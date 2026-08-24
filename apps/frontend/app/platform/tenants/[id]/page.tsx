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
  function load() {
    api<Detail>(`/platform/tenants/${id}`)
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(load, [id]);
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
            </section>
          </div>
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
