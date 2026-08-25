"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CanonicalField } from "../canonical/manifests";

const preferredTimezones = [
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];
const currencies = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "BDT"];

type LookupRow = Record<string, unknown> & { id: string };
const lookupTitle = (row: LookupRow) =>
  String(
    row.displayName ??
      row.display_name ??
      row.legalName ??
      row.legal_name ??
      row.name ??
      row.code ??
      row.employeeCode ??
      row.employee_code ??
      row.registrationNumber ??
      row.registration_number ??
      row.indentNo ??
      row.indent_no ??
      row.id,
  );

function ReferenceField({
  field,
  value,
  onChange,
}: {
  field: CanonicalField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<LookupRow[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const path =
        field.referenceResource === "access-users"
          ? `/tenant/access/users?search=${encodeURIComponent(search)}`
          : `/domain/${field.referenceResource}?search=${encodeURIComponent(search)}`;
      void api<{ items: LookupRow[] }>(path, { signal: controller.signal })
        .then((result) => setItems(result.items ?? []))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [field.referenceResource, search]);
  return (
    <div className="reference-picker">
      <input
        type="search"
        aria-label={`Search ${field.label}`}
        placeholder={`Search ${field.label.toLowerCase()}…`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <select
        id={`canonical-${field.key}`}
        required={field.required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{loading ? "Loading…" : "Select…"}</option>
        {value && !items.some((item) => item.id === value) && (
          <option value={value}>Current selection</option>
        )}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {lookupTitle(item)}
          </option>
        ))}
      </select>
    </div>
  );
}

type Fence = {
  mode: "POLYGON" | "POINT_RADIUS" | "DYNAMIC_RADIUS";
  points: Array<{ lat: number; lng: number }>;
  radiusKm: number;
};
const defaultFence: Fence = { mode: "POINT_RADIUS", points: [], radiusKm: 5 };

function GeofenceField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const fence = useMemo(() => {
    try {
      return value ? (JSON.parse(value) as Fence) : defaultFence;
    } catch {
      return defaultFence;
    }
  }, [value]);
  const update = (next: Fence) => onChange(JSON.stringify(next));
  return (
    <fieldset className="geofence-editor">
      <legend>Geofence method</legend>
      <select
        value={fence.mode}
        onChange={(event) =>
          update({
            ...fence,
            mode: event.target.value as Fence["mode"],
            points: [],
          })
        }
      >
        <option value="POLYGON">Draw polygon on map</option>
        <option value="POINT_RADIUS">Fixed point and radius</option>
        <option value="DYNAMIC_RADIUS">
          Radius around contextual location
        </option>
      </select>
      {fence.mode !== "DYNAMIC_RADIUS" && (
        <div
          className="geofence-map"
          role="application"
          aria-label="Geofence map. Click to add a point."
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const lng = ((event.clientX - box.left) / box.width) * 360 - 180;
            const normalizedY = (event.clientY - box.top) / box.height;
            const lat =
              (Math.atan(Math.sinh(Math.PI * (1 - 2 * normalizedY))) * 180) /
              Math.PI;
            const point = {
              lat: Number(lat.toFixed(6)),
              lng: Number(lng.toFixed(6)),
            };
            update({
              ...fence,
              points:
                fence.mode === "POINT_RADIUS"
                  ? [point]
                  : [...fence.points, point],
            });
          }}
        >
          <span>
            World map · click{" "}
            {fence.mode === "POLYGON"
              ? "each polygon vertex"
              : "the centre point"}
          </span>
          {fence.points.map((point, index) => (
            <i
              key={`${point.lat}-${point.lng}-${index}`}
              style={{
                left: `${((point.lng + 180) / 360) * 100}%`,
                top: `${((1 - Math.asinh(Math.tan((point.lat * Math.PI) / 180)) / Math.PI) / 2) * 100}%`,
              }}
            >
              {index + 1}
            </i>
          ))}
        </div>
      )}
      {fence.mode !== "DYNAMIC_RADIUS" && (
        <small>
          Map data ©{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            OpenStreetMap contributors
          </a>
        </small>
      )}
      <div className="inline-fields">
        {fence.mode !== "DYNAMIC_RADIUS" && fence.points.length > 0 && (
          <output>
            {fence.points
              .map((point) => `${point.lat}, ${point.lng}`)
              .join(" · ")}
          </output>
        )}
        <label>
          Radius (km)
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={fence.radiusKm}
            onChange={(event) =>
              update({ ...fence, radiusKm: Number(event.target.value) })
            }
          />
        </label>
        {fence.points.length > 0 && (
          <button
            type="button"
            onClick={() => update({ ...fence, points: [] })}
          >
            Clear map points
          </button>
        )}
      </div>
      {fence.mode === "DYNAMIC_RADIUS" && (
        <small>
          The centre is taken automatically from the record’s pickup, drop,
          office or current location.
        </small>
      )}
    </fieldset>
  );
}

export function SmartField({
  field,
  value,
  onChange,
}: {
  field: CanonicalField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `canonical-${field.key}`;
  const descriptionId = `${id}-description`;
  const label = `${field.label}${field.required ? "" : " (Optional)"}`;
  return (
    <div className="smart-field">
      <label htmlFor={id}>{label}</label>
      {field.help && <small id={descriptionId}>{field.help}</small>}
      {field.kind === "reference" ? (
        <ReferenceField field={field} value={value} onChange={onChange} />
      ) : field.kind === "geofence" ? (
        <GeofenceField value={value} onChange={onChange} />
      ) : field.kind === "select" ||
        field.kind === "timezone" ||
        field.kind === "currency" ? (
        <select
          id={id}
          required={field.required}
          aria-describedby={field.help ? descriptionId : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select…</option>
          {(field.kind === "timezone"
            ? preferredTimezones
            : field.kind === "currency"
              ? currencies
              : (field.options ?? [])
          ).map((option) => (
            <option key={option} value={option}>
              {option === "Asia/Kolkata" ? "Asia/Kolkata (IST)" : option}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ||
        field.kind === "list" ||
        field.kind === "key-value" ? (
        <textarea
          id={id}
          required={field.required}
          aria-describedby={field.help ? descriptionId : undefined}
          rows={field.kind === "textarea" ? 3 : 2}
          placeholder={
            field.kind === "list"
              ? "value one, value two"
              : field.kind === "key-value"
                ? "key=value, anotherKey=another value"
                : undefined
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === "records" ? (
        <div id={id} className="record-editor">
          <p>
            Enter one record per line, with columns separated by{" "}
            <strong>|</strong>.
          </p>
          <code>
            {field.recordColumns?.map((column) => column.label).join(" | ")}
          </code>
          <textarea
            required={field.required}
            rows={4}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      ) : (
        <input
          id={id}
          type={field.kind ?? "text"}
          required={field.required}
          aria-describedby={field.help ? descriptionId : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
