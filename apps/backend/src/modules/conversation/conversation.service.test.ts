import { describe, expect, it } from "vitest";
import { ConversationService } from "./conversation.service.js";
import {
  receiptConversationSchema,
  statusConversationSchema,
} from "./conversation-commands.js";

describe("INT02-C-001 closed command catalog", () => {
  it("does not expose arbitrary dispatch and keeps high-risk commands off WhatsApp", () => {
    const service = new ConversationService(
      { config: { WHATSAPP_PROVIDER: "disabled" } } as never,
      {} as never,
      {} as never,
    );
    const catalog = service.catalog();
    expect(catalog.whatsapp.enabled).toBe(false);
    expect(catalog.attachments).toMatchObject({
      maxFiles: 1,
      maxBytesEach: 5_000_000,
    });
    expect(catalog.commands.every((command) => "intent" in command)).toBe(true);
    expect(catalog.commands.some((command) => "url" in command)).toBe(false);
    expect(catalog.commands.map((command) => command.intent)).toEqual(
      expect.arrayContaining([
        "CLIENT_CREATE",
        "VENDOR_CREATE",
        "RECORD_RECEIPT",
        "OPERATIONS_STATUS_UPDATE",
        "FINANCE_STATUS_UPDATE",
        "APPROVAL_DECIDE",
        "REFERENCE_SEARCH",
        "STATUS_REPORT",
        "OPERATIONAL_INSIGHT",
      ]),
    );
    expect(
      catalog.commands
        .filter((command) =>
          [
            "RECORD_RECEIPT",
            "FINANCE_STATUS_UPDATE",
            "APPROVAL_DECIDE",
          ].includes(command.intent),
        )
        .every(
          (command) => command.risk === "HIGH" && command.requiresConfirmation,
        ),
    ).toBe(true);
    expect(
      catalog.commands
        .filter((command) =>
          ["REFERENCE_SEARCH", "STATUS_REPORT", "OPERATIONAL_INSIGHT"].includes(
            command.intent,
          ),
        )
        .every((command) => !command.requiresConfirmation),
    ).toBe(true);
  });
});

describe("INT02-C-002 typed command boundaries", () => {
  it("keeps financial values in positive integer minor units", () => {
    expect(() =>
      receiptConversationSchema.parse({
        receiptRef: "RCPT-1",
        client: "DEMO",
        paymentDate: "2026-09-04",
        amountMinor: "10.50",
        mode: "BANK_TRANSFER",
      }),
    ).toThrow();
    expect(
      receiptConversationSchema.parse({
        receiptRef: "RCPT-1",
        client: "DEMO",
        paymentDate: "2026-09-04",
        amountMinor: "1050",
        mode: "BANK_TRANSFER",
      }).amountMinor,
    ).toBe("1050");
  });

  it("rejects unknown resources and malformed optimistic versions", () => {
    expect(() =>
      statusConversationSchema.parse({
        resource: "users",
        targetRef: "someone",
        expectedVersion: 0,
        toState: "ACTIVE",
      }),
    ).toThrow();
  });
});
