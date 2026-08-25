"use client";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import styles from "./finance-workbench.module.css";

type Row = Record<string, unknown> & {
  id: string;
  state?: string;
  version: number;
};
type Dashboard = {
  asOf: string;
  metrics: Record<string, number>;
  queues: {
    invoices: Row[];
    collections: Row[];
    unallocatedReceipts: Row[];
    vendorBills: Row[];
    paymentRuns: Row[];
    vendorServices: Row[];
  };
};
type Service = {
  tripId: string;
  podTaskId: string;
  tripNo: string;
  lrNo: string;
  clientId: string;
  clientLocationId: string;
  laneId: string;
  client: string;
  podState: string;
};
type Charge = {
  laneId: string;
  code: string;
  basis: string;
  rateMinor: string;
  taxBasisPoints: number;
};
type Bank = {
  bankVersionId: string;
  vendorId: string;
  vendor: string;
  accountHolder: string;
  ifsc: string;
};
type Refs = { services: Service[]; charges: Charge[]; banks: Bank[] };
type Section = "overview" | "invoices" | "collections" | "vendors";
type Line = {
  tripId: string;
  podTaskId: string;
  chargeCode: string;
  quantityMilli: string;
  rateMinor: string;
  taxBasisPoints: number;
};
const blankLine: Line = {
  tripId: "",
  podTaskId: "",
  chargeCode: "",
  quantityMilli: "1000",
  rateMinor: "0",
  taxBasisPoints: 0,
};
const money = (minor: unknown) => {
  try {
    const value = BigInt(String(minor ?? "0"));
    const zero = BigInt(0);
    const hundred = BigInt(100);
    const absolute = value < zero ? -value : value;
    return `${value < zero ? "-" : ""}₹${(absolute / hundred).toLocaleString("en-IN")}.${(absolute % hundred).toString().padStart(2, "0")}`;
  } catch {
    return "—";
  }
};

export function FinanceWorkbench({
  section = "overview",
}: {
  section?: Section;
}) {
  const [data, setData] = useState<Dashboard | null>(null),
    [refs, setRefs] = useState<Refs>({ services: [], charges: [], banks: [] }),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [allocation, setAllocation] = useState({
    receiptId: "",
    invoiceId: "",
    amountMinor: "",
  });
  const [invoice, setInvoice] = useState({
    invoiceNo: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    currency: "INR",
    creditDays: 30,
    lines: [{ ...blankLine }],
  });
  const load = useCallback(async () => {
    setError("");
    try {
      const [next, nextRefs] = await Promise.all([
        api<Dashboard>("/tenant/finance/workbench"),
        api<Refs>("/tenant/finance/references"),
      ]);
      setData(next);
      setRefs(nextRefs);
    } catch (value) {
      setError(
        (value as ApiError).message ?? "Finance workbench could not be loaded",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const firstService = useMemo(
    () =>
      refs.services.find((s) =>
        invoice.lines.some((l) => l.tripId === s.tripId),
      ),
    [refs.services, invoice.lines],
  );
  const mutate = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice("Finance record updated.");
      await load();
    } catch (value) {
      setError((value as ApiError).message ?? "Action could not be completed");
    } finally {
      setBusy(false);
    }
  };
  const lineChange = (index: number, patch: Partial<Line>) =>
    setInvoice((current) => ({
      ...current,
      lines: current.lines.map((line, i) =>
        i === index ? { ...line, ...patch } : line,
      ),
    }));
  const chooseService = (index: number, tripId: string) => {
    const selected = refs.services.find((s) => s.tripId === tripId);
    lineChange(index, { tripId, podTaskId: selected?.podTaskId ?? "" });
  };
  const chooseCharge = (index: number, code: string) => {
    const service = refs.services.find(
      (candidate) => candidate.tripId === invoice.lines[index]?.tripId,
    );
    const selected = refs.charges.find(
      (candidate) =>
        candidate.code === code && candidate.laneId === service?.laneId,
    );
    lineChange(index, {
      chargeCode: code,
      rateMinor: selected?.rateMinor ?? "0",
      taxBasisPoints: selected?.taxBasisPoints ?? 0,
    });
  };
  const submitInvoice = (event: FormEvent) => {
    event.preventDefault();
    if (!firstService) {
      setError("Select at least one eligible trip / POD.");
      return;
    }
    void mutate("/tenant/finance/invoices", {
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      clientId: firstService.clientId,
      clientLocationId: firstService.clientLocationId,
      currency: invoice.currency,
      creditDays: Number(invoice.creditDays),
      lines: invoice.lines,
    });
  };
  const invoiceAction = (row: Row, action: string) => {
    if (action === "REVERSE") {
      const reversalInvoiceNo = prompt("Reversal invoice number");
      const reason = prompt("Reversal reason");
      if (!reversalInvoiceNo || !reason) return;
      void mutate(`/tenant/finance/invoices/${row.id}/actions`, {
        action: "REVERSE",
        expectedVersion: row.version,
        reversalInvoiceNo,
        reason,
      });
      return;
    }
    void mutate(`/tenant/finance/invoices/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
      ...(action === "ACKNOWLEDGE"
        ? { acknowledgedAt: new Date().toISOString() }
        : {}),
    });
  };
  const vendorAction = (row: Row, action: string) => {
    if (action === "PAY") {
      const bank = refs.banks.find((b) => b.vendorId === String(row.vendorId));
      const amount = prompt(
        "Payment amount in minor units",
        String(row.outstandingMinor ?? ""),
      );
      if (!bank || !amount) {
        setError(
          "A current verified vendor bank and payment amount are required.",
        );
        return;
      }
      void mutate(`/tenant/finance/vendor-bills/${row.id}/actions`, {
        action,
        expectedVersion: row.version,
        bankVersionId: bank.bankVersionId,
        amountMinor: amount,
        batchNo: `PAY-${Date.now()}`,
      });
      return;
    }
    void mutate(`/tenant/finance/vendor-bills/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
      reason:
        action === "DISPUTE"
          ? "Raised from finance exception queue"
          : undefined,
    });
  };
  const createVendorBill = (row: Row) => {
    const vendorInvoiceNo = prompt("Vendor invoice / reference");
    const claimedMinor = prompt(
      "Claimed amount in minor units",
      String(row.expectedMinor ?? "0"),
    );
    const gstMinor = prompt("GST amount in minor units", "0");
    if (!vendorInvoiceNo || claimedMinor === null || gstMinor === null) return;
    void mutate("/tenant/finance/vendor-bills", {
      vendorInvoiceNo,
      invoiceDate: new Date().toISOString().slice(0, 10),
      vendorId: row.vendorId,
      gstMinor,
      lines: [{ tripId: row.tripId, claimedMinor }],
    });
  };
  const paymentAction = (row: Row, action: string) => {
    const utr =
      action === "MARK_PAID"
        ? (prompt("Bank UTR / transaction reference") ?? "")
        : undefined;
    if (action === "MARK_PAID" && !utr) return;
    void mutate(`/tenant/finance/payment-runs/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
      utr,
      reason: ["FAIL", "REVERSE"].includes(action)
        ? "Recorded from payment-run queue"
        : undefined,
    });
  };
  const nav = (
    <nav className={styles.tabs} aria-label="Finance workbench">
      <Link className={styles.tab} href="/app/finance">
        Dashboard
      </Link>
      <Link className={styles.tab} href="/app/finance/invoices">
        Billing
      </Link>
      <Link className={styles.tab} href="/app/finance/receipts">
        Collections
      </Link>
      <Link className={styles.tab} href="/app/finance/vendor-bills">
        Vendor payables
      </Link>
    </nav>
  );
  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.hero}>
          <div>
            <p className="eyebrow">Finance</p>
            <h1>Billing, collections and payables</h1>
            <p className="muted">
              Action queues reconcile to canonical minor-unit ledgers.
            </p>
          </div>
          {nav}
        </header>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        )}
        {section === "overview" && (
          <>
            <section className={styles.metrics}>
              {Object.entries(data?.metrics ?? {}).map(([key, value]) => (
                <article className={styles.metric} key={key}>
                  <strong>{value}</strong>
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                </article>
              ))}
            </section>
            <div className={styles.grid}>
              <Queue
                title="Invoice work"
                rows={data?.queues.invoices ?? []}
                columns={["invoiceNo", "client", "state", "totalMinor"]}
              />
              <Queue
                title="Collection priority"
                rows={data?.queues.collections ?? []}
                columns={["invoiceNo", "client", "priority", "openMinor"]}
              />
              <Queue
                title="Vendor payable exceptions"
                rows={data?.queues.vendorBills ?? []}
                columns={[
                  "vendorInvoiceNo",
                  "vendor",
                  "state",
                  "outstandingMinor",
                ]}
              />
              <Queue
                title="Unbilled vendor services"
                rows={data?.queues.vendorServices ?? []}
                columns={["tripNo", "lrNo", "vendor", "expectedMinor"]}
              />
              <Queue
                title="Payment runs"
                rows={data?.queues.paymentRuns ?? []}
                columns={["batchNo", "state", "totalMinor", "allocations"]}
              />
            </div>
          </>
        )}
        {section === "invoices" && (
          <>
            <section className={styles.panel}>
              <h2>Create invoice from eligible services</h2>
              <p className="muted">
                Select actual delivered trip/POD records and published charge
                codes. Calculated line JSON is generated by the application.
              </p>
              <form className={styles.form} onSubmit={submitInvoice}>
                <div className={styles.grid}>
                  <label>
                    Invoice number
                    <input
                      required
                      value={invoice.invoiceNo}
                      onChange={(e) =>
                        setInvoice({ ...invoice, invoiceNo: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Invoice date
                    <input
                      required
                      type="date"
                      value={invoice.invoiceDate}
                      onChange={(e) =>
                        setInvoice({ ...invoice, invoiceDate: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Currency
                    <select
                      value={invoice.currency}
                      onChange={(e) =>
                        setInvoice({ ...invoice, currency: e.target.value })
                      }
                    >
                      <option>INR</option>
                      <option>USD</option>
                      <option>EUR</option>
                    </select>
                  </label>
                  <label>
                    Credit days
                    <input
                      required
                      type="number"
                      min="0"
                      max="365"
                      value={invoice.creditDays}
                      onChange={(e) =>
                        setInvoice({
                          ...invoice,
                          creditDays: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                {invoice.lines.map((line, index) => (
                  <div className={styles.line} key={index}>
                    <label>
                      Trip / LR / POD
                      <select
                        required
                        value={line.tripId}
                        onChange={(e) => chooseService(index, e.target.value)}
                      >
                        <option value="">Select eligible service…</option>
                        {refs.services.map((s) => (
                          <option key={s.tripId} value={s.tripId}>
                            {s.tripNo} · {s.lrNo} · {s.client} · POD{" "}
                            {s.podState}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Charge code
                      <select
                        required
                        value={line.chargeCode}
                        onChange={(e) => chooseCharge(index, e.target.value)}
                      >
                        <option value="">Select…</option>
                        {refs.charges
                          .filter((c) => {
                            const service = refs.services.find(
                              (candidate) => candidate.tripId === line.tripId,
                            );
                            return c.laneId === service?.laneId;
                          })
                          .map((c) => (
                            <option key={`${c.laneId}:${c.code}`}>
                              {c.code}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Quantity (milli)
                      <input
                        required
                        inputMode="numeric"
                        pattern="[0-9]+"
                        value={line.quantityMilli}
                        onChange={(e) =>
                          lineChange(index, { quantityMilli: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Rate (minor)
                      <input
                        required
                        inputMode="numeric"
                        pattern="-?[0-9]+"
                        value={line.rateMinor}
                        onChange={(e) =>
                          lineChange(index, { rateMinor: e.target.value })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={invoice.lines.length === 1}
                      onClick={() =>
                        setInvoice({
                          ...invoice,
                          lines: invoice.lines.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() =>
                      setInvoice({
                        ...invoice,
                        lines: [...invoice.lines, { ...blankLine }],
                      })
                    }
                  >
                    Add service line
                  </button>
                  <button disabled={busy}>Create draft invoice</button>
                </div>
              </form>
            </section>
            <InvoiceQueue
              rows={data?.queues.invoices ?? []}
              busy={busy}
              action={invoiceAction}
            />
          </>
        )}
        {section === "collections" && (
          <>
            <CollectionQueue
              rows={data?.queues.collections ?? []}
              busy={busy}
              mutate={mutate}
            />
            <section className={styles.panel}>
              <h2>Unallocated receipts</h2>
              <Table
                rows={data?.queues.unallocatedReceipts ?? []}
                columns={[
                  "receiptRef",
                  "client",
                  "paymentDate",
                  "amountMinor",
                  "unallocatedMinor",
                  "state",
                ]}
              />
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    `/domain/receipts/${allocation.receiptId}/allocations`,
                    {
                      invoiceId: allocation.invoiceId,
                      entryType: "ALLOCATION",
                      amountMinor: allocation.amountMinor,
                    },
                  );
                }}
              >
                <div className={styles.grid}>
                  <label>
                    Receipt
                    <select
                      required
                      value={allocation.receiptId}
                      onChange={(event) =>
                        setAllocation({
                          ...allocation,
                          receiptId: event.target.value,
                        })
                      }
                    >
                      <option value="">Search and select…</option>
                      {(data?.queues.unallocatedReceipts ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {String(row.receiptRef)} · {String(row.client)} ·{" "}
                          {money(row.unallocatedMinor)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Invoice
                    <select
                      required
                      value={allocation.invoiceId}
                      onChange={(event) =>
                        setAllocation({
                          ...allocation,
                          invoiceId: event.target.value,
                        })
                      }
                    >
                      <option value="">Search and select…</option>
                      {(data?.queues.collections ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {String(row.invoiceNo)} · {String(row.client)} ·{" "}
                          {money(row.openMinor)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Allocation amount (minor units)
                    <input
                      required
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      value={allocation.amountMinor}
                      onChange={(event) =>
                        setAllocation({
                          ...allocation,
                          amountMinor: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <button disabled={busy}>Allocate receipt</button>
              </form>
            </section>
          </>
        )}
        {section === "vendors" && (
          <>
            <section className={styles.panel}>
              <h2>Unbilled vendor services</h2>
              <Table
                rows={data?.queues.vendorServices ?? []}
                columns={["tripNo", "lrNo", "vendor", "expectedMinor"]}
                actions={(row) => (
                  <button disabled={busy} onClick={() => createVendorBill(row)}>
                    Create vendor bill
                  </button>
                )}
              />
            </section>
            <VendorQueue
              rows={data?.queues.vendorBills ?? []}
              busy={busy}
              action={vendorAction}
            />
            <PaymentRuns
              rows={data?.queues.paymentRuns ?? []}
              busy={busy}
              action={paymentAction}
            />
          </>
        )}
      </main>
    </Shell>
  );
}

function Queue({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Row[];
  columns: string[];
}) {
  return (
    <section className={styles.panel}>
      <h2>{title}</h2>
      <Table rows={rows.slice(0, 8)} columns={columns} />
    </section>
  );
}
function Table({
  rows,
  columns,
  actions,
}: {
  rows: Row[];
  columns: string[];
  actions?: (row: Row) => React.ReactNode;
}) {
  if (!rows.length)
    return <p className={styles.empty}>No work is waiting in this queue.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c.replace(/([A-Z])/g, " $1")}</th>
            ))}
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => (
                <td key={c}>
                  {/Minor$/.test(c) ? money(row[c]) : String(row[c] ?? "—")}
                </td>
              ))}
              {actions && (
                <td>
                  <div className={styles.actions}>{actions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function InvoiceQueue({
  rows,
  busy,
  action,
}: {
  rows: Row[];
  busy: boolean;
  action: (row: Row, a: string) => void;
}) {
  return (
    <section className={styles.panel}>
      <h2>Draft, approval and posted-unsubmitted queue</h2>
      <Table
        rows={rows}
        columns={["invoiceNo", "client", "invoiceDate", "state", "totalMinor"]}
        actions={(row) => (
          <>
            {["DRAFT", "VALIDATION_EXCEPTION"].includes(String(row.state)) && (
              <button disabled={busy} onClick={() => action(row, "SUBMIT")}>
                {row.state === "VALIDATION_EXCEPTION"
                  ? "Submit with exception"
                  : "Submit"}
              </button>
            )}
            {row.state === "PENDING_APPROVAL" && (
              <button disabled={busy} onClick={() => action(row, "APPROVE")}>
                Approve
              </button>
            )}
            {row.state === "APPROVED" && (
              <button disabled={busy} onClick={() => action(row, "POST")}>
                Post
              </button>
            )}
            {row.state === "POSTED" && (
              <>
                <button
                  disabled={busy}
                  onClick={() => action(row, "ACKNOWLEDGE")}
                >
                  Acknowledge submission
                </button>
                <button disabled={busy} onClick={() => action(row, "REVERSE")}>
                  Reverse
                </button>
              </>
            )}
          </>
        )}
      />
    </section>
  );
}
function CollectionQueue({
  rows,
  busy,
  mutate,
}: {
  rows: Row[];
  busy: boolean;
  mutate: (p: string, b: unknown) => Promise<void>;
}) {
  return (
    <section className={styles.panel}>
      <h2>Collection priority</h2>
      <Table
        rows={rows}
        columns={[
          "invoiceNo",
          "client",
          "priority",
          "dueDate",
          "openMinor",
          "lastFollowupAt",
        ]}
        actions={(row) => (
          <>
            <button
              disabled={busy}
              onClick={() => {
                const note = prompt("Follow-up note");
                if (note)
                  void mutate(`/tenant/finance/invoices/${row.id}/followups`, {
                    outcome: "CONTACTED",
                    note,
                    nextFollowupAt: new Date(
                      Date.now() + 86400000,
                    ).toISOString(),
                  });
              }}
            >
              Add follow-up
            </button>
            <Link href={`/app/finance/receipts?invoice=${row.id}`}>
              Allocate receipt
            </Link>
          </>
        )}
      />
    </section>
  );
}
function VendorQueue({
  rows,
  busy,
  action,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
}) {
  return (
    <section className={styles.panel}>
      <h2>Vendor unbilled, approval and payment queue</h2>
      <Table
        rows={rows}
        columns={[
          "vendorInvoiceNo",
          "vendor",
          "invoiceDate",
          "state",
          "outstandingMinor",
        ]}
        actions={(row) => (
          <>
            {row.state === "DRAFT" && (
              <button disabled={busy} onClick={() => action(row, "SUBMIT")}>
                Submit
              </button>
            )}
            {row.state === "PENDING_OPERATIONAL_VERIFICATION" && (
              <button disabled={busy} onClick={() => action(row, "VERIFY")}>
                Verify operations
              </button>
            )}
            {row.state === "PENDING_FINANCE_APPROVAL" && (
              <button disabled={busy} onClick={() => action(row, "APPROVE")}>
                Approve
              </button>
            )}
            {["APPROVED", "PART_PAID"].includes(String(row.state)) && (
              <button disabled={busy} onClick={() => action(row, "PAY")}>
                Add to payment run
              </button>
            )}
            {[
              "VALIDATION_EXCEPTION",
              "PENDING_OPERATIONAL_VERIFICATION",
              "PENDING_FINANCE_APPROVAL",
            ].includes(String(row.state)) && (
              <button disabled={busy} onClick={() => action(row, "DISPUTE")}>
                Raise exception
              </button>
            )}
          </>
        )}
      />
    </section>
  );
}
function PaymentRuns({
  rows,
  busy,
  action,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
}) {
  return (
    <section className={styles.panel}>
      <h2>Payment runs and exceptions</h2>
      <Table
        rows={rows}
        columns={["batchNo", "state", "totalMinor", "allocations", "utr"]}
        actions={(row) => (
          <>
            {row.state === "PENDING_APPROVAL" && (
              <button disabled={busy} onClick={() => action(row, "APPROVE")}>
                Approve
              </button>
            )}
            {row.state === "APPROVED" && (
              <button disabled={busy} onClick={() => action(row, "SUBMIT")}>
                Submit to bank
              </button>
            )}
            {row.state === "SUBMITTED" && (
              <>
                <button
                  disabled={busy}
                  onClick={() => action(row, "MARK_PAID")}
                >
                  Mark paid
                </button>
                <button disabled={busy} onClick={() => action(row, "FAIL")}>
                  Mark failed
                </button>
              </>
            )}
            {row.state === "PAID" && (
              <button disabled={busy} onClick={() => action(row, "REVERSE")}>
                Reverse
              </button>
            )}
          </>
        )}
      />
    </section>
  );
}
