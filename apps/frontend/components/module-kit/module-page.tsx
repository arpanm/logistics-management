"use client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "../api";
import { FormSubmitResult } from "../forms/form-submit-result";
import { Modal } from "../modal";
import { Shell } from "../shell";
import { DetailList } from "../ui/primitives";
import { useTenantFormat } from "../use-tenant-format";
import type { UiField, UiManifest } from "./manifests";

type RecordRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  data: Record<string, unknown>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  version: number;
  snapshots?: Array<{ id: string; snapshotNo: number; capturedAt: string }>;
  events?: Array<{
    id: string;
    fromStatus?: string;
    toStatus: string;
    reason?: string;
    occurredAt: string;
  }>;
  comments?: Array<{ id: string; body: string; createdAt: string }>;
  documents?: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: string;
  }>;
};
type ListResult = {
  items: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
};
const empty = (manifest: UiManifest) =>
  Object.fromEntries(
    manifest.fields.map((field) => [
      field.key,
      field.kind === "timezone" ? "Asia/Kolkata" : "",
    ]),
  );

function Field({
  field,
  value,
  onChange,
}: {
  field: UiField;
  value: string;
  onChange: (value: string) => void;
}) {
  const common = {
    id: `field-${field.key}`,
    name: field.key,
    required: field.required,
    value,
    onChange: (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => onChange(event.target.value),
  };
  return (
    <label htmlFor={common.id}>
      {field.label}
      {field.required ? "" : " (Optional)"}
      {field.help && <small>{field.help}</small>}
      {field.kind === "select" ? (
        <select {...common}>
          <option value="">Select…</option>
          {field.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : field.kind === "timezone" ? (
        <select {...common}>
          <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
          <option value="Asia/Dhaka">Asia/Dhaka</option>
          <option value="Asia/Dubai">Asia/Dubai</option>
          <option value="Asia/Singapore">Asia/Singapore</option>
          <option value="UTC">UTC</option>
        </select>
      ) : field.kind === "textarea" || field.kind === "key-value" ? (
        <textarea
          {...common}
          rows={3}
          placeholder={
            field.kind === "key-value"
              ? "key=value, anotherKey=value"
              : undefined
          }
        />
      ) : (
        <input
          {...common}
          type={field.kind === "mobile" ? "tel" : field.kind}
        />
      )}
    </label>
  );
}

export function ModulePage({ manifest }: { manifest: UiManifest }) {
  const tenantFormat = useTenantFormat();
  const base = `/modules/${manifest.module}/${manifest.resource}`;
  const [items, setItems] = useState<RecordRow[]>([]),
    [selected, setSelected] = useState<RecordRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    empty(manifest),
  );
  const [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState("");
  const [report, setReport] = useState<Array<{
    status: string;
    count: number;
  }> | null>(null);
  const [editName, setEditName] = useState(""),
    [reason, setReason] = useState(""),
    [comment, setComment] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const transitions = useMemo(
    () =>
      manifest.transitions.filter(
        (item) => selected && item.from.includes(selected.status),
      ),
    [manifest, selected],
  );
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const result = await api<ListResult>(
        `${base}?search=${encodeURIComponent(search)}`,
        { signal },
      );
      setItems(result.items);
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
  function dataFromForm() {
    return Object.fromEntries(
      manifest.fields
        .filter((field) => values[field.key] !== "")
        .map((field) => {
          const value = values[field.key]!;
          if (field.kind === "number") return [field.key, Number(value)];
          if (field.kind === "key-value")
            return [
              field.key,
              Object.fromEntries(
                value.split(",").map((entry) => {
                  const [key, ...rest] = entry.split("=");
                  if (!key?.trim() || !rest.length)
                    throw new SyntaxError("Use key=value for every setting.");
                  return [key.trim(), rest.join("=").trim()];
                }),
              ),
            ];
          return [field.key, value];
        }),
    );
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice("");
    try {
      await api(base, {
        method: "POST",
        body: JSON.stringify({
          code,
          name,
          data: dataFromForm(),
          effectiveFrom: values.effectiveFrom || null,
          effectiveTo: values.effectiveTo || null,
        }),
      });
      setCode("");
      setName("");
      setValues(empty(manifest));
      setNotice(`${manifest.singular} created.`);
      await load();
    } catch (value) {
      setError(
        value instanceof SyntaxError
          ? {
              code: "INVALID_JSON",
              message: "Enter every structured setting as key=value.",
            }
          : (value as ApiError),
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }
  async function open(row: RecordRow) {
    try {
      const detail = await api<RecordRow>(`${base}/${row.id}`);
      setSelected(detail);
      setEditName(detail.name);
      setReason("");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function save() {
    if (!selected) return;
    try {
      const row = await api<RecordRow>(`${base}/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          expectedVersion: selected.version,
        }),
      });
      setNotice("Changes saved.");
      await open(row);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function transition(toStatus: string) {
    if (!selected) return;
    try {
      const row = await api<RecordRow>(`${base}/${selected.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          toStatus,
          expectedVersion: selected.version,
          reason: reason || undefined,
        }),
      });
      setNotice(`Status changed to ${toStatus}.`);
      await open(row);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function addComment(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      await api(`${base}/${selected.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      });
      setComment("");
      await open(selected);
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function showReport() {
    try {
      const value = await api<{
        rows: Array<{ status: string; count: number }>;
      }>(`${base}/report`);
      setReport(value.rows);
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">{manifest.feature}</p>
          <h1>{manifest.plural}</h1>
          <p className="muted">{manifest.description}</p>
        </div>
        <button type="button" onClick={() => void showReport()}>
          Status report
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
        <section className="panel" aria-labelledby="report-heading">
          <h2 id="report-heading">Status report</h2>
          <div className="stats">
            {report.map((row) => (
              <article key={row.status}>
                <strong>{row.count}</strong>
                <span>{row.status}</span>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="panel" aria-labelledby="create-heading">
        <h2 id="create-heading">Create {manifest.singular.toLowerCase()}</h2>
        <form
          className="access-form"
          noValidate
          onSubmit={(event) => void create(event)}
        >
          <label htmlFor="record-code">
            Code
            <input
              id="record-code"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9_-]+"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </label>
          <label htmlFor="record-name">
            Name
            <input
              id="record-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {manifest.fields.map((field) => (
            <Field
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
              Create {manifest.singular.toLowerCase()}
            </button>
          </FormSubmitResult>
        </form>
      </section>
      <section className="panel" aria-labelledby="records-heading">
        <div className="heading">
          <h2 id="records-heading">Records</h2>
          <label htmlFor="record-search">
            Search
            <input
              id="record-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => void load()}>
            Search
          </button>
        </div>
        {loading ? (
          <p role="status">Loading records…</p>
        ) : items.length === 0 ? (
          <p className="empty">No records found.</p>
        ) : (
          <div className="card-list">
            {items.map((row) => (
              <article className="record-card" key={row.id}>
                <div>
                  <strong>{row.name}</strong>
                  <p className="muted">
                    {row.code} · {row.status}
                  </p>
                </div>
                <button type="button" onClick={() => void open(row)}>
                  View details
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {selected && (
        <Modal titleId="detail-heading" onClose={() => setSelected(null)}>
          <div className="panel-title">
            <h2 id="detail-heading">{selected.name}</h2>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <p>
            <strong>Status:</strong> {selected.status} ·{" "}
            <strong>Version:</strong> {selected.version}
          </p>
          <label htmlFor="edit-name">
            Name
            <input
              id="edit-name"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
          </label>
          <FormSubmitResult error={error} success={notice}>
            <button type="button" onClick={() => void save()}>
              Save changes
            </button>
          </FormSubmitResult>
          {transitions.length > 0 && (
            <div>
              <label htmlFor="transition-reason">
                Transition reason
                <input
                  id="transition-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="actions">
                {transitions.map((item) => (
                  <button
                    type="button"
                    key={item.to}
                    onClick={() => void transition(item.to)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <details>
            <summary>Record data</summary>
            <DetailList
              value={selected.data}
              locale={tenantFormat.locale}
              timezone={tenantFormat.timezone}
            />
          </details>
          <h3>Comments</h3>
          <form onSubmit={(event) => void addComment(event)}>
            <label htmlFor="new-comment">
              Add comment
              <textarea
                id="new-comment"
                required
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
            <FormSubmitResult error={error} success={notice}>
              <button type="submit">Post comment</button>
            </FormSubmitResult>
          </form>
          {selected.comments?.map((item) => (
            <article key={item.id}>
              <p>{item.body}</p>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </article>
          ))}
          <p className="muted">
            Snapshots: {selected.snapshots?.length ?? 0} · Workflow events:{" "}
            {selected.events?.length ?? 0} · Documents:{" "}
            {selected.documents?.length ?? 0}
          </p>
        </Modal>
      )}
    </Shell>
  );
}
