export type ModuleKey =
  | "masters"
  | "governance"
  | "configuration"
  | "control"
  | "alerts"
  | "data"
  | "integrations"
  | "operations"
  | "pod"
  | "finance";
export type FieldKind =
  | "text"
  | "textarea"
  | "email"
  | "mobile"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "json";

export type ModuleField = {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: readonly string[];
  help?: string;
};

export type WorkflowTransition = {
  from: readonly string[];
  to: string;
  label: string;
  reasonRequired?: boolean;
};

export type ResourceManifest = {
  feature: string;
  module: ModuleKey;
  resource: string;
  singular: string;
  plural: string;
  description: string;
  fields: readonly ModuleField[];
  initialStatus: string;
  transitions: readonly WorkflowTransition[];
  reportDimensions: readonly string[];
  effectiveDated?: boolean;
  documents?: boolean;
  comments?: boolean;
};

const lifecycle: readonly WorkflowTransition[] = [
  { from: ["DRAFT"], to: "ACTIVE", label: "Activate" },
  {
    from: ["ACTIVE"],
    to: "INACTIVE",
    label: "Deactivate",
    reasonRequired: true,
  },
  { from: ["INACTIVE"], to: "ACTIVE", label: "Reactivate" },
];

export const resourceManifests = {
  "masters.locations": {
    feature: "MST-01",
    module: "masters",
    resource: "locations",
    singular: "Location",
    plural: "Locations",
    description: "Regions, branches, hubs and service locations.",
    fields: [
      {
        key: "locationType",
        label: "Location type",
        kind: "select",
        required: true,
        options: ["REGION", "BRANCH", "HUB", "CITY"],
      },
      { key: "parentCode", label: "Parent code", kind: "text" },
      { key: "address", label: "Address", kind: "textarea" },
      { key: "timezone", label: "Timezone", kind: "text" },
    ],
    initialStatus: "DRAFT",
    transitions: lifecycle,
    reportDimensions: ["status", "locationType"],
    effectiveDated: true,
    documents: true,
    comments: true,
  },
  "masters.parties": {
    feature: "MST-02",
    module: "masters",
    resource: "parties",
    singular: "Business party",
    plural: "Clients and vendors",
    description: "Reusable client, vendor and contact master data.",
    fields: [
      {
        key: "partyType",
        label: "Party type",
        kind: "select",
        required: true,
        options: ["CLIENT", "VENDOR", "BOTH"],
      },
      { key: "taxIdentifier", label: "Tax identifier", kind: "text" },
      { key: "email", label: "Email", kind: "email" },
      { key: "mobile", label: "Mobile", kind: "mobile" },
      { key: "address", label: "Address", kind: "textarea" },
    ],
    initialStatus: "DRAFT",
    transitions: lifecycle,
    reportDimensions: ["status", "partyType"],
    effectiveDated: true,
    documents: true,
    comments: true,
  },
  "masters.fleet": {
    feature: "MST-03",
    module: "masters",
    resource: "fleet",
    singular: "Fleet asset",
    plural: "Fleet and drivers",
    description: "Vehicles, vehicle types and driver master records.",
    fields: [
      {
        key: "assetType",
        label: "Record type",
        kind: "select",
        required: true,
        options: ["VEHICLE_TYPE", "VEHICLE", "DRIVER"],
      },
      { key: "registrationNumber", label: "Registration number", kind: "text" },
      { key: "vendorCode", label: "Vendor code", kind: "text" },
      { key: "capacity", label: "Capacity", kind: "number" },
      { key: "expiryDate", label: "Compliance expiry", kind: "date" },
    ],
    initialStatus: "DRAFT",
    transitions: lifecycle,
    reportDimensions: ["status", "assetType", "expiryDate"],
    effectiveDated: true,
    documents: true,
    comments: true,
  },
  "governance.policies": {
    feature: "GOV-01",
    module: "governance",
    resource: "policies",
    singular: "Governance policy",
    plural: "Governance policies",
    description: "Approval rules, delegations and operating controls.",
    fields: [
      {
        key: "policyType",
        label: "Policy type",
        kind: "select",
        required: true,
        options: ["APPROVAL", "DELEGATION", "CONTROL"],
      },
      { key: "appliesTo", label: "Applies to", kind: "text", required: true },
      { key: "rule", label: "Rule", kind: "json", required: true },
      { key: "owner", label: "Control owner", kind: "text" },
    ],
    initialStatus: "DRAFT",
    transitions: [
      { from: ["DRAFT"], to: "PENDING_APPROVAL", label: "Submit" },
      {
        from: ["PENDING_APPROVAL"],
        to: "ACTIVE",
        label: "Approve",
        reasonRequired: true,
      },
      {
        from: ["PENDING_APPROVAL"],
        to: "REJECTED",
        label: "Reject",
        reasonRequired: true,
      },
      ...lifecycle,
    ],
    reportDimensions: ["status", "policyType", "owner"],
    effectiveDated: true,
    documents: true,
    comments: true,
  },
  "configuration.settings": {
    feature: "CFG-01",
    module: "configuration",
    resource: "settings",
    singular: "Configuration set",
    plural: "Configuration",
    description:
      "Effective-dated tenant configuration with immutable snapshots.",
    fields: [
      { key: "namespace", label: "Namespace", kind: "text", required: true },
      {
        key: "value",
        label: "Configuration JSON",
        kind: "json",
        required: true,
      },
      { key: "effectiveFrom", label: "Effective from", kind: "date" },
      { key: "effectiveTo", label: "Effective to", kind: "date" },
    ],
    initialStatus: "DRAFT",
    transitions: lifecycle,
    reportDimensions: ["status", "namespace", "effectiveFrom"],
    effectiveDated: true,
    documents: true,
    comments: true,
  },
} as const satisfies Record<string, ResourceManifest>;

export type ResourceManifestKey = keyof typeof resourceManifests;
export const moduleNavigation = [
  {
    feature: "MST-01",
    label: "Locations",
    href: "/app/masters/locations",
    module: "masters",
  },
  {
    feature: "MST-02",
    label: "Clients & vendors",
    href: "/app/masters/parties",
    module: "masters",
  },
  {
    feature: "MST-03",
    label: "Fleet & drivers",
    href: "/app/masters/fleet",
    module: "masters",
  },
  {
    feature: "GOV-01",
    label: "Governance",
    href: "/app/governance/policies",
    module: "governance",
  },
  {
    feature: "CFG-01",
    label: "Configuration",
    href: "/app/configuration/settings",
    module: "configuration",
  },
] as const;

export const manifestFor = (module: string, resource: string) =>
  resourceManifests[`${module}.${resource}` as ResourceManifestKey];
