import { describe, expect, it } from "vitest";
import {
  assertDemoProfileAdoptionState,
  assertDemoProfileIdentityCollision,
  assertDemoProfileTenantCollision,
} from "./demo-seed.js";
import {
  JURIGARI_EXEMPLAR,
  JURIGARI_IDS,
  JURIGARI_SHOWCASE_MANIFEST,
  JURIGARI_TENANT_ID,
  jurigariBootstrapProfile,
  jurigariStatements,
} from "./jurigari-demo-profile.js";

const config = {
  appEnv: "test",
  encryptionKey: Buffer.alloc(32, 12),
  password: `${"A".repeat(16)}!1`,
  platformAdminEmail: "platform@test.local",
  rotatePassword: false,
  tenantOwnerEmail: "piyana10@gmail.com",
  operationsEmail: "siddhartha09@gmail.com",
  financeEmail: "siddhartha09@gmail.com",
  vendorEmail: "siddhartha09@gmail.com",
  driverEmail: "siddhartha09@gmail.com",
  clientEmail: "piyana10@gmail.com",
};

describe("Jurigari bootstrap profile", () => {
  it("uses a collision-free namespace and exactly two active INTERNAL owners", () => {
    const sql = jurigariStatements().join("\n");
    const profile = jurigariBootstrapProfile(config);
    expect(sql).not.toContain("10000000-0000-4000-8000-");
    expect(sql).not.toContain("11000000-0000-4000-8000-");
    expect(profile.tenantId).toBe(JURIGARI_TENANT_ID);
    expect(profile.users).toEqual([
      [JURIGARI_IDS.owner, "piyana10@gmail.com", "Piyana Bandyopadhyay", false],
      [JURIGARI_IDS.operations, "siddhartha09@gmail.com", "Siddhartha", false],
    ]);
    expect(sql.match(/'TENANT_OWNER','INTERNAL','ACTIVE'/g)).toHaveLength(2);
    expect(JURIGARI_SHOWCASE_MANIFEST.internalEmployees).toBe(2);
  });

  it("materializes the workbook operational chain and source details", () => {
    const sql = jurigariStatements().join("\n");
    for (const value of [
      "Tata Consumer Products Ltd",
      "TCPL-KUN",
      "TCPL Kunigal",
      "Sahil Roadlines",
      JURIGARI_EXEMPLAR.vendorCode,
      JURIGARI_EXEMPLAR.indentNo,
      JURIGARI_EXEMPLAR.vehicleRegistration,
      JURIGARI_EXEMPLAR.lrNo,
    ]) {
      expect(sql).toContain(value);
    }
    expect(sql).toContain(",45,'PORTAL','ACTIVE')");
    expect(sql).toContain("credit_days=excluded.credit_days");
  });

  it("keeps the exact invoice, receipt, deduction, and balance reconciliation", () => {
    expect(
      JURIGARI_EXEMPLAR.invoiceTaxableMinor + JURIGARI_EXEMPLAR.invoiceGstMinor,
    ).toBe(JURIGARI_EXEMPLAR.invoiceTotalMinor);
    expect(
      JURIGARI_EXEMPLAR.invoiceTotalMinor -
        JURIGARI_EXEMPLAR.receiptAmountMinor,
    ).toBe(JURIGARI_EXEMPLAR.balanceMinor);
    expect(
      JURIGARI_EXEMPLAR.receiptAmountMinor - JURIGARI_EXEMPLAR.deductionMinor,
    ).toBe(14_160_000);
    const sql = jurigariStatements().join("\n");
    for (const value of [
      JURIGARI_EXEMPLAR.invoiceNo,
      JURIGARI_EXEMPLAR.receiptRef,
      String(JURIGARI_EXEMPLAR.invoiceTaxableMinor),
      String(JURIGARI_EXEMPLAR.invoiceGstMinor),
      String(JURIGARI_EXEMPLAR.invoiceTotalMinor),
      String(JURIGARI_EXEMPLAR.receiptAmountMinor),
      String(JURIGARI_EXEMPLAR.deductionMinor),
      String(JURIGARI_EXEMPLAR.balanceMinor),
    ]) {
      expect(sql).toContain(value);
    }
  });

  it("keeps normal seeding separate and has a stable replay marker", () => {
    const first = jurigariBootstrapProfile(config);
    const second = jurigariBootstrapProfile(config);
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.dataset).toBe("jurigari-production-demo");
    expect(first.passwordVariable).toBe("JURIGARI_USER_PASSWORD");
  });

  it("rejects reserved tenant-code and identity collisions before materialization", () => {
    const profile = jurigariBootstrapProfile(config);
    expect(() =>
      assertDemoProfileTenantCollision(profile, {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        name: "Other Tenant",
        legal_name: "Other Tenant Private Limited",
      }),
    ).toThrow("Tenant code JG already belongs to another tenant");
    expect(() =>
      assertDemoProfileIdentityCollision(
        profile,
        "piyana10@gmail.com",
        JURIGARI_IDS.owner,
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ),
    ).toThrow("Reserved JG identity");
  });

  it("adopts only the explicitly confirmed matching Jurigari tenant", () => {
    const tenantId = "415f88a2-675a-476c-8031-87c3ff1ae23b";
    const profile = jurigariBootstrapProfile({
      ...config,
      adoptTenantId: tenantId,
    });
    expect(profile.tenantId).toBe(tenantId);
    expect(profile.statements.join("\n")).toContain(tenantId);
    expect(profile.statements.join("\n")).not.toContain(JURIGARI_TENANT_ID);
    expect(() =>
      assertDemoProfileTenantCollision(profile, {
        id: tenantId,
        name: "Juri Gari",
        legal_name: "Jurigari Pvt Limited",
      }),
    ).not.toThrow();
    expect(() =>
      assertDemoProfileTenantCollision(profile, {
        id: tenantId,
        name: "Unrelated Logistics",
        legal_name: "Unrelated Logistics Private Limited",
      }),
    ).toThrow("already belongs to another tenant");
    expect(() => assertDemoProfileAdoptionState(profile, 0)).not.toThrow();
    expect(() => assertDemoProfileAdoptionState(profile, 1)).toThrow(
      "already provisioned",
    );
  });
});
