import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL("../src/modules/control/workbench.service.ts", import.meta.url),
  "utf8",
);
const controller = readFileSync(
  new URL("../src/modules/control/workbench.controller.ts", import.meta.url),
  "utf8",
);
const ui = readFileSync(
  new URL(
    "../../frontend/components/control/control-tower.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("CTL-01 completed control-tower contracts (Implemented / Not Run)", () => {
  it("CTL-UX-01 gates each lens by control and source-module capabilities", () => {
    expect(controller).toContain('@Get("access")');
    expect(service).toContain("c.capability_code='control.dashboard.read'");
    for (const value of [
      'placement: "operations.read"',
      'pod: "pod.read"',
      'collection: "finance.read"',
      'trip: "operations.read"',
      '"vendor-payable": "finance.read"',
    ])
      expect(service).toContain(value);
    expect(service).toContain("app.domain_resource_authorized");
    expect(ui).toContain("access.lenses.map");
  });

  it("CTL-UX-02 exposes canonical prototype-parity lenses and definitions", () => {
    for (const value of [
      "Live indents",
      "POD received",
      "Outstanding",
      "GPS silent",
      "Payment blocked",
      "Ageing guide:",
    ])
      expect(ui).toContain(value);
    for (const value of [
      "gpsSilent",
      "loadingDetention",
      "unloadingDetention",
      "paymentBlocked",
      "over45Minor",
    ])
      expect(service).toContain(value);
    expect(service).not.toContain("Math.random");
  });

  it("CTL-UX-03 provides client-location-record drill and contextual actions", () => {
    for (const value of [
      "PortfolioBoard",
      "LocationBoard",
      "RecordTable",
      "Drill-down breadcrumb",
      "Open in",
      "Vendor allocation",
      "Open allocation register",
    ])
      expect(ui).toContain(value);
  });

  it("CTL-UX-04 preserves filters, saved views, freshness and exact visible export", () => {
    for (const value of [
      "Search visible scope",
      "Traffic light",
      "Workflow status",
      "Ageing bucket",
      "Save current view",
      "Pause live refresh",
      "Download visible CSV",
      "Last canonical change",
    ])
      expect(ui).toContain(value);
    expect(ui).not.toContain("window.prompt");
    expect(service).toContain("control_saved_views");
    expect(service).toContain("control.view.exported");
    expect(service).toContain("csvCell");
  });

  it("CTL-UX-05 uses exact minor-unit rollups and collection ageing buckets", () => {
    expect(service).toContain("BigInt");
    expect(service).toContain("CURRENT");
    expect(service).toContain('"31_45"');
    expect(service).toContain('"46_90"');
    expect(service).toContain('"OVER_90"');
    expect(service).toContain("entry_type='REVERSAL'");
    expect(ui).toContain("BigInt");
  });

  it("CTL-AUTH-07 masks scoped payment values without sensitive payment access", () => {
    expect(service).toContain("'sensitive.payment.read','READ','invoices'");
    expect(service).toContain("'sensitive.payment.read','READ','vendor-bills'");
    expect(service).toContain("moneyVisible === false");
    expect(service).toContain('key.toLowerCase().includes("minor")');
    expect(service).toContain('moneyKeys.has(key) ? "••••"');
    expect(ui).toContain('if (minor === "••••") return "••••"');
    expect(ui).toContain('bucket.amountMinor === "••••"');
    expect(service).not.toContain("bank_account_number");
    expect(service).not.toContain("offered_rate_minor AS");
  });

  it("CTL-REC-08 deduplicates POD exposure by canonical invoice identity", () => {
    expect(service).toContain(
      "coalesce(ci.id::text,'REFERENCE:'||x.invoice_reference)",
    );
    expect(service).toContain("invoiceValueAtRisk.has(identity)");
    expect(service).toContain("invoiceValueAtRisk.values()");
  });

  it("CTL-TIME-09 evaluates all ageing from one as-of in tenant timezone", () => {
    expect(service).toContain("const asOf = new Date()");
    expect(service).toContain("AT TIME ZONE $5");
    expect(service).toContain("asOf.toISOString()");
    expect(service).not.toContain("current_date");
  });

  it("CTL-REC-10 matches Operations placement pre-breach policy", () => {
    expect(service).toContain("$4::timestamptz>=i.committed_placement_at");
    expect(service).toContain(
      "$4::timestamptz>=i.committed_placement_at-interval '24 hours'",
    );
    expect(service).not.toContain("committed_placement_at+interval '48 hours'");
  });

  it("CTL-UX-06 includes accessible loading, empty, retry and responsive states", () => {
    for (const value of [
      "aria-busy={loading}",
      'aria-live="polite"',
      'role="status"',
      'role="alert"',
      "Clear filters",
      "Retry",
      "LoadingRows",
    ])
      expect(ui).toContain(value);
  });
});
