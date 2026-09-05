import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@logistics/db";
import { AppError } from "../../app.service.js";
import { ConversationWhatsappService } from "./conversation-whatsapp.service.js";

type Query = (sql: string, ...args: unknown[]) => Promise<unknown[]>;

const ids = {
  tenant: "30000000-0000-4000-8000-000000000001",
  membership: "30000000-0000-4000-8000-000000000002",
  actor: "30000000-0000-4000-8000-000000000003",
  delivery: "30000000-0000-4000-8000-000000000004",
};
const createDigest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

function service(query: Query, maxAttempts = 3) {
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
  const conversation = {
    providerEventReceived: vi.fn(),
    acceptWhatsapp: vi.fn(),
  };
  const adapter = {
    sendText: vi.fn(),
    sendTemplate: vi.fn(),
    downloadMedia: vi.fn(),
  };
  const subject = new ConversationWhatsappService(
    {
      config: {
        WHATSAPP_PROVIDER: "meta",
        WHATSAPP_APP_SECRET: "s".repeat(32),
        WHATSAPP_VERIFY_TOKEN: "v".repeat(32),
        WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
        WHATSAPP_ADDRESS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
        WHATSAPP_DELIVERY_MAX_ATTEMPTS: maxAttempts,
        WHATSAPP_ALERT_TEMPLATE_NAME: "logistics_operational_alert",
      },
      db,
    } as never,
    conversation as never,
    adapter as never,
  );
  return { subject, tx, conversation, adapter };
}

describe("INT02-WA-007 inbound identity and duplicate handling", () => {
  it("atomically claims concurrent duplicate deliveries and dispatches only once", async () => {
    const raw = Buffer.from("concurrent-duplicate");
    let claimed = false;
    let releaseFirst: (() => void) | undefined;
    const firstDispatchGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = service(async (sql) => {
      if (sql.includes("INSERT INTO app.conversation_provider_event_claims")) {
        if (claimed) return [];
        claimed = true;
        return [{ id: ids.delivery, attempts: 1 }];
      }
      if (sql.includes("FROM app.conversation_provider_event_claims"))
        return [
          {
            id: ids.delivery,
            body_sha256: createDigest(raw),
            state: "PROCESSING",
            attempts: 1,
            lease_expires_at: new Date("2099-01-01T00:00:00.000Z"),
          },
        ];
      if (sql.includes("FROM app.whatsapp_bindings"))
        return [{ tenant_id: ids.tenant, membership_id: ids.membership }];
      if (sql.includes("UPDATE app.conversation_provider_event_claims"))
        return [{ attempts: 1 }];
      return [];
    });
    harness.conversation.providerEventReceived.mockImplementation(async () => {
      await firstDispatchGate;
      return false;
    });
    harness.conversation.acceptWhatsapp.mockResolvedValue({
      response: { assistantMessage: { text: "Processed once" } },
    });

    const first = harness.subject.receive(
      { id: "wamid.concurrent", from: "919999999999", text: "status" },
      raw,
      "correlation-first",
    );
    await vi.waitFor(() => expect(claimed).toBe(true));
    const second = harness.subject.receive(
      { id: "wamid.concurrent", from: "919999999999", text: "status" },
      raw,
      "correlation-second",
    );
    await expect(second).resolves.toEqual({ accepted: true, duplicate: true });
    releaseFirst?.();
    await expect(first).resolves.toEqual({ accepted: true });
    expect(harness.conversation.acceptWhatsapp).toHaveBeenCalledTimes(1);
  });

  it("recovers and requeues a persisted reply after processing completed before acknowledgement", async () => {
    const raw = Buffer.from("provider-retry-after-crash");
    const harness = service(async (sql) => {
      if (sql.includes("INSERT INTO app.conversation_provider_event_claims"))
        return [{ id: ids.delivery, attempts: 2 }];
      if (sql.includes("SELECT reply_ciphertext")) return [];
      if (sql.includes("JOIN app.conversation_messages reply"))
        return [{ text: "Recovered canonical reply" }];
      if (sql.includes("FROM app.whatsapp_bindings"))
        return [{ tenant_id: ids.tenant, membership_id: ids.membership }];
      if (sql.includes("UPDATE app.conversation_provider_event_claims"))
        return [{ attempts: 2 }];
      return [];
    });
    harness.conversation.providerEventReceived.mockResolvedValue(true);

    await expect(
      harness.subject.receive(
        { id: "wamid.recovery", from: "919999999999", text: "show status" },
        raw,
        "correlation-recovery",
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });
    expect(harness.conversation.acceptWhatsapp).not.toHaveBeenCalled();
    expect(harness.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("conversation_channel_deliveries"),
      ids.tenant,
      ids.membership,
      "Recovered canonical reply",
      "whatsapp-reply:wamid.recovery",
    );
  });
});

type PrivateWhatsapp = {
  deliver(lease: {
    row: Record<string, unknown>;
    tokenHash: string;
  }): Promise<void>;
  inQuietHours(row: Record<string, unknown>): boolean;
  decryptAddress(value: Buffer): string;
};

function privateApi(subject: ConversationWhatsappService) {
  return subject as unknown as PrivateWhatsapp;
}

describe("INT02-WA-008 outbound consent, quiet-hours, and retry policy", () => {
  it("suppresses proactive delivery after consent is withdrawn", async () => {
    const harness = service(async (sql) => {
      if (sql.includes("SELECT b.address_ciphertext"))
        return [
          {
            address_ciphertext: Buffer.from("unused"),
            timezone: "Asia/Kolkata",
            proactive_state: "OPTED_OUT",
            quiet_start: null,
            quiet_end: null,
          },
        ];
      return [];
    });
    await privateApi(harness.subject).deliver({
      row: {
        id: ids.delivery,
        tenant_id: ids.tenant,
        membership_id: ids.membership,
        category: "PROACTIVE",
        attempts: 0,
      },
      tokenHash: "lease-token",
    });

    expect(harness.adapter.sendTemplate).not.toHaveBeenCalled();
    expect(harness.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("SET state=$1"),
      "SUPPRESSED",
      1,
      null,
      "WHATSAPP_NOT_OPTED_IN",
      ids.delivery,
      "lease-token",
    );
  });

  it("evaluates overnight quiet hours in the tenant timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T18:45:00.000Z")); // 00:15 Asia/Kolkata
    try {
      const harness = service(async () => []);
      expect(
        privateApi(harness.subject).inQuietHours({
          timezone: "Asia/Kolkata",
          quiet_start: "22:00",
          quiet_end: "06:00",
        }),
      ).toBe(true);
      expect(
        privateApi(harness.subject).inQuietHours({
          timezone: "Asia/Kolkata",
          quiet_start: "06:00",
          quiet_end: "22:00",
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { attempts: 0, maxAttempts: 3, expected: "RETRY" },
    { attempts: 2, maxAttempts: 3, expected: "DEAD_LETTER" },
  ])(
    "records $expected after a retryable provider failure",
    async ({ attempts, maxAttempts, expected }) => {
      const harness = service(async (sql) => {
        if (sql.includes("SELECT b.address_ciphertext"))
          return [
            {
              address_ciphertext: Buffer.from("test-envelope"),
              timezone: "Asia/Kolkata",
              proactive_state: "OPTED_IN",
            },
          ];
        return [];
      }, maxAttempts);
      privateApi(harness.subject).decryptAddress = () => "+919999999999";
      harness.adapter.sendText.mockRejectedValue(
        new AppError(503, "WHATSAPP_PROVIDER_UNAVAILABLE", "Unavailable"),
      );

      await privateApi(harness.subject).deliver({
        row: {
          id: ids.delivery,
          tenant_id: ids.tenant,
          membership_id: ids.membership,
          category: "TRANSACTIONAL",
          rendered_body: "Safe reply",
          attempts,
        },
        tokenHash: "lease-token",
      });

      expect(harness.tx.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("SET state=$1"),
        expected,
        attempts + 1,
        null,
        "WHATSAPP_PROVIDER_UNAVAILABLE",
        ids.delivery,
        "lease-token",
      );
    },
  );
});
