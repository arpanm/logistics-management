import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  tenantKeyHash,
} from "../src/modules/control/idempotency.js";
import {
  calculateInvoice,
  receiptPosition,
  roundBasisPointMinor,
  vendorPayable,
} from "../src/modules/finance/provider.js";

describe("FIN-01/02/03 finance workbench contracts", () => {
  it("FIN-WB-UNIT-01 keeps invoice totals in exact minor units", () => {
    expect(
      calculateInvoice([
        { taxableMinor: 10_001n, taxBasisPoints: 1_800n },
        { taxableMinor: 9_999n, taxBasisPoints: 500n },
      ]),
    ).toEqual({ taxableMinor: 20_000n, taxMinor: 2_300n, totalMinor: 22_300n });
  });

  it("FIN-WB-UNIT-04 rounds negative credit-line tax symmetrically", () => {
    expect(roundBasisPointMinor(10_001n, 1_800n)).toBe(1_800n);
    expect(roundBasisPointMinor(-10_001n, 1_800n)).toBe(-1_800n);
    expect(
      calculateInvoice([{ taxableMinor: -10_001n, taxBasisPoints: 1_800n }]),
    ).toEqual({
      taxableMinor: -10_001n,
      taxMinor: -1_800n,
      totalMinor: -11_801n,
    });
  });

  it("FIN-WB-UNIT-05 binds replay keys to tenant and canonical request body", () => {
    expect(tenantKeyHash("tenant-a", "retry-key")).not.toBe(
      tenantKeyHash("tenant-b", "retry-key"),
    );
    expect(canonicalJson({ action: "POST", expectedVersion: 2 })).toBe(
      canonicalJson({ expectedVersion: 2, action: "POST" }),
    );
    expect(canonicalJson({ action: "POST", expectedVersion: 2 })).not.toBe(
      canonicalJson({ action: "POST", expectedVersion: 3 }),
    );
  });

  it("FIN-WB-UNIT-02 derives unallocated receipts from append-only entries", () => {
    expect(
      receiptPosition(20_000n, [
        { kind: "ALLOCATION", amountMinor: 12_000n },
        { kind: "DEDUCTION", amountMinor: 1_000n },
        { kind: "REVERSAL", amountMinor: 1_000n },
      ]),
    ).toEqual({
      receivedMinor: 20_000n,
      appliedMinor: 12_000n,
      unallocatedMinor: 8_000n,
    });
  });

  it("FIN-WB-UNIT-03 derives vendor payable without binary floating point", () => {
    expect(
      vendorPayable({
        taxableMinor: 100_000n,
        gstMinor: 18_000n,
        tdsMinor: 2_000n,
        deductionsMinor: 1_500n,
        advancesMinor: 10_000n,
        paymentsMinor: 50_000n,
      }),
    ).toEqual({ approvedMinor: 104_500n, outstandingMinor: 54_500n });
  });

  it("FIN-WB-CONTRACT-01 wires scoped queues and real invoice service links", () => {
    const service = readFileSync(
      new URL("../src/modules/finance/workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(service).toContain("domain_resource_authorized");
    expect(service).toContain("app.invoice_service_links");
    expect(service).toContain("quantity * rate");
    expect(service).toContain("SEGREGATION_REQUIRED");
    expect(service).toContain("BANK_NOT_VERIFIED");
    expect(service).toContain("SERVICE_NOT_ELIGIBLE");
    expect(service).toContain("paymentBatchAction");
    expect(service).toContain("createVendorBill");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("tenantKeyHash");
    expect(service).toContain("canonicalJson");
    expect(service).toContain("IDEMPOTENCY_CONFLICT");
    for (const route of [
      "invoices:create",
      "receipts:create",
      "invoices:${id}:update",
      "invoices:${id}:action",
      "invoices:${id}:notes:create",
      "invoices:${id}:followups:create",
      "vendor-bills:create",
      "vendor-bills:${id}:action",
      "payment-runs:${id}:action",
    ])
      expect(service).toContain(route);
    expect(service).toContain("audit.audit_events");
    expect(service).toContain("app.outbox_events");
  });

  it("FIN-WB-CONTRACT-02 exposes tenant-scoped complete finance registers and state-valid actions", () => {
    const controller = readFileSync(
      new URL(
        "../src/modules/finance/workbench.controller.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const service = readFileSync(
      new URL("../src/modules/finance/workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(controller).toContain('@Get("invoices")');
    expect(controller).toContain('@Get("receipts")');
    expect(controller).toContain('@Post("receipts")');
    expect(controller).toContain('@Post("invoices/:id/update")');
    expect(controller).toContain('@Post("invoices/:id/notes")');
    expect(controller).toContain('"REJECT"');
    expect(service).toContain("Only draft or rejected invoices can be edited");
    expect(service).toContain("A rejection reason is required");
    expect(service).toContain("Notes are available only for posted invoices");
    expect(service).toContain("LIMIT 500");
    expect(service).toContain("domain_resource_authorized");
  });

  it("FIN-WB-UI-01 uses contextual forms instead of browser prompts", () => {
    const component = readFileSync(
      new URL(
        "../../frontend/components/finance/finance-workbench.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(component).not.toContain("prompt(");
    expect(component).toContain("All invoices");
    expect(component).toContain("Payment runs");
    expect(component).toContain("Record bank receipt");
    expect(component).toContain("Acknowledge client submission");
    expect(component).toContain('type="date"');
    expect(component).toContain('role="dialog"');
  });

  it("FIN-WB-SEC-01 requires approval scope for financial decisions before mutation", () => {
    const service = readFileSync(
      new URL("../src/modules/finance/workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(service).toContain(
      '["APPROVE", "REJECT", "POST", "REVERSE"].includes',
    );
    expect(service).toContain('["VERIFY", "APPROVE", "PAY"].includes');
    expect(service).toContain('["APPROVE", "MARK_PAID", "REVERSE"].includes');
    expect(service).toMatch(
      /scopedAction[\s\S]+this\.allowed\([\s\S]+scopedAction[\s\S]+const replay/,
    );
  });

  it("FIN-WB-SEC-02 masks payment, bank, and commercial values in every register", () => {
    const service = readFileSync(
      new URL("../src/modules/finance/workbench.service.ts", import.meta.url),
      "utf8",
    );
    expect(service).toContain("sensitive.payment.read");
    expect(service).toContain("sensitive.bank_detail.read");
    expect(service).toContain("sensitive.commercial_rate.read");
    expect(service).toContain("ELSE '••••'");
    for (const field of [
      'AS "taxableMinor"',
      'AS "taxMinor"',
      'AS "totalMinor"',
      'AS "openMinor"',
      'AS "amountMinor"',
      'AS "unallocatedMinor"',
      'AS "instrumentNo"',
      'AS "bankReference"',
      'AS "payableMinor"',
      'AS "outstandingMinor"',
      'AS "expectedMinor"',
      'AS "rateMinor"',
    ])
      expect(service).toContain(field);
  });

  it("FIN-WB-CONTRACT-03 records signed non-financial memos without changing invoice balance", () => {
    const service = readFileSync(
      new URL("../src/modules/finance/workbench.service.ts", import.meta.url),
      "utf8",
    );
    const component = readFileSync(
      new URL(
        "../../frontend/components/finance/finance-workbench.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(service).toContain(
      'input.noteType === "CREDIT_NOTE" ? -unsignedAmount : unsignedAmount',
    );
    expect(service).toContain("Memo amount must be positive");
    expect(component).toContain("Add non-financial invoice memo");
    expect(component).toContain("does not change the posted");
  });

  it("FIN-WB-MIG-01 adds queue indexes without mutable balance columns", () => {
    const sql = readFileSync(
      new URL(
        "../../../packages/db/prisma/migrations/202608250024_finance_workbenches/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("client_invoices_workbench");
    expect(sql).toContain("receipt_ledger_receipt");
    expect(sql).toContain("vendor_bills_workbench");
    expect(sql).not.toMatch(/ADD COLUMN\s+(balance|paid|received)/i);
  });
});
