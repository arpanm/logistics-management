"use client";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { api, type ApiError } from "../../components/api";

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ accepted: true; message: string }>(
        "/auth/password-reset/request",
        {
          method: "POST",
          body: JSON.stringify({
            identifier: form.get("identifier"),
            tenantCode: form.get("tenantCode") || undefined,
          }),
        },
      );
      setMessage(result.message);
      event.currentTarget.reset();
    } catch (value) {
      setError((value as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="forgot-title">
        <div className="brand-mark large">RG</div>
        <p className="eyebrow">Account recovery</p>
        <h1 id="forgot-title">Reset your password</h1>
        <p className="muted">
          Enter the email address or mobile number used for your invitation. The
          workspace code is optional unless the same identity belongs to
          multiple workspaces.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <form onSubmit={submit}>
          <label>
            Email or mobile
            <input
              name="identifier"
              type="text"
              autoComplete="username"
              required
              minLength={3}
            />
          </label>
          <label>
            Workspace code <span className="muted">(optional)</span>
            <input
              name="tenantCode"
              type="text"
              autoCapitalize="characters"
              maxLength={30}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Requesting…" : "Request password reset"}
          </button>
        </form>
        <p className="muted">
          Recovery delivery is not currently configured. Ask your workspace
          administrator to generate a one-time reset link from the user
          directory.
        </p>
        <p>
          <Link href="/login">Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}
