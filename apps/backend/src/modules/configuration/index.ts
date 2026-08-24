import type {
  KernelManifest,
  KernelNavDescriptor,
} from "../kernel/contracts.js";

export const configurationManifests: readonly KernelManifest[] = [
  {
    feature: "CFG-01",
    module: "configuration",
    resource: "settings",
    initialStatus: "DRAFT",
    statuses: ["DRAFT", "ACTIVE", "INACTIVE"],
  },
];

export const configurationNavigation: readonly KernelNavDescriptor[] = [
  {
    feature: "CFG-01",
    module: "configuration",
    label: "Configuration",
    href: "/app/configuration/settings",
  },
];
