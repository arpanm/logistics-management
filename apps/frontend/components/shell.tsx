"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "./api";
import { usePathname, useRouter } from "next/navigation";
type Me = {
  user: { email: string; platformAdmin: boolean };
  activeTenantId: string | null;
  contextVersion: number;
  memberships: Array<{
    id: string;
    code: string;
    name: string;
    primaryColor: string;
  }>;
};
type Effective = {
  capabilities: string[];
  navigation: {
    users: boolean;
    roles: boolean;
    reports: boolean;
    probes: boolean;
  };
  home: string;
};
export function Shell({
  children,
  area = "tenant",
}: {
  children: React.ReactNode;
  area?: "platform" | "tenant";
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState("");
  const [effective, setEffective] = useState<Effective | null>(null);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    api<Me>("/auth/me")
      .then(async (value) => {
        setMe(value);
        if (value.activeTenantId)
          setEffective(await api<Effective>("/tenant/access/effective"));
      })
      .catch((error: { code?: string }) => {
        setMe(null);
        setEffective(null);
        sessionStorage.clear();
        router.replace(
          error?.code === "MFA_REQUIRED"
            ? "/mfa"
            : "/login?reason=access-changed",
        );
      });
  }, [router, path]);
  async function change(id: string) {
    if (!me) return;
    const result = await api<{ contextVersion: number }>(
      "/session/active-tenant",
      {
        method: "POST",
        body: JSON.stringify({
          tenantId: id,
          expectedContextVersion: me.contextVersion,
        }),
      },
    );
    setNotice(`Active tenant changed`);
    window.location.replace(`/app/setup?context=${result.contextVersion}`);
  }
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }
  return (
    <>
      <header className="topbar">
        <Link
          className="brand"
          href={area === "platform" ? "/platform/tenants" : "/app/setup"}
        >
          <span className="brand-mark">RG</span>
          <span>Rupantar Logistics</span>
        </Link>
        <nav aria-label="Primary">
          {me?.user.platformAdmin && (
            <>
              <Link href="/platform/tenants">Tenants</Link>
              <Link href="/platform/report">Health</Link>
            </>
          )}
          {area === "tenant" && me && me.memberships.length > 1 && (
            <label className="switcher">
              Tenant
              <select
                aria-label="Active tenant"
                value={me.activeTenantId ?? ""}
                onChange={(e) => void change(e.target.value)}
              >
                {me.memberships.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          {area === "tenant" && effective?.navigation.users && (
            <Link href="/app/access/users">Users</Link>
          )}
          {area === "tenant" && effective?.navigation.roles && (
            <Link href="/app/access/roles">Roles</Link>
          )}
          {area === "tenant" && effective?.navigation.reports && (
            <Link href="/app/access/reports">Activity &amp; audit</Link>
          )}
          {area === "tenant" && effective && (
            <>
              <Link href="/app/masters/locations">Masters</Link>
              <Link href="/app/operations">Operations</Link>
              <Link href="/app/pod">POD</Link>
              <Link href="/app/finance">Finance</Link>
              <Link href="/app/control">Control</Link>
              <Link href="/app/alerts">Alerts</Link>
              <Link href="/app/data">Imports</Link>
              <Link href="/app/integrations">Integrations</Link>
              <Link href="/app/governance/policies">Governance</Link>
              <Link href="/app/configuration/settings">Configuration</Link>
            </>
          )}
          <button className="link-button" onClick={() => void logout()}>
            Sign out
          </button>
        </nav>
      </header>
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>
      <main id="main" className="page" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
