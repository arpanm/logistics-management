"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import styles from "./operations.module.css";

type Mode = "dashboard" | "indents" | "allocations" | "trips";
type Item = Record<string, unknown> & {
  id: string;
  state: string;
  version: number;
};
type Ref = Record<string, unknown> & {
  id: string;
  label?: string;
  code?: string;
  name?: string;
  eligible?: boolean;
};
type Eligible = Ref & { name: string; eligible: boolean; reasons: string[] };
type Rule = {
  id: string;
  name: string;
  priority: number;
  clientId?: string;
  client?: string;
  laneId?: string;
  lane?: string;
  vendorId?: string;
  vendor?: string;
  maxVehicles: number;
  offerRateMinor?: string | null;
  offerValidMinutes: number;
  active: boolean;
  version: number;
};

const endpoint: Record<Mode, string> = {
  dashboard: "/operations/dashboard",
  indents: "/operations/indents",
  allocations: "/operations/allocations",
  trips: "/operations/trips",
};
const refLabel = (v: Ref) =>
  String(
    v.label ??
      v.code ??
      v.name ??
      v.legal_name ??
      v.legalName ??
      v.display_name ??
      v.displayName ??
      v.registration_number ??
      v.id,
  );
const localNow = (hours = 0) =>
  new Date(
    Date.now() + hours * 3_600_000 - new Date().getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 16);
const toLocal = (v: unknown) => {
  if (!v) return "";
  const d = new Date(String(v));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const iso = (v: string) => new Date(v).toISOString();
const pretty = (v: string) => v.replaceAll("_", " ");

export function OperationsWorkbench({ mode }: { mode: Mode }) {
  const [items, setItems] = useState<Item[]>([]),
    [summary, setSummary] = useState<Record<string, number>>({});
  const [search, setSearch] = useState(""),
    [state, setState] = useState(""),
    [owner, setOwner] = useState("ALL"),
    [risk, setRisk] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<string | null>(null),
    [selected, setSelected] = useState<Item | null>(null),
    [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [eligible, setEligible] = useState<Eligible[]>([]),
    [rules, setRules] = useState<Rule[]>([]),
    [openIndents, setOpenIndents] = useState<Item[]>([]),
    [refs, setRefs] = useState<Record<string, Ref[]>>({});
  const [allocationTab, setAllocationTab] = useState<"register" | "rules">(
    "register",
  );
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...(search && { search }),
        ...(state && { state }),
        ...(["dashboard", "indents"].includes(mode) &&
          owner !== "ALL" && { owner }),
        ...(mode === "dashboard" && risk && { risk }),
        limit: "200",
      }).toString(),
    [mode, owner, risk, search, state],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "dashboard") {
        const v = await api<{
          summary: Record<string, number>;
          openIndents: Item[];
        }>(`${endpoint[mode]}?${query}`);
        setSummary(v.summary);
        setItems(v.openIndents);
      } else
        setItems(
          (await api<{ items: Item[] }>(`${endpoint[mode]}?${query}`)).items,
        );
      if (mode === "allocations") {
        const [r, i] = await Promise.all([
          api<{ items: Rule[] }>("/operations/auto-allocation-rules"),
          api<{ items: Item[] }>("/operations/indents?limit=200"),
        ]);
        setRules(r.items);
        setOpenIndents(
          i.items.filter(
            (x) =>
              ["OPEN", "PARTIALLY_ALLOCATED"].includes(x.state) &&
              Number(x.remaining) > 0,
          ),
        );
      }
      setError(null);
    } catch (v) {
      setError(v as ApiError);
    } finally {
      setLoading(false);
    }
  }, [mode, query]);
  useEffect(() => void load(), [load]);

  async function getRefs(names: string[]) {
    const pairs = await Promise.all(
      names.map(
        async (n) =>
          [n, (await api<{ items: Ref[] }>(`/domain/${n}`)).items] as const,
      ),
    );
    setRefs((v) => ({ ...v, ...Object.fromEntries(pairs) }));
  }
  async function mutate(path: string, body: unknown, method = "POST") {
    setError(null);
    setNotice("");
    try {
      await api(path, {
        method,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice("Saved. The workbench has been refreshed.");
      setDialog(null);
      setSelected(null);
      setSelectedRule(null);
      await load();
    } catch (v) {
      setError(v as ApiError);
    }
  }
  const createIndent = () => {
    setSelected(null);
    void getRefs(["clients", "client-locations", "lanes"]);
    setDialog("indent-create");
  };
  const editIndent = (v: Item) => {
    setSelected(v);
    setDialog("indent-edit");
  };
  const allocate = async (v: Item) => {
    setSelected(v);
    try {
      setEligible(
        (
          await api<{ items: Eligible[] }>(
            `/operations/indents/${v.id}/eligible-vendors`,
          )
        ).items,
      );
      setDialog("allocation-create");
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const assign = async (v: Item) => {
    setSelected(v);
    try {
      const a = await api<{ vehicles: Ref[]; drivers: Ref[] }>(
        `/operations/allocations/${v.id}/eligible-assets`,
      );
      setRefs((r) => ({
        ...r,
        vehicles: a.vehicles.filter((x) => x.eligible),
        drivers: a.drivers.filter((x) => x.eligible),
      }));
      setDialog("assignment");
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const transition = (v: Item, resource: string, target: string) => {
    setSelected(v);
    setDialog(`${resource}-transition-${target}`);
  };
  const quick = (v: Item, resource: string, target: string) =>
    void mutate(`/operations/${resource}/${v.id}/transition`, {
      expectedVersion: v.version,
      toState: target,
    });
  const editRule = (v: Rule | null) => {
    setSelectedRule(v);
    void getRefs(["clients", "lanes", "vendors"]);
    setDialog("rule");
  };
  const states =
    mode === "dashboard"
      ? ["OPEN", "PARTIALLY_ALLOCATED"]
      : mode === "indents"
        ? [
            "DRAFT",
            "OPEN",
            "PARTIALLY_ALLOCATED",
            "FULFILLED",
            "CANCELLED",
            "CLOSED",
          ]
        : mode === "allocations"
          ? [
              "OFFERED",
              "ACCEPTED",
              "REJECTED",
              "EXPIRED",
              "VEHICLE_ASSIGNED",
              "NTP_RELEASED",
              "PLACED",
              "CANCELLED",
            ]
          : [
              "PLANNED",
              "AT_ORIGIN",
              "LOADED",
              "IN_TRANSIT",
              "AT_DESTINATION",
              "DELIVERED",
              "CANCELLED",
            ];
  const totals = useMemo(
    () =>
      items.reduce<Record<string, number>>(
        (a, v) => ({ ...a, [v.state]: (a[v.state] ?? 0) + 1 }),
        {},
      ),
    [items],
  );

  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">OPS-01 · OPS-02 · OPS-03</p>
            <h1>
              {mode === "dashboard"
                ? "Open indent workbench"
                : mode === "indents"
                  ? "Indent register"
                  : mode === "allocations"
                    ? "Truck allocations"
                    : "Trip execution"}
            </h1>
            <p className="muted">
              {mode === "dashboard"
                ? "Prioritize open demand, update commitments, and allocate eligible supply from one queue."
                : "The complete register exposes only actions valid for each current state."}
            </p>
          </div>
          {["dashboard", "indents"].includes(mode) && (
            <button className="primary" onClick={createIndent}>
              Create indent
            </button>
          )}
        </header>
        <nav className={styles.nav} aria-label="Operations sections">
          <Link href="/app/operations">Open indent workbench</Link>
          <Link href="/app/operations/indents">All indents</Link>
          <Link href="/app/operations/allocations">Truck allocations</Link>
          <Link href="/app/operations/trips">Trips</Link>
        </nav>
        {error && (
          <div role="alert" className="error">
            <strong>{error.message}</strong>
            {error.correlationId && (
              <small> Reference {error.correlationId}</small>
            )}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {notice && (
          <p role="status" className="success">
            {notice}
          </p>
        )}
        <section className={styles.metrics}>
          {(mode === "dashboard"
            ? [
                ["Open indents", summary.openIndents],
                ["Trucks awaiting", summary.awaitingVehicles],
                ["Green", summary.green],
                ["Yellow", summary.yellow],
                ["Red / breached", summary.red],
                ["Live trips", summary.liveTrips],
              ]
            : Object.entries(totals).slice(0, 6)
          ).map(([k, v]) => (
            <article
              className={`${styles.metric} ${styles[String(k).split(" ")[0].toLowerCase()] ?? ""}`}
              key={String(k)}
            >
              <span>{pretty(String(k))}</span>
              <strong>{Number(v ?? 0)}</strong>
            </article>
          ))}
        </section>
        {mode === "allocations" && (
          <div className={styles.subnav} role="tablist">
            <button
              role="tab"
              aria-selected={allocationTab === "register"}
              onClick={() => setAllocationTab("register")}
            >
              All allocations
            </button>
            <button
              role="tab"
              aria-selected={allocationTab === "rules"}
              onClick={() => setAllocationTab("rules")}
            >
              Auto-allocation rules
            </button>
          </div>
        )}
        {(mode !== "allocations" || allocationTab === "register") && (
          <>
            <section className={`${styles.panel} ${styles.toolbar}`}>
              <label>
                Search
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Indent, client, vendor, trip or vehicle"
                />
              </label>
              <label>
                Status
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {states.map((v) => (
                    <option value={v} key={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </label>
              {["dashboard", "indents"].includes(mode) && (
                <label>
                  Owner
                  <select
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                  >
                    <option value="ALL">All owners</option>
                    <option value="MINE">Assigned to me</option>
                    <option value="UNASSIGNED">Unassigned</option>
                  </select>
                </label>
              )}
              {mode === "dashboard" && (
                <label>
                  Placement risk
                  <select
                    value={risk}
                    onChange={(e) => setRisk(e.target.value)}
                  >
                    <option value="">All risks</option>
                    <option>GREEN</option>
                    <option>YELLOW</option>
                    <option>RED</option>
                  </select>
                </label>
              )}
              <button onClick={() => void load()}>Refresh</button>
            </section>
            <section className={styles.panel} aria-busy={loading}>
              <div className={styles.panelHead}>
                <div>
                  <h2>
                    {mode === "dashboard"
                      ? "All open indents"
                      : mode === "indents"
                        ? "All indents"
                        : mode === "allocations"
                          ? "Allocation register"
                          : "Trip register"}
                  </h2>
                  <p className="muted">{items.length} record(s) in this view</p>
                </div>
              </div>
              {loading ? (
                <p className={styles.empty}>Loading operations…</p>
              ) : items.length ? (
                <Queue
                  mode={mode}
                  items={items}
                  allocate={(v) => void allocate(v)}
                  edit={editIndent}
                  assign={(v) => void assign(v)}
                  dialog={(v, k) => {
                    setSelected(v);
                    setDialog(k);
                  }}
                  transition={transition}
                  quick={quick}
                />
              ) : (
                <p className={styles.empty}>Nothing matches this view.</p>
              )}
            </section>
          </>
        )}
        {mode === "allocations" && allocationTab === "rules" && (
          <Rules
            rules={rules}
            indents={openIndents}
            edit={editRule}
            preview={async (r, id) => {
              try {
                const v = await api<{
                  matches: boolean;
                  reasons: string[];
                  proposedVendor?: { name: string };
                }>(`/operations/auto-allocation-rules/${r.id}/preview/${id}`);
                setNotice(
                  v.matches
                    ? `Preview: allocate to ${v.proposedVendor?.name}.`
                    : `No match: ${v.reasons.join(", ")}`,
                );
              } catch (e) {
                setError(e as ApiError);
              }
            }}
            execute={(r, id) =>
              void mutate(
                `/operations/auto-allocation-rules/${r.id}/execute/${id}`,
                {},
              )
            }
            toggle={(r) =>
              void mutate(
                `/operations/auto-allocation-rules/${r.id}`,
                {
                  name: r.name,
                  priority: r.priority,
                  clientId: r.clientId ?? null,
                  laneId: r.laneId ?? null,
                  vendorId: r.vendorId ?? null,
                  maxVehicles: r.maxVehicles,
                  offerRateMinor: String(r.offerRateMinor),
                  offerValidMinutes: r.offerValidMinutes,
                  active: !r.active,
                  expectedVersion: r.version,
                },
                "PATCH",
              )
            }
          />
        )}
        {dialog && (
          <ActionDialog
            key={`${dialog}-${selected?.id ?? selectedRule?.id ?? "new"}`}
            kind={dialog}
            selected={selected}
            rule={selectedRule}
            refs={refs}
            eligible={eligible}
            close={() => {
              setDialog(null);
              setSelected(null);
              setSelectedRule(null);
            }}
            submit={(p, b, m) => void mutate(p, b, m)}
          />
        )}
      </main>
    </Shell>
  );
}

function Queue({
  mode,
  items,
  allocate,
  edit,
  assign,
  dialog,
  transition,
  quick,
}: {
  mode: Mode;
  items: Item[];
  allocate: (v: Item) => void;
  edit: (v: Item) => void;
  assign: (v: Item) => void;
  dialog: (v: Item, k: string) => void;
  transition: (v: Item, r: string, s: string) => void;
  quick: (v: Item, r: string, s: string) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Client / vendor</th>
            <th>Supply / asset</th>
            <th>Status</th>
            <th>Commitment</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td>
                <strong>{String(v.indentNo ?? v.tripNo ?? v.id)}</strong>
                {Boolean(v.lrNo) && <small>LR {String(v.lrNo)}</small>}
                {Boolean(v.lane) && <small>Lane {String(v.lane)}</small>}
              </td>
              <td>
                {String(v.client ?? v.vendor ?? "—")}
                <small>{String(v.location ?? v.ownerName ?? "")}</small>
              </td>
              <td>
                {v.requestedVehicles != null ? (
                  <>
                    {Number(v.requestedVehicles) - Number(v.remaining)} /{" "}
                    {String(v.requestedVehicles)} allocated
                    <small>{String(v.remaining)} truck(s) awaiting</small>
                  </>
                ) : (
                  <>
                    {String(
                      v.vehicle ?? `${v.allottedVehicles ?? "—"} truck(s)`,
                    )}
                    <small>{String(v.driver ?? "")}</small>
                  </>
                )}
              </td>
              <td>
                <span
                  className={`${styles.pill} ${styles[String(v.risk ?? "").toLowerCase()] ?? ""}`}
                >
                  {pretty(v.state)}
                  {v.risk ? ` · ${String(v.risk)}` : ""}
                </span>
              </td>
              <td>
                {v.committedPlacementAt
                  ? new Date(String(v.committedPlacementAt)).toLocaleString()
                  : v.plannedDeliveryAt
                    ? new Date(String(v.plannedDeliveryAt)).toLocaleString()
                    : v.expiresAt
                      ? new Date(String(v.expiresAt)).toLocaleString()
                      : "—"}
              </td>
              <td>
                <div className={styles.actions}>
                  {mode === "dashboard" && (
                    <>
                      <button onClick={() => edit(v)}>Edit indent</button>
                      <button
                        className="primary"
                        disabled={Number(v.remaining) < 1}
                        onClick={() => allocate(v)}
                      >
                        Allocate truck
                      </button>
                      <button
                        onClick={() => transition(v, "indents", "CANCELLED")}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {mode === "indents" && (
                    <>
                      {["DRAFT", "OPEN", "PARTIALLY_ALLOCATED"].includes(
                        v.state,
                      ) && <button onClick={() => edit(v)}>Edit</button>}
                      {v.state === "DRAFT" && (
                        <button
                          className="primary"
                          onClick={() => quick(v, "indents", "OPEN")}
                        >
                          Submit
                        </button>
                      )}
                      {["DRAFT", "OPEN", "PARTIALLY_ALLOCATED"].includes(
                        v.state,
                      ) && (
                        <button
                          onClick={() => transition(v, "indents", "CANCELLED")}
                        >
                          Cancel
                        </button>
                      )}
                    </>
                  )}
                  {mode === "allocations" && (
                    <AllocationButtons
                      v={v}
                      assign={assign}
                      dialog={dialog}
                      transition={transition}
                      quick={quick}
                    />
                  )}
                  {mode === "trips" && (
                    <>
                      {tripActions(v).map((a) => (
                        <button
                          className={
                            ["START", "END"].includes(a) ? "primary" : ""
                          }
                          key={a}
                          onClick={() => dialog(v, `trip-action-${a}`)}
                        >
                          {tripLabel(a)}
                        </button>
                      ))}
                      {["PLANNED", "AT_ORIGIN"].includes(v.state) && (
                        <button
                          onClick={() => transition(v, "trips", "CANCELLED")}
                        >
                          Cancel trip
                        </button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function AllocationButtons({
  v,
  assign,
  dialog,
  transition,
  quick,
}: {
  v: Item;
  assign: (v: Item) => void;
  dialog: (v: Item, k: string) => void;
  transition: (v: Item, r: string, s: string) => void;
  quick: (v: Item, r: string, s: string) => void;
}) {
  return (
    <>
      {v.state === "OFFERED" && (
        <>
          <button
            className="primary"
            onClick={() => quick(v, "allocations", "ACCEPTED")}
          >
            Accept
          </button>
          <button onClick={() => transition(v, "allocations", "REJECTED")}>
            Reject
          </button>
          <button onClick={() => quick(v, "allocations", "EXPIRED")}>
            Expire
          </button>
        </>
      )}
      {v.state === "ACCEPTED" && (
        <button className="primary" onClick={() => assign(v)}>
          Assign truck & driver
        </button>
      )}
      {["VEHICLE_ASSIGNED", "NTP_RELEASED"].includes(v.state) && (
        <button onClick={() => assign(v)}>Replace assignment</button>
      )}
      {v.state === "VEHICLE_ASSIGNED" && (
        <button
          className="primary"
          onClick={() => quick(v, "allocations", "NTP_RELEASED")}
        >
          Release NTP
        </button>
      )}
      {v.state === "NTP_RELEASED" && (
        <button
          className="primary"
          onClick={() => quick(v, "allocations", "PLACED")}
        >
          Confirm placed
        </button>
      )}
      {["VEHICLE_ASSIGNED", "NTP_RELEASED", "PLACED"].includes(v.state) &&
        !v.hasTrip && (
          <button onClick={() => dialog(v, "trip-create")}>Create trip</button>
        )}
      {["ACCEPTED", "VEHICLE_ASSIGNED", "NTP_RELEASED"].includes(v.state) && (
        <button onClick={() => transition(v, "allocations", "CANCELLED")}>
          Cancel
        </button>
      )}
    </>
  );
}
const tripActions = (v: Item) =>
  v.state === "PLANNED"
    ? v.accepted
      ? ["START"]
      : ["ACCEPT", "START"]
    : v.state === "AT_ORIGIN"
      ? ["LOAD"]
      : v.state === "LOADED"
        ? ["TRANSIT"]
        : v.state === "IN_TRANSIT"
          ? ["UNLOAD"]
          : v.state === "AT_DESTINATION"
            ? ["END"]
            : [];
const tripLabel = (a: string) =>
  ({
    ACCEPT: "Accept trip",
    START: "Start / gate-in",
    LOAD: "Confirm loading",
    TRANSIT: "Start transit",
    UNLOAD: "Arrival / unload",
    END: "End & deliver",
  })[a] ?? a;

function Rules({
  rules,
  indents,
  edit,
  preview,
  execute,
  toggle,
}: {
  rules: Rule[];
  indents: Item[];
  edit: (v: Rule | null) => void;
  preview: (r: Rule, i: string) => void;
  execute: (r: Rule, i: string) => void;
  toggle: (r: Rule) => void;
}) {
  const [indent, setIndent] = useState("");
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>Auto-allocation rules</h2>
          <p className="muted">
            Preview before applying a rule to remaining demand.
          </p>
        </div>
        <button className="primary" onClick={() => edit(null)}>
          New rule
        </button>
      </div>
      <div className={styles.ruleTarget}>
        <label>
          Open indent
          <select value={indent} onChange={(e) => setIndent(e.target.value)}>
            <option value="">Search and select</option>
            {indents.map((v) => (
              <option value={v.id} key={v.id}>
                {String(v.indentNo)} · {String(v.client)} ·{" "}
                {String(v.remaining)} awaiting
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.ruleGrid}>
        {rules.length ? (
          rules.map((r) => (
            <article className={styles.card} key={r.id}>
              <div className={styles.cardTitle}>
                <strong>{r.name}</strong>
                <span className={styles.pill}>
                  {r.active ? "Active" : "Inactive"}
                </span>
              </div>
              <p>
                {r.client ?? "Any client"} · {r.lane ?? "Any lane"}
                <br />
                {r.vendor ?? "Any eligible vendor"} · max {r.maxVehicles}{" "}
                truck(s)
              </p>
              <small>
                Priority {r.priority} · valid {r.offerValidMinutes} minutes
              </small>
              <div className={styles.actions}>
                <button disabled={!indent} onClick={() => preview(r, indent)}>
                  Preview
                </button>
                <button
                  className="primary"
                  disabled={!indent || !r.active}
                  onClick={() => execute(r, indent)}
                >
                  Allocate once
                </button>
                <button
                  disabled={r.offerRateMinor == null}
                  onClick={() => edit(r)}
                >
                  Edit
                </button>
                <button
                  disabled={r.offerRateMinor == null}
                  onClick={() => toggle(r)}
                >
                  {r.active ? "Disable" : "Enable"}
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className={styles.empty}>No rules configured.</p>
        )}
      </div>
    </section>
  );
}

function ActionDialog({
  kind,
  selected,
  rule,
  refs,
  eligible,
  close,
  submit,
}: {
  kind: string;
  selected: Item | null;
  rule: Rule | null;
  refs: Record<string, Ref[]>;
  eligible: Eligible[];
  close: () => void;
  submit: (p: string, b: unknown, m?: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({
    requestedVehicles: String(selected?.requestedVehicles ?? 1),
    quantityMilli: String(selected?.quantityMilli ?? 1000),
    pickupWindowStart: toLocal(selected?.pickupWindowStart) || localNow(),
    pickupWindowEnd: toLocal(selected?.pickupWindowEnd) || localNow(4),
    committedPlacementAt:
      toLocal(selected?.committedPlacementAt) || localNow(4),
    commitmentOverrideReason: String(selected?.commitmentOverrideReason ?? ""),
    cargoType: String(selected?.cargoType ?? ""),
    bodyType: String(selected?.bodyType ?? ""),
    allottedVehicles: "1",
    offeredRateMinor: String(rule?.offerRateMinor ?? 0),
    offeredAt: localNow(),
    expiresAt: localNow(2),
    plannedPickupAt: localNow(),
    plannedDeliveryAt: localNow(24),
    occurredAt: localNow(),
    priority: String(rule?.priority ?? 100),
    maxVehicles: String(rule?.maxVehicles ?? 1),
    offerValidMinutes: String(rule?.offerValidMinutes ?? 120),
    name: rule?.name ?? "",
    clientId: rule?.clientId ?? "",
    laneId: rule?.laneId ?? "",
    vendorId: rule?.vendorId ?? "",
  });
  const [refSearch, setRefSearch] = useState<Record<string, string>>({});
  const action = kind.startsWith("trip-action-") ? kind.slice(12) : "",
    target = kind.includes("-transition-") ? kind.split("-transition-")[1] : "";
  const field = (
    k: string,
    l: string,
    type = "text",
    required = true,
    help?: string,
  ) => (
    <label>
      <span>
        {l}
        {!required && <small> (optional)</small>}
      </span>
      <input
        type={type}
        required={required}
        value={f[k] ?? ""}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
      {help && <small>{help}</small>}
    </label>
  );
  const area = (k: string, l: string, required = false) => (
    <label>
      <span>
        {l}
        {!required && <small> (optional)</small>}
      </span>
      <textarea
        required={required}
        value={f[k] ?? ""}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </label>
  );
  const select = (k: string, l: string, values: Ref[], required = true) => {
    const q = (refSearch[k] ?? "").toLowerCase();
    const visible = values.filter((v) => refLabel(v).toLowerCase().includes(q));
    return (
      <label>
        <span>
          {l}
          {!required && <small> (optional)</small>}
        </span>
        {values.length > 8 && (
          <input
            type="search"
            value={refSearch[k] ?? ""}
            placeholder={`Search ${l.toLowerCase()}`}
            onChange={(e) =>
              setRefSearch({ ...refSearch, [k]: e.target.value })
            }
          />
        )}
        <select
          required={required}
          value={f[k] ?? ""}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
        >
          <option value="">Search and select</option>
          {visible.map((v) => (
            <option value={v.id} key={v.id}>
              {refLabel(v)}
            </option>
          ))}
        </select>
      </label>
    );
  };
  function save(e: FormEvent) {
    e.preventDefault();
    if (kind === "indent-create")
      return submit("/operations/indents", {
        indentNo: f.indentNo,
        clientId: f.clientId,
        clientLocationId: f.clientLocationId,
        laneId: f.laneId,
        requestedVehicles: +f.requestedVehicles,
        quantityMilli: +f.quantityMilli,
        pickupWindowStart: iso(f.pickupWindowStart),
        pickupWindowEnd: iso(f.pickupWindowEnd),
        source: "MANUAL",
        cargoType: f.cargoType || undefined,
        bodyType: f.bodyType || undefined,
      });
    if (kind === "indent-edit")
      return submit(
        `/operations/indents/${selected?.id}`,
        {
          expectedVersion: selected?.version,
          requestedVehicles: +f.requestedVehicles,
          quantityMilli: +f.quantityMilli,
          pickupWindowStart: iso(f.pickupWindowStart),
          pickupWindowEnd: iso(f.pickupWindowEnd),
          committedPlacementAt: iso(f.committedPlacementAt),
          commitmentOverrideReason: f.commitmentOverrideReason || null,
          ownerMembershipId: selected?.ownerMembershipId ?? null,
          cargoType: f.cargoType || null,
          bodyType: f.bodyType || null,
        },
        "PATCH",
      );
    if (kind === "allocation-create")
      return submit("/operations/allocations/manual", {
        indentId: selected?.id,
        vendorId: f.vendorId,
        allottedVehicles: +f.allottedVehicles,
        offeredRateMinor: f.offeredRateMinor,
        offerChannel: "PORTAL",
        offeredAt: iso(f.offeredAt),
        expiresAt: iso(f.expiresAt),
      });
    if (kind === "assignment")
      return submit(`/operations/allocations/${selected?.id}/assign`, {
        vehicleId: f.vehicleId,
        driverId: f.driverId,
        expectedVersion: selected?.version,
        ...(selected?.vehicle ? { reason: f.reason } : {}),
      });
    if (kind === "trip-create")
      return submit("/operations/trips", {
        allocationId: selected?.id,
        tripNo: f.tripNo,
        lrNo: f.lrNo,
        plannedPickupAt: iso(f.plannedPickupAt),
        plannedDeliveryAt: iso(f.plannedDeliveryAt),
        trackingConsentFrom: f.trackingConsentFrom
          ? iso(f.trackingConsentFrom)
          : null,
        trackingConsentTo: f.trackingConsentTo
          ? iso(f.trackingConsentTo)
          : null,
      });
    if (action)
      return submit(`/operations/trips/${selected?.id}/action`, {
        action,
        expectedVersion: selected?.version,
        occurredAt: iso(f.occurredAt),
        ...(f.receiverName && { receiverName: f.receiverName }),
        ...(f.notes && { notes: f.notes }),
        ...(f.loadQuantityMilli && { loadQuantityMilli: +f.loadQuantityMilli }),
        ...(f.sealNumber && { sealNumber: f.sealNumber }),
        ...(f.delayReason && { delayReason: f.delayReason }),
        ...(f.latitude && { latitude: +f.latitude }),
        ...(f.longitude && { longitude: +f.longitude }),
        ...(f.odometerKm && { odometerKm: +f.odometerKm }),
      });
    if (target) {
      const resource = kind.startsWith("indents-")
        ? "indents"
        : kind.startsWith("allocations-")
          ? "allocations"
          : "trips";
      return submit(`/operations/${resource}/${selected?.id}/transition`, {
        expectedVersion: selected?.version,
        toState: target,
        reason: f.reason,
      });
    }
    return submit(
      rule
        ? `/operations/auto-allocation-rules/${rule.id}`
        : "/operations/auto-allocation-rules",
      {
        name: f.name,
        priority: +f.priority,
        clientId: f.clientId || null,
        laneId: f.laneId || null,
        vendorId: f.vendorId || null,
        maxVehicles: +f.maxVehicles,
        offerRateMinor: f.offeredRateMinor,
        offerValidMinutes: +f.offerValidMinutes,
        active: rule?.active ?? true,
        ...(rule && { expectedVersion: rule.version }),
      },
      rule ? "PATCH" : "POST",
    );
  }
  const title =
    kind === "indent-create"
      ? "Create indent"
      : kind === "indent-edit"
        ? `Edit ${String(selected?.indentNo)}`
        : kind === "allocation-create"
          ? "Allocate trucks"
          : kind === "assignment"
            ? selected?.vehicle
              ? "Replace truck and driver"
              : "Assign truck and driver"
            : kind === "trip-create"
              ? "Create trip"
              : action
                ? tripLabel(action)
                : target
                  ? `${pretty(target)} record`
                  : rule
                    ? "Edit auto-allocation rule"
                    : "New auto-allocation rule";
  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-dialog"
        className={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.dialogHead}>
          <div>
            <p className="eyebrow">Operations action</p>
            <h2 id="ops-dialog">{title}</h2>
          </div>
          <button onClick={close}>Close</button>
        </div>
        <form className={styles.form} onSubmit={save}>
          {kind === "indent-create" && (
            <>
              {field("indentNo", "Indent number")}
              {select("clientId", "Client", refs.clients ?? [])}
              {select(
                "clientLocationId",
                "Client location",
                refs["client-locations"] ?? [],
              )}
              {select("laneId", "Contract lane", refs.lanes ?? [])}
            </>
          )}
          {["indent-create", "indent-edit"].includes(kind) && (
            <>
              {field("requestedVehicles", "Requested vehicles", "number")}
              {field(
                "quantityMilli",
                "Quantity (thousandths)",
                "number",
                true,
                "1000 is one whole unit",
              )}
              {field("pickupWindowStart", "Pickup starts", "datetime-local")}
              {field("pickupWindowEnd", "Pickup ends", "datetime-local")}
              {kind === "indent-edit" && (
                <>
                  {field(
                    "committedPlacementAt",
                    "Committed placement",
                    "datetime-local",
                  )}
                  {area(
                    "commitmentOverrideReason",
                    "Commitment override reason",
                  )}
                </>
              )}
              {field("cargoType", "Cargo type", "text", false)}
              {field("bodyType", "Body type", "text", false)}
            </>
          )}
          {kind === "allocation-create" && (
            <>
              {select(
                "vendorId",
                "Eligible vendor",
                eligible.filter((v) => v.eligible),
              )}
              {field("allottedVehicles", "Truck quantity", "number")}
              {field(
                "offeredRateMinor",
                "Offer rate (minor units)",
                "number",
                true,
                "For INR, enter paise",
              )}
              {field("offeredAt", "Offered at", "datetime-local")}
              {field("expiresAt", "Offer expires", "datetime-local")}
              {eligible
                .filter((v) => !v.eligible)
                .map((v) => (
                  <p className={styles.reason} key={v.id}>
                    <strong>{v.name} excluded:</strong> {v.reasons.join(", ")}
                  </p>
                ))}
            </>
          )}
          {kind === "assignment" && (
            <>
              {select("vehicleId", "Eligible vehicle", refs.vehicles ?? [])}
              {select("driverId", "Eligible driver", refs.drivers ?? [])}
              {selected?.vehicle && area("reason", "Replacement reason", true)}
            </>
          )}
          {kind === "trip-create" && (
            <>
              {field("tripNo", "Trip number")}
              {field("lrNo", "LR number")}
              {field("plannedPickupAt", "Planned pickup", "datetime-local")}
              {field("plannedDeliveryAt", "Planned delivery", "datetime-local")}
              {field(
                "trackingConsentFrom",
                "Location consent starts",
                "datetime-local",
                false,
              )}
              {field(
                "trackingConsentTo",
                "Location consent ends",
                "datetime-local",
                false,
              )}
            </>
          )}
          {action && (
            <>
              {field("occurredAt", "Event date and time", "datetime-local")}
              {["START", "TRANSIT", "UNLOAD", "END"].includes(action) &&
                field("odometerKm", "Odometer km", "number", false)}
              {["START", "UNLOAD"].includes(action) && (
                <>
                  {field("latitude", "Latitude", "number", false)}
                  {field("longitude", "Longitude", "number", false)}
                </>
              )}
              {action === "LOAD" && (
                <>
                  {field(
                    "loadQuantityMilli",
                    "Loaded quantity (thousandths)",
                    "number",
                    false,
                  )}
                  {field("sealNumber", "Seal number", "text", false)}
                </>
              )}
              {action === "TRANSIT" &&
                field("delayReason", "Delay / exception", "text", false)}
              {action === "END" && field("receiverName", "Receiver name")}
              {area("notes", "Operational notes")}
            </>
          )}
          {target && area("reason", "Reason", true)}
          {kind === "rule" && (
            <>
              {field("name", "Rule name")}
              {field("priority", "Priority", "number")}
              {select("clientId", "Client", refs.clients ?? [], false)}
              {select("laneId", "Lane", refs.lanes ?? [], false)}
              {select(
                "vendorId",
                "Preferred vendor",
                refs.vendors ?? [],
                false,
              )}
              {field("maxVehicles", "Maximum trucks", "number")}
              {field("offeredRateMinor", "Offer rate (minor units)", "number")}
              {field("offerValidMinutes", "Offer validity minutes", "number")}
            </>
          )}
          <div className={styles.dialogActions}>
            <button type="button" onClick={close}>
              Back
            </button>
            <button className="primary" type="submit">
              Confirm action
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
