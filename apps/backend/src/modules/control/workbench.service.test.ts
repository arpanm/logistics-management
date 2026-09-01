import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionableKpiMeasure,
  controlStableOrder,
  kpiActionsByLens,
  parseControlQuery,
} from "./workbench.service.js";

const asOf = new Date("2026-08-31T06:30:00.000Z");

describe("UI01-CTL-CONTRACT-001 control query contract", () => {
  it("isolates the aggregate summary from portfolio and location breakdowns", () => {
    const source = readFileSync(
      new URL("./workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("summary AS (");
    expect(source).toContain("SELECT summary.*,${portfolios} portfolios");
    expect(source).toContain("FROM summary");
  });

  it("preaggregates placement quantities separately from assignment assets", () => {
    const source = readFileSync(
      new URL("./workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("LEFT JOIN LATERAL (");
    expect(source).toContain("supply.allotted,supply.placed");
    expect(source).toContain("assets.vehicles,assets.drivers");
    expect(source).not.toContain(
      "sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int AS placed",
    );
  });

  it("allow-lists lens-specific KPI predicates for dashboard and export", () => {
    expect(parseControlQuery("collection", { kpi: "part-paid" }).kpi).toBe(
      "part-paid",
    );
    expect(() => parseControlQuery("placement", { kpi: "part-paid" })).toThrow(
      "not available for this lens",
    );
    expect(parseControlQuery("trip", { kpi: "gps-silent" })).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      direction: "desc",
    });
  });

  it("enforces bounded pagination and a stable id tie-breaker", () => {
    expect(() => parseControlQuery("trip", { page: 0 })).toThrow();
    expect(() => parseControlQuery("trip", { pageSize: 101 })).toThrow();
    const query = parseControlQuery("collection", {
      page: 2,
      pageSize: 10,
      sort: "balance",
      direction: "asc",
    });
    expect(controlStableOrder("collection", query)).toBe(
      'f."balanceMinor" ASC NULLS LAST,f.id ASC',
    );
    expect(() =>
      controlStableOrder("placement", { ...query, sort: "balance" }),
    ).toThrow("sort field is not available");
  });

  it("reconciles every actionable KPI to its exact shared row predicate", () => {
    const fixtures = {
      placement: [{ colour: "GREEN" }, { colour: "YELLOW" }, { colour: "RED" }],
      pod: [
        { completedAt: asOf.toISOString(), priorPeriod: false },
        { completedAt: null, priorPeriod: false },
        { completedAt: null, priorPeriod: true },
      ],
      collection: [
        { balanceMinor: "100", receivedMinor: "0", ageDays: 10 },
        { balanceMinor: "50", receivedMinor: "50", ageDays: 20 },
        { balanceMinor: "70", receivedMinor: "0", ageDays: 60, hold: "Review" },
      ],
      trip: [
        {
          state: "IN_TRANSIT",
          colour: "GREEN",
          lastGpsAt: asOf.toISOString(),
          updatedAt: asOf.toISOString(),
        },
        {
          state: "AT_ORIGIN",
          colour: "YELLOW",
          lastGpsAt: null,
          updatedAt: "2026-08-31T03:00:00.000Z",
        },
        {
          state: "AT_DESTINATION",
          colour: "RED",
          lastGpsAt: "2026-08-31T05:00:00.000Z",
          updatedAt: "2026-08-31T03:00:00.000Z",
        },
        {
          state: "DELIVERED",
          colour: "RED",
          lastGpsAt: null,
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
      "vendor-payable": [
        { state: "DRAFT", colour: "GREEN" },
        { state: "PENDING_FINANCE_APPROVAL", colour: "YELLOW" },
        { state: "VALIDATION_EXCEPTION", colour: "RED" },
        { state: "DISPUTED", colour: "RED" },
        { state: "PAID", colour: "GREEN" },
      ],
    } as const;
    const expected = {
      placement: { liveIndents: 3, green: 1, yellow: 1, red: 1 },
      pod: {
        deliveryRecords: 3,
        received: 1,
        pendingCurrent: 1,
        pendingPrior: 1,
      },
      collection: {
        submitted: 3,
        openInvoices: 3,
        partPaid: 1,
        onHold: 1,
        over45Count: 1,
        over45Minor: 70n,
      },
      trip: {
        active: 3,
        atRisk: 2,
        delayed: 1,
        gpsSilent: 2,
        loadingDetention: 1,
        unloadingDetention: 1,
        deliveryExceptions: 2,
      },
      "vendor-payable": {
        unbilled: 1,
        approvalPending: 1,
        due: 1,
        overdue: 2,
        paymentBlocked: 2,
        disputed: 1,
        paid: 1,
      },
    } as const;
    for (const lens of Object.keys(kpiActionsByLens) as Array<
      keyof typeof kpiActionsByLens
    >) {
      for (const key of Object.keys(kpiActionsByLens[lens]))
        expect(
          actionableKpiMeasure(
            lens,
            key,
            fixtures[lens] as unknown as Array<Record<string, unknown>>,
            asOf,
          ),
        ).toBe(
          (expected[lens] as unknown as Record<string, number | bigint>)[key],
        );
    }
    expect(kpiActionsByLens.collection.submitted).toBeUndefined();
    expect(kpiActionsByLens.trip.atRisk).toBeUndefined();
    expect(kpiActionsByLens.trip.deliveryExceptions).toBeUndefined();
    expect(kpiActionsByLens["vendor-payable"].due).toBeUndefined();
    expect(kpiActionsByLens["vendor-payable"].overdue).toBeUndefined();
  });
});
