"use client";
import Link from "next/link";
import { Shell } from "../shell";
const groups = [
  {
    title: "Organization & people",
    description:
      "Maintain hierarchy, PIN-derived geography, employees, coverage and operational ownership.",
    links: [
      ["Organization & geography", "/app/masters/locations"],
      ["Employees & ownership", "/app/masters/employees"],
    ],
  },
  {
    title: "Clients & commercials",
    description:
      "Maintain client parties, service locations, contracts and lanes.",
    links: [
      ["Clients", "/app/masters/parties"],
      ["Client locations", "/app/masters/client-locations"],
      ["Contracts", "/app/masters/contracts"],
      ["Lanes", "/app/masters/lanes"],
    ],
  },
  {
    title: "Supply & fleet",
    description:
      "Maintain vendors, vehicles and drivers used in allocation and trip execution.",
    links: [
      ["Vendors", "/app/masters/vendors"],
      ["Fleet", "/app/masters/fleet"],
      ["Drivers", "/app/masters/drivers"],
    ],
  },
];
export function MastersHub() {
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Master data</p>
          <h1>Masters</h1>
          <p className="muted">
            Create the reusable organization, customer and supply records used
            by operations and finance.
          </p>
        </div>
      </div>
      <div className="hub-grid">
        {groups.map((group) => (
          <section className="panel" key={group.title}>
            <h2>{group.title}</h2>
            <p>{group.description}</p>
            <div className="hub-links">
              {group.links.map(([label, href]) => (
                <Link className="button-link" key={href} href={href}>
                  {label}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Shell>
  );
}
