export type UiField = {
  key: string;
  label: string;
  kind:
    | "text"
    | "textarea"
    | "email"
    | "mobile"
    | "number"
    | "date"
    | "select"
    | "key-value"
    | "timezone";
  required?: boolean;
  options?: readonly string[];
  help?: string;
};
export type UiTransition = {
  from: readonly string[];
  to: string;
  label: string;
  reasonRequired?: boolean;
};
export type UiManifest = {
  feature: string;
  module: "masters" | "governance" | "configuration";
  resource: string;
  singular: string;
  plural: string;
  description: string;
  fields: readonly UiField[];
  transitions: readonly UiTransition[];
};
const lifecycle: readonly UiTransition[] = [
  { from: ["DRAFT"], to: "ACTIVE", label: "Activate" },
  {
    from: ["ACTIVE"],
    to: "INACTIVE",
    label: "Deactivate",
    reasonRequired: true,
  },
  { from: ["INACTIVE"], to: "ACTIVE", label: "Reactivate" },
];
export const uiManifests = {
  locations: {
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
      { key: "timezone", label: "Timezone", kind: "timezone", required: true },
    ],
    transitions: lifecycle,
  },
  parties: {
    feature: "MST-02",
    module: "masters",
    resource: "parties",
    singular: "Business party",
    plural: "Clients and vendors",
    description: "Client, vendor and contact master data.",
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
    transitions: lifecycle,
  },
  fleet: {
    feature: "MST-03",
    module: "masters",
    resource: "fleet",
    singular: "Fleet asset",
    plural: "Fleet and drivers",
    description: "Vehicles, vehicle types and driver records.",
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
    transitions: lifecycle,
  },
  policies: {
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
      {
        key: "rule",
        label: "Rule values",
        kind: "key-value",
        required: true,
        help: "Enter comma-separated key=value conditions.",
      },
      { key: "owner", label: "Control owner", kind: "text" },
    ],
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
  },
  settings: {
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
        label: "Configuration values",
        kind: "key-value",
        help: "Enter comma-separated key=value settings.",
        required: true,
      },
      { key: "effectiveFrom", label: "Effective from", kind: "date" },
      { key: "effectiveTo", label: "Effective to", kind: "date" },
    ],
    transitions: lifecycle,
  },
} as const satisfies Record<string, UiManifest>;
