import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantCreateSchema } from "@logistics/domain";
import { withTenant } from "@logistics/db";
import { AppService, AppError } from "../src/app.service.js";
import { AccessMastersService } from "../src/modules/remediation/access-masters.service.js";

const tenant = (code: string, email: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Pvt Ltd`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Directory Road",
      postalCode: "700001",
      postalLocalityId: "70000100-0000-4000-8000-000000000001",
      country: "IN",
    },
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    currency: "INR",
    fiscalYearStart: { month: 4, day: 1 },
    legalEntity: { name: `${code} Entity`, code },
    support: { name: "Support", email: `support-${email}` },
    owner: { name: `${code} Owner`, email },
    branding: {
      shortName: code,
      primaryColor: "#16324F",
      accentColor: "#D97706",
    },
    active: true,
  });

describe.sequential("rapid access and masters remediation", () => {
  const app = new AppService();
  const service = new AccessMastersService(app);
  let ownerA: Awaited<ReturnType<AppService["session"]>>;
  let ownerB: Awaited<ReturnType<AppService["session"]>>;
  beforeAll(async () => {
    const loggedIn = await app.login(
      process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
      process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
      undefined,
      "rapid-remediation-login",
    );
    if (!("sessionToken" in loggedIn)) throw new Error("Platform login failed");
    const platform = await app.session(loggedIn.sessionToken);
    const a = await app.provision(
      platform,
      tenant("RMA", "rapid-a@test.local"),
      "rapid-a",
      "rapid-a",
    );
    const b = await app.provision(
      platform,
      tenant("RMB", "rapid-b@test.local"),
      "rapid-b",
      "rapid-b",
    );
    const acceptedA = await app.acceptInvitation(
      String(a.invitationUrl).split("token=")[1]!,
      "Rapid A",
      "OwnerPassword!234",
      "rapid-accept-a",
    );
    const acceptedB = await app.acceptInvitation(
      String(b.invitationUrl).split("token=")[1]!,
      "Rapid B",
      "OwnerPassword!234",
      "rapid-accept-b",
    );
    ownerA = await app.session(acceptedA.sessionToken);
    ownerB = await app.session(acceptedB.sessionToken);
  });
  afterAll(async () => app.onModuleDestroy());

  it("RAPID-FND02-01: directory filters paginate and dossier never crosses tenants", async () => {
    const page = await service.directory(ownerA, {
      search: "Rapid",
      audience: "INTERNAL",
      page: 1,
      pageSize: 10,
    });
    expect(page.pageSize).toBe(10);
    expect(page.items.length).toBeGreaterThan(0);
    await expect(
      service.userDossier(ownerB, String(page.items[0]!.id)),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
  });

  it("RAPID-FND02-02: profile edit is versioned, audited and exposes session/MFA/history panels", async () => {
    const page = await service.directory(ownerA, { page: 1, pageSize: 10 });
    const id = String(page.items[0]!.id);
    const before = await service.userDossier(ownerA, id);
    await service.updateProfile(
      ownerA,
      id,
      {
        displayName: "Rapid Owner Edited",
        employeeCode: "RAPID-OWNER",
        portalAudience: "INTERNAL",
        expectedVersion: before.profile.version,
        reason: "Corrected by tenant administrator",
      },
      "rapid-profile-key",
      "rapid-profile-edit",
    );
    const after = await service.userDossier(ownerA, id);
    expect(after.profile.displayName).toBe("Rapid Owner Edited");
    expect(after.sessions).toBeInstanceOf(Array);
    expect(after.mfa).toBeInstanceOf(Array);
    expect(
      after.history.some(
        (entry) => entry.action === "identity.profile.updated",
      ),
    ).toBe(true);
  });

  it("RAPID-CFG01-01: configured truck/body/cargo references are tenant isolated", async () => {
    const truck = await service.createCatalog(
      ownerA,
      {
        kind: "TRUCK_TYPE",
        code: "LCV",
        name: "Light commercial vehicle",
        capacityMilli: "3500000",
      },
      "rapid-truck-key",
      "rapid-truck",
    );
    const own = await service.catalogs(ownerA, "TRUCK_TYPE", "LCV");
    const other = await service.catalogs(ownerB, "TRUCK_TYPE", "LCV");
    expect(own.items.map((item) => item.id)).toContain(truck.id);
    expect(other.items).toHaveLength(0);
    await expect(
      service.createCatalog(
        ownerA,
        {
          kind: "TRUCK_TYPE",
          code: "LCV",
          name: "Light commercial vehicle",
          capacityMilli: "3500000",
        },
        "rapid-truck-key",
        "rapid-truck-replay",
      ),
    ).resolves.toMatchObject({ id: truck.id, replayed: true });
  });

  it("RAPID-MST03-01: unknown PIN blocks vendor creation without partial mutation", async () => {
    await expect(
      service.createEnhanced(
        ownerA,
        "vendors",
        {
          code: "BADPIN",
          legalName: "Blocked PIN Vendor",
          paymentTermsDays: 0,
          address: {
            line1: "1 Unknown Road",
            postalCode: "999999",
            postalLocalityId: crypto.randomUUID(),
          },
        },
        "rapid-bad-pin-key",
        "rapid-bad-pin",
      ),
    ).rejects.toBeInstanceOf(AppError);
    const rows = await withTenant(app.db, String(ownerA.activeTenantId), (tx) =>
      tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int count FROM app.vendors WHERE tenant_id=$1::uuid AND code='BADPIN'`,
        ownerA.activeTenantId,
      ),
    );
    expect(rows[0]!.count).toBe(0);
  });

  it("RAPID-MIG-022: runtime privileges and canonical postal foreign keys are declared", () => {
    const migration = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202608250022_access_master_ux/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON app.transport_reference_masters TO logistics_app",
    );
    expect(migration).toContain(
      "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO logistics_app",
    );
    expect(migration).toContain("postal_reference.postal_localities");
    expect(migration).toContain("FOREIGN KEY(postal_directory_version_id)");
    const handoff = readFileSync(
      new URL(
        "../../../scripts/sql/postal-ownership-handoff.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(handoff).toContain(
      "GRANT SELECT,REFERENCES ON postal_reference.postal_directory_versions,postal_reference.postal_localities TO logistics_app",
    );
    expect(handoff).toContain(
      "ARRAY['app.client_locations','app.vendors','app.drivers']",
    );
  });

  it("RAPID-FND02-03: portal audience changes require compatible roles and atomically invalidate authorization context", async () => {
    const membershipId = String(ownerA.membershipId);
    const before = await service.userDossier(ownerA, membershipId);
    await expect(
      service.updateProfile(
        ownerA,
        membershipId,
        {
          displayName: before.profile.displayName,
          employeeCode: before.profile.employeeCode,
          portalAudience: "VENDOR",
          expectedVersion: before.profile.version,
          reason: "Move user to vendor portal after review",
        },
        "rapid-incompatible-audience",
        "rapid-incompatible-audience",
      ),
    ).rejects.toMatchObject({ code: "ROLE_AUDIENCE_INCOMPATIBLE" });

    await withTenant(app.db, String(ownerA.activeTenantId), (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.roles r SET portal_audiences=ARRAY['INTERNAL','VENDOR']::text[]
         FROM app.membership_role_assignments a
         WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid
           AND a.role_id=r.id AND r.tenant_id=a.tenant_id AND r.code='TENANT_OWNER'`,
        ownerA.activeTenantId,
        membershipId,
      ),
    );
    const changed = await service.updateProfile(
      ownerA,
      membershipId,
      {
        displayName: before.profile.displayName,
        employeeCode: before.profile.employeeCode,
        portalAudience: "VENDOR",
        expectedVersion: before.profile.version,
        reason: "Move user to vendor portal after role review",
      },
      "rapid-compatible-audience",
      "rapid-compatible-audience",
    );
    const evidence = await withTenant(
      app.db,
      String(ownerA.activeTenantId),
      (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            authorizationVersion: number;
            revokedSessions: number;
            contextBumps: number;
            auditAfter: Record<string, unknown>;
          }>
        >(
          `SELECT m.authorization_version AS "authorizationVersion",
             (SELECT count(*)::int FROM app.sessions s WHERE s.active_tenant_id=m.tenant_id AND s.membership_id=m.id AND s.revoked_reason='PORTAL_AUDIENCE_CHANGED') AS "revokedSessions",
             (SELECT count(*)::int FROM app.sessions s WHERE s.active_tenant_id=m.tenant_id AND s.membership_id=m.id AND s.context_version>1) AS "contextBumps",
             (SELECT after_json FROM audit.audit_events e WHERE e.tenant_id=m.tenant_id AND e.target_type='membership' AND e.target_id=m.id AND e.correlation_id='rapid-compatible-audience' ORDER BY e.occurred_at DESC LIMIT 1) AS "auditAfter"
           FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid`,
          ownerA.activeTenantId,
          membershipId,
        ),
    );
    expect(Number(changed.authorizationVersion)).toBeGreaterThan(
      Number(ownerA.membershipAuthVersion),
    );
    expect(evidence[0]).toMatchObject({
      revokedSessions: expect.any(Number),
      contextBumps: expect.any(Number),
      auditAfter: {
        portalAudience: "VENDOR",
        revokedSessionCount: expect.any(Number),
      },
    });
    expect(evidence[0]!.revokedSessions).toBeGreaterThan(0);
    expect(evidence[0]!.contextBumps).toBeGreaterThan(0);
  });
});
import { readFileSync } from "node:fs";
