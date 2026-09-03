"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export type TabItem<T extends string> = {
  id: T;
  label: string;
  panelId?: string;
};

export function Tabs<T extends string>({
  items,
  active,
  label,
  idPrefix,
  panelId,
  onChange,
}: {
  items: Array<TabItem<T>>;
  active: T;
  label: string;
  idPrefix?: string;
  panelId?: string;
  onChange: (id: T) => void;
}) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-${item.id}` : undefined}
          aria-controls={item.panelId ?? panelId}
          aria-selected={active === item.id}
          tabIndex={active === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowRight"
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
            const next = items[nextIndex];
            if (!next) return;
            onChange(next.id);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [nextIndex]?.focus();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PillNav({
  label,
  items,
}: {
  label: string;
  items: Array<{ href: string; label: string; current?: boolean }>;
}) {
  return (
    <nav className="ui-pill-nav" aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.current ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function DialogHeader({
  titleId,
  eyebrow,
  title,
  onClose,
  closeDisabled = false,
}: {
  titleId: string;
  eyebrow?: string;
  title: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  return (
    <header className="ui-dialog-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 id={titleId}>{title}</h2>
      </div>
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={closeDisabled}
      >
        Close
      </button>
    </header>
  );
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <div className="ui-dialog-body">{children}</div>;
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <footer className="ui-dialog-actions">{children}</footer>;
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="ui-form-grid">{children}</div>;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const recognizedEnums = new Set([
  "ACTIVE",
  "INACTIVE",
  "INVITED",
  "SUSPENDED",
  "DRAFT",
  "OPEN",
  "CLOSED",
  "CANCELLED",
  "APPROVED",
  "REJECTED",
  "SUBMITTED",
  "PAID",
  "PARTIALLY_ALLOCATED",
  "PENDING_FINANCE_APPROVAL",
  "PENDING_OPERATIONAL_VERIFICATION",
  "VALIDATION_EXCEPTION",
]);

type DetailFormat = { locale?: string; timezone?: string };

function readable(value: unknown, format: DetailFormat): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    if (value === "••••") return value;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        try {
          return new Intl.DateTimeFormat(format.locale ?? "en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: format.timezone ?? "Asia/Kolkata",
          }).format(date);
        } catch {
          return date.toISOString();
        }
      }
    }
    return recognizedEnums.has(value) ? humanize(value) : value;
  }
  if (typeof value === "number" || typeof value === "bigint")
    return value.toLocaleString();
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    return (
      <ul className="ui-detail-list-values">
        {value.map((item, index) => (
          <li key={index}>{readable(item, format)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object")
    return (
      <DetailList
        value={value as Record<string, unknown>}
        locale={format.locale}
        timezone={format.timezone}
        nested
      />
    );
  return String(value);
}

export function DetailList({
  value,
  omit = [],
  labels = {},
  locale,
  timezone,
  nested = false,
}: {
  value: Record<string, unknown>;
  omit?: string[];
  labels?: Record<string, string>;
  locale?: string;
  timezone?: string;
  nested?: boolean;
}) {
  return (
    <dl className={`ui-detail-list${nested ? " ui-detail-list-nested" : ""}`}>
      {Object.entries(value)
        .filter(([key]) => !omit.includes(key))
        .map(([key, item]) => (
          <div key={key}>
            <dt>{labels[key] ?? humanize(key)}</dt>
            <dd
              className={
                /(^|_)id$/i.test(key)
                  ? "ui-detail-secondary safe-id"
                  : undefined
              }
            >
              {readable(item, { locale, timezone })}
            </dd>
          </div>
        ))}
    </dl>
  );
}

export function MetricCard({
  label,
  value,
  help,
  selected = false,
  tone = "accent",
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  help?: ReactNode;
  selected?: boolean;
  tone?: "accent" | "success" | "warning" | "danger" | "neutral";
  onClick?: () => void;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      {help && <small>{help}</small>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`ui-metric-card ui-tone-${tone}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <article className={`ui-metric-card ui-tone-${tone}`}>{content}</article>
  );
}

export function FilterChip({
  label,
  onRemove,
}: {
  label: ReactNode;
  onRemove?: () => void;
}) {
  return (
    <span className="ui-filter-chip">
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${String(label)} filter`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
