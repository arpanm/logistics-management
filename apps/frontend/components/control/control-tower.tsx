"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import styles from "./control-tower.module.css";
const lenses = [
  "placement",
  "pod",
  "collection",
  "trip",
  "vendor-payable",
] as const;
type Lens = (typeof lenses)[number];
type Row = Record<string, unknown> & {
  id: string;
  reference: string;
  client?: string;
  clientId?: string;
  location?: string;
  locationId?: string;
  state: string;
  colour: "GREEN" | "YELLOW" | "RED";
};
type Data = {
  lens: Lens;
  asOf: string;
  freshness: { lastCanonicalChange: string | null; state: string };
  kpis: Record<string, string | number>;
  rows: Row[];
  vendors: Array<Record<string, unknown>>;
};
type View = {
  id: string;
  name: string;
  filters: Record<string, string>;
  isDefault: boolean;
};
const money = (minor: unknown) => {
  const value = BigInt(String(minor ?? 0));
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const absolute = value < zero ? -value : value;
  return `${value < zero ? "-" : ""}₹${(absolute / hundred).toLocaleString("en-IN")}.${String(absolute % hundred).padStart(2, "0")}`;
};
const kpiLabel = (key: string) =>
  key
    .replace(/Minor$/, " value")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (v) => v.toUpperCase());
const isMoney = (key: string) => key.toLowerCase().includes("minor");
export function ControlTower() {
  const [lens, setLens] = useState<Lens>("placement"),
    [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<ApiError | null>(null),
    [loading, setLoading] = useState(true),
    [search, setSearch] = useState(""),
    [colour, setColour] = useState(""),
    [client, setClient] = useState<{ id: string; name: string } | null>(null),
    [location, setLocation] = useState<{ id: string; name: string } | null>(
      null,
    ),
    [views, setViews] = useState<View[]>([]),
    [paused, setPaused] = useState(false);
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...(search ? { search } : {}),
        ...(colour ? { colour } : {}),
        ...(client ? { clientId: client.id } : {}),
        ...(location ? { locationId: location.id } : {}),
      }).toString(),
    [search, colour, client, location],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, v] = await Promise.all([
        api<Data>(`/control-workbench/${lens}?${query}`),
        api<View[]>(`/control-workbench/${lens}/views`),
      ]);
      setData(d);
      setViews(v);
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }, [lens, query]);
  useEffect(() => {
    void load();
    if (paused) return;
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [load, paused]);
  const groups = useMemo(() => {
    const result = new Map<string, { id: string; name: string; rows: Row[] }>();
    for (const row of data?.rows ?? []) {
      const id = String(row.clientId ?? row.client ?? "vendor");
      const group = result.get(id) ?? {
        id,
        name: String(row.client ?? "Vendor portfolio"),
        rows: [],
      };
      group.rows.push(row);
      result.set(id, group);
    }
    return [...result.values()];
  }, [data]);
  async function saveView() {
    const name = window.prompt("Name this filter");
    if (!name) return;
    await api(`/control-workbench/${lens}/views`, {
      method: "POST",
      body: JSON.stringify({
        name,
        filters: {
          search,
          ...(colour ? { colour } : {}),
          ...(client ? { clientId: client.id } : {}),
          ...(location ? { locationId: location.id } : {}),
        },
        isDefault: false,
      }),
    });
    await load();
  }
  async function exportCsv() {
    const result = await api<{ filename: string; content: string }>(
      `/control-workbench/${lens}/export?${query}`,
    );
    const href = URL.createObjectURL(
      new Blob([result.content], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = href;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(href);
  }
  function changeLens(value: Lens) {
    setLens(value);
    setClient(null);
    setLocation(null);
    setSearch("");
    setColour("");
  }
  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">CTL-01</p>
            <h1>Control tower</h1>
            <p className="muted">
              Placement, documents, collections and execution risk from
              canonical records.
            </p>
          </div>
          <div className={styles.actions}>
            <button onClick={() => setPaused((v) => !v)}>
              {paused ? "Resume refresh" : "Pause refresh"}
            </button>
            <button onClick={() => void saveView()}>Save filter</button>
            <button onClick={() => void exportCsv()}>
              Download visible CSV
            </button>
          </div>
        </header>
        <nav className={styles.tabs} aria-label="Control tower lens">
          {lenses.map((value) => (
            <button
              key={value}
              aria-selected={lens === value}
              onClick={() => changeLens(value)}
            >
              {value.replaceAll("-", " ")}
            </button>
          ))}
        </nav>
        <section className={`${styles.panel} ${styles.toolbar}`}>
          <label>
            Search
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Client, location, LR, invoice or vehicle"
            />
          </label>
          <label>
            Risk
            <select value={colour} onChange={(e) => setColour(e.target.value)}>
              <option value="">All G/Y/R</option>
              <option>GREEN</option>
              <option>YELLOW</option>
              <option>RED</option>
            </select>
          </label>
          {views.length > 0 && (
            <label>
              Saved filter
              <select
                defaultValue=""
                onChange={(e) => {
                  const view = views.find((v) => v.id === e.target.value);
                  if (view) {
                    setSearch(view.filters.search ?? "");
                    setColour(view.filters.colour ?? "");
                    setClient(
                      view.filters.clientId
                        ? { id: view.filters.clientId, name: "Saved client" }
                        : null,
                    );
                    setLocation(
                      view.filters.locationId
                        ? {
                            id: view.filters.locationId,
                            name: "Saved location",
                          }
                        : null,
                    );
                  }
                }}
              >
                <option value="">Select</option>
                {views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
        {data && (
          <p role="status" className="muted">
            As of {new Date(data.asOf).toLocaleString()} ·{" "}
            {data.freshness.state} · last canonical change{" "}
            {data.freshness.lastCanonicalChange
              ? new Date(data.freshness.lastCanonicalChange).toLocaleString()
              : "awaiting records"}
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error.message}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {data && (
          <section className={styles.metrics}>
            {Object.entries(data.kpis).map(([key, value]) => (
              <article className={styles.metric} key={key}>
                <span>{kpiLabel(key)}</span>
                <strong className={isMoney(key) ? styles.money : ""}>
                  {isMoney(key) ? money(value) : String(value)}
                </strong>
              </article>
            ))}
          </section>
        )}
        <div className={styles.crumbs}>
          <button
            onClick={() => {
              setClient(null);
              setLocation(null);
            }}
          >
            All clients
          </button>
          {client && (
            <>
              <span>›</span>
              <button onClick={() => setLocation(null)}>{client.name}</button>
            </>
          )}
          {location && (
            <>
              <span>›</span>
              <strong>{location.name}</strong>
            </>
          )}
        </div>
        <section className={styles.panel} aria-busy={loading}>
          {loading ? (
            <p role="status">Refreshing canonical metrics…</p>
          ) : !data?.rows.length ? (
            <p className={styles.empty}>
              Nothing matches this lens and filter.
            </p>
          ) : !client ? (
            <ClientBoard groups={groups} onOpen={setClient} />
          ) : !location ? (
            <LocationBoard rows={data.rows} onOpen={setLocation} />
          ) : (
            <RecordTable lens={lens} rows={data.rows} />
          )}
        </section>
        {lens === "placement" && data && data.vendors.length > 0 && (
          <section className={styles.panel}>
            <h2>Vendor allocation</h2>
            <p className="muted">
              NTP means allotted capacity that has not yet reached placed
              status.
            </p>
            <div className={styles.vendors}>
              {data.vendors.map((v) => (
                <article className={styles.vendor} key={String(v.id)}>
                  <strong>{String(v.vendor)}</strong>
                  <p>
                    Allotted {String(v.allotted)} · Placed {String(v.placed)} ·
                    NTP {String(v.ntp)}
                  </p>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
    </Shell>
  );
}
function rollup(rows: Row[]) {
  return {
    green: rows.filter((r) => r.colour === "GREEN").length,
    yellow: rows.filter((r) => r.colour === "YELLOW").length,
    red: rows.filter((r) => r.colour === "RED").length,
  };
}
function ClientBoard({
  groups,
  onOpen,
}: {
  groups: Array<{ id: string; name: string; rows: Row[] }>;
  onOpen: (v: { id: string; name: string }) => void;
}) {
  return (
    <>
      <h2>Client portfolio</h2>
      <div className={styles.clients}>
        {groups.map((group) => {
          const r = rollup(group.rows),
            total = group.rows.length;
          return (
            <button
              className={styles.client}
              key={group.id}
              onClick={() => onOpen({ id: group.id, name: group.name })}
            >
              <h3>{group.name}</h3>
              <p>
                {new Set(group.rows.map((v) => v.locationId)).size} locations ·{" "}
                {total} records
              </p>
              <div
                className={styles.strip}
                style={
                  {
                    "--green": `${(r.green * 100) / total}%`,
                    "--yellow": `${(r.yellow * 100) / total}%`,
                  } as CSSProperties
                }
              />
              <p>
                G {r.green} · Y {r.yellow} · R {r.red}
              </p>
            </button>
          );
        })}
      </div>
    </>
  );
}
function LocationBoard({
  rows,
  onOpen,
}: {
  rows: Row[];
  onOpen: (v: { id: string; name: string }) => void;
}) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row.locationId ?? row.location);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return (
    <>
      <h2>Location board</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Location</th>
              <th>Records</th>
              <th>Green</th>
              <th>Yellow</th>
              <th>Red</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {[...groups].map(([id, items]) => {
              const r = rollup(items);
              return (
                <tr key={id}>
                  <td>{String(items[0]?.location)}</td>
                  <td>{items.length}</td>
                  <td>{r.green}</td>
                  <td>{r.yellow}</td>
                  <td>{r.red}</td>
                  <td>
                    <button
                      onClick={() =>
                        onOpen({ id, name: String(items[0]?.location) })
                      }
                    >
                      View records
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
function RecordTable({ lens, rows }: { lens: Lens; rows: Row[] }) {
  const href = (row: Row) =>
    lens === "placement"
      ? `/app/operations/indents?search=${encodeURIComponent(row.reference)}`
      : lens === "pod"
        ? "/app/pod"
        : lens === "collection"
          ? `/app/finance/invoices?search=${encodeURIComponent(row.reference)}`
          : lens === "trip"
            ? `/app/operations/trips?search=${encodeURIComponent(row.reference)}`
            : "/app/finance/vendor-bills";
  return (
    <>
      <h2>Record detail</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Due / delivered</th>
              <th>Value / balance</th>
              <th>Vehicle / vendor</th>
              <th>Follow-up / hold</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.reference}</strong>
                  <small>
                    <br />
                    {String(row.secondaryReference ?? "")}
                  </small>
                </td>
                <td>{row.state}</td>
                <td>
                  <span className={`${styles.status} ${styles[row.colour]}`}>
                    {row.colour}
                  </span>
                </td>
                <td>
                  {row.dueAt
                    ? new Date(String(row.dueAt)).toLocaleString()
                    : "—"}
                </td>
                <td>
                  {row.balanceMinor != null
                    ? money(row.balanceMinor)
                    : row.valueMinor != null
                      ? money(row.valueMinor)
                      : "—"}
                </td>
                <td>{String(row.vehicle ?? row.vendors ?? "Awaiting")}</td>
                <td>
                  {String(row.followupOutcome ?? row.hold ?? "—")}
                  {Boolean(row.nextFollowupAt) && (
                    <small>
                      <br />
                      Next{" "}
                      {new Date(String(row.nextFollowupAt)).toLocaleString()}
                    </small>
                  )}
                </td>
                <td>
                  <Link href={href(row)}>Open record</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
