"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["/app/masters", "Overview"],
  ["/app/masters/locations", "Organization & geography"],
  ["/app/masters/employees", "Employees & ownership"],
  ["/app/masters/parties", "Clients"],
  ["/app/masters/client-locations", "Client locations"],
  ["/app/masters/contracts", "Contracts"],
  ["/app/masters/lanes", "Lanes"],
  ["/app/masters/vendors", "Vendors"],
  ["/app/masters/fleet", "Fleet"],
  ["/app/masters/catalogs", "Truck/body/cargo catalogs"],
  ["/app/masters/drivers", "Drivers"],
] as const;
export function MastersNav() {
  const path = usePathname();
  return (
    <nav className="subnav" aria-label="Masters">
      <span>Masters</span>
      {links.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={path === href ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
