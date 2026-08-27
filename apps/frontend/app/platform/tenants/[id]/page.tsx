"use client";
import { FormEvent, use, useEffect, useState } from "react";
import { Shell } from "../../../../components/shell";
import { api, ApiError } from "../../../../components/api";
import { FormSubmitResult } from "../../../../components/forms/form-submit-result";

type Role = { code: string; name: string };
type User = {
  id: string;
  displayName: string;
  employeeCode: string;
  portalAudience: string;
  membershipStatus: string;
  activationStatus: string;
  destination: string;
  roles: Role[];
  onboarding: {
    percent: number;
    status: string;
    checks: Record<string, boolean | null>;
    explanations: Record<string, string>;
  };
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  activeSessions: number;
  version: number;
  invitationEditable: boolean;
  sharedIdentity: boolean;
  permittedActions: string[];
  activity?: Array<{ eventType: string; outcome: string; occurredAt: string }>;
};
type Detail = {
  tenant: {
    name: string;
    code: string;
    status: string;
    version: number;
    legal_name: string;
    timezone: string;
    locale: string;
    currency: string;
    short_name: string;
    primary_color: string;
    accent_color: string;
    setup_complete: number;
    setup_total: number;
  };
  invitations: Array<{
    id: string;
    email: string;
    expiresAt: string;
    deliveryState: string;
    acceptedAt: string | null;
    version: number;
  }>;
  checklist: Array<{
    key: string;
    label: string;
    state: string;
    version: number;
  }>;
  availableRoles: Array<{
    id: string;
    code: string;
    name: string;
    portalAudiences: string[];
    privilegeLevel: string;
  }>;
  setupEvidence: Array<{
    key: string;
    label: string;
    count: number;
    records: Array<{
      id: string;
      code: string;
      name: string;
      state: string;
      type?: string;
      version: number;
    }>;
  }>;
};

export default function TenantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Detail | null>(null),
    [users, setUsers] = useState<User[]>([]),
    [selected, setSelected] = useState<User | null>(null);
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [activationUrl, setActivationUrl] = useState(""),
    [userActivationUrl, setUserActivationUrl] = useState(""),
    [resetUrl, setResetUrl] = useState(""),
    [revealed, setRevealed] = useState<{
      membershipId: string;
      type: "EMAIL" | "MOBILE";
      destination: string;
      revealedUntil: string;
    } | null>(null),
    [inviteOpen, setInviteOpen] = useState(false),
    [inviteAudience, setInviteAudience] = useState("INTERNAL"),
    [editing, setEditing] = useState(false),
    [editingTenant, setEditingTenant] = useState(false),
    [editingRecord, setEditingRecord] = useState(""),
    [sensitiveFeedback, setSensitiveFeedback] = useState<{
      action: "reveal" | "reset";
      error: string;
    } | null>(null),
    [inviteFeedback, setInviteFeedback] = useState<{
      error?: string;
      success?: string;
    } | null>(null),
    [busy, setBusy] = useState(false);
  async function selectUser(memberId: string) {
    try {
      setRevealed(null);
      setResetUrl("");
      setEditing(false);
      setSelected(await api<User>(`/platform/tenants/${id}/users/${memberId}`));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  async function load() {
    setError("");
    try {
      const [detail, directory] = await Promise.all([
        api<Detail>(`/platform/tenants/${id}`),
        api<{ items: User[] }>(
          `/platform/tenants/${id}/users?search=${encodeURIComponent(search)}${status ? `&membershipStatus=${status}` : ""}`,
        ),
      ]);
      setData(detail);
      setUsers(directory.items);
      if (selected) await selectUser(selected.id);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  useEffect(() => {
    if (!revealed) return;
    const timeout = window.setTimeout(
      () => setRevealed(null),
      Math.max(0, new Date(revealed.revealedUntil).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [revealed]);
  useEffect(() => {
    if (!resetUrl) return;
    const timeout = window.setTimeout(() => setResetUrl(""), 300_000);
    return () => window.clearTimeout(timeout);
  }, [resetUrl]);
  useEffect(() => {
    const clearSensitive = () => {
      if (document.visibilityState === "hidden") {
        setRevealed(null);
        setResetUrl("");
      }
    };
    const pageHide = () => {
      setRevealed(null);
      setResetUrl("");
    };
    document.addEventListener("visibilitychange", clearSensitive);
    window.addEventListener("pagehide", pageHide);
    return () => {
      document.removeEventListener("visibilitychange", clearSensitive);
      window.removeEventListener("pagehide", pageHide);
    };
  }, []);
  async function updateProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/platform/tenants/${id}/users/${selected.id}/profile`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: selected.version,
          displayName: form.get("displayName"),
          employeeCode: form.get("employeeCode"),
          portalAudience: form.get("portalAudience"),
          reason: form.get("reason"),
        }),
      });
      setNotice("Tenant-specific user profile updated.");
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function updateTenantConfiguration(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/platform/tenants/${id}/configuration`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: data.tenant.version,
          legalName: form.get("legalName"),
          timezone: form.get("timezone"),
          locale: form.get("locale"),
          currency: form.get("currency"),
          shortName: form.get("shortName"),
          primaryColor: form.get("primaryColor"),
          accentColor: form.get("accentColor"),
          reason: form.get("reason"),
        }),
      });
      setEditingTenant(false);
      setNotice("Tenant configuration updated.");
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function updateMasterRecord(
    e: FormEvent<HTMLFormElement>,
    resourceType: "organization" | "client" | "vendor",
    record: { id: string; version: number },
  ) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        `/platform/tenants/${id}/master-data/${resourceType}/${record.id}`,
        {
          method: "PATCH",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedVersion: record.version,
            name: form.get("name"),
            reason: form.get("reason"),
          }),
        },
      );
      setEditingRecord("");
      setNotice("Master-data name updated.");
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget),
      action =
        selected.membershipStatus === "SUSPENDED" ? "reactivate" : "suspend";
    setBusy(true);
    setError("");
    try {
      await api(`/platform/tenants/${id}/users/${selected.id}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: selected.version,
          reason: form.get("reason"),
        }),
      });
      setNotice(
        action === "suspend"
          ? "User disabled; active tenant sessions revoked."
          : "User enabled; a new sign-in is required.",
      );
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function revealDestination(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setSensitiveFeedback(null);
    try {
      setRevealed(
        await api<{
          membershipId: string;
          type: "EMAIL" | "MOBILE";
          destination: string;
          revealedUntil: string;
        }>(`/platform/tenants/${id}/users/${selected.id}/reveal-destination`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: selected.version,
            reason: form.get("reason"),
            currentPassword: form.get("currentPassword"),
          }),
        }),
      );
    } catch (e) {
      const message = (e as ApiError).message;
      setRevealed(null);
      setError(message);
      setSensitiveFeedback({ action: "reveal", error: message });
    } finally {
      setBusy(false);
    }
  }
  async function issuePasswordReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setResetUrl("");
    setSensitiveFeedback(null);
    try {
      const result = await api<{ resetUrl: string | null }>(
        `/platform/tenants/${id}/users/${selected.id}/password-reset`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedVersion: selected.version,
            reason: form.get("reason"),
            currentPassword: form.get("currentPassword"),
            expiresInHours: Number(form.get("expiresInHours")),
          }),
        },
      );
      setResetUrl(result.resetUrl ?? "");
    } catch (e) {
      const message = (e as ApiError).message;
      setResetUrl("");
      setError(message);
      setSensitiveFeedback({ action: "reset", error: message });
    } finally {
      setBusy(false);
    }
  }
  async function inviteUser(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formElement = e.currentTarget,
      form = new FormData(formElement);
    setBusy(true);
    setError("");
    setUserActivationUrl("");
    setInviteFeedback(null);
    try {
      const result = await api<{ invitationUrl: string | null }>(
        `/platform/tenants/${id}/users`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            displayName: form.get("displayName"),
            employeeCode: form.get("employeeCode"),
            email: String(form.get("email") || "") || undefined,
            mobile: String(form.get("mobile") || "") || undefined,
            portalAudience: form.get("portalAudience"),
            roleIds: [form.get("roleId")],
            expiresInHours: Number(form.get("expiresInHours")),
            reason: form.get("reason"),
            tenantWideAccessConfirmed:
              form.get("tenantWideAccessConfirmed") === "on",
          }),
        },
      );
      setUserActivationUrl(result.invitationUrl ?? "");
      formElement.reset();
      setInviteAudience("INTERNAL");
      setNotice("Tenant user invitation created.");
      setInviteFeedback({ success: "Tenant user invitation created." });
      await load();
    } catch (e) {
      const message = (e as ApiError).message;
      setError(message);
      setInviteFeedback({ error: message });
    } finally {
      setBusy(false);
    }
  }
  async function reissue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const invite = data?.invitations[0];
    if (!invite) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const result = await api<{ activationUrl: string | null }>(
        `/platform/tenants/${id}/owner-invitation/reissue`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            expectedVersion: invite.version,
            reason: form.get("reason"),
          }),
        },
      );
      setActivationUrl(result.activationUrl ?? "");
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function tenantLifecycle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    const form = new FormData(e.currentTarget),
      action = data.tenant.status === "ACTIVE" ? "deactivate" : "reactivate";
    try {
      await api(`/platform/tenants/${id}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: data.tenant.version,
          reason: form.get("reason"),
          confirmationCode: form.get("confirmationCode") || undefined,
        }),
      });
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  return (
    <Shell area="platform">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {!data ? (
        <p role="status">Loading tenant administration…</p>
      ) : (
        <>
          <div className="heading">
            <div>
              <p className="eyebrow">{data.tenant.code}</p>
              <h1>{data.tenant.name}</h1>
              <span className={`status ${data.tenant.status.toLowerCase()}`}>
                {data.tenant.status}
              </span>
            </div>
          </div>
          <div className="grid-2">
            <section className="panel">
              <div className="heading">
                <h2>Configuration</h2>
                {!editingTenant && (
                  <button type="button" onClick={() => setEditingTenant(true)}>
                    Edit
                  </button>
                )}
              </div>
              {editingTenant ? (
                <form onSubmit={updateTenantConfiguration}>
                  <label>
                    Legal name
                    <input
                      name="legalName"
                      defaultValue={data.tenant.legal_name}
                      required
                    />
                  </label>
                  <label>
                    Timezone
                    <input
                      name="timezone"
                      defaultValue={data.tenant.timezone}
                      required
                    />
                  </label>
                  <label>
                    Locale
                    <input
                      name="locale"
                      defaultValue={data.tenant.locale}
                      required
                    />
                  </label>
                  <label>
                    Currency
                    <input
                      name="currency"
                      defaultValue={data.tenant.currency}
                      pattern="[A-Z]{3}"
                      required
                    />
                  </label>
                  <label>
                    Short name
                    <input
                      name="shortName"
                      defaultValue={data.tenant.short_name}
                      required
                    />
                  </label>
                  <label>
                    Primary colour
                    <input
                      name="primaryColor"
                      type="color"
                      defaultValue={data.tenant.primary_color}
                      required
                    />
                  </label>
                  <label>
                    Accent colour
                    <input
                      name="accentColor"
                      type="color"
                      defaultValue={data.tenant.accent_color}
                      required
                    />
                  </label>
                  <label>
                    Reason
                    <input name="reason" required minLength={10} />
                  </label>
                  <div className="actions">
                    <button disabled={busy}>Save</button>
                    <button
                      type="button"
                      onClick={() => setEditingTenant(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <dl className="facts">
                  <div>
                    <dt>Legal name</dt>
                    <dd>{data.tenant.legal_name}</dd>
                  </div>
                  <div>
                    <dt>Timezone</dt>
                    <dd>{data.tenant.timezone}</dd>
                  </div>
                  <div>
                    <dt>Locale / currency</dt>
                    <dd>
                      {data.tenant.locale} · {data.tenant.currency}
                    </dd>
                  </div>
                  <div>
                    <dt>Setup</dt>
                    <dd>
                      {data.tenant.setup_complete}/{data.tenant.setup_total}
                    </dd>
                  </div>
                  <div>
                    <dt>Branding</dt>
                    <dd>
                      {data.tenant.short_name} · {data.tenant.primary_color} ·{" "}
                      {data.tenant.accent_color}
                    </dd>
                  </div>
                </dl>
              )}
            </section>
            <section className="panel">
              <h2>Owner activation</h2>
              {data.invitations.map((i) => (
                <dl className="facts" key={i.id}>
                  <div>
                    <dt>Email</dt>
                    <dd>{i.email}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{i.acceptedAt ? "ACCEPTED" : i.deliveryState}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(i.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
              ))}
              {activationUrl && (
                <div className="success">
                  <p>Bearer link shown once.</p>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(activationUrl)
                    }
                  >
                    Copy activation link
                  </button>
                </div>
              )}
              {!data.invitations[0]?.acceptedAt && (
                <form onSubmit={reissue}>
                  <label>
                    Replacement reason
                    <input name="reason" required minLength={10} />
                  </label>
                  <button disabled={busy}>Generate replacement link</button>
                </form>
              )}
            </section>
          </div>
          <section className="panel" id="tenant-users">
            <h2>Tenant users</h2>
            <p className="muted">
              Manage tenant membership only. Accepted login identifiers and
              passwords cannot be edited here.
            </p>
            <form
              className="actions"
              onSubmit={(e) => {
                e.preventDefault();
                void load();
              }}
            >
              <label>
                Search
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name or employee code"
                />
              </label>
              <label>
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All</option>
                  <option>INVITED</option>
                  <option>ACTIVE</option>
                  <option>SUSPENDED</option>
                </select>
              </label>
              <button>Apply filters</button>
            </form>
            {!users.length ? (
              <p>No tenant users match these filters.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Audience / roles</th>
                      <th>Activation</th>
                      <th>Onboarding</th>
                      <th>Security</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <strong>{user.displayName}</strong>
                          <br />
                          <span className="muted">
                            {user.employeeCode} · {user.destination}
                          </span>
                        </td>
                        <td>
                          {user.portalAudience}
                          <br />
                          {user.roles.map((r) => r.name).join(", ") ||
                            "No effective role"}
                        </td>
                        <td>
                          {user.membershipStatus}
                          <br />
                          {user.activationStatus}
                        </td>
                        <td>
                          {user.onboarding.percent}% · {user.onboarding.status}
                        </td>
                        <td>
                          {user.mfaEnabled ? "MFA enabled" : "No MFA"}
                          <br />
                          {user.activeSessions} sessions
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => void selectUser(user.id)}
                          >
                            View / manage
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel">
            <div className="heading">
              <div>
                <h2>Tenant user invitation</h2>
                <p className="muted">
                  Creates a tenant-scoped membership and tenant-wide root scope
                  grant for the selected role.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInviteOpen((open) => !open)}
              >
                {inviteOpen ? "Cancel" : "Add user"}
              </button>
            </div>
            {userActivationUrl && (
              <div className="success">
                <strong>Activation link created</strong>
                <p>Copy it now and send it through a trusted channel.</p>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(userActivationUrl)
                  }
                >
                  Copy user activation link
                </button>
              </div>
            )}
            {inviteOpen && (
              <form onSubmit={inviteUser} className="grid-2">
                <label>
                  Display name
                  <input name="displayName" required minLength={2} />
                </label>
                <label>
                  Employee code
                  <input name="employeeCode" required minLength={2} />
                </label>
                <label>
                  Email (optional)
                  <input name="email" type="email" />
                </label>
                <label>
                  Mobile (optional, E.164)
                  <input name="mobile" type="tel" placeholder="+919876543210" />
                </label>
                <label>
                  Portal audience
                  <select
                    name="portalAudience"
                    value={inviteAudience}
                    onChange={(event) => setInviteAudience(event.target.value)}
                  >
                    <option>INTERNAL</option>
                    <option>VENDOR</option>
                    <option>DRIVER</option>
                    <option>CLIENT</option>
                  </select>
                </label>
                <label>
                  Compatible role
                  <select
                    key={inviteAudience}
                    name="roleId"
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Select an active compatible role
                    </option>
                    {data.availableRoles
                      .filter((role) =>
                        role.portalAudiences.includes(inviteAudience),
                      )
                      .map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name} · {role.privilegeLevel}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Link expiry (hours)
                  <input
                    name="expiresInHours"
                    type="number"
                    min={1}
                    max={720}
                    defaultValue={72}
                    required
                  />
                </label>
                <label>
                  Reason
                  <input
                    name="reason"
                    required
                    minLength={10}
                    maxLength={500}
                  />
                </label>
                <label>
                  <input
                    name="tenantWideAccessConfirmed"
                    type="checkbox"
                    required
                  />{" "}
                  I confirm this role will receive tenant-wide/root scope
                  access.
                </label>
                <FormSubmitResult
                  error={inviteFeedback?.error}
                  success={inviteFeedback?.success}
                  busy={busy}
                >
                  <button disabled={busy}>Create invitation</button>
                </FormSubmitResult>
              </form>
            )}
          </section>
          {selected && (
            <section className="panel">
              <div className="heading">
                <div>
                  <h2>{selected.displayName}</h2>
                  <p>
                    {selected.membershipStatus} · {selected.activationStatus}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setRevealed(null);
                    setResetUrl("");
                    setEditing(false);
                  }}
                >
                  Close
                </button>
              </div>
              <div className="grid-2">
                {editing ? (
                  <form
                    key={`${selected.id}:${selected.version}`}
                    onSubmit={updateProfile}
                  >
                    <h3>Tenant profile</h3>
                    <label>
                      Display name
                      <input
                        name="displayName"
                        defaultValue={selected.displayName}
                        required
                      />
                    </label>
                    <label>
                      Employee code
                      <input
                        name="employeeCode"
                        defaultValue={selected.employeeCode}
                        required
                      />
                    </label>
                    <label>
                      Portal audience
                      <select
                        name="portalAudience"
                        defaultValue={selected.portalAudience}
                      >
                        <option>INTERNAL</option>
                        <option>VENDOR</option>
                        <option>DRIVER</option>
                        <option>CLIENT</option>
                      </select>
                    </label>
                    <p className="muted">
                      Invitation destination is read-only because changing it
                      requires token rotation. Use the owner replacement
                      activation flow when applicable.
                    </p>
                    <label>
                      Reason
                      <input name="reason" required minLength={10} />
                    </label>
                    <div className="actions">
                      <button disabled={busy}>Save tenant profile</button>
                      <button type="button" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <h3>Tenant profile</h3>
                    <dl className="facts">
                      <div>
                        <dt>Display name</dt>
                        <dd>{selected.displayName}</dd>
                      </div>
                      <div>
                        <dt>Employee code</dt>
                        <dd>{selected.employeeCode}</dd>
                      </div>
                      <div>
                        <dt>Portal audience</dt>
                        <dd>{selected.portalAudience}</dd>
                      </div>
                      <div>
                        <dt>Destination</dt>
                        <dd>{selected.destination}</dd>
                      </div>
                    </dl>
                    <button type="button" onClick={() => setEditing(true)}>
                      Edit user details
                    </button>
                  </div>
                )}
                <div>
                  <h3>Access, onboarding and security</h3>
                  <dl className="facts">
                    <div>
                      <dt>Roles</dt>
                      <dd>
                        {selected.roles.map((r) => r.name).join(", ") ||
                          "No effective role"}
                      </dd>
                    </div>
                    <div>
                      <dt>Onboarding</dt>
                      <dd>
                        {selected.onboarding.percent}% ·{" "}
                        {selected.onboarding.status}
                      </dd>
                    </div>
                    <div>
                      <dt>Last login</dt>
                      <dd>
                        {selected.lastLoginAt
                          ? new Date(selected.lastLoginAt).toLocaleString()
                          : "Never"}
                      </dd>
                    </div>
                    <div>
                      <dt>MFA / sessions</dt>
                      <dd>
                        {selected.mfaEnabled ? "Enabled" : "Not enabled"} ·{" "}
                        {selected.activeSessions} active
                      </dd>
                    </div>
                  </dl>
                  <ul>
                    {Object.entries(selected.onboarding.checks).map(
                      ([check, complete]) => (
                        <li key={check}>
                          <strong>{check.replaceAll("_", " ")}: </strong>
                          {complete === null
                            ? "Not applicable"
                            : complete
                              ? "Complete"
                              : "Incomplete"}{" "}
                          — {selected.onboarding.explanations[check]}
                        </li>
                      ),
                    )}
                  </ul>
                  {selected.permittedActions.includes("REVEAL_DESTINATION") && (
                    <>
                      <h3>Login destination</h3>
                      <p className="muted">
                        The tenant membership destination is masked by default.
                        Reveal requires your current Platform Admin password and
                        is audited.
                      </p>
                      {revealed && (
                        <div className="success">
                          <p>
                            <strong>
                              {revealed.type === "EMAIL"
                                ? "Email"
                                : "Destination"}
                              :
                            </strong>{" "}
                            {revealed.destination}
                          </p>
                          <p>
                            Visible until{" "}
                            {new Date(
                              revealed.revealedUntil,
                            ).toLocaleTimeString()}{" "}
                            unless hidden sooner.
                          </p>
                          <div className="actions">
                            <button
                              type="button"
                              onClick={() =>
                                void navigator.clipboard.writeText(
                                  revealed.destination,
                                )
                              }
                            >
                              {revealed.type === "EMAIL"
                                ? "Copy email"
                                : "Copy destination"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setRevealed(null)}
                            >
                              Hide
                            </button>
                          </div>
                        </div>
                      )}
                      {!revealed && (
                        <form onSubmit={revealDestination}>
                          <label>
                            Current Platform Admin password
                            <input
                              name="currentPassword"
                              type="password"
                              required
                              autoComplete="current-password"
                            />
                          </label>
                          <label>
                            Reason for reveal
                            <input name="reason" required minLength={10} />
                          </label>
                          <FormSubmitResult
                            error={
                              sensitiveFeedback?.action === "reveal"
                                ? sensitiveFeedback.error
                                : ""
                            }
                            busy={busy}
                          >
                            <button disabled={busy}>Reveal email</button>
                          </FormSubmitResult>
                        </form>
                      )}
                    </>
                  )}
                  {selected.permittedActions.includes(
                    "GENERATE_PASSWORD_RESET",
                  ) ? (
                    <>
                      <h3>Password recovery</h3>
                      <p className="muted">
                        Available only when this active identity belongs to one
                        active workspace. The link hides automatically after
                        five minutes.
                      </p>
                      {resetUrl && (
                        <div className="success">
                          <div className="actions">
                            <button
                              type="button"
                              onClick={() =>
                                void navigator.clipboard.writeText(resetUrl)
                              }
                            >
                              Copy reset link
                            </button>
                            <button
                              type="button"
                              onClick={() => setResetUrl("")}
                            >
                              Hide
                            </button>
                          </div>
                        </div>
                      )}
                      {!resetUrl && (
                        <form onSubmit={issuePasswordReset}>
                          <label>
                            Current Platform Admin password
                            <input
                              name="currentPassword"
                              type="password"
                              required
                              autoComplete="current-password"
                            />
                          </label>
                          <label>
                            Expiry (hours)
                            <input
                              name="expiresInHours"
                              type="number"
                              min={1}
                              max={24}
                              defaultValue={1}
                              required
                            />
                          </label>
                          <label>
                            Reason
                            <input name="reason" required minLength={10} />
                          </label>
                          <FormSubmitResult
                            error={
                              sensitiveFeedback?.action === "reset"
                                ? sensitiveFeedback.error
                                : ""
                            }
                            busy={busy}
                          >
                            <button disabled={busy}>
                              Generate password reset link
                            </button>
                          </FormSubmitResult>
                        </form>
                      )}
                    </>
                  ) : (
                    selected.sharedIdentity && (
                      <p className="muted">
                        Password reset link is unavailable here because this
                        identity belongs to multiple active workspaces; use
                        self-service recovery.
                      </p>
                    )
                  )}
                  {selected.membershipStatus !== "INVITED" && (
                    <form onSubmit={changeStatus}>
                      <label>
                        Reason for{" "}
                        {selected.membershipStatus === "SUSPENDED"
                          ? "enabling"
                          : "disabling"}
                        <input name="reason" required minLength={10} />
                      </label>
                      <button
                        disabled={busy}
                        className={
                          selected.membershipStatus === "SUSPENDED"
                            ? "primary"
                            : "danger"
                        }
                      >
                        {selected.membershipStatus === "SUSPENDED"
                          ? "Enable user"
                          : "Disable user and revoke sessions"}
                      </button>
                    </form>
                  )}
                </div>
              </div>
              <h3>Recent security activity</h3>
              {selected.activity?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.activity.map((event, index) => (
                        <tr key={`${event.occurredAt}-${index}`}>
                          <td>{new Date(event.occurredAt).toLocaleString()}</td>
                          <td>{event.eventType}</td>
                          <td>{event.outcome}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No recorded security activity.</p>
              )}
            </section>
          )}
          <section className="panel">
            <h2>Onboarding and master data</h2>
            <p className="muted">
              Safe representative records from this tenant are shown directly in
              Platform context. Organization, branch, client and vendor names
              can be edited here; governed records remain read-only with their
              owning workflow explained.
            </p>
            {data.setupEvidence.map((evidence) => {
              const item = data.checklist.find(
                (entry) => entry.key === evidence.key,
              );
              const resourceType =
                evidence.key === "organization" || evidence.key === "branches"
                  ? "organization"
                  : evidence.key === "clients"
                    ? "client"
                    : evidence.key === "vendors"
                      ? "vendor"
                      : null;
              return (
                <section key={evidence.key}>
                  <h3>
                    {evidence.label} · {evidence.count}
                  </h3>
                  <p>{item?.state ?? "DERIVED"}</p>
                  {!resourceType && (
                    <p className="muted">
                      Read-only here:{" "}
                      {evidence.key === "users"
                        ? "use the Tenant users section above"
                        : evidence.key === "commercial"
                          ? "contract lifecycle changes require the commercial workflow"
                          : evidence.key === "imports"
                            ? "import history is append-only"
                            : "role access changes require the governed access workflow"}
                      .
                    </p>
                  )}
                  {evidence.records.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Code</th>
                            <th>Name</th>
                            <th>Type / state</th>
                            <th>Version</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.records.map((record) => {
                            const editKey = `${evidence.key}:${record.id}`;
                            return (
                              <tr key={record.id}>
                                <td>{record.code}</td>
                                <td>
                                  {editingRecord === editKey && resourceType ? (
                                    <form
                                      onSubmit={(event) =>
                                        void updateMasterRecord(
                                          event,
                                          resourceType,
                                          record,
                                        )
                                      }
                                    >
                                      <label>
                                        Name
                                        <input
                                          name="name"
                                          defaultValue={record.name}
                                          required
                                        />
                                      </label>
                                      <label>
                                        Reason
                                        <input
                                          name="reason"
                                          required
                                          minLength={10}
                                        />
                                      </label>
                                      <div className="actions">
                                        <button disabled={busy}>Save</button>
                                        <button
                                          type="button"
                                          onClick={() => setEditingRecord("")}
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </form>
                                  ) : (
                                    record.name
                                  )}
                                </td>
                                <td>
                                  {record.type ? `${record.type} · ` : ""}
                                  {record.state}
                                </td>
                                <td>{record.version}</td>
                                <td>
                                  {resourceType && editingRecord !== editKey ? (
                                    <button
                                      type="button"
                                      onClick={() => setEditingRecord(editKey)}
                                    >
                                      Edit
                                    </button>
                                  ) : !resourceType ? (
                                    "Read-only"
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      No records yet. Creation is not supported from Platform
                      context.
                    </p>
                  )}
                </section>
              );
            })}
          </section>
          <section className="panel danger-zone">
            <h2>
              {data.tenant.status === "ACTIVE" ? "Deactivate" : "Reactivate"}{" "}
              tenant
            </h2>
            <form onSubmit={tenantLifecycle}>
              {data.tenant.status === "ACTIVE" && (
                <label>
                  Type {data.tenant.code} to confirm
                  <input name="confirmationCode" required />
                </label>
              )}
              <label>
                Reason
                <input name="reason" required minLength={10} />
              </label>
              <button
                className={
                  data.tenant.status === "ACTIVE" ? "danger" : "primary"
                }
              >
                {data.tenant.status === "ACTIVE"
                  ? "Deactivate tenant"
                  : "Reactivate tenant"}
              </button>
            </form>
          </section>
        </>
      )}
    </Shell>
  );
}
