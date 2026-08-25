"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import styles from "./policies.module.css";
type Step = { roleId: string; label: string; expiresHours: string };
type Policy = {
  id: string;
  code: string;
  targetType: string;
  minimumMinor?: string;
  maximumMinor?: string;
  steps: Array<{ roleId: string; label: string; expiresHours?: number }>;
  active: boolean;
  version: number;
};
type Role = { id: string; code: string; name: string };
const targets = [
  "CONTRACT",
  "INDENT",
  "ALLOCATION",
  "TRIP",
  "POD",
  "INVOICE",
  "RECEIPT",
  "VENDOR_BILL",
  "PAYMENT_BATCH",
];
const toMinor = (value: string) => {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value);
  if (!match) throw new Error("Enter an amount with at most two decimals");
  return (
    BigInt(match[1]) * BigInt(100) +
    BigInt((match[2] ?? "").padEnd(2, "0"))
  ).toString();
};
const fromMinor = (value: string) => {
  const amount = BigInt(value);
  const fraction = String(amount % BigInt(100)).padStart(2, "0");
  return `${amount / BigInt(100)}.${fraction}`;
};
const formatMinor = (value: string) => {
  const minor = BigInt(value);
  const hundred = BigInt(100);
  return `₹${(minor / hundred).toLocaleString("en-IN")}.${String(minor % hundred).padStart(2, "0")}`;
};
export function PoliciesWorkbench() {
  const [items, setItems] = useState<Policy[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [editing, setEditing] = useState<Policy | null | undefined>(undefined),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [policies, availableRoles] = await Promise.all([
        api<Policy[]>("/governance-workbench/policies"),
        api<Role[]>("/governance-workbench/policies/roles"),
      ]);
      setItems(policies);
      setRoles(
        availableRoles.filter(
          (v) => v.code !== "DRIVER" && v.code !== "CLIENT_VIEWER",
        ),
      );
      setError(null);
    } catch (value) {
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);
  async function save(body: unknown, id?: string) {
    try {
      await api(
        id
          ? `/governance-workbench/policies/${id}`
          : "/governance-workbench/policies",
        {
          method: id ? "PATCH" : "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify(body),
        },
      );
      setNotice("Approval policy saved with immutable audit evidence.");
      setEditing(undefined);
      await load();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <main className={styles.page}>
        <header className={styles.head}>
          <div>
            <p className="eyebrow">GOV-01</p>
            <h1>Approval policies</h1>
            <p className="muted">
              Create and maintain role-sequenced approval rules without editing
              JSON.
            </p>
          </div>
          <button className="primary" onClick={() => setEditing(null)}>
            Create policy
          </button>
        </header>
        {error && (
          <div role="alert" className="error">
            {error.message}
            {error.correlationId && (
              <small> Reference {error.correlationId}</small>
            )}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {notice && (
          <p role="status" className="success">
            {notice}
          </p>
        )}
        <section className={styles.panel} aria-busy={loading}>
          <h2>Configured policies</h2>
          {loading ? (
            <p role="status">Loading policies…</p>
          ) : items.length === 0 ? (
            <p className={styles.empty}>
              No approval policies configured. Create one to govern sensitive
              changes.
            </p>
          ) : (
            <div className={styles.grid}>
              {items.map((policy) => (
                <article className={styles.policy} key={policy.id}>
                  <div className={styles.head}>
                    <h3>{policy.code}</h3>
                    <span
                      className={`${styles.status} ${!policy.active ? styles.inactive : ""}`}
                    >
                      {policy.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p>{policy.targetType.replaceAll("_", " ")}</p>
                  <p>
                    {policy.steps.length} approval step(s)
                    {policy.minimumMinor != null
                      ? ` · from ${formatMinor(policy.minimumMinor)}`
                      : ""}
                  </p>
                  <ol>
                    {policy.steps.map((step, index) => (
                      <li key={`${step.roleId}-${index}`}>
                        {step.label}
                        {step.expiresHours ? ` · ${step.expiresHours}h` : ""}
                      </li>
                    ))}
                  </ol>
                  <button onClick={() => setEditing(policy)}>
                    View / edit
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        {editing !== undefined && (
          <PolicyDialog
            policy={editing}
            roles={roles}
            onClose={() => setEditing(undefined)}
            onSave={(body) => void save(body, editing?.id)}
          />
        )}
      </main>
    </Shell>
  );
}
function PolicyDialog({
  policy,
  roles,
  onClose,
  onSave,
}: {
  policy: Policy | null;
  roles: Role[];
  onClose: () => void;
  onSave: (v: unknown) => void;
}) {
  const [code, setCode] = useState(policy?.code ?? ""),
    [targetType, setTargetType] = useState(policy?.targetType ?? "INVOICE"),
    [minimum, setMinimum] = useState(
      policy?.minimumMinor != null ? fromMinor(policy.minimumMinor) : "",
    ),
    [maximum, setMaximum] = useState(
      policy?.maximumMinor != null ? fromMinor(policy.maximumMinor) : "",
    ),
    [active, setActive] = useState(policy?.active ?? true),
    [steps, setSteps] = useState<Step[]>(
      policy?.steps.map((v) => ({
        roleId: v.roleId,
        label: v.label,
        expiresHours: v.expiresHours ? String(v.expiresHours) : "",
      })) ?? [{ roleId: "", label: "Review", expiresHours: "24" }],
    );
  function update(index: number, key: keyof Step, value: string) {
    setSteps(
      steps.map((step, i) => (i === index ? { ...step, [key]: value } : step)),
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      code,
      targetType,
      minimumMinor: minimum ? toMinor(minimum) : null,
      maximumMinor: maximum ? toMinor(maximum) : null,
      active,
      expectedVersion: policy?.version,
      steps: steps.map((step) => ({
        roleId: step.roleId,
        label: step.label,
        ...(step.expiresHours
          ? { expiresHours: Number(step.expiresHours) }
          : {}),
      })),
    });
  }
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="policy-title"
      className={styles.dialog}
    >
      <div className={styles.head}>
        <h2 id="policy-title">
          {policy ? `Edit ${policy.code}` : "Create approval policy"}
        </h2>
        <button onClick={onClose}>Close</button>
      </div>
      <form className={styles.form} onSubmit={submit}>
        <label>
          Code
          <input
            required
            pattern="[A-Z0-9_-]{2,40}"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <small>Stable identifier used by approval requests.</small>
        </label>
        <label>
          Record type
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
          >
            {targets.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Minimum amount (₹, optional)
          <input
            type="number"
            min="0"
            step="0.01"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
        </label>
        <label>
          Maximum amount (₹, optional)
          <input
            type="number"
            min="0"
            step="0.01"
            value={maximum}
            onChange={(e) => setMaximum(e.target.value)}
          />
        </label>
        <label>
          <span>Policy state</span>
          <select
            value={active ? "ACTIVE" : "INACTIVE"}
            onChange={(e) => setActive(e.target.value === "ACTIVE")}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>
        <section className={`${styles.steps} ${styles.wide}`}>
          <div className={styles.stepHead}>
            <div>
              <h3>Approval sequence</h3>
              <p className="muted">
                Approvers act in this order. Expiry is optional.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setSteps([
                  ...steps,
                  { roleId: "", label: "Review", expiresHours: "24" },
                ])
              }
            >
              Add step
            </button>
          </div>
          {steps.map((step, index) => (
            <div className={styles.step} key={index}>
              <label>
                Approver role
                <select
                  required
                  value={step.roleId}
                  onChange={(e) => update(index, "roleId", e.target.value)}
                >
                  <option value="">Search and select role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name} ({role.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Step label
                <input
                  required
                  value={step.label}
                  onChange={(e) => update(index, "label", e.target.value)}
                />
              </label>
              <label>
                Expires after hours (optional)
                <input
                  type="number"
                  min="1"
                  max="8760"
                  value={step.expiresHours}
                  onChange={(e) =>
                    update(index, "expiresHours", e.target.value)
                  }
                />
              </label>
              <button
                type="button"
                disabled={steps.length === 1}
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
        </section>
        <div className={`${styles.actions} ${styles.wide}`}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Save policy</button>
        </div>
      </form>
    </section>
  );
}
