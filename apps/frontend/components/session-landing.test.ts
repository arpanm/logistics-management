import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UIM-SRC-010 default home and Quick access contract", () => {
  it("routes a verified cookie session through the server-derived home", () => {
    const source = readFileSync(
      new URL("./session-landing.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('api<SessionHome>("/auth/me")');
    expect(source).toContain(
      'api<{ home: string }>("/tenant/access/effective")',
    );
    expect(source).toContain("router.replace(home)");
    expect(source).toContain('value.code === "MFA_REQUIRED"');
  });

  it("moves the former landing shortcuts into one capability-aware group", () => {
    const source = readFileSync(
      new URL("./shell.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('label: "Quick access"');
    expect(source).toContain('label: "Open operations"');
    expect(source).toContain('label: "Manage access"');
    expect(source).toContain('label: "Review activity & audit"');
    expect(source).toContain('capability(effective, "operations.read")');
    expect(source).not.toContain('capability(effective, "operations.")');
  });
});
