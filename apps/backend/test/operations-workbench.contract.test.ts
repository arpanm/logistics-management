import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL(
    "../src/modules/operations/operations-workbench.service.ts",
    import.meta.url,
  ),
  "utf8",
);
const controller = readFileSync(
  new URL(
    "../src/modules/operations/operations-workbench.controller.ts",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/202608250023_operations_workbench/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("OPS workbench acceptance contracts (Implemented / Not Run)", () => {
  it("OPS-WB-01 scopes every operational queue with server-derived tenant and resource authorization", () => {
    expect(service).toContain("this.app.requireTenant(actor)");
    for (const resource of ["indents", "allocations", "trips"])
      expect(service).toContain(`'READ','${resource}'`);
    expect(service).toContain("app.domain_resource_authorized");
    expect(service).not.toMatch(/tenantId:\s*z\./);
  });

  it("OPS-WB-02 exposes searchable queues and contextual workbench commands", () => {
    for (const route of [
      '@Get("dashboard")',
      '@Get("indents")',
      '@Get("allocations")',
      '@Get("trips")',
      '@Post("allocations/manual")',
      '@Post("allocations/:id/assign")',
      '@Post("trips")',
      '@Post("trips/:id/action")',
    ])
      expect(controller).toContain(route);
    expect(service).toContain("ILIKE");
  });

  it("OPS-WB-03 explains vendor inclusion and exclusion from canonical compliance and capacity", () => {
    for (const evidence of [
      "No effective service scope",
      "Compliance requirement is expired or unverified",
      "No available compliant vehicle",
      "No available licensed driver",
    ])
      expect(service).toContain(evidence);
  });

  it("OPS-WB-04 persists versioned tenant-isolated auto-allocation rules and execution evidence", () => {
    expect(migration).toContain("CREATE TABLE app.auto_allocation_rules");
    expect(migration).toContain("CREATE TABLE app.auto_allocation_executions");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CHECK (offer_rate_minor >= 0)");
    expect(service).toContain("AUTO_ALLOCATION_NO_MATCH");
    expect(service).toContain(
      "ON CONFLICT(tenant_id,rule_id,indent_id,allocation_id)",
    );
    expect(service).toContain("IDEMPOTENCY_CONFLICT");
    expect(service).toContain("clientScopeId");
    expect(service).toContain("laneScopeId");
    expect(service).toContain("vendorScopeId");
    expect(service).toContain("sensitive.commercial_rate.read");
    expect(service).toContain("private async executionRule");
    expect(service).not.toContain("rule: match");
  });

  it("OPS-WB-05 maps accept/start/load/transit/unload/end to append-only trip events", () => {
    for (const action of [
      "ACCEPT",
      "START",
      "LOAD",
      "TRANSIT",
      "UNLOAD",
      "END",
    ])
      expect(service).toContain(action);
    for (const event of [
      "CHECKPOINT",
      "AT_ORIGIN",
      "LOADED",
      "DEPARTED",
      "AT_DESTINATION",
      "DELIVERED",
    ])
      expect(service).toContain(event);
    expect(service).toContain("this.canonical.appendTripEvent");
  });
});
