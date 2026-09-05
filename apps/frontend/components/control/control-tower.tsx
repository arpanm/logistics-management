"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import { FilterChip, MetricCard, Tabs } from "../ui/primitives";
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
  kpis: Record<string, unknown>;
  kpiActions: Record<string, string>;
  rows: Row[];
  portfolios: Summary[];
  locations: Summary[];
  vendors: VendorAllocationRow[];
  ageing: Bucket[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    hasPrevious: boolean;
    hasNext: boolean;
    sort: string;
    direction: "asc" | "desc";
  };
};
type Summary = {
  id: string;
  name: string;
  recordCount: number;
  locationCount?: number;
  green: number;
  yellow: number;
  red: number;
  demand: number;
  placed: number;
  valueMinor: string;
  balanceMinor: string;
  signals?: SummarySignal[];
};
type SummarySignal = {
  id: string;
  name: string;
  colour: Risk;
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
type VendorAllocationRow = {
  id: string;
  vendor: string;
  allotted: number;
  placed: number;
  ntp: number;
};
type SettledDashboard = { requestKey: string; data: Data };
type ActiveRequest = { requestKey: string; requestId: number };

export function controlDashboardRequestKey(lens: Lens, query: string) {
  return `${lens}?${query}`;
}

export function isCurrentControlDashboardRequest(
  active: ActiveRequest,
  requestKey: string,
  requestId: number,
  aborted = false,
) {
  return (
    !aborted &&
    active.requestKey === requestKey &&
    active.requestId === requestId
  );
}

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

function kpiTone(key: string) {
  if (["green", "received", "paid", "closureRate", "fillRate"].includes(key))
    return "success" as const;
  if (
    ["yellow", "awaiting", "pendingCurrent", "approvalPending", "due"].includes(
      key,
    )
  )
    return "warning" as const;
  if (
    [
      "red",
      "pendingPrior",
      "over45Count",
      "over45Minor",
      "delayed",
      "paymentBlocked",
      "disputed",
      "overdue",
    ].includes(key)
  )
    return "danger" as const;
  return "accent" as const;
}

function money(minor: unknown, currency = "INR", locale = "en-IN") {
  if (minor === "••••") return "••••";
  const value = minorValue(minor);
  if (value === null) return "—";
  const absolute = value < BigInt(0) ? -value : value;
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  const formatted = `${symbol}${(absolute / BigInt(100)).toLocaleString(locale)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
  return value < BigInt(0) ? `-${formatted}` : formatted;
}
function minorValue(value: unknown) {
  if (value === null || value === undefined || value === "" || value === "••••")
    return null;
  const raw = String(value).trim();
  return /^-?\d+$/.test(raw) ? BigInt(raw) : null;
}
function count(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
function normalizeSummary(value: Partial<Summary>): Summary {
  const signals = Array.isArray(value.signals)
    ? value.signals
        .filter(
          (signal): signal is SummarySignal =>
            Boolean(signal) &&
            typeof signal.id === "string" &&
            typeof signal.name === "string" &&
            ["GREEN", "YELLOW", "RED"].includes(String(signal.colour)),
        )
        .map((signal) => ({
          id: signal.id,
          name: signal.name,
          colour: signal.colour,
        }))
    : [];
  return {
    id: String(value.id ?? "unknown"),
    name: String(value.name ?? "Unnamed portfolio"),
    recordCount: count(value.recordCount),
    locationCount: count(value.locationCount),
    green: count(value.green),
    yellow: count(value.yellow),
    red: count(value.red),
    demand: count(value.demand),
    placed: count(value.placed),
    valueMinor:
      value.valueMinor === "••••" ? "••••" : String(value.valueMinor ?? "0"),
    balanceMinor:
      value.balanceMinor === "••••"
        ? "••••"
        : String(value.balanceMinor ?? "0"),
    signals,
  };
}
function normalizeVendor(value: Record<string, unknown>): VendorAllocationRow {
  return {
    id: String(value.id),
    vendor: String(value.vendor),
    allotted: count(value.allotted),
    placed: count(value.placed),
    ntp: count(value.ntp),
  };
}
function invalidDashboard(message: string): never {
  throw {
    code: "CONTROL_RESPONSE_INVALID",
    message: `Control Tower data could not be displayed safely: ${message}`,
  } satisfies ApiError;
}
function parseDashboard(value: unknown, requestedLens: Lens): Data {
  if (!value || typeof value !== "object")
    return invalidDashboard("the response was not an object");
  const candidate = value as Partial<Data>;
  if (candidate.lens !== requestedLens)
    return invalidDashboard("the response lens did not match the selected tab");
  if (
    !candidate.freshness ||
    !["LIVE", "DELAYED"].includes(String(candidate.freshness.state)) ||
    (candidate.freshness.lastCanonicalChange !== null &&
      typeof candidate.freshness.lastCanonicalChange !== "string")
  )
    return invalidDashboard("freshness metadata was missing or invalid");
  if (
    !candidate.pagination ||
    !["page", "pageSize", "total", "pageCount"].every((key) =>
      Number.isFinite(
        Number(candidate.pagination?.[key as keyof Data["pagination"]]),
      ),
    )
  )
    return invalidDashboard("pagination metadata was missing or invalid");
  if (
    !Array.isArray(candidate.rows) ||
    candidate.rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.reference !== "string" ||
        typeof row.state !== "string" ||
        !["GREEN", "YELLOW", "RED"].includes(String(row.colour)),
    )
  )
    return invalidDashboard("one or more canonical rows were malformed");
  if (
    !Array.isArray(candidate.vendors) ||
    candidate.vendors.some(
      (vendor) =>
        !vendor ||
        typeof vendor.id !== "string" ||
        !vendor.id ||
        typeof vendor.vendor !== "string" ||
        !vendor.vendor ||
        ![vendor.allotted, vendor.placed, vendor.ntp].every((entry) =>
          Number.isFinite(Number(entry)),
        ),
    )
  )
    return invalidDashboard("vendor allocation totals were incomplete");
  if (
    !Array.isArray(candidate.portfolios) ||
    !Array.isArray(candidate.locations) ||
    !Array.isArray(candidate.ageing) ||
    !candidate.kpis ||
    typeof candidate.kpis !== "object" ||
    !candidate.kpiActions ||
    typeof candidate.kpiActions !== "object" ||
    typeof candidate.asOf !== "string"
  )
    return invalidDashboard("dashboard summaries were incomplete");
  return candidate as Data;
}
function dateTime(value: unknown, access: Access | null) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(access?.locale ?? "en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: access?.timezone ?? "Asia/Kolkata",
  }).format(parsed);
}
function href(lens: Lens, row: Row) {
  const search = encodeURIComponent(row.reference);
  if (lens === "placement") return `/app/operations/indents?search=${search}`;
  if (lens === "pod") return "/app/pod";
  if (lens === "collection") return `/app/finance/invoices?search=${search}`;
  if (lens === "trip") return `/app/operations/trips?search=${search}`;
  return `/app/finance/vendor-bills?search=${search}`;
}

function ActionIcon({
  name,
}: {
  name: "pause" | "play" | "save" | "download";
}) {
  const path =
    name === "pause"
      ? "M9 6v12M15 6v12"
      : name === "play"
        ? "m9 6 9 6-9 6Z"
        : name === "save"
          ? "M5 4h12l2 2v14H5Zm3 0v6h8V4m-8 16v-6h8v6"
          : "M12 4v11m-4-4 4 4 4-4M5 20h14";
  return (
    <svg
      className={styles.actionIcon}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function ControlTower() {
  const [access, setAccess] = useState<Access | null>(null),
    [lens, setLens] = useState<Lens>("placement"),
    [settledDashboard, setSettledDashboard] = useState<SettledDashboard | null>(
      null,
    ),
    [views, setViews] = useState<View[]>([]),
    [error, setError] = useState<ApiError | null>(null),
    [errorRequestKey, setErrorRequestKey] = useState(""),
    [initialLoading, setInitialLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [refreshFailure, setRefreshFailure] = useState<{
      error: ApiError;
      failedAt: string;
    } | null>(null);
  const [search, setSearch] = useState(""),
    [colour, setColour] = useState(""),
    [state, setState] = useState(""),
    [ageingBucket, setAgeingBucket] = useState(""),
    [client, setClient] = useState<Drill | null>(null),
    [location, setLocation] = useState<Drill | null>(null);
  const [paused, setPaused] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false),
    [saveOpen, setSaveOpen] = useState(false),
    [viewName, setViewName] = useState(""),
    [saving, setSaving] = useState(false),
    [selectedView, setSelectedView] = useState(""),
    [selectedKpi, setSelectedKpi] = useState(""),
    [kpiPredicate, setKpiPredicate] = useState(""),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [sort, setSort] = useState("updatedAt"),
    [direction, setDirection] = useState<"asc" | "desc">("desc"),
    [urlReady, setUrlReady] = useState(false);
  const initializedFromUrl = useRef(false);
  const settledRequestKey = useRef<string | null>(null);
  const requestSequence = useRef(0);
  const activeRequest = useRef<ActiveRequest>({
    requestKey: "",
    requestId: 0,
  });
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...(search ? { search } : {}),
        ...(colour ? { colour } : {}),
        ...(state ? { state } : {}),
        ...(ageingBucket ? { ageingBucket } : {}),
        ...(client ? { clientId: client.id } : {}),
        ...(location ? { locationId: location.id } : {}),
        ...(kpiPredicate ? { kpi: kpiPredicate } : {}),
        page: String(page),
        pageSize: String(pageSize),
        sort,
        direction,
      }).toString(),
    [
      search,
      colour,
      state,
      ageingBucket,
      client,
      location,
      kpiPredicate,
      page,
      pageSize,
      sort,
      direction,
    ],
  );
  const requestKey = controlDashboardRequestKey(lens, query);
  const data =
    settledDashboard?.requestKey === requestKey ? settledDashboard.data : null;
  const scopeTransition = Boolean(
    activeRequest.current.requestKey !== requestKey ||
      (settledDashboard && settledDashboard.requestKey !== requestKey),
  );
  const visibleError =
    error && (errorRequestKey === "access" || errorRequestKey === requestKey)
      ? error
      : null;

  useEffect(() => {
    if (initializedFromUrl.current) return;
    initializedFromUrl.current = true;
    const params = new URLSearchParams(window.location.search);
    const requestedLens = params.get("lens") as Lens | null;
    if (requestedLens && requestedLens in meta) setLens(requestedLens);
    setSearch(params.get("search") ?? "");
    setColour(params.get("colour") ?? "");
    setState(params.get("state") ?? "");
    setAgeingBucket(params.get("ageingBucket") ?? "");
    const requestedPage = Number(params.get("page") ?? 1);
    const requestedPageSize = Number(params.get("pageSize") ?? 25);
    const requestedSort = params.get("sort") ?? "updatedAt";
    setPage(
      Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    );
    setPageSize(
      [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25,
    );
    setSort(
      [
        "reference",
        "client",
        "state",
        "risk",
        "dueAt",
        "updatedAt",
        "value",
        "balance",
      ].includes(requestedSort)
        ? requestedSort
        : "updatedAt",
    );
    setDirection(params.get("direction") === "asc" ? "asc" : "desc");
    setKpiPredicate(params.get("kpi") ?? "");
    const clientId = params.get("clientId"),
      locationId = params.get("locationId");
    setClient(clientId ? { id: clientId, name: "Shared client scope" } : null);
    setLocation(
      locationId ? { id: locationId, name: "Shared location scope" } : null,
    );
    window.requestAnimationFrame(() => setUrlReady(true));
  }, []);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const syncFilterDisclosure = (matches: boolean) => setFiltersOpen(matches);
    syncFilterDisclosure(desktop.matches);
    const listener = (event: MediaQueryListEvent) =>
      syncFilterDisclosure(event.matches);
    desktop.addEventListener("change", listener);
    return () => desktop.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    const next = new URLSearchParams(query);
    next.set("lens", lens);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${next}`,
    );
  }, [lens, query, urlReady]);

  useEffect(() => {
    let mounted = true;
    api<Access>("/control-workbench/access")
      .then((value) => {
        if (!mounted) return;
        setAccess(value);
        if (value.lenses[0])
          setLens((current) =>
            value.lenses.includes(current) ? current : value.lenses[0]!,
          );
      })
      .catch((value) => {
        if (!mounted) return;
        setError(value as ApiError);
        setErrorRequestKey("access");
        setInitialLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const load = useCallback(
    async (signal?: AbortSignal, background = false) => {
      if (!access?.lenses.includes(lens)) return;
      const loadRequestKey = requestKey;
      const requestId = ++requestSequence.current;
      activeRequest.current = { requestKey: loadRequestKey, requestId };
      const sameKeySettled = settledRequestKey.current === loadRequestKey;
      if (background && sameKeySettled) setRefreshing(true);
      else {
        setInitialLoading(true);
        setRefreshing(false);
        setRefreshFailure(null);
        setError(null);
        setErrorRequestKey("");
      }
      try {
        const [payload, saved] = await Promise.all([
          api<unknown>(`/control-workbench/${lens}?${query}`, { signal }),
          api<View[]>(`/control-workbench/${lens}/views`, { signal }),
        ]);
        if (
          !isCurrentControlDashboardRequest(
            activeRequest.current,
            loadRequestKey,
            requestId,
            signal?.aborted,
          )
        )
          return;
        const dashboard = parseDashboard(payload, lens);
        setSettledDashboard({
          requestKey: loadRequestKey,
          data: {
            ...dashboard,
            kpis:
              dashboard.kpis && typeof dashboard.kpis === "object"
                ? dashboard.kpis
                : {},
            kpiActions:
              dashboard.kpiActions && typeof dashboard.kpiActions === "object"
                ? dashboard.kpiActions
                : {},
            rows: Array.isArray(dashboard.rows) ? dashboard.rows : [],
            portfolios: Array.isArray(dashboard.portfolios)
              ? dashboard.portfolios.map(normalizeSummary)
              : [],
            locations: Array.isArray(dashboard.locations)
              ? dashboard.locations.map(normalizeSummary)
              : [],
            vendors: Array.isArray(dashboard.vendors)
              ? dashboard.vendors.map(normalizeVendor)
              : [],
            ageing: Array.isArray(dashboard.ageing)
              ? dashboard.ageing.filter(
                  (bucket) =>
                    ["CURRENT", "31_45", "46_90", "OVER_90"].includes(
                      bucket.bucket,
                    ) && Number.isFinite(Number(bucket.count)),
                )
              : [],
          },
        });
        settledRequestKey.current = loadRequestKey;
        if (kpiPredicate)
          setSelectedKpi(
            Object.entries(dashboard.kpiActions ?? {}).find(
              ([, predicate]) => predicate === kpiPredicate,
            )?.[0] ?? "",
          );
        setViews(saved);
        setError(null);
        setErrorRequestKey("");
        setRefreshFailure(null);
      } catch (value) {
        if (
          !isCurrentControlDashboardRequest(
            activeRequest.current,
            loadRequestKey,
            requestId,
            signal?.aborted,
          )
        )
          return;
        if (sameKeySettled)
          setRefreshFailure({
            error: value as ApiError,
            failedAt: new Date().toISOString(),
          });
        else {
          setSettledDashboard(null);
          settledRequestKey.current = null;
          setError(value as ApiError);
          setErrorRequestKey(loadRequestKey);
        }
      } finally {
        if (
          isCurrentControlDashboardRequest(
            activeRequest.current,
            loadRequestKey,
            requestId,
            signal?.aborted,
          )
        ) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    },
    [access, lens, query, kpiPredicate, requestKey],
  );
  useEffect(() => {
    const controller = new AbortController();
    const debounce = window.setTimeout(
      () =>
        void load(controller.signal, settledRequestKey.current === requestKey),
      250,
    );
    const interval =
      !paused && access
        ? window.setInterval(
            () => void load(controller.signal, true),
            access.refreshSeconds * 1000,
          )
        : undefined;
    return () => {
      controller.abort();
      window.clearTimeout(debounce);
      if (interval) window.clearInterval(interval);
    };
  }, [access, load, paused, requestKey]);

  const resetDrill = () => {
    setClient(null);
    setLocation(null);
    setPage(1);
  };
  function changeLens(value: Lens) {
    if (value === lens) return;
    setError(null);
    setInitialLoading(true);
    setLens(value);
    setColour("");
    setState("");
    setAgeingBucket("");
    setSelectedView("");
    setSelectedKpi("");
    setKpiPredicate("");
    setPage(1);
    setSort("updatedAt");
    setDirection("desc");
    resetDrill();
  }
  function applyView(view?: View) {
    if (!view) return;
    setSelectedView(view.id);
    setPage(1);
    setSearch(view.filters.search ?? "");
    setColour(view.filters.colour ?? "");
    setState(view.filters.state ?? "");
    setAgeingBucket(view.filters.ageingBucket ?? "");
    setKpiPredicate(view.filters.kpi ?? "");
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
        successFeedback: "View saved.",
        body: JSON.stringify({
          name: viewName.trim(),
          filters: {
            search,
            ...(colour ? { colour } : {}),
            ...(state ? { state } : {}),
            ...(ageingBucket ? { ageingBucket } : {}),
            ...(client ? { clientId: client.id } : {}),
            ...(location ? { locationId: location.id } : {}),
            ...(kpiPredicate ? { kpi: kpiPredicate } : {}),
          },
          isDefault: false,
        }),
      });
      setViewName("");
      setSaveOpen(false);
      await load(undefined, true);
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
    const predicate = data?.kpiActions[key];
    if (!predicate) return;
    setSelectedKpi(key);
    setKpiPredicate(predicate);
    setPage(1);
    resetDrill();
  }
  const clear = () => {
    setSearch("");
    setColour("");
    setState("");
    setAgeingBucket("");
    setSelectedKpi("");
    setKpiPredicate("");
    setSelectedView("");
    setPage(1);
    resetDrill();
  };
  const states = [
    ...new Set((data?.rows ?? []).map((row) => row.state)),
  ].sort();
  const activeFilterCount = [
    search,
    colour,
    state,
    ageingBucket,
    selectedView,
    kpiPredicate,
  ].filter(Boolean).length;

  return (
    <Shell>
      <div className={styles.page}>
        <header className={styles.head}>
          <div className={styles.headCopy}>
            <p className="eyebrow">CTL-01 · operational command view</p>
            <h1>Control tower</h1>
            <p className={styles.headSubtitle}>Portfolio risk to workflow.</p>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => setPaused((value) => !value)}
              aria-pressed={paused}
              aria-label={paused ? "Resume live refresh" : "Pause live refresh"}
              title={paused ? "Resume live refresh" : "Pause live refresh"}
            >
              <ActionIcon name={paused ? "play" : "pause"} />
              <span className={styles.actionLabel}>
                {paused ? "Resume live refresh" : "Pause live refresh"}
              </span>
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => setSaveOpen((value) => !value)}
              aria-expanded={saveOpen}
              aria-controls="control-save-view"
              aria-label="Save current view"
              title="Save current view"
            >
              <ActionIcon name="save" />
              <span className={styles.actionLabel}>Save current view</span>
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => void exportCsv()}
              disabled={!data || initialLoading}
              aria-label="Download matching CSV"
              title="Download matching CSV"
            >
              <ActionIcon name="download" />
              <span className={styles.actionLabel}>Download matching CSV</span>
            </button>
          </div>
        </header>
        {access?.lenses.length ? (
          <Tabs
            label="Control tower lens"
            idPrefix="control-tab"
            panelId="control-panel"
            items={access.lenses.map((value) => ({
              id: value,
              label: meta[value].label,
            }))}
            active={lens}
            onChange={changeLens}
          />
        ) : !visibleError ? (
          <section className={styles.panel}>
            <p>
              No control-tower lens is enabled for your current role and scope.
            </p>
          </section>
        ) : null}
        <section className={styles.lensIntro}>
          <div>
            <h2>{meta[lens].label}</h2>
            <p className={styles.lensDescription}>{meta[lens].description}</p>
          </div>
          <details className={styles.guidance}>
            <summary>Ageing guide</summary>
            <p>{meta[lens].guidance}</p>
          </details>
        </section>
        <details
          className={`${styles.panel} ${styles.filterDisclosure}`}
          open={filtersOpen}
          onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
        >
          <summary className={styles.filterSummary}>
            <span className={styles.filterSummaryText}>Search and filters</span>
            <span className={styles.filterCount}>
              {activeFilterCount
                ? `${activeFilterCount} active`
                : "Search, risk, status and sort"}
            </span>
          </summary>
          <div
            className={`${styles.toolbar} ${styles.filterBody}`}
            id="control-view-filters"
            aria-label="View filters"
          >
            <label>
              Search visible scope
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Client, location, reference, vehicle or vendor"
              />
            </label>
            <label>
              Traffic light
              <select
                value={colour}
                onChange={(event) => {
                  setColour(event.target.value);
                  setPage(1);
                }}
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
                onChange={(event) => {
                  setState(event.target.value);
                  setPage(1);
                }}
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
                  onChange={(event) => {
                    setAgeingBucket(event.target.value);
                    setPage(1);
                  }}
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
                value={selectedView}
                onChange={(event) => {
                  setSelectedView(event.target.value);
                  applyView(
                    views.find((view) => view.id === event.target.value),
                  );
                }}
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
            <label>
              Sort records
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setPage(1);
                }}
              >
                <option value="updatedAt">Recently changed</option>
                <option value="reference">Reference</option>
                <option value="client">Client / vendor</option>
                <option value="state">Workflow status</option>
                <option value="risk">Risk</option>
                <option value="dueAt">Critical date</option>
                {lens !== "placement" && lens !== "trip" && (
                  <option value="value">Value</option>
                )}
                {(lens === "collection" || lens === "vendor-payable") && (
                  <option value="balance">Outstanding</option>
                )}
              </select>
            </label>
            <label>
              Direction
              <select
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value as "asc" | "desc");
                  setPage(1);
                }}
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
            <label>
              Rows per page
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <button type="button" className={styles.clear} onClick={clear}>
              Clear filters
            </button>
          </div>
        </details>
        {saveOpen && (
          <form
            className={`${styles.panel} ${styles.saveForm}`}
            id="control-save-view"
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
              className={`${styles.freshDot} ${!refreshFailure && data.freshness.state === "LIVE" ? styles.live : styles.delayed}`}
              aria-hidden="true"
            />
            <strong>
              {refreshFailure
                ? "REFRESH FAILED"
                : refreshing
                  ? "REFRESHING"
                  : paused
                    ? "PAUSED"
                    : data.freshness.state}
            </strong>
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
        {refreshFailure && data && (
          <div className={styles.staleNotice} role="alert">
            <div>
              <strong>Showing the last permitted result.</strong>
              <span>
                {" "}
                Refresh failed at {dateTime(refreshFailure.failedAt, access)};
                counts and freshness may now be stale.
              </span>
              {refreshFailure.error.correlationId && (
                <small>
                  {" "}
                  Correlation: {refreshFailure.error.correlationId}
                </small>
              )}
            </div>
            <button type="button" onClick={() => void load(undefined, true)}>
              Retry refresh
            </button>
          </div>
        )}
        {visibleError && (
          <div className="error" role="alert">
            <p>{visibleError.message}</p>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {data && (
          <section
            className={`${styles.metrics} ui-metric-grid`}
            aria-label={`${meta[lens].label} key performance indicators`}
          >
            {Object.entries(data.kpis).map(([key, value]) => {
              const shown = moneyKeys.has(key)
                ? money(value, access?.currency, access?.locale)
                : value === null ||
                    value === undefined ||
                    typeof value === "object"
                  ? "—"
                  : `${String(value)}${percentKeys.has(key) ? "%" : ""}`;
              return (
                <MetricCard
                  key={key}
                  label={kpiNames[key] ?? key}
                  value={shown}
                  help={
                    data.kpiActions[key]
                      ? "Open exact matching records"
                      : "Summary metric"
                  }
                  tone={kpiTone(key)}
                  selected={selectedKpi === key}
                  onClick={
                    data.kpiActions[key] ? () => drillKpi(key) : undefined
                  }
                />
              );
            })}
          </section>
        )}
        {lens === "collection" && data?.ageing.length ? (
          <AgeingBoard
            buckets={data.ageing}
            access={access}
            onOpen={(bucket) => {
              setAgeingBucket(bucket);
              setPage(1);
            }}
          />
        ) : null}
        {(search ||
          colour ||
          state ||
          ageingBucket ||
          selectedKpi ||
          kpiPredicate) && (
          <div
            className={styles.activeFilters}
            role="status"
            aria-label="Applied filters"
          >
            <strong>Showing:</strong>
            {selectedKpi && (
              <FilterChip label={kpiNames[selectedKpi] ?? selectedKpi} />
            )}
            {!selectedKpi && kpiPredicate && (
              <FilterChip label={`KPI: ${kpiPredicate.replaceAll("-", " ")}`} />
            )}
            {search && <FilterChip label={`Search: ${search}`} />}
            {colour && <FilterChip label={`Risk: ${colour}`} />}
            {state && <FilterChip label={`Status: ${state}`} />}
            {ageingBucket && (
              <FilterChip
                label={`Ageing: ${ageingBucket.replaceAll("_", "–")}`}
              />
            )}
            <button type="button" onClick={clear}>
              Clear
            </button>
          </div>
        )}
        <nav className={styles.crumbs} aria-label="Drill-down breadcrumb">
          <button type="button" onClick={resetDrill}>
            All {lens === "vendor-payable" ? "vendors" : "clients"}
          </button>
          {client && (
            <>
              <span aria-hidden="true">›</span>
              <button
                type="button"
                onClick={() => {
                  setLocation(null);
                  setPage(1);
                }}
              >
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
          id="control-panel"
          role="tabpanel"
          aria-labelledby={`control-tab-${lens}`}
          aria-busy={initialLoading || scopeTransition}
          aria-live="polite"
        >
          {initialLoading || scopeTransition ? (
            <LoadingRows />
          ) : !data || data.pagination.total === 0 ? (
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
              summaries={data.portfolios}
              access={access}
              onOpen={(value) => {
                setClient(value);
                setPage(1);
              }}
            />
          ) : !location ? (
            <LocationBoard
              lens={lens}
              summaries={data.locations}
              access={access}
              onOpen={(value) => {
                setLocation(value);
                setPage(1);
              }}
            />
          ) : (
            <RecordTable
              lens={lens}
              rows={data.rows}
              total={data.pagination.total}
              access={access}
            />
          )}
        </section>
        {location && data && data.pagination.pageCount > 1 && (
          <nav className={styles.pagination} aria-label="Record result pages">
            <span>
              Page {data.pagination.page} of {data.pagination.pageCount} ·{" "}
              {data.pagination.total} records
            </span>
            <div>
              <button
                type="button"
                disabled={!data.pagination.hasPrevious || refreshing}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!data.pagination.hasNext || refreshing}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </button>
            </div>
          </nav>
        )}
        {lens === "placement" && data?.vendors.length ? (
          <VendorAllocation vendors={data.vendors} />
        ) : null}
      </div>
    </Shell>
  );
}

function summaryRisk(summary: Summary): Risk {
  return summary.red ? "RED" : summary.yellow ? "YELLOW" : "GREEN";
}
function summaryFill(summary: Summary) {
  return summary.demand
    ? Math.round((summary.placed * 10_000) / summary.demand) / 100
    : 0;
}

function summaryMonogram(name: string) {
  const ignored = new Set(["private", "limited", "ltd", "pvt", "llp"]);
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignored.has(word.toLowerCase()));
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function summaryStatusLabel(lens: Lens, risk: Risk) {
  const labels: Record<Lens, Record<Risk, string>> = {
    placement: {
      GREEN: "On time",
      YELLOW: "24–48 hrs",
      RED: "Over 48 hrs",
    },
    pod: {
      GREEN: "On track",
      YELLOW: "8–15 days",
      RED: "Over 15 days",
    },
    collection: {
      GREEN: "Current",
      YELLOW: "31–45 days",
      RED: "Over 45 days",
    },
    trip: { GREEN: "On track", YELLOW: "At risk", RED: "Delayed" },
    "vendor-payable": {
      GREEN: "On track",
      YELLOW: "Due soon",
      RED: "Exception",
    },
  };
  return labels[lens][risk];
}

function summaryRecordLabel(lens: Lens, value: number) {
  const noun: Record<Lens, string> = {
    placement: "indent",
    pod: "delivery",
    collection: "invoice",
    trip: "trip",
    "vendor-payable": "vendor bill",
  };
  return `${value} ${noun[lens]}${value === 1 ? "" : "s"}`;
}

function PortfolioBoard({
  lens,
  summaries,
  access,
  onOpen,
}: {
  lens: Lens;
  summaries: Summary[];
  access: Access | null;
  onOpen: (value: Drill) => void;
}) {
  return (
    <>
      <div className={styles.sectionHead}>
        <div className={styles.portfolioTitle}>
          <h2>
            {lens === "vendor-payable"
              ? "Vendor portfolio"
              : "Client portfolio"}
          </h2>
          <p>{summaries.length} scoped portfolios</p>
        </div>
      </div>
      <div className={styles.clients}>
        {summaries.map((summary) => {
          const worst = summaryRisk(summary);
          const signals = summary.signals ?? [];
          return (
            <button
              type="button"
              className={styles.client}
              key={summary.id}
              onClick={() => onOpen({ id: summary.id, name: summary.name })}
            >
              <span className="sr-only">
                Open {summary.name}. {summary.locationCount ?? 0} locations.{" "}
                {summaryRecordLabel(lens, summary.recordCount)}. Status{" "}
                {summaryStatusLabel(lens, worst)}. Green {summary.green}, yellow{" "}
                {summary.yellow}, red {summary.red}.
                {signals.length
                  ? ` Location signals: ${signals
                      .map(
                        (signal) =>
                          `${signal.name}, ${summaryStatusLabel(lens, signal.colour)}`,
                      )
                      .join("; ")}.`
                  : ""}
              </span>
              <div className={styles.cardHead}>
                <div className={styles.clientIdentity}>
                  <span className={styles.clientMonogram} aria-hidden="true">
                    {summaryMonogram(summary.name)}
                  </span>
                  <div className={styles.clientTitle}>
                    <h3>{summary.name}</h3>
                    <p className={styles.clientMeta}>
                      {summary.locationCount ?? 0}{" "}
                      {(summary.locationCount ?? 0) === 1
                        ? "location"
                        : "locations"}{" "}
                      · {summaryRecordLabel(lens, summary.recordCount)}
                    </p>
                  </div>
                </div>
                <span className={`${styles.status} ${styles[worst]}`}>
                  {summaryStatusLabel(lens, worst)}
                </span>
              </div>
              {signals.length > 0 && (
                <div className={styles.clientDots} aria-hidden="true">
                  {signals.map((signal) => (
                    <span
                      key={signal.id}
                      className={`${styles.clientDot} ${styles[signal.colour]}`}
                      title={`${signal.name}: ${summaryStatusLabel(lens, signal.colour)}`}
                    />
                  ))}
                </div>
              )}
              <div className={styles.clientFooter}>
                <div
                  className={styles.clientCounts}
                  aria-label={`Green ${summary.green}, yellow ${summary.yellow}, red ${summary.red}`}
                >
                  <span className={styles.GREEN}>
                    G <b>{summary.green}</b>
                  </span>
                  <span className={styles.YELLOW}>
                    Y <b>{summary.yellow}</b>
                  </span>
                  <span className={styles.RED}>
                    R <b>{summary.red}</b>
                  </span>
                </div>
                {lens === "placement" ? (
                  <span className={styles.clientMeasure}>
                    Fill <b>{summaryFill(summary)}%</b>
                  </span>
                ) : (
                  <span className={styles.clientMeasure}>
                    Open{" "}
                    <b>
                      {money(
                        summary.balanceMinor,
                        access?.currency,
                        access?.locale,
                      )}
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
  summaries,
  access,
  onOpen,
}: {
  lens: Lens;
  summaries: Summary[];
  access: Access | null;
  onOpen: (value: Drill) => void;
}) {
  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2>
            {lens === "vendor-payable" ? "Vendor accounts" : "Location board"}
          </h2>
          <p className="muted">
            Select a server-projected summary to open its paged register.
          </p>
        </div>
        <span>{summaries.length} locations / accounts</span>
      </div>
      <div className={styles.recordCards} aria-label="Location summaries">
        {summaries.map((summary) => {
          const worst = summaryRisk(summary);
          return (
            <article className={styles.recordCard} key={summary.id}>
              <header>
                <strong>{summary.name}</strong>
                <span className={`${styles.status} ${styles[worst]}`}>
                  {worst}
                </span>
              </header>
              <dl>
                <div>
                  <dt>Records</dt>
                  <dd>{summary.recordCount}</dd>
                </div>
                <div>
                  <dt>Green / Yellow / Red</dt>
                  <dd>
                    {summary.green} / {summary.yellow} / {summary.red}
                  </dd>
                </div>
                {lens === "placement" ? (
                  <div>
                    <dt>Fill</dt>
                    <dd>{summaryFill(summary)}%</dd>
                  </div>
                ) : (
                  <div>
                    <dt>Outstanding</dt>
                    <dd>
                      {money(
                        summary.balanceMinor,
                        access?.currency,
                        access?.locale,
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              <button
                type="button"
                onClick={() => onOpen({ id: summary.id, name: summary.name })}
              >
                View records
              </button>
            </article>
          );
        })}
      </div>
      <p className={styles.scrollHint}>Swipe or scroll for more columns.</p>
      <div
        className={styles.tableWrap}
        role="region"
        aria-label="Location results table"
        tabIndex={0}
      >
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
            {summaries.map((summary) => {
              const worst = summaryRisk(summary);
              return (
                <tr key={summary.id}>
                  <td>
                    <span className={`${styles.status} ${styles[worst]}`}>
                      {worst}
                    </span>
                  </td>
                  <td>
                    <strong>{summary.name}</strong>
                  </td>
                  <td>{summary.recordCount}</td>
                  {lens === "placement" ? (
                    <>
                      <td>{summary.placed}</td>
                      <td>{Math.max(summary.demand - summary.placed, 0)}</td>
                      <td>{summaryFill(summary)}%</td>
                    </>
                  ) : (
                    <>
                      <td>
                        {money(
                          summary.valueMinor,
                          access?.currency,
                          access?.locale,
                        )}
                      </td>
                      <td>
                        {money(
                          summary.balanceMinor,
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
                      onClick={() =>
                        onOpen({ id: summary.id, name: summary.name })
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
  total,
  access,
}: {
  lens: Lens;
  rows: Row[];
  total: number;
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
        <span>
          {total} records · {rows.length} on this page
        </span>
      </div>
      <div
        className={styles.recordCards}
        aria-label={`${meta[lens].record} records`}
      >
        {rows.map((row) => (
          <article className={styles.recordCard} key={row.id}>
            <header>
              <strong>{row.reference}</strong>
              <span className={`${styles.status} ${styles[row.colour]}`}>
                {row.colour}
              </span>
            </header>
            <dl>
              {fields.slice(1).map((field) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{cell(row, field.key, access)}</dd>
                </div>
              ))}
            </dl>
            <Link className={styles.actionLink} href={href(lens, row)}>
              Open source record
            </Link>
          </article>
        ))}
      </div>
      <p className={styles.scrollHint}>Swipe or scroll for more columns.</p>
      <div
        className={styles.tableWrap}
        role="region"
        aria-label={`${meta[lens].record} results table`}
        tabIndex={0}
      >
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
    parsed = buckets.map((bucket) => minorValue(bucket.amountMinor)),
    masked = buckets.some((bucket) => bucket.amountMinor === "••••"),
    total = parsed.some((value) => value === null)
      ? null
      : parsed.reduce<bigint>(
          (sum, value) => sum + (value ?? BigInt(0)),
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
                : total === null
                  ? "amount unavailable"
                  : `${
                      total !== BigInt(0)
                        ? Number(
                            ((minorValue(bucket.amountMinor) ?? BigInt(0)) *
                              BigInt(10000)) /
                              total,
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
function VendorAllocation({ vendors }: { vendors: VendorAllocationRow[] }) {
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
          <article className={styles.vendor} key={vendor.id}>
            <strong>{vendor.vendor}</strong>
            <dl>
              <div>
                <dt>Allotted</dt>
                <dd>{vendor.allotted}</dd>
              </div>
              <div>
                <dt>Placed</dt>
                <dd>{vendor.placed}</dd>
              </div>
              <div>
                <dt>NTP</dt>
                <dd>{vendor.ntp}</dd>
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
