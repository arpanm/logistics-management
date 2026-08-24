"use client";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";
type Job = {
  id: string;
  dataset: string;
  filename: string;
  state: string;
  summary: Record<string, unknown>;
  createdAt: string;
  version: number;
};
const datasets = [
  "CLIENT",
  "LOCATION",
  "VENDOR",
  "INDENT_PLACEMENT",
  "POD",
  "INVOICE_COLLECTION",
  "PAYMENT_RECEIPT",
];
export default function DataImportsPage() {
  const [jobs, setJobs] = useState<Job[]>([]),
    [preview, setPreview] = useState<Job | null>(null),
    [error, setError] = useState<ApiError | null>(null),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<Job[]>("/tenant/imports/status").then(setJobs).catch(setError);
  useEffect(() => {
    void load();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget),
      file = form.get("file") as File;
    try {
      if (!file?.size)
        throw { message: "Choose a CSV file", code: "FILE_REQUIRED" };
      const content = await file.text();
      const lines = content
          .replace(/^\uFEFF/, "")
          .split(/\r?\n/)
          .filter(Boolean),
        headers = (lines.shift() ?? "").split(",").map((v) => v.trim());
      const rows = lines.map((line) =>
        Object.fromEntries(
          line
            .split(",")
            .map((value, index) => [
              headers[index] ?? `column_${index + 1}`,
              value.trim(),
            ]),
        ),
      );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(content),
      );
      const checksum = Array.from(new Uint8Array(digest), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join("");
      const result = await api<Job>("/tenant/imports/preview", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          dataset: form.get("dataset"),
          filename: file.name,
          mediaType: file.type || "text/csv",
          byteSize: file.size,
          checksum,
          sourceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          importMode: form.get("mode"),
          headers,
          rows,
        }),
      });
      setPreview(result);
      await load();
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      await api(`/tenant/imports/${preview.id}/commit`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: preview.version }),
      });
      setPreview(null);
      await load();
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">DAT-01</p>
          <h1>Data imports</h1>
          <p className="muted">
            Preview and validate the complete file before an idempotent
            PostgreSQL-backed commit.
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error.message}
        </div>
      )}
      <section className="panel">
        <h2>Preview import</h2>
        <form className="access-form" onSubmit={(e) => void submit(e)}>
          <label>
            Dataset
            <select name="dataset">
              {datasets.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Import mode
            <select name="mode">
              <option>UPSERT</option>
              <option>FULL_FILE</option>
              <option>APPEND</option>
            </select>
          </label>
          <label>
            CSV file
            <input name="file" type="file" accept=".csv,text/csv" required />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Validating…" : "Validate complete file"}
          </button>
        </form>
        {preview && (
          <div role="status">
            <h3>{preview.state}</h3>
            <pre className="safe-json">
              {JSON.stringify(preview.summary, null, 2)}
            </pre>
            {preview.state === "VALIDATED" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void commit()}
              >
                Commit import
              </button>
            )}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Import history</h2>
        {jobs.length ? (
          <div className="responsive-list">
            {jobs.map((job) => (
              <article className="access-card" key={job.id}>
                <div>
                  <h3>{job.filename}</h3>
                  <p>
                    {job.dataset} · {job.state}
                  </p>
                  <small>{new Date(job.createdAt).toLocaleString()}</small>
                </div>
                <pre className="safe-json">
                  {JSON.stringify(job.summary, null, 2)}
                </pre>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No imports yet.</p>
        )}
      </section>
    </Shell>
  );
}
