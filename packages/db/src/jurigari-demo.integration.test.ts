import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, withPlatform } from "./index.js";
import { seedJurigariDemo } from "./jurigari-demo-seed.js";
import {
  JURIGARI_EXEMPLAR,
  JURIGARI_TENANT_ID,
} from "./jurigari-demo-profile.js";
import { verifyJurigariDemo } from "./verify-jurigari-demo.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const db = databaseUrl ? createDatabase(databaseUrl) : undefined;
const env = {
  JURIGARI_DATA_ENABLED: "true",
  APP_ENV: "test",
  JURIGARI_USER_PASSWORD: `${"A".repeat(16)}!1`,
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
  PLATFORM_ADMIN_EMAIL: "jurigari-seed-platform@test.local",
};

describe.skipIf(!databaseUrl)("Jurigari production demo bootstrap", () => {
  beforeAll(async () => {
    const passwordHash = await argon2.hash(`${"B".repeat(16)}!1`);
    await withPlatform(
      db!,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO app.users(id,email,display_name,password_hash,status,is_platform_admin)
        VALUES('40000000-0000-4000-8000-000000000001'::uuid,${env.PLATFORM_ADMIN_EMAIL},'Jurigari Test Platform Admin',${passwordHash},'ACTIVE',true)
        ON CONFLICT(email) DO UPDATE SET is_platform_admin=true,status='ACTIVE'
      `,
    );
  });
  afterAll(async () => db?.$disconnect());

  it("installs once, replays without duplicates, and passes secret-free verification", async () => {
    const first = await seedJurigariDemo(env, databaseUrl);
    const replay = await seedJurigariDemo(env, databaseUrl);
    const verification = await verifyJurigariDemo(databaseUrl);
    expect(first.rotated).toBe(false);
    expect(replay).toEqual({ replayed: true, rotated: false });
    expect(verification).toMatchObject({
      tenantCode: "JG",
      owners: 2,
      employees: 2,
      workbookChain: 1,
      financeReconciled: true,
      receiptReconciled: true,
    });
  });

  it("persists exactly two active INTERNAL Tenant Owners and the reconciled workbook finance", async () => {
    const [result] = await withPlatform(db!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          owners: number;
          employees: number;
          taxable: bigint;
          gst: bigint;
          total: bigint;
          receipt: bigint;
          deduction: bigint;
        }>
      >(`SELECT
        (SELECT count(DISTINCT membership.id)::int FROM app.tenant_memberships membership
         JOIN app.membership_role_assignments assignment ON assignment.tenant_id=membership.tenant_id AND assignment.membership_id=membership.id AND assignment.status='ACTIVE'
         JOIN app.roles role ON role.tenant_id=assignment.tenant_id AND role.id=assignment.role_id AND role.code='TENANT_OWNER'
         WHERE membership.tenant_id='${JURIGARI_TENANT_ID}'::uuid AND membership.status='ACTIVE' AND membership.portal_audience='INTERNAL') owners,
        (SELECT count(*)::int FROM app.employees WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND state='ACTIVE' AND linked_membership_id IS NOT NULL) employees,
        (SELECT taxable_minor FROM app.client_invoices WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND invoice_no='${JURIGARI_EXEMPLAR.invoiceNo}') taxable,
        (SELECT tax_minor FROM app.client_invoices WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND invoice_no='${JURIGARI_EXEMPLAR.invoiceNo}') gst,
        (SELECT total_minor FROM app.client_invoices WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND invoice_no='${JURIGARI_EXEMPLAR.invoiceNo}') total,
        (SELECT amount_minor FROM app.receipts WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND receipt_ref='${JURIGARI_EXEMPLAR.receiptRef}') receipt,
        (SELECT amount_minor FROM app.receipt_ledger_entries WHERE tenant_id='${JURIGARI_TENANT_ID}'::uuid AND receipt_id='30000000-0000-4000-8000-000000000921'::uuid AND entry_type='DEDUCTION') deduction`),
    );
    expect(result).toEqual({
      owners: 2,
      employees: 2,
      taxable: BigInt(JURIGARI_EXEMPLAR.invoiceTaxableMinor),
      gst: BigInt(JURIGARI_EXEMPLAR.invoiceGstMinor),
      total: BigInt(JURIGARI_EXEMPLAR.invoiceTotalMinor),
      receipt: BigInt(JURIGARI_EXEMPLAR.receiptAmountMinor),
      deduction: BigInt(JURIGARI_EXEMPLAR.deductionMinor),
    });
  });
});
