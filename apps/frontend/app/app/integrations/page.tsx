"use client";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";
type Endpoint = {
  id: string;
  code: string;
  type: string;
  name: string;
  environment: string;
  state: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  version: number;
};
type Delivery = {
  id: string;
  integration: string;
  eventType: string;
  state: string;
  attempts: number;
  createdAt: string;
  lastErrorCode?: string;
};
type Dead = {
  id: string;
  integration: string;
  eventType: string;
  reasonCode: string;
  safeError: string;
  replayCount: number;
  resolvedAt?: string;
};
export default function IntegrationsPage() {
  const [tab, setTab] = useState("health"),
    [endpoints, setEndpoints] = useState<Endpoint[]>([]),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [dead, setDead] = useState<Dead[]>([]),
    [error, setError] = useState<ApiError | null>(null);
  const load = () =>
    Promise.all([
      api<Endpoint[]>("/tenant/integrations"),
      api<Delivery[]>("/tenant/integrations/deliveries"),
      api<Dead[]>("/tenant/integrations/dead-letters"),
    ])
      .then(([e, d, l]) => {
        setEndpoints(e);
        setDeliveries(d);
        setDead(l);
        setError(null);
      })
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    try {
      await api("/tenant/integrations", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          code: f.get("code"),
          type: f.get("type"),
          name: f.get("name"),
          environment: f.get("environment"),
          endpoint: f.get("endpoint") || undefined,
          credentialReference: f.get("credentialReference") || undefined,
          scopes: [],
          allowedEvents: [],
          mappingVersion: 1,
        }),
      });
      event.currentTarget.reset();
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function replay(item: Dead) {
    const reason = window.prompt("Reason for replay") ?? "";
    if (!reason) return;
    try {
      await api(`/tenant/integrations/dead-letters/${item.id}/replay`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">INT-01</p>
          <h1>Integrations</h1>
          <p className="muted">
            Endpoint registry, persisted deliveries, dead letters and
            reconciliation health.
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error.message}
          <button onClick={load}>Retry</button>
        </div>
      )}
      <section className="panel">
        <div role="tablist" aria-label="Integration views">
          {["health", "deliveries", "dead-letters", "new"].map((value) => (
            <button
              role="tab"
              aria-selected={tab === value}
              key={value}
              onClick={() => setTab(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </section>
      {tab === "health" && (
        <section className="panel">
          <h2>Endpoint health</h2>
          {endpoints.length ? (
            <div className="responsive-list">
              {endpoints.map((item) => (
                <article className="access-card" key={item.id}>
                  <div>
                    <h3>{item.name}</h3>
                    <p>
                      {item.type} · {item.environment} · {item.state}
                    </p>
                  </div>
                  <small>
                    Success{" "}
                    {item.lastSuccessAt
                      ? new Date(item.lastSuccessAt).toLocaleString()
                      : "—"}
                    <br />
                    Failure{" "}
                    {item.lastFailureAt
                      ? new Date(item.lastFailureAt).toLocaleString()
                      : "—"}
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty">No integrations configured.</p>
          )}
        </section>
      )}
      {tab === "deliveries" && (
        <section className="panel">
          <h2>Delivery log</h2>
          {deliveries.map((item) => (
            <pre className="safe-json" key={item.id}>
              {JSON.stringify(item, null, 2)}
            </pre>
          ))}
        </section>
      )}
      {tab === "dead-letters" && (
        <section className="panel">
          <h2>Dead letters</h2>
          {dead.length ? (
            dead.map((item) => (
              <article className="access-card" key={item.id}>
                <pre className="safe-json">{JSON.stringify(item, null, 2)}</pre>
                {!item.resolvedAt && (
                  <button onClick={() => void replay(item)}>Replay</button>
                )}
              </article>
            ))
          ) : (
            <p className="empty">No dead letters.</p>
          )}
        </section>
      )}
      {tab === "new" && (
        <section className="panel">
          <h2>Register integration</h2>
          <form className="access-form" onSubmit={(e) => void create(e)}>
            <label>
              Code
              <input name="code" required />
            </label>
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Type
              <select name="type">
                {[
                  "API",
                  "WEBHOOK",
                  "NOTIFICATION",
                  "GPS",
                  "ACCOUNTING",
                  "MIGRATION",
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Environment
              <input name="environment" defaultValue="production" required />
            </label>
            <label>
              Endpoint
              <input name="endpoint" type="url" />
            </label>
            <label>
              Credential reference
              <input
                name="credentialReference"
                placeholder="secret-store reference only"
              />
            </label>
            <button className="primary">Create integration</button>
          </form>
        </section>
      )}
    </Shell>
  );
}
