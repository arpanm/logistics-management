import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, withPlatform } from "./index.js";
import {
  DEMO_CONTENT_HASH,
  DEMO_DATASET_VERSION,
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
      users: 6,
      memberships: 6,
      indents: 4,
      trips: 2,
      invoices: 2,
      payouts: 1,
      markers: 1,
      dispositions: ["CREATE", "UPDATE", "REJECT"],
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
      internal_links: 3,
      external_employee_links: 0,
      driver_links: 1,
    });
  });
});
