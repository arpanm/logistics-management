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
const workbench = readFileSync(
  new URL(
    "../../frontend/components/operations/operations-workbench.tsx",
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
    expect(service).toContain("operations.trip.action:${id}");
    expect(service).toContain("INSERT INTO app.trip_events");
    expect(service).toContain("version=version+1");
    expect(service).toContain("INSERT INTO audit.audit_events");
    expect(service).toContain("INSERT INTO app.outbox_events");
  });

  it("OPS-WB-06 exposes the open-indent landing queue with risk, ownership, edit, cancel, and allocation controls", () => {
    expect(controller).toContain('@Patch("indents/:id")');
    expect(service).toContain('risk: z.enum(["", "GREEN", "YELLOW", "RED"])');
    expect(service).toContain('"awaitingVehicles"');
    expect(service).toContain("REQUEST_BELOW_ALLOCATION");
    expect(service).toContain("VERSION_CONFLICT");
    expect(service).toContain("indent.updated.v1");
    for (const action of [
      "Create indent",
      "Edit indent",
      "Allocate truck",
      "Cancel",
    ])
      expect(workbench).toContain(action);
  });

  it("OPS-WB-07 provides every state-valid allocation command and vendor-scoped eligible assets", () => {
    expect(controller).toContain('@Get("allocations/:id/eligible-assets")');
    expect(service).toContain("aa.allocation_id<>$4::uuid");
    expect(service).toContain("VENDOR_CAPACITY_EXCEEDED");
    for (const action of [
      "Accept",
      "Reject",
      "Expire",
      "Assign truck & driver",
      "Replace assignment",
      "Release NTP",
      "Confirm placed",
      "Create trip",
      "Cancel",
    ])
      expect(workbench).toContain(action);
    expect(workbench).toContain("Auto-allocation rules");
    expect(workbench).not.toContain("prompt(");
  });

  it("OPS-WB-08 captures contextual trip evidence with optimistic concurrency", () => {
    expect(controller).toContain('@Post("trips/:id/transition")');
    for (const evidence of [
      "expectedVersion",
      "loadQuantityMilli",
      "sealNumber",
      "delayReason",
      "receiverName",
      "odometerKm",
    ]) {
      expect(service).toContain(evidence);
      expect(workbench).toContain(evidence);
    }
    expect(service).toContain("Receiver name is required to complete delivery");
  });

  it("OPS-WB-09 commits each trip action atomically and rejects stale or repeated acceptance", () => {
    const action = service.slice(
      service.indexOf("async tripAction("),
      service.indexOf("async rules("),
    );
    expect(action).toContain("FOR UPDATE");
    expect(action).toContain("input.expectedVersion");
    expect(action).toContain("VERSION_CONFLICT");
    expect(action).toContain("trip.accepted === true");
    expect(action).toContain("INSERT INTO app.trip_events");
    expect(action).toContain("UPDATE app.trips SET state=$1");
    expect(action).toContain("version=version+1");
    expect(action.indexOf("INSERT INTO app.trip_events")).toBeLessThan(
      action.indexOf("INSERT INTO audit.audit_events"),
    );
    expect(action.indexOf("INSERT INTO audit.audit_events")).toBeLessThan(
      action.indexOf("INSERT INTO app.outbox_events"),
    );
  });

  it("OPS-WB-10 submits allocation version and requires replacement evidence", () => {
    const canonical = readFileSync(
      new URL("../src/modules/canonical/canonical.service.ts", import.meta.url),
      "utf8",
    );
    const assignment = canonical.slice(
      canonical.indexOf("async assignAllocation("),
      canonical.indexOf("async createTrip("),
    );
    expect(assignment).toContain("expectedVersion");
    expect(assignment).toContain("VERSION_CONFLICT");
    expect(assignment).toContain("REPLACEMENT_REASON_REQUIRED");
    expect(assignment).toContain("app.domain_resource_authorized");
    expect(assignment).toContain("'operations.admin','UPDATE','vehicles'");
    expect(assignment).toContain("'operations.admin','UPDATE','drivers'");
    expect(assignment.indexOf("REPLACEMENT_REASON_REQUIRED")).toBeLessThan(
      assignment.indexOf("UPDATE app.allocation_assignments SET assigned_to"),
    );
    expect(workbench).toContain("expectedVersion: selected?.version");
    expect(workbench).toContain('area("reason", "Replacement reason", true)');
  });

  it("OPS-WB-11 keeps the auto-allocation register query syntactically grouped and tenant authorized", () => {
    const rules = service.slice(
      service.indexOf("async rules("),
      service.indexOf("async saveRule("),
    );
    expect(rules).toContain("CASE WHEN ((r.client_id IS NULL OR");
    expect(rules).toContain("WHERE r.tenant_id=$1::uuid");
    expect(rules).toContain("app.domain_resource_authorized");
    expect(rules).toContain("'operations.read','READ','clients'");
    expect(rules).toContain("'operations.read','READ','lanes'");
    expect(rules).toContain("'operations.read','READ','vendors'");
    expect(rules).toContain("'sensitive.commercial_rate.read'");
  });
});
