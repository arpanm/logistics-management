import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_LIMITS,
  effectiveConversationLimits,
  formatFileLimit,
  mediaTypeForFile,
  stableIdempotencySlot,
} from "./types.js";

describe("INT-02 conversational workspace contract", () => {
  it("INT02-FE-UT-001 uses server-advertised attachment boundaries without widening them", () => {
    expect(
      effectiveConversationLimits({
        maxFiles: 2,
        maxBytesEach: 1_250_000,
        acceptedMediaTypes: ["text/csv"],
      }),
    ).toEqual({
      maxAttachments: 2,
      maxAttachmentBytes: 1_250_000,
      acceptedMediaTypes: ["text/csv"],
    });
  });

  it("INT02-FE-UT-002 keeps a restrictive local fallback while capabilities load", () => {
    expect(effectiveConversationLimits()).toEqual(DEFAULT_CONVERSATION_LIMITS);
    expect(DEFAULT_CONVERSATION_LIMITS.maxAttachments).toBe(1);
    expect(DEFAULT_CONVERSATION_LIMITS.maxAttachmentBytes).toBe(
      5 * 1024 * 1024,
    );
    expect(formatFileLimit(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatFileLimit(48 * 1024)).toBe("48 KB");
    expect(mediaTypeForFile("clients.csv", "")).toBe("text/csv");
    expect(mediaTypeForFile("pod.pdf", "application/pdf")).toBe(
      "application/pdf",
    );
  });

  it("INT02-FE-UT-003 retains a key for an unchanged retry and rotates it for a changed operation", () => {
    let sequence = 0;
    const create = () => `key-${++sequence}`;
    const first = stableIdempotencySlot(null, "draft-a", create);
    const retry = stableIdempotencySlot(first, "draft-a", create);
    const changed = stableIdempotencySlot(retry, "draft-b", create);

    expect(retry).toBe(first);
    expect(retry.key).toBe("key-1");
    expect(changed).toEqual({ identity: "draft-b", key: "key-2" });
  });
});
