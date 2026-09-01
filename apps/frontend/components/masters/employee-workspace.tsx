"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "../api";
import { FormSubmitResult } from "../forms/form-submit-result";
import { SmartField } from "../forms/smart-field";
import { Modal } from "../modal";
import { Shell } from "../shell";

type Node = {
  id: string;
  code: string;
  name: string;
  nodeType: string;
  state: string;
};
type Employee = {
  id: string;
  employeeCode: string;
  displayName: string;
  designation: string;
  email?: string | null;
  mobile?: string | null;
  managerId?: string | null;
  managerName?: string | null;
  homeNodeId: string;
  homeNodeName: string;
  linkedMembershipId?: string | null;
  linkedUser?: boolean;
  linkedUserEmail?: string | null;
  activeFrom: string;
  activeTo?: string | null;
  state: string;
  version: number;
  regions: Array<{ id: string; name: string }>;
  accessSummary: Array<{ role: string; scope: string }>;
  permissions: { update: boolean; deactivate: boolean; assign: boolean };
};
type OwnershipReport = {
  total: number;
  owned: number;
  unowned: number;
  inactiveOwner: number;
  noEscalation: number;
  permissions: { canExport: boolean; canRefreshAlerts: boolean };
  items: Array<{
    id: string;
    resourceKind: string;
    code: string;
    name: string;
    ownerCode?: string | null;
    ownershipState: string;
  }>;
  alerts: Array<{
    id: string;
    alertType: string;
    severity: string;
    state: string;
    evidence: { resourceCode?: string; resourceKind?: string };
  }>;
};
type Impact = {
  snapshotId: string;
  calculatedAt: string;
  versions: { employee: number };
  categories: Record<string, { count: number; ids: string[] }>;
};
type ExceptionRow = {
  id: string;
  targetType: "ORGANIZATION" | "EMPLOYEE";
  targetName: string;
  reason: string;
  reviewBy: string;
  reviewOwnerName: string;
  state: "OPEN" | "RESOLVED" | "EXPIRED";
};
const fresh = () => ({
  employeeCode: "",
  displayName: "",
  designation: "",
  email: "",
  mobile: "",
  managerId: "",
  homeNodeId: "",
  regionIds: [] as string[],
  linkedMembershipId: "",
  activeFrom: new Date().toISOString().slice(0, 10),
  activeTo: "",
  reason: "",
});

export function EmployeeWorkspace() {
  const [items, setItems] = useState<Employee[]>([]),
    [nodes, setNodes] = useState<Node[]>([]),
    [selected, setSelected] = useState<Employee | null>(null),
    [editTarget, setEditTarget] = useState<Employee | null>(null),
    [form, setForm] = useState(fresh());
  const [editing, setEditing] = useState(false),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [total, setTotal] = useState(0),
    [search, setSearch] = useState(""),
    [state, setState] = useState(""),
    [impact, setImpact] = useState<Impact | null>(null),
    [ownership, setOwnership] = useState<OwnershipReport | null>(null),
    [exceptions, setExceptions] = useState<ExceptionRow[]>([]),
    [permissions, setPermissions] = useState<{
      canCreate: boolean;
      canException: boolean;
    } | null>(null),
    [nodeSearch, setNodeSearch] = useState(""),
    [command, setCommand] = useState<Record<string, string>>({});
  const editFocus = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => editFocus.current?.focus());
  }, [editing]);
  const load = async (offset = 0, append = false) => {
    setLoading(true);
    try {
      const [e, n, report, exceptionReport] = await Promise.all([
        api<{
          items: Employee[];
          total: number;
          permissions: { canCreate: boolean; canException: boolean };
        }>(
          `/domain/masters/employees?query=${encodeURIComponent(search)}&state=${encodeURIComponent(state)}&limit=50&offset=${offset}`,
        ),
        api<{ items: Node[] }>(
          `/domain/masters/organization?query=${encodeURIComponent(nodeSearch)}&state=ACTIVE&nodeType=REGION&limit=50&offset=0`,
        ),
        api<OwnershipReport>("/domain/masters/ownership-report"),
        api<{ items: ExceptionRow[] }>("/domain/masters/exceptions"),
      ]);
      setItems((current) => (append ? [...current, ...e.items] : e.items));
      setTotal(e.total);
      setPermissions(e.permissions);
      setNodes(n.items);
      setOwnership(report);
      setExceptions(exceptionReport.items);
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [search, state, nodeSearch]);
  useEffect(() => {
    if (!selected) {
      setImpact(null);
      return;
    }
    void api<Impact>(`/domain/masters/employees/${selected.id}/impact`)
      .then(setImpact)
      .catch((value) => setError(value as ApiError));
  }, [selected]);
  async function run(path: string, payload: unknown) {
    try {
      await api(path, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      setNotice("Responsibilities updated and audit evidence recorded.");
      setSelected(null);
      setCommand({});
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  const contactsMasked =
    editing && (editTarget?.email === "••••" || editTarget?.mobile === "••••");
  const body = () => ({
    employeeCode: form.employeeCode,
    displayName: form.displayName,
    designation: form.designation,
    ...(!contactsMasked
      ? { email: form.email || null, mobile: form.mobile || null }
      : {}),
    managerId: form.managerId || null,
    homeNodeId: form.homeNodeId,
    regionIds: form.regionIds,
    ...(!editing ||
    (editTarget && Object.hasOwn(editTarget, "linkedMembershipId"))
      ? { linkedMembershipId: form.linkedMembershipId || null }
      : {}),
    activeFrom: form.activeFrom,
    activeTo: form.activeTo || null,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice("");
    try {
      if (editing && editTarget)
        await api(`/domain/masters/employees/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...body(),
            expectedVersion: editTarget.version,
            reason: form.reason,
          }),
        });
      else
        await api("/domain/masters/employees", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(body()),
        });
      setNotice(editing ? "Employee updated." : "Employee created.");
      setForm(fresh());
      setEditing(false);
      setEditTarget(null);
      setSelected(null);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  function edit() {
    if (!selected) return;
    setForm({
      employeeCode: selected.employeeCode,
      displayName: selected.displayName,
      designation: selected.designation ?? "",
      email: selected.email === "••••" ? "" : (selected.email ?? ""),
      mobile: selected.mobile === "••••" ? "" : (selected.mobile ?? ""),
      managerId: selected.managerId ?? "",
      homeNodeId: selected.homeNodeId,
      regionIds: selected.regions.map((r) => r.id),
      linkedMembershipId: selected.linkedMembershipId ?? "",
      activeFrom: selected.activeFrom,
      activeTo: selected.activeTo ?? "",
      reason: "",
    });
    setEditTarget(selected);
    setSelected(null);
    setEditing(true);
  }
  const filtered = items;
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">MST-01</p>
          <h1>Employees &amp; ownership</h1>
          <p className="muted">
            Maintain employee profiles, reporting lines, region coverage, linked
            access and operational responsibilities.
          </p>
        </div>
        <Link className="button-link" href="/app/access/users">
          Manage user invitations
        </Link>
      </div>
      {error && (
        <div role="alert" className="error">
          <strong>{error.message}</strong>
          {error.fields &&
            Object.entries(error.fields).map(([key, messages]) => (
              <small key={key}>
                {key}: {messages.join(", ")}
              </small>
            ))}
        </div>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {ownership && (
        <section className="panel">
          <h2>Ownership coverage</h2>
          <div className="stats">
            <article>
              <strong>{ownership.total}</strong>
              <span>Resources reviewed</span>
            </article>
            <article>
              <strong>{ownership.owned}</strong>
              <span>Owned</span>
            </article>
            <article>
              <strong>
                {ownership.unowned +
                  ownership.inactiveOwner +
                  ownership.noEscalation}
              </strong>
              <span>Exceptions</span>
            </article>
          </div>
          <div
            className="table-wrap"
            role="region"
            aria-label="Ownership resource detail"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Code / name</th>
                  <th>Owner</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ownership.items.map((item) => (
                  <tr key={`${item.resourceKind}:${item.id}`}>
                    <td>{item.resourceKind.replaceAll("-", " ")}</td>
                    <td>
                      {item.code} — {item.name}
                    </td>
                    <td>{item.ownerCode ?? "Not assigned"}</td>
                    <td>{item.ownershipState.replaceAll("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            {ownership.permissions.canExport && (
              <a
                className="button-link"
                href="/api/v1/domain/masters/ownership-report/export"
              >
                Export permission-scoped CSV
              </a>
            )}
            {ownership.permissions.canRefreshAlerts && (
              <button
                type="button"
                onClick={() =>
                  void run("/domain/masters/ownership-alerts/evaluate", {})
                }
              >
                Refresh ownership alerts
              </button>
            )}
          </div>
          <h3>Open ownership alerts</h3>
          {ownership.alerts.length ? (
            <ul>
              {ownership.alerts.map((alert) => (
                <li key={alert.id}>
                  <strong>{alert.alertType.replaceAll(".", " ")}</strong> —{" "}
                  {alert.evidence.resourceCode ?? "Resource"} (
                  {alert.evidence.resourceKind ?? "master"}; {alert.severity})
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No open ownership alerts.</p>
          )}
        </section>
      )}
      <section className="panel">
        <h2>Temporary deactivation exceptions</h2>
        {exceptions.length === 0 ? (
          <p className="muted">No temporary deactivation exceptions.</p>
        ) : (
          <div
            className="table-wrap"
            role="region"
            aria-label="Temporary deactivation exception report"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Master</th>
                  <th>Review by</th>
                  <th>Owner</th>
                  <th>State</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.targetType} · {item.targetName}
                    </td>
                    <td>{String(item.reviewBy).slice(0, 10)}</td>
                    <td>{item.reviewOwnerName}</td>
                    <td>{item.state}</td>
                    <td>
                      {permissions?.canException &&
                      item.state !== "RESOLVED" ? (
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              `/domain/masters/exceptions/${item.id}/reactivate`,
                              {
                                reason:
                                  "Exception reviewed and master reactivated",
                              },
                            )
                          }
                        >
                          Reactivate
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {(permissions?.canCreate ||
        (editing && editTarget?.permissions.update)) && (
        <section className="panel">
          <h2>
            {editing ? `Edit ${editTarget?.displayName}` : "Create employee"}
          </h2>
          <form className="access-form" onSubmit={submit}>
            <label>
              Employee code
              <input
                ref={editFocus}
                required
                value={form.employeeCode}
                onChange={(e) =>
                  setForm({ ...form, employeeCode: e.target.value })
                }
              />
            </label>
            <label>
              Display name
              <input
                required
                value={form.displayName}
                onChange={(e) =>
                  setForm({ ...form, displayName: e.target.value })
                }
              />
            </label>
            <label>
              Designation
              <input
                required
                value={form.designation}
                onChange={(e) =>
                  setForm({ ...form, designation: e.target.value })
                }
              />
            </label>
            <label>
              Email (Optional)
              <input
                type="email"
                disabled={contactsMasked}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {contactsMasked && (
                <small>Requires sensitive contact access.</small>
              )}
            </label>
            <label>
              Mobile (Optional)
              <input
                type="tel"
                disabled={contactsMasked}
                placeholder="+919999999999"
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              />
              <small>
                Use an international number. Spaces and punctuation are
                normalized.
              </small>
            </label>
            <SmartField
              field={{
                key: "managerId",
                label: "Manager",
                kind: "reference",
                referenceResource: "employees",
                help: "Optional. Select the employee this person reports to.",
              }}
              value={form.managerId}
              onChange={(managerId) => setForm({ ...form, managerId })}
            />
            <SmartField
              field={{
                key: "homeNodeId",
                label: "Home organization node",
                kind: "reference",
                referenceResource: "organization-nodes",
                required: true,
                help: "Determines the employee's operating scope.",
              }}
              value={form.homeNodeId}
              onChange={(homeNodeId) => setForm({ ...form, homeNodeId })}
            />
            <label>
              Region coverage (Optional)
              <input
                type="search"
                aria-label="Search permitted active regions"
                placeholder="Search regions…"
                value={nodeSearch}
                onChange={(event) => setNodeSearch(event.target.value)}
              />
              <select
                multiple
                value={form.regionIds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    regionIds: Array.from(e.target.selectedOptions).map(
                      (o) => o.value,
                    ),
                  })
                }
              >
                {nodes
                  .filter(
                    (n) => n.nodeType === "REGION" && n.state === "ACTIVE",
                  )
                  .map((n) => (
                    <option value={n.id} key={n.id}>
                      {n.code} · {n.name}
                    </option>
                  ))}
              </select>
              <small>Hold Ctrl/Command to select multiple.</small>
            </label>
            {editing && editTarget?.linkedMembershipId ? (
              <label>
                Linked user membership
                <input
                  readOnly
                  value={
                    editTarget.linkedUserEmail ?? editTarget.linkedMembershipId
                  }
                />
                <small>
                  This employee is linked to an internal user. Reassignment or
                  unlinking requires a governed identity-transfer workflow and
                  cannot be performed from profile editing.
                </small>
              </label>
            ) : (
              <SmartField
                field={{
                  key: "linkedMembershipId",
                  label: "Linked user membership",
                  kind: "reference",
                  referenceResource: "access-users",
                  help: "Optional. Links an existing activated user; invitations are managed from Users.",
                }}
                value={form.linkedMembershipId}
                onChange={(linkedMembershipId) =>
                  setForm({ ...form, linkedMembershipId })
                }
              />
            )}
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
                {editing ? "Save changes" : "Create employee"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditTarget(null);
                    setForm(fresh());
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
          <h2>Employee directory</h2>
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
          <p role="status">Loading employees…</p>
        ) : filtered.length === 0 ? (
          <p className="empty">No matching employees.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Designation</th>
                  <th>Home node</th>
                  <th>Manager</th>
                  <th>State</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((employee) => (
                  <tr key={employee.id}>
                    <td>
                      {employee.employeeCode} · {employee.displayName}
                    </td>
                    <td>{employee.designation || "—"}</td>
                    <td>{employee.homeNodeName}</td>
                    <td>{employee.managerName || "—"}</td>
                    <td>{employee.state}</td>
                    <td>
                      <button
                        onClick={() => {
                          setEditing(false);
                          setEditTarget(null);
                          setSelected(employee);
                        }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items.length < total && (
          <button type="button" onClick={() => void load(items.length, true)}>
            Load more employees
          </button>
        )}
      </section>
      {selected && (
        <Modal titleId="employee-detail" onClose={() => setSelected(null)}>
          <div className="panel-title">
            <h2 id="employee-detail">{selected.displayName}</h2>
            <div className="actions">
              {selected.permissions.update && (
                <button onClick={edit}>Edit</button>
              )}
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          <dl className="details-grid">
            <div>
              <dt>Employee code</dt>
              <dd>{selected.employeeCode}</dd>
            </div>
            <div>
              <dt>Designation</dt>
              <dd>{selected.designation}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{selected.email || "Not provided"}</dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>{selected.mobile || "Not provided"}</dd>
            </div>
            <div>
              <dt>Home node</dt>
              <dd>{selected.homeNodeName}</dd>
            </div>
            <div>
              <dt>Manager</dt>
              <dd>{selected.managerName || "Not assigned"}</dd>
            </div>
            <div>
              <dt>Regions</dt>
              <dd>
                {selected.regions.map((r) => r.name).join(", ") || "None"}
              </dd>
            </div>
            <div>
              <dt>Linked user</dt>
              <dd>{selected.linkedUserEmail || "Not linked"}</dd>
            </div>
            <div>
              <dt>Roles and scopes</dt>
              <dd>
                {selected.accessSummary
                  .map((a) => `${a.role} · ${a.scope}`)
                  .join(", ") || "No linked access"}
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{selected.state}</dd>
            </div>
          </dl>
          <div className="actions">
            <Link
              className="button-link"
              href={`/app/access/reports?targetId=${selected.id}`}
            >
              Audit history
            </Link>
          </div>
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
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  `/domain/commands/employees/${selected.id}/reassign-deactivate`,
                  {
                    replacementEmployeeId: command.replacementEmployeeId,
                    expectedVersion: selected.version,
                    impactSnapshotId: impact?.snapshotId,
                    reason: command.reason,
                  },
                );
              }}
            >
              <h3>Reassign and deactivate</h3>
              <SmartField
                field={{
                  key: "replacementEmployeeId",
                  label: "Replacement employee",
                  kind: "reference",
                  referenceResource: "employees",
                  required: true,
                  help: "Must be active and outside this employee's reporting subtree.",
                }}
                value={command.replacementEmployeeId ?? ""}
                onChange={(replacementEmployeeId) =>
                  setCommand({ ...command, replacementEmployeeId })
                }
              />
              <label>
                Reason
                <input
                  required
                  minLength={5}
                  value={command.reason ?? ""}
                  onChange={(event) =>
                    setCommand({ ...command, reason: event.target.value })
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
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    `/domain/masters/employees/${selected.id}/exception-deactivate`,
                    {
                      expectedVersion: selected.version,
                      impactSnapshotId: impact.snapshotId,
                      reason: command.exceptionReason,
                      reviewBy: command.reviewBy,
                    },
                  );
                }}
              >
                <h3>Temporary deactivation exception</h3>
                <p className="muted">
                  Use only when reassignment cannot be completed immediately.
                  The exception remains visible in the review report and alerts.
                </p>
                <label>
                  Reason
                  <input
                    required
                    minLength={10}
                    value={command.exceptionReason ?? ""}
                    onChange={(event) =>
                      setCommand({
                        ...command,
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
                    value={command.reviewBy ?? ""}
                    onChange={(event) =>
                      setCommand({ ...command, reviewBy: event.target.value })
                    }
                  />
                </label>
                <button>Deactivate with temporary exception</button>
              </form>
            )}
          {selected.permissions.assign && (
            <form
              className="access-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run("/domain/commands/assignments/bulk", {
                  items: [
                    {
                      employeeId: selected.id,
                      assignmentType: command.assignmentType,
                      organizationNodeId:
                        command.organizationNodeId || undefined,
                      clientId: command.clientId || undefined,
                      effectiveFrom: new Date(
                        command.effectiveFrom,
                      ).toISOString(),
                    },
                  ],
                });
              }}
            >
              <h3>Add operational assignment</h3>
              <label>
                Assignment type
                <select
                  required
                  value={command.assignmentType ?? ""}
                  onChange={(event) =>
                    setCommand({
                      ...command,
                      assignmentType: event.target.value,
                    })
                  }
                >
                  <option value="">Select…</option>
                  <option>MANAGER</option>
                  <option>KAM</option>
                  <option>TRAFFIC</option>
                  <option>QUEUE_OWNER</option>
                </select>
              </label>
              <SmartField
                field={{
                  key: "organizationNodeId",
                  label: "Organization node",
                  kind: "reference",
                  referenceResource: "organization-nodes",
                  help: "Optional unless organization-scoped.",
                }}
                value={command.organizationNodeId ?? ""}
                onChange={(organizationNodeId) =>
                  setCommand({ ...command, organizationNodeId })
                }
              />
              <SmartField
                field={{
                  key: "clientId",
                  label: "Client",
                  kind: "reference",
                  referenceResource: "clients",
                  help: "Optional unless client-scoped.",
                }}
                value={command.clientId ?? ""}
                onChange={(clientId) => setCommand({ ...command, clientId })}
              />
              <label>
                Effective from
                <input
                  type="datetime-local"
                  required
                  value={command.effectiveFrom ?? ""}
                  onChange={(event) =>
                    setCommand({
                      ...command,
                      effectiveFrom: event.target.value,
                    })
                  }
                />
              </label>
              <button>Add assignment</button>
            </form>
          )}
        </Modal>
      )}
    </Shell>
  );
}
