import type {
  KernelManifest,
  KernelNavDescriptor,
} from "../kernel/contracts.js";

export const governanceManifests: readonly KernelManifest[] = [
  {
    feature: "GOV-01",
    module: "governance",
    resource: "policies",
    initialStatus: "DRAFT",
    statuses: ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "REJECTED", "INACTIVE"],
  },
];

export const governanceNavigation: readonly KernelNavDescriptor[] = [
  {
    feature: "GOV-01",
    module: "governance",
    label: "Governance",
    href: "/app/governance/policies",
  },
];
export { GovernanceWorkbenchController } from "./workbench.controller.js";
export { GovernanceWorkbenchService } from "./workbench.service.js";
