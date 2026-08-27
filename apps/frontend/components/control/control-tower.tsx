"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import styles from "./control-tower.module.css";

type Lens = "placement" | "pod" | "collection" | "trip" | "vendor-payable";
type Risk = "GREEN" | "YELLOW" | "RED";
type Row = Record<string, unknown> & {
  id: string;
  reference: string;
  client?: string;
  clientId?: string;
  location?: string;
  locationId?: string;
  state: string;
  colour: Risk;
};
type Bucket = {
  bucket: "CURRENT" | "31_45" | "46_90" | "OVER_90";
  count: number;
  amountMinor: string;
};
type Data = {
  lens: Lens;
  asOf: string;
  freshness: { lastCanonicalChange: string | null; state: "LIVE" | "DELAYED" };
  kpis: Record<string, string | number>;
  rows: Row[];
  vendors: Array<Record<string, unknown>>;
  ageing: Bucket[];
};
type Access = {
  lenses: Lens[];
  timezone: string;
  locale: string;
  currency: string;
  refreshSeconds: number;
};
type View = {
  id: string;
  name: string;
  filters: Record<string, string>;
  isDefault: boolean;
};
type Drill = { id: string; name: string };

const meta: Record<
  Lens,
  { label: string; description: string; guidance: string; record: string }
> = {
  placement: {
    label: "Placement",
    description: "Demand, placement ageing, fill and vendor NTP exposure.",
    guidance:
      "Green is placed or within 24 hours; yellow is 24–48 hours late; red is over 48 hours late.",
    record: "indent",
  },
  pod: {
    label: "POD vs Invoice",
    description: "Delivery records, POD closure and invoice value at risk.",
    guidance:
      "Green is received or within 7 days; yellow is 8–15 days; red is over 15 days or prior-period pending.",
    record: "POD",
  },
  collection: {
    label: "Collection",
    description: "Submitted invoices, receipts, holds and outstanding ageing.",
    guidance:
      "Green is current through 30 days; yellow is 31–45 days; red is over 45 days. Age starts at acknowledgement, falling back to invoice date.",
    record: "invoice",
  },
  trip: {
    label: "Trips",
    description:
      "Live execution, ETA risk, GPS silence and detention exceptions.",
    guidance:
      "Yellow is within two hours of planned delivery; red is past planned delivery. GPS silence is over 30 minutes without an observation.",
    record: "trip",
  },
  "vendor-payable": {
    label: "Vendor Payable",
    description:
      "Verification, approval, disputes, payment blocks and balances.",
    guidance:
      "Exceptions and disputes are red; approval queues and 31–45 day items are yellow; unpaid items over 45 days are red.",
    record: "vendor bill",
  },
};
const kpiNames: Record<string, string> = {
  liveIndents: "Live indents",
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  placed: "Vehicles placed",
  awaiting: "Awaiting placement",
  fillRate: "Fill rate",
  deliveryRecords: "LRs / deliveries",
  received: "POD received",
  pendingCurrent: "Pending current period",
  pendingPrior: "Pending prior periods",
  valueAtRiskMinor: "Value at risk",
  closureRate: "Closure rate",
  submitted: "Invoices submitted",
  billedMinor: "Billed",
  receivedMinor: "Received",
  outstandingMinor: "Outstanding",
  openInvoices: "Open invoices",
  partPaid: "Part paid",
  onHold: "On hold",
  over45Minor: "Over 45 days",
  over45Count: "Invoices over 45 days",
  oldestDays: "Oldest outstanding (days)",
  active: "Active trips",
  atRisk: "At risk",
  delayed: "Delayed",
  gpsSilent: "GPS silent",
  loadingDetention: "Loading detention",
  unloadingDetention: "Unloading detention",
  deliveryExceptions: "Delivery exceptions",
  unbilled: "Unbilled / draft",
  approvalPending: "Approval pending",
  due: "Due",
  overdue: "Overdue",
  paymentBlocked: "Payment blocked",
  disputed: "Disputed",
  paid: "Paid",
};
const moneyKeys = new Set([
  "valueAtRiskMinor",
  "billedMinor",
  "receivedMinor",
  "outstandingMinor",
  "over45Minor",
]);
const percentKeys = new Set(["fillRate", "closureRate"]);

function money(minor: unknown, currency = "INR", locale = "en-IN") {
  if (minor === "••••") return "••••";
  const value = BigInt(String(minor ?? 0)),
    absolute = value < BigInt(0) ? -value : value;
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  const formatted = `${symbol}${(absolute / BigInt(100)).toLocaleString(locale)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
  return value < BigInt(0) ? `-${formatted}` : formatted;
}
function dateTime(value: unknown, access: Access | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(access?.locale ?? "en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: access?.timezone ?? "Asia/Kolkata",
  }).format(new Date(String(value)));
}
function href(lens: Lens, row: Row) {
  const search = encodeURIComponent(row.reference);
  if (lens === "placement") return `/app/operations/indents?search=${search}`;
  if (lens === "pod") return "/app/pod";
  if (lens === "collection") return `/app/finance/invoices?search=${search}`;
  if (lens === "trip") return `/app/operations/trips?search=${search}`;
  return `/app/finance/vendor-bills?search=${search}`;
}

export function ControlTower() {
  const [access, setAccess] = useState<Access | null>(null),
    [lens, setLens] = useState<Lens>("placement"),
    [data, setData] = useState<Data | null>(null),
    [views, setViews] = useState<View[]>([]),
    [error, setError] = useState<ApiError | null>(null),
    [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(""),
    [colour, setColour] = useState(""),
    [state, setState] = useState(""),
    [ageingBucket, setAgeingBucket] = useState(""),
    [client, setClient] = useState<Drill | null>(null),
    [location, setLocation] = useState<Drill | null>(null);
  const [paused, setPaused] = useState(false),
    [saveOpen, setSaveOpen] = useState(false),
    [viewName, setViewName] = useState(""),
    [saving, setSaving] = useState(false);
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...(search ? { search } : {}),
        ...(colour ? { colour } : {}),
        ...(state ? { state } : {}),
        ...(ageingBucket ? { ageingBucket } : {}),
        ...(client ? { clientId: client.id } : {}),
        ...(location ? { locationId: location.id } : {}),
      }).toString(),
    [search, colour, state, ageingBucket, client, location],
  );

  useEffect(() => {
    let mounted = true;
    api<Access>("/control-workbench/access")
      .then((value) => {
        if (!mounted) return;
        setAccess(value);
        if (value.lenses[0] && !value.lenses.includes(lens))
          setLens(value.lenses[0]);
      })
      .catch((value) => {
        if (!mounted) return;
        setError(value as ApiError);
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [lens]);
  const load = useCallback(async () => {
    if (!access?.lenses.includes(lens)) return;
    setLoading(true);
    try {
      const [dashboard, saved] = await Promise.all([
        api<Data>(`/control-workbench/${lens}?${query}`),
        api<View[]>(`/control-workbench/${lens}/views`),
      ]);
      setData(dashboard);
      setViews(saved);
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }, [access, lens, query]);
  useEffect(() => {
    void load();
    if (paused || !access) return;
    const timer = window.setInterval(
      () => void load(),
      access.refreshSeconds * 1000,
    );
    return () => window.clearInterval(timer);
  }, [access, load, paused]);

  const groups = useMemo(
    () => groupBy(data?.rows ?? [], "clientId", "client"),
    [data],
  );
  const resetDrill = () => {
    setClient(null);
    setLocation(null);
  };
  function changeLens(value: Lens) {
    setLens(value);
    setSearch("");
    setColour("");
    setState("");
    setAgeingBucket("");
    resetDrill();
  }
  function applyView(view?: View) {
    if (!view) return;
    setSearch(view.filters.search ?? "");
    setColour(view.filters.colour ?? "");
    setState(view.filters.state ?? "");
    setAgeingBucket(view.filters.ageingBucket ?? "");
    setClient(
      view.filters.clientId
        ? { id: view.filters.clientId, name: "Saved client scope" }
        : null,
    );
    setLocation(
      view.filters.locationId
        ? { id: view.filters.locationId, name: "Saved location scope" }
        : null,
    );
  }
  async function saveView() {
    if (viewName.trim().length < 2) return;
    setSaving(true);
    try {
      await api(`/control-workbench/${lens}/views`, {
        method: "POST",
        body: JSON.stringify({
          name: viewName.trim(),
          filters: {
            search,
            ...(colour ? { colour } : {}),
            ...(state ? { state } : {}),
            ...(ageingBucket ? { ageingBucket } : {}),
            ...(client ? { clientId: client.id } : {}),
            ...(location ? { locationId: location.id } : {}),
          },
          isDefault: false,
        }),
      });
      setViewName("");
      setSaveOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  }
  async function exportCsv() {
    const result = await api<{ filename: string; content: string }>(
      `/control-workbench/${lens}/export?${query}`,
    );
    const url = URL.createObjectURL(
      new Blob([result.content], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  function drillKpi(key: string) {
    resetDrill();
    setState("");
    setAgeingBucket("");
    if (["green", "received", "paid"].includes(key)) setColour("GREEN");
    else if (["yellow", "atRisk", "due", "approvalPending"].includes(key))
      setColour("YELLOW");
    else if (
      [
        "red",
        "delayed",
        "deliveryExceptions",
        "overdue",
        "paymentBlocked",
        "disputed",
      ].includes(key)
    )
      setColour("RED");
    else {
      setColour("");
      if (key === "partPaid") setState("PART_PAID");
      if (key === "loadingDetention") setState("AT_ORIGIN");
      if (key === "unloadingDetention") setState("AT_DESTINATION");
    }
  }
  const clear = () => {
    setSearch("");
    setColour("");
    setState("");
    setAgeingBucket("");
    resetDrill();
  };
  const states = [
    ...new Set((data?.rows ?? []).map((row) => row.state)),
  ].sort();

  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">CTL-01 · operational command view</p>
            <h1>Control tower</h1>
            <p className="muted">
              Move from portfolio risk to the exact canonical record and its
              owning workflow.
            </p>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => setPaused((value) => !value)}
              aria-pressed={paused}
            >
              {paused ? "Resume live refresh" : "Pause live refresh"}
            </button>
            <button
              type="button"
              onClick={() => setSaveOpen((value) => !value)}
            >
              Save current view
            </button>
            <button
              type="button"
              onClick={() => void exportCsv()}
              disabled={!data || loading}
            >
              Download visible CSV
            </button>
          </div>
        </header>
        {access?.lenses.length ? (
          <nav
            className={styles.tabs}
            aria-label="Control tower lens"
            role="tablist"
          >
            {access.lenses.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={lens === value}
                onClick={() => changeLens(value)}
              >
                {meta[value].label}
              </button>
            ))}
          </nav>
        ) : !error ? (
          <section className={styles.panel}>
            <p>
              No control-tower lens is enabled for your current role and scope.
            </p>
          </section>
        ) : null}
        <section className={styles.lensIntro}>
          <div>
            <h2>{meta[lens].label}</h2>
            <p>{meta[lens].description}</p>
          </div>
          <p className={styles.guidance}>
            <strong>Ageing guide:</strong> {meta[lens].guidance}
          </p>
        </section>
        <section
          className={`${styles.panel} ${styles.toolbar}`}
          aria-label="View filters"
        >
          <label>
            Search visible scope
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Client, location, reference, vehicle or vendor"
            />
          </label>
          <label>
            Traffic light
            <select
              value={colour}
              onChange={(event) => setColour(event.target.value)}
            >
              <option value="">All risks</option>
              <option value="GREEN">Green</option>
              <option value="YELLOW">Yellow</option>
              <option value="RED">Red</option>
            </select>
          </label>
          <label>
            Workflow status
            <select
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              <option value="">All statuses</option>
              {states.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {(lens === "collection" || lens === "vendor-payable") && (
            <label>
              Ageing bucket
              <select
                value={ageingBucket}
                onChange={(event) => setAgeingBucket(event.target.value)}
              >
                <option value="">All ageing</option>
                <option value="CURRENT">0–30 days</option>
                <option value="31_45">31–45 days</option>
                <option value="46_90">46–90 days</option>
                <option value="OVER_90">Beyond 90 days</option>
              </select>
            </label>
          )}
          <label>
            Saved filter / view
            <select
              defaultValue=""
              onChange={(event) =>
                applyView(views.find((view) => view.id === event.target.value))
              }
            >
              <option value="">Select a saved view</option>
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                  {view.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={styles.clear} onClick={clear}>
            Clear filters
          </button>
        </section>
        {saveOpen && (
          <form
            className={`${styles.panel} ${styles.saveForm}`}
            onSubmit={(event) => {
              event.preventDefault();
              void saveView();
            }}
          >
            <label htmlFor="control-view-name">View name</label>
            <input
              id="control-view-name"
              value={viewName}
              minLength={2}
              maxLength={100}
              required
              autoFocus
              onChange={(event) => setViewName(event.target.value)}
            />
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save view"}
            </button>
            <button type="button" onClick={() => setSaveOpen(false)}>
              Cancel
            </button>
          </form>
        )}
        {data && (
          <div className={styles.freshness} role="status">
            <span
              className={`${styles.freshDot} ${data.freshness.state === "LIVE" ? styles.live : styles.delayed}`}
              aria-hidden="true"
            />
            <strong>{paused ? "PAUSED" : data.freshness.state}</strong>
            <span>As of {dateTime(data.asOf, access)}</span>
            <span>
              Last canonical change{" "}
              {dateTime(data.freshness.lastCanonicalChange, access)}
            </span>
            <span>
              {access?.timezone} · {access?.currency}
            </span>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            <p>{error.message}</p>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {data && (
          <section
            className={styles.metrics}
            aria-label={`${meta[lens].label} key performance indicators`}
          >
            {Object.entries(data.kpis).map(([key, value]) => (
              <button
                type="button"
                className={styles.metric}
                key={key}
                onClick={() => drillKpi(key)}
                aria-label={`Show records for ${kpiNames[key] ?? key}`}
              >
                <span>{kpiNames[key] ?? key}</span>
                <strong className={moneyKeys.has(key) ? styles.money : ""}>
                  {moneyKeys.has(key)
                    ? money(value, access?.currency, access?.locale)
                    : `${value}${percentKeys.has(key) ? "%" : ""}`}
                </strong>
                <small>Open filtered records</small>
              </button>
            ))}
          </section>
        )}
        {lens === "collection" && data?.ageing.length ? (
          <AgeingBoard
            buckets={data.ageing}
            access={access}
            onOpen={setAgeingBucket}
          />
        ) : null}
        <nav className={styles.crumbs} aria-label="Drill-down breadcrumb">
          <button type="button" onClick={resetDrill}>
            All {lens === "vendor-payable" ? "vendors" : "clients"}
          </button>
          {client && (
            <>
              <span aria-hidden="true">›</span>
              <button type="button" onClick={() => setLocation(null)}>
                {client.name}
              </button>
            </>
          )}
          {location && (
            <>
              <span aria-hidden="true">›</span>
              <strong>{location.name}</strong>
            </>
          )}
        </nav>
        <section
          className={styles.panel}
          aria-busy={loading}
          aria-live="polite"
        >
          {loading ? (
            <LoadingRows />
          ) : !data?.rows.length ? (
            <div className={styles.empty}>
              <h2>No matching {meta[lens].record} records</h2>
              <p>
                Clear a filter or wait for scoped canonical records to arrive.
              </p>
              <button type="button" onClick={clear}>
                Clear filters
              </button>
            </div>
          ) : !client ? (
            <PortfolioBoard
              lens={lens}
              groups={groups}
              access={access}
              onOpen={setClient}
            />
          ) : !location ? (
            <LocationBoard
              lens={lens}
              rows={data.rows}
              access={access}
              onOpen={setLocation}
            />
          ) : (
            <RecordTable lens={lens} rows={data.rows} access={access} />
          )}
        </section>
        {lens === "placement" && data?.vendors.length ? (
          <VendorAllocation vendors={data.vendors} />
        ) : null}
      </main>
    </Shell>
  );
}

function groupBy(
  rows: Row[],
  idKey: "clientId" | "locationId",
  nameKey: "client" | "location",
) {
  const result = new Map<string, { id: string; name: string; rows: Row[] }>();
  for (const row of rows) {
    const id = String(row[idKey] ?? row[nameKey] ?? "unassigned"),
      group = result.get(id) ?? {
        id,
        name: String(row[nameKey] ?? "Unassigned"),
        rows: [],
      };
    group.rows.push(row);
    result.set(id, group);
  }
  return [...result.values()];
}
function rollup(rows: Row[]) {
  const sum = (key: string) => {
      if (rows.some((row) => row[key] === "••••")) return "••••";
      return rows.reduce(
        (total, row) => total + BigInt(String(row[key] ?? 0)),
        BigInt(0),
      );
    },
    demand = rows.reduce((total, row) => total + Number(row.demand ?? 0), 0),
    placed = rows.reduce((total, row) => total + Number(row.placed ?? 0), 0),
    red = rows.filter((row) => row.colour === "RED").length,
    yellow = rows.filter((row) => row.colour === "YELLOW").length,
    green = rows.filter((row) => row.colour === "GREEN").length;
  return {
    green,
    yellow,
    red,
    worst: (red ? "RED" : yellow ? "YELLOW" : "GREEN") as Risk,
    demand,
    placed,
    pending: Math.max(demand - placed, 0),
    fill: demand ? Math.round((placed * 10000) / demand) / 100 : 0,
    value: sum("valueMinor"),
    balance: sum("balanceMinor"),
  };
}

function PortfolioBoard({
  lens,
  groups,
  access,
  onOpen,
}: {
  lens: Lens;
  groups: ReturnType<typeof groupBy>;
  access: Access | null;
  onOpen: (value: Drill) => void;
}) {
  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2>
            {lens === "vendor-payable"
              ? "Vendor portfolio"
              : "Client portfolio"}
          </h2>
          <p className="muted">
            Worst child status controls each portfolio card.
          </p>
        </div>
        <span>{groups.length} scoped portfolios</span>
      </div>
      <div className={styles.clients}>
        {groups.map((group) => {
          const summary = rollup(group.rows);
          return (
            <button
              type="button"
              className={styles.client}
              key={group.id}
              onClick={() => onOpen({ id: group.id, name: group.name })}
            >
              <div className={styles.cardHead}>
                <div>
                  <h3>{group.name}</h3>
                  <p>
                    {
                      new Set(
                        group.rows.map((row) => row.locationId ?? row.location),
                      ).size
                    }{" "}
                    locations · {group.rows.length} records
                  </p>
                </div>
                <span className={`${styles.status} ${styles[summary.worst]}`}>
                  {summary.worst}
                </span>
              </div>
              <div
                className={styles.strip}
                style={
                  {
                    "--green": `${(summary.green * 100) / group.rows.length}%`,
                    "--yellow": `${(summary.yellow * 100) / group.rows.length}%`,
                  } as CSSProperties
                }
              />
              <div className={styles.cardStats}>
                <span>
                  G <b>{summary.green}</b>
                </span>
                <span>
                  Y <b>{summary.yellow}</b>
                </span>
                <span>
                  R <b>{summary.red}</b>
                </span>
                {lens === "placement" ? (
                  <span>
                    Fill <b>{summary.fill}%</b>
                  </span>
                ) : (
                  <span>
                    Open{" "}
                    <b>
                      {money(summary.balance, access?.currency, access?.locale)}
                    </b>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
function LocationBoard({
  lens,
  rows,
  access,
  onOpen,
}: {
  lens: Lens;
  rows: Row[];
  access: Access | null;
  onOpen: (value: Drill) => void;
}) {
  const groups = groupBy(rows, "locationId", "location");
  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2>
            {lens === "vendor-payable" ? "Vendor accounts" : "Location board"}
          </h2>
          <p className="muted">Select a row to open the detailed register.</p>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Risk</th>
              <th>Location / account</th>
              <th>Records</th>
              {lens === "placement" ? (
                <>
                  <th>Placed</th>
                  <th>Pending</th>
                  <th>Fill</th>
                </>
              ) : (
                <>
                  <th>Value</th>
                  <th>Outstanding</th>
                </>
              )}
              <th>G</th>
              <th>Y</th>
              <th>R</th>
              <th>Drill</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const summary = rollup(group.rows);
              return (
                <tr key={group.id}>
                  <td>
                    <span
                      className={`${styles.status} ${styles[summary.worst]}`}
                    >
                      {summary.worst}
                    </span>
                  </td>
                  <td>
                    <strong>{group.name}</strong>
                  </td>
                  <td>{group.rows.length}</td>
                  {lens === "placement" ? (
                    <>
                      <td>{summary.placed}</td>
                      <td>{summary.pending}</td>
                      <td>{summary.fill}%</td>
                    </>
                  ) : (
                    <>
                      <td>
                        {money(summary.value, access?.currency, access?.locale)}
                      </td>
                      <td>
                        {money(
                          summary.balance,
                          access?.currency,
                          access?.locale,
                        )}
                      </td>
                    </>
                  )}
                  <td>{summary.green}</td>
                  <td>{summary.yellow}</td>
                  <td>{summary.red}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => onOpen({ id: group.id, name: group.name })}
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

function columns(lens: Lens) {
  const first = [
    {
      key: "reference",
      label:
        lens === "placement"
          ? "Indent no"
          : lens === "collection"
            ? "Invoice no"
            : lens === "vendor-payable"
              ? "Vendor invoice"
              : lens === "trip"
                ? "Trip no"
                : "Trip no",
    },
  ];
  if (lens === "placement")
    return [
      ...first,
      { key: "truckType", label: "Truck type" },
      { key: "vendors", label: "Vendor" },
      { key: "vehicles", label: "Vehicle no" },
      { key: "drivers", label: "Driver" },
      { key: "dueAt", label: "Indent due" },
      { key: "placedAt", label: "Placed at" },
      { key: "age", label: "Ageing" },
      { key: "risk", label: "Status" },
    ];
  if (lens === "pod")
    return [
      ...first,
      { key: "secondaryReference", label: "LR no" },
      { key: "invoiceReferences", label: "Invoice no" },
      { key: "valueMinor", label: "Invoice value" },
      { key: "vehicle", label: "Vehicle no" },
      { key: "truckType", label: "Truck type" },
      { key: "loadedAt", label: "Loaded" },
      { key: "dueAt", label: "Delivered" },
      { key: "completedAt", label: "POD in" },
      { key: "age", label: "Ageing" },
      { key: "risk", label: "Status" },
    ];
  if (lens === "collection")
    return [
      ...first,
      { key: "submittedAt", label: "Submitted" },
      { key: "age", label: "Outstanding" },
      { key: "valueMinor", label: "Invoice amount" },
      { key: "receivedMinor", label: "Received" },
      { key: "balanceMinor", label: "Due" },
      { key: "hold", label: "Hold reason" },
      { key: "nextFollowupAt", label: "Next follow-up" },
      { key: "risk", label: "Status" },
    ];
  if (lens === "trip")
    return [
      ...first,
      { key: "secondaryReference", label: "LR no" },
      { key: "state", label: "Stage" },
      { key: "vehicle", label: "Vehicle" },
      { key: "driver", label: "Driver" },
      { key: "dueAt", label: "Planned delivery" },
      { key: "lastGpsAt", label: "Last GPS" },
      { key: "lastEvent", label: "Latest event" },
      { key: "risk", label: "Risk" },
    ];
  return [
    ...first,
    { key: "client", label: "Vendor" },
    { key: "state", label: "Workflow" },
    { key: "valueMinor", label: "Payable" },
    { key: "balanceMinor", label: "Outstanding" },
    { key: "dueAt", label: "Invoice date" },
    { key: "age", label: "Ageing" },
    { key: "risk", label: "Risk" },
  ];
}
function cell(row: Row, key: string, access: Access | null) {
  if (key === "risk")
    return (
      <span className={`${styles.status} ${styles[row.colour]}`}>
        {row.colour}
      </span>
    );
  if (["valueMinor", "receivedMinor", "balanceMinor"].includes(key))
    return (
      <span className={styles.money}>
        {money(row[key], access?.currency, access?.locale)}
      </span>
    );
  if (
    [
      "dueAt",
      "placedAt",
      "loadedAt",
      "completedAt",
      "submittedAt",
      "nextFollowupAt",
      "lastGpsAt",
    ].includes(key)
  )
    return dateTime(row[key], access);
  if (key === "age")
    return row.ageHours != null
      ? `${row.ageHours} hours`
      : row.ageDays != null
        ? `${row.ageDays} days`
        : "—";
  return String(row[key] ?? "—");
}
function RecordTable({
  lens,
  rows,
  access,
}: {
  lens: Lens;
  rows: Row[];
  access: Access | null;
}) {
  const fields = columns(lens);
  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2>{meta[lens].record} register</h2>
          <p className="muted">
            Canonical rows in the current filters and drill scope.
          </p>
        </div>
        <span>{rows.length} records</span>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {fields.map((field) => (
                <th key={field.key}>{field.label}</th>
              ))}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {fields.map((field) => (
                  <td key={field.key}>{cell(row, field.key, access)}</td>
                ))}
                <td>
                  <Link className={styles.actionLink} href={href(lens, row)}>
                    Open in{" "}
                    {lens === "placement" || lens === "trip"
                      ? "Operations"
                      : lens === "pod"
                        ? "POD"
                        : "Finance"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
function AgeingBoard({
  buckets,
  access,
  onOpen,
}: {
  buckets: Bucket[];
  access: Access | null;
  onOpen: (bucket: string) => void;
}) {
  const labels = {
      CURRENT: "0–30 days",
      "31_45": "31–45 days",
      "46_90": "46–90 days",
      OVER_90: "Beyond 90 days",
    },
    masked = buckets.some((bucket) => bucket.amountMinor === "••••"),
    total = masked
      ? BigInt(0)
      : buckets.reduce(
          (sum, bucket) => sum + BigInt(bucket.amountMinor),
          BigInt(0),
        );
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHead}>
        <div>
          <h2>Outstanding by ageing bucket</h2>
          <p className="muted">
            Exact outstanding balance by days since invoice submission.
          </p>
        </div>
      </div>
      <div className={styles.ageing}>
        {buckets.map((bucket) => (
          <button
            type="button"
            key={bucket.bucket}
            onClick={() => onOpen(bucket.bucket)}
          >
            <span>{labels[bucket.bucket]}</span>
            <strong>
              {money(bucket.amountMinor, access?.currency, access?.locale)}
            </strong>
            <small>
              {bucket.count} invoices ·{" "}
              {masked
                ? "masked"
                : `${
                    total
                      ? Number(
                          (BigInt(bucket.amountMinor) * BigInt(10000)) / total,
                        ) / 100
                      : 0
                  }%`}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}
function VendorAllocation({
  vendors,
}: {
  vendors: Array<Record<string, unknown>>;
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHead}>
        <div>
          <h2>Vendor allocation</h2>
          <p className="muted">
            NTP means allotted capacity without a placed truck.
          </p>
        </div>
        <Link href="/app/operations/allocations">Open allocation register</Link>
      </div>
      <div className={styles.vendors}>
        {vendors.map((vendor) => (
          <article className={styles.vendor} key={String(vendor.id)}>
            <strong>{String(vendor.vendor)}</strong>
            <dl>
              <div>
                <dt>Allotted</dt>
                <dd>{String(vendor.allotted)}</dd>
              </div>
              <div>
                <dt>Placed</dt>
                <dd>{String(vendor.placed)}</dd>
              </div>
              <div>
                <dt>NTP</dt>
                <dd>{String(vendor.ntp)}</dd>
              </div>
            </dl>
            <Link href="/app/operations/allocations">Review allocations</Link>
          </article>
        ))}
      </div>
    </section>
  );
}
function LoadingRows() {
  return (
    <div role="status" className={styles.loading}>
      <span />
      <span />
      <span />
      <p>Refreshing permission-scoped canonical metrics…</p>
    </div>
  );
}
