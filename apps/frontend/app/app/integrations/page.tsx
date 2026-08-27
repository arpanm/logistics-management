"use client";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";
import { FormSubmitResult } from "../../../components/forms/form-submit-result";
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
  deliveryVersion: number;
  resolvedAt?: string;
};
type Accounting = {
  id: string;
  documentType: string;
  state: string;
  amountMinor: number;
  externalReference?: string;
  safeErrorCode?: string;
  version: number;
};
export default function IntegrationsPage() {
  const [tab, setTab] = useState("health"),
    [endpoints, setEndpoints] = useState<Endpoint[]>([]),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [dead, setDead] = useState<Dead[]>([]),
    [accounting, setAccounting] = useState<Accounting[]>([]),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [secret, setSecret] = useState("");
  const load = () =>
    Promise.all([
      api<Endpoint[]>("/tenant/integrations"),
      api<Delivery[]>("/tenant/integrations/deliveries"),
      api<Dead[]>("/tenant/integrations/dead-letters"),
      api<Accounting[]>("/domain/commands/accounting/reconciliation"),
    ])
      .then(([e, d, l, a]) => {
        setEndpoints(e);
        setDeliveries(d);
        setDead(l);
        setAccounting(a);
        setError(null);
      })
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    setError(null);
    setNotice("");
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
      form.reset();
      await load();
      setNotice("Integration registered.");
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
        body: JSON.stringify({ reason, expectedVersion: item.deliveryVersion }),
      });
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function addMapping(endpoint: Endpoint) {
    const raw = window.prompt(
      "Enter comma-separated source=destination field mappings",
      "customerCode=clientCode, shipmentNo=indentNo",
    );
    if (!raw) return;
    try {
      const fields = Object.fromEntries(
        raw.split(",").map((entry) => {
          const [source, ...destination] = entry.split("=");
          if (!source?.trim() || !destination.length)
            throw new Error("Use source=destination for every mapping.");
          return [source.trim(), destination.join("=").trim()];
        }),
      );
      await api(`/tenant/integrations/${endpoint.id}/mappings`, {
        method: "POST",
        body: JSON.stringify({
          schema: { type: "object" },
          mapping: { fields },
        }),
      });
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      fields = new FormData(form);
    try {
      const created = await api<{ secret: string }>(
        "/tenant/integrations/api-clients",
        {
          method: "POST",
          body: JSON.stringify({
            code: fields.get("code"),
            name: fields.get("name"),
            scopes: String(fields.get("scopes"))
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          }),
        },
      );
      setSecret(created.secret);
      form.reset();
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
          {[
            "health",
            "deliveries",
            "dead-letters",
            "accounting",
            "credentials",
            "new",
          ].map((value) => (
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
                  <button type="button" onClick={() => void addMapping(item)}>
                    Create mapping version
                  </button>
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
              <input
                name="endpoint"
                placeholder="https://… or local://capture"
              />
            </label>
            <label>
              Credential reference
              <input
                name="credentialReference"
                placeholder="secret-store reference only"
              />
            </label>
            <FormSubmitResult error={error} success={notice}>
              <button className="primary">Create integration</button>
            </FormSubmitResult>
          </form>
        </section>
      )}
      {tab === "credentials" && (
        <section className="panel">
          <h2>Machine credentials</h2>
          {secret && (
            <div className="success" role="status">
              <strong>Copy this secret now</strong>
              <code>{secret}</code>
              <p>It is not shown again.</p>
            </div>
          )}
          <form
            className="access-form"
            onSubmit={(event) => void createCredential(event)}
          >
            <label>
              Client code
              <input name="code" required />
            </label>
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Allowed event scopes
              <input
                name="scopes"
                required
                placeholder="indent.created.v1, trip.event.v1"
              />
            </label>
            <FormSubmitResult
              error={error}
              success={
                secret ? "Credential created. Copy the secret now." : notice
              }
            >
              <button className="primary">Create credential</button>
            </FormSubmitResult>
          </form>
        </section>
      )}
      {tab === "accounting" && (
        <section className="panel">
          <h2>Accounting reconciliation</h2>
          {accounting.length ? (
            accounting.map((item) => (
              <article className="access-card" key={item.id}>
                <h3>{item.documentType}</h3>
                <p>
                  {item.state} · {item.amountMinor} minor units
                </p>
                <small>
                  {item.externalReference ??
                    item.safeErrorCode ??
                    "Awaiting adapter"}
                </small>
              </article>
            ))
          ) : (
            <p className="empty">
              No posted documents await accounting exchange.
            </p>
          )}
        </section>
      )}
    </Shell>
  );
}
