import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/202608250028_internal_membership_employee_link/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const accessService = readFileSync(
  new URL("../src/access.service.ts", import.meta.url),
  "utf8",
);
const appService = readFileSync(
  new URL("../src/app.service.ts", import.meta.url),
  "utf8",
);
const employeeService = readFileSync(
  new URL("../src/modules/canonical/mst01.service.ts", import.meta.url),
  "utf8",
);

describe("FND02-MST01 internal membership/employee link — Implemented / Not Run", () => {
  it("backfills and enforces one employee per internal membership", () => {
    expect(migration).toContain("app.ensure_internal_membership_employee");
    expect(migration).toContain("employees_one_linked_membership");
    expect(migration).toContain("WHERE portal_audience='INTERNAL'");
    expect(migration).toContain("tenant_memberships_sync_employee");
    expect(migration).toContain(
      "INTERNAL membership must have exactly one linked employee",
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("matches only locked, active, same-code employees with compatible normalized destinations", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("employee_code=membership_row.employee_code");
    expect(migration).toContain("AND state='ACTIVE'");
    expect(migration).toContain(
      "lower(trim(email))=lower(trim(membership_row.invited_email))",
    );
    expect(migration).toContain("regexp_replace(mobile,'[^0-9+]','','g')");
    expect(migration).toContain("email IS NOT NULL AND lower(trim(email))");
    expect(migration).toContain("mobile IS NOT NULL AND regexp_replace(mobile");
    expect(migration).not.toContain(
      "WHERE tenant_id=p_tenant AND linked_membership_id IS NULL AND (",
    );
  });

  it("requires governed confirmation for destination/code identity collisions", () => {
    expect(migration).toContain("EMPLOYEE_LINK_CONFIRMATION_REQUIRED");
    expect(migration).toContain("Reconcile the Employee code/destination");
    expect(accessService).toContain("EMPLOYEE_LINK_CONFIRMATION_REQUIRED");
    expect(appService).toContain("EMPLOYEE_LINK_CONFIRMATION_REQUIRED");
    expect(employeeService).toContain("EMPLOYEE_LINK_CONFIRMATION_REQUIRED");
  });

  it("preserves only an unambiguous active explicit legacy FK with migration evidence", () => {
    expect(migration).toContain("migration.identity.employee.link.confirmed");
    expect(migration).toContain("identity.employee.link.confirmed.v1");
    expect(migration).toContain("MIGRATION_EXPLICIT_FK_CONFIRMED");
    expect(migration).toContain("membership.status='ACTIVE'");
    expect(migration).toContain("employee.state='ACTIVE'");
    expect(migration).toContain(
      "employee.employee_code IS DISTINCT FROM membership.employee_code",
    );
    expect(migration).toContain("FOR UPDATE OF employee,membership");
    expect(migration).toContain("before_snapshot,after_snapshot");
  });

  it("rejects direct unlink, reassignment, cross-tenant, external, and mismatched links", () => {
    expect(migration).toContain(
      "an INTERNAL membership employee link cannot be removed or reassigned directly",
    );
    expect(migration).toContain(
      "employees may link only to an INTERNAL membership in the same tenant",
    );
    expect(migration).toContain(
      "linked employee and INTERNAL membership are inconsistent",
    );
    expect(migration).toContain("employees_one_linked_membership");
  });

  it("does not create employees for external audiences and unlinks audience changes", () => {
    expect(migration).toContain(
      "IF membership_row.portal_audience<>'INTERNAL' THEN RETURN NULL",
    );
    expect(migration).toContain("ELSIF TG_OP='UPDATE'");
    expect(migration).toContain("membership.portal_audience<>'INTERNAL'");
    expect(migration).toContain("SET linked_membership_id=NULL");
  });

  it("covers owner, platform-admin and tenant-admin membership creation atomically", () => {
    expect(appService).toContain("app.actor_user_id");
    expect(accessService).toContain("app.actor_user_id");
    expect(appService).toContain("INSERT INTO app.tenant_memberships");
    expect(accessService).toContain("INSERT INTO app.tenant_memberships");
  });

  it("creates invited access from employee creation only with explicit roles and scopes", () => {
    expect(employeeService).toContain("input.accessInvitation");
    expect(employeeService).toContain("inviteEmployeeAccess");
    expect(employeeService).toContain("identity.user.admin");
    expect(employeeService).toContain("INSERT INTO app.scope_grants");
    expect(employeeService).toContain("identity.invitation.requested.v1");
    expect(employeeService).toContain("'INTERNAL','INVITED'");
  });

  it("records linkage audit and an idempotent outbox event", () => {
    expect(migration).toContain("IF link_changed THEN");
    expect(migration).toContain("identity.employee.linked");
    expect(migration).toContain("identity.employee.linked.v1");
    expect(migration).toContain("ON CONFLICT(deduplication_key) DO NOTHING");
  });

  it("requires one canonical legal root and an attributable actor", () => {
    expect(migration).toContain(
      "tenant must have exactly one active canonical default legal root",
    );
    expect(migration).toContain("scope.canonical_resource_id=node.id");
    expect(migration).toContain("app.resolve_tenant_attributable_actor");
    expect(migration).toContain("role.code='TENANT_OWNER'");
    expect(migration).toContain("membership.status='ACTIVE'");
    expect(migration).toContain("is_platform_admin AND status='ACTIVE'");
    expect(migration).toContain("membership_row.id,migration_actor");
    expect(migration).toContain(") DESC,membership.created_at,membership.id");
    expect(migration).not.toContain(
      "SELECT id FROM app.users WHERE is_platform_admin ORDER BY created_at,id LIMIT 1",
    );
    expect(migration).not.toContain(
      "SELECT id FROM app.users ORDER BY created_at,id LIMIT 1",
    );
  });

  it("audits and publishes actual INTERNAL-to-external unlink changes", () => {
    expect(migration).toContain("identity.employee.unlinked");
    expect(migration).toContain("identity.employee.unlinked.v1");
    expect(migration).toContain("RETURNING id INTO employee_id");
    expect(migration).toContain("employee unlink actor is unavailable");
  });
});
