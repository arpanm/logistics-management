"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "../../../../components/api";
import { FormSubmitResult } from "../../../../components/forms/form-submit-result";
import { Modal } from "../../../../components/modal";
import { Shell } from "../../../../components/shell";
import { DetailList } from "../../../../components/ui/primitives";
import { useTenantFormat } from "../../../../components/use-tenant-format";

export type WorkspaceField = {
  key: string;
  label: string;
  kind?: "text" | "date" | "datetime-local" | "number" | "textarea" | "select";
  required?: boolean;
  options?: readonly string[];
};

type KernelRecord = {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
  data?: Record<string, unknown>;
  updatedAt?: string;
};

export function TransactionWorkspace({
  feature,
  module,
  resource,
  title,
  description,
  fields,
  queues,
  reports,
}: {
  feature: string;
  module: string;
  resource: string;
  title: string;
  description: string;
  fields: readonly WorkspaceField[];
  queues: readonly string[];
  reports: readonly string[];
}) {
  const tenantFormat = useTenantFormat();
  const [items, setItems] = useState<KernelRecord[]>([]);
  const [selected, setSelected] = useState<KernelRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [success, setSuccess] = useState("");
  const [form, setForm] = useState<Record<string, string>>({
    code: "",
    name: "",
  });
  const endpoint = `/modules/${module}/${resource}`;

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ items: KernelRecord[] }>(endpoint);
      setItems(result.items);
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => void load(), [endpoint]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess("");
    const data = Object.fromEntries(
      fields.map((field) => [field.key, form[field.key] ?? ""]),
    );
    try {
      await api(endpoint, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ code: form.code, name: form.name, data }),
      });
      setForm({ code: "", name: "" });
      setSuccess(`${title} record created.`);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }

  const statusCounts = useMemo(
    () =>
      items.reduce<Record<string, number>>((counts, item) => {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        return counts;
      }, {}),
    [items],
  );

  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">{feature}</p>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error">
          {error.message}
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      {success && (
        <p role="status" className="success">
          {success}
        </p>
      )}
      <section className="panel" aria-labelledby={`${resource}-create`}>
        <h2 id={`${resource}-create`}>Create {title.toLowerCase()}</h2>
        <form className="access-form" onSubmit={(event) => void create(event)}>
          <label>
            Code
            <input
              required
              value={form.code ?? ""}
              onChange={(event) =>
                setForm({ ...form, code: event.target.value.toUpperCase() })
              }
            />
          </label>
          <label>
            Name
            <input
              required
              value={form.name ?? ""}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          {fields.map((field) => (
            <label key={field.key}>
              {field.label}
              {field.kind === "textarea" ? (
                <textarea
                  required={field.required}
                  value={form[field.key] ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, [field.key]: event.target.value })
                  }
                />
              ) : field.kind === "select" ? (
                <select
                  required={field.required}
                  value={form[field.key] ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, [field.key]: event.target.value })
                  }
                >
                  <option value="">Select</option>
                  {field.options?.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.kind ?? "text"}
                  required={field.required}
                  value={form[field.key] ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, [field.key]: event.target.value })
                  }
                />
              )}
            </label>
          ))}
          <FormSubmitResult error={error} success={success}>
            <button type="submit" className="primary">
              Create draft
            </button>
          </FormSubmitResult>
        </form>
      </section>
      <section className="panel" aria-busy={loading}>
        <div className="panel-title">
          <h2>Work queue</h2>
          <span className="count">{items.length}</span>
        </div>
        <p className="muted">{queues.join(" · ")}</p>
        {loading ? (
          <p role="status">Loading queue…</p>
        ) : items.length === 0 ? (
          <p className="empty">No records in this queue.</p>
        ) : (
          <div className="responsive-list">
            {items.map((item) => (
              <article className="access-card" key={item.id}>
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.code}</p>
                </div>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>{item.status}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{item.version}</dd>
                  </div>
                </dl>
                <button type="button" onClick={() => setSelected(item)}>
                  View details
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {selected && (
        <Modal titleId={`${resource}-detail`} onClose={() => setSelected(null)}>
          <div className="panel-title">
            <h2 id={`${resource}-detail`}>{selected.name}</h2>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
          <DetailList
            value={selected}
            locale={tenantFormat.locale}
            timezone={tenantFormat.timezone}
            labels={{
              code: "Reference code",
              name: "Record name",
              status: "Workflow status",
              version: "Record version",
              updatedAt: "Last updated",
            }}
          />
        </Modal>
      )}
      <section className="panel">
        <h2>Reports</h2>
        <p className="muted">{reports.join(" · ")}</p>
        <div className="responsive-list">
          {Object.entries(statusCounts).map(([status, count]) => (
            <article className="access-card" key={status}>
              <h3>{status}</h3>
              <p>{count} records</p>
            </article>
          ))}
        </div>
      </section>
    </Shell>
  );
}
