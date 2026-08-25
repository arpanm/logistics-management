"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
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
  if (field.kind === "json") return JSON.parse(value);
  if (field.kind === "datetime-local") return new Date(value).toISOString();
  return value;
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
  const [items, setItems] = useState<Row[]>([]),
    [selected, setSelected] = useState<Row | null>(null),
    [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [report, setReport] = useState<Array<{
      state: string;
      count: number;
    }> | null>(null),
    [reason, setReason] = useState(""),
    [banks, setBanks] = useState<Array<Row>>([]),
    [compliance, setCompliance] = useState<Array<Row>>([]);
  const [command, setCommand] = useState<Record<string, string>>({});
  const errorRef = useRef<HTMLDivElement>(null),
    base = `/domain/${manifest.resource}`;
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const result = await api<{ items: Row[] }>(base, { signal });
      setItems(result.items);
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
  }, [base]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
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
      setValues({});
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
      setSelected(await api<Row>(`${base}/${row.id}`));
      if (manifest.resource === "vendors")
        setBanks(
          await api<Array<Row>>(`/domain/commands/vendors/${row.id}/banks`),
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
  async function runCommand(path: string, body: Record<string, unknown>) {
    try {
      const changed = await api<Row>(`/domain/commands/${path}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice("Command completed and audit evidence was recorded.");
      setCommand({});
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
          <div className="stats">
            {report.map((row) => (
              <article key={row.state}>
                <strong>{row.count}</strong>
                <span>{row.state}</span>
              </article>
            ))}
          </div>
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
              <label key={field.key} htmlFor={`canonical-${field.key}`}>
                {field.label}
                {field.kind === "select" ? (
                  <select
                    id={`canonical-${field.key}`}
                    required={field.required}
                    value={values[field.key] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [field.key]: event.target.value })
                    }
                  >
                    <option value="">Select…</option>
                    {field.options?.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : field.kind === "textarea" || field.kind === "json" ? (
                  <textarea
                    id={`canonical-${field.key}`}
                    required={field.required}
                    rows={field.kind === "json" ? 5 : 3}
                    value={values[field.key] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [field.key]: event.target.value })
                    }
                  />
                ) : (
                  <input
                    id={`canonical-${field.key}`}
                    type={field.kind ?? "text"}
                    required={field.required}
                    value={values[field.key] ?? ""}
                    onChange={(event) =>
                      setValues({ ...values, [field.key]: event.target.value })
                    }
                  />
                )}
              </label>
            ))}
            <button className="primary" type="submit">
              Create {manifest.singular}
            </button>
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
              void runCommand("vendor-bills", {
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
              });
            }}
          >
            <label>
              Vendor ID
              <input
                required
                value={values.vendorId ?? ""}
                onChange={(e) =>
                  setValues({ ...values, vendorId: e.target.value })
                }
              />
            </label>
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
            <label>
              Delivered trip ID
              <input
                required
                value={values.tripId ?? ""}
                onChange={(e) =>
                  setValues({ ...values, tripId: e.target.value })
                }
              />
            </label>
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
            <button className="primary">Validate and create</button>
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
              void runCommand("payment-batches", {
                batchNo: values.batchNo,
                bankVersionId: values.bankVersionId,
                allocations: [
                  {
                    vendorBillId: values.paymentBillId,
                    amountMinor: values.paymentAmount,
                  },
                ],
              });
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
              Verified bank version ID
              <input
                required
                value={values.bankVersionId ?? ""}
                onChange={(event) =>
                  setValues({ ...values, bankVersionId: event.target.value })
                }
              />
            </label>
            <label>
              Approved vendor bill ID
              <input
                required
                value={values.paymentBillId ?? ""}
                onChange={(event) =>
                  setValues({ ...values, paymentBillId: event.target.value })
                }
              />
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
            <button className="primary">Create payment batch</button>
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
            <label>
              Batch ID
              <input
                required
                value={values.existingBatchId ?? ""}
                onChange={(event) =>
                  setValues({ ...values, existingBatchId: event.target.value })
                }
              />
            </label>
            <label>
              Current version
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
          <span className="count">{items.length}</span>
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
      </section>
      {selected && (
        <section
          className="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="canonical-detail"
        >
          <div className="panel-title">
            <h2 id="canonical-detail">{titleOf(selected)}</h2>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl className="details-grid">
            {Object.entries(selected)
              .filter(([key]) => !["tenant_id"].includes(key))
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value ?? "—")}
                  </dd>
                </div>
              ))}
          </dl>
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
              <label>
                New parent ID
                <input
                  value={command.parentId ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, parentId: e.target.value })
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
                <label>
                  Replacement employee ID
                  <input
                    required
                    value={command.replacementEmployeeId ?? ""}
                    onChange={(e) =>
                      setCommand({
                        ...command,
                        replacementEmployeeId: e.target.value,
                      })
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
              <label>
                Organization node ID
                <input
                  value={command.organizationNodeId ?? ""}
                  onChange={(event) =>
                    setCommand({
                      ...command,
                      organizationNodeId: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Client ID
                <input
                  value={command.clientId ?? ""}
                  onChange={(event) =>
                    setCommand({ ...command, clientId: event.target.value })
                  }
                />
              </label>
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
                  documentRequirements: JSON.parse(command.documents || "[]"),
                  terms: JSON.parse(command.terms || "{}"),
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
                Document requirements
                <textarea
                  value={command.documents ?? "[]"}
                  onChange={(e) =>
                    setCommand({ ...command, documents: e.target.value })
                  }
                />
              </label>
              <label>
                Terms
                <textarea
                  value={command.terms ?? "{}"}
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
                <label>
                  Vehicle ID
                  <input
                    required
                    value={command.vehicleId ?? ""}
                    onChange={(e) =>
                      setCommand({ ...command, vehicleId: e.target.value })
                    }
                  />
                </label>
                <label>
                  Driver ID
                  <input
                    required
                    value={command.driverId ?? ""}
                    onChange={(e) =>
                      setCommand({ ...command, driverId: e.target.value })
                    }
                  />
                </label>
                <label>
                  Replacement reason
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
                Evidence note
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
              <label>
                Invoice ID
                <input
                  value={command.invoiceId ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, invoiceId: e.target.value })
                  }
                />
              </label>
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
                Reason
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
              <label>
                Governed document ID
                <input
                  value={command.documentId ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, documentId: e.target.value })
                  }
                />
              </label>
              <label>
                Valid from
                <input
                  type="date"
                  value={command.validFrom ?? ""}
                  onChange={(e) =>
                    setCommand({ ...command, validFrom: e.target.value })
                  }
                />
              </label>
              <label>
                Valid to
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
        </section>
      )}
    </Shell>
  );
}
