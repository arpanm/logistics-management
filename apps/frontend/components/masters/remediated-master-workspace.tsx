"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, type ApiError } from "../api";
import { FormSubmitResult } from "../forms/form-submit-result";
import { SmartField } from "../forms/smart-field";
import { Shell } from "../shell";
import { MastersNav } from "./masters-nav";
import styles from "./remediated-master-workspace.module.css";

type Mode =
  | "client-locations"
  | "vendors"
  | "vehicles"
  | "drivers"
  | "catalogs";
type Row = Record<string, unknown> & { id: string };
type Postal = {
  id: string;
  locality: string;
  district: string;
  city: string;
  region: string;
  directoryVersion: string;
};
type CatalogKind = "TRUCK_TYPE" | "BODY_TYPE" | "CARGO_TYPE";
const title = (row: Row) =>
  String(
    row.name ??
      row.legal_name ??
      row.display_name ??
      row.registration_number ??
      row.code ??
      row.id,
  );

function SearchSelect({
  label,
  resource,
  value,
  onChange,
  required = true,
}: {
  label: string;
  resource: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [items, setItems] = useState<Row[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const path = resource.startsWith("catalog:")
        ? `/domain/master-admin/catalogs/${resource.slice(8)}?search=${encodeURIComponent(search)}`
        : resource === "access-users"
          ? `/tenant/access/users?search=${encodeURIComponent(search)}`
          : `/domain/${resource}?search=${encodeURIComponent(search)}`;
      void api<{ items: Row[] }>(path, { signal: controller.signal })
        .then((result) => setItems(result.items))
        .catch(() => setItems([]));
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [resource, search]);
  return (
    <label>
      {label}
      {required ? "" : " (Optional)"}
      <input
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Search ${label.toLowerCase()}`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <select
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {title(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

function AddressFields({
  form,
  setForm,
}: {
  form: Record<string, string>;
  setForm: (next: Record<string, string>) => void;
}) {
  const [items, setItems] = useState<Postal[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    setItems([]);
    setError("");
    if (!/^[1-9][0-9]{5}$/.test(form.postalCode ?? "")) return;
    const controller = new AbortController();
    void api<{ items: Postal[] }>(
      `/domain/masters/postal-localities?postalCode=${form.postalCode}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setItems(result.items);
        if (!result.items.length)
          setError(
            "Unknown PIN. Creation remains blocked until the directory contains it.",
          );
        else if (result.items.length === 1)
          setForm({ ...form, postalLocalityId: result.items[0]!.id });
      })
      .catch(() =>
        setError(
          "PIN lookup is unavailable. Retry before creating the record.",
        ),
      );
    return () => controller.abort();
  }, [form.postalCode]);
  const selected = items.find((item) => item.id === form.postalLocalityId);
  return (
    <>
      <label>
        Address line 1
        <input
          required
          value={form.line1 ?? ""}
          onChange={(event) => setForm({ ...form, line1: event.target.value })}
        />
      </label>
      <label>
        Address line 2 (Optional)
        <input
          value={form.line2 ?? ""}
          onChange={(event) => setForm({ ...form, line2: event.target.value })}
        />
      </label>
      <label>
        PIN code
        <input
          required
          inputMode="numeric"
          pattern="[1-9][0-9]{5}"
          maxLength={6}
          value={form.postalCode ?? ""}
          onChange={(event) =>
            setForm({
              ...form,
              postalCode: event.target.value.replace(/\D/g, "").slice(0, 6),
              postalLocalityId: "",
            })
          }
        />
      </label>
      {items.length > 1 && (
        <label>
          Locality
          <select
            required
            value={form.postalLocalityId ?? ""}
            onChange={(event) =>
              setForm({ ...form, postalLocalityId: event.target.value })
            }
          >
            <option value="">Select locality…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.locality} · {item.district}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selected && (
        <div className={`${styles.derived} ${styles.wide}`}>
          <strong>Directory-derived address</strong>
          <p className={styles.summary}>
            {selected.locality}, {selected.city}, {selected.district},{" "}
            {selected.region} · directory {selected.directoryVersion}
          </p>
          <small>
            City and state are immutable snapshots; they are not manually
            entered.
          </small>
        </div>
      )}
    </>
  );
}

export function RemediatedMasterWorkspace({ mode }: { mode: Mode }) {
  const [items, setItems] = useState<Row[]>([]),
    [form, setForm] = useState<Record<string, string>>({}),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [catalogKind, setCatalogKind] = useState<CatalogKind>("TRUCK_TYPE");
  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      const path =
        mode === "catalogs"
          ? `/domain/master-admin/catalogs/${catalogKind}`
          : `/domain/${mode}`;
      const result = await api<{ items: Row[] }>(path, { signal });
      setItems(result.items);
      setError(null);
    } catch (value) {
      if ((value as Error).name !== "AbortError") setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [mode, catalogKind]);
  const set = (key: string, value: string) =>
    setForm({ ...form, [key]: value });
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice("");
    const address = ["client-locations", "vendors", "drivers"].includes(mode)
      ? {
          line1: form.line1,
          line2: form.line2 || undefined,
          postalCode: form.postalCode,
          postalLocalityId: form.postalLocalityId,
        }
      : undefined;
    let body: Record<string, unknown>;
    if (mode === "catalogs")
      body = {
        kind: catalogKind,
        code: form.code,
        name: form.name,
        description: form.description || undefined,
        capacityMilli: form.capacityMilli || undefined,
      };
    else if (mode === "client-locations")
      body = {
        clientId: form.clientId,
        code: form.code,
        name: form.name,
        locationType: form.locationType,
        organizationNodeId: form.organizationNodeId,
        managerEmployeeId: form.managerEmployeeId || undefined,
        mobile: form.mobile || undefined,
        address,
        geofence: form.geofence ? JSON.parse(form.geofence) : {},
      };
    else if (mode === "vendors")
      body = {
        code: form.code,
        legalName: form.legalName,
        pan: form.pan || undefined,
        gstin: form.gstin || undefined,
        paymentTermsDays: Number(form.paymentTermsDays || 0),
        onboardingEmployeeId: form.onboardingEmployeeId || undefined,
        address,
      };
    else if (mode === "drivers")
      body = {
        vendorId: form.vendorId,
        code: form.code,
        displayName: form.displayName,
        mobile: form.mobile,
        licenceNumber: form.licenceNumber,
        licenceClass: form.licenceClass,
        licenceValidTo: form.licenceValidTo,
        emergencyContact: form.emergencyContact || undefined,
        portalMembershipId: form.portalMembershipId || undefined,
        address,
      };
    else
      body = {
        vendorId: form.vendorId,
        registrationNumber: form.registrationNumber,
        truckTypeId: form.truckTypeId,
        bodyTypeId: form.bodyTypeId,
        make: form.make || undefined,
        model: form.model || undefined,
        modelYear: form.modelYear ? Number(form.modelYear) : undefined,
        capacityMilli: form.capacityMilli,
      };
    try {
      await api(
        mode === "catalogs"
          ? "/domain/master-admin/catalogs"
          : `/domain/master-admin/${mode}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(body),
        },
      );
      setForm({});
      setNotice("Master record created.");
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  const heading =
    mode === "catalogs"
      ? "Truck, body and cargo catalogs"
      : mode === "vehicles"
        ? "Fleet"
        : mode
            .replaceAll("-", " ")
            .replace(/^./, (letter) => letter.toUpperCase());
  return (
    <Shell>
      <MastersNav />
      <div className="heading">
        <div>
          <p className="eyebrow">MST-02 · MST-03 · CFG-01</p>
          <h1>{heading}</h1>
          <p className="muted">
            Structured, searchable master data with audited tenant-safe
            creation.
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          <strong>{error.message}</strong>
          {error.fields &&
            Object.entries(error.fields).map(([field, messages]) => (
              <small key={field}>
                {field}: {messages.join(", ")}
              </small>
            ))}
        </div>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      <section className="panel">
        <h2>
          Create {mode === "catalogs" ? "reference" : heading.toLowerCase()}
        </h2>
        <form className={styles.grid} onSubmit={(event) => void submit(event)}>
          {mode === "catalogs" && (
            <>
              <label>
                Reference kind
                <select
                  value={catalogKind}
                  onChange={(event) =>
                    setCatalogKind(event.target.value as CatalogKind)
                  }
                >
                  <option value="TRUCK_TYPE">Truck type</option>
                  <option value="BODY_TYPE">Body type</option>
                  <option value="CARGO_TYPE">Cargo type</option>
                </select>
              </label>
              <label>
                Code
                <input
                  required
                  value={form.code ?? ""}
                  onChange={(event) =>
                    set("code", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                Name
                <input
                  required
                  value={form.name ?? ""}
                  onChange={(event) => set("name", event.target.value)}
                />
              </label>
              <label>
                Capacity milli-units (Optional)
                <input
                  type="number"
                  min="1"
                  value={form.capacityMilli ?? ""}
                  onChange={(event) => set("capacityMilli", event.target.value)}
                />
              </label>
              <label className={styles.wide}>
                Description (Optional)
                <textarea
                  value={form.description ?? ""}
                  onChange={(event) => set("description", event.target.value)}
                />
              </label>
            </>
          )}
          {mode === "client-locations" && (
            <>
              <SearchSelect
                label="Client"
                resource="clients"
                value={form.clientId ?? ""}
                onChange={(value) => set("clientId", value)}
              />
              <label>
                Location code
                <input
                  required
                  value={form.code ?? ""}
                  onChange={(event) =>
                    set("code", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                Name
                <input
                  required
                  value={form.name ?? ""}
                  onChange={(event) => set("name", event.target.value)}
                />
              </label>
              <label>
                Location type
                <input
                  required
                  value={form.locationType ?? ""}
                  onChange={(event) => set("locationType", event.target.value)}
                />
              </label>
              <SearchSelect
                label="Organization node"
                resource="organization-nodes"
                value={form.organizationNodeId ?? ""}
                onChange={(value) => set("organizationNodeId", value)}
              />
              <SearchSelect
                label="Manager"
                resource="employees"
                required={false}
                value={form.managerEmployeeId ?? ""}
                onChange={(value) => set("managerEmployeeId", value)}
              />
              <label>
                Mobile (Optional)
                <input
                  placeholder="+919876543210"
                  value={form.mobile ?? ""}
                  onChange={(event) => set("mobile", event.target.value)}
                />
              </label>
              <div className={styles.wide}>
                <SmartField
                  field={{
                    key: "geofence",
                    label: "Geofence",
                    kind: "geofence",
                    required: false,
                    help: "Draw a polygon, select a fixed point and radius, or use a dynamic radius around the pickup/drop location.",
                  }}
                  value={form.geofence ?? ""}
                  onChange={(value) => set("geofence", value)}
                />
              </div>
              <AddressFields form={form} setForm={setForm} />
            </>
          )}
          {mode === "vendors" && (
            <>
              <label>
                Vendor code
                <input
                  required
                  value={form.code ?? ""}
                  onChange={(event) =>
                    set("code", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                Legal name
                <input
                  required
                  value={form.legalName ?? ""}
                  onChange={(event) => set("legalName", event.target.value)}
                />
              </label>
              <label>
                PAN (Optional)
                <input
                  value={form.pan ?? ""}
                  onChange={(event) =>
                    set("pan", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                GSTIN (Optional)
                <input
                  value={form.gstin ?? ""}
                  onChange={(event) =>
                    set("gstin", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                Payment terms days
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={form.paymentTermsDays ?? "0"}
                  onChange={(event) =>
                    set("paymentTermsDays", event.target.value)
                  }
                />
              </label>
              <SearchSelect
                label="Onboarding employee"
                resource="employees"
                required={false}
                value={form.onboardingEmployeeId ?? ""}
                onChange={(value) => set("onboardingEmployeeId", value)}
              />
              <AddressFields form={form} setForm={setForm} />
            </>
          )}
          {mode === "drivers" && (
            <>
              <SearchSelect
                label="Vendor"
                resource="vendors"
                value={form.vendorId ?? ""}
                onChange={(value) => set("vendorId", value)}
              />
              <label>
                Driver code
                <input
                  required
                  value={form.code ?? ""}
                  onChange={(event) =>
                    set("code", event.target.value.toUpperCase())
                  }
                />
              </label>
              <label>
                Display name
                <input
                  required
                  value={form.displayName ?? ""}
                  onChange={(event) => set("displayName", event.target.value)}
                />
              </label>
              <label>
                Mobile
                <input
                  required
                  placeholder="+919876543210"
                  value={form.mobile ?? ""}
                  onChange={(event) => set("mobile", event.target.value)}
                />
              </label>
              <label>
                Licence number
                <input
                  required
                  value={form.licenceNumber ?? ""}
                  onChange={(event) => set("licenceNumber", event.target.value)}
                />
              </label>
              <label>
                Licence class
                <input
                  required
                  value={form.licenceClass ?? ""}
                  onChange={(event) => set("licenceClass", event.target.value)}
                />
              </label>
              <label>
                Licence valid to
                <input
                  required
                  type="date"
                  value={form.licenceValidTo ?? ""}
                  onChange={(event) =>
                    set("licenceValidTo", event.target.value)
                  }
                />
              </label>
              <label>
                Emergency contact (Optional)
                <input
                  value={form.emergencyContact ?? ""}
                  onChange={(event) =>
                    set("emergencyContact", event.target.value)
                  }
                />
              </label>
              <SearchSelect
                label="Portal user membership"
                resource="access-users"
                required={false}
                value={form.portalMembershipId ?? ""}
                onChange={(value) => set("portalMembershipId", value)}
              />
              <AddressFields form={form} setForm={setForm} />
            </>
          )}
          {mode === "vehicles" && (
            <>
              <SearchSelect
                label="Vendor"
                resource="vendors"
                value={form.vendorId ?? ""}
                onChange={(value) => set("vendorId", value)}
              />
              <label>
                Registration number
                <input
                  required
                  value={form.registrationNumber ?? ""}
                  onChange={(event) =>
                    set("registrationNumber", event.target.value.toUpperCase())
                  }
                />
              </label>
              <SearchSelect
                label="Truck type"
                resource="catalog:TRUCK_TYPE"
                value={form.truckTypeId ?? ""}
                onChange={(value) => set("truckTypeId", value)}
              />
              <SearchSelect
                label="Body type"
                resource="catalog:BODY_TYPE"
                value={form.bodyTypeId ?? ""}
                onChange={(value) => set("bodyTypeId", value)}
              />
              <label>
                Capacity milli-units
                <input
                  required
                  type="number"
                  min="1"
                  value={form.capacityMilli ?? ""}
                  onChange={(event) => set("capacityMilli", event.target.value)}
                />
              </label>
              <label>
                Make (Optional)
                <input
                  value={form.make ?? ""}
                  onChange={(event) => set("make", event.target.value)}
                />
              </label>
              <label>
                Model (Optional)
                <input
                  value={form.model ?? ""}
                  onChange={(event) => set("model", event.target.value)}
                />
              </label>
              <label>
                Model year (Optional)
                <input
                  type="number"
                  min="1900"
                  max="2200"
                  value={form.modelYear ?? ""}
                  onChange={(event) => set("modelYear", event.target.value)}
                />
              </label>
            </>
          )}
          <FormSubmitResult error={error} success={notice}>
            <button className="primary">Create</button>
          </FormSubmitResult>
        </form>
      </section>
      {mode === "vehicles" && (
        <section className="panel">
          <h2>Configured transport references</h2>
          <p>
            Truck, body and cargo types are tenant reference masters, not
            free-text inputs.
          </p>
          <a href="/app/masters/catalogs">Open reference catalogs</a>
        </section>
      )}
      <section className="panel" aria-busy={loading}>
        <h2>Current records</h2>
        {loading ? (
          <p role="status">Loading…</p>
        ) : !items.length ? (
          <p className="empty">No records yet.</p>
        ) : (
          <div className={styles.list}>
            {items.map((item) => (
              <article className={styles.card} key={item.id}>
                <h3>{title(item)}</h3>
                <p className={styles.summary}>
                  {String(item.state ?? item.kind ?? "ACTIVE")} ·{" "}
                  {String(item.code ?? item.registration_number ?? item.id)}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
