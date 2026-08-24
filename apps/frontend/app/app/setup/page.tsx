"use client";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, ApiError } from "../../../components/api";
type Context = {
  tenant: {
    id: string;
    code: string;
    name: string;
    timezone: string;
    locale: string;
    currency: string;
    shortName: string;
    primaryColor: string;
    accentColor: string;
  };
  checklist: Array<{
    key: string;
    label: string;
    state: string;
    version: number;
  }>;
  configurations: Array<{ namespace: string; value: unknown }>;
  contextVersion: number;
};
type Probe = { id: string; label: string; note: string; version: number };
export default function Setup() {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checklistBusy, setChecklistBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function load() {
    setError("");
    try {
      const [c, p] = await Promise.all([
        api<Context>("/tenant/context"),
        api<{ items: Probe[] }>("/tenant/probes"),
      ]);
      setCtx(c);
      setProbes(p.items);
    } catch (error) {
      setError((error as ApiError).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/tenant/probes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ label: f.get("label"), note: f.get("note") }),
      });
      e.currentTarget.reset();
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function updateBranding(item: Context["checklist"][number]) {
    const nextState = item.state === "COMPLETE" ? "NOT_STARTED" : "COMPLETE";
    setChecklistBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/tenant/setup/${item.key}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: item.version,
          state: nextState,
        }),
      });
      await load();
      setNotice(
        nextState === "COMPLETE"
          ? "Branding setup marked complete."
          : "Branding setup reopened.",
      );
    } catch (error) {
      setError((error as ApiError).message);
    } finally {
      setChecklistBusy(false);
    }
  }
  return (
    <Shell>
      <p className="sr-only" role="status" aria-live="polite">
        {notice}
      </p>
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      {!ctx ? (
        <p role="status">Loading your workspace…</p>
      ) : (
        <>
          <section
            className="tenant-hero"
            style={
              {
                "--tenant": ctx.tenant.primaryColor,
                "--accent": ctx.tenant.accentColor,
              } as React.CSSProperties
            }
          >
            <div className="tenant-mark">
              {ctx.tenant.shortName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="eyebrow">{ctx.tenant.code}</p>
              <h1>{ctx.tenant.name}</h1>
              <p>
                {ctx.tenant.locale} · {ctx.tenant.currency} ·{" "}
                {ctx.tenant.timezone}
              </p>
            </div>
          </section>
          <div className="grid-2">
            <section className="panel">
              <h2>Setup checklist</h2>
              <p className="muted">
                The foundation is ready. Future modules unlock the remaining
                areas.
              </p>
              <ul className="checklist">
                {ctx.checklist.map((i) => (
                  <li key={i.key}>
                    <span aria-hidden>
                      {i.state === "COMPLETE" ? "✓" : "○"}
                    </span>
                    <div>
                      <strong>{i.label}</strong>
                      <small>
                        {i.state === "COMPLETE"
                          ? "Configured"
                          : i.key === "branding"
                            ? "Ready to complete"
                            : "Available with a later feature"}
                      </small>
                    </div>
                    <span
                      className={`status ${i.state === "COMPLETE" ? "active" : ""}`}
                    >
                      {i.state.replaceAll("_", " ")}
                    </span>
                    {i.key === "branding" && (
                      <button
                        type="button"
                        disabled={checklistBusy}
                        aria-label={
                          i.state === "COMPLETE"
                            ? "Reopen branding setup"
                            : "Mark branding setup complete"
                        }
                        onClick={() => void updateBranding(i)}
                      >
                        {checklistBusy
                          ? "Updating…"
                          : i.state === "COMPLETE"
                            ? "Reopen"
                            : "Mark complete"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel isolation">
              <p className="eyebrow">Development assurance</p>
              <h2>Isolation test records</h2>
              <p className="muted">
                Simple records exercise tenant-scoped data, documents, events,
                reports and exports.
              </p>
              <form onSubmit={add}>
                <label>
                  Label
                  <input name="label" required minLength={2} />
                </label>
                <label>
                  Note
                  <textarea name="note" maxLength={2000} />
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? "Saving…" : "Add isolated record"}
                </button>
              </form>
              <div className="probe-list">
                {probes.length === 0 ? (
                  <p className="empty">No isolation records in this tenant.</p>
                ) : (
                  probes.map((p) => (
                    <article key={p.id}>
                      <strong>{p.label}</strong>
                      <p>{p.note}</p>
                      <a href={`/api/v1/tenant/probes/${p.id}/document`}>
                        Open stored document
                      </a>
                    </article>
                  ))
                )}
              </div>
              <a className="button" href="/api/v1/tenant/probes/export">
                Export current tenant CSV
              </a>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}
