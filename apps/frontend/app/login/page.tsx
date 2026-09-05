"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "../../components/api";
export default function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenantChoices, setTenantChoices] = useState<
    Array<{ code: string; name: string }>
  >([]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const result = await api<{
        user: { platformAdmin: boolean };
        mfaRequired?: boolean;
        activeTenantId?: string;
        home?: string;
        requiresTenantSelection?: boolean;
        tenants?: Array<{ code: string; name: string }>;
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          identifier: f.get("identifier"),
          password: f.get("password"),
          tenantCode: f.get("tenantCode") || undefined,
        }),
      });
      if (result.requiresTenantSelection && result.tenants) {
        setTenantChoices(result.tenants);
        return;
      }
      router.replace(
        result.mfaRequired
          ? "/mfa"
          : result.user.platformAdmin
            ? "/platform/tenants"
            : "/app",
      );
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="login-title">
        <div className="brand-mark large">RG</div>
        <p className="eyebrow">Operations platform</p>
        <h1 id="login-title">Welcome back</h1>
        <p className="muted">Sign in to your secure logistics workspace.</p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <form onSubmit={submit}>
          <label>
            Email or mobile
            <input
              name="identifier"
              type="text"
              inputMode="email"
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
            />
          </label>
          {tenantChoices.length > 0 && (
            <label>
              Workspace
              <select name="tenantCode" required autoFocus defaultValue="">
                <option value="" disabled>
                  Select a workspace
                </option>
                {tenantChoices.map((tenant) => (
                  <option key={tenant.code} value={tenant.code}>
                    {tenant.name} ({tenant.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? "Signing in…"
              : tenantChoices.length
                ? "Continue to workspace"
                : "Sign in"}
          </button>
        </form>
        <p>
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      </section>
    </main>
  );
}
