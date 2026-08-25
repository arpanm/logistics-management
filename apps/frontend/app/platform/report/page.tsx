"use client";
import { useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api } from "../../../components/api";
type Report = {
  generatedAt: string;
  totals: { total: number; active: number; inactive: number };
  projectDatabaseBytes: string;
  storageLabel: string;
  integrationHealth:
    | string
    | { endpoints: number; active: number; failures: number };
  tenants: Array<Record<string, string | number | null>>;
};
type PlatformAlert = {
  id: string;
  type: string;
  severity: string;
  summary: string;
  state: string;
  occurrenceCount: number;
  correlationId: string | null;
  lastSeenAt: string;
};
export default function Report() {
  const [data, setData] = useState<Report | null>(null);
  const [alerts, setAlerts] = useState<PlatformAlert[]>([]);
  const [error, setError] = useState("");
  const load = async () => {
    setError("");
    try {
      const [report, operationalAlerts] = await Promise.all([
        api<Report>("/platform/report"),
        api<PlatformAlert[]>("/platform/alerts"),
      ]);
      setData(report);
      setAlerts(operationalAlerts);
    } catch (error) {
      setError(
        (error as { message?: string }).message ?? "Health data is unavailable",
      );
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <Shell area="platform">
      <div className="heading">
        <div>
          <p className="eyebrow">Control plane</p>
          <h1>Platform health</h1>
          <p className="muted">
            Reconciled metadata only. Tenant business content is excluded.
          </p>
        </div>
        <button onClick={load}>Refresh</button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={load}>Retry</button>
        </div>
      )}
      {!data ? (
        <p role="status">Loading reconciled health…</p>
      ) : (
        <>
          <div className="metric-grid">
            <article>
              <span>Total tenants</span>
              <strong>{data.totals.total}</strong>
            </article>
            <article>
              <span>Active</span>
              <strong>{data.totals.active}</strong>
            </article>
            <article>
              <span>Inactive</span>
              <strong>{data.totals.inactive}</strong>
            </article>
            <article>
              <span>Database</span>
              <strong>
                {(Number(data.projectDatabaseBytes) / 1048576).toFixed(1)} MB
              </strong>
              <small>{data.storageLabel}</small>
            </article>
          </div>
          <section className="panel">
            <h2>Tenant health detail</h2>
            <div
              className="table-region"
              tabIndex={0}
              aria-label="Tenant health table"
            >
              <table>
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Status</th>
                    <th>Users</th>
                    <th>Setup</th>
                    <th>Pending events</th>
                    <th>Failed work</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tenants.map((t) => (
                    <tr key={String(t.id)}>
                      <th>
                        {String(t.name)} <code>{String(t.code)}</code>
                      </th>
                      <td>{String(t.status)}</td>
                      <td>{String(t.active_user_count)}</td>
                      <td>
                        {String(t.setup_complete)}/{String(t.setup_total)}
                      </td>
                      <td>{String(t.pending_events)}</td>
                      <td>{Number(t.failed_events) + Number(t.failed_jobs)}</td>
                      <td>
                        {t.last_activity_at
                          ? new Date(
                              String(t.last_activity_at),
                            ).toLocaleString()
                          : "No activity"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Integration health:{" "}
              {typeof data.integrationHealth === "string"
                ? data.integrationHealth
                : `${data.integrationHealth.active}/${data.integrationHealth.endpoints} active, ${data.integrationHealth.failures} failures`}
              . Generated {new Date(data.generatedAt).toLocaleString()}.
            </p>
          </section>
          <section className="panel" aria-labelledby="alerts-title">
            <div className="panel-title">
              <h2 id="alerts-title">Operational alerts</h2>
              <span className="count">
                {alerts.filter((alert) => alert.state === "OPEN").length} open
              </span>
            </div>
            {alerts.length === 0 ? (
              <p className="empty">No operational alerts.</p>
            ) : (
              <div className="cards">
                {alerts.map((alert) => (
                  <article className="tenant-card" key={alert.id}>
                    <span
                      className={`status ${alert.state === "OPEN" ? "inactive" : "active"}`}
                    >
                      {alert.severity} · {alert.state}
                    </span>
                    <h3>{alert.type.replaceAll("_", " ")}</h3>
                    <p>{alert.summary}</p>
                    <small>
                      Seen {alert.occurrenceCount} time
                      {alert.occurrenceCount === 1 ? "" : "s"}; latest{" "}
                      {new Date(alert.lastSeenAt).toLocaleString()}
                      {alert.correlationId
                        ? ` · Reference ${alert.correlationId}`
                        : ""}
                    </small>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
