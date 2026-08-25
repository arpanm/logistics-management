"use client";
import { FormEvent, use, useEffect, useState } from "react";
import { Shell } from "../../../../components/shell";
import { api, ApiError } from "../../../../components/api";
type Detail = {
  tenant: {
    id: string;
    name: string;
    code: string;
    status: string;
    version: number;
    legal_name: string;
    timezone: string;
    locale: string;
    currency: string;
    setup_complete: number;
    setup_total: number;
  };
  invitations: Array<{
    id: string;
    email: string;
    expiresAt: string;
    deliveryState: string;
    acceptedAt: string | null;
    revokedAt: string | null;
    version: number;
  }>;
};
export default function TenantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [activationUrl, setActivationUrl] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  function load() {
    api<Detail>(`/platform/tenants/${id}`)
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(load, [id]);
  async function reissueInvitation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const invitation = data?.invitations[0];
    if (!invitation) return;
    setInviteBusy(true);
    setError("");
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    try {
      const result = await api<{
        activationUrl: string | null;
        invitation: Detail["invitations"][number];
      }>(`/platform/tenants/${id}/owner-invitation/reissue`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: invitation.version,
          reason: form.get("reason"),
        }),
      });
      setActivationUrl(result.activationUrl ?? "");
      formElement.reset();
      load();
    } catch (error) {
      setError((error as ApiError).message);
    } finally {
      setInviteBusy(false);
    }
  }
  async function lifecycle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    const f = new FormData(e.currentTarget),
      action = data.tenant.status === "ACTIVE" ? "deactivate" : "reactivate";
    try {
      await api(`/platform/tenants/${id}/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedVersion: data.tenant.version,
          reason: f.get("reason"),
          confirmationCode: f.get("confirmationCode") || undefined,
        }),
      });
      load();
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
      {!data ? (
        <p role="status">Loading tenant details…</p>
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
              <h2>Configuration</h2>
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
                  <dt>Setup progress</dt>
                  <dd>
                    {data.tenant.setup_complete}/{data.tenant.setup_total}
                  </dd>
                </div>
              </dl>
            </section>
            <section className="panel">
              <h2>Owner invitation</h2>
              {data.invitations.map((i) => (
                <dl className="facts" key={i.id}>
                  <div>
                    <dt>Email</dt>
                    <dd>{i.email}</dd>
                  </div>
                  <div>
                    <dt>Delivery</dt>
                    <dd>{i.acceptedAt ? "ACCEPTED" : i.deliveryState}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(i.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
              ))}
              {activationUrl && (
                <div className="success" role="status">
                  <strong>Replacement activation link created.</strong>
                  <p>
                    This bearer link is shown once. Copy it and send it to the
                    named owner through a trusted channel.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard.writeText(activationUrl)
                      }
                    >
                      Copy activation link
                    </button>
                    <a
                      className="button"
                      href={activationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open activation link
                    </a>
                  </div>
                </div>
              )}
              {!data.invitations[0]?.acceptedAt && (
                <form onSubmit={reissueInvitation}>
                  <p className="muted">
                    Email delivery is unavailable until a provider is
                    configured. Generate a replacement link if the original link
                    was missed; the previous link becomes invalid.
                  </p>
                  <label>
                    Reason for replacement link
                    <input
                      name="reason"
                      required
                      minLength={10}
                      maxLength={500}
                      placeholder="Owner did not receive the original invitation"
                    />
                  </label>
                  <button className="primary" disabled={inviteBusy}>
                    {inviteBusy
                      ? "Generating securely…"
                      : "Generate replacement activation link"}
                  </button>
                </form>
              )}
            </section>
          </div>
          <section className="panel">
            <h2>User administration</h2>
            {data.invitations[0]?.acceptedAt ? (
              <p>
                The Tenant Owner can sign in and manage employees, vendors,
                drivers, clients, roles, scopes, invitation resend, suspension,
                and session resets from <code>/app/access/users</code>.
              </p>
            ) : (
              <p>
                Activate the first Tenant Owner before adding tenant users. This
                preserves tenant isolation and prevents the Platform Admin from
                impersonating a tenant administrator.
              </p>
            )}
          </section>
          <section className="panel danger-zone">
            <h2>
              {data.tenant.status === "ACTIVE" ? "Deactivate" : "Reactivate"}{" "}
              tenant
            </h2>
            <p>
              Data and memberships are retained. Existing tenant sessions are
              revoked when deactivated.
            </p>
            <form onSubmit={lifecycle}>
              {data.tenant.status === "ACTIVE" && (
                <label>
                  Type {data.tenant.code} to confirm
                  <input
                    name="confirmationCode"
                    required
                    pattern={data.tenant.code.replaceAll("-", "\\-")}
                    autoComplete="off"
                  />
                </label>
              )}
              <label>
                Reason
                <input name="reason" required minLength={10} maxLength={500} />
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
