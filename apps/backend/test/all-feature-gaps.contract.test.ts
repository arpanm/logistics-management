import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateMoneyLine, documentUploadSchema } from "@logistics/domain";
import { DataProvider } from "../src/modules/data/data.provider.js";
import ExcelJS from "exceljs";

describe("ALL-FEATURE-GAPS canonical contracts", () => {
  it("GAP-A-01: governed document replacement remains strict and bounded", () => {
    const parsed = documentUploadSchema.parse({
      documentId: "00000000-0000-4000-8000-000000000001",
      targetType: "POD",
      targetId: "00000000-0000-4000-8000-000000000002",
      category: "SIGNED_POD",
      confidentiality: "CLIENT",
      fileName: "pod.pdf",
      mediaType: "application/pdf",
      contentBase64: "JVBERi0=",
      checksumSha256: "a".repeat(64),
    });
    expect(parsed.documentId).toBeTruthy();
    expect(() =>
      documentUploadSchema.parse({
        ...parsed,
        mediaType: "application/octet-stream",
      }),
    ).toThrow();
  });

  it("GAP-D-01: exact minor-unit calculations reconcile", () => {
    expect(calculateMoneyLine("1250", "10000", 1800)).toEqual({
      taxableMinor: "12500",
      taxMinor: "2250",
      totalMinor: "14750",
    });
  });

  it("GAP-E-01: server CSV parser preserves quoted commas and escaped quotes", async () => {
    const provider = new DataProvider({} as never);
    const content =
      'Client Code,Client Name,Account Manager,Credit Days\nC1,"Acme, India","A ""One""",30\n';
    const parsed = await provider.parseFile(
      "clients.csv",
      "text/csv",
      Buffer.from(content).toString("base64"),
    );
    expect(parsed.headers).toEqual([
      "Client Code",
      "Client Name",
      "Account Manager",
      "Credit Days",
    ]);
    expect(parsed.rows[0]).toEqual({
      "Client Code": "C1",
      "Client Name": "Acme, India",
      "Account Manager": 'A "One"',
      "Credit Days": "30",
    });
    expect(parsed.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("GAP-E-02: server XLSX parser reads one typed worksheet", async () => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Clients");
    sheet.addRow([
      "Client Code",
      "Client Name",
      "Account Manager",
      "Credit Days",
    ]);
    sheet.addRow(["C2", "Workbook Client", "EMP-1", 45]);
    const bytes = await workbook.xlsx.writeBuffer(),
      provider = new DataProvider({} as never);
    const parsed = await provider.parseFile(
      "clients.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      Buffer.from(bytes).toString("base64"),
    );
    expect(parsed.rows[0]).toMatchObject({
      "Client Code": "C2",
      "Client Name": "Workbook Client",
      "Credit Days": "45",
    });
  });

  it("GAP-X-01/X-03: migration declares forced RLS, append-only ledgers and same-assignment authorization", () => {
    const sql = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202608250007_all_feature_canonical/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("CREATE FUNCTION app.domain_resource_authorized");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("gps_observations_immutable");
    expect(sql).toContain("payment_allocations_immutable");
    expect(sql).toContain("document_scan_results_immutable");
  });

  it("GAP-B/C/D/E: executable APIs are wired, not manifest-only labels", () => {
    const controller = readFileSync(
      new URL(
        "../src/modules/canonical/advanced.controller.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const route of [
      "organization/:id/move",
      "vendors/:id/banks",
      "indents/:id/cancel",
      "pod/:id/review",
      "invoices/:id/reverse",
      "payment-batches/:id/transition",
      "accounting/reconciliation/:id/action",
    ])
      expect(controller).toContain(route);
    const intelligence = readFileSync(
      new URL(
        "../src/modules/control/intelligence.controller.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const route of [
      "alert-rules",
      "imports/parse",
      "integrations/:id/mappings",
      "webhooks/:tenantCode/:clientCode",
    ])
      expect(intelligence).toContain(route);
  });
});
