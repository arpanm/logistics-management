"use client";
import { useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";
type Alert = {
  id: string;
  type: string;
  severity: string;
  state: string;
  title: string;
  summary: string;
  dueAt?: string;
  occurrenceCount: number;
  version: number;
};
export default function AlertsPage() {
  const [items, setItems] = useState<Alert[]>([]),
    [state, setState] = useState(""),
    [error, setError] = useState<ApiError | null>(null),
    [busy, setBusy] = useState("");
  const load = () =>
    api<{ items: Alert[] }>(`/tenant/alerts?state=${encodeURIComponent(state)}`)
      .then((v) => {
        setItems(v.items);
        setError(null);
      })
      .catch(setError);
  useEffect(() => {
    void load();
  }, [state]);
  async function act(alert: Alert, action: "ACKNOWLEDGE" | "RESOLVE") {
    const reason =
      action === "RESOLVE" ? (window.prompt("Resolution outcome") ?? "") : "";
    if (action === "RESOLVE" && !reason) return;
    setBusy(alert.id);
    try {
      await api(`/tenant/alerts/${alert.id}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          action,
          reason,
          expectedVersion: alert.version,
        }),
      });
      await load();
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setBusy("");
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">ALT-01</p>
          <h1>Alerts and work queue</h1>
          <p className="muted">
            Deduplicated operational risk ordered for action.
          </p>
        </div>
      </div>
      <section className="panel">
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            {["OPEN", "ACKNOWLEDGED", "SNOOZED", "ESCALATED", "RESOLVED"].map(
              (v) => (
                <option key={v}>{v}</option>
              ),
            )}
          </select>
        </label>
      </section>
      {error && (
        <div role="alert" className="error">
          {error.message}
          <button onClick={load}>Retry</button>
        </div>
      )}
      <section className="panel" aria-busy={busy !== ""}>
        {items.length ? (
          <div className="responsive-list">
            {items.map((alert) => (
              <article className="access-card" key={alert.id}>
                <div>
                  <p className="eyebrow">
                    {alert.severity} · {alert.state}
                  </p>
                  <h2>{alert.title}</h2>
                  <p>{alert.summary}</p>
                  <small>
                    {alert.occurrenceCount} occurrence(s)
                    {alert.dueAt
                      ? ` · Due ${new Date(alert.dueAt).toLocaleString()}`
                      : ""}
                  </small>
                </div>
                <div>
                  {alert.state === "OPEN" && (
                    <button
                      disabled={busy === alert.id}
                      onClick={() => void act(alert, "ACKNOWLEDGE")}
                    >
                      Acknowledge
                    </button>
                  )}
                  {alert.state !== "RESOLVED" && (
                    <button
                      disabled={busy === alert.id}
                      onClick={() => void act(alert, "RESOLVE")}
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No alerts match this queue.</p>
        )}
      </section>
    </Shell>
  );
}
