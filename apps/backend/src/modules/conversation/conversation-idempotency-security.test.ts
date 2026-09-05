import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@logistics/db";
import { ConversationService } from "./conversation.service.js";

const ids = {
  tenant: "20000000-0000-4000-8000-000000000001",
  membership: "20000000-0000-4000-8000-000000000002",
  actor: "20000000-0000-4000-8000-000000000003",
  thread: "20000000-0000-4000-8000-000000000004",
  message: "20000000-0000-4000-8000-000000000005",
  assistant: "20000000-0000-4000-8000-000000000006",
  proposal: "20000000-0000-4000-8000-000000000007",
  execution: "20000000-0000-4000-8000-000000000008",
};

const actor = {
  userId: ids.actor,
  email: "operator@example.test",
  platformAdmin: false,
  activeTenantId: ids.tenant,
  membershipId: ids.membership,
  contextVersion: 1,
  csrfToken: "test",
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Query = (sql: string, ...args: unknown[]) => Promise<unknown[]>;

function harness(query: Query) {
  const tx = {
    $queryRawUnsafe: vi.fn(query),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: vi.fn(
      async (callback: (value: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(tx),
    ),
  };
  return {
    tx,
    service: new ConversationService(
      {
        config: {
          CONVERSATION_INTENT_PROVIDER: "deterministic",
          WHATSAPP_PROVIDER: "disabled",
        },
        db,
      } as never,
      { validateAttachment: vi.fn() } as never,
      {} as never,
    ),
  };
}

function errorCode(error: unknown) {
  return (error as { code?: string }).code;
}

describe("INT02-SEC-003 live membership authorization", () => {
  it("rejects a stale or revoked membership even when the session still contains it", async () => {
    const { service, tx } = harness(async (sql, ...args) => {
      if (sql.includes("FROM app.membership_role_assignments")) {
        expect(sql).toContain("m.status='ACTIVE'");
        expect(args.slice(0, 3)).toEqual([
          ids.tenant,
          ids.membership,
          ids.actor,
        ]);
        return [];
      }
      throw new Error(`Unexpected query after revoked membership: ${sql}`);
    });

    await expect(service.list(actor)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "FORBIDDEN",
    );
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe("INT02-SEC-004 browser command idempotency", () => {
  it("requires a current MFA-authenticated session for a high-risk web confirmation", async () => {
    const { service } = harness(async (sql) => {
      if (sql.includes("FROM app.membership_role_assignments"))
        return [{ allowed: 1 }];
      if (sql.includes("FROM app.conversation_executions")) return [];
      if (sql.includes("SELECT p.*,t.channel"))
        return [
          {
            id: ids.proposal,
            intent: "RECORD_RECEIPT",
            state: "PENDING",
            version: 1,
            expires_at: new Date("2099-01-01T00:00:00.000Z"),
            requires_step_up: true,
            channel: "WEB",
          },
        ];
      throw new Error(`Unexpected MFA query: ${sql}`);
    });

    await expect(
      service.confirm(
        { ...actor, assuranceLevel: "PASSWORD" as const },
        ids.proposal,
        1,
        "browser-high-risk-confirmation",
        "correlation-high-risk-confirmation",
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "IN_APP_STEP_UP_REQUIRED",
    );
  });

  it("replays the original message/proposal and does not insert a second command", async () => {
    const key = "browser-message-idempotency";
    const input = { text: "create probe label Alpha", attachments: [] };
    const requestHash = sha(JSON.stringify({ threadId: ids.thread, input }));
    const { service, tx } = harness(async (sql) => {
      if (sql.includes("FROM app.membership_role_assignments"))
        return [{ allowed: 1 }];
      if (
        sql.includes("FROM app.conversation_messages WHERE tenant_id") &&
        sql.includes("idempotency_key_hash")
      )
        return [
          {
            id: ids.message,
            direction: "INBOUND",
            kind: "USER",
            text: input.text,
            requestHash,
          },
        ];
      if (sql.includes("in_reply_to_id"))
        return [
          {
            id: ids.assistant,
            direction: "OUTBOUND",
            kind: "ASSISTANT",
            text: "Review",
          },
        ];
      if (sql.includes("source_message_id"))
        return [
          {
            id: ids.proposal,
            intent: "PROBE_CREATE",
            state: "PENDING",
            version: 1,
          },
        ];
      throw new Error(`Unexpected replay query: ${sql}`);
    });

    const result = await service.submit(
      actor,
      ids.thread,
      input,
      "correlation-message-replay",
      key,
    );

    expect(result).toMatchObject({
      replayed: true,
      message: { id: ids.message },
    });
    expect(
      (tx.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.some(
        (args: unknown[]) =>
          String(args[0]).includes("INSERT INTO app.conversation_messages"),
      ),
    ).toBe(false);
  });

  it("replays a completed confirmation and never executes the proposal twice", async () => {
    const key = "browser-confirm-idempotency";
    const expectedVersion = 1;
    const requestHash = sha(
      JSON.stringify({ proposalId: ids.proposal, expectedVersion }),
    );
    const { service, tx } = harness(async (sql) => {
      if (sql.includes("FROM app.membership_role_assignments"))
        return [{ allowed: 1 }];
      if (sql.includes("FROM app.conversation_executions"))
        return [
          {
            id: ids.execution,
            state: "SUCCEEDED",
            result: { id: "created-once" },
            requestHash,
            proposalId: ids.proposal,
            proposalState: "EXECUTED",
            version: 2,
          },
        ];
      throw new Error(`Unexpected confirmation replay query: ${sql}`);
    });

    const result = await service.confirm(
      actor,
      ids.proposal,
      expectedVersion,
      key,
      "correlation-confirm-replay",
    );

    expect(result).toMatchObject({
      replayed: true,
      execution: { id: ids.execution },
    });
    expect(
      (tx.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls.some(
        (args: unknown[]) => String(args[0]).includes("SELECT p.*,t.channel"),
      ),
    ).toBe(false);
  });

  it("rejects reuse of a browser message key with different input", async () => {
    const key = "browser-message-conflict";
    const priorHash = sha(
      JSON.stringify({
        threadId: ids.thread,
        input: { text: "create probe label Original", attachments: [] },
      }),
    );
    const { service } = harness(async (sql) => {
      if (sql.includes("FROM app.membership_role_assignments"))
        return [{ allowed: 1 }];
      if (sql.includes("idempotency_key_hash"))
        return [{ id: ids.message, requestHash: priorHash }];
      throw new Error(`Unexpected conflict query: ${sql}`);
    });

    await expect(
      service.submit(
        actor,
        ids.thread,
        { text: "create probe label Different", attachments: [] },
        "correlation-message-conflict",
        key,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "IDEMPOTENCY_CONFLICT",
    );
  });
});

describe("INT02-WA-007 WhatsApp identity isolation", () => {
  it("treats an unknown or revoked binding as unlinked without revealing identity", async () => {
    const bodyHash = sha("unlinked-body");
    const { service, tx } = harness(async () => []);
    Object.assign(
      (service as unknown as { app: { config: Record<string, unknown> } }).app
        .config,
      {
        WHATSAPP_PROVIDER: "meta",
        WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
      },
    );

    await expect(
      service.acceptWhatsapp(
        "wamid.unlinked",
        "+919999999999",
        "show status",
        bodyHash,
        "correlation-unlinked",
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WHATSAPP_NOT_LINKED",
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("conversation_provider_receipts"),
      "wamid.unlinked",
      bodyHash,
      "UNBOUND",
    );
  });

  it("rejects an address linked to more than one active tenant membership", async () => {
    const { service, tx } = harness(async (sql) => {
      if (sql.includes("FROM app.whatsapp_bindings"))
        return [
          {
            tenant_id: ids.tenant,
            membership_id: ids.membership,
            actor_id: ids.actor,
            email: "operator@example.test",
          },
          {
            tenant_id: "20000000-0000-4000-8000-000000000019",
            membership_id: "20000000-0000-4000-8000-000000000018",
            actor_id: ids.actor,
            email: "operator@example.test",
          },
        ];
      return [];
    });
    Object.assign(
      (service as unknown as { app: { config: Record<string, unknown> } }).app
        .config,
      {
        WHATSAPP_PROVIDER: "meta",
        WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
      },
    );

    await expect(
      service.acceptWhatsapp(
        "wamid.ambiguous",
        "+919999999999",
        "show status",
        sha("ambiguous-body"),
        "correlation-ambiguous",
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "WHATSAPP_TENANT_AMBIGUOUS",
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("conversation_provider_receipts"),
      "wamid.ambiguous",
      sha("ambiguous-body"),
      "AMBIGUOUS",
    );
  });
});
