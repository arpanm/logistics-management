"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import { SmartField } from "../forms/smart-field";
import { FormSubmitResult } from "../forms/form-submit-result";
import { Modal } from "../modal";

type Postal = {
  id: string;
  postalCode: string;
  locality: string;
  district: string;
  city: string;
  region: string;
  directoryVersion: string;
};
type Node = {
  id: string;
  code: string;
  name: string;
  nodeType: string;
  parentId?: string | null;
  timezone: string;
  activeFrom: string;
  activeTo?: string | null;
  state: string;
  version: number;
  address?: null | {
    line1: string;
    line2?: string;
    postalCode: string;
    postalLocalityId: string;
    locality: string;
    district: string;
    city: string;
    region: string;
    directoryVersion: string;
    provenance: string;
  };
  geofence?: unknown;
  treeDepth: number;
  permissions: { update: boolean; deactivate: boolean };
  descendantCount: number;
  activeEmployeeCount: number;
};
const today = () => new Date().toISOString().slice(0, 10);
const empty = () => ({
  code: "",
  name: "",
  nodeType: "LEGAL_ENTITY",
  parentId: "",
  timezone: "Asia/Kolkata",
  activeFrom: today(),
  activeTo: "",
  line1: "",
  line2: "",
  postalCode: "",
  postalLocalityId: "",
  fenceMode: "POINT_RADIUS",
  lat: "",
  lng: "",
  radiusKm: "5",
  polygonPoints: "",
  reason: "",
});
const parentTypes: Record<string, string[]> = {
  LEGAL_ENTITY: [],
  REGION: ["LEGAL_ENTITY"],
  BRANCH: ["REGION"],
  TEAM: ["BRANCH", "HUB"],
  HUB: ["REGION", "BRANCH"],
};
export function OrganizationWorkspace() {
  const [items, setItems] = useState<Node[]>([]),
    [selected, setSelected] = useState<Node | null>(null),
    [editTarget, setEditTarget] = useState<Node | null>(null),
    [form, setForm] = useState(empty()),
    [postal, setPostal] = useState<Postal[]>([]),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [total, setTotal] = useState(0),
    [editing, setEditing] = useState(false),
    [search, setSearch] = useState(""),
    [state, setState] = useState(""),
    [postalError, setPostalError] = useState(""),
    [postalRetry, setPostalRetry] = useState(0),
    [permissions, setPermissions] = useState<{
      canCreate: boolean;
      canUpdate: boolean;
      canException: boolean;
    } | null>(null),
    [impact, setImpact] = useState<{
      snapshotId: string;
      calculatedAt: string;
      categories: Record<string, { count: number; ids: string[] }>;
    } | null>(null),
    [deactivate, setDeactivate] = useState({
      replacementNodeId: "",
      reason: "",
      exceptionReason: "",
      reviewBy: "",
    });
  const editFocus = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => editFocus.current?.focus());
  }, [editing]);
  const load = async (offset = 0, append = false) => {
    setLoading(true);
    try {
      const r = await api<{
        items: Node[];
        total: number;
        permissions: {
          canCreate: boolean;
          canUpdate: boolean;
          canException: boolean;
        };
      }>(
        `/domain/masters/organization?query=${encodeURIComponent(search)}&state=${encodeURIComponent(state)}&limit=50&offset=${offset}`,
      );
      setItems((current) => (append ? [...current, ...r.items] : r.items));
      setTotal(r.total);
      setPermissions(r.permissions);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [search, state]);
  useEffect(() => {
    if (!error?.fields) return;
    const fieldTargets: Record<string, string> = {
      "geofence.points": "organization-geofence-points",
    };
    const target = Object.keys(error.fields)
      .map((field) => fieldTargets[field])
      .find(Boolean);
    if (!target) return;
    document.getElementById(target)?.focus();
  }, [error]);
  useEffect(() => {
    if (!selected) {
      setImpact(null);
      return;
    }
    void api<{
      snapshotId: string;
      calculatedAt: string;
      categories: Record<string, { count: number; ids: string[] }>;
    }>(`/domain/masters/organization/${selected.id}/impact`)
      .then(setImpact)
      .catch((value) => setError(value as ApiError));
  }, [selected]);
  useEffect(() => {
    if (!/^[1-9][0-9]{5}$/.test(form.postalCode)) {
      setPostal([]);
      setPostalError("");
      return;
    }
    const controller = new AbortController();
    void api<{ items: Postal[] }>(
      `/domain/masters/postal-localities?postalCode=${form.postalCode}`,
      { signal: controller.signal },
    )
      .then((r) => {
        setPostalError("");
        setPostal(r.items);
        if (r.items.length === 1)
          setForm((v) => ({ ...v, postalLocalityId: r.items[0]!.id }));
      })
      .catch((e: ApiError) => setPostalError(e.message));
    return () => controller.abort();
  }, [form.postalCode, postalRetry]);
  const chosen = postal.find((p) => p.id === form.postalLocalityId),
    polygonError = error?.fields?.["geofence.points"]?.join(", ") ?? "",
    filtered = items;
  const mapPoints =
    form.fenceMode === "POLYGON"
      ? form.polygonPoints
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(",").map(Number))
          .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))
      : form.lat && form.lng
        ? [[Number(form.lat), Number(form.lng)]]
        : [];
  const mapPosition = ([lat, lng]: number[]) =>
    `${((lng! + 180) / 360) * 600},${((90 - lat!) / 180) * 240}`;
  const body = () => ({
    code: form.code,
    name: form.name,
    nodeType: form.nodeType,
    parentId: form.parentId || null,
    timezone: form.timezone,
    activeFrom: form.activeFrom,
    activeTo: form.activeTo || null,
    address: form.line1
      ? {
          line1: form.line1,
          line2: form.line2 || null,
          country: "IN",
          postalCode: form.postalCode,
          postalLocalityId: form.postalLocalityId,
        }
      : null,
    geofence:
      form.fenceMode === "POLYGON"
        ? {
            mode: "POLYGON",
            points: form.polygonPoints
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [lat, lng] = line.split(",").map(Number);
                return { lat, lng };
              }),
          }
        : form.fenceMode === "DYNAMIC_RADIUS"
          ? {
              mode: "DYNAMIC_RADIUS",
              radiusKm: Number(form.radiusKm),
              contextualAnchor: "ORGANIZATION_ADDRESS",
            }
          : form.lat && form.lng
            ? {
                mode: "POINT_RADIUS",
                point: { lat: Number(form.lat), lng: Number(form.lng) },
                radiusKm: Number(form.radiusKm),
              }
            : null,
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice("");
    try {
      if (editing && editTarget)
        await api(`/domain/masters/organization/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...body(),
            expectedVersion: editTarget.version,
            reason: form.reason,
          }),
        });
      else
        await api("/domain/masters/organization", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(body()),
        });
      setNotice(
        editing ? "Organization node updated." : "Organization node created.",
      );
      setSelected(null);
      setEditing(false);
      setEditTarget(null);
      setForm(empty());
      setPostal([]);
      await load();
    } catch (e) {
      setError(e as ApiError);
    }
  }
  function open(node: Node) {
    setSelected(node);
    setEditing(false);
    setEditTarget(null);
  }
  function edit() {
    if (!selected) return;
    const a = selected.address;
    setForm({
      ...empty(),
      code: selected.code,
      name: selected.name,
      nodeType: selected.nodeType,
      parentId: selected.parentId ?? "",
      timezone: selected.timezone,
      activeFrom: selected.activeFrom,
      activeTo: selected.activeTo ?? "",
      line1: a?.line1 ?? "",
      line2: a?.line2 ?? "",
      postalCode: a?.postalCode ?? "",
      postalLocalityId: a?.postalLocalityId ?? "",
    });
    setEditTarget(selected);
    setSelected(null);
    setEditing(true);
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">MST-01</p>
          <h1>Organization &amp; geography</h1>
          <p className="muted">
            Build the legal entity, region, branch, hub and team hierarchy. City
            and state always come from the selected PIN.
          </p>
        </div>
        <Link className="button-link" href="/app/access/reports">
          View audit history
        </Link>
      </div>
      {error && (
        <div role="alert" className="error">
          <strong>{error.message}</strong>
          {error.fields &&
            Object.entries(error.fields).map(([k, v]) => (
              <small key={k}>
                {k}: {v.join(", ")}
              </small>
            ))}
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {(permissions?.canCreate || (editing && permissions?.canUpdate)) && (
        <section className="panel">
          <h2>
            {editing ? `Edit ${editTarget?.name}` : "Create organization node"}
          </h2>
          <form className="access-form" onSubmit={submit}>
            <label>
              Code
              <input
                ref={editFocus}
                required
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </label>
            <label>
              Name
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Node type
              <select
                required
                value={form.nodeType}
                onChange={(e) =>
                  setForm({ ...form, nodeType: e.target.value, parentId: "" })
                }
              >
                {Object.keys(parentTypes).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            {form.nodeType === "LEGAL_ENTITY" ? (
              <p className="muted">
                Parent node is not applicable to a root legal entity.
              </p>
            ) : (
              <SmartField
                field={{
                  key: "parentId",
                  label: "Parent node",
                  kind: "reference",
                  referenceResource: "organization-nodes",
                  required: true,
                  help: `Search all permitted active nodes. ${form.nodeType} accepts ${parentTypes[form.nodeType]?.join(" or ")}.`,
                }}
                value={form.parentId}
                onChange={(parentId) => setForm({ ...form, parentId })}
              />
            )}
            <SmartField
              field={{
                key: "timezone",
                label: "Timezone",
                kind: "timezone",
                required: true,
              }}
              value={form.timezone}
              onChange={(timezone) => setForm({ ...form, timezone })}
            />
            <label>
              Active from
              <input
                type="date"
                required
                value={form.activeFrom}
                onChange={(e) =>
                  setForm({ ...form, activeFrom: e.target.value })
                }
              />
            </label>
            <label>
              Active to (Optional)
              <input
                type="date"
                value={form.activeTo}
                onChange={(e) => setForm({ ...form, activeTo: e.target.value })}
              />
            </label>
            <fieldset className="form-section">
              <legend>
                Physical address{" "}
                {!["BRANCH", "HUB"].includes(form.nodeType) && "(Optional)"}
              </legend>
              <label>
                Address line 1
                <input
                  required={["BRANCH", "HUB"].includes(form.nodeType)}
                  value={form.line1}
                  onChange={(e) => setForm({ ...form, line1: e.target.value })}
                />
              </label>
              <label>
                Address line 2 (Optional)
                <input
                  value={form.line2}
                  onChange={(e) => setForm({ ...form, line2: e.target.value })}
                />
              </label>
              <label>
                Country
                <input value="India (IN)" readOnly />
              </label>
              <label>
                PIN code
                <input
                  aria-invalid={postalError ? true : undefined}
                  aria-describedby={
                    postalError ? "organization-postal-error" : undefined
                  }
                  inputMode="numeric"
                  pattern="[1-9][0-9]{5}"
                  maxLength={6}
                  required={!!form.line1}
                  value={form.postalCode}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      postalCode: e.target.value.replace(/\D/g, "").slice(0, 6),
                      postalLocalityId: "",
                    })
                  }
                />
              </label>
              {postal.length > 1 && (
                <label>
                  Locality
                  <select
                    required
                    value={form.postalLocalityId}
                    onChange={(e) =>
                      setForm({ ...form, postalLocalityId: e.target.value })
                    }
                  >
                    <option value="">Select…</option>
                    {postal.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.locality} · {p.district}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {postalError && (
                <p id="organization-postal-error" role="alert">
                  {postalError}{" "}
                  <button
                    type="button"
                    onClick={() => setPostalRetry((value) => value + 1)}
                  >
                    Retry PIN lookup
                  </button>
                </p>
              )}
              {chosen && (
                <div className="derived-fields" aria-live="polite">
                  <span>
                    <b>Locality</b>
                    {chosen.locality}
                  </span>
                  <span>
                    <b>District</b>
                    {chosen.district}
                  </span>
                  <span>
                    <b>City</b>
                    {chosen.city}
                  </span>
                  <span>
                    <b>State</b>
                    {chosen.region}
                  </span>
                </div>
              )}
            </fieldset>
            <fieldset className="form-section">
              <legend>Geofence (Optional)</legend>
              <label>
                Method
                <select
                  value={form.fenceMode}
                  onChange={(e) =>
                    setForm({ ...form, fenceMode: e.target.value })
                  }
                >
                  <option value="POINT_RADIUS">Fixed point and radius</option>
                  <option value="POLYGON">Polygon vertices</option>
                  <option value="DYNAMIC_RADIUS">
                    Radius around contextual location
                  </option>
                </select>
              </label>
              {form.fenceMode !== "DYNAMIC_RADIUS" && (
                <div>
                  <p id="geofence-map-help" className="muted">
                    Click the map to{" "}
                    {form.fenceMode === "POLYGON"
                      ? "add polygon vertices"
                      : "choose the fixed point"}
                    . The labelled coordinate fields below remain the accessible
                    alternative.
                  </p>
                  <svg
                    viewBox="0 0 600 240"
                    role="img"
                    aria-label="Interactive geofence coordinate map"
                    aria-describedby="geofence-map-help"
                    tabIndex={0}
                    className="geofence-map"
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      const lng =
                        ((event.clientX - box.left) / box.width) * 360 - 180;
                      const lat =
                        90 - ((event.clientY - box.top) / box.height) * 180;
                      if (form.fenceMode === "POLYGON")
                        setForm({
                          ...form,
                          polygonPoints: `${form.polygonPoints}${form.polygonPoints ? "\n" : ""}${lat.toFixed(6)},${lng.toFixed(6)}`,
                        });
                      else
                        setForm({
                          ...form,
                          lat: lat.toFixed(6),
                          lng: lng.toFixed(6),
                        });
                    }}
                  >
                    <rect
                      width="600"
                      height="240"
                      fill="#eef4f7"
                      stroke="#73808c"
                    />
                    <path d="M0 120H600M300 0V240" stroke="#b7c1c9" />
                    {form.fenceMode === "POLYGON" && mapPoints.length > 1 && (
                      <polyline
                        points={mapPoints.map(mapPosition).join(" ")}
                        fill="rgba(22,50,79,.16)"
                        stroke="#16324f"
                        strokeWidth="3"
                      />
                    )}
                    {mapPoints.map((point, index) => {
                      const [cx, cy] = mapPosition(point).split(",");
                      return (
                        <circle
                          key={`${cx}-${cy}-${index}`}
                          cx={cx}
                          cy={cy}
                          r="5"
                          fill="#d97706"
                        />
                      );
                    })}
                  </svg>
                </div>
              )}
              {form.fenceMode === "POINT_RADIUS" && (
                <>
                  <label>
                    Latitude (Optional)
                    <input
                      type="number"
                      min="-90"
                      max="90"
                      step="0.000001"
                      value={form.lat}
                      onChange={(e) =>
                        setForm({ ...form, lat: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Longitude (Optional)
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="0.000001"
                      value={form.lng}
                      onChange={(e) =>
                        setForm({ ...form, lng: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {form.fenceMode === "POLYGON" && (
                <label>
                  Polygon vertices
                  <textarea
                    id="organization-geofence-points"
                    required
                    rows={5}
                    aria-invalid={polygonError ? true : undefined}
                    aria-describedby={
                      polygonError
                        ? "organization-geofence-points-help organization-geofence-points-error"
                        : "organization-geofence-points-help"
                    }
                    placeholder={"17.443,78.462\n17.444,78.470\n17.438,78.468"}
                    value={form.polygonPoints}
                    onChange={(event) =>
                      setForm({ ...form, polygonPoints: event.target.value })
                    }
                  />
                  <small id="organization-geofence-points-help">
                    Enter one latitude,longitude vertex per line. Use at least
                    three distinct vertices; the system closes the polygon.
                  </small>
                  {polygonError && (
                    <small
                      id="organization-geofence-points-error"
                      className="error-text"
                      role="alert"
                    >
                      {polygonError}
                    </small>
                  )}
                </label>
              )}
              <label>
                Radius (km)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={form.radiusKm}
                  onChange={(e) =>
                    setForm({ ...form, radiusKm: e.target.value })
                  }
                />
              </label>
              <small>
                Coordinates provide an accessible alternative to selecting the
                point on a map.
              </small>
            </fieldset>
            {editing && (
              <label>
                Reason for change
                <input
                  required
                  minLength={5}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </label>
            )}
            <FormSubmitResult error={error} success={notice}>
              <button className="primary">
                {editing ? "Save changes" : "Create node"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditTarget(null);
                    setForm(empty());
                  }}
                >
                  Cancel
                </button>
              )}
            </FormSubmitResult>
          </form>
        </section>
      )}
      <section className="panel" aria-busy={loading}>
        <div className="panel-title">
          <h2>Organization hierarchy</h2>
          <span className="count">{total}</span>
        </div>
        <div className="filter-bar">
          <label>
            Search
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            State
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All</option>
              <option>ACTIVE</option>
              <option>INACTIVE</option>
            </select>
          </label>
        </div>
        {loading ? (
          <p role="status">Loading organization…</p>
        ) : filtered.length === 0 ? (
          <p className="empty">No matching organization nodes.</p>
        ) : (
          <ul className="hierarchy-tree" role="tree">
            {filtered.map((n) => (
              <li
                role="treeitem"
                aria-level={n.treeDepth + 1}
                key={n.id}
                style={{ marginInlineStart: `${n.treeDepth * 1.25}rem` }}
              >
                <button onClick={() => open(n)}>
                  <strong>
                    {n.code} · {n.name}
                  </strong>
                  <span>
                    {n.nodeType.replaceAll("_", " ")} · {n.state}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length < total && (
          <button type="button" onClick={() => void load(items.length, true)}>
            Load more organization nodes
          </button>
        )}
      </section>
      {selected && (
        <Modal titleId="node-detail" onClose={() => setSelected(null)}>
          <div className="panel-title">
            <h2 id="node-detail">{selected.name}</h2>
            <div className="actions">
              {selected.permissions.update && (
                <button onClick={edit}>Edit</button>
              )}
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          <dl className="details-grid">
            <div>
              <dt>Code</dt>
              <dd>{selected.code}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selected.nodeType}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{selected.state}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{selected.timezone}</dd>
            </div>
            <div>
              <dt>Active employees</dt>
              <dd>{selected.activeEmployeeCount}</dd>
            </div>
            <div>
              <dt>Descendants</dt>
              <dd>{selected.descendantCount}</dd>
            </div>
            {selected.address && (
              <>
                <div>
                  <dt>Address</dt>
                  <dd>
                    {selected.address.line1}
                    {selected.address.line2
                      ? `, ${selected.address.line2}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>PIN / locality</dt>
                  <dd>
                    {selected.address.postalCode} · {selected.address.locality}
                  </dd>
                </div>
                <div>
                  <dt>City / state</dt>
                  <dd>
                    {selected.address.city}, {selected.address.region}
                  </dd>
                </div>
                <div>
                  <dt>Postal evidence</dt>
                  <dd>
                    {selected.address.provenance} ·{" "}
                    {selected.address.directoryVersion}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <Link href={`/app/access/reports?targetId=${selected.id}`}>
            Open related audit events
          </Link>
          {impact && (
            <div className="stats" aria-live="polite">
              {Object.entries(impact.categories).map(([label, detail]) => (
                <article key={label}>
                  <strong>{detail.count}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
          )}
          {selected.state === "ACTIVE" && selected.permissions.deactivate && (
            <form
              className="access-form"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await api(
                    `/domain/masters/organization/${selected.id}/reassign-deactivate`,
                    {
                      method: "POST",
                      headers: { "Idempotency-Key": crypto.randomUUID() },
                      body: JSON.stringify({
                        replacementNodeId: deactivate.replacementNodeId,
                        expectedVersion: selected.version,
                        impactSnapshotId: impact!.snapshotId,
                        reason: deactivate.reason,
                      }),
                    },
                  );
                  setNotice(
                    "Organization responsibilities reassigned and node deactivated.",
                  );
                  setSelected(null);
                  setDeactivate({
                    replacementNodeId: "",
                    reason: "",
                    exceptionReason: "",
                    reviewBy: "",
                  });
                  await load();
                } catch (value) {
                  setError(value as ApiError);
                }
              }}
            >
              <h3>Reassign and deactivate</h3>
              <SmartField
                field={{
                  key: "replacementNodeId",
                  label: "Replacement organization node",
                  kind: "reference",
                  referenceResource: "organization-nodes",
                  required: true,
                  help: "Choose another active node of the same type. Move child nodes first.",
                }}
                value={deactivate.replacementNodeId}
                onChange={(replacementNodeId) =>
                  setDeactivate({ ...deactivate, replacementNodeId })
                }
              />
              <label>
                Reason
                <input
                  required
                  minLength={5}
                  value={deactivate.reason}
                  onChange={(event) =>
                    setDeactivate({ ...deactivate, reason: event.target.value })
                  }
                />
              </label>
              <button>Reassign responsibilities and deactivate</button>
            </form>
          )}
          {selected.state === "ACTIVE" &&
            selected.permissions.deactivate &&
            permissions?.canException &&
            impact && (
              <form
                className="access-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    await api(
                      `/domain/masters/organization/${selected.id}/exception-deactivate`,
                      {
                        method: "POST",
                        headers: { "Idempotency-Key": crypto.randomUUID() },
                        body: JSON.stringify({
                          expectedVersion: selected.version,
                          impactSnapshotId: impact.snapshotId,
                          reason: deactivate.exceptionReason,
                          reviewBy: deactivate.reviewBy,
                        }),
                      },
                    );
                    setNotice(
                      "Organization temporarily deactivated with a tracked review exception.",
                    );
                    setSelected(null);
                    await load();
                  } catch (value) {
                    setError(value as ApiError);
                  }
                }}
              >
                <h3>Temporary deactivation exception</h3>
                <p className="muted">
                  Use when reassignment cannot be completed immediately. This
                  creates a review alert and report entry.
                </p>
                <label>
                  Reason
                  <input
                    required
                    minLength={10}
                    value={deactivate.exceptionReason}
                    onChange={(event) =>
                      setDeactivate({
                        ...deactivate,
                        exceptionReason: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Review by
                  <input
                    required
                    type="date"
                    value={deactivate.reviewBy}
                    onChange={(event) =>
                      setDeactivate({
                        ...deactivate,
                        reviewBy: event.target.value,
                      })
                    }
                  />
                </label>
                <button>Deactivate with temporary exception</button>
              </form>
            )}
        </Modal>
      )}
    </Shell>
  );
}
