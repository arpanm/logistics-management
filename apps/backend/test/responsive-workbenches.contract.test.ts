import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("UI-01 responsive workbench remediation (Implemented / Not Run)", () => {
  it("UI01-MODAL-01 provides a portalled, focus-contained modal contract", () => {
    const modal = source("../../frontend/components/modal.tsx");
    for (const value of [
      "createPortal",
      'role="dialog"',
      'aria-modal="true"',
      'event.key === "Escape"',
      'event.key !== "Tab"',
      'document.body.style.overflow = "hidden"',
      "application.inert = true",
      "previous?.focus()",
    ])
      expect(modal).toContain(value);
  });

  it("UI01-MODAL-02 uses the shared surface for cited and representative details", () => {
    for (const file of [
      "../../frontend/components/access-pages.tsx",
      "../../frontend/components/canonical/canonical-workspace.tsx",
      "../../frontend/components/module-kit/module-page.tsx",
      "../../frontend/components/masters/organization-workspace.tsx",
      "../../frontend/components/masters/employee-workspace.tsx",
      "../../frontend/app/app/operations/_components/transaction-workspace.tsx",
      "../../frontend/app/platform/tenants/[id]/page.tsx",
    ])
      expect(source(file)).toContain("<Modal");
  });

  it("UI01-REFLOW-03 exposes mobile semantic cards for Operations and Finance", () => {
    const operations = source(
      "../../frontend/components/operations/operations-workbench.tsx",
    );
    const finance = source(
      "../../frontend/components/finance/finance-workbench.tsx",
    );
    expect(operations).toContain('aria-label="Operations records"');
    expect(operations).toContain("styles.mobileCards");
    expect(finance).toContain('aria-label="Records"');
    expect(finance).toContain("styles.mobileCards");
  });

  it("UI01-MODAL-04 preserves failed dialog input and blocks duplicate submits", () => {
    for (const file of [
      "../../frontend/components/operations/operations-workbench.tsx",
      "../../frontend/components/finance/finance-workbench.tsx",
    ]) {
      const workbench = source(file);
      expect(workbench).toContain("pendingRef.current");
      expect(workbench).toContain("idempotencyKey.current");
      expect(workbench).toContain('role="alert"');
      expect(workbench).toContain("correlationId");
      expect(workbench).toContain("disabled={busy || pending}");
    }
  });

  it("UI01-MODAL-05 closes master details before focused version-safe editing", () => {
    for (const file of [
      "../../frontend/components/masters/organization-workspace.tsx",
      "../../frontend/components/masters/employee-workspace.tsx",
    ]) {
      const workspace = source(file);
      expect(workspace).toContain("editTarget");
      expect(workspace).toContain("setSelected(null)");
      expect(workspace).toContain("editFocus.current?.focus()");
      expect(workspace).toContain("expectedVersion: editTarget.version");
    }
  });
});
