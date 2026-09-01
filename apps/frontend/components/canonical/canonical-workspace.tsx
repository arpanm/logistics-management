"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import { SmartField } from "../forms/smart-field";
import { FormSubmitResult } from "../forms/form-submit-result";
import { Modal } from "../modal";
import { DetailList, FilterChip, MetricCard } from "../ui/primitives";
import { useTenantFormat } from "../use-tenant-format";
import type { CanonicalField, CanonicalManifest } from "./manifests";

type Row = Record<string, unknown> & {
  id: string;
  version: number;
  state?: string;
};
const titleOf = (row: Row) =>
  String(
    row.name ??
      row.legal_name ??
      row.display_name ??
      row.code ??
      row.indent_no ??
      row.invoice_no ??
      row.receipt_ref ??
      row.trip_no ??
      row.id,
  );
const stateOf = (row: Row) => String(row.state ?? "ACTIVE");
function inputValue(field: CanonicalField, value: string) {
  if (field.kind === "number")
    return /Minor$/.test(field.key) ? value : Number(value);
  if (field.kind === "list")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (field.kind === "key-value")
    return Object.fromEntries(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const split = item.indexOf("=");
          if (split < 1)
            throw new SyntaxError("Each setting must use key=value.");
          const key = item.slice(0, split).trim(),
            raw = item.slice(split + 1).trim();
          return [
            key,
            /^(true|false)$/i.test(raw)
              ? raw.toLowerCase() === "true"
              : /^-?\d+(\.\d+)?$/.test(raw)
                ? Number(raw)
                : raw,
          ];
        }),
    );
  if (field.kind === "records")
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        if (cells.length !== field.recordColumns?.length)
          throw new SyntaxError(
            "Each record must contain every displayed column.",
          );
        return Object.fromEntries(
          field.recordColumns.map((column, index) => [
            column.key,
            column.kind === "number" ? cells[index] : cells[index],
          ]),
        );
      });
  if (field.kind === "geofence") return JSON.parse(value);
  if (field.kind === "datetime-local") return new Date(value).toISOString();
  return value;
}
const commaList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const keyValues = (value: string) =>
  Object.fromEntries(
    commaList(value).map((item) => {
      const index = item.indexOf("=");
      if (index < 1) throw new SyntaxError("Use key=value for every term.");
      return [item.slice(0, index).trim(), item.slice(index + 1).trim()];
    }),
  );

function CommandReference({
  fieldKey,
  label,
  resource,
  value,
  required = true,
  help,
  onChange,
}: {
  fieldKey: string;
  label: string;
  resource: string;
  value: string;
  required?: boolean;
  help?: string;
  onChange: (value: string) => void;
}) {
  return (
    <SmartField
      field={{
        key: fieldKey,
        label,
        kind: "reference",
        referenceResource: resource,
        required,
        help,
      }}
      value={value}
      onChange={onChange}
    />
  );
}

export function CanonicalWorkspace({
  manifest,
  portal = false,
  portalTitle,
}: {
  manifest: CanonicalManifest;
  portal?: boolean;
  portalTitle?: string;
}) {
  const tenantFormat = useTenantFormat();
  const [items, setItems] = useState<Row[]>([]),
    [selected, setSelected] = useState<Row | null>(null),
    [values, setValues] = useState<Record<string, string>>(() => ({
      timezone: "Asia/Kolkata",
      currency: "INR",
    }));
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [report, setReport] = useState<Array<{
      state: string;
      count: number;
    }> | null>(null),
    [reason, setReason] = useState(""),
    [banks, setBanks] = useState<Array<Row>>([]),
    [compliance, setCompliance] = useState<Array<Row>>([]),
    [reportState, setReportState] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0);
  const [command, setCommand] = useState<Record<string, string>>({});
  const errorRef = useRef<HTMLDivElement>(null),
    base = `/domain/${manifest.resource}`;
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: "50",
        ...(reportState ? { state: reportState } : {}),
      });
      const result = await api<{
        items: Row[];
        total: number;
        page: number;
        pageSize: number;
      }>(`${base}?${query.toString()}`, { signal });
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (value) {
      if ((value as Error).name !== "AbortError") setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [base, page, reportState]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice("");
    try {
      const body = Object.fromEntries(
        manifest.fields
          .filter(
            (field) =>
              values[field.key] !== undefined && values[field.key] !== "",
          )
          .map((field) => [field.key, inputValue(field, values[field.key]!)]),
      );
      await api(base, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setValues({ timezone: "Asia/Kolkata", currency: "INR" });
      setNotice(`${manifest.singular} created.`);
      await load();
    } catch (value) {
      setError(
        value instanceof SyntaxError
          ? { code: "INVALID_JSON", message: "Enter valid JSON." }
          : (value as ApiError),
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }
  async function open(row: Row) {
    try {
      const detail = await api<Row>(`${base}/${row.id}`);
      setSelected(detail);
      const bankVendorId =
        manifest.resource === "vendors"
          ? row.id
          : manifest.resource === "vendor-bills"
            ? String(detail.vendorId ?? detail.vendor_id ?? "")
            : "";
      if (bankVendorId)
        setBanks(
          await api<Array<Row>>(
            `/domain/commands/vendors/${bankVendorId}/banks`,
          ),
        );
      else setBanks([]);
      const subjectType =
        manifest.resource === "vendors"
          ? "VENDOR"
          : manifest.resource === "vehicles"
            ? "VEHICLE"
            : manifest.resource === "drivers"
              ? "DRIVER"
              : "";
      if (subjectType)
        setCompliance(
          await api<Array<Row>>(
            `/domain/commands/compliance/${subjectType}/${row.id}`,
          ),
        );
      else setCompliance([]);
      setReason("");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function transition(toState: string) {
    if (!selected) return;
    try {
      const changed = await api<Row>(`${base}/${selected.id}/transition`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          toState,
          expectedVersion: selected.version,
          reason: reason || undefined,
        }),
      });
      setNotice(`State changed to ${toState}.`);
      await open(changed);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function showReport() {
    try {
      setReport(
        (
          await api<{ rows: Array<{ state: string; count: number }> }>(
            `${base}/report`,
          )
        ).rows,
      );
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function runCommand(
    path: string,
    body: Record<string, unknown>,
    resetValueKeys: string[] = [],
  ) {
    setError(null);
    setNotice("");
    try {
      const changed = await api<Row>(`/domain/commands/${path}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice("Command completed and audit evidence was recorded.");
      setCommand({});
      if (resetValueKeys.length)
        setValues((current) => ({
          ...current,
          ...Object.fromEntries(resetValueKeys.map((key) => [key, ""])),
        }));
      if (selected) await open(selected);
      await load();
      return changed;
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">{manifest.feature}</p>
          <h1>{portalTitle ?? manifest.title}</h1>
          <p className="muted">{manifest.description}</p>
        </div>
        <button type="button" onClick={() => void showReport()}>
          Reconciled report
        </button>
      </div>
      {error && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="error">
          <strong>{error.message}</strong>
          {error.fields &&
            Object.entries(error.fields).map(([field, messages]) => (
              <small key={field}>
                {field}: {messages.join(", ")}
              </small>
            ))}
        </div>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {report && (
        <section className="panel" aria-labelledby="canonical-report">
          <h2 id="canonical-report">Current-state reconciliation</h2>
          <p className="muted">
            Select a status metric to filter the scoped work queue below.
          </p>
          <div
            className="ui-metric-grid"
            aria-label="Reconciliation status filters"
          >
            {report.map((row) => (
              <MetricCard
                key={row.state}
                label={row.state.replaceAll("_", " ")}
                value={row.count}
                help="Filter matching records"
                selected={reportState === row.state}
                onClick={() => {
                  setPage(1);
                  setReportState((current) =>
                    current === row.state ? "" : row.state,
                  );
                }}
              />
            ))}
          </div>
          {reportState && (
            <FilterChip
              label={`Status: ${reportState.replaceAll("_", " ")}`}
              onRemove={() => {
                setPage(1);
                setReportState("");
              }}
            />
          )}
          <p role="status" aria-live="polite">
            {reportState
              ? `${total} ${reportState.replaceAll("_", " ").toLowerCase()} records selected.`
              : `${total} records in the current authorized queue.`}
          </p>
        </section>
      )}
      {!portal && manifest.fields.length > 0 && (
        <section className="panel" aria-labelledby="canonical-create">
          <h2 id="canonical-create">Create {manifest.singular}</h2>
          <form
            className="access-form"
            noValidate
            onSubmit={(event) => void create(event)}
          >
            {manifest.fields.map((field) => (
              <SmartField
                key={field.key}
                field={field}
                value={values[field.key] ?? ""}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.key]: value }))
                }
              />
            ))}
            <FormSubmitResult error={error} success={notice}>
              <button className="primary" type="submit">
                Create {manifest.singular}
              </button>
            </FormSubmitResult>
          </form>
        </section>
      )}
      {!portal && manifest.resource === "vendor-bills" && (
        <section className="panel">
          <h2>Create validated vendor bill</h2>
          <form
            className="access-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runCommand(
                "vendor-bills",
                {
                  vendorId: values.vendorId,
                  vendorInvoiceNo: values.vendorInvoiceNo,
                  invoiceDate: values.invoiceDate,
                  gstMinor: values.gstMinor || "0",
                  tdsMinor: values.tdsMinor || "0",
                  deductionMinor: values.deductionMinor || "0",
                  advanceMinor: values.advanceMinor || "0",
                  lines: [
                    {
                      tripId: values.tripId,
                      claimedMinor: values.claimedMinor,
                    },
                  ],
                },
                [
                  "vendorId",
                  "vendorInvoiceNo",
                  "invoiceDate",
                  "tripId",
                  "claimedMinor",
                  "gstMinor",
                  "tdsMinor",
                  "deductionMinor",
                  "advanceMinor",
                ],
              );
            }}
          >
            <CommandReference
              fieldKey="vendorId"
              label="Vendor"
              resource="vendors"
              value={values.vendorId ?? ""}
              onChange={(value) => setValues({ ...values, vendorId: value })}
            />
            <label>
              Vendor invoice number
              <input
                required
                value={values.vendorInvoiceNo ?? ""}
                onChange={(e) =>
                  setValues({ ...values, vendorInvoiceNo: e.target.value })
                }
              />
            </label>
            <label>
              Invoice date
              <input
                required
                type="date"
                value={values.invoiceDate ?? ""}
                onChange={(e) =>
                  setValues({ ...values, invoiceDate: e.target.value })
                }
              />
            </label>
            <CommandReference
              fieldKey="tripId"
              label="Delivered trip"
              resource="trips"
              value={values.tripId ?? ""}
              onChange={(value) => setValues({ ...values, tripId: value })}
            />
            <label>
              Claimed amount (minor)
              <input
                required
                type="number"
                min="0"
                value={values.claimedMinor ?? ""}
                onChange={(e) =>
                  setValues({ ...values, claimedMinor: e.target.value })
                }
              />
            </label>
            <label>
              GST (minor)
              <input
                required
                type="number"
                min="0"
                value={values.gstMinor ?? "0"}
                onChange={(e) =>
                  setValues({ ...values, gstMinor: e.target.value })
                }
              />
            </label>
            <label>
              TDS (minor)
              <input
                required
                type="number"
                min="0"
                value={values.tdsMinor ?? "0"}
                onChange={(e) =>
                  setValues({ ...values, tdsMinor: e.target.value })
                }
              />
            </label>
            <FormSubmitResult error={error} success={notice}>
              <button className="primary">Validate and create</button>
            </FormSubmitResult>
          </form>
        </section>
      )}
      {!portal && manifest.resource === "vendor-bills" && (
        <section className="panel">
          <h2>Create payment batch</h2>
          <form
            className="access-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runCommand(
                "payment-batches",
                {
                  batchNo: values.batchNo,
                  bankVersionId: values.bankVersionId,
                  allocations: [
                    {
                      vendorBillId: values.paymentBillId,
                      amountMinor: values.paymentAmount,
                    },
                  ],
                },
                ["batchNo", "bankVersionId", "paymentBillId", "paymentAmount"],
              );
            }}
          >
            <label>
              Batch number
              <input
                required
                value={values.batchNo ?? ""}
                onChange={(event) =>
                  setValues({ ...values, batchNo: event.target.value })
                }
              />
            </label>
            <label>
              Verified bank account
              <select
                required
                value={values.bankVersionId ?? ""}
                onChange={(event) =>
                  setValues({ ...values, bankVersionId: event.target.value })
                }
              >
                <option value="">Select a verified bank account…</option>
                {banks
                  .filter((bank) => bank.state === "VERIFIED")
                  .map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {String(bank.accountHolder)} · ••••
                      {String(bank.accountLast4)}
                    </option>
                  ))}
              </select>
              <small>
                Only bank versions verified by a different authorized user are
                available.
              </small>
            </label>
            <label>
              Approved vendor bill
              <select
                required
                value={values.paymentBillId ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentBillId: event.target.value })
                }
              >
                <option value="">Select an approved bill…</option>
                {items
                  .filter((item) =>
                    ["APPROVED", "POSTED"].includes(stateOf(item)),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {titleOf(item)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Amount (minor)
              <input
                required
                type="number"
                min="1"
                value={values.paymentAmount ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentAmount: event.target.value })
                }
              />
            </label>
            <FormSubmitResult error={error} success={notice}>
              <button className="primary">Create payment batch</button>
            </FormSubmitResult>
          </form>
          <form
            className="access-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runCommand(
                `payment-batches/${values.existingBatchId}/transition`,
                {
                  action: values.paymentAction,
                  expectedVersion: Number(values.paymentVersion),
                  utr: values.utr || undefined,
                  reason: values.paymentReason || undefined,
                },
              );
            }}
          >
            <h3>Payment lifecycle</h3>
            <CommandReference
              fieldKey="existingBatchId"
              label="Payment batch"
              resource="commands/payment-batches"
              value={values.existingBatchId ?? ""}
              onChange={(value) =>
                setValues({ ...values, existingBatchId: value })
              }
            />
            <label>
              Current version
              <small>
                Shown on the selected payment batch. It prevents overwriting a
                newer change.
              </small>
              <input
                required
                type="number"
                min="1"
                value={values.paymentVersion ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentVersion: event.target.value })
                }
              />
            </label>
            <label>
              Action
              <select
                required
                value={values.paymentAction ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentAction: event.target.value })
                }
              >
                <option value="">Select…</option>
                <option>APPROVE</option>
                <option>SUBMIT</option>
                <option>MARK_PAID</option>
                <option>FAIL</option>
                <option>REVERSE</option>
              </select>
            </label>
            <label>
              UTR
              <input
                value={values.utr ?? ""}
                onChange={(event) =>
                  setValues({ ...values, utr: event.target.value })
                }
              />
            </label>
            <label>
              Reason
              <input
                value={values.paymentReason ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentReason: event.target.value })
                }
              />
            </label>
            <button>Apply payment action</button>
          </form>
        </section>
      )}
      <section
        className="panel"
        aria-busy={loading}
        aria-labelledby="canonical-queue"
      >
        <div className="panel-title">
          <h2 id="canonical-queue">Scoped work queue</h2>
          <span className="count">{total}</span>
        </div>
        {loading ? (
          <p role="status">Loading queue…</p>
        ) : items.length === 0 ? (
          <p className="empty">No permitted records.</p>
        ) : (
          <div className="responsive-list">
            {items.map((row) => (
              <article className="access-card" key={row.id}>
                <h3>{titleOf(row)}</h3>
                <dl>
                  <div>
                    <dt>State</dt>
                    <dd>{stateOf(row)}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{row.version}</dd>
                  </div>
                </dl>
                <button type="button" onClick={() => void open(row)}>
                  View details
                </button>
              </article>
            ))}
          </div>
        )}
        {total > 50 && (
          <nav className="pagination" aria-label="Canonical queue pages">
            <span>
              Page {page} · showing {items.length} of {total}
            </span>
            <div className="actions">
              <button
                type="button"
                disabled={page === 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page * 50 >= total || loading}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </nav>
        )}
      </section>
      {selected && (
        <Modal titleId="canonical-detail" onClose={() => setSelected(null)}>
          <div className="panel-title">
            <h2 id="canonical-detail">{titleOf(selected)}</h2>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <DetailList
            value={selected}
            omit={["tenant_id"]}
            locale={tenantFormat.locale}
            timezone={tenantFormat.timezone}
          />
          {(manifest.transitions[stateOf(selected)] ?? []).length > 0 && (
            <div className="access-form">
              <label htmlFor="transition-reason">
                Reason
                <input
                  id="transition-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="actions">
                {manifest.transitions[stateOf(selected)]?.map((state) => (
                  <button
                    type="button"
                    key={state}
                    onClick={() => void transition(state)}
                  >
                    {state.replaceAll("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {manifest.resource === "organization-nodes" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand(`organization/${selected.id}/move`, {
                  parentId: command.parentId || null,
                  expectedVersion: selected.version,
                  reason: command.reason,
                });
              }}
            >
              <h3>Move hierarchy node</h3>
              <CommandReference
                fieldKey="parentId"
                label="New parent node"
                resource="organization-nodes"
                required={false}
                help="Optional. Leave empty to move the node to the top level."
                value={command.parentId ?? ""}
                onChange={(value) =>
                  setCommand({ ...command, parentId: value })
                }
              />
              <label>
                Reason
                <input
                  required
                  minLength={5}
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button>Move node</button>
            </form>
          )}
          {manifest.resource === "employees" &&
            stateOf(selected) === "ACTIVE" && (
              <form
                className="access-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runCommand(
                    `employees/${selected.id}/reassign-deactivate`,
                    {
                      replacementEmployeeId: command.replacementEmployeeId,
                      expectedVersion: selected.version,
                      reason: command.reason,
                    },
                  );
                }}
              >
                <h3>Reassign and deactivate</h3>
                <CommandReference
                  fieldKey="replacementEmployeeId"
                  label="Replacement employee"
                  resource="employees"
                  value={command.replacementEmployeeId ?? ""}
                  onChange={(value) =>
                    setCommand({ ...command, replacementEmployeeId: value })
                  }
                />
                <label>
                  Reason
                  <input
                    required
                    minLength={5}
                    value={command.reason ?? ""}
                    onChange={(e) =>
                      setCommand({ ...command, reason: e.target.value })
                    }
                  />
                </label>
                <button>Reassign responsibilities</button>
              </form>
            )}
          {manifest.resource === "employees" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand("assignments/bulk", {
                  items: [
                    {
                      employeeId: selected.id,
                      assignmentType: command.assignmentType,
                      organizationNodeId:
                        command.organizationNodeId || undefined,
                      clientId: command.clientId || undefined,
                      effectiveFrom: new Date(
                        command.effectiveFrom!,
                      ).toISOString(),
                      exceptionReason: command.reason || undefined,
                    },
                  ],
                });
              }}
            >
              <h3>Add operational assignment</h3>
              <label>
                Assignment type
                <select
                  required
                  value={command.assignmentType ?? ""}
                  onChange={(event) =>
                    setCommand({
                      ...command,
                      assignmentType: event.target.value,
                    })
                  }
                >
                  <option value="">Select…</option>
                  <option>MANAGER</option>
                  <option>KAM</option>
                  <option>TRAFFIC</option>
                  <option>QUEUE_OWNER</option>
                </select>
              </label>
              <CommandReference
                fieldKey="organizationNodeId"
                label="Organization node"
                resource="organization-nodes"
                required={false}
                help="Optional unless the assignment is organization-scoped."
                value={command.organizationNodeId ?? ""}
                onChange={(value) =>
                  setCommand({ ...command, organizationNodeId: value })
                }
              />
              <CommandReference
                fieldKey="clientId"
                label="Client"
                resource="clients"
                required={false}
                help="Optional unless the assignment is client-scoped."
                value={command.clientId ?? ""}
                onChange={(value) =>
                  setCommand({ ...command, clientId: value })
                }
              />
              <label>
                Effective from
                <input
                  required
                  type="datetime-local"
                  value={command.effectiveFrom ?? ""}
                  onChange={(event) =>
                    setCommand({
                      ...command,
                      effectiveFrom: event.target.value,
                    })
                  }
                />
              </label>
              <button>Add assignment</button>
            </form>
          )}
          {manifest.resource === "contracts" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand(`contracts/${selected.id}/versions`, {
                  expectedVersion: selected.version,
                  creditDays: Number(command.creditDays),
                  podMode: command.podMode,
                  documentRequirements: commaList(command.documents || ""),
                  terms: keyValues(command.terms || ""),
                  reason: command.reason,
                });
              }}
            >
              <h3>Create contract version</h3>
              <label>
                Credit days
                <input
                  required
                  type="number"
                  value={command.creditDays ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, creditDays: e.target.value })
                  }
                />
              </label>
              <label>
                POD mode
                <select
                  required
                  value={command.podMode ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, podMode: e.target.value })
                  }
                >
                  <option value="">Select…</option>
                  <option>PHYSICAL</option>
                  <option>DIGITAL</option>
                  <option>BOTH</option>
                </select>
              </label>
              <label>
                Document requirements (Optional)
                <textarea
                  placeholder="POD, invoice copy, e-way bill"
                  value={command.documents ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, documents: e.target.value })
                  }
                />
              </label>
              <label>
                Terms (Optional)
                <textarea
                  placeholder="detentionHours=4, fuelSurcharge=true"
                  value={command.terms ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, terms: e.target.value })
                  }
                />
              </label>
              <label>
                Change reason
                <input
                  required
                  minLength={5}
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button>Create next version</button>
            </form>
          )}
          {manifest.resource === "vendors" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand(`vendors/${selected.id}/banks`, {
                  accountHolder: command.accountHolder,
                  accountNumber: command.accountNumber,
                  ifsc: command.ifsc,
                });
              }}
            >
              <h3>Add protected bank version</h3>
              <label>
                Account holder
                <input
                  required
                  value={command.accountHolder ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, accountHolder: e.target.value })
                  }
                />
              </label>
              <label>
                Account number
                <input
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  value={command.accountNumber ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, accountNumber: e.target.value })
                  }
                />
              </label>
              <label>
                IFSC
                <input
                  required
                  value={command.ifsc ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, ifsc: e.target.value })
                  }
                />
              </label>
              <button>Submit for verification</button>
            </form>
          )}
          {manifest.resource === "vendors" && banks.length > 0 && (
            <div className="access-form">
              <h3>Bank verification</h3>
              {banks.map((bank) => (
                <article className="access-card" key={bank.id}>
                  <strong>
                    {String(bank.accountHolder)} ·••••{" "}
                    {String(bank.accountLast4)}
                  </strong>
                  <span>
                    {String(bank.ifsc)} · {String(bank.state)}
                  </span>
                  {bank.state === "PENDING_VERIFICATION" && (
                    <div className="actions">
                      <button
                        type="button"
                        onClick={() =>
                          void runCommand(`vendor-banks/${bank.id}/decision`, {
                            expectedState: "PENDING_VERIFICATION",
                            decision: "VERIFIED",
                            reason: "Bank evidence independently verified",
                          })
                        }
                      >
                        Verify
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runCommand(`vendor-banks/${bank.id}/decision`, {
                            expectedState: "PENDING_VERIFICATION",
                            decision: "REJECTED",
                            reason: "Bank evidence rejected by checker",
                          })
                        }
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {manifest.resource === "indents" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand(`indents/${selected.id}/cancel`, {
                  cancelledVehicles: Number(command.quantity),
                  vendorCostMinor: command.cost || "0",
                  expectedVersion: selected.version,
                  reason: command.reason,
                });
              }}
            >
              <h3>Cancel remaining demand</h3>
              <label>
                Vehicles
                <input
                  required
                  type="number"
                  min="1"
                  value={command.quantity ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, quantity: e.target.value })
                  }
                />
              </label>
              <label>
                Vendor cost (minor units)
                <input
                  type="number"
                  min="0"
                  value={command.cost ?? "0"}
                  onChange={(e) =>
                    setCommand({ ...command, cost: e.target.value })
                  }
                />
              </label>
              <label>
                Reason
                <input
                  required
                  minLength={5}
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button>Cancel demand</button>
            </form>
          )}
          {manifest.resource === "allocations" &&
            stateOf(selected) === "OFFERED" && (
              <div className="access-form">
                <h3>Vendor offer response</h3>
                <label>
                  Reason
                  <input
                    value={command.reason ?? ""}
                    onChange={(e) =>
                      setCommand({ ...command, reason: e.target.value })
                    }
                  />
                </label>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() =>
                      void runCommand(`allocations/${selected.id}/respond`, {
                        decision: "ACCEPTED",
                        expectedVersion: selected.version,
                      })
                    }
                  >
                    Accept offer
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runCommand(`allocations/${selected.id}/respond`, {
                        decision: "REJECTED",
                        expectedVersion: selected.version,
                        reason: command.reason,
                      })
                    }
                  >
                    Reject offer
                  </button>
                </div>
              </div>
            )}
          {manifest.resource === "allocations" &&
            ["ACCEPTED", "VEHICLE_ASSIGNED", "NTP_RELEASED"].includes(
              stateOf(selected),
            ) && (
              <form
                className="access-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void api(`/domain/allocations/${selected.id}/assign`, {
                    method: "POST",
                    headers: { "Idempotency-Key": crypto.randomUUID() },
                    body: JSON.stringify({
                      vehicleId: command.vehicleId,
                      driverId: command.driverId,
                      reason: command.reason || undefined,
                    }),
                  })
                    .then(() => {
                      setNotice("Eligible vehicle and driver assigned.");
                      return load();
                    })
                    .catch((value) => setError(value as ApiError));
                }}
              >
                <h3>Assign or replace vehicle and driver</h3>
                <CommandReference
                  fieldKey="vehicleId"
                  label="Vehicle"
                  resource="vehicles"
                  value={command.vehicleId ?? ""}
                  onChange={(value) =>
                    setCommand({ ...command, vehicleId: value })
                  }
                />
                <CommandReference
                  fieldKey="driverId"
                  label="Driver"
                  resource="drivers"
                  value={command.driverId ?? ""}
                  onChange={(value) =>
                    setCommand({ ...command, driverId: value })
                  }
                />
                <label>
                  Replacement reason (Optional)
                  <input
                    value={command.reason ?? ""}
                    onChange={(e) =>
                      setCommand({ ...command, reason: e.target.value })
                    }
                  />
                </label>
                <button>Check eligibility and assign</button>
              </form>
            )}
          {manifest.resource === "trips" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void api(`/domain/trips/${selected.id}/events`, {
                  method: "POST",
                  headers: { "Idempotency-Key": crypto.randomUUID() },
                  body: JSON.stringify({
                    eventKey: crypto.randomUUID(),
                    eventType: command.eventType,
                    source: "WEB",
                    deviceAt: new Date().toISOString(),
                    evidence: { note: command.reason },
                  }),
                })
                  .then(() => {
                    setNotice("Immutable trip event recorded.");
                    return load();
                  })
                  .catch((value) => setError(value as ApiError));
              }}
            >
              <h3>Record trip milestone</h3>
              <label>
                Milestone
                <select
                  required
                  value={command.eventType ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, eventType: e.target.value })
                  }
                >
                  <option value="">Select…</option>
                  <option>AT_ORIGIN</option>
                  <option>LOADED</option>
                  <option>DEPARTED</option>
                  <option>AT_DESTINATION</option>
                  <option>DELIVERED</option>
                </select>
              </label>
              <label>
                Evidence note (Optional)
                <input
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button>Append milestone</button>
            </form>
          )}
          {manifest.resource === "pod-tasks" && (
            <div className="access-form">
              <h3>POD review</h3>
              <label>
                Reason / discrepancy
                <input
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <div className="actions">
                {[
                  "RECEIVE",
                  "START_REVIEW",
                  "ACCEPT",
                  "REQUEST_CORRECTION",
                  "SUBMIT",
                ].map((action) => (
                  <button
                    type="button"
                    key={action}
                    onClick={() =>
                      void runCommand(`pod/${selected.id}/review`, {
                        action,
                        expectedVersion: selected.version,
                        reason: command.reason || undefined,
                      })
                    }
                  >
                    {action.replaceAll("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {manifest.resource === "invoices" && (
            <div className="access-form">
              <h3>Invoice collection actions</h3>
              <label>
                Acknowledged at
                <input
                  type="datetime-local"
                  value={command.acknowledgedAt ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, acknowledgedAt: e.target.value })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  void runCommand(`invoices/${selected.id}/acknowledge`, {
                    expectedVersion: selected.version,
                    acknowledgedAt: new Date(
                      command.acknowledgedAt!,
                    ).toISOString(),
                    evidence: { channel: "UI" },
                  })
                }
              >
                Record acknowledgement
              </button>
              <label>
                Follow-up note
                <textarea
                  value={command.note ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, note: e.target.value })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  void runCommand(`invoices/${selected.id}/followups`, {
                    outcome: "CONTACTED",
                    note: command.note,
                  })
                }
              >
                Add follow-up
              </button>
              <label>
                Reversal invoice number
                <input
                  value={command.reversalInvoiceNo ?? ""}
                  onChange={(e) =>
                    setCommand({
                      ...command,
                      reversalInvoiceNo: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Reversal reason
                <input
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  void runCommand(`invoices/${selected.id}/reverse`, {
                    expectedVersion: selected.version,
                    reversalInvoiceNo: command.reversalInvoiceNo,
                    reason: command.reason,
                  })
                }
              >
                Create compensating reversal
              </button>
            </div>
          )}
          {manifest.resource === "receipts" && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void api(`/domain/receipts/${selected.id}/allocations`, {
                  method: "POST",
                  headers: { "Idempotency-Key": crypto.randomUUID() },
                  body: JSON.stringify({
                    invoiceId: command.invoiceId || undefined,
                    entryType: command.entryType,
                    amountMinor: command.amountMinor,
                    reason: command.reason || undefined,
                  }),
                })
                  .then(() => {
                    setNotice("Receipt ledger entry appended.");
                    return load();
                  })
                  .catch((value) => setError(value as ApiError));
              }}
            >
              <h3>Allocate receipt</h3>
              <CommandReference
                fieldKey="invoiceId"
                label="Invoice"
                resource="invoices"
                required={false}
                help="Optional for deductions or on-account receipts."
                value={command.invoiceId ?? ""}
                onChange={(value) =>
                  setCommand({ ...command, invoiceId: value })
                }
              />
              <label>
                Entry type
                <select
                  required
                  value={command.entryType ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, entryType: e.target.value })
                  }
                >
                  <option value="">Select…</option>
                  <option>ALLOCATION</option>
                  <option>DEDUCTION</option>
                  <option>ON_ACCOUNT</option>
                </select>
              </label>
              <label>
                Amount (minor)
                <input
                  required
                  type="number"
                  min="1"
                  value={command.amountMinor ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, amountMinor: e.target.value })
                  }
                />
              </label>
              <label>
                Reason (Optional)
                <input
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <button>Append allocation</button>
            </form>
          )}
          {["vendors", "vehicles", "drivers"].includes(manifest.resource) && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand("compliance", {
                  subjectType:
                    manifest.resource === "vendors"
                      ? "VENDOR"
                      : manifest.resource === "vehicles"
                        ? "VEHICLE"
                        : "DRIVER",
                  subjectId: selected.id,
                  requirementCode: command.requirementCode,
                  documentId: command.documentId || undefined,
                  validFrom: command.validFrom || undefined,
                  validTo: command.validTo || undefined,
                });
              }}
            >
              <h3>Compliance evidence</h3>
              <label>
                Requirement code
                <input
                  required
                  value={command.requirementCode ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, requirementCode: e.target.value })
                  }
                />
              </label>
              <CommandReference
                fieldKey="documentId"
                label="Governed document"
                resource="governance/documents"
                required={false}
                help="Optional. Attach governed evidence, or leave empty when no document is required."
                value={command.documentId ?? ""}
                onChange={(value) =>
                  setCommand({ ...command, documentId: value })
                }
              />
              <label>
                Valid from (Optional)
                <input
                  type="date"
                  value={command.validFrom ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, validFrom: e.target.value })
                  }
                />
              </label>
              <label>
                Valid to (Optional)
                <input
                  type="date"
                  value={command.validTo ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, validTo: e.target.value })
                  }
                />
              </label>
              <button>Submit compliance</button>
            </form>
          )}
          {compliance.length > 0 && (
            <div className="responsive-list">
              {compliance.map((record) => (
                <article className="access-card" key={record.id}>
                  <h3>{String(record.requirementCode)}</h3>
                  <p>
                    {String(record.state)} · valid to{" "}
                    {String(record.validTo ?? "—")}
                  </p>
                  {record.state === "PENDING" && (
                    <div className="actions">
                      <button
                        type="button"
                        onClick={() =>
                          void runCommand(`compliance/${record.id}/decision`, {
                            decision: "VERIFIED",
                            reason: "Evidence independently verified",
                          })
                        }
                      >
                        Verify
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runCommand(`compliance/${record.id}/decision`, {
                            decision: "REJECTED",
                            reason: "Evidence rejected by checker",
                          })
                        }
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {manifest.resource === "vendor-bills" && (
            <div className="access-form">
              <h3>Maker-checker decision</h3>
              <label>
                Reason
                <input
                  value={command.reason ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, reason: e.target.value })
                  }
                />
              </label>
              <div className="actions">
                {["VERIFY", "APPROVE", "DISPUTE"].map((action) => (
                  <button
                    type="button"
                    key={action}
                    onClick={() =>
                      void runCommand(`vendor-bills/${selected.id}/decision`, {
                        action,
                        expectedVersion: selected.version,
                        reason: command.reason || undefined,
                      })
                    }
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </Shell>
  );
}
