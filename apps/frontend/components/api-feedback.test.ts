import { describe, expect, it } from "vitest";
import { mutationSuccessFeedback } from "./api";

describe("UI-01 shared mutation feedback", () => {
  it("does not infer a saved message from an HTTP method", () => {
    expect(mutationSuccessFeedback("POST")).toBeNull();
    expect(mutationSuccessFeedback("PATCH", "   ")).toBeNull();
  });

  it("uses an explicit create/update confirmation only for mutations", () => {
    expect(mutationSuccessFeedback("POST", "Tenant created.")).toBe(
      "Tenant created.",
    );
    expect(mutationSuccessFeedback("PATCH", "User updated.")).toBe(
      "User updated.",
    );
    expect(mutationSuccessFeedback("GET", "Saved.")).toBeNull();
  });
});
