import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError, type AppService } from "../../app.service.js";
import type { ConversationService } from "./conversation.service.js";
import type { MetaWhatsappAdapter } from "./conversation-whatsapp.adapter.js";
import { ConversationWhatsappService } from "./conversation-whatsapp.service.js";

const appSecret = "provider-app-secret-with-minimum-length";

function service(provider: "disabled" | "meta") {
  const db = { $transaction: vi.fn() };
  const app = {
    config: {
      WHATSAPP_PROVIDER: provider,
      WHATSAPP_APP_SECRET: appSecret,
      WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
      WHATSAPP_DELIVERY_MAX_ATTEMPTS: 5,
      WHATSAPP_ALERT_TEMPLATE_NAME: "logistics_operational_alert",
    },
    db,
  } as unknown as AppService;
  const conversation = {
    providerEventReceived: vi.fn(),
  } as unknown as ConversationService;
  const adapter = {
    sendText: vi.fn(),
    sendTemplate: vi.fn(),
    downloadMedia: vi.fn(),
  } as unknown as MetaWhatsappAdapter;
  return {
    db,
    adapter,
    conversation,
    subject: new ConversationWhatsappService(app, conversation, adapter),
  };
}

describe("INT02-WA-006 WhatsApp channel security", () => {
  it("authenticates the exact raw webhook bytes", () => {
    const { subject } = service("meta");
    const raw = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
    expect(subject.verifySignature(raw, signature)).toBe(true);
    expect(
      subject.verifySignature(Buffer.from('{"entry":[1]}'), signature),
    ).toBe(false);
  });

  it("does no polling or provider work when the channel is disabled", async () => {
    const { subject, db, adapter } = service("disabled");
    await expect(subject.processPending()).resolves.toBe(0);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendTemplate).not.toHaveBeenCalled();
  });

  it("acknowledges an atomically claimed duplicate before interpretation or media retrieval", async () => {
    const { subject, adapter } = service("meta");
    vi.spyOn(
      subject as unknown as { claimProviderEvent: () => Promise<null> },
      "claimProviderEvent",
    ).mockResolvedValue(null);
    await expect(
      subject.receive(
        {
          id: "provider-event-1",
          from: "919999999999",
          text: "create something",
          media: { id: "provider-media-1" },
        },
        Buffer.from("signed-body"),
        "correlation-1",
      ),
    ).resolves.toEqual({ accepted: true, duplicate: true });
    expect(adapter.downloadMedia).not.toHaveBeenCalled();
  });

  it("releases a transient failure for a provider retry", async () => {
    const { subject, adapter, conversation } = service("meta");
    vi.spyOn(
      subject as unknown as {
        claimProviderEvent: () => Promise<{
          id: string;
          leaseTokenHash: string;
        }>;
      },
      "claimProviderEvent",
    ).mockResolvedValue({ id: crypto.randomUUID(), leaseTokenHash: "lease" });
    vi.mocked(conversation.providerEventReceived).mockResolvedValue(false);
    vi.mocked(adapter.downloadMedia).mockRejectedValue(
      new AppError(503, "WHATSAPP_MEDIA_DOWNLOAD_FAILED", "retry"),
    );
    const retry = vi
      .spyOn(
        subject as unknown as {
          retryProviderEvent: () => Promise<void>;
        },
        "retryProviderEvent",
      )
      .mockResolvedValue();
    await expect(
      subject.receive(
        {
          id: "provider-event-2",
          from: "919999999999",
          text: "upload",
          media: { id: "provider-media-2" },
        },
        Buffer.from("signed-body"),
        "correlation-2",
      ),
    ).rejects.toMatchObject({ code: "WHATSAPP_MEDIA_DOWNLOAD_FAILED" });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ leaseTokenHash: "lease" }),
      "WHATSAPP_MEDIA_DOWNLOAD_FAILED",
    );
  });
});
