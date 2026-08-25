"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, ApiError } from "../../../components/api";
type Tenant = {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
  active_user_count: number;
  setup_complete: number;
  setup_total: number;
  invitationState: string;
};
type PostalLocality = {
  id: string;
  country: string;
  postalCode: string;
  locality: string;
  district: string;
  city: string;
  region: string;
};
const defaults = {
  timezone: "Asia/Kolkata",
  locale: "en-IN",
  currency: "INR",
  country: "IN",
  primary: "#16324F",
  accent: "#D97706",
};
export default function Tenants() {
  const [data, setData] = useState<{
    items: Tenant[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [listError, setListError] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [postalCode, setPostalCode] = useState("");
  const [postalItems, setPostalItems] = useState<PostalLocality[]>([]);
  const [postalLocalityId, setPostalLocalityId] = useState("");
  const [postalBusy, setPostalBusy] = useState(false);
  const [postalError, setPostalError] = useState("");
  const [postalLookupNonce, setPostalLookupNonce] = useState(0);
  const [success, setSuccess] = useState<{ id: string; url?: string } | null>(
    null,
  );
  const summary = useRef<HTMLDivElement>(null);
  function load(nextSearch = search, nextStatus = status, nextPage = page) {
    setListError("");
    const params = new URLSearchParams({
      search: nextSearch,
      status: nextStatus,
      page: String(nextPage),
    });
    api<{ items: Tenant[]; total: number; page: number; pageSize: number }>(
      `/platform/tenants?${params}`,
    )
      .then(setData)
      .catch((value: ApiError) => setListError(value.message));
  }
  useEffect(() => {
    load("", "", 1);
  }, []);
  useEffect(() => {
    if (error) summary.current?.focus();
  }, [error]);
  useEffect(() => {
    setPostalItems([]);
    setPostalLocalityId("");
    setPostalError("");
    if (!/^[1-9][0-9]{5}$/.test(postalCode)) return;
    const controller = new AbortController();
    setPostalBusy(true);
    api<{ items: PostalLocality[] }>(
      `/reference/postal-localities?country=IN&postalCode=${encodeURIComponent(postalCode)}`,
      { signal: controller.signal },
    )
      .then(({ items }) => {
        setPostalItems(items);
        if (items.length === 1) setPostalLocalityId(items[0]!.id);
      })
      .catch((value: ApiError | DOMException | TypeError) => {
        if (value instanceof DOMException && value.name === "AbortError")
          return;
        setPostalError(
          "code" in value
            ? value.message
            : "Could not reach the postal directory. Check your connection and retry.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPostalBusy(false);
      });
    return () => controller.abort();
  }, [postalCode, postalLookupNonce]);
  const selectedPostal = postalItems.find(
    (item) => item.id === postalLocalityId,
  );
  const fieldId = (path: string) => path.replaceAll(".", "-");
  const clearField = (path: string) => {
    if (!error?.fields?.[path]) return;
    const fields = { ...error.fields };
    delete fields[path];
    setError(Object.keys(fields).length ? { ...error, fields } : null);
  };
  const fieldProps = (path: string) => {
    const invalid = Boolean(error?.fields?.[path]);
    return {
      id: fieldId(path),
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? `${fieldId(path)}-error` : undefined,
      onInput: () => clearField(path),
    };
  };
  const FieldError = ({ path }: { path: string }) => {
    const messages = error?.fields?.[path];
    return messages ? (
      <span className="field-error" id={`${fieldId(path)}-error`}>
        {messages.join(", ")}
      </span>
    ) : null;
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const body = {
      name: f.get("name"),
      code: f.get("code"),
      legalName: f.get("legalName"),
      taxIdentifier: f.get("taxIdentifier"),
      address: {
        line1: f.get("line1"),
        line2: f.get("line2"),
        postalCode: f.get("postalCode"),
        postalLocalityId: f.get("postalLocalityId"),
        country: f.get("country"),
      },
      timezone: f.get("timezone"),
      locale: f.get("locale"),
      currency: f.get("currency"),
      fiscalYearStart: {
        month: Number(f.get("fiscalMonth")),
        day: Number(f.get("fiscalDay")),
      },
      legalEntity: {
        name: f.get("entityName"),
        code: f.get("entityCode"),
        taxIdentifier: f.get("entityTax") || undefined,
      },
      support: {
        name: f.get("supportName"),
        email: f.get("supportEmail"),
        mobile: f.get("supportMobile") || undefined,
      },
      owner: { name: f.get("ownerName"), email: f.get("ownerEmail") },
      branding: {
        shortName: f.get("shortName"),
        primaryColor: f.get("primaryColor"),
        accentColor: f.get("accentColor"),
      },
      active: f.get("active") === "on",
    };
    try {
      const result = await api<{
        tenant: { id: string };
        invitationUrl?: string;
      }>("/platform/tenants", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setSuccess({ id: result.tenant.id, url: result.invitationUrl });
      setShow(false);
      load();
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.code === "POSTAL_REFERENCE_CHANGED") {
        setPostalItems([]);
        setPostalLocalityId("");
        setPostalError(
          "Postal reference data changed. Recheck the locality before submitting again.",
        );
        setPostalLookupNonce((value) => value + 1);
      }
      setError(apiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell area="platform">
      <div className="heading">
        <div>
          <p className="eyebrow">Platform administration</p>
          <h1>Tenants</h1>
          <p className="muted">
            Provision and govern isolated company workspaces.
          </p>
        </div>
        <button className="primary" onClick={() => setShow((v) => !v)}>
          {show ? "Cancel" : "Create tenant"}
        </button>
      </div>
      {success && (
        <div className="success" role="status">
          <strong>Tenant provisioned.</strong>{" "}
          <Link href={`/platform/tenants/${success.id}`}>Open details</Link>
          {success.url && (
            <>
              {" "}
              ·{" "}
              <button
                className="link-button"
                onClick={() => void navigator.clipboard.writeText(success.url!)}
              >
                Copy invitation link
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div ref={summary} tabIndex={-1} className="error" role="alert">
          <strong>{error.message}</strong>
          {error.correlationId && (
            <small> Reference {error.correlationId}</small>
          )}
          {error.fields && (
            <ul>
              {Object.entries(error.fields).map(([k, v]) => (
                <li key={k}>
                  <a href={`#${fieldId(k)}`}>
                    {k}: {v.join(", ")}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {show && (
        <section className="panel">
          <h2>New tenant</h2>
          <form className="tenant-form" onSubmit={submit}>
            <fieldset>
              <legend>Company</legend>
              <label>
                Tenant name
                <input
                  {...fieldProps("name")}
                  name="name"
                  required
                  minLength={2}
                />
                <FieldError path="name" />
              </label>
              <label>
                Tenant code
                <input
                  {...fieldProps("code")}
                  name="code"
                  required
                  pattern="[A-Za-z0-9-]{2,30}"
                />
                <FieldError path="code" />
              </label>
              <label>
                Legal name
                <input {...fieldProps("legalName")} name="legalName" required />
                <FieldError path="legalName" />
              </label>
              <label>
                GSTIN / tax identifier
                <input
                  {...fieldProps("taxIdentifier")}
                  name="taxIdentifier"
                  required
                />
                <FieldError path="taxIdentifier" />
              </label>
              <label>
                Short name
                <input
                  {...fieldProps("branding.shortName")}
                  name="shortName"
                  required
                />
                <FieldError path="branding.shortName" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Registered address</legend>
              <label>
                PIN code
                <input
                  {...fieldProps("address.postalCode")}
                  name="postalCode"
                  required
                  value={postalCode}
                  onChange={(event) => {
                    clearField("address.postalCode");
                    setPostalCode(event.currentTarget.value);
                    setPostalError("");
                  }}
                  onBlur={() => {
                    if (postalCode && !/^[1-9][0-9]{5}$/.test(postalCode))
                      setPostalError(
                        "Enter exactly six digits; the first digit cannot be zero.",
                      );
                  }}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  pattern="[1-9][0-9]{5}"
                  maxLength={6}
                  aria-describedby={`postal-help postal-status${
                    error?.fields?.["address.postalCode"]
                      ? ` ${fieldId("address.postalCode")}-error`
                      : ""
                  }`}
                />
                <small id="postal-help">
                  Enter the six-digit Indian PIN. City and state are filled from
                  the postal directory.
                </small>
                <FieldError path="address.postalCode" />
              </label>
              <input type="hidden" name="country" value="IN" />
              <label>
                Country
                <input value="India (IN)" readOnly aria-readonly="true" />
              </label>
              <div id="postal-status" role="status" aria-live="polite">
                {postalBusy
                  ? "Looking up PIN code…"
                  : postalError ||
                    (selectedPostal
                      ? `Derived ${selectedPostal.city}, ${selectedPostal.region} from ${selectedPostal.locality}, ${selectedPostal.district} district.`
                      : "")}
              </div>
              {postalError && /^[1-9][0-9]{5}$/.test(postalCode) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setPostalLookupNonce((value) => value + 1)}
                  disabled={postalBusy}
                >
                  Retry PIN lookup
                </button>
              )}
              {postalItems.length > 1 && (
                <label>
                  Locality
                  <select
                    {...fieldProps("address.postalLocalityId")}
                    name="postalLocalityId"
                    required
                    value={postalLocalityId}
                    onChange={(event) => {
                      clearField("address.postalLocalityId");
                      setPostalLocalityId(event.currentTarget.value);
                    }}
                  >
                    <option value="">Select locality</option>
                    {postalItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.locality} — {item.district} district
                      </option>
                    ))}
                  </select>
                  <FieldError path="address.postalLocalityId" />
                </label>
              )}
              {postalItems.length === 1 && (
                <input
                  type="hidden"
                  name="postalLocalityId"
                  value={postalLocalityId}
                />
              )}
              <label>
                City
                <input
                  value={selectedPostal?.city ?? ""}
                  readOnly
                  aria-readonly="true"
                  placeholder="Derived from PIN code"
                />
              </label>
              <label>
                State
                <input
                  value={selectedPostal?.region ?? ""}
                  readOnly
                  aria-readonly="true"
                  placeholder="Derived from PIN code"
                />
              </label>
              <label>
                Address line 1
                <input {...fieldProps("address.line1")} name="line1" required />
                <FieldError path="address.line1" />
              </label>
              <label>
                Address line 2
                <input {...fieldProps("address.line2")} name="line2" />
                <FieldError path="address.line2" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Business settings</legend>
              <label>
                Timezone
                <select
                  {...fieldProps("timezone")}
                  name="timezone"
                  required
                  defaultValue={defaults.timezone}
                >
                  <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                  <option value="Asia/Dhaka">Asia/Dhaka</option>
                  <option value="Asia/Dubai">Asia/Dubai</option>
                  <option value="Asia/Singapore">Asia/Singapore</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="UTC">UTC</option>
                </select>
                <FieldError path="timezone" />
              </label>
              <label>
                Locale
                <input
                  {...fieldProps("locale")}
                  name="locale"
                  required
                  defaultValue={defaults.locale}
                />
                <FieldError path="locale" />
              </label>
              <label>
                Currency
                <select
                  {...fieldProps("currency")}
                  name="currency"
                  required
                  defaultValue={defaults.currency}
                >
                  {["INR", "USD", "EUR", "GBP", "AED", "SGD", "BDT"].map(
                    (currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ),
                  )}
                </select>
                <FieldError path="currency" />
              </label>
              <label>
                Fiscal month
                <input
                  {...fieldProps("fiscalYearStart.month")}
                  name="fiscalMonth"
                  type="number"
                  min="1"
                  max="12"
                  required
                  defaultValue="4"
                />
                <FieldError path="fiscalYearStart.month" />
              </label>
              <label>
                Fiscal day
                <input
                  {...fieldProps("fiscalYearStart.day")}
                  name="fiscalDay"
                  type="number"
                  min="1"
                  max="28"
                  required
                  defaultValue="1"
                />
                <FieldError path="fiscalYearStart.day" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Default legal entity</legend>
              <label>
                Entity name
                <input
                  {...fieldProps("legalEntity.name")}
                  name="entityName"
                  required
                />
                <FieldError path="legalEntity.name" />
              </label>
              <label>
                Entity code
                <input
                  {...fieldProps("legalEntity.code")}
                  name="entityCode"
                  required
                />
                <FieldError path="legalEntity.code" />
              </label>
              <label>
                Tax identifier override
                <input
                  {...fieldProps("legalEntity.taxIdentifier")}
                  name="entityTax"
                />
                <FieldError path="legalEntity.taxIdentifier" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Support contact</legend>
              <label>
                Name
                <input
                  {...fieldProps("support.name")}
                  name="supportName"
                  required
                />
                <FieldError path="support.name" />
              </label>
              <label>
                Email
                <input
                  {...fieldProps("support.email")}
                  name="supportEmail"
                  type="email"
                  required
                />
                <FieldError path="support.email" />
              </label>
              <label>
                Mobile (E.164)
                <input
                  {...fieldProps("support.mobile")}
                  name="supportMobile"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+919999999999"
                />
                <FieldError path="support.mobile" />
              </label>
            </fieldset>
            <fieldset>
              <legend>First tenant owner</legend>
              <label>
                Name
                <input
                  {...fieldProps("owner.name")}
                  name="ownerName"
                  required
                />
                <FieldError path="owner.name" />
              </label>
              <label>
                Email
                <input
                  {...fieldProps("owner.email")}
                  name="ownerEmail"
                  type="email"
                  required
                />
                <FieldError path="owner.email" />
              </label>
            </fieldset>
            <fieldset>
              <legend>Branding</legend>
              <label>
                Primary colour
                <input
                  {...fieldProps("branding.primaryColor")}
                  name="primaryColor"
                  type="color"
                  defaultValue={defaults.primary}
                />
                <FieldError path="branding.primaryColor" />
              </label>
              <label>
                Accent colour
                <input
                  {...fieldProps("branding.accentColor")}
                  name="accentColor"
                  type="color"
                  defaultValue={defaults.accent}
                />
                <FieldError path="branding.accentColor" />
              </label>
              <label className="checkbox">
                <input name="active" type="checkbox" defaultChecked /> Active
                immediately
              </label>
            </fieldset>
            <button
              className="primary span"
              type="submit"
              disabled={busy || !selectedPostal}
            >
              {busy ? "Provisioning safely…" : "Provision tenant"}
            </button>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-title">
          <h2>Tenant registry</h2>
          <span className="count">{data?.total ?? "—"} total</span>
        </div>
        <form
          className="registry-filters"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            load(search, status, 1);
          }}
        >
          <label>
            Search tenants
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              name="tenantSearch"
            />
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              name="tenantStatus"
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </label>
          <button>Apply filters</button>
        </form>
        {listError && (
          <div className="error" role="alert">
            {listError} <button onClick={() => load()}>Retry</button>
          </div>
        )}
        {!data ? (
          <p role="status">Loading tenants…</p>
        ) : data.items.length === 0 ? (
          <div className="empty">
            <h3>No matching tenants</h3>
            <p>Change the filters or create an isolated workspace.</p>
          </div>
        ) : (
          <div className="cards">
            {data.items.map((t) => (
              <article className="tenant-card" key={t.id}>
                <div>
                  <span className={`status ${t.status.toLowerCase()}`}>
                    {t.status}
                  </span>
                  <h3>
                    <Link href={`/platform/tenants/${t.id}`}>{t.name}</Link>
                  </h3>
                  <code>{t.code}</code>
                </div>
                <dl>
                  <div>
                    <dt>Active users</dt>
                    <dd>{t.active_user_count}</dd>
                  </div>
                  <div>
                    <dt>Setup</dt>
                    <dd>
                      {t.setup_complete}/{t.setup_total}
                    </dd>
                  </div>
                  <div>
                    <dt>Invitation</dt>
                    <dd>{t.invitationState ?? "—"}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
        {data && data.total > data.pageSize && (
          <nav className="pagination" aria-label="Tenant registry pages">
            <button
              disabled={page <= 1}
              onClick={() => {
                const next = page - 1;
                setPage(next);
                load(search, status, next);
              }}
            >
              Previous
            </button>
            <span>
              Page {page} of {Math.ceil(data.total / data.pageSize)}
            </span>
            <button
              disabled={page >= Math.ceil(data.total / data.pageSize)}
              onClick={() => {
                const next = page + 1;
                setPage(next);
                load(search, status, next);
              }}
            >
              Next
            </button>
          </nav>
        )}
      </section>
    </Shell>
  );
}
