import { describe, expect, it } from "vitest";
import {
  DEMO_DATASET_VERSION,
  DEMO_SHOWCASE_MANIFEST,
  validateDemoShowcaseCounts,
} from "./demo-seed.js";

describe("UI01-DEMO-U-009 showcase manifest", () => {
  it("publishes the deterministic client-presentation minimums", () => {
    expect(DEMO_DATASET_VERSION).toBe("2026.09.2");
    expect(DEMO_SHOWCASE_MANIFEST).toEqual({
      tenant: 1,
      regions: 2,
      branches: 3,
      internalEmployees: 6,
      clients: 4,
      clientLocations: 10,
      vendors: 5,
      activeVendors: 4,
      vehicles: 12,
      drivers: 10,
      indents: 36,
      allocations: 24,
      trips: 18,
      podTasks: 14,
      clientInvoices: 18,
      receipts: 8,
      vendorBills: 14,
      paymentBatches: 5,
      alerts: 12,
      lanes: 6,
      currentCommercialExamples: 2,
      expiredCommercialExamples: 1,
      upcomingCommercialExamples: 2,
      placementLensRows: 10,
      podLensRows: 10,
      collectionLensRows: 10,
      tripLensRows: 10,
      vendorPayableLensRows: 10,
      placementPortfolios: 3,
      podPortfolios: 3,
      collectionPortfolios: 3,
      tripPortfolios: 3,
      vendorPayablePortfolios: 3,
      notificationSuppression: 1,
    });
  });

  it("rejects incomplete or non-integer postflight counts", () => {
    const { tenant, ...counts } = DEMO_SHOWCASE_MANIFEST;
    expect(tenant).toBe("DEMO");
    expect(() => validateDemoShowcaseCounts(counts)).not.toThrow();
    expect(() =>
      validateDemoShowcaseCounts({ ...counts, trips: counts.trips - 1 }),
    ).toThrow("reconciliation failed for trips");
    expect(() =>
      validateDemoShowcaseCounts({ ...counts, alerts: Number.NaN }),
    ).toThrow("reconciliation failed for alerts");
  });
});
