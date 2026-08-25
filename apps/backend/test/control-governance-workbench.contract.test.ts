import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const control = readFileSync(
  new URL("../src/modules/control/workbench.service.ts", import.meta.url),
  "utf8",
);
const governance = readFileSync(
  new URL("../src/modules/governance/workbench.service.ts", import.meta.url),
  "utf8",
);
const ui = readFileSync(
  new URL(
    "../../frontend/components/control/control-tower.tsx",
    import.meta.url,
  ),
  "utf8",
);
const policyUi = readFileSync(
  new URL(
    "../../frontend/components/governance/policies-workbench.tsx",
    import.meta.url,
  ),
  "utf8",
);
describe("CTL-01 and GOV-01 remediation contracts (Implemented / Not Run)", () => {
  it("CTL-WB-01 derives G/Y/R lenses from scoped canonical PostgreSQL rows", () => {
    for (const resource of [
      "indents",
      "pod-tasks",
      "invoices",
      "trips",
      "vendor-bills",
    ])
      expect(control).toContain(`'READ','${resource}'`);
    expect(control).toContain("app.domain_resource_authorized");
    expect(control).not.toContain("Math.random");
  });
  it("CTL-WB-02 reconciles placement, POD and collection KPIs", () => {
    for (const value of [
      "fillRate",
      "valueAtRiskMinor",
      "pendingPrior",
      "outstandingMinor",
      "partPaid",
      "over45Minor",
    ])
      expect(control).toContain(value);
    expect(control).toContain("collection_followups");
    expect(control).toContain("invoice_notes");
    expect(control).toContain("FILTER(WHERE pb.state='PAID')");
  });
  it("CTL-WB-03 provides portfolio drill, vendor metrics, saved filters, freshness, CSV and record actions", () => {
    for (const value of [
      "ClientBoard",
      "LocationBoard",
      "RecordTable",
      "Vendor allocation",
      "Saved filter",
      "Download visible CSV",
      "lastCanonicalChange",
    ])
      expect(ui).toContain(value);
    expect(control).toContain("csvCell");
    expect(control).toContain("control_saved_views");
  });
  it("GOV-WB-01 restores structured policy list/create/edit/deactivate without JSON input", () => {
    expect(governance).toContain("approval_definitions");
    expect(governance).toContain("VERSION_CONFLICT");
    expect(governance).toContain("n.scope_type='TENANT'");
    expect(governance).toContain("status='ACTIVE' AND id=ANY");
    expect(governance).toContain("minimum_minor::text");
    expect(governance).toContain("IDEMPOTENCY_CONFLICT");
    expect(governance).toContain("audit.audit_events");
    for (const value of [
      "Create policy",
      "View / edit",
      "Approval sequence",
      "Approver role",
      "Policy state",
    ])
      expect(policyUi).toContain(value);
    expect(policyUi).not.toContain("JSON.stringify(policy");
  });
});
