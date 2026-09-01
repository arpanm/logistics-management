import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, withPlatform } from "./index.js";
import {
  DEMO_CONTENT_HASH,
  DEMO_DATASET_VERSION,
  DEMO_SHOWCASE_MANIFEST,
  seedDemoData,
} from "./demo-seed.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const db = databaseUrl ? createDatabase(databaseUrl) : undefined;
const env = {
  DEMO_DATA_ENABLED: "true",
  APP_ENV: "test",
  DEMO_USER_PASSWORD: "DemoIntegration!234",
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  PLATFORM_ADMIN_EMAIL: "demo-seed-platform@test.local",
};

describe.skipIf(!databaseUrl)("demo data bootstrap", () => {
  beforeAll(async () => {
    const passwordHash = await argon2.hash("IndependentPlatform!234");
    await withPlatform(
      db!,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO app.users(id,email,display_name,password_hash,status,is_platform_admin)
        VALUES('20000000-0000-4000-8000-000000000001'::uuid,${env.PLATFORM_ADMIN_EMAIL},'Independent Test Platform Admin',${passwordHash},'ACTIVE',true)
        ON CONFLICT(email) DO UPDATE SET is_platform_admin=true,status='ACTIVE'
      `,
    );
    await seedDemoData(env, databaseUrl);
  });
  afterAll(async () => db?.$disconnect());

  it("is rerunnable without duplicating records or rotating credentials", async () => {
    const first = await withPlatform(db!, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          (SELECT count(*)::int FROM app.users WHERE email LIKE 'demo.%@logistics.test') users,
          (SELECT count(*)::int FROM app.tenant_memberships WHERE tenant_id='10000000-0000-4000-8000-000000000100') memberships,
          (SELECT count(*)::int FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100') indents,
          (SELECT count(*)::int FROM app.trips WHERE tenant_id='10000000-0000-4000-8000-000000000100') trips,
          (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100') invoices,
          (SELECT count(*)::int FROM app.payment_batches WHERE tenant_id='10000000-0000-4000-8000-000000000100') payouts,
          (SELECT count(*)::int FROM app.demo_bootstrap_runs WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND dataset_version='${DEMO_DATASET_VERSION}' AND content_hash='${DEMO_CONTENT_HASH}') markers,
          (SELECT array_agg(disposition ORDER BY row_number) FROM app.import_rows WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND job_id='10000000-0000-4000-8000-000000000951') dispositions,
          (SELECT jsonb_agg(jsonb_build_object('id',id,'version',version,'hash',password_hash) ORDER BY id) FROM app.users WHERE email LIKE 'demo.%@logistics.test') credentials
      `),
    );
    const replay = await seedDemoData(env, databaseUrl);
    const second = await withPlatform(db!, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          (SELECT count(*)::int FROM app.users WHERE email LIKE 'demo.%@logistics.test') users,
          (SELECT count(*)::int FROM app.tenant_memberships WHERE tenant_id='10000000-0000-4000-8000-000000000100') memberships,
          (SELECT count(*)::int FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100') indents,
          (SELECT count(*)::int FROM app.trips WHERE tenant_id='10000000-0000-4000-8000-000000000100') trips,
          (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100') invoices,
          (SELECT count(*)::int FROM app.payment_batches WHERE tenant_id='10000000-0000-4000-8000-000000000100') payouts,
          (SELECT count(*)::int FROM app.demo_bootstrap_runs WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND dataset_version='${DEMO_DATASET_VERSION}' AND content_hash='${DEMO_CONTENT_HASH}') markers,
          (SELECT array_agg(disposition ORDER BY row_number) FROM app.import_rows WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND job_id='10000000-0000-4000-8000-000000000951') dispositions,
          (SELECT jsonb_agg(jsonb_build_object('id',id,'version',version,'hash',password_hash) ORDER BY id) FROM app.users WHERE email LIKE 'demo.%@logistics.test') credentials
      `),
    );
    expect(replay).toEqual({ replayed: true, rotated: false });
    expect(second[0]).toEqual(first[0]);
    expect(second[0]).toMatchObject({
      users: 9,
      memberships: 9,
      indents: DEMO_SHOWCASE_MANIFEST.indents,
      trips: DEMO_SHOWCASE_MANIFEST.trips,
      invoices: DEMO_SHOWCASE_MANIFEST.clientInvoices,
      payouts: DEMO_SHOWCASE_MANIFEST.paymentBatches,
      markers: 1,
      dispositions: ["CREATE", "UPDATE", "REJECT"],
    });
  });

  it("materializes the reconciled UI-01 showcase graph only inside the demo tenant", async () => {
    const [counts] = await withPlatform(db!, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, number>>>(`
        SELECT
          (SELECT count(*)::int FROM app.tenants WHERE id='10000000-0000-4000-8000-000000000100') tenant,
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND node_type='REGION') regions,
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND node_type='BRANCH') branches,
          (SELECT count(*)::int FROM app.employees e JOIN app.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.id=e.linked_membership_id WHERE e.tenant_id='10000000-0000-4000-8000-000000000100' AND m.portal_audience='INTERNAL') "internalEmployees",
          (SELECT count(*)::int FROM app.clients WHERE tenant_id='10000000-0000-4000-8000-000000000100') clients,
          (SELECT count(*)::int FROM app.client_locations WHERE tenant_id='10000000-0000-4000-8000-000000000100') "clientLocations",
          (SELECT count(*)::int FROM app.vendors WHERE tenant_id='10000000-0000-4000-8000-000000000100') vendors,
          (SELECT count(*)::int FROM app.vendors WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND state='ACTIVE') "activeVendors",
          (SELECT count(*)::int FROM app.vehicles WHERE tenant_id='10000000-0000-4000-8000-000000000100') vehicles,
          (SELECT count(*)::int FROM app.drivers WHERE tenant_id='10000000-0000-4000-8000-000000000100') drivers,
          (SELECT count(*)::int FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100') indents,
          (SELECT count(*)::int FROM app.allocations WHERE tenant_id='10000000-0000-4000-8000-000000000100') allocations,
          (SELECT count(*)::int FROM app.trips WHERE tenant_id='10000000-0000-4000-8000-000000000100') trips,
          (SELECT count(*)::int FROM app.pod_tasks WHERE tenant_id='10000000-0000-4000-8000-000000000100') "podTasks",
          (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100') "clientInvoices",
          (SELECT count(*)::int FROM app.receipts WHERE tenant_id='10000000-0000-4000-8000-000000000100') receipts,
          (SELECT count(*)::int FROM app.vendor_bills WHERE tenant_id='10000000-0000-4000-8000-000000000100') "vendorBills",
          (SELECT count(*)::int FROM app.payment_batches WHERE tenant_id='10000000-0000-4000-8000-000000000100') "paymentBatches",
          (SELECT count(*)::int FROM app.operational_alerts WHERE tenant_id='10000000-0000-4000-8000-000000000100') alerts,
          (SELECT count(*)::int FROM app.contract_lanes WHERE tenant_id='10000000-0000-4000-8000-000000000100') lanes,
          (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND effective_from<='2026-08-31T12:00:00+05:30'::timestamptz AND (effective_to IS NULL OR effective_to>'2026-08-31T12:00:00+05:30'::timestamptz)) "currentCommercialExamples",
          (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND effective_to<='2026-08-31T12:00:00+05:30'::timestamptz) "expiredCommercialExamples",
          (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND effective_from>'2026-08-31T12:00:00+05:30'::timestamptz) "upcomingCommercialExamples",
          (SELECT count(*)::int FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND state IN ('OPEN','PARTIALLY_ALLOCATED')) "placementLensRows",
          (SELECT count(*)::int FROM app.pod_tasks WHERE tenant_id='10000000-0000-4000-8000-000000000100') "podLensRows",
          (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100') "collectionLensRows",
          (SELECT count(*)::int FROM app.trips WHERE tenant_id='10000000-0000-4000-8000-000000000100') "tripLensRows",
          (SELECT count(*)::int FROM app.vendor_bills WHERE tenant_id='10000000-0000-4000-8000-000000000100') "vendorPayableLensRows",
          (SELECT count(DISTINCT client_id)::int FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND state IN ('OPEN','PARTIALLY_ALLOCATED')) "placementPortfolios",
          (SELECT count(DISTINCT i.client_id)::int FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE p.tenant_id='10000000-0000-4000-8000-000000000100') "podPortfolios",
          (SELECT count(DISTINCT client_id)::int FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100') "collectionPortfolios",
          (SELECT count(DISTINCT i.client_id)::int FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE t.tenant_id='10000000-0000-4000-8000-000000000100') "tripPortfolios",
          (SELECT count(DISTINCT vendor_id)::int FROM app.vendor_bills WHERE tenant_id='10000000-0000-4000-8000-000000000100') "vendorPayablePortfolios",
          (SELECT count(*)::int FROM app.tenant_configuration WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND namespace='notifications' AND value->>'suppressOutbound'='true' AND value->>'syntheticDestinationsOnly'='true') "notificationSuppression",
          (SELECT count(*)::int FROM (
            SELECT tenant_id FROM app.clients WHERE id::text LIKE '11000000-0000-4000-8000-%'
            UNION ALL SELECT tenant_id FROM app.indents WHERE id::text LIKE '11000000-0000-4000-8000-%'
            UNION ALL SELECT tenant_id FROM app.client_invoices WHERE id::text LIKE '11000000-0000-4000-8000-%'
            UNION ALL SELECT tenant_id FROM app.vendor_bills WHERE id::text LIKE '11000000-0000-4000-8000-%'
          ) demo_rows WHERE tenant_id<>'10000000-0000-4000-8000-000000000100') "foreignTenantRows",
          ((SELECT count(*) FROM app.client_invoices WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND total_minor<>taxable_minor+tax_minor)
            +(SELECT count(*) FROM app.vendor_bills WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND payable_minor<>taxable_minor+gst_minor-tds_minor-deduction_minor-advance_minor))::int "financialMismatchRows",
          ((SELECT count(*) FROM app.indents WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND (requested_vehicles<=0 OR quantity_milli<=0))
            +(SELECT count(*) FROM app.allocations WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND allotted_vehicles<=0))::int "invalidQuantityRows"
      `),
    );
    expect(counts).toMatchObject({
      ...DEMO_SHOWCASE_MANIFEST,
      foreignTenantRows: 0,
      financialMismatchRows: 0,
      invalidQuantityRows: 0,
    });
  });

  it("rejects a changed configured password unless rotation is explicit", async () => {
    await expect(
      seedDemoData(
        { ...env, DEMO_USER_PASSWORD: "DifferentDemo!234" },
        databaseUrl,
      ),
    ).rejects.toThrow("DEMO_ROTATE_PASSWORD=true");
  });

  it("links internal users to employees and external personas only to their domain records", async () => {
    const [result] = await withPlatform(db!, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT
          (SELECT count(*)::int FROM app.tenant_memberships m JOIN app.employees e ON e.tenant_id=m.tenant_id AND e.linked_membership_id=m.id WHERE m.tenant_id='10000000-0000-4000-8000-000000000100' AND m.portal_audience='INTERNAL') internal_links,
          (SELECT count(*)::int FROM app.tenant_memberships m JOIN app.employees e ON e.tenant_id=m.tenant_id AND e.linked_membership_id=m.id WHERE m.tenant_id='10000000-0000-4000-8000-000000000100' AND m.portal_audience<>'INTERNAL') external_employee_links,
          (SELECT count(*)::int FROM app.drivers WHERE tenant_id='10000000-0000-4000-8000-000000000100' AND portal_membership_id='10000000-0000-4000-8000-000000000405') driver_links
      `),
    );
    expect(result).toMatchObject({
      internal_links: 6,
      external_employee_links: 0,
      driver_links: 1,
    });
  });

  it("uses real security time and audits explicit password rotation", async () => {
    const [clock] = await withPlatform(db!, async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.current_tenant_id','10000000-0000-4000-8000-000000000100',true)",
      );
      await tx.$executeRawUnsafe(`
        INSERT INTO app.sessions(
          id,token_hash,csrf_hash,user_id,active_tenant_id,context_version,
          expires_at,user_auth_version,membership_id,membership_auth_version
        )
        SELECT '30000000-0000-4000-8000-000000000001'::uuid,'demo-rotation-session','demo-rotation-csrf',
          u.id,m.tenant_id,1,clock_timestamp()+interval '1 day',u.auth_version,m.id,m.authorization_version
        FROM app.users u JOIN app.tenant_memberships m ON m.user_id=u.id
        WHERE u.id='10000000-0000-4000-8000-000000000002'::uuid
        ON CONFLICT(token_hash) DO UPDATE SET revoked_at=null,revoked_reason=null,
          expires_at=clock_timestamp()+interval '1 day',updated_at=clock_timestamp()
      `);
      return tx.$queryRawUnsafe<Array<{ before: Date }>>(
        "SELECT clock_timestamp() before",
      );
    });

    try {
      const rotation = await seedDemoData(
        {
          ...env,
          DEMO_USER_PASSWORD: "RotatedDemoAccess!234",
          DEMO_ROTATE_PASSWORD: "true",
        },
        databaseUrl,
      );
      const [result] = await withPlatform(db!, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            changed_users: number;
            revoked_sessions: number;
            occurred_at: Date;
            after_json: Record<string, unknown>;
          }>
        >(`
          SELECT
            (SELECT count(*)::int FROM app.users WHERE email LIKE 'demo.%@logistics.test' AND credentials_changed_at >= '${clock.before.toISOString()}'::timestamptz) changed_users,
            (SELECT count(*)::int FROM app.sessions WHERE token_hash='demo-rotation-session' AND revoked_at >= '${clock.before.toISOString()}'::timestamptz AND revoked_reason='DEMO_PASSWORD_ROTATED') revoked_sessions,
            occurred_at,after_json
          FROM audit.audit_events
          WHERE tenant_id='10000000-0000-4000-8000-000000000100'::uuid
            AND action='demo.credentials.rotated'
          ORDER BY occurred_at DESC,id DESC LIMIT 1
        `),
      );
      expect(rotation).toEqual({ replayed: true, rotated: true });
      expect(result.changed_users).toBe(6);
      expect(result.revoked_sessions).toBe(1);
      expect(result.occurred_at.getTime()).toBeGreaterThanOrEqual(
        clock.before.getTime(),
      );
      expect(result.after_json).toMatchObject({
        dataset: "logistics-end-to-end-demo",
        datasetVersion: DEMO_DATASET_VERSION,
        affectedUserCount: 6,
        revokedSessionCount: 1,
        sessionsRevoked: true,
      });
    } finally {
      await seedDemoData({ ...env, DEMO_ROTATE_PASSWORD: "true" }, databaseUrl);
      const hashes = await withPlatform(db!, (tx) =>
        tx.$queryRawUnsafe<Array<{ password_hash: string }>>(`
          SELECT password_hash FROM app.users
          WHERE email LIKE 'demo.%@logistics.test' ORDER BY id
        `),
      );
      expect(hashes).toHaveLength(6);
      for (const row of hashes) {
        expect(
          await argon2.verify(row.password_hash, env.DEMO_USER_PASSWORD),
        ).toBe(true);
      }
    }
  });
});
