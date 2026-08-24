import type { IntelligenceModuleManifest } from "./module-contract.js";

export const controlManifest: IntelligenceModuleManifest = {
  code: "CTL-01",
  name: "Control tower dashboards",
  capabilityPrefix: "control",
  navigation: { label: "Control tower", href: "/app/control" },
  entities: [
    {
      code: "saved_view",
      label: "Saved view",
      fields: ["lens", "name", "filters", "isDefault"],
      states: ["ACTIVE"],
    },
  ],
  reports: [
    {
      code: "placement",
      label: "Placement",
      drillBy: ["client", "location", "record"],
    },
    {
      code: "pod",
      label: "POD versus invoice",
      drillBy: ["client", "location", "record"],
    },
    {
      code: "collection",
      label: "Collection",
      drillBy: ["client", "location", "invoice"],
    },
    {
      code: "trip",
      label: "Trip execution",
      drillBy: ["status", "owner", "trip"],
    },
    {
      code: "vendor-payable",
      label: "Vendor payable",
      drillBy: ["vendor", "status", "bill"],
    },
  ],
};

export const controlKpis = {
  placement: [
    "liveIndents",
    "green",
    "yellow",
    "red",
    "placed",
    "awaiting",
    "fillRate",
  ],
  pod: [
    "deliveryRecords",
    "received",
    "pendingCurrent",
    "pendingPrior",
    "valueAtRisk",
    "closureRate",
  ],
  collection: [
    "submitted",
    "billedMinor",
    "receivedMinor",
    "outstandingMinor",
    "openInvoices",
    "over45Minor",
  ],
  trip: ["active", "atRisk", "delayed", "gpsSilent", "detention", "exceptions"],
  "vendor-payable": [
    "unbilledMinor",
    "approvalPendingMinor",
    "dueMinor",
    "overdueMinor",
    "blockedMinor",
    "disputedMinor",
  ],
} as const;
