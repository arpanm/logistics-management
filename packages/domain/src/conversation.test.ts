import { describe, expect, it } from "vitest";
import {
  conversationMessageCreateSchema,
  extractConfiguredConversationIntent,
  extractEnglishConversationIntent,
  decimalToMinor,
} from "./conversation.js";

describe("INT02-U-001 closed conversation intent extraction", () => {
  it("extracts only a registered probe command", () => {
    expect(
      extractEnglishConversationIntent(
        "Create a probe with label Daily check, note received at gate",
      ),
    ).toMatchObject({ intent: "PROBE_CREATE", missing: [] });
  });
  it("does not turn arbitrary instructions into executable commands", () => {
    expect(
      extractEnglishConversationIntent("DELETE FROM users").intent,
    ).toBeNull();
  });
  it("extracts registered master, status, approval and report intents", () => {
    expect(
      extractEnglishConversationIntent(
        "Create vendor code FAST, legal name Fast Carrier, payment terms days 30",
      ),
    ).toMatchObject({ intent: "VENDOR_CREATE", missing: [] });
    expect(
      extractEnglishConversationIntent(
        "Mark trip DEMO-TRIP-1 as in transit, version 2",
      ),
    ).toMatchObject({
      intent: "OPERATIONS_STATUS_UPDATE",
      arguments: { toState: "IN_TRANSIT", expectedVersion: 2 },
      missing: [],
    });
    expect(
      extractEnglishConversationIntent(
        "Approve approval 11000000-0000-4000-8000-000000000001, version 1, comment checked and approved",
      ),
    ).toMatchObject({ intent: "APPROVAL_DECIDE", missing: [] });
    expect(extractEnglishConversationIntent("Show open indents")).toMatchObject(
      {
        intent: "STATUS_REPORT",
        arguments: { resource: "indents", state: "OPEN" },
      },
    );
  });
  it("supports bounded Hinglish aliases without opening arbitrary intents", () => {
    expect(extractEnglishConversationIntent("vendors dikhao")).toMatchObject({
      intent: "STATUS_REPORT",
      arguments: { resource: "vendors" },
    });
  });
  it("converts decimal currency to exact integer minor units", () => {
    expect(decimalToMinor("INR 1234.50")).toBe("123450");
    expect(decimalToMinor("0.01")).toBe("1");
    expect(decimalToMinor("12.345")).toBeUndefined();
  });
});

describe("INT02-U-003 intent provider kill switch", () => {
  it("never proposes an action when extraction is disabled", () => {
    expect(
      extractConfiguredConversationIntent(
        "disabled",
        "Create a probe with label Unsafe execution",
      ).intent,
    ).toBeNull();
  });
});

describe("INT02-U-002 bounded attachments", () => {
  it("rejects unknown attachment metadata", () => {
    expect(() =>
      conversationMessageCreateSchema.parse({
        text: "preview import",
        attachments: [
          {
            filename: "a.csv",
            mediaType: "text/csv",
            contentBase64: "YQ==",
            url: "https://evil.test",
          },
        ],
      }),
    ).toThrow();
  });
});
