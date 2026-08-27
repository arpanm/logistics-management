"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type ApiError } from "./api";
import { Shell } from "./shell";
import { FormSubmitResult } from "./forms/form-submit-result";

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
type AccessGrant = { scopeNodeId: string; actions: string[] };
type AccessAssignment = {
  assignmentId?: string;
  roleId: string;
  roleName?: string;
  grants: AccessGrant[];
};
type UserDetail = {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
  portalAudience: string;
  authorizationVersion: number;
  version: number;
  email?: string | null;
  mobile?: string | null;
  assignments: AccessAssignment[];
};
type UserDossier = {
  profile: {
    id: string;
    displayName: string;
    employeeCode: string;
    status: string;
    portalAudience: string;
    email?: string | null;
    mobile?: string | null;
    version: number;
  };
  invitation: null | {
    destination: string;
    expiresAt: string;
    deliveryState: string;
    usedAt?: string | null;
    revokedAt?: string | null;
  };
  sessions: Array<{
    id: string;
    createdAt: string;
    expiresAt: string;
    assuranceLevel: string;
    revokedAt?: string | null;
    revokedReason?: string | null;
  }>;
  mfa: Array<{
    factorType: string;
    createdAt: string;
    verifiedAt?: string | null;
    disabledAt?: string | null;
  }>;
  history: Array<{
    action: string;
    occurredAt: string;
    reason?: string | null;
    correlationId: string;
  }>;
};
type AccessPreview = {
  fingerprint: string;
  authorizationVersion: number;
  decisions: Array<{
    capability: string;
    action: string;
    scopeNodeId: string;
    allowed: boolean;
    reason: string;
    role?: string;
  }>;
};

const words = (value: unknown) =>
  String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const displayValue = (value: unknown) => {
  if (value === null || value === undefined || value === "")
    return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return new Date(value).toLocaleString();
  return words(value);
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
    [scopes, setScopes] = useState<Scope[]>([]),
    [availableActions, setAvailableActions] = useState({
      canReadTenantRoles: false,
      canAdminTenantUsers: false,
      canResetTenantSessions: false,
      canResetMfa: false,
    }),
    [supportNotice, setSupportNotice] = useState("");
  const [filters, setFilters] = useState({
      search: "",
      status: "",
      audience: "",
      roleId: "",
      sessionState: "",
    }),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [dossier, setDossier] = useState<UserDossier | null>(null),
    [profile, setProfile] = useState({
      displayName: "",
      employeeCode: "",
      email: "",
      mobile: "",
      portalAudience: "INTERNAL",
      reason: "Profile corrected after administrator review",
    });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [success, setSuccess] = useState(""),
    [detail, setDetail] = useState<UserDetail | null>(null),
    [preview, setPreview] = useState<AccessPreview | null>(null),
    [activationLink, setActivationLink] = useState(""),
    [activationReason, setActivationReason] = useState(
      "User needs a new activation link",
    ),
    [copyStatus, setCopyStatus] = useState(""),
    [activationPending, setActivationPending] = useState(false),
    [passwordResetLink, setPasswordResetLink] = useState(""),
    [passwordResetReason, setPasswordResetReason] = useState(
      "User requested account recovery assistance",
    ),
    [passwordResetPending, setPasswordResetPending] = useState(false),
    [passwordResetStatus, setPasswordResetStatus] = useState(""),
    [accessReason, setAccessReason] = useState(
      "Access updated after administrator review",
    );
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
  useEffect(() => {
    if (!activationLink) return;
    const timer = window.setTimeout(
      () => {
        setActivationLink("");
        setCopyStatus("Activation link cleared for security.");
      },
      5 * 60 * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [activationLink]);
  useEffect(() => {
    if (!passwordResetLink) return;
    const timer = window.setTimeout(
      () => {
        setPasswordResetLink("");
        setPasswordResetStatus("Password reset link cleared for security.");
      },
      5 * 60 * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [passwordResetLink]);
  function closeUser() {
    setActivationLink("");
    setCopyStatus("");
    setPasswordResetLink("");
    setPasswordResetStatus("");
    setPreview(null);
    setDetail(null);
    setDossier(null);
  }
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: "25" });
      Object.entries(filters).forEach(([name, value]) => {
        if (value) query.set(name, value);
      });
      const [directory, effective] = await Promise.all([
        api<{ items: User[]; total: number }>(
          `/tenant/access/remediation/users?${query.toString()}`,
          { signal },
        ),
        api<{
          capabilities: string[];
          actions: typeof availableActions;
        }>("/tenant/access/effective", { signal }),
      ]);
      const mayLoadAdminReferences =
        effective.actions.canReadTenantRoles &&
        effective.actions.canAdminTenantUsers;
      const [roleResult, scopeResult] = mayLoadAdminReferences
        ? await Promise.allSettled([
            api<Role[]>("/tenant/access/roles", { signal }),
            api<Scope[]>("/tenant/access/scopes", { signal }),
          ])
        : [
            { status: "fulfilled", value: [] as Role[] } as const,
            { status: "fulfilled", value: [] as Scope[] } as const,
          ];
      const roleData =
        roleResult.status === "fulfilled" ? roleResult.value : [];
      const scopeData =
        scopeResult.status === "fulfilled" ? scopeResult.value : [];
      setUsers(directory.items);
      setTotal(directory.total);
      setRoles(roleData);
      setScopes(scopeData);
      setAvailableActions(effective.actions);
      setSupportNotice(
        roleResult.status === "rejected" || scopeResult.status === "rejected"
          ? "The directory is available, but role or scope administration is not permitted for this account."
          : "",
      );
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
  }, [filters, page]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const canAdminUsers = availableActions.canAdminTenantUsers;
  const canResetSessions = availableActions.canResetTenantSessions;
  const canResetMfa = availableActions.canResetMfa;
  const canEditAccess = canAdminUsers && roles.length > 0 && scopes.length > 0;
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
          ? "Invitation created. Open the pending user to generate and copy an activation link."
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
    }
  }
  async function openUser(user: User) {
    try {
      const [nextDetail, nextDossier] = await Promise.all([
        api<UserDetail>(`/tenant/access/users/${user.id}`),
        api<UserDossier>(`/tenant/access/remediation/users/${user.id}`),
      ]);
      setDetail(nextDetail);
      setDossier(nextDossier);
      setProfile({
        displayName: nextDossier.profile.displayName,
        employeeCode: nextDossier.profile.employeeCode,
        email: "",
        mobile: "",
        portalAudience: nextDossier.profile.portalAudience,
        reason: "Profile corrected after administrator review",
      });
      setPreview(null);
      setActivationLink("");
      setCopyStatus("");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!detail || !dossier) return;
    try {
      await api(`/tenant/access/remediation/users/${detail.id}/profile`, {
        method: "PATCH",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({
          ...profile,
          email: profile.email || undefined,
          mobile: profile.mobile || undefined,
          expectedVersion: dossier.profile.version,
        }),
      });
      setSuccess("User profile updated and recorded in activity history.");
      const current = users.find((user) => user.id === detail.id);
      if (current) await openUser(current);
      await load();
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
        await api<AccessPreview>(`/tenant/access/users/${detail.id}/preview`, {
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
  async function applyCurrentAccess() {
    if (!detail || !preview) return;
    try {
      await api(`/tenant/access/users/${detail.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({
          expectedVersion: detail.version,
          assignments: detail.assignments,
          reason: accessReason,
          previewFingerprint: preview.fingerprint,
        }),
      });
      setSuccess("The reviewed access configuration was applied.");
      setDetail(await api<UserDetail>(`/tenant/access/users/${detail.id}`));
      setPreview(null);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function invitationAction(action: "resend" | "revoke") {
    if (!detail) return;
    setActivationPending(true);
    try {
      const result = await api<{ invitationUrl?: string; version?: number }>(
        `/tenant/access/users/${detail.id}/invitations/${action}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": newKey() },
          body: JSON.stringify({
            expectedVersion: detail.version,
            reason: activationReason,
          }),
        },
      );
      if (action === "resend") {
        setActivationLink(result.invitationUrl ?? "");
        if (result.version)
          setDetail((current) =>
            current ? { ...current, version: result.version! } : current,
          );
        setCopyStatus("");
        setSuccess(
          "A new activation link was generated. Every older link is now invalid.",
        );
      } else {
        setActivationLink("");
        setSuccess("The pending invitation was revoked.");
        setDetail(null);
      }
      await load();
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setActivationPending(false);
    }
  }
  async function copyActivationLink() {
    if (!activationLink) return;
    try {
      await navigator.clipboard.writeText(activationLink);
      setCopyStatus("Activation link copied.");
    } catch {
      const input = document.getElementById(
        "activation-link",
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
      setCopyStatus(
        "Copy was blocked. The link is selected; press Control+C or Command+C.",
      );
    }
  }
  async function issuePasswordReset() {
    if (!detail) return;
    setPasswordResetPending(true);
    setPasswordResetStatus("");
    try {
      const result = await api<{
        resetUrl?: string;
        expiresAt: string;
        replayed?: boolean;
      }>(`/tenant/access/users/${detail.id}/password-reset`, {
        method: "POST",
        headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({
          expectedVersion: detail.version,
          reason: passwordResetReason,
          expiresInHours: 1,
        }),
      });
      setPasswordResetLink(result.resetUrl ?? "");
      setSuccess(
        result.resetUrl
          ? "A one-time password reset link was generated. Older reset links are now invalid."
          : "This request was already processed; its bearer link cannot be displayed again.",
      );
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setPasswordResetPending(false);
    }
  }
  async function copyPasswordResetLink() {
    if (!passwordResetLink) return;
    try {
      await navigator.clipboard.writeText(passwordResetLink);
      setPasswordResetStatus("Password reset link copied.");
    } catch {
      const input = document.getElementById(
        "password-reset-link",
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
      setPasswordResetStatus(
        "Copy was blocked. The link is selected; press Control+C or Command+C.",
      );
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
      {supportNotice && (
        <p className="notice" role="status">
          {supportNotice}
        </p>
      )}
      {canEditAccess && (
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
                  setForm({
                    ...form,
                    employeeCode: e.target.value.toUpperCase(),
                  })
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
            <FormSubmitResult error={error} success={success}>
              <button className="primary" type="submit">
                Review and send invitation
              </button>
            </FormSubmitResult>
          </form>
        </section>
      )}
      <section className="panel" aria-busy={loading}>
        <div className="panel-title">
          <h2>Users</h2>
          <span className="count">{total}</span>
        </div>
        <form
          className="access-form"
          aria-label="User directory filters"
          onSubmit={(event) => event.preventDefault()}
        >
          <label>
            Search users
            <input
              type="search"
              value={filters.search}
              onChange={(event) => {
                setPage(1);
                setFilters({ ...filters, search: event.target.value });
              }}
            />
          </label>
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) => {
                setPage(1);
                setFilters({ ...filters, status: event.target.value });
              }}
            >
              <option value="">All statuses</option>
              <option value="INVITED">Invited</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>
          <label>
            Portal audience
            <select
              value={filters.audience}
              onChange={(event) => {
                setPage(1);
                setFilters({ ...filters, audience: event.target.value });
              }}
            >
              <option value="">All audiences</option>
              <option value="INTERNAL">Internal</option>
              <option value="VENDOR">Vendor</option>
              <option value="DRIVER">Driver</option>
              <option value="CLIENT">Client</option>
            </select>
          </label>
          <label>
            Role
            <select
              value={filters.roleId}
              onChange={(event) => {
                setPage(1);
                setFilters({ ...filters, roleId: event.target.value });
              }}
            >
              <option value="">All roles</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.sessionState === "ACTIVE"}
              onChange={(event) => {
                setPage(1);
                setFilters({
                  ...filters,
                  sessionState: event.target.checked ? "ACTIVE" : "",
                });
              }}
            />
            Active sessions only
          </label>
        </form>
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
                  {canAdminUsers && user.status !== "INVITED" && (
                    <button
                      type="button"
                      onClick={() =>
                        void userAction(
                          user,
                          user.status === "SUSPENDED"
                            ? "reactivate"
                            : "suspend",
                        )
                      }
                    >
                      {user.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
                    </button>
                  )}
                  {canResetSessions && (
                    <button
                      type="button"
                      onClick={() => void userAction(user, "sessions/reset")}
                    >
                      Reset sessions
                    </button>
                  )}
                  {canResetMfa && (
                    <button
                      type="button"
                      onClick={() => void userAction(user, "mfa/reset")}
                    >
                      Reset MFA
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="actions" aria-label="Directory pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            Previous page
          </button>
          <span>
            Page {page} of {Math.max(1, Math.ceil(total / 25))}
          </span>
          <button
            type="button"
            disabled={page * 25 >= total}
            onClick={() => setPage((value) => value + 1)}
          >
            Next page
          </button>
        </div>
      </section>
      {detail && (
        <section
          className="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-detail-title"
        >
          <div className="panel-title">
            <div>
              <h2 id="user-detail-title">User access details</h2>
              <h3>{detail.displayName}</h3>
              <p className="muted">
                Identity, account state, roles, scopes and sessions.
              </p>
            </div>
            <button
              type="button"
              onClick={closeUser}
              aria-label="Close user details"
            >
              Close
            </button>
          </div>
          <h3>Profile</h3>
          <dl className="details-grid">
            <div>
              <dt>Employee code</dt>
              <dd>{detail.employeeCode}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{words(detail.status)}</dd>
            </div>
            <div>
              <dt>Portal audience</dt>
              <dd>{words(detail.portalAudience)}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{detail.email || "Not provided"}</dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>{detail.mobile || "Not provided"}</dd>
            </div>
            <div>
              <dt>Access version</dt>
              <dd>{detail.authorizationVersion}</dd>
            </div>
          </dl>
          {canAdminUsers && dossier && (
            <details>
              <summary>Edit user profile</summary>
              <p className="muted">
                Contact changes apply to this tenant profile and future tenant
                invitations or notifications. They do not silently change a
                shared login identity used in another tenant.
              </p>
              <form
                className="access-form"
                onSubmit={(event) => void saveProfile(event)}
              >
                <label>
                  Display name
                  <input
                    required
                    minLength={2}
                    value={profile.displayName}
                    onChange={(event) =>
                      setProfile({
                        ...profile,
                        displayName: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Employee code
                  <input
                    required
                    value={profile.employeeCode}
                    onChange={(event) =>
                      setProfile({
                        ...profile,
                        employeeCode: event.target.value.toUpperCase(),
                      })
                    }
                  />
                </label>
                <label>
                  Tenant notification email (optional)
                  <input
                    type="email"
                    value={profile.email}
                    placeholder={dossier.profile.email ?? "Not provided"}
                    onChange={(event) =>
                      setProfile({ ...profile, email: event.target.value })
                    }
                  />
                </label>
                <label>
                  Tenant notification mobile in E.164 (optional)
                  <input
                    value={profile.mobile}
                    placeholder={dossier.profile.mobile ?? "+919876543210"}
                    onChange={(event) =>
                      setProfile({ ...profile, mobile: event.target.value })
                    }
                  />
                </label>
                <label>
                  Portal audience
                  <select
                    value={profile.portalAudience}
                    onChange={(event) =>
                      setProfile({
                        ...profile,
                        portalAudience: event.target.value,
                      })
                    }
                  >
                    <option value="INTERNAL">Internal</option>
                    <option value="VENDOR">Vendor</option>
                    <option value="DRIVER">Driver</option>
                    <option value="CLIENT">Client</option>
                  </select>
                </label>
                <label>
                  Reason
                  <input
                    required
                    minLength={10}
                    value={profile.reason}
                    onChange={(event) =>
                      setProfile({ ...profile, reason: event.target.value })
                    }
                  />
                </label>
                <FormSubmitResult error={error} success={success}>
                  <button className="primary">Save profile</button>
                </FormSubmitResult>
              </form>
            </details>
          )}

          {dossier && (
            <section aria-labelledby="security-account-panels">
              <h3 id="security-account-panels">Invitation, sessions and MFA</h3>
              <dl className="details-grid">
                <div>
                  <dt>Invitation destination</dt>
                  <dd>
                    {dossier.invitation?.destination ?? "No current invitation"}
                  </dd>
                </div>
                <div>
                  <dt>Invitation expires</dt>
                  <dd>
                    {dossier.invitation
                      ? new Date(dossier.invitation.expiresAt).toLocaleString()
                      : "Not applicable"}
                  </dd>
                </div>
                <div>
                  <dt>Delivery state</dt>
                  <dd>
                    {words(
                      dossier.invitation?.deliveryState ?? "Not applicable",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Active MFA factors</dt>
                  <dd>
                    {dossier.mfa.filter((factor) => !factor.disabledAt).length}
                  </dd>
                </div>
              </dl>
              <div
                className="table-region"
                tabIndex={0}
                aria-label="User sessions"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Expires</th>
                      <th>Assurance</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dossier.sessions.map((session) => (
                      <tr key={session.id}>
                        <td>{new Date(session.createdAt).toLocaleString()}</td>
                        <td>{new Date(session.expiresAt).toLocaleString()}</td>
                        <td>{words(session.assuranceLevel)}</td>
                        <td>
                          {session.revokedAt
                            ? `Revoked: ${words(session.revokedReason)}`
                            : "Active"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Profile and security history</h3>
              {dossier.history.length === 0 ? (
                <p className="empty">No recorded history.</p>
              ) : (
                <div
                  className="table-region"
                  tabIndex={0}
                  aria-label="Profile and security history"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Action</th>
                        <th>Reason</th>
                        <th>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dossier.history.map((item) => (
                        <tr key={`${item.correlationId}-${item.occurredAt}`}>
                          <td>{new Date(item.occurredAt).toLocaleString()}</td>
                          <td>{words(item.action)}</td>
                          <td>{item.reason ?? "—"}</td>
                          <td>{item.correlationId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <h3>Role and scope assignments</h3>
          {detail.assignments.length === 0 ? (
            <p className="empty">No active role assignments.</p>
          ) : (
            <div
              className="table-region"
              tabIndex={0}
              aria-label="Role and scope assignments"
            >
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Scope</th>
                    <th>Allowed actions</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.assignments.flatMap((assignment) =>
                    assignment.grants.map((grant) => (
                      <tr
                        key={`${assignment.assignmentId ?? assignment.roleId}-${grant.scopeNodeId}`}
                      >
                        <td>
                          {assignment.roleName ??
                            roles.find((role) => role.id === assignment.roleId)
                              ?.name ??
                            "Role"}
                        </td>
                        <td>
                          {scopes.find(
                            (scope) => scope.id === grant.scopeNodeId,
                          )?.path ?? "Assigned scope"}
                        </td>
                        <td>{grant.actions.map(words).join(", ")}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {canEditAccess && (
            <details>
              <summary>Edit role and scope assignments</summary>
              <p className="muted">
                Change the current assignments below, preview their effective
                permissions, then apply the reviewed configuration.
              </p>
              {detail.assignments.map((assignment, assignmentIndex) => (
                <fieldset
                  key={assignment.assignmentId ?? assignmentIndex}
                  className="access-form"
                >
                  <legend>Assignment {assignmentIndex + 1}</legend>
                  <label>
                    Role
                    <select
                      value={assignment.roleId}
                      onChange={(event) => {
                        const assignments = [...detail.assignments];
                        assignments[assignmentIndex] = {
                          ...assignment,
                          roleId: event.target.value,
                          roleName: roles.find(
                            (role) => role.id === event.target.value,
                          )?.name,
                        };
                        setDetail({ ...detail, assignments });
                        setPreview(null);
                      }}
                    >
                      {roles
                        .filter((role) => role.status === "ACTIVE")
                        .map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {assignment.grants.map((grant, grantIndex) => (
                    <div key={`${grant.scopeNodeId}-${grantIndex}`}>
                      <label>
                        Scope
                        <select
                          value={grant.scopeNodeId}
                          onChange={(event) => {
                            const assignments = [...detail.assignments];
                            const grants = [...assignment.grants];
                            grants[grantIndex] = {
                              ...grant,
                              scopeNodeId: event.target.value,
                            };
                            assignments[assignmentIndex] = {
                              ...assignment,
                              grants,
                            };
                            setDetail({ ...detail, assignments });
                            setPreview(null);
                          }}
                        >
                          {scopes.map((scope) => (
                            <option key={scope.id} value={scope.id}>
                              {scope.path}
                            </option>
                          ))}
                        </select>
                      </label>
                      <fieldset>
                        <legend>Allowed actions</legend>
                        {[
                          "READ",
                          "CREATE",
                          "UPDATE",
                          "APPROVE",
                          "EXPORT",
                          "ADMIN",
                        ].map((action) => (
                          <label className="check" key={action}>
                            <input
                              type="checkbox"
                              checked={grant.actions.includes(action)}
                              onChange={(event) => {
                                const assignments = [...detail.assignments];
                                const grants = [...assignment.grants];
                                grants[grantIndex] = {
                                  ...grant,
                                  actions: event.target.checked
                                    ? [...grant.actions, action]
                                    : grant.actions.filter(
                                        (item) => item !== action,
                                      ),
                                };
                                assignments[assignmentIndex] = {
                                  ...assignment,
                                  grants,
                                };
                                setDetail({ ...detail, assignments });
                                setPreview(null);
                              }}
                            />
                            {words(action)}
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  ))}
                </fieldset>
              ))}
              <label>
                Reason for access change
                <input
                  minLength={10}
                  value={accessReason}
                  onChange={(event) => setAccessReason(event.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  aria-label="Preview current access"
                  onClick={() => void previewCurrentAccess()}
                >
                  Preview effective access
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!preview || accessReason.trim().length < 10}
                  onClick={() => void applyCurrentAccess()}
                >
                  Apply reviewed access
                </button>
              </div>
            </details>
          )}
          {preview && (
            <>
              <h3 aria-label="Authorization preview">
                Effective access preview
              </h3>
              <p>
                {
                  preview.decisions.filter((decision) => decision.allowed)
                    .length
                }{" "}
                allowed decisions and{" "}
                {
                  preview.decisions.filter((decision) => !decision.allowed)
                    .length
                }{" "}
                denied decisions.
              </p>
              <div
                className="table-region"
                tabIndex={0}
                aria-label="Effective access preview"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Result</th>
                      <th>Role</th>
                      <th>Capability</th>
                      <th>Action</th>
                      <th>Scope</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.decisions.map((decision, index) => (
                      <tr
                        key={`${decision.capability}-${decision.scopeNodeId}-${index}`}
                      >
                        <td>{decision.allowed ? "Allowed" : "Denied"}</td>
                        <td>{decision.role ?? "—"}</td>
                        <td>{words(decision.capability)}</td>
                        <td>{words(decision.action)}</td>
                        <td>
                          {scopes.find(
                            (scope) => scope.id === decision.scopeNodeId,
                          )?.path ?? "Assigned scope"}
                        </td>
                        <td>{words(decision.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {canAdminUsers && detail.status === "INVITED" && (
            <section aria-labelledby="activation-heading">
              <h3 id="activation-heading">Pending activation</h3>
              <p className="muted">
                Generate a replacement link when delivery failed. Generating it
                invalidates every older link. The new bearer link is shown only
                now and cannot be retrieved later.
              </p>
              <label>
                Reason
                <input
                  minLength={10}
                  value={activationReason}
                  onChange={(event) => setActivationReason(event.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  disabled={
                    activationPending || activationReason.trim().length < 10
                  }
                  onClick={() => void invitationAction("resend")}
                >
                  Generate new activation link
                </button>
                <button
                  type="button"
                  disabled={
                    activationPending || activationReason.trim().length < 10
                  }
                  onClick={() => void invitationAction("revoke")}
                >
                  Revoke invitation
                </button>
              </div>
              {activationLink && (
                <div>
                  <label htmlFor="activation-link">New activation link</label>
                  <input
                    id="activation-link"
                    readOnly
                    value={activationLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    onClick={() => void copyActivationLink()}
                  >
                    Copy activation link
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActivationLink("");
                      setCopyStatus("Activation link cleared.");
                    }}
                  >
                    Done
                  </button>
                  <p role="status">{copyStatus}</p>
                </div>
              )}
            </section>
          )}
          {canAdminUsers && detail.status === "ACTIVE" && (
            <section aria-labelledby="password-recovery-heading">
              <h3 id="password-recovery-heading">Password recovery</h3>
              <p className="muted">
                Generate a one-time link when this active user cannot sign in.
                The link is shown only once, expires after one hour, and resets
                the shared login identity across its workspaces. Completing the
                reset signs that identity out of every active session. For
                identities active in more than one workspace, administrator link
                generation is blocked and the user must use self-service
                recovery from the sign-in page.
              </p>
              <label>
                Reason
                <input
                  minLength={10}
                  value={passwordResetReason}
                  onChange={(event) =>
                    setPasswordResetReason(event.target.value)
                  }
                />
              </label>
              <FormSubmitResult
                error={error}
                success={passwordResetStatus || success}
                busy={passwordResetPending}
              >
                <button
                  type="button"
                  disabled={
                    passwordResetPending ||
                    passwordResetReason.trim().length < 10
                  }
                  onClick={() => void issuePasswordReset()}
                >
                  {passwordResetPending
                    ? "Generating…"
                    : "Generate password reset link"}
                </button>
              </FormSubmitResult>
              {passwordResetLink && (
                <div>
                  <label htmlFor="password-reset-link">
                    One-time password reset link
                  </label>
                  <input
                    id="password-reset-link"
                    readOnly
                    value={passwordResetLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => void copyPasswordResetLink()}
                    >
                      Copy password reset link
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPasswordResetLink("");
                        setPasswordResetStatus("Password reset link cleared.");
                      }}
                    >
                      Done
                    </button>
                  </div>
                  <p role="status">{passwordResetStatus}</p>
                </div>
              )}
            </section>
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
  const [operationResult, setOperationResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const title = audience
    ? `${audience[0]!.toUpperCase()}${audience.slice(1)} portal`
    : "Permission tester";
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
        return;
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
      }
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
            {audience
              ? "Only server-authorized work items and masked fields are shown."
              : "For administrators and support: check whether your current signed-in access may read a synthetic authorization fixture. This makes no business transaction and does not create or change operational data."}
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
          <h2>How to use this diagnostic</h2>
          <ol>
            <li>Choose a fixture from the list below.</li>
            <li>
              Select <strong>Test read permission</strong>.
            </li>
            <li>Review the Allowed or Denied decision and safe reason.</li>
          </ol>
          <p>
            This tool tests the current signed-in administrator. To review
            another user, open that user in{" "}
            <a href="/app/access/users">Users</a> and use{" "}
            <strong>Preview effective access</strong>.
          </p>
        </section>
      )}
      {operationResult && (
        <section className="panel" role="status">
          <h2>Permission decision</h2>
          <dl className="details-grid">
            <div>
              <dt>Result</dt>
              <dd>{operationResult.allowed ? "Allowed" : "Denied"}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{words(operationResult.reason)}</dd>
            </div>
            {operationResult.matchedRoleName ? (
              <div>
                <dt>Matched role</dt>
                <dd>{String(operationResult.matchedRoleName)}</dd>
              </div>
            ) : null}
            {operationResult.matchedScopeName ? (
              <div>
                <dt>Matched scope</dt>
                <dd>{String(operationResult.matchedScopeName)}</dd>
              </div>
            ) : null}
          </dl>
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
                <dl>
                  <div>
                    <dt>Type</dt>
                    <dd>{words(item.resourceType)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{words(item.status)}</dd>
                  </div>
                  {item.note ? (
                    <div>
                      <dt>Note</dt>
                      <dd>{String(item.note)}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void operation(item, "preview")}
                  >
                    Test read permission
                  </button>
                  {audience && (
                    <button
                      type="button"
                      onClick={() => void operation(item, "update")}
                    >
                      Complete
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
    [search, setSearch] = useState(""),
    [items, setItems] = useState<Array<Record<string, unknown>>>([]),
    [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null);
  async function exportReport() {
    try {
      const result = await api<{ filename: string; csv: string }>(
        `/tenant/access/reports/${type}/export?search=${encodeURIComponent(search)}`,
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
        `/tenant/access/reports/${type}?search=${encodeURIComponent(search)}`,
        { signal: c.signal },
      ),
      api<{ items: Array<Record<string, unknown>> }>(
        `/tenant/access/alerts?search=${encodeURIComponent(search)}`,
        { signal: c.signal },
      ),
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
  }, [type, search]);
  const reportColumns: Record<string, Array<[string, string]>> = {
    users: [
      ["displayName", "User"],
      ["employeeCode", "Employee code"],
      ["status", "Status"],
      ["portalAudience", "Portal"],
      ["roles", "Roles"],
      ["activeSessions", "Sessions"],
    ],
    roles: [
      ["name", "Role"],
      ["users", "Users"],
      ["grants", "Active grants"],
    ],
    sessions: [
      ["displayName", "User"],
      ["count", "Active sessions"],
      ["lastSeenAt", "Last seen"],
    ],
    "audit-log": [
      ["occurredAt", "When"],
      ["actor", "Actor"],
      ["action", "Action"],
      ["targetType", "Record type"],
      ["reason", "Reason"],
      ["correlationId", "Reference"],
    ],
    "permission-changes": [
      ["occurredAt", "When"],
      ["actor", "Actor"],
      ["action", "Permission change"],
      ["targetType", "Record type"],
      ["reason", "Reason"],
      ["correlationId", "Reference"],
    ],
    "security-events": [
      ["occurredAt", "When"],
      ["actor", "Actor"],
      ["eventType", "Security event"],
      ["outcome", "Outcome"],
      ["safeTargetHash", "Safe target reference"],
      ["correlationId", "Reference"],
    ],
    "failed-logins": [
      ["bucket", "Time window"],
      ["eventType", "Event"],
      ["count", "Attempts"],
    ],
    dormant: [
      ["displayName", "User"],
      ["lastActivityAt", "Last activity"],
      ["neverLoggedIn", "Never logged in"],
    ],
    "privileged-actions": [
      ["occurredAt", "When"],
      ["actor", "Actor"],
      ["action", "Action"],
      ["targetType", "Record type"],
      ["reason", "Reason"],
      ["correlationId", "Reference"],
    ],
  };
  const columns = reportColumns[type] ?? reportColumns.users!;
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Access</p>
          <h1>Activity &amp; audit</h1>
          <h2 className="sr-only">Reports and alerts</h2>
          <p className="muted">
            Search user-access reports, immutable audit evidence, authentication
            and authorization events, and actionable security alerts.
          </p>
        </div>
      </div>
      <section className="panel">
        <label>
          Evidence view
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="users">Users</option>
            <option value="roles">Role assignments</option>
            <option value="sessions">Active sessions</option>
            <option value="audit-log">Audit log</option>
            <option value="permission-changes">Permission changes</option>
            <option value="security-events">
              Authentication &amp; authorization events
            </option>
            <option value="failed-logins">Failed logins</option>
            <option value="dormant">Dormant users</option>
            <option value="privileged-actions">Privileged actions</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Actor, action, user, target or reference"
          />
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
        ) : items.length === 0 ? (
          <p className="empty">No matching evidence.</p>
        ) : (
          <div
            className="table-region"
            tabIndex={0}
            aria-label={`${words(type)} results`}
          >
            <table>
              <thead>
                <tr>
                  {columns.map(([key, label]) => (
                    <th key={key} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={String(item.id ?? index)}>
                    {columns.map(([key]) => (
                      <td key={key}>{displayValue(item[key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Security alerts</h2>
        <p className="muted">
          Actionable conditions are separate from the immutable audit log.
          Acknowledging or resolving an alert creates audit evidence.
        </p>
        {alerts.length ? (
          alerts.map((alert, index) => (
            <article className="access-card" key={String(alert.id ?? index)}>
              <div>
                <h3>{words(alert.type)}</h3>
                <p>
                  {words(alert.severity)} severity · {words(alert.state)}
                </p>
              </div>
              <dl>
                <div>
                  <dt>Affected user</dt>
                  <dd>{String(alert.actor ?? "System")}</dd>
                </div>
                <div>
                  <dt>Occurrences</dt>
                  <dd>{String(alert.occurrenceCount ?? 0)}</dd>
                </div>
                <div>
                  <dt>First seen</dt>
                  <dd>{displayValue(alert.firstSeenAt)}</dd>
                </div>
                <div>
                  <dt>Last seen</dt>
                  <dd>{displayValue(alert.lastSeenAt)}</dd>
                </div>
                {alert.resolutionReason ? (
                  <div>
                    <dt>Resolution</dt>
                    <dd>{String(alert.resolutionReason)}</dd>
                  </div>
                ) : null}
              </dl>
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
                  <p className="field-help">
                    Create a password you will remember. It is not sent or
                    shared by the platform and will be required after logout.
                  </p>
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
