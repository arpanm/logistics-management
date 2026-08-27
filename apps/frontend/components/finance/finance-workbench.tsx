"use client";

import Link from "next/link";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, type ApiError } from "../api";
import { FormSubmitResult } from "../forms/form-submit-result";
import { Shell } from "../shell";
import styles from "./finance-workbench.module.css";

type Row = Record<string, unknown> & {
  id: string;
  state?: string;
  version: number;
};
type Client = { id: string; name: string; code: string };
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
type Refs = {
  services: Service[];
  charges: Charge[];
  banks: Bank[];
  clients: Client[];
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
type Section = "overview" | "invoices" | "collections" | "vendors" | "payments";
type Line = {
  tripId: string;
  podTaskId: string;
  chargeCode: string;
  quantityMilli: string;
  rateMinor: string;
  taxBasisPoints: number;
};
type InvoiceDraft = {
  invoiceNo: string;
  invoiceDate: string;
  currency: string;
  creditDays: number;
  lines: Line[];
};
type InvoiceFilters = {
  search: string;
  status: string;
  clientId: string;
  from: string;
  to: string;
};
type ReceiptDraft = {
  receiptRef: string;
  clientId: string;
  paymentDate: string;
  amountMinor: string;
  mode: string;
  instrumentNo: string;
  bankReference: string;
};
type AllocationDraft = {
  receiptId: string;
  invoiceId: string;
  amountMinor: string;
};
type Dialog = {
  kind:
    | "edit"
    | "reject"
    | "acknowledge"
    | "reverse-invoice"
    | "note"
    | "followup"
    | "vendor-bill"
    | "pay"
    | "payment-reference"
    | "payment-reason";
  row: Row;
  action?: string;
} | null;

const blankLine: Line = {
  tripId: "",
  podTaskId: "",
  chargeCode: "",
  quantityMilli: "1000",
  rateMinor: "0",
  taxBasisPoints: 0,
};
const today = () => new Date().toISOString().slice(0, 10);
const blankInvoice = (): InvoiceDraft => ({
  invoiceNo: "",
  invoiceDate: today(),
  currency: "INR",
  creditDays: 30,
  lines: [{ ...blankLine }],
});
const blankReceipt = (): ReceiptDraft => ({
  receiptRef: "",
  clientId: "",
  paymentDate: today(),
  amountMinor: "",
  mode: "NEFT",
  instrumentNo: "",
  bankReference: "",
});
const blankAllocation = (): AllocationDraft => ({
  receiptId: "",
  invoiceId: "",
  amountMinor: "",
});
const money = (minor: unknown) => {
  if (minor === "••••") return "••••";
  try {
    const value = BigInt(String(minor ?? "0"));
    const absolute = value < BigInt(0) ? -value : value;
    return `${value < BigInt(0) ? "-" : ""}₹${(absolute / BigInt(100)).toLocaleString("en-IN")}.${(absolute % BigInt(100)).toString().padStart(2, "0")}`;
  } catch {
    return "—";
  }
};
const positiveMinor = (minor: unknown) => {
  try {
    return BigInt(String(minor)) > BigInt(0);
  } catch {
    return false;
  }
};
const label = (key: string) =>
  key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const pendingBill = (row: Row) =>
  !["PAID", "REVERSED"].includes(String(row.state));

export function FinanceWorkbench({
  section = "overview",
}: {
  section?: Section;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [refs, setRefs] = useState<Refs>({
    services: [],
    charges: [],
    banks: [],
    clients: [],
  });
  const [allInvoices, setAllInvoices] = useState<Row[]>([]),
    [allReceipts, setAllReceipts] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [feedbackAction, setFeedbackAction] = useState(""),
    [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filters, setFilters] = useState({
    search: "",
    status: "",
    clientId: "",
    from: "",
    to: "",
  });
  const [invoice, setInvoice] = useState<InvoiceDraft>(blankInvoice);
  const [receipt, setReceipt] = useState<ReceiptDraft>(blankReceipt);
  const [allocation, setAllocation] =
    useState<AllocationDraft>(blankAllocation);
  const invoicePath = useMemo(() => {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(
      ([key, value]) => value && query.set(key, value),
    );
    return `/tenant/finance/invoices?${query.toString()}`;
  }, [filters]);
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const [next, nextRefs, invoices, receipts] = await Promise.all([
        api<Dashboard>("/tenant/finance/workbench"),
        api<Refs>("/tenant/finance/references"),
        api<{ items: Row[] }>(invoicePath),
        api<{ items: Row[] }>("/tenant/finance/receipts"),
      ]);
      setData(next);
      setRefs(nextRefs);
      setAllInvoices(invoices.items);
      setAllReceipts(receipts.items);
    } catch (value) {
      setError(
        (value as ApiError).message ?? "Finance workbench could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }, [invoicePath]);
  useEffect(() => {
    void load();
  }, [load]);
  const mutate = async (
    path: string,
    body: unknown,
    success = "Finance record updated.",
    feedbackKey = "",
  ) => {
    setFeedbackAction(feedbackKey);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice(success);
      setDialog(null);
      await load();
      return true;
    } catch (value) {
      setError((value as ApiError).message ?? "Action could not be completed");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const firstService = useMemo(
    () =>
      refs.services.find((s) =>
        invoice.lines.some((line) => line.tripId === s.tripId),
      ),
    [invoice.lines, refs.services],
  );
  const lineChange = (index: number, patch: Partial<Line>) =>
    setInvoice((current) => ({
      ...current,
      lines: current.lines.map((line, i) =>
        i === index ? { ...line, ...patch } : line,
      ),
    }));
  const chooseService = (index: number, tripId: string) => {
    const selected = refs.services.find((s) => s.tripId === tripId);
    lineChange(index, {
      tripId,
      podTaskId: selected?.podTaskId ?? "",
      chargeCode: "",
      rateMinor: "0",
      taxBasisPoints: 0,
    });
  };
  const chooseCharge = (index: number, code: string) => {
    const service = refs.services.find(
      (s) => s.tripId === invoice.lines[index]?.tripId,
    );
    const selected = refs.charges.find(
      (c) => c.code === code && c.laneId === service?.laneId,
    );
    lineChange(index, {
      chargeCode: code,
      rateMinor: selected?.rateMinor ?? "0",
      taxBasisPoints: selected?.taxBasisPoints ?? 0,
    });
  };
  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    if (!firstService)
      return setError("Select at least one eligible trip / POD.");
    const saved = await mutate(
      "/tenant/finance/invoices",
      {
        ...invoice,
        clientId: firstService.clientId,
        clientLocationId: firstService.clientLocationId,
        creditDays: Number(invoice.creditDays),
      },
      "Draft invoice created.",
      "invoice-create",
    );
    if (saved) setInvoice(blankInvoice());
  };
  const invoiceAction = (row: Row, action: string) =>
    void mutate(`/tenant/finance/invoices/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
    });
  const vendorAction = (row: Row, action: string) =>
    void mutate(`/tenant/finance/vendor-bills/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
    });
  const paymentAction = (row: Row, action: string) =>
    void mutate(`/tenant/finance/payment-runs/${row.id}/actions`, {
      action,
      expectedVersion: row.version,
    });
  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.hero}>
          <div>
            <p className="eyebrow">Finance command centre</p>
            <h1>Billing, collections and payables</h1>
            <p className="muted">
              Every pending item has its next valid action. Amounts reconcile to
              append-only minor-unit ledgers.
            </p>
          </div>
          <FinanceNav />
        </header>
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        )}
        {loading && (
          <div className={styles.loading} role="status">
            Loading current finance queues…
          </div>
        )}
        {!loading && section === "overview" && (
          <Overview
            data={data}
            busy={busy}
            invoiceAction={invoiceAction}
            openDialog={setDialog}
            vendorAction={vendorAction}
            paymentAction={paymentAction}
          />
        )}
        {!loading && section === "invoices" && (
          <>
            <InvoiceCreate
              invoice={invoice}
              refs={refs}
              busy={busy}
              onSubmit={createInvoice}
              setInvoice={setInvoice}
              lineChange={lineChange}
              chooseService={chooseService}
              chooseCharge={chooseCharge}
              error={feedbackAction === "invoice-create" ? error : ""}
              notice={feedbackAction === "invoice-create" ? notice : ""}
            />
            <InvoiceRegister
              rows={allInvoices}
              refs={refs}
              filters={filters}
              setFilters={setFilters}
              busy={busy}
              action={invoiceAction}
              openDialog={setDialog}
            />
          </>
        )}
        {!loading && section === "collections" && (
          <Collections
            rows={data?.queues.collections ?? []}
            receipts={allReceipts}
            refs={refs}
            receipt={receipt}
            setReceipt={setReceipt}
            allocation={allocation}
            setAllocation={setAllocation}
            busy={busy}
            mutate={mutate}
            error={error}
            notice={notice}
            feedbackAction={feedbackAction}
            openDialog={setDialog}
          />
        )}
        {!loading && section === "vendors" && (
          <VendorPayables
            services={data?.queues.vendorServices ?? []}
            bills={data?.queues.vendorBills ?? []}
            busy={busy}
            action={vendorAction}
            openDialog={setDialog}
          />
        )}
        {!loading && section === "payments" && (
          <PaymentRuns
            rows={data?.queues.paymentRuns ?? []}
            busy={busy}
            action={paymentAction}
            openDialog={setDialog}
          />
        )}
        {dialog && (
          <ActionDialog
            dialog={dialog}
            refs={refs}
            busy={busy}
            close={() => setDialog(null)}
            mutate={mutate}
          />
        )}
      </main>
    </Shell>
  );
}

function FinanceNav() {
  return (
    <nav className={styles.tabs} aria-label="Finance workbench">
      <Link href="/app/finance">Dashboard</Link>
      <Link href="/app/finance/invoices">All invoices</Link>
      <Link href="/app/finance/receipts">Collections & receipts</Link>
      <Link href="/app/finance/vendor-bills">Vendor payables</Link>
      <Link href="/app/finance/payment-runs">Payment runs</Link>
    </nav>
  );
}
function Overview({
  data,
  busy,
  invoiceAction,
  openDialog,
  vendorAction,
  paymentAction,
}: {
  data: Dashboard | null;
  busy: boolean;
  invoiceAction: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
  vendorAction: (r: Row, a: string) => void;
  paymentAction: (r: Row, a: string) => void;
}) {
  const bills = (data?.queues.vendorBills ?? []).filter(pendingBill);
  return (
    <>
      <section className={styles.metrics} aria-label="Finance workload">
        {Object.entries(data?.metrics ?? {}).map(([key, value]) => (
          <article className={styles.metric} key={key}>
            <strong>{value}</strong>
            <span>{label(key)}</span>
          </article>
        ))}
      </section>
      <div className={styles.dashboardGrid}>
        <section className={styles.panel}>
          <PanelHeading
            title="Pending client invoices"
            href="/app/finance/invoices"
          />
          <InvoiceTable
            rows={data?.queues.invoices ?? []}
            busy={busy}
            action={invoiceAction}
            openDialog={openDialog}
            compact
          />
        </section>
        <section className={styles.panel}>
          <PanelHeading
            title="Collections requiring follow-up"
            href="/app/finance/receipts"
          />
          <CollectionTable
            rows={data?.queues.collections ?? []}
            busy={busy}
            openDialog={openDialog}
            compact
          />
        </section>
        <section className={styles.panel}>
          <PanelHeading
            title="Vendor bills requiring action"
            href="/app/finance/vendor-bills"
          />
          <VendorTable
            rows={bills}
            busy={busy}
            action={vendorAction}
            openDialog={openDialog}
            compact
          />
        </section>
        <section className={styles.panel}>
          <PanelHeading
            title="Payment runs requiring action"
            href="/app/finance/payment-runs"
          />
          <PaymentTable
            rows={data?.queues.paymentRuns ?? []}
            busy={busy}
            action={paymentAction}
            openDialog={openDialog}
            compact
          />
        </section>
      </div>
    </>
  );
}
function PanelHeading({ title, href }: { title: string; href?: string }) {
  return (
    <div className={styles.panelHeading}>
      <h2>{title}</h2>
      {href && <Link href={href}>View all</Link>}
    </div>
  );
}

function InvoiceCreate({
  invoice,
  refs,
  busy,
  onSubmit,
  setInvoice,
  lineChange,
  chooseService,
  chooseCharge,
  error,
  notice,
}: {
  invoice: InvoiceDraft;
  refs: Refs;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  setInvoice: Dispatch<SetStateAction<InvoiceDraft>>;
  lineChange: (index: number, patch: Partial<Line>) => void;
  chooseService: (index: number, tripId: string) => void;
  chooseCharge: (index: number, code: string) => void;
  error: string;
  notice: string;
}) {
  return (
    <details className={styles.panel}>
      <summary>Create invoice from eligible services</summary>
      <p className="muted">
        Select delivered trips with accepted PODs. Rates and tax are taken from
        published charge snapshots.
      </p>
      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.formGrid}>
          <Field label="Invoice number">
            <input
              required
              value={invoice.invoiceNo}
              onChange={(e) =>
                setInvoice({ ...invoice, invoiceNo: e.target.value })
              }
            />
          </Field>
          <Field label="Invoice date">
            <input
              required
              type="date"
              value={invoice.invoiceDate}
              onChange={(e) =>
                setInvoice({ ...invoice, invoiceDate: e.target.value })
              }
            />
          </Field>
          <Field label="Currency">
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
          </Field>
          <Field label="Credit days">
            <input
              required
              type="number"
              min="0"
              max="365"
              value={invoice.creditDays}
              onChange={(e) =>
                setInvoice({ ...invoice, creditDays: Number(e.target.value) })
              }
            />
          </Field>
        </div>
        {invoice.lines.map((line: Line, index: number) => (
          <div className={styles.line} key={index}>
            <Field label="Trip / LR / POD">
              <select
                required
                value={line.tripId}
                onChange={(e) => chooseService(index, e.target.value)}
              >
                <option value="">Search and select eligible service…</option>
                {refs.services.map((s: Service) => (
                  <option key={s.tripId} value={s.tripId}>
                    {s.tripNo} · {s.lrNo} · {s.client} · POD {s.podState}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Charge code">
              <select
                required
                value={line.chargeCode}
                onChange={(e) => chooseCharge(index, e.target.value)}
              >
                <option value="">Select charge…</option>
                {refs.charges
                  .filter(
                    (c: Charge) =>
                      c.laneId ===
                      refs.services.find(
                        (s: Service) => s.tripId === line.tripId,
                      )?.laneId,
                  )
                  .map((c: Charge) => (
                    <option key={`${c.laneId}:${c.code}`} value={c.code}>
                      {c.code} · {c.basis}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Quantity (milli-units)" hint="1000 = one unit">
              <input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={line.quantityMilli}
                onChange={(e) =>
                  lineChange(index, { quantityMilli: e.target.value })
                }
              />
            </Field>
            <Field label="Rate (minor units)" hint="₹100.00 = 10000">
              <input required readOnly value={line.rateMinor} />
            </Field>
            <button
              type="button"
              disabled={invoice.lines.length === 1}
              onClick={() =>
                setInvoice({
                  ...invoice,
                  lines: invoice.lines.filter(
                    (_: Line, i: number) => i !== index,
                  ),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <FormSubmitResult error={error} success={notice} busy={busy}>
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
        </FormSubmitResult>
      </form>
    </details>
  );
}
function InvoiceRegister({
  rows,
  refs,
  filters,
  setFilters,
  busy,
  action,
  openDialog,
}: {
  rows: Row[];
  refs: Refs;
  filters: InvoiceFilters;
  setFilters: Dispatch<SetStateAction<InvoiceFilters>>;
  busy: boolean;
  action: (row: Row, action: string) => void;
  openDialog: Dispatch<SetStateAction<Dialog>>;
}) {
  return (
    <section className={styles.panel}>
      <PanelHeading title={`All invoices (${rows.length})`} />
      <form
        className={styles.filters}
        onSubmit={(e) => e.preventDefault()}
        aria-label="Invoice filters"
      >
        <Field label="Search">
          <input
            type="search"
            value={filters.search}
            placeholder="Invoice or client"
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
        </Field>
        <Field label="Status">
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {[
              "DRAFT",
              "PENDING_APPROVAL",
              "REJECTED",
              "APPROVED",
              "POSTED",
              "SUBMITTED",
              "REVERSED",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Client">
          <select
            value={filters.clientId}
            onChange={(e) =>
              setFilters({ ...filters, clientId: e.target.value })
            }
          >
            <option value="">All clients</option>
            {refs.clients.map((c: Client) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Invoice date from" optional>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </Field>
        <Field label="Invoice date to" optional>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </Field>
        <button
          type="button"
          onClick={() =>
            setFilters({
              search: "",
              status: "",
              clientId: "",
              from: "",
              to: "",
            })
          }
        >
          Clear
        </button>
      </form>
      <InvoiceTable
        rows={rows}
        busy={busy}
        action={action}
        openDialog={openDialog}
      />
    </section>
  );
}
function InvoiceTable({
  rows,
  busy,
  action,
  openDialog,
  compact = false,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
  compact?: boolean;
}) {
  return (
    <DataTable
      rows={compact ? rows.slice(0, 8) : rows}
      columns={
        compact
          ? ["invoiceNo", "client", "state", "totalMinor"]
          : [
              "invoiceNo",
              "client",
              "invoiceDate",
              "dueDate",
              "state",
              "totalMinor",
              "openMinor",
            ]
      }
      actions={(row) => (
        <>
          {["DRAFT", "REJECTED"].includes(String(row.state)) && (
            <>
              <button
                disabled={busy}
                onClick={() => openDialog({ kind: "edit", row })}
              >
                Edit
              </button>
              <button disabled={busy} onClick={() => action(row, "SUBMIT")}>
                Submit
              </button>
            </>
          )}
          {row.state === "PENDING_APPROVAL" && (
            <>
              <button disabled={busy} onClick={() => action(row, "APPROVE")}>
                Approve
              </button>
              <button
                disabled={busy}
                className={styles.danger}
                onClick={() => openDialog({ kind: "reject", row })}
              >
                Reject
              </button>
            </>
          )}
          {row.state === "APPROVED" && (
            <button disabled={busy} onClick={() => action(row, "POST")}>
              Post
            </button>
          )}
          {row.state === "POSTED" && (
            <button
              disabled={busy}
              onClick={() => openDialog({ kind: "acknowledge", row })}
            >
              Acknowledge
            </button>
          )}
          {["POSTED", "SUBMITTED"].includes(String(row.state)) && (
            <>
              <button
                disabled={busy}
                onClick={() => openDialog({ kind: "note", row })}
              >
                Add finance memo
              </button>
              <button
                disabled={busy}
                className={styles.danger}
                onClick={() => openDialog({ kind: "reverse-invoice", row })}
              >
                Reverse
              </button>
            </>
          )}
        </>
      )}
    />
  );
}

function Collections({
  rows,
  receipts,
  refs,
  receipt,
  setReceipt,
  allocation,
  setAllocation,
  busy,
  mutate,
  error,
  notice,
  feedbackAction,
  openDialog,
}: {
  rows: Row[];
  receipts: Row[];
  refs: Refs;
  receipt: ReceiptDraft;
  setReceipt: Dispatch<SetStateAction<ReceiptDraft>>;
  allocation: AllocationDraft;
  setAllocation: Dispatch<SetStateAction<AllocationDraft>>;
  busy: boolean;
  mutate: (
    path: string,
    body: unknown,
    success?: string,
    feedbackKey?: string,
  ) => Promise<boolean>;
  error: string;
  notice: string;
  feedbackAction: string;
  openDialog: Dispatch<SetStateAction<Dialog>>;
}) {
  return (
    <>
      <section className={styles.panel}>
        <PanelHeading title="Collection priority dashboard" />
        <CollectionTable rows={rows} busy={busy} openDialog={openDialog} />
      </section>
      <details className={styles.panel}>
        <summary>Record bank receipt</summary>
        <form
          className={styles.form}
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await mutate(
              "/tenant/finance/receipts",
              { ...receipt, bankReference: receipt.bankReference || undefined },
              "Receipt recorded.",
              "receipt-create",
            );
            if (saved) setReceipt(blankReceipt());
          }}
        >
          <div className={styles.formGrid}>
            <Field label="Receipt reference">
              <input
                required
                value={receipt.receiptRef}
                onChange={(e) =>
                  setReceipt({ ...receipt, receiptRef: e.target.value })
                }
              />
            </Field>
            <Field label="Client">
              <select
                required
                value={receipt.clientId}
                onChange={(e) =>
                  setReceipt({ ...receipt, clientId: e.target.value })
                }
              >
                <option value="">Search and select client…</option>
                {refs.clients.map((c: Client) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payment date">
              <input
                required
                type="date"
                value={receipt.paymentDate}
                onChange={(e) =>
                  setReceipt({ ...receipt, paymentDate: e.target.value })
                }
              />
            </Field>
            <Field label="Amount received (minor units)" hint="₹100.00 = 10000">
              <input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={receipt.amountMinor}
                onChange={(e) =>
                  setReceipt({ ...receipt, amountMinor: e.target.value })
                }
              />
            </Field>
            <Field label="Payment mode">
              <select
                value={receipt.mode}
                onChange={(e) =>
                  setReceipt({ ...receipt, mode: e.target.value })
                }
              >
                {["NEFT", "RTGS", "IMPS", "CHEQUE", "UPI", "ADJUSTMENT"].map(
                  (m) => (
                    <option key={m}>{m}</option>
                  ),
                )}
              </select>
            </Field>
            <Field label="UTR / instrument number">
              <input
                required
                value={receipt.instrumentNo}
                onChange={(e) =>
                  setReceipt({ ...receipt, instrumentNo: e.target.value })
                }
              />
            </Field>
            <Field label="Bank reference" optional>
              <input
                value={receipt.bankReference}
                onChange={(e) =>
                  setReceipt({ ...receipt, bankReference: e.target.value })
                }
              />
            </Field>
          </div>
          <FormSubmitResult
            error={feedbackAction === "receipt-create" ? error : ""}
            success={feedbackAction === "receipt-create" ? notice : ""}
            busy={busy}
          >
            <button disabled={busy}>Record receipt</button>
          </FormSubmitResult>
        </form>
      </details>
      <section className={styles.panel}>
        <PanelHeading title={`Receipt register (${receipts.length})`} />
        <DataTable
          rows={receipts}
          columns={[
            "receiptRef",
            "client",
            "paymentDate",
            "mode",
            "instrumentNo",
            "amountMinor",
            "unallocatedMinor",
            "state",
          ]}
        />
        <form
          className={styles.form}
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await mutate(
              `/domain/receipts/${allocation.receiptId}/allocations`,
              {
                invoiceId: allocation.invoiceId,
                entryType: "ALLOCATION",
                amountMinor: allocation.amountMinor,
              },
              "Receipt allocated.",
              "receipt-allocation",
            );
            if (saved) setAllocation(blankAllocation());
          }}
        >
          <h3>Allocate a receipt</h3>
          <div className={styles.formGrid}>
            <Field label="Receipt">
              <select
                required
                value={allocation.receiptId}
                onChange={(e) =>
                  setAllocation({ ...allocation, receiptId: e.target.value })
                }
              >
                <option value="">Search and select unallocated receipt…</option>
                {receipts
                  .filter((r: Row) => positiveMinor(r.unallocatedMinor))
                  .map((r: Row) => (
                    <option key={r.id} value={r.id}>
                      {String(r.receiptRef)} · {String(r.client)} ·{" "}
                      {money(r.unallocatedMinor)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Invoice">
              <select
                required
                value={allocation.invoiceId}
                onChange={(e) =>
                  setAllocation({ ...allocation, invoiceId: e.target.value })
                }
              >
                <option value="">Search and select open invoice…</option>
                {rows.map((r: Row) => (
                  <option key={r.id} value={r.id}>
                    {String(r.invoiceNo)} · {String(r.client)} ·{" "}
                    {money(r.openMinor)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Allocation (minor units)">
              <input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={allocation.amountMinor}
                onChange={(e) =>
                  setAllocation({ ...allocation, amountMinor: e.target.value })
                }
              />
            </Field>
          </div>
          <FormSubmitResult
            error={feedbackAction === "receipt-allocation" ? error : ""}
            success={feedbackAction === "receipt-allocation" ? notice : ""}
            busy={busy}
          >
            <button disabled={busy}>Allocate receipt</button>
          </FormSubmitResult>
        </form>
      </section>
    </>
  );
}
function CollectionTable({
  rows,
  busy,
  openDialog,
  compact = false,
}: {
  rows: Row[];
  busy: boolean;
  openDialog: (d: Dialog) => void;
  compact?: boolean;
}) {
  return (
    <DataTable
      rows={compact ? rows.slice(0, 8) : rows}
      columns={
        compact
          ? ["invoiceNo", "client", "priority", "openMinor"]
          : [
              "invoiceNo",
              "client",
              "priority",
              "dueDate",
              "openMinor",
              "lastFollowupAt",
            ]
      }
      actions={(row) => (
        <>
          <button
            disabled={busy}
            onClick={() => openDialog({ kind: "followup", row })}
          >
            Add follow-up
          </button>
          <Link href={`/app/finance/receipts?invoice=${row.id}`}>
            Allocate receipt
          </Link>
        </>
      )}
    />
  );
}
function VendorPayables({
  services,
  bills,
  busy,
  action,
  openDialog,
}: {
  services: Row[];
  bills: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
}) {
  return (
    <>
      <section className={styles.panel}>
        <PanelHeading title="Unbilled vendor services" />
        <DataTable
          rows={services}
          columns={["tripNo", "lrNo", "vendor", "expectedMinor"]}
          actions={(row) => (
            <button
              disabled={busy}
              onClick={() => openDialog({ kind: "vendor-bill", row })}
            >
              Create vendor bill
            </button>
          )}
        />
      </section>
      <section className={styles.panel}>
        <PanelHeading title={`All vendor bills (${bills.length})`} />
        <VendorTable
          rows={bills}
          busy={busy}
          action={action}
          openDialog={openDialog}
        />
      </section>
    </>
  );
}
function VendorTable({
  rows,
  busy,
  action,
  openDialog,
  compact = false,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
  compact?: boolean;
}) {
  return (
    <DataTable
      rows={compact ? rows.slice(0, 8) : rows}
      columns={
        compact
          ? ["vendorInvoiceNo", "vendor", "state", "outstandingMinor"]
          : [
              "vendorInvoiceNo",
              "vendor",
              "invoiceDate",
              "state",
              "payableMinor",
              "outstandingMinor",
            ]
      }
      actions={(row) => (
        <>
          {["DRAFT", "VALIDATION_EXCEPTION"].includes(String(row.state)) && (
            <button disabled={busy} onClick={() => action(row, "SUBMIT")}>
              Submit
            </button>
          )}
          {row.state === "PENDING_OPERATIONAL_VERIFICATION" && (
            <button disabled={busy} onClick={() => action(row, "VERIFY")}>
              Verify
            </button>
          )}
          {row.state === "PENDING_FINANCE_APPROVAL" && (
            <button disabled={busy} onClick={() => action(row, "APPROVE")}>
              Approve
            </button>
          )}
          {[
            "VALIDATION_EXCEPTION",
            "PENDING_OPERATIONAL_VERIFICATION",
            "PENDING_FINANCE_APPROVAL",
          ].includes(String(row.state)) && (
            <button
              disabled={busy}
              className={styles.danger}
              onClick={() =>
                openDialog({ kind: "payment-reason", row, action: "DISPUTE" })
              }
            >
              Dispute
            </button>
          )}
          {["APPROVED", "PART_PAID"].includes(String(row.state)) && (
            <button
              disabled={busy}
              onClick={() => openDialog({ kind: "pay", row })}
            >
              Add to payment run
            </button>
          )}
        </>
      )}
    />
  );
}
function PaymentRuns({
  rows,
  busy,
  action,
  openDialog,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
}) {
  return (
    <section className={styles.panel}>
      <PanelHeading title={`All payment runs (${rows.length})`} />
      <PaymentTable
        rows={rows}
        busy={busy}
        action={action}
        openDialog={openDialog}
      />
    </section>
  );
}
function PaymentTable({
  rows,
  busy,
  action,
  openDialog,
  compact = false,
}: {
  rows: Row[];
  busy: boolean;
  action: (r: Row, a: string) => void;
  openDialog: (d: Dialog) => void;
  compact?: boolean;
}) {
  return (
    <DataTable
      rows={compact ? rows.slice(0, 8) : rows}
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
                onClick={() =>
                  openDialog({
                    kind: "payment-reference",
                    row,
                    action: "MARK_PAID",
                  })
                }
              >
                Mark paid
              </button>
              <button
                disabled={busy}
                className={styles.danger}
                onClick={() =>
                  openDialog({ kind: "payment-reason", row, action: "FAIL" })
                }
              >
                Mark failed
              </button>
            </>
          )}
          {row.state === "PAID" && (
            <button
              disabled={busy}
              className={styles.danger}
              onClick={() =>
                openDialog({ kind: "payment-reason", row, action: "REVERSE" })
              }
            >
              Reverse
            </button>
          )}
        </>
      )}
    />
  );
}

function ActionDialog({
  dialog,
  refs,
  busy,
  close,
  mutate,
}: {
  dialog: NonNullable<Dialog>;
  refs: Refs;
  busy: boolean;
  close: () => void;
  mutate: (p: string, b: unknown, s?: string) => Promise<boolean>;
}) {
  const row = dialog.row;
  const [form, setForm] = useState<Record<string, string>>({
    invoiceNo: String(row.invoiceNo ?? ""),
    invoiceDate: String(row.invoiceDate ?? today()).slice(0, 10),
    creditDays: String(row.creditDays ?? 30),
    reason: "",
    acknowledgedAt: new Date().toISOString().slice(0, 16),
    noteType: "CREDIT_NOTE",
    amountMinor: String(row.outstandingMinor ?? row.openMinor ?? ""),
    outcome: "CONTACTED",
    promisedAt: "",
    promisedMinor: "",
    nextFollowupAt: "",
    vendorInvoiceNo: "",
    gstMinor: "0",
    claimedMinor: String(row.expectedMinor ?? "0"),
    bankVersionId:
      refs.banks.find((b) => b.vendorId === String(row.vendorId))
        ?.bankVersionId ?? "",
    batchNo: `PAY-${Date.now()}`,
    utr: "",
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dialog.kind === "edit")
      void mutate(
        `/tenant/finance/invoices/${row.id}/update`,
        {
          expectedVersion: row.version,
          invoiceNo: form.invoiceNo,
          invoiceDate: form.invoiceDate,
          creditDays: Number(form.creditDays),
        },
        "Invoice draft updated.",
      );
    if (dialog.kind === "reject")
      void mutate(
        `/tenant/finance/invoices/${row.id}/actions`,
        { action: "REJECT", expectedVersion: row.version, reason: form.reason },
        "Invoice rejected for correction.",
      );
    if (dialog.kind === "acknowledge")
      void mutate(
        `/tenant/finance/invoices/${row.id}/actions`,
        {
          action: "ACKNOWLEDGE",
          expectedVersion: row.version,
          acknowledgedAt: new Date(form.acknowledgedAt).toISOString(),
        },
        "Client acknowledgement recorded.",
      );
    if (dialog.kind === "reverse-invoice")
      void mutate(
        `/tenant/finance/invoices/${row.id}/actions`,
        {
          action: "REVERSE",
          expectedVersion: row.version,
          reversalInvoiceNo: form.invoiceNo,
          reason: form.reason,
        },
        "Compensating reversal posted.",
      );
    if (dialog.kind === "note")
      void mutate(
        `/tenant/finance/invoices/${row.id}/notes`,
        {
          noteType: form.noteType,
          amountMinor: form.amountMinor,
          reason: form.reason,
        },
        "Invoice note recorded.",
      );
    if (dialog.kind === "followup")
      void mutate(
        `/tenant/finance/invoices/${row.id}/followups`,
        {
          outcome: form.outcome,
          note: form.reason,
          promisedAt: form.promisedAt || undefined,
          promisedMinor: form.promisedMinor || undefined,
          nextFollowupAt: form.nextFollowupAt
            ? new Date(form.nextFollowupAt).toISOString()
            : undefined,
        },
        "Collection follow-up recorded.",
      );
    if (dialog.kind === "vendor-bill")
      void mutate(
        "/tenant/finance/vendor-bills",
        {
          vendorInvoiceNo: form.vendorInvoiceNo,
          invoiceDate: form.invoiceDate,
          vendorId: row.vendorId,
          gstMinor: form.gstMinor,
          lines: [{ tripId: row.tripId, claimedMinor: form.claimedMinor }],
        },
        "Vendor bill created.",
      );
    if (dialog.kind === "pay")
      void mutate(
        `/tenant/finance/vendor-bills/${row.id}/actions`,
        {
          action: "PAY",
          expectedVersion: row.version,
          bankVersionId: form.bankVersionId,
          amountMinor: form.amountMinor,
          batchNo: form.batchNo,
        },
        "Payment run created for approval.",
      );
    if (dialog.kind === "payment-reference")
      void mutate(
        `/tenant/finance/payment-runs/${row.id}/actions`,
        { action: dialog.action, expectedVersion: row.version, utr: form.utr },
        "Payment marked paid.",
      );
    if (dialog.kind === "payment-reason") {
      const route =
        dialog.action === "DISPUTE"
          ? `/tenant/finance/vendor-bills/${row.id}/actions`
          : `/tenant/finance/payment-runs/${row.id}/actions`;
      void mutate(
        route,
        {
          action: dialog.action,
          expectedVersion: row.version,
          reason: form.reason,
        },
        "Finance exception recorded.",
      );
    }
  };
  const f = (name: string, value: string) =>
    setForm((current) => ({ ...current, [name]: value }));
  const title: Record<string, string> = {
    edit: "Edit invoice draft",
    reject: "Reject invoice",
    acknowledge: "Acknowledge client submission",
    "reverse-invoice": "Reverse posted invoice",
    note: "Add non-financial invoice memo",
    followup: "Record collection follow-up",
    "vendor-bill": "Create vendor bill",
    pay: "Create payment run",
    "payment-reference": "Record bank payment",
    "payment-reason":
      dialog.action === "DISPUTE"
        ? "Dispute vendor bill"
        : dialog.action === "FAIL"
          ? "Mark payment failed"
          : "Reverse payment",
  };
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="finance-dialog-title"
      >
        <div className={styles.panelHeading}>
          <h2 id="finance-dialog-title">{title[dialog.kind]}</h2>
          <button type="button" onClick={close} aria-label="Close dialog">
            ×
          </button>
        </div>
        <form className={styles.form} onSubmit={submit}>
          {dialog.kind === "edit" && (
            <div className={styles.formGrid}>
              <Field label="Invoice number">
                <input
                  required
                  value={form.invoiceNo}
                  onChange={(e) => f("invoiceNo", e.target.value)}
                />
              </Field>
              <Field label="Invoice date">
                <input
                  required
                  type="date"
                  value={form.invoiceDate}
                  onChange={(e) => f("invoiceDate", e.target.value)}
                />
              </Field>
              <Field label="Credit days">
                <input
                  required
                  type="number"
                  min="0"
                  max="365"
                  value={form.creditDays}
                  onChange={(e) => f("creditDays", e.target.value)}
                />
              </Field>
            </div>
          )}
          {dialog.kind === "acknowledge" && (
            <Field label="Acknowledged at">
              <input
                required
                type="datetime-local"
                value={form.acknowledgedAt}
                onChange={(e) => f("acknowledgedAt", e.target.value)}
              />
            </Field>
          )}
          {dialog.kind === "reverse-invoice" && (
            <>
              <Field label="Reversal invoice number">
                <input
                  required
                  value={form.invoiceNo}
                  onChange={(e) => f("invoiceNo", e.target.value)}
                />
              </Field>
              <Reason form={form} f={f} />
            </>
          )}
          {dialog.kind === "reject" && (
            <Reason
              form={form}
              f={f}
              labelText="Reason and correction required"
            />
          )}
          {dialog.kind === "note" && (
            <>
              <p className="muted">
                This memo is an audit reference only and does not change the
                posted invoice balance. Use a compensating invoice or receipt
                ledger entry for financial adjustments.
              </p>
              <Field label="Note type">
                <select
                  value={form.noteType}
                  onChange={(e) => f("noteType", e.target.value)}
                >
                  <option>CREDIT_NOTE</option>
                  <option>DEBIT_NOTE</option>
                </select>
              </Field>
              <Field label="Amount (minor units)">
                <input
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  value={form.amountMinor}
                  onChange={(e) => f("amountMinor", e.target.value)}
                />
              </Field>
              <Reason form={form} f={f} />
            </>
          )}
          {dialog.kind === "followup" && (
            <>
              <Field label="Outcome">
                <select
                  value={form.outcome}
                  onChange={(e) => f("outcome", e.target.value)}
                >
                  <option>CONTACTED</option>
                  <option>PROMISE_TO_PAY</option>
                  <option>DISPUTED</option>
                  <option>NO_RESPONSE</option>
                  <option>ESCALATED</option>
                </select>
              </Field>
              <Reason form={form} f={f} labelText="Follow-up note" />
              <div className={styles.formGrid}>
                <Field label="Promise date" optional>
                  <input
                    type="date"
                    value={form.promisedAt}
                    onChange={(e) => f("promisedAt", e.target.value)}
                  />
                </Field>
                <Field label="Promise amount (minor)" optional>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]+"
                    value={form.promisedMinor}
                    onChange={(e) => f("promisedMinor", e.target.value)}
                  />
                </Field>
                <Field label="Next follow-up" optional>
                  <input
                    type="datetime-local"
                    value={form.nextFollowupAt}
                    onChange={(e) => f("nextFollowupAt", e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
          {dialog.kind === "vendor-bill" && (
            <>
              <Field label="Vendor invoice / reference">
                <input
                  required
                  value={form.vendorInvoiceNo}
                  onChange={(e) => f("vendorInvoiceNo", e.target.value)}
                />
              </Field>
              <Field label="Invoice date">
                <input
                  required
                  type="date"
                  value={form.invoiceDate}
                  onChange={(e) => f("invoiceDate", e.target.value)}
                />
              </Field>
              <Field label="Claimed amount (minor units)">
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={form.claimedMinor}
                  onChange={(e) => f("claimedMinor", e.target.value)}
                />
              </Field>
              <Field label="GST amount (minor units)">
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={form.gstMinor}
                  onChange={(e) => f("gstMinor", e.target.value)}
                />
              </Field>
            </>
          )}
          {dialog.kind === "pay" && (
            <>
              <Field label="Verified bank account">
                <select
                  required
                  value={form.bankVersionId}
                  onChange={(e) => f("bankVersionId", e.target.value)}
                >
                  <option value="">Select verified account…</option>
                  {refs.banks
                    .filter((b) => b.vendorId === String(row.vendorId))
                    .map((b) => (
                      <option key={b.bankVersionId} value={b.bankVersionId}>
                        {b.accountHolder} · {b.ifsc}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Payment amount (minor units)">
                <input
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  value={form.amountMinor}
                  onChange={(e) => f("amountMinor", e.target.value)}
                />
              </Field>
              <Field label="Payment batch number">
                <input
                  required
                  value={form.batchNo}
                  onChange={(e) => f("batchNo", e.target.value)}
                />
              </Field>
            </>
          )}
          {dialog.kind === "payment-reference" && (
            <Field label="Bank UTR / transaction reference">
              <input
                required
                value={form.utr}
                onChange={(e) => f("utr", e.target.value)}
              />
            </Field>
          )}
          {dialog.kind === "payment-reason" && <Reason form={form} f={f} />}
          <div className={styles.actions}>
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button disabled={busy}>Confirm</button>
          </div>
        </form>
      </section>
    </div>
  );
}
function Reason({
  form,
  f,
  labelText = "Reason",
}: {
  form: Record<string, string>;
  f: (n: string, v: string) => void;
  labelText?: string;
}) {
  return (
    <Field label={labelText}>
      <textarea
        required
        minLength={3}
        rows={4}
        value={form.reason}
        onChange={(e) => f("reason", e.target.value)}
      />
    </Field>
  );
}
function Field({
  label: text,
  hint,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span>
        {text}
        {optional && <small> (optional)</small>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function DataTable({
  rows,
  columns,
  actions,
}: {
  rows: Row[];
  columns: string[];
  actions?: (row: Row) => ReactNode;
}) {
  if (!rows.length)
    return (
      <div className={styles.empty}>
        <strong>Nothing waiting here</strong>
        <span>This register has no records matching the current view.</span>
      </div>
    );
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{label(c)}</th>
            ))}
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => (
                <td key={c}>
                  {c.endsWith("Minor") ? (
                    money(row[c])
                  ) : c === "state" || c === "priority" ? (
                    <span
                      className={`${styles.badge} ${styles[String(row[c]).toLowerCase()] ?? ""}`}
                    >
                      {String(row[c] ?? "—")}
                    </span>
                  ) : (
                    String(row[c] ?? "—")
                  )}
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
