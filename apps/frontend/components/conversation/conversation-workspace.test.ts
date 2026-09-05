import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./conversation-workspace.tsx", import.meta.url),
  "utf8",
);

describe("INT-02 safe conversational UI source contract", () => {
  it("INT02-FE-SEC-001 renders safe text and only calls the bounded conversation API", () => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("/conversations/capabilities");
    expect(source).toContain("/conversations/threads");
    expect(source).toContain(
      "/conversations/proposals/${proposal.id}/${action}",
    );
    expect(source).not.toContain("api(proposal");
    expect(source).not.toContain("tenantId:");
    expect(source).not.toContain("actorId:");
  });

  it("INT02-FE-SEC-002 hashes bounded attachments and requires explicit proposal confirmation", () => {
    expect(source).toContain('crypto.subtle.digest("SHA-256", bytes)');
    expect(source).toContain("limits.maxAttachmentBytes");
    expect(source).toContain("limits.maxAttachments");
    expect(source).toContain("Review and confirm");
    expect(source).toContain("Confirm and execute");
    expect(source).toContain("expectedVersion: proposal.version");
    expect(source).toContain("messageIdempotency.current");
    expect(source).toContain("confirmationIdempotency.current");
    expect(source).toContain("threadIdempotency.current");
    expect(source).toContain("stableIdempotencySlot");
    expect(source).toContain("threadId: detail.thread.id");
    expect(source).toContain('role="log"');
  });

  it("INT02-FE-UX-004 exposes capability discovery and only future structured output", () => {
    expect(source).toContain("What can I ask?");
    expect(source).toContain("message.clarification");
    expect(source).toContain("message.result");
    expect(source).toContain("safeConversationHref");
    expect(source).toContain('aria-label="Conversation language"');
    expect(source).toContain("Proactive alerts");
    expect(source).toContain("/conversations/whatsapp/status");
    expect(source).toContain("/conversations/whatsapp/preferences");
    expect(source).toContain("/conversations/whatsapp/unlink");
    expect(source).toContain("/conversations/whatsapp/deliveries");
    expect(source).toContain("parsedMessageResult");
    expect(source).toContain("setDraft(command.label)");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
