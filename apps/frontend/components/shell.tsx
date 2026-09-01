"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { MastersNav } from "./masters/masters-nav";

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
type NavItem = { href: string; label: string; allowed: boolean };

function capability(effective: Effective | null, prefix: string) {
  return Boolean(
    effective?.capabilities.some((value) => value.startsWith(prefix)),
  );
}

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    let active = true;
    api<Me>("/auth/me")
      .then(async (value) => {
        if (!active) return;
        setMe(value);
        setEffective(
          value.activeTenantId
            ? await api<Effective>("/tenant/access/effective")
            : null,
        );
      })
      .catch((error: { code?: string }) => {
        if (!active) return;
        setMe(null);
        setEffective(null);
        sessionStorage.clear();
        router.replace(
          error?.code === "MFA_REQUIRED"
            ? "/mfa"
            : "/login?reason=access-changed",
        );
      });
    return () => {
      active = false;
    };
  }, [router, path]);

  useEffect(() => setDrawerOpen(false), [path]);
  useEffect(() => {
    if (!drawerOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = drawer.current;
    const focusable = () => [
      ...(node?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("drawer-visible");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("drawer-visible");
      (menuButton.current ?? previouslyFocused)?.focus();
    };
  }, [drawerOpen]);

  const groups = useMemo(() => {
    if (area === "platform")
      return [
        {
          label: "Platform",
          items: [
            {
              href: "/platform/tenants",
              label: "Tenants",
              allowed: Boolean(me?.user.platformAdmin),
            },
            {
              href: "/platform/report",
              label: "Platform health",
              allowed: Boolean(me?.user.platformAdmin),
            },
          ],
        },
      ];
    const ready = Boolean(effective);
    return [
      {
        label: "Home & Control",
        items: [
          {
            href: effective?.home || "/app/setup",
            label: "Home",
            allowed: ready,
          },
          {
            href: "/app/control",
            label: "Control tower",
            allowed: capability(effective, "control."),
          },
          {
            href: "/app/alerts",
            label: "Alerts",
            allowed: capability(effective, "alerts."),
          },
        ],
      },
      {
        label: "Operations",
        items: [
          {
            href: "/app/operations",
            label: "Operations",
            allowed: capability(effective, "operations."),
          },
          {
            href: "/app/pod",
            label: "POD",
            allowed: capability(effective, "pod."),
          },
        ],
      },
      {
        label: "Finance",
        items: [
          {
            href: "/app/finance",
            label: "Finance",
            allowed: capability(effective, "finance."),
          },
        ],
      },
      {
        label: "Masters & Data",
        items: [
          {
            href: "/app/masters",
            label: "Masters",
            allowed: capability(effective, "masters."),
          },
          {
            href: "/app/data",
            label: "Imports",
            allowed:
              capability(effective, "data.") ||
              capability(effective, "import."),
          },
          {
            href: "/app/integrations",
            label: "Integrations",
            allowed: capability(effective, "integrations."),
          },
        ],
      },
      {
        label: "Administration",
        items: [
          {
            href: "/app/access/users",
            label: "Users",
            allowed: Boolean(effective?.navigation.users),
          },
          {
            href: "/app/access/roles",
            label: "Roles",
            allowed: Boolean(effective?.navigation.roles),
          },
          {
            href: "/app/access/reports",
            label: "Activity & audit",
            allowed: Boolean(effective?.navigation.reports),
          },
          {
            href: "/app/governance/policies",
            label: "Governance",
            allowed: capability(effective, "governance."),
          },
          {
            href: "/app/configuration/settings",
            label: "Configuration",
            allowed: capability(effective, "configuration."),
          },
        ],
      },
    ];
  }, [area, effective, me]);

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
    setNotice("Active tenant changed");
    window.location.replace(`/app/setup?context=${result.contextVersion}`);
  }
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }
  const isCurrent = (href: string) =>
    path === href || (href !== "/app" && path.startsWith(`${href}/`));
  const navigation = (
    <>
      {area === "tenant" && me && me.memberships.length > 1 && (
        <label className="switcher">
          <span>Active tenant</span>
          <select
            value={me.activeTenantId ?? ""}
            onChange={(event) => void change(event.target.value)}
          >
            {me.memberships.map((membership) => (
              <option key={membership.id} value={membership.id}>
                {membership.name} ({membership.code})
              </option>
            ))}
          </select>
        </label>
      )}
      {groups.map((group) => {
        const items = group.items.filter((item: NavItem) => item.allowed);
        return items.length ? (
          <section
            className="nav-group"
            key={group.label}
            aria-label={group.label}
          >
            <h2>{group.label}</h2>
            {items.map((item: NavItem) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isCurrent(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </section>
        ) : null;
      })}
      <div className="nav-account">
        <span title={me?.user.email}>{me?.user.email}</span>
        <button className="link-button" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      <header
        className="topbar"
        inert={drawerOpen ? true : undefined}
        aria-hidden={drawerOpen || undefined}
      >
        <button
          ref={menuButton}
          className="menu-button"
          type="button"
          aria-expanded={drawerOpen}
          aria-controls="mobile-navigation"
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true">☰</span>
          <span>Menu</span>
        </button>
        <Link
          className="brand"
          href={
            area === "platform"
              ? "/platform/tenants"
              : effective?.home || "/app/setup"
          }
        >
          <span className="brand-mark">RG</span>
          <span className="brand-copy">
            <strong>Rupantar</strong>
            <small>Logistics workspace</small>
          </span>
        </Link>
        <span className="topbar-context">
          {area === "platform"
            ? "Platform"
            : (me?.memberships.find((item) => item.id === me.activeTenantId)
                ?.name ?? "Workspace")}
        </span>
      </header>
      <aside
        className="nav-rail"
        aria-label="Primary navigation"
        inert={drawerOpen ? true : undefined}
        aria-hidden={drawerOpen || undefined}
      >
        {navigation}
      </aside>
      {drawerOpen && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setDrawerOpen(false)
          }
        >
          <div
            ref={drawer}
            id="mobile-navigation"
            className="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-navigation-title"
          >
            <div className="drawer-head">
              <strong id="mobile-navigation-title">Navigation</strong>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                ×
              </button>
            </div>
            <nav aria-label="Primary navigation">{navigation}</nav>
          </div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>
      <div
        className="shell-content"
        inert={drawerOpen ? true : undefined}
        aria-hidden={drawerOpen || undefined}
      >
        {area === "tenant" && path.startsWith("/app/masters") && <MastersNav />}
        <main id="main" className="page" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
