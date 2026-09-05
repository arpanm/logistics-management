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
type NavItem = {
  href: string;
  label: string;
  allowed: boolean;
  match?: "exact" | "prefix";
};
type NavGroup = { label: string; items: NavItem[] };

function capability(effective: Effective | null, code: string) {
  return Boolean(effective?.capabilities.includes(code));
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
  const drawerTrigger = useRef<HTMLButtonElement>(null);
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
      (drawerTrigger.current ?? previouslyFocused)?.focus();
    };
  }, [drawerOpen]);

  const groups = useMemo<NavGroup[]>(() => {
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
            allowed: ready && effective?.home !== "/app/control",
          },
          {
            href: "/app/control",
            label: "Control tower",
            allowed: capability(effective, "control.dashboard.read"),
          },
          {
            href: "/app/alerts",
            label: "Alerts",
            allowed: capability(effective, "alerts.read"),
          },
          {
            href: "/app/assistant",
            label: "Assistant",
            allowed: capability(effective, "conversation.use"),
          },
        ],
      },
      {
        label: "Operations",
        items: [
          {
            href: "/app/operations",
            label: "Indent & Truck Allocation",
            allowed: capability(effective, "operations.read"),
          },
          {
            href: "/app/pod",
            label: "POD",
            allowed: capability(effective, "pod.read"),
          },
        ],
      },
      {
        label: "Finance",
        items: [
          {
            href: "/app/finance",
            label: "Dashboard",
            allowed: capability(effective, "finance.read"),
            match: "exact",
          },
          {
            href: "/app/finance/invoices",
            label: "Invoices",
            allowed: capability(effective, "finance.read"),
          },
          {
            href: "/app/finance/receipts",
            label: "Collection & Receipt",
            allowed: capability(effective, "finance.read"),
          },
          {
            href: "/app/finance/vendor-bills",
            label: "Vendor Payable",
            allowed: capability(effective, "finance.read"),
          },
          {
            href: "/app/finance/payment-runs",
            label: "Payout Runs",
            allowed: capability(effective, "finance.read"),
          },
        ],
      },
      {
        label: "Masters & Data",
        items: [
          {
            href: "/app/masters",
            label: "Masters",
            allowed: capability(effective, "masters.read"),
          },
          {
            href: "/app/data",
            label: "Imports",
            allowed: capability(effective, "data.import.admin"),
          },
          {
            href: "/app/integrations",
            label: "Integrations",
            allowed: capability(effective, "integrations.read"),
          },
        ],
      },
      {
        label: "Administration",
        items: [
          {
            href: "/app/access/users",
            label: "User & Access",
            allowed: Boolean(effective?.navigation.users),
          },
          {
            href: "/app/access/roles",
            label: "Roles",
            allowed: Boolean(effective?.navigation.roles),
          },
          {
            href: "/app/access/reports",
            label: "Activity & Audit",
            allowed: Boolean(effective?.navigation.reports),
          },
          {
            href: "/app/governance/policies",
            label: "Governance",
            allowed: capability(effective, "governance.read"),
          },
          {
            href: "/app/configuration/settings",
            label: "Configuration",
            allowed: capability(effective, "configuration.read"),
          },
        ],
      },
    ];
  }, [area, effective, me]);

  const mobilePrimaryItems = useMemo(() => {
    const allowed = groups
      .flatMap((group) => group.items)
      .filter((item) => item.allowed);
    const byHref = new Map(allowed.map((item) => [item.href, item]));
    const operations = capability(effective, "operations.read");
    const finance = capability(effective, "finance.read");
    let preferred: string[];
    if (operations && finance) {
      preferred = ["/app/control", "/app/operations", "/app/finance"];
    } else if (operations) {
      preferred = ["/app/operations", "/app/control", "/app/pod"];
    } else if (finance) {
      preferred = [
        "/app/finance",
        "/app/finance/invoices",
        "/app/finance/receipts",
      ];
    } else if (effective?.navigation.users) {
      preferred = [
        "/app/access/users",
        "/app/access/roles",
        "/app/access/reports",
      ];
    } else {
      preferred = [
        effective?.home ?? "",
        "/app/control",
        "/app/pod",
        "/app/masters",
        "/app/alerts",
        "/app/assistant",
      ];
    }
    const selected = preferred
      .map((href) => byHref.get(href))
      .filter((item): item is NavItem => Boolean(item));
    for (const item of allowed) {
      if (selected.length >= 3) break;
      if (!selected.some((candidate) => candidate.href === item.href))
        selected.push(item);
    }
    return selected.slice(0, 3);
  }, [effective, groups]);

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
    window.location.replace(`/app?context=${result.contextVersion}`);
  }
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }
  const isCurrent = (item: NavItem) =>
    path === item.href ||
    (item.match !== "exact" &&
      item.href !== "/app" &&
      path.startsWith(`${item.href}/`));
  const isMobileCurrent = (item: NavItem) =>
    isCurrent(item) ||
    (item.href === "/app/finance" && path.startsWith("/app/finance/"));
  const openDrawer = (trigger: HTMLButtonElement) => {
    drawerTrigger.current = trigger;
    setDrawerOpen(true);
  };
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
                aria-current={isCurrent(item) ? "page" : undefined}
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
    <div
      className={`app-shell ${area}-shell${mobilePrimaryItems.length ? " has-mobile-nav" : ""}`}
    >
      <header
        className="topbar"
        inert={drawerOpen ? true : undefined}
        aria-hidden={drawerOpen || undefined}
      >
        <button
          className="menu-button"
          type="button"
          aria-expanded={drawerOpen}
          aria-controls="mobile-navigation"
          onClick={(event) => openDrawer(event.currentTarget)}
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
      {area === "tenant" && mobilePrimaryItems.length > 0 && (
        <nav
          className="mobile-bottom-nav"
          aria-label="Primary mobile navigation"
          inert={drawerOpen ? true : undefined}
          aria-hidden={drawerOpen || undefined}
        >
          {mobilePrimaryItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={isMobileCurrent(item) ? "page" : undefined}
            >
              <NavigationIcon href={item.href} />
              <span>{mobileLabel(item)}</span>
            </Link>
          ))}
          <button
            type="button"
            aria-label="More navigation"
            aria-expanded={drawerOpen}
            aria-controls="mobile-navigation"
            onClick={(event) => openDrawer(event.currentTarget)}
          >
            <NavigationIcon href="more" />
            <span>More</span>
          </button>
        </nav>
      )}
    </div>
  );
}

function mobileLabel(item: NavItem) {
  const labels: Record<string, string> = {
    "/app/control": "Control",
    "/app/operations": "Indents",
    "/app/pod": "POD",
    "/app/finance": "Finance",
    "/app/finance/invoices": "Invoices",
    "/app/finance/receipts": "Collection",
    "/app/access/users": "Users",
    "/app/access/roles": "Roles",
    "/app/access/reports": "Audit",
  };
  return labels[item.href] ?? item.label;
}

function NavigationIcon({ href }: { href: string }) {
  if (href === "more")
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    );
  if (href.includes("access"))
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.6-4 2.4-6 5.5-6s4.9 2 5.5 6M16 8.5h5M18.5 6v5" />
      </svg>
    );
  if (href.includes("finance"))
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h3M14 15h2" />
      </svg>
    );
  if (href.includes("operations"))
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z" />
        <circle cx="7" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
      </svg>
    );
  if (href.includes("pod"))
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M6 3h9l3 3v15H6zM14 3v4h4M9 12l2 2 4-5" />
      </svg>
    );
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  );
}
