"use client";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "../../components/api";
type Preview = {
  name: string;
  shortName: string;
  primaryColor: string;
  email: string;
  expiresAt: string;
  existingAccount: boolean;
};
function AcceptForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (token)
      api<Preview>(`/auth/invitations/${encodeURIComponent(token)}/preview`)
        .then(setPreview)
        .catch((e: ApiError) => setError(e.message));
    else setError("Invitation link is invalid");
  }, [token]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({
          displayName: f.get("displayName") || "Existing account",
          password: f.get("password"),
          passwordConfirmation: f.get("confirmation") || f.get("password"),
          termsAccepted: f.get("terms") === "on",
        }),
      });
      router.replace("/app/setup");
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <section
        className="auth-card"
        style={
          preview
            ? ({ "--tenant": preview.primaryColor } as React.CSSProperties)
            : {}
        }
      >
        <div className="brand-mark large">
          {preview?.shortName?.slice(0, 2).toUpperCase() ?? "RG"}
        </div>
        <p className="eyebrow">Tenant owner invitation</p>
        <h1>{preview ? `Join ${preview.name}` : "Checking invitation…"}</h1>
        {preview && (
          <p className="muted">
            Invitation for {preview.email}, expires{" "}
            {new Date(preview.expiresAt).toLocaleString()}.
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {preview && (
          <form onSubmit={submit}>
            {!preview.existingAccount && (
              <label>
                Your name
                <input
                  name="displayName"
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </label>
            )}
            {preview.existingAccount && (
              <p className="muted">
                This email already has an account. Enter its current password to
                link this workspace; your identity details will not change.
              </p>
            )}
            <label>
              {preview.existingAccount
                ? "Existing account password"
                : "Create password"}
              <input
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete={
                  preview.existingAccount ? "current-password" : "new-password"
                }
              />
              {!preview.existingAccount && (
                <small>At least 12 characters.</small>
              )}
            </label>
            {!preview.existingAccount && (
              <label>
                Confirm password
                <input
                  name="confirmation"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </label>
            )}
            <label className="checkbox">
              <input name="terms" type="checkbox" required /> I accept the local
              terms acknowledgement
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "Creating workspace access…" : "Accept invitation"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export default function Accept() {
  return (
    <Suspense
      fallback={
        <main id="main" className="auth-page" tabIndex={-1}>
          <section className="auth-card" aria-busy="true">
            Checking invitation…
          </section>
        </main>
      }
    >
      <AcceptForm />
    </Suspense>
  );
}
