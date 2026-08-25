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
type Reference = {
  id: string;
  code?: string;
  legal_name?: string;
  legalName?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
  registration_number?: string;
};
type Eligible = {
  id: string;
  code: string;
  name: string;
  eligible: boolean;
  reasons: string[];
  availableVehicles: number;
  availableDrivers: number;
};
type Rule = {
  id: string;
  name: string;
  priority: number;
  clientId?: string;
  laneId?: string;
  vendorId?: string;
  vendor?: string;
  maxVehicles: number;
  offerRateMinor?: string | null;
  offerValidMinutes: number;
  active: boolean;
  version: number;
};

const path: Record<Mode, string> = {
  dashboard: "/operations/dashboard",
  indents: "/operations/indents",
  allocations: "/operations/allocations",
  trips: "/operations/trips",
};
const label = (item: Reference) =>
  item.code ??
  item.legal_name ??
  item.legalName ??
  item.name ??
  item.display_name ??
  item.displayName ??
  item.registration_number ??
  item.id;
const nowLocal = (hours = 0) => {
  const d = new Date(
    Date.now() + hours * 3600000 - new Date().getTimezoneOffset() * 60000,
  );
  return d.toISOString().slice(0, 16);
};
const offsetIso = (value: string) => new Date(value).toISOString();

export function OperationsWorkbench({ mode }: { mode: Mode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [openIndents, setOpenIndents] = useState<Item[]>([]);
  const [refs, setRefs] = useState<Record<string, Reference[]>>({});
  const query = useMemo(
    () =>
      new URLSearchParams({
        ...(search ? { search } : {}),
        ...(state ? { state } : {}),
      }).toString(),
    [search, state],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "dashboard") {
        const data = await api<{
          summary: Record<string, number>;
          urgent: Item[];
        }>(path[mode]);
        setSummary(data.summary);
        setItems(data.urgent);
      } else {
        const data = await api<{ items: Item[] }>(`${path[mode]}?${query}`);
        setItems(data.items);
      }
      if (mode === "allocations") {
        const [ruleData, indentData] = await Promise.all([
          api<{ items: Rule[] }>("/operations/auto-allocation-rules"),
          api<{ items: Item[] }>("/operations/indents?state=OPEN"),
        ]);
        setRules(ruleData.items);
        setOpenIndents(indentData.items);
      }
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }, [mode, query]);
  useEffect(() => void load(), [load]);
  async function references(resources: string[]) {
    const values = await Promise.all(
      resources.map(
        async (resource) =>
          [
            resource,
            (await api<{ items: Reference[] }>(`/domain/${resource}`)).items,
          ] as const,
      ),
    );
    setRefs(Object.fromEntries(values));
  }
  async function mutate(endpoint: string, body: unknown, method = "POST") {
    setNotice("");
    setError(null);
    try {
      await api(endpoint, {
        method,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setNotice("Saved. The queue has been refreshed.");
      setDialog(null);
      setSelected(null);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function showAllocation(indent: Item) {
    setSelected(indent);
    await Promise.all([
      references(["vendors"]),
      api<{ items: Eligible[] }>(
        `/operations/indents/${indent.id}/eligible-vendors`,
      ).then((v) => setEligible(v.items)),
    ]);
    setDialog("allocate");
  }
  async function showAssign(allocation: Item) {
    setSelected(allocation);
    await references(["vehicles", "drivers"]);
    setDialog("assign");
  }
  async function showTrip(allocation: Item) {
    setSelected(allocation);
    setDialog("trip");
  }
  async function tripAction(item: Item, action: string) {
    await mutate(`/operations/trips/${item.id}/action`, {
      action,
      occurredAt: new Date().toISOString(),
      ...(action === "END" ? { receiverName: "Receiver" } : {}),
    });
  }
  const states =
    mode === "indents"
      ? ["OPEN", "PARTIALLY_ALLOCATED", "FULFILLED", "CANCELLED"]
      : mode === "allocations"
        ? ["OFFERED", "ACCEPTED", "VEHICLE_ASSIGNED", "NTP_RELEASED", "PLACED"]
        : [
            "PLANNED",
            "AT_ORIGIN",
            "LOADED",
            "IN_TRANSIT",
            "AT_DESTINATION",
            "DELIVERED",
          ];
  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">OPS-01 · OPS-02 · OPS-03</p>
            <h1>
              {mode === "dashboard"
                ? "Operations control desk"
                : mode[0].toUpperCase() + mode.slice(1)}
            </h1>
            <p className="muted">
              One queue for demand, allocation, placement, and trip execution.
            </p>
          </div>
          {mode === "indents" && (
            <button
              className="primary"
              onClick={() => {
                void references(["clients", "client-locations", "lanes"]);
                setDialog("indent");
              }}
            >
              Create indent
            </button>
          )}
        </header>
        <nav className={styles.nav} aria-label="Operations sections">
          <Link href="/app/operations">Overview</Link>
          <Link href="/app/operations/indents">Open indents</Link>
          <Link href="/app/operations/allocations">Allocations & rules</Link>
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
        {mode === "dashboard" && (
          <section className={styles.metrics}>
            {[
              ["Open indents", summary.openIndents],
              ["Placement breaches", summary.placementBreaches],
              ["Active allocations", summary.activeAllocations],
              ["Live trips", summary.liveTrips],
            ].map(([key, value]) => (
              <article className={styles.metric} key={String(key)}>
                <span>{key}</span>
                <strong>{Number(value ?? 0)}</strong>
              </article>
            ))}
          </section>
        )}
        {mode !== "dashboard" && (
          <section className={`${styles.panel} ${styles.toolbar}`}>
            <label>
              Search
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Number, client, vendor or vehicle"
              />
            </label>
            <label>
              Status
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">All actionable</option>
                {states.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button onClick={() => void load()}>Refresh</button>
            {mode === "allocations" && (
              <button
                onClick={() => {
                  void references(["clients", "lanes", "vendors"]);
                  setDialog("rule");
                }}
              >
                New auto-allocation rule
              </button>
            )}
          </section>
        )}
        <section className={styles.panel} aria-busy={loading}>
          <h2>
            {mode === "dashboard" ? "Most urgent open indents" : "Action queue"}
          </h2>
          {loading ? (
            <p role="status">Loading operations…</p>
          ) : items.length === 0 ? (
            <p className={styles.empty}>
              Nothing requires action in this view.
            </p>
          ) : (
            <Queue
              mode={mode}
              items={items}
              onAllocate={showAllocation}
              onAssign={showAssign}
              onTrip={showTrip}
              onTripAction={tripAction}
              onTransition={(item, toState) =>
                void mutate(`/operations/indents/${item.id}/transition`, {
                  expectedVersion: item.version,
                  toState,
                })
              }
              onAllocationTransition={(item, toState) =>
                void mutate(`/operations/allocations/${item.id}/transition`, {
                  expectedVersion: item.version,
                  toState,
                })
              }
            />
          )}
        </section>
        {mode === "dashboard" && (
          <div className={styles.actions}>
            <Link href="/app/operations/indents" className="primary">
              Create or update indent
            </Link>
            <Link href="/app/operations/allocations">Allocate trucks</Link>
            <Link href="/app/operations/trips">Run live trips</Link>
          </div>
        )}
        {mode === "allocations" && (
          <Rules
            rules={rules}
            items={openIndents}
            onPreview={async (rule, indentId) => {
              const result = await api<{
                matches: boolean;
                reasons: string[];
                proposedVendor?: { name: string };
              }>(
                `/operations/auto-allocation-rules/${rule.id}/preview/${indentId}`,
              );
              setNotice(
                result.matches
                  ? `Preview: allocate to ${result.proposedVendor?.name}.`
                  : `No match: ${result.reasons.join(", ")}`,
              );
            }}
            onExecute={(rule, indentId) =>
              void mutate(
                `/operations/auto-allocation-rules/${rule.id}/execute/${indentId}`,
                {},
              )
            }
            onToggle={(rule) =>
              void mutate(
                `/operations/auto-allocation-rules/${rule.id}`,
                {
                  name: rule.name,
                  priority: rule.priority,
                  clientId: rule.clientId ?? null,
                  laneId: rule.laneId ?? null,
                  vendorId: rule.vendorId ?? null,
                  maxVehicles: rule.maxVehicles,
                  offerRateMinor: String(rule.offerRateMinor),
                  offerValidMinutes: rule.offerValidMinutes,
                  active: !rule.active,
                  expectedVersion: rule.version,
                },
                "PATCH",
              )
            }
          />
        )}
        {dialog && (
          <WorkbenchDialog
            kind={dialog}
            selected={selected}
            refs={refs}
            eligible={eligible}
            onClose={() => setDialog(null)}
            onSubmit={(endpoint, body, method) =>
              void mutate(endpoint, body, method)
            }
          />
        )}
      </main>
    </Shell>
  );
}

function Queue({
  mode,
  items,
  onAllocate,
  onAssign,
  onTrip,
  onTripAction,
  onTransition,
  onAllocationTransition,
}: {
  mode: Mode;
  items: Item[];
  onAllocate: (v: Item) => void;
  onAssign: (v: Item) => void;
  onTrip: (v: Item) => void;
  onTripAction: (v: Item, a: string) => void;
  onTransition: (v: Item, s: string) => void;
  onAllocationTransition: (v: Item, s: string) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Party / asset</th>
            <th>Status</th>
            <th>Commitment</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>
                  {String(item.indentNo ?? item.tripNo ?? item.id)}
                </strong>
                {Boolean(item.lrNo) && (
                  <small>
                    <br />
                    LR {String(item.lrNo)}
                  </small>
                )}
              </td>
              <td>
                {String(item.client ?? item.vendor ?? "")}
                <small>
                  <br />
                  {String(item.location ?? item.vehicle ?? "")}
                </small>
              </td>
              <td>{item.state}</td>
              <td
                className={
                  Number(item.varianceHours) > 0 ? styles.late : styles.ok
                }
              >
                {item.committedPlacementAt
                  ? new Date(String(item.committedPlacementAt)).toLocaleString()
                  : item.plannedDeliveryAt
                    ? new Date(String(item.plannedDeliveryAt)).toLocaleString()
                    : "—"}
              </td>
              <td>
                <div className={styles.actions}>
                  {(mode === "dashboard" || mode === "indents") && (
                    <>
                      <button
                        onClick={() => onAllocate(item)}
                        disabled={Number(item.remaining) < 1}
                      >
                        Allocate truck
                      </button>
                      {item.state === "DRAFT" && (
                        <button onClick={() => onTransition(item, "OPEN")}>
                          Submit
                        </button>
                      )}
                    </>
                  )}
                  {mode === "allocations" && (
                    <>
                      {item.state === "OFFERED" && (
                        <button
                          onClick={() =>
                            onAllocationTransition(item, "ACCEPTED")
                          }
                        >
                          Accept offer
                        </button>
                      )}
                      {item.state === "ACCEPTED" && (
                        <button onClick={() => onAssign(item)}>
                          Assign vehicle & driver
                        </button>
                      )}
                      {item.state === "VEHICLE_ASSIGNED" && (
                        <button
                          onClick={() =>
                            onAllocationTransition(item, "NTP_RELEASED")
                          }
                        >
                          Release NTP
                        </button>
                      )}
                      {item.state === "NTP_RELEASED" && (
                        <button
                          onClick={() => onAllocationTransition(item, "PLACED")}
                        >
                          Confirm placement
                        </button>
                      )}
                      {["VEHICLE_ASSIGNED", "NTP_RELEASED", "PLACED"].includes(
                        item.state,
                      ) &&
                        !item.hasTrip && (
                          <button onClick={() => onTrip(item)}>
                            Create trip
                          </button>
                        )}
                    </>
                  )}
                  {mode === "trips" &&
                    actionsFor(item.state).map((action) => (
                      <button
                        key={action}
                        onClick={() => onTripAction(item, action)}
                      >
                        {actionLabel(action)}
                      </button>
                    ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const actionsFor = (state: string) =>
  state === "PLANNED"
    ? ["ACCEPT", "START"]
    : state === "AT_ORIGIN"
      ? ["LOAD"]
      : state === "LOADED"
        ? ["TRANSIT"]
        : state === "IN_TRANSIT"
          ? ["UNLOAD"]
          : state === "AT_DESTINATION"
            ? ["END"]
            : [];
const actionLabel = (value: string) =>
  ({
    ACCEPT: "Accept trip",
    START: "Start / gate-in",
    LOAD: "Confirm loaded",
    TRANSIT: "Start transit",
    UNLOAD: "Confirm destination",
    END: "End & deliver",
  })[value] ?? value;

function Rules({
  rules,
  items,
  onPreview,
  onExecute,
  onToggle,
}: {
  rules: Rule[];
  items: Item[];
  onPreview: (r: Rule, i: string) => void;
  onExecute: (r: Rule, i: string) => void;
  onToggle: (r: Rule) => void;
}) {
  const [indentId, setIndentId] = useState("");
  return (
    <section className={styles.panel}>
      <h2>Automatic allocation rules</h2>
      <label>
        Indent to evaluate
        <select value={indentId} onChange={(e) => setIndentId(e.target.value)}>
          <option value="">Select open indent</option>
          {items.map((v) => (
            <option key={v.id} value={v.id}>
              {String(v.indentNo)} · {String(v.client)}
            </option>
          ))}
        </select>
      </label>
      {rules.length === 0 ? (
        <p className={styles.empty}>No rules configured.</p>
      ) : (
        rules.map((rule) => (
          <article className={styles.card} key={rule.id}>
            <strong>{rule.name}</strong>
            <p>
              {rule.vendor ?? "Any eligible vendor"} · up to {rule.maxVehicles}{" "}
              vehicle(s) · priority {rule.priority} ·{" "}
              {rule.active ? "Active" : "Inactive"}
            </p>
            <div className={styles.actions}>
              <button
                disabled={!indentId}
                onClick={() => onPreview(rule, indentId)}
              >
                Preview
              </button>
              <button
                className="primary"
                disabled={!indentId || !rule.active}
                onClick={() => onExecute(rule, indentId)}
              >
                Execute once
              </button>
              <button
                disabled={rule.offerRateMinor == null}
                title={
                  rule.offerRateMinor == null
                    ? "Commercial-rate permission is required"
                    : undefined
                }
                onClick={() => onToggle(rule)}
              >
                {rule.active ? "Disable" : "Enable"}
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function WorkbenchDialog({
  kind,
  selected,
  refs,
  eligible,
  onClose,
  onSubmit,
}: {
  kind: string;
  selected: Item | null;
  refs: Record<string, Reference[]>;
  eligible: Eligible[];
  onClose: () => void;
  onSubmit: (e: string, b: unknown, m?: string) => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({
    pickupWindowStart: nowLocal(),
    pickupWindowEnd: nowLocal(4),
    plannedPickupAt: nowLocal(),
    plannedDeliveryAt: nowLocal(24),
    offeredAt: nowLocal(),
    expiresAt: nowLocal(2),
    priority: "100",
    maxVehicles: "1",
    offerRateMinor: "0",
    offerValidMinutes: "120",
    allottedVehicles: "1",
  });
  const field = (
    key: string,
    labelText: string,
    type = "text",
    required = true,
  ) => (
    <label>
      {labelText}
      <input
        type={type}
        required={required}
        value={form[key] ?? ""}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );
  const select = (
    key: string,
    labelText: string,
    resource: string,
    values?: Reference[],
    required = true,
  ) => {
    const choices = values ?? refs[resource] ?? [];
    return (
      <label>
        {labelText}
        <select
          required={required}
          value={form[key] ?? ""}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        >
          <option value="">Search and select</option>
          {choices.map((v) => (
            <option key={v.id} value={v.id}>
              {label(v)}
            </option>
          ))}
        </select>
      </label>
    );
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (kind === "indent")
      onSubmit("/operations/indents", {
        indentNo: form.indentNo,
        clientId: form.clientId,
        clientLocationId: form.clientLocationId,
        laneId: form.laneId,
        requestedVehicles: Number(form.requestedVehicles),
        quantityMilli: Number(form.quantityMilli),
        pickupWindowStart: offsetIso(form.pickupWindowStart),
        pickupWindowEnd: offsetIso(form.pickupWindowEnd),
        source: "MANUAL",
        cargoType: form.cargoType || undefined,
        bodyType: form.bodyType || undefined,
      });
    if (kind === "allocate")
      onSubmit("/operations/allocations/manual", {
        indentId: selected?.id,
        vendorId: form.vendorId,
        allottedVehicles: Number(form.allottedVehicles),
        offeredRateMinor: form.offeredRateMinor,
        offerChannel: "PORTAL",
        offeredAt: offsetIso(form.offeredAt),
        expiresAt: offsetIso(form.expiresAt),
      });
    if (kind === "assign")
      onSubmit(`/operations/allocations/${selected?.id}/assign`, {
        vehicleId: form.vehicleId,
        driverId: form.driverId,
      });
    if (kind === "trip")
      onSubmit("/operations/trips", {
        allocationId: selected?.id,
        tripNo: form.tripNo,
        lrNo: form.lrNo,
        plannedPickupAt: offsetIso(form.plannedPickupAt),
        plannedDeliveryAt: offsetIso(form.plannedDeliveryAt),
      });
    if (kind === "rule")
      onSubmit("/operations/auto-allocation-rules", {
        name: form.name,
        priority: Number(form.priority),
        clientId: form.clientId || null,
        laneId: form.laneId || null,
        vendorId: form.vendorId || null,
        maxVehicles: Number(form.maxVehicles),
        offerRateMinor: form.offerRateMinor,
        offerValidMinutes: Number(form.offerValidMinutes),
        active: true,
      });
  }
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={`${kind} form`}
      className={styles.dialog}
    >
      <div className={styles.dialogHead}>
        <h2>
          {kind === "indent"
            ? "Create indent"
            : kind === "allocate"
              ? "Allocate truck"
              : kind === "assign"
                ? "Assign vehicle and driver"
                : kind === "trip"
                  ? "Create trip"
                  : "Auto-allocation rule"}
        </h2>
        <button onClick={onClose}>Close</button>
      </div>
      <form className={styles.form} onSubmit={submit}>
        {kind === "indent" && (
          <>
            {field("indentNo", "Indent number")}
            {select("clientId", "Client", "clients")}
            {select("clientLocationId", "Client location", "client-locations")}
            {select("laneId", "Lane", "lanes")}
            {field("requestedVehicles", "Requested vehicles", "number")}
            {field("quantityMilli", "Quantity (thousandths)", "number")}
            {field(
              "pickupWindowStart",
              "Pickup window start",
              "datetime-local",
            )}
            {field("pickupWindowEnd", "Pickup window end", "datetime-local")}
            {field("cargoType", "Cargo type", "text", false)}
            {field("bodyType", "Body type", "text", false)}
          </>
        )}
        {kind === "allocate" && (
          <>
            {select(
              "vendorId",
              "Eligible vendor",
              "vendors",
              eligible.filter((v) => v.eligible),
            )}
            {field("allottedVehicles", "Vehicles", "number")}
            {field("offeredRateMinor", "Offer rate (minor units)", "number")}
            {field("offeredAt", "Offer time", "datetime-local")}
            {field("expiresAt", "Offer expiry", "datetime-local")}
            <div>
              {eligible
                .filter((v) => !v.eligible)
                .map((v) => (
                  <p key={v.id} className={styles.reason}>
                    <strong>{v.name} excluded:</strong> {v.reasons.join(", ")}
                  </p>
                ))}
            </div>
          </>
        )}
        {kind === "assign" && (
          <>
            {select("vehicleId", "Vehicle", "vehicles")}
            {select("driverId", "Driver", "drivers")}
          </>
        )}
        {kind === "trip" && (
          <>
            {field("tripNo", "Trip number")}
            {field("lrNo", "LR number")}
            {field("plannedPickupAt", "Planned pickup", "datetime-local")}
            {field("plannedDeliveryAt", "Planned delivery", "datetime-local")}
          </>
        )}
        {kind === "rule" && (
          <>
            {field("name", "Rule name")}
            {field("priority", "Priority", "number")}
            {select(
              "clientId",
              "Client (optional)",
              "clients",
              undefined,
              false,
            )}
            {select("laneId", "Lane (optional)", "lanes", undefined, false)}
            {select(
              "vendorId",
              "Preferred vendor (optional)",
              "vendors",
              undefined,
              false,
            )}
            {field("maxVehicles", "Maximum vehicles", "number")}
            {field("offerRateMinor", "Offer rate (minor units)", "number")}
            {field("offerValidMinutes", "Offer validity (minutes)", "number")}
          </>
        )}
        <button className="primary" type="submit">
          Save and refresh
        </button>
      </form>
    </section>
  );
}
