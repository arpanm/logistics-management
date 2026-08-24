"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type ApiError } from "./api";
import { Shell } from "./shell";

type Role = {
  id: string;
  code: string;
  name: string;
  capabilityCount: number;
  userCount: number;
  capabilities: string[];
  protected: boolean;
  status: string;
};
type Scope = {
  id: string;
  code: string;
  name: string;
  path: string;
  scope_type: string;
};
type User = {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
  portalAudience: string;
  identifier: string;
  roles: string[];
  roleCount: number;
  activeSessions: number;
  version: number;
};

const newKey = () => crypto.randomUUID();
function useRequestKey(body: unknown) {
  const state = useRef({ body: "", key: newKey() });
  const canonical = JSON.stringify(body);
  if (state.current.body !== canonical)
    state.current = { body: canonical, key: newKey() };
  return state.current.key;
}

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [success, setSuccess] = useState(""),
    [detail, setDetail] = useState<Record<string, unknown> | null>(null),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({
    displayName: "",
    employeeCode: "",
    email: "",
    mobile: "",
    portalAudience: "INTERNAL",
    roleId: "",
    scopeNodeId: "",
    actions: ["READ"],
  });
  const key = useRequestKey(form),
    errorRef = useRef<HTMLDivElement>(null);
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const [directory, roleData, scopeData] = await Promise.all([
        api<{ items: User[] }>("/tenant/access/users", { signal }),
        api<Role[]>("/tenant/access/roles", { signal }),
        api<Scope[]>("/tenant/access/scopes", { signal }),
      ]);
      setUsers(directory.items);
      setRoles(roleData);
      setScopes(scopeData);
      setForm((value) => ({
        ...value,
        roleId:
          value.roleId ||
          roleData.find((r) => r.code === "REGIONAL_MANAGER")?.id ||
          roleData[0]?.id ||
          "",
        scopeNodeId: value.scopeNodeId || scopeData[0]?.id || "",
      }));
    } catch (value) {
      if ((value as DOMException).name !== "AbortError")
        setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess("");
    const payload = {
      displayName: form.displayName,
      employeeCode: form.employeeCode,
      ...(form.email ? { email: form.email } : {}),
      ...(form.mobile ? { mobile: form.mobile } : {}),
      authenticationMethod: "LOCAL_PASSWORD",
      portalAudience: form.portalAudience,
      assignments: [
        {
          roleId: form.roleId,
          grants: [{ scopeNodeId: form.scopeNodeId, actions: form.actions }],
        },
      ],
      expiresInHours: 72,
      reason: "Approved access invitation",
    };
    try {
      const result = await api<{ invitationUrl?: string }>(
        "/tenant/access/users",
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify(payload),
        },
      );
      setSuccess(
        result.invitationUrl
          ? `Invitation created. Local acceptance link: ${result.invitationUrl}`
          : "Invitation created and queued for delivery.",
      );
      setForm((value) => ({
        ...value,
        displayName: "",
        employeeCode: "",
        email: "",
        mobile: "",
      }));
      await load();
    } catch (value) {
      setError(value as ApiError);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }
  async function openUser(user: User) {
    try {
      setDetail(await api(`/tenant/access/users/${user.id}`));
      setPreview(null);
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function userAction(
    user: User,
    action: "suspend" | "reactivate" | "sessions/reset" | "mfa/reset",
  ) {
    try {
      await api(`/tenant/access/users/${user.id}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({
          expectedVersion: user.version,
          reason: `Approved ${action.replace("/", " ")} from user directory`,
        }),
      });
      setSuccess(`User action completed: ${action}.`);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function previewCurrentAccess() {
    if (!detail) return;
    try {
      setPreview(
        await api(`/tenant/access/users/${String(detail.id)}/preview`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: Number(detail.version),
            assignments: detail.assignments,
          }),
        }),
      );
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Access</p>
          <h1>User directory</h1>
          <p className="muted">Invite users and manage tenant-scoped access.</p>
        </div>
      </div>
      {error && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="error">
          <strong>{error.message}</strong>
          {error.fields &&
            Object.entries(error.fields).map(([field, messages]) => (
              <small key={field}>
                {field}: {messages.join(", ")}
              </small>
            ))}
        </div>
      )}
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      <section className="panel" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite user</h2>
        <form
          className="access-form"
          noValidate
          onSubmit={(e) => void submit(e)}
        >
          <label>
            Display name
            <input
              required
              minLength={2}
              value={form.displayName}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
            />
          </label>
          <label>
            Employee code
            <input
              required
              pattern="[A-Z0-9-]{2,30}"
              value={form.employeeCode}
              onChange={(e) =>
                setForm({ ...form, employeeCode: e.target.value.toUpperCase() })
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Mobile (E.164)
            <input
              autoComplete="tel"
              placeholder="+919876543210"
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
            />
          </label>
          <label>
            Portal audience
            <select
              value={form.portalAudience}
              onChange={(e) =>
                setForm({ ...form, portalAudience: e.target.value })
              }
            >
              <option>INTERNAL</option>
              <option>VENDOR</option>
              <option>DRIVER</option>
              <option>CLIENT</option>
            </select>
          </label>
          <label>
            Role
            <select
              required
              value={form.roleId}
              onChange={(e) => setForm({ ...form, roleId: e.target.value })}
            >
              {roles
                .filter((r) => r.status === "ACTIVE")
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Scope
            <select
              required
              value={form.scopeNodeId}
              onChange={(e) =>
                setForm({ ...form, scopeNodeId: e.target.value })
              }
            >
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.path}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Actions</legend>
            {["READ", "CREATE", "UPDATE", "APPROVE", "EXPORT", "ADMIN"].map(
              (action) => (
                <label className="check" key={action}>
                  <input
                    type="checkbox"
                    checked={form.actions.includes(action)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        actions: e.target.checked
                          ? [...form.actions, action]
                          : form.actions.filter((a) => a !== action),
                      })
                    }
                  />
                  {action}
                </label>
              ),
            )}
          </fieldset>
          <button className="primary" type="submit">
            Review and send invitation
          </button>
        </form>
      </section>
      <section className="panel" aria-busy={loading}>
        <div className="panel-title">
          <h2>Users</h2>
          <span className="count">{users.length}</span>
        </div>
        {loading ? (
          <p role="status">Loading users…</p>
        ) : users.length === 0 ? (
          <p className="empty">No users match the current filters.</p>
        ) : (
          <div className="responsive-list">
            {users.map((user) => (
              <article className="access-card" key={user.id}>
                <div>
                  <h3>{user.displayName}</h3>
                  <p>
                    {user.identifier} · {user.employeeCode}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>{user.status}</dd>
                  </div>
                  <div>
                    <dt>Roles</dt>
                    <dd>{user.roles.join(", ") || "None"}</dd>
                  </div>
                  <div>
                    <dt>Sessions</dt>
                    <dd>{user.activeSessions}</dd>
                  </div>
                </dl>
                <div className="actions">
                  <button type="button" onClick={() => void openUser(user)}>
                    View details
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void userAction(
                        user,
                        user.status === "SUSPENDED" ? "reactivate" : "suspend",
                      )
                    }
                  >
                    {user.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void userAction(user, "sessions/reset")}
                  >
                    Reset sessions
                  </button>
                  <button
                    type="button"
                    onClick={() => void userAction(user, "mfa/reset")}
                  >
                    Reset MFA
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {detail && (
        <section
          className="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-detail-title"
        >
          <div className="panel-title">
            <h2 id="user-detail-title">User access details</h2>
            <button
              type="button"
              onClick={() => setDetail(null)}
              aria-label="Close user details"
            >
              Close
            </button>
          </div>
          <pre className="safe-json">{JSON.stringify(detail, null, 2)}</pre>
          <button type="button" onClick={() => void previewCurrentAccess()}>
            Preview current access
          </button>
          {preview && (
            <>
              <h3>Authorization preview</h3>
              <pre className="safe-json">
                {JSON.stringify(preview, null, 2)}
              </pre>
            </>
          )}
        </section>
      )}
    </Shell>
  );
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]),
    [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const c = new AbortController();
    api<Role[]>("/tenant/access/roles", { signal: c.signal })
      .then(setRoles)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      });
    return () => c.abort();
  }, []);
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Access</p>
          <h1>Roles and capabilities</h1>
          <p className="muted">
            Capabilities are centrally versioned; roles select from the
            catalogue.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error.message}
        </p>
      )}
      <section className="panel">
        <h2>Tenant roles</h2>
        <div className="responsive-list">
          {roles.map((role) => (
            <article className="access-card" key={role.id}>
              <div>
                <h3>{role.name}</h3>
                <p>
                  {role.code}
                  {role.protected ? " · Protected" : ""}
                </p>
              </div>
              <dl>
                <div>
                  <dt>Capabilities</dt>
                  <dd>{role.capabilityCount}</dd>
                </div>
                <div>
                  <dt>Users</dt>
                  <dd>{role.userCount}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{role.status}</dd>
                </div>
              </dl>
              <details>
                <summary>Capability details</summary>
                <ul>
                  {role.capabilities.map((capability) => (
                    <li key={capability}>{capability}</li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
      </section>
    </Shell>
  );
}

export function ProbesPage({
  audience,
}: {
  audience?: "vendor" | "driver" | "client";
}) {
  const [data, setData] = useState<{
      items: Array<Record<string, unknown>>;
      total: number;
    } | null>(null),
    [error, setError] = useState<ApiError | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [createLabel, setCreateLabel] = useState(""),
    [scopeId, setScopeId] = useState(""),
    [driverId, setDriverId] = useState(""),
    [operationResult, setOperationResult] = useState<Record<
      string,
      unknown
    > | null>(null);
  const title = audience
    ? `${audience[0]!.toUpperCase()}${audience.slice(1)} portal`
    : "Access proof";
  useEffect(() => {
    const c = new AbortController();
    api<{ items: Array<Record<string, unknown>>; total: number }>(
      "/tenant/access/probes",
      { signal: c.signal },
    )
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      });
    return () => c.abort();
  }, []);
  useEffect(() => {
    if (audience) return;
    const c = new AbortController();
    Promise.all([
      api<Scope[]>("/tenant/access/scopes", { signal: c.signal }),
      api<{ items: User[] }>("/tenant/access/users", { signal: c.signal }),
    ])
      .then(([scopeData, userData]) => {
        setScopes(scopeData);
        setUsers(userData.items);
        setScopeId(scopeData[0]?.id ?? "");
      })
      .catch((value) => {
        if (value.name !== "AbortError") setError(value);
      });
    return () => c.abort();
  }, [audience]);
  async function operation(
    item: Record<string, unknown>,
    action: "preview" | "update" | "approve" | "reassign",
  ) {
    try {
      if (action === "preview") {
        const result = await api("/tenant/access/operations/preview", {
          method: "POST",
          body: JSON.stringify({
            capability: "probe.read",
            action: "READ",
            resourceId: item.id,
          }),
        });
        setError(null);
        setOperationResult(result as Record<string, unknown>);
      } else if (action === "update") {
        await api(`/tenant/access/probes/${String(item.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedVersion: Number(item.version),
            status: "COMPLETED",
          }),
        });
      } else if (action === "approve") {
        await api(`/tenant/access/probes/${String(item.id)}/approve`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: Number(item.version),
            reason: "Approved after operational review",
          }),
        });
      } else {
        await api(`/tenant/access/probes/${String(item.id)}/reassign`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: Number(item.version),
            assignedUserId: driverId,
            reason: "Driver reassigned after operational review",
          }),
        });
      }
      location.reload();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/tenant/access/probes", {
        method: "POST",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({
          label: createLabel,
          resourceType: "WORK_ITEM",
          scopeNodeIds: [scopeId],
          status: "OPEN",
        }),
      });
      location.reload();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">{audience ? "Portal" : "Access"}</p>
          <h1>{title}</h1>
          <p className="muted">
            Only server-authorized work items and masked fields are shown.
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error">
          {error.message}
          <button onClick={() => location.reload()}>Retry</button>
        </div>
      )}
      {!audience && (
        <section className="panel">
          <h2>Create access proof</h2>
          <form
            className="access-form"
            onSubmit={(event) => void create(event)}
          >
            <label>
              Label
              <input
                required
                value={createLabel}
                onChange={(event) => setCreateLabel(event.target.value)}
              />
            </label>
            <label>
              Scope
              <select
                required
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
              >
                {scopes.map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scope.path}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary">
              Create proof
            </button>
          </form>
          <label>
            Reassign trip to driver
            <select
              value={driverId}
              onChange={(event) => setDriverId(event.target.value)}
            >
              <option value="">Select driver</option>
              {users
                .filter((user) => user.portalAudience === "DRIVER")
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName}
                  </option>
                ))}
            </select>
          </label>
          <a className="button" href="/api/v1/tenant/access/probes/export">
            Export visible work
          </a>
        </section>
      )}
      {operationResult && (
        <section className="panel" role="status">
          <h2>Operation preview</h2>
          <pre className="safe-json">
            {JSON.stringify(operationResult, null, 2)}
          </pre>
        </section>
      )}
      <section className="panel" aria-busy={!data}>
        {!data ? (
          <p role="status">Loading work queue…</p>
        ) : data.items.length === 0 ? (
          <p className="empty">
            There are no work items in your current scope.
          </p>
        ) : (
          <div className="responsive-list">
            {data.items.map((item) => (
              <article className="access-card" key={String(item.id)}>
                <div>
                  <h3>{String(item.label)}</h3>
                  <p>{String(item.status)}</p>
                </div>
                <pre className="safe-json">{JSON.stringify(item, null, 2)}</pre>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void operation(item, "preview")}
                  >
                    Preview access
                  </button>
                  <button
                    type="button"
                    onClick={() => void operation(item, "update")}
                  >
                    Complete
                  </button>
                  {!audience && (
                    <button
                      type="button"
                      onClick={() => void operation(item, "approve")}
                    >
                      Approve
                    </button>
                  )}
                  {!audience && item.resourceType === "TRIP" && (
                    <button
                      type="button"
                      disabled={!driverId}
                      onClick={() => void operation(item, "reassign")}
                    >
                      Reassign driver
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}

export function ReportsPage() {
  const [type, setType] = useState("users"),
    [items, setItems] = useState<Array<Record<string, unknown>>>([]),
    [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null);
  async function exportReport() {
    try {
      const result = await api<{ filename: string; csv: string }>(
        `/tenant/access/reports/${type}/export`,
      );
      const href = URL.createObjectURL(
        new Blob([result.csv], { type: "text/csv" }),
      );
      const link = document.createElement("a");
      link.href = href;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(href);
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function updateAlert(
    alert: Record<string, unknown>,
    action: "acknowledge" | "resolve",
  ) {
    try {
      await api(`/tenant/access/alerts/${String(alert.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: Number(alert.version),
          reason: `${action === "resolve" ? "Resolved" : "Acknowledged"} after security review`,
        }),
      });
      setAlerts((current) =>
        current.map((item) =>
          item.id === alert.id
            ? {
                ...item,
                state: action === "resolve" ? "RESOLVED" : "ACKNOWLEDGED",
                version: Number(item.version) + 1,
              }
            : item,
        ),
      );
    } catch (value) {
      setError(value as ApiError);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    Promise.all([
      api<{ items: Array<Record<string, unknown>> }>(
        `/tenant/access/reports/${type}`,
        { signal: c.signal },
      ),
      api<{ items: Array<Record<string, unknown>> }>("/tenant/access/alerts", {
        signal: c.signal,
      }),
    ])
      .then(([report, alertData]) => {
        setItems(report.items);
        setAlerts(alertData.items);
        setError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      })
      .finally(() => setLoading(false));
    return () => c.abort();
  }, [type]);
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Security</p>
          <h1>Reports and alerts</h1>
          <p className="muted">Canonical tenant-scoped access evidence.</p>
        </div>
      </div>
      <section className="panel">
        <label>
          Report
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="users">Users</option>
            <option value="roles">Role assignments</option>
            <option value="sessions">Active sessions</option>
            <option value="permission-changes">Permission changes</option>
            <option value="security-events">Denials</option>
            <option value="failed-logins">Failed logins</option>
            <option value="dormant">Dormant users</option>
            <option value="privileged-actions">Privileged actions</option>
          </select>
        </label>
        <button type="button" onClick={() => void exportReport()}>
          Export CSV
        </button>
        {error && (
          <p role="alert" className="error">
            {error.message}
          </p>
        )}
        {loading ? (
          <p role="status">Loading report…</p>
        ) : (
          <div className="responsive-list">
            {items.map((item, index) => (
              <pre className="safe-json" key={String(item.id ?? index)}>
                {JSON.stringify(item, null, 2)}
              </pre>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Security alerts</h2>
        {alerts.length ? (
          alerts.map((alert, index) => (
            <article className="access-card" key={String(alert.id ?? index)}>
              <pre className="safe-json">{JSON.stringify(alert, null, 2)}</pre>
              {alert.state !== "RESOLVED" && (
                <div className="actions">
                  {alert.state === "OPEN" && (
                    <button
                      type="button"
                      onClick={() => void updateAlert(alert, "acknowledge")}
                    >
                      Acknowledge
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void updateAlert(alert, "resolve")}
                  >
                    Resolve
                  </button>
                </div>
              )}
            </article>
          ))
        ) : (
          <p className="empty">No open security alerts.</p>
        )}
      </section>
    </Shell>
  );
}

export function AcceptAccessPage() {
  const search = useSearchParams(),
    router = useRouter(),
    invitationToken = useRef(search.get("token") ?? ""),
    token = invitationToken.current;
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState<ApiError | null>(null),
    [form, setForm] = useState({
      displayName: "",
      password: "",
      confirmation: "",
      currentPassword: "",
      termsAccepted: false,
    });
  useEffect(() => {
    if (!token) return;
    api<Record<string, unknown>>(
      `/auth/access-invitations/${encodeURIComponent(token)}/preview`,
    )
      .then((value) => {
        setPreview(value);
        history.replaceState({}, "", "/accept-access");
      })
      .catch(setError);
  }, [token]);
  async function accept(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!form.termsAccepted) {
      setError({
        code: "VALIDATION_FAILED",
        message: "Accept the terms to continue",
      });
      document.getElementById("access-terms")?.focus();
      return;
    }
    try {
      const result = await api<{ home: string; mfaRequired: boolean }>(
        `/auth/access-invitations/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          body: JSON.stringify({
            displayName: form.displayName,
            ...(preview?.existingIdentity
              ? { currentPassword: form.currentPassword }
              : {
                  password: form.password,
                  passwordConfirmation: form.confirmation,
                }),
            termsAccepted: form.termsAccepted,
          }),
        },
      );
      setForm({
        displayName: "",
        password: "",
        confirmation: "",
        currentPassword: "",
        termsAccepted: false,
      });
      router.replace(result.mfaRequired ? "/mfa" : result.home);
    } catch (value) {
      setError(value as ApiError);
      setForm((v) => ({
        ...v,
        password: "",
        confirmation: "",
        currentPassword: "",
      }));
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="brand-mark large">RG</span>
        <h1>Accept access invitation</h1>
        {error && (
          <p className="error" role="alert">
            {error.message}
          </p>
        )}
        {!preview ? (
          <p role="status">Checking invitation…</p>
        ) : (
          <>
            <p>
              You were invited to <strong>{String(preview.tenantName)}</strong>{" "}
              via {String(preview.maskedDestination)}.
            </p>
            <p>
              Expires{" "}
              {new Date(String(preview.expiresAt)).toLocaleString(undefined, {
                timeZone: String(preview.timezone),
              })}{" "}
              ({String(preview.timezone)}).
            </p>
            <form noValidate onSubmit={(e) => void accept(e)}>
              <label>
                Display name
                <input
                  required
                  autoComplete="name"
                  value={form.displayName}
                  onChange={(e) =>
                    setForm({ ...form, displayName: e.target.value })
                  }
                />
              </label>
              {preview.existingIdentity ? (
                <label>
                  Current password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={form.currentPassword}
                    onChange={(e) =>
                      setForm({ ...form, currentPassword: e.target.value })
                    }
                  />
                </label>
              ) : (
                <>
                  <label>
                    Create password
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Confirm password
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      value={form.confirmation}
                      onChange={(e) =>
                        setForm({ ...form, confirmation: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              <label className="checkbox-label" htmlFor="access-terms">
                <input
                  id="access-terms"
                  type="checkbox"
                  required
                  aria-describedby="access-terms-help"
                  checked={form.termsAccepted}
                  onChange={(e) =>
                    setForm({ ...form, termsAccepted: e.target.checked })
                  }
                />
                I accept the access and acceptable-use terms
              </label>
              <p id="access-terms-help" className="field-help">
                Required to activate this account.
              </p>
              <button className="primary" type="submit">
                Accept invitation
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

export function MfaPage() {
  const router = useRouter(),
    [setup, setSetup] = useState<{
      factorId: string;
      provisioningUri: string;
      testCodes?: [string, string];
    } | null>(null),
    [codes, setCodes] = useState(["", ""]),
    [recovery, setRecovery] = useState<string[] | null>(null),
    [error, setError] = useState<ApiError | null>(null);
  async function start() {
    try {
      setSetup(await api("/auth/mfa/totp/setup", { method: "POST" }));
    } catch (e) {
      setError(e as ApiError);
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!setup) return;
    try {
      const value = await api<{ recoveryCodes: string[] }>(
        "/auth/mfa/totp/confirm",
        {
          method: "POST",
          body: JSON.stringify({ factorId: setup.factorId, codes }),
        },
      );
      setCodes(["", ""]);
      setRecovery(value.recoveryCodes);
    } catch (v) {
      setCodes(["", ""]);
      setError(v as ApiError);
    }
  }
  async function acknowledge() {
    if (!setup) return;
    try {
      await api("/auth/mfa/recovery/acknowledge", {
        method: "POST",
        body: JSON.stringify({ factorId: setup.factorId, acknowledged: true }),
      });
      setRecovery(null);
      router.replace("/app");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Secure your account</h1>
        {error && (
          <p role="alert" className="error">
            {error.message}
          </p>
        )}
        {!setup && (
          <button className="primary" onClick={() => void start()}>
            Set up authenticator
          </button>
        )}
        {setup && !recovery && (
          <>
            <p>
              Scan this provisioning URI in your authenticator. It is displayed
              once.
            </p>
            <code className="break-word">{setup.provisioningUri}</code>
            <form onSubmit={(e) => void confirm(e)}>
              <label>
                First code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  value={codes[0]}
                  onChange={(e) => setCodes([e.target.value, codes[1]])}
                />
              </label>
              <label>
                Next code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  value={codes[1]}
                  onChange={(e) => setCodes([codes[0], e.target.value])}
                />
              </label>
              <button className="primary">Verify</button>
            </form>
          </>
        )}
        {recovery && (
          <>
            <p role="status">
              MFA is active. Save these recovery codes now; they will not be
              shown again.
            </p>
            <ul>
              {recovery.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <button className="primary" onClick={() => void acknowledge()}>
              I saved the codes
            </button>
          </>
        )}
      </section>
    </main>
  );
}
