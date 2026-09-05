import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UIM-SRC-010 default home and role-aware navigation contract", () => {
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

  it("places each former landing shortcut in its domain group", () => {
    const source = readFileSync(
      new URL("./shell.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('label: "Quick access"');
    expect(source).toContain('label: "Indent & Truck Allocation"');
    expect(source).toContain('label: "User & Access"');
    expect(source).toContain('label: "Activity & Audit"');
    expect(source.indexOf('label: "User & Access"')).toBeLessThan(
      source.indexOf('label: "Roles"'),
    );
    expect(source.indexOf('label: "Roles"')).toBeLessThan(
      source.indexOf('label: "Activity & Audit"'),
    );
    expect(source).toContain('capability(effective, "operations.read")');
    expect(source).not.toContain('capability(effective, "operations.")');
  });

  it("exposes each finance tab as a direct navigation destination", () => {
    const source = readFileSync(
      new URL("./shell.tsx", import.meta.url),
      "utf8",
    );
    for (const label of [
      "Dashboard",
      "Invoices",
      "Collection & Receipt",
      "Vendor Payable",
      "Payout Runs",
    ])
      expect(source).toContain(`label: "${label}"`);
    expect(source).toContain('match: "exact"');
  });

  it("provides three capability-derived mobile destinations plus More", () => {
    const source = readFileSync(
      new URL("./shell.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("mobilePrimaryItems");
    expect(source).toContain("return selected.slice(0, 3)");
    expect(source).toContain('aria-label="Primary mobile navigation"');
    expect(source).toContain('aria-label="More navigation"');
  });
});
