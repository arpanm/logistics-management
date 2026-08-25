import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configurationCommandSchema,
  laneCommandSchema,
} from "../../../packages/domain/src/canonical.js";
import { AppError } from "../src/app.service.js";
import { DataProvider } from "../src/modules/data/data.provider.js";

describe("canonical exact values and validation focused repairs", () => {
  it("keeps an exact minor-unit string and binds exact columns as bigint", () => {
    const exact = "900719925474099312345678";
    const lane = laneCommandSchema.parse({
      contractVersionId: "00000000-0000-4000-8000-000000000001",
      code: "LANE_01",
      originLocationId: "00000000-0000-4000-8000-000000000002",
      destinationLocationId: "00000000-0000-4000-8000-000000000003",
      truckType: "32FT",
      quantityMinMilli: 1,
      placementMinutes: 60,
      transitMinutes: 120,
      podMinutes: 180,
      rateMinor: exact,
      taxBasisPoints: 1800,
      effectiveFrom: "2026-08-25T00:00:00.000Z",
    });
    expect(lane.rateMinor).toBe(exact);

    const source = readFileSync(
      new URL("../src/modules/canonical/canonical.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("amount_minor,tax_basis_points");
    expect(source).toContain("$3::bigint,$4,$5::timestamptz");
    expect(source).toContain("$8::bigint,$9::bigint,$10::bigint,$11::uuid");
    expect(source).toContain(
      "$5::bigint,$6::bigint,$7::bigint,$8,$9::bigint,$10::bigint",
    );
  });

  it("rejects ambiguous alert threshold ordering", () => {
    const result = configurationCommandSchema.safeParse({
      namespace: "alerts",
      value: { yellowAt: 48, redAt: 24 },
      effectiveFrom: "2026-08-25T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    expect(
      configurationCommandSchema.parse({
        namespace: "alerts",
        value: { yellowAt: 24, redAt: 48 },
        effectiveFrom: "2026-08-25T00:00:00.000Z",
      }).value,
    ).toEqual({ yellowAt: 24, redAt: 48 });
  });

  it.each([
    ["duplicate", "Client Code,Client Code\nC1,C2\n", "DUPLICATE_HEADER"],
    [
      "case-folded duplicate",
      "Client Code,client code\nC1,C2\n",
      "DUPLICATE_HEADER",
    ],
    ["blank", "Client Code,   \nC1,C2\n", "EMPTY_HEADER"],
  ])(
    "rejects %s CSV headers before rows are materialized",
    async (_, csv, code) => {
      const provider = new DataProvider({} as never);
      await expect(
        provider.parseFile(
          "clients.csv",
          "text/csv",
          Buffer.from(csv).toString("base64"),
        ),
      ).rejects.toMatchObject<AppError>({ status: 400, code });
    },
  );

  it("uses the same header validator for CSV and XLSX parsing", () => {
    const source = readFileSync(
      new URL("../src/modules/data/data.provider.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/validateHeaders\(headers\)/g)).toHaveLength(2);
  });
});
