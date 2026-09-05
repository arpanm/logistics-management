"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "./api";

type SessionHome = {
  home: string;
  user: { platformAdmin: boolean };
  activeTenantId: string | null;
};

export function SessionLanding() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    void api<SessionHome>("/auth/me")
      .then(async (session) => {
        const home =
          session.user.platformAdmin || !session.activeTenantId
            ? session.home
            : (await api<{ home: string }>("/tenant/access/effective")).home;
        if (active) router.replace(home);
      })
      .catch((value: ApiError) => {
        if (!active) return;
        router.replace(value.code === "MFA_REQUIRED" ? "/mfa" : "/login");
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="auth-page" aria-busy="true">
      <section className="auth-card">
        <p className="eyebrow">Logistics workspace</p>
        <h1>Opening your home</h1>
        <p role="status" className="muted">
          Checking your active session and access…
        </p>
      </section>
    </main>
  );
}
