import type { Prisma } from "@logistics/db";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../app.service.js";
import { CanonicalService } from "../canonical/canonical.service.js";
import {
  type ConversationActor,
  prepareConversationWrite,
  resolveUniqueConversationReference,
} from "./conversation-commands.js";
import { ConversationService } from "./conversation.service.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  membership: "10000000-0000-4000-8000-000000000002",
  actor: "10000000-0000-4000-8000-000000000003",
  approval: "10000000-0000-4000-8000-000000000004",
  definition: "10000000-0000-4000-8000-000000000005",
  role: "10000000-0000-4000-8000-000000000006",
  billing: "10000000-0000-4000-8000-000000000007",
};

const actor: ConversationActor = {
  userId: ids.actor,
  email: "approver@example.test",
  platformAdmin: false,
  activeTenantId: ids.tenant,
  membershipId: ids.membership,
  contextVersion: 1,
  csrfToken: "test",
};

type Query = (sql: string, ...args: unknown[]) => Promise<unknown[]>;
const transaction = (query: Query) =>
  ({
    $queryRawUnsafe: vi.fn(query),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  }) as unknown as Prisma.TransactionClient;
const errorCode = (error: unknown) => (error as { code?: string }).code;

describe("INT02-SEC-001 scoped conversational preparation", () => {
  it("does not disclose a reference outside the actor tenant or granted scope", async () => {
    const query = vi.fn<Query>(async (sql, ...args) => {
      expect(sql).toContain("r.tenant_id=$1::uuid");
      expect(sql).toContain("app.domain_resource_authorized");
      expect(args.slice(0, 5)).toEqual([
        ids.tenant,
        "FOREIGN-CLIENT",
        "%FOREIGN-CLIENT%",
        ids.membership,
        ids.actor,
      ]);
      return [];
    });
    await expect(
      resolveUniqueConversationReference(
        transaction(query),
        actor,
        "client",
        "FOREIGN-CLIENT",
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "REFERENCE_NOT_FOUND",
    );
  });

  it("scope-filters billing entities before a client proposal is persisted", async () => {
    const query = vi.fn<Query>(async (sql, ...args) => {
      expect(sql).toContain("app.domain_resource_authorized");
      expect(sql).toContain("'organization-nodes'");
      expect(args.slice(-2)).toEqual([ids.membership, ids.actor]);
      return [{ id: ids.billing, reference: "LEGAL", label: "Legal entity" }];
    });
    await expect(
      prepareConversationWrite(transaction(query), actor, "CLIENT_CREATE", {
        code: "CLIENT",
        legalName: "Scoped Client",
        billingEntity: "LEGAL",
        creditDays: 0,
        podMode: "DIGITAL",
      }),
    ).resolves.toMatchObject({ billingEntity: ids.billing });
  });

  it("rejects generic conversational financial reversals", async () => {
    await expect(
      prepareConversationWrite(
        transaction(async () => {
          throw new Error("reference lookup must not run");
        }),
        actor,
        "FINANCE_STATUS_UPDATE",
        {
          resource: "invoice",
          targetRef: "INV-1",
          expectedVersion: 1,
          toState: "REVERSED",
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "COMPENSATING_ENTRY_REQUIRED",
    );
  });

  it("derives the required approval role from the current locked workflow definition", async () => {
    const query = vi.fn<Query>(async (sql) => {
      if (
        sql.includes("FROM app.approval_instances i") &&
        sql.includes("CASE upper")
      )
        return [
          {
            id: ids.approval,
            reference: ids.approval,
            label: "INVOICE approval",
            state: "PENDING",
            version: 1,
          },
        ];
      if (sql.includes("SELECT i.current_step,d.steps"))
        return [{ current_step: 1, steps: [{ roleId: ids.role }] }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(
      prepareConversationWrite(transaction(query), actor, "APPROVAL_DECIDE", {
        instanceRef: ids.approval,
        expectedVersion: 1,
        decision: "APPROVE",
        comment: "Reviewed independently",
      }),
    ).resolves.toMatchObject({ instanceRef: ids.approval, roleId: ids.role });
  });
});

describe("INT02-SEC-002 canonical-only write dispatch", () => {
  it("dispatches client creation through CanonicalService with the proposal idempotency key", async () => {
    const createInTransaction = vi.fn().mockResolvedValue({ id: "client-id" });
    const service = new ConversationService(
      {} as never,
      {} as never,
      { createInTransaction } as never,
    );
    const execute = (
      service as unknown as {
        execute(
          tx: Prisma.TransactionClient,
          actor: ConversationActor,
          intent: "CLIENT_CREATE",
          raw: Record<string, unknown>,
          correlationId: string,
          proposalId: string,
        ): Promise<unknown>;
      }
    ).execute.bind(service);
    await execute(
      transaction(async () => []),
      actor,
      "CLIENT_CREATE",
      {
        code: "CLIENT",
        legalName: "Canonical Client",
        billingEntity: ids.billing,
        creditDays: 0,
        podMode: "DIGITAL",
      },
      "correlation",
      ids.approval,
    );
    expect(createInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      "clients",
      expect.objectContaining({ billingEntityId: ids.billing }),
      `conversation:${ids.approval}`,
      "correlation",
    );
  });

  it("rejects an expired approval inside the canonical locked transaction", async () => {
    const query = vi.fn<Query>(async (sql) => {
      if (sql.includes("FROM app.tenant_memberships"))
        return [{ audience: "INTERNAL" }];
      if (sql.includes("FROM app.idempotency_records")) return [];
      if (sql.includes("SELECT * FROM app.approval_instances"))
        return [
          {
            id: ids.approval,
            requester_id: "20000000-0000-4000-8000-000000000001",
            version: 1,
            state: "PENDING",
            expires_at: new Date("2020-01-01T00:00:00.000Z"),
            target_type: "INVOICE",
            target_id: ids.billing,
          },
        ];
      if (sql.includes("domain_resource_authorized"))
        return [{ allowed: true }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const canonical = new CanonicalService({
      requireTenant: () => ids.tenant,
    } as never);
    await expect(
      canonical.decideApproval(
        actor,
        ids.approval,
        {
          expectedVersion: 1,
          decision: "APPROVE",
          roleId: ids.role,
          comment: "Reviewed independently",
        },
        "conversation:approval",
        "correlation",
        transaction(query),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError && error.code === "APPROVAL_EXPIRED",
    );
  });
});
