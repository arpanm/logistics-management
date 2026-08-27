"use client";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";
import { FormSubmitResult } from "../../../components/forms/form-submit-result";
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
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dataset, setDataset] = useState("CLIENT");
  const load = () =>
    api<Job[]>("/tenant/imports/status").then(setJobs).catch(setError);
  useEffect(() => {
    void load();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice("");
    const formElement = event.currentTarget;
    const feedbackAnchor = formElement.querySelector<HTMLElement>(
      'button[type="submit"], button:not([type])',
    );
    const form = new FormData(formElement),
      file = form.get("file") as File;
    try {
      if (!file?.size)
        throw { message: "Choose a CSV file", code: "FILE_REQUIRED" };
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768),
        );
      const parsed = await api<{
        headers: string[];
        rows: Array<Record<string, unknown>>;
        byteSize: number;
        checksum: string;
      }>("/tenant/imports/parse", {
        method: "POST",
        // Parsing is an internal step; the preview mutation below owns the
        // user-visible result for this one submit action.
        feedbackAnchor: null,
        body: JSON.stringify({
          filename: file.name,
          mediaType: file.type || "text/csv",
          contentBase64: btoa(binary),
        }),
      });
      const result = await api<Job>("/tenant/imports/preview", {
        method: "POST",
        feedbackAnchor,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          dataset: form.get("dataset"),
          filename: file.name,
          mediaType: file.type || "text/csv",
          byteSize: parsed.byteSize,
          checksum: parsed.checksum,
          sourceTimezone: form.get("sourceTimezone"),
          importMode: form.get("mode"),
          headers: parsed.headers,
          rows: parsed.rows,
        }),
      });
      setPreview(result);
      formElement.reset();
      setNotice("File validated. Review the preview before committing it.");
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
    setError(null);
    setNotice("");
    try {
      await api(`/tenant/imports/${preview.id}/commit`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: preview.version }),
      });
      setPreview(null);
      setNotice("Import committed successfully.");
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
            <select
              name="dataset"
              value={dataset}
              onChange={(event) => setDataset(event.target.value)}
            >
              {datasets.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <div className="field-help">
            <strong>Sample files for {dataset}</strong>
            <span>
              Use the exact headers and formats shown in these examples.
            </span>
            <div className="button-row">
              <a
                className="button"
                href={`/api/v1/tenant/imports/templates/${dataset}?format=csv`}
                download
              >
                Download sample CSV
              </a>
              <a
                className="button"
                href={`/api/v1/tenant/imports/templates/${dataset}?format=xlsx`}
                download
              >
                Download sample Excel
              </a>
            </div>
          </div>
          <label>
            Import mode
            <select name="mode">
              <option>UPSERT</option>
              <option>FULL_FILE</option>
              <option>APPEND</option>
            </select>
          </label>
          <label>
            Source timezone
            <select name="sourceTimezone" defaultValue="Asia/Kolkata">
              <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
              <option value="Asia/Dhaka">Asia/Dhaka</option>
              <option value="Asia/Dubai">Asia/Dubai</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <label>
            CSV or XLSX file
            <input
              name="file"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
            />
          </label>
          <FormSubmitResult error={error} success={notice} busy={busy}>
            <button className="primary" disabled={busy}>
              {busy ? "Validating…" : "Validate complete file"}
            </button>
          </FormSubmitResult>
        </form>
        {preview && (
          <div role="status">
            <h3>{preview.state}</h3>
            <pre className="safe-json">
              {JSON.stringify(preview.summary, null, 2)}
            </pre>
            {preview.state === "VALIDATED" && (
              <FormSubmitResult error={error} success={notice} busy={busy}>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void commit()}
                >
                  Commit import
                </button>
              </FormSubmitResult>
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
