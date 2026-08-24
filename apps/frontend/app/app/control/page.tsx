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
    [paused, setPaused] = useState(false);
  const load = () => {
    setError(null);
    api<Dashboard>(`/tenant/control/${lens}`).then(setData).catch(setError);
  };
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
                    <pre className="safe-json" key={index}>
                      {JSON.stringify(row, null, 2)}
                    </pre>
                  ))}
                </div>
              ) : (
                <p className="empty">
                  No canonical records are available for this lens.
                </p>
              )}
            </section>
          </>
        )
      )}
    </Shell>
  );
}
