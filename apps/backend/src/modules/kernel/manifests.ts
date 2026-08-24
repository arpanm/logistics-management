import {
  configurationManifests,
  configurationNavigation,
} from "../configuration/index.js";
import {
  governanceManifests,
  governanceNavigation,
} from "../governance/index.js";
import { masterManifests, masterNavigation } from "../masters/index.js";
import {
  operationsManifests,
  operationsNavigation,
} from "../operations/index.js";
import { podManifest, podNavigation } from "../pod/index.js";
import { financeManifests, financeNavigation } from "../finance/index.js";
import {
  intelligenceManifests,
  intelligenceNavigation,
} from "../control/index.js";

const intelligenceKernelManifests = intelligenceManifests.flatMap((manifest) =>
  manifest.entities.map((entity) => ({
    feature: manifest.code,
    module: manifest.capabilityPrefix as
      | "control"
      | "alerts"
      | "data"
      | "integrations",
    resource: entity.code,
    initialStatus: entity.states?.[0] ?? "ACTIVE",
    statuses: entity.states ?? (["ACTIVE"] as const),
  })),
);

const transactionKernelManifests = [
  ...operationsManifests,
  podManifest,
  ...financeManifests,
].map((manifest) => ({
  feature: manifest.feature,
  module: manifest.module,
  resource: manifest.resource,
  initialStatus: manifest.statuses[0] ?? "DRAFT",
  statuses: manifest.statuses,
}));

export const kernelManifests = [
  ...masterManifests,
  ...governanceManifests,
  ...configurationManifests,
  ...transactionKernelManifests,
  ...intelligenceKernelManifests,
] as const;

export const moduleNavDescriptors = [
  ...masterNavigation,
  ...governanceNavigation,
  ...configurationNavigation,
  ...operationsNavigation,
  ...podNavigation,
  ...financeNavigation,
  ...intelligenceNavigation.map((item) => ({
    ...item,
    module: intelligenceManifests.find(
      (manifest) => manifest.code === item.feature,
    )!.capabilityPrefix as "control" | "alerts" | "data" | "integrations",
  })),
] as const;

export const findKernelManifest = (module: string, resource: string) =>
  kernelManifests.find(
    (manifest) => manifest.module === module && manifest.resource === resource,
  );
