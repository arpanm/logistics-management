"use client";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { Shell } from "../../../components/shell";
import { api, ApiError } from "../../../components/api";
import { FormSubmitResult } from "../../../components/forms/form-submit-result";
type Context = {
  tenant: {
    id: string;
    code: string;
    name: string;
    timezone: string;
    locale: string;
    currency: string;
    shortName: string;
    primaryColor: string;
    accentColor: string;
  };
  checklist: Array<{
    key: string;
    label: string;
    state: string;
    version: number;
  }>;
  configurations: Array<{ namespace: string; value: unknown }>;
  contextVersion: number;
};
type Probe = { id: string; label: string; note: string; version: number };

const setupActions: Record<
  string,
  { href: string; label: string; pending: string }
> = {
  organization: {
    href: "/app/masters/locations",
    label: "Manage organization",
    pending: "Create or review the legal entity and organization hierarchy.",
  },
  users: {
    href: "/app/access/users",
    label: "Manage users",
    pending: "Invite employees and assign their roles and scopes.",
  },
  branches: {
    href: "/app/masters/locations",
    label: "Add branches",
    pending: "Add branches and regions under the organization hierarchy.",
  },
  clients: {
    href: "/app/masters/parties",
    label: "Add clients",
    pending: "Create the first client master.",
  },
  vendors: {
    href: "/app/masters/vendors",
    label: "Add vendors",
    pending: "Create the first vendor and its operating scope.",
  },
  commercial: {
    href: "/app/masters/contracts",
    label: "Configure commercials",
    pending: "Create and publish client contracts, lanes, rates, and SLAs.",
  },
  imports: {
    href: "/app/data",
    label: "Open imports",
    pending: "Validate and commit a CSV or XLSX master-data import.",
  },
};

function contrastInk(background: string) {
  const hex = background.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#000000";
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

export default function Setup() {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [probes, setProbes] = useState<Probe[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checklistBusy, setChecklistBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function load() {
    setError("");
    try {
      const [c, p] = await Promise.all([
        api<Context>("/tenant/context"),
        api<{ items: Probe[] }>("/tenant/probes"),
      ]);
      setCtx(c);
      setProbes(p.items);
    } catch (error) {
      setError((error as ApiError).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("/tenant/probes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ label: f.get("label"), note: f.get("note") }),
      });
      form.reset();
      await load();
      setNotice("Isolated record added.");
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function updateBranding(item: Context["checklist"][number]) {
    const nextState = item.state === "COMPLETE" ? "NOT_STARTED" : "COMPLETE";
    setChecklistBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/tenant/setup/${item.key}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: item.version,
          state: nextState,
        }),
      });
      await load();
      setNotice(
        nextState === "COMPLETE"
          ? "Branding setup marked complete."
          : "Branding setup reopened.",
      );
    } catch (error) {
      setError((error as ApiError).message);
    } finally {
      setChecklistBusy(false);
    }
  }
  return (
    <Shell>
      <p className="sr-only" role="status" aria-live="polite">
        {notice}
      </p>
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      {!ctx ? (
        <p role="status">Loading your workspace…</p>
      ) : (
        <>
          {(() => {
            const next = ctx.checklist.find(
              (item) => item.state !== "COMPLETE" && setupActions[item.key],
            );
            return next ? (
              <section className="panel setup-next">
                <div>
                  <p className="eyebrow">Recommended next step</p>
                  <h2>{next.label}</h2>
                  <p>{setupActions[next.key]!.pending}</p>
                </div>
                <Link
                  className="button primary"
                  href={setupActions[next.key]!.href}
                >
                  {setupActions[next.key]!.label}
                </Link>
              </section>
            ) : null;
          })()}
          <section
            className="tenant-hero"
            style={
              {
                "--tenant": ctx.tenant.primaryColor,
                "--tenant-ink": contrastInk(ctx.tenant.primaryColor),
                "--accent": ctx.tenant.accentColor,
                "--accent-ink": contrastInk(ctx.tenant.accentColor),
              } as React.CSSProperties
            }
          >
            <div className="tenant-mark">
              {ctx.tenant.shortName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="eyebrow">{ctx.tenant.code}</p>
              <h1>{ctx.tenant.name}</h1>
              <p>
                {ctx.tenant.locale} · {ctx.tenant.currency} ·{" "}
                {ctx.tenant.timezone}
              </p>
            </div>
          </section>
          <div className="grid-2">
            <section className="panel">
              <h2>Setup checklist</h2>
              <p className="muted">
                Complete these areas in sequence. Each action opens the live
                workspace for that setup area.
              </p>
              <ul className="checklist">
                {ctx.checklist.map((i) => (
                  <li key={i.key}>
                    <span aria-hidden>
                      {i.state === "COMPLETE" ? "✓" : "○"}
                    </span>
                    <div>
                      <strong>{i.label}</strong>
                      <small>
                        {i.state === "COMPLETE"
                          ? "Configured — open to review or add more"
                          : i.key === "branding"
                            ? "Ready to complete"
                            : (setupActions[i.key]?.pending ??
                              "Ready for configuration")}
                      </small>
                    </div>
                    <span
                      className={`status ${i.state === "COMPLETE" ? "active" : ""}`}
                    >
                      {i.state.replaceAll("_", " ")}
                    </span>
                    {i.key === "branding" && (
                      <button
                        type="button"
                        disabled={checklistBusy}
                        aria-label={
                          i.state === "COMPLETE"
                            ? "Reopen branding setup"
                            : "Mark branding setup complete"
                        }
                        onClick={() => void updateBranding(i)}
                      >
                        {checklistBusy
                          ? "Updating…"
                          : i.state === "COMPLETE"
                            ? "Reopen"
                            : "Mark complete"}
                      </button>
                    )}
                    {setupActions[i.key] && (
                      <Link className="button" href={setupActions[i.key].href}>
                        {setupActions[i.key].label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel isolation">
              <p className="eyebrow">Development assurance</p>
              <h2>Isolation test records</h2>
              <p className="muted">
                Simple records exercise tenant-scoped data, documents, events,
                reports and exports.
              </p>
              <form onSubmit={add}>
                <label>
                  Label
                  <input name="label" required minLength={2} />
                </label>
                <label>
                  Note
                  <textarea name="note" maxLength={2000} />
                </label>
                <FormSubmitResult error={error} success={notice} busy={busy}>
                  <button className="primary" disabled={busy}>
                    {busy ? "Saving…" : "Add isolated record"}
                  </button>
                </FormSubmitResult>
              </form>
              <div className="probe-list">
                {probes.length === 0 ? (
                  <p className="empty">No isolation records in this tenant.</p>
                ) : (
                  probes.map((p) => (
                    <article key={p.id}>
                      <strong>{p.label}</strong>
                      <p>{p.note}</p>
                      <a href={`/api/v1/tenant/probes/${p.id}/document`}>
                        Open stored document
                      </a>
                    </article>
                  ))
                )}
              </div>
              <p className="muted">
                CSV columns: Label, Note, Created at. The sample contains one
                example row; the export contains only this tenant's real
                records.
              </p>
              <div className="actions">
                <a className="button" href="/api/v1/tenant/probes/template">
                  Download sample CSV
                </a>
                <a className="button" href="/api/v1/tenant/probes/export">
                  Export current tenant CSV
                </a>
              </div>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}
