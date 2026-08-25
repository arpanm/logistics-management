"use client";
import { useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, type ApiError } from "../../../components/api";

const lenses = [
  "placement",
  "pod",
  "collection",
  "trip",
  "vendor-payable",
] as const;
type Dashboard = {
  asOf: string;
  freshness: string | null;
  kpiCodes: string[];
  totals: Record<string, number>;
  status: Array<Record<string, unknown>>;
};

export default function ControlTowerPage() {
  const [lens, setLens] = useState<(typeof lenses)[number]>("placement");
  const [data, setData] = useState<Dashboard | null>(null),
    [error, setError] = useState<ApiError | null>(null),
    [paused, setPaused] = useState(false),
    [views, setViews] = useState<Array<Record<string, unknown>>>([]),
    [drill, setDrill] = useState<Array<Record<string, unknown>>>([]);
  const load = () => {
    setError(null);
    api<Dashboard>(`/tenant/control/${lens}`).then(setData).catch(setError);
    api<Array<Record<string, unknown>>>(`/tenant/control/${lens}/views`)
      .then(setViews)
      .catch(setError);
  };
  async function saveView() {
    const name = window.prompt("Saved view name");
    if (!name) return;
    try {
      await api(`/tenant/control/${lens}/views`, {
        method: "POST",
        body: JSON.stringify({ name, filters: {}, isDefault: false }),
      });
      load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function openDrill(status: string) {
    try {
      setDrill(
        await api(
          `/tenant/control/${lens}/drill?status=${encodeURIComponent(status)}`,
        ),
      );
    } catch (value) {
      setError(value as ApiError);
    }
  }
  useEffect(() => {
    setData(null);
    load();
    if (paused) return;
    const timer = window.setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [lens, paused]);
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">CTL-01</p>
          <h1>Control tower</h1>
          <p className="muted">
            Permission-scoped portfolio risk with canonical drill-down.
          </p>
        </div>
        <button onClick={() => setPaused((v) => !v)}>
          {paused ? "Resume live refresh" : "Pause refresh"}
        </button>
        <button onClick={() => void saveView()}>Save current view</button>
      </div>
      <section className="panel">
        <label>
          Lens
          <select
            value={lens}
            onChange={(e) => setLens(e.target.value as typeof lens)}
          >
            {lenses.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("-", " ")}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <p role="status" className="muted">
            As of {new Date(data.asOf).toLocaleString()} · Source{" "}
            {data.freshness
              ? new Date(data.freshness).toLocaleString()
              : "awaiting data"}
          </p>
        )}
      </section>
      {error && (
        <div role="alert" className="error">
          {error.message}
          <button onClick={load}>Retry</button>
        </div>
      )}
      {!data && !error ? (
        <p role="status">Loading dashboard…</p>
      ) : (
        data && (
          <>
            <div className="cards">
              {data.kpiCodes.map((code) => (
                <article className="panel" key={code}>
                  <h2>{code}</h2>
                  <strong>{data.totals[code] ?? "—"}</strong>
                </article>
              ))}
            </div>
            <section className="panel">
              <h2>Status drill-down</h2>
              {data.status.length ? (
                <div className="responsive-list">
                  {data.status.map((row, index) => (
                    <button
                      type="button"
                      className="access-card"
                      key={index}
                      onClick={() => void openDrill(String(row.status))}
                    >
                      <strong>{String(row.status)}</strong>
                      <span>{String(row.count)} records</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty">
                  No canonical records are available for this lens.
                </p>
              )}
            </section>
            {views.length > 0 && (
              <section className="panel">
                <h2>Saved views</h2>
                <div className="responsive-list">
                  {views.map((view) => (
                    <article className="access-card" key={String(view.id)}>
                      <h3>{String(view.name)}</h3>
                      <small>{String(view.lens)}</small>
                    </article>
                  ))}
                </div>
              </section>
            )}
            {drill.length > 0 && (
              <section className="panel">
                <h2>Scoped drill-down</h2>
                {drill.map((row) => (
                  <pre className="safe-json" key={String(row.id)}>
                    {JSON.stringify(row, null, 2)}
                  </pre>
                ))}
              </section>
            )}
          </>
        )
      )}
    </Shell>
  );
}
