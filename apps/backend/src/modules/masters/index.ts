import type {
  KernelManifest,
  KernelNavDescriptor,
} from "../kernel/contracts.js";

export const masterManifests: readonly KernelManifest[] = [
  {
    feature: "MST-01",
    module: "masters",
    resource: "locations",
    initialStatus: "DRAFT",
    statuses: ["DRAFT", "ACTIVE", "INACTIVE"],
  },
  {
    feature: "MST-02",
    module: "masters",
    resource: "parties",
    initialStatus: "DRAFT",
    statuses: ["DRAFT", "ACTIVE", "INACTIVE"],
  },
  {
    feature: "MST-03",
    module: "masters",
    resource: "fleet",
    initialStatus: "DRAFT",
    statuses: ["DRAFT", "ACTIVE", "INACTIVE"],
  },
];

export const masterNavigation: readonly KernelNavDescriptor[] = [
  {
    feature: "MST-01",
    module: "masters",
    label: "Locations",
    href: "/app/masters/locations",
  },
  {
    feature: "MST-02",
    module: "masters",
    label: "Clients & vendors",
    href: "/app/masters/parties",
  },
  {
    feature: "MST-03",
    module: "masters",
    label: "Fleet & drivers",
    href: "/app/masters/fleet",
  },
];
