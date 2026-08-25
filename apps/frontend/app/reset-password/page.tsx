"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "../../components/api";

function ResetPasswordForm() {
  const resetToken = useRef("");
  const [preview, setPreview] = useState<{
    expiresAt: string;
    tenantName: string;
    timezone: string;
    maskedDestination: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token") ?? "";
    history.replaceState({}, "", "/reset-password");
    if (!token) {
      setError("Password reset link is missing");
      return;
    }
    resetToken.current = token;
    api<typeof preview>("/auth/password-reset/preview", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then((value) => {
        setPreview(value);
      })
      .catch((value: ApiError) => setError(value.message));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/auth/password-reset/complete", {
        method: "POST",
        body: JSON.stringify({
          token: resetToken.current,
          password: form.get("password"),
          passwordConfirmation: form.get("passwordConfirmation"),
        }),
      });
      setComplete(true);
      setPreview(null);
    } catch (value) {
      setError((value as ApiError).message);
      event.currentTarget.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="reset-title">
        <div className="brand-mark large">RG</div>
        <p className="eyebrow">Account recovery</p>
        <h1 id="reset-title">Create a new password</h1>
        {complete && (
          <p role="status">
            Password reset complete. Your other sessions have been signed out.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!preview && !error && !complete && (
          <p role="status">Checking reset link…</p>
        )}
        {preview && (
          <>
            <p>
              Reset access for <strong>{preview.tenantName}</strong> identity{" "}
              {preview.maskedDestination}.
            </p>
            <p className="muted">
              This one-time link expires{" "}
              {new Date(preview.expiresAt).toLocaleString(undefined, {
                timeZone: preview.timezone,
              })}{" "}
              ({preview.timezone}). Completing the reset signs the identity out
              of every device and workspace.
            </p>
            <form onSubmit={submit}>
              <label>
                New password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                />
              </label>
              <label>
                Confirm new password
                <input
                  name="passwordConfirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? "Resetting…" : "Reset password"}
              </button>
            </form>
          </>
        )}
        <p>
          <Link href="/login">{complete ? "Sign in" : "Back to sign in"}</Link>
        </p>
      </section>
    </main>
  );
}

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
