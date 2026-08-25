export type CanonicalField = {
  key: string;
  label: string;
  kind?:
    | "text"
    | "number"
    | "date"
    | "datetime-local"
    | "select"
    | "textarea"
    | "json";
  required?: boolean;
  options?: readonly string[];
};
export type CanonicalManifest = {
  feature: string;
  resource: string;
  title: string;
  singular: string;
  description: string;
  fields: readonly CanonicalField[];
  transitions: Readonly<Record<string, readonly string[]>>;
};
const ref = (key: string, label: string, required = true): CanonicalField => ({
  key,
  label,
  required,
});
const number = (
  key: string,
  label: string,
  required = true,
): CanonicalField => ({ key, label, kind: "number", required });
const date = (key: string, label: string, required = true): CanonicalField => ({
  key,
  label,
  kind: "date",
  required,
});
const instant = (
  key: string,
  label: string,
  required = true,
): CanonicalField => ({ key, label, kind: "datetime-local", required });

export const canonicalManifests = {
  organization: {
    feature: "MST-01",
    resource: "organization-nodes",
    title: "Organization hierarchy",
    singular: "organization node",
    description:
      "Legal entities, regions, branches, teams and hubs with effective hierarchy and scoped ownership.",
    fields: [
      ref("code", "Code"),
      ref("name", "Name"),
      {
        key: "nodeType",
        label: "Node type",
        kind: "select",
        required: true,
        options: ["LEGAL_ENTITY", "REGION", "BRANCH", "TEAM", "HUB"],
      },
      ref("parentId", "Parent node ID", false),
      ref("authorizationScopeNodeId", "Authorization scope ID", false),
      ref("timezone", "Timezone"),
      { key: "address", label: "Address", kind: "textarea" },
      { key: "postalCodes", label: "Postal codes (JSON array)", kind: "json" },
      { key: "geofence", label: "Geofence (JSON)", kind: "json" },
      date("activeFrom", "Active from"),
      date("activeTo", "Active to", false),
    ],
    transitions: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  },
  employees: {
    feature: "MST-01",
    resource: "employees",
    title: "Employees and ownership",
    singular: "employee",
    description:
      "Manager, home-location, linked-user and operational ownership assignments.",
    fields: [
      ref("employeeCode", "Employee code"),
      ref("displayName", "Display name"),
      ref("email", "Email", false),
      ref("mobile", "Mobile", false),
      ref("managerId", "Manager ID", false),
      ref("homeNodeId", "Home node ID"),
      ref("linkedMembershipId", "Linked user membership", false),
      date("activeFrom", "Active from"),
      date("activeTo", "Active to", false),
    ],
    transitions: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  },
  clients: {
    feature: "MST-02",
    resource: "clients",
    title: "Clients",
    singular: "client",
    description:
      "Billing entities, account ownership, escalation, credit and POD policy.",
    fields: [
      ref("code", "Client code"),
      ref("legalName", "Legal name"),
      ref("industry", "Industry", false),
      ref("billingEntityId", "Billing entity node ID"),
      ref("accountManagerEmployeeId", "Account manager ID", false),
      ref("authorizationScopeNodeId", "Authorization scope ID", false),
      ref("taxIdentifier", "GSTIN / tax ID", false),
      ref("escalationEmail", "Escalation email", false),
      ref("escalationMobile", "Escalation mobile", false),
      number("creditDays", "Credit days"),
      {
        key: "podMode",
        label: "POD mode",
        kind: "select",
        required: true,
        options: ["PHYSICAL", "DIGITAL", "BOTH"],
      },
    ],
    transitions: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  },
  clientLocations: {
    feature: "MST-02",
    resource: "client-locations",
    title: "Client locations",
    singular: "client location",
    description: "Client-owned service locations, managers and geofences.",
    fields: [
      ref("clientId", "Client ID"),
      ref("code", "Location code"),
      ref("name", "Name"),
      ref("locationType", "Location type"),
      ref("organizationNodeId", "Organization node ID"),
      ref("managerEmployeeId", "Manager ID", false),
      ref("authorizationScopeNodeId", "Authorization scope ID", false),
      ref("mobile", "Mobile", false),
      { key: "geofence", label: "Geofence (JSON)", kind: "json" },
    ],
    transitions: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  },
  contracts: {
    feature: "MST-02",
    resource: "contracts",
    title: "Contracts",
    singular: "contract",
    description: "Effective, versioned client terms and document requirements.",
    fields: [
      ref("clientId", "Client ID"),
      ref("code", "Contract code"),
      ref("name", "Name"),
      date("effectiveFrom", "Effective from"),
      date("effectiveTo", "Effective to", false),
      number("creditDays", "Credit days"),
      {
        key: "podMode",
        label: "POD mode",
        kind: "select",
        required: true,
        options: ["PHYSICAL", "DIGITAL", "BOTH"],
      },
      {
        key: "documentRequirements",
        label: "Required documents (JSON array)",
        kind: "json",
      },
      { key: "terms", label: "Terms (JSON)", kind: "json" },
    ],
    transitions: {
      DRAFT: ["PENDING_APPROVAL"],
      PENDING_APPROVAL: ["APPROVED", "DRAFT"],
      APPROVED: ["PUBLISHED"],
      PUBLISHED: ["SUPERSEDED", "INACTIVE"],
    },
  },
  lanes: {
    feature: "MST-02",
    resource: "lanes",
    title: "Lanes, SLA and rates",
    singular: "lane",
    description:
      "Published lane coverage, SLA commitment and exact client rate.",
    fields: [
      ref("contractVersionId", "Contract version ID"),
      ref("code", "Lane code"),
      ref("originLocationId", "Origin location ID"),
      ref("destinationLocationId", "Destination location ID"),
      ref("truckType", "Truck type"),
      ref("cargoType", "Cargo type", false),
      number("quantityMinMilli", "Minimum quantity", false),
      number("quantityMaxMilli", "Maximum quantity", false),
      number("priority", "Priority", false),
      number("placementMinutes", "Placement minutes"),
      number("transitMinutes", "Transit minutes"),
      number("podMinutes", "POD minutes"),
      number("rateMinor", "Rate minor units"),
      number("taxBasisPoints", "Tax basis points"),
      instant("effectiveFrom", "Effective from"),
      instant("effectiveTo", "Effective to", false),
    ],
    transitions: {},
  },
  vendors: {
    feature: "MST-03",
    resource: "vendors",
    title: "Vendors",
    singular: "vendor",
    description:
      "Onboarding, taxation, service eligibility and payment policy.",
    fields: [
      ref("code", "Vendor code"),
      ref("legalName", "Legal name"),
      ref("pan", "PAN", false),
      ref("gstin", "GSTIN", false),
      number("tdsBasisPoints", "TDS basis points", false),
      ref("msmeNumber", "MSME number", false),
      number("paymentTermsDays", "Payment terms", false),
      ref("onboardingEmployeeId", "Onboarding employee", false),
      ref("authorizationScopeNodeId", "Authorization scope ID", false),
    ],
    transitions: {
      ONBOARDING: ["ACTIVE", "BLOCKED"],
      ACTIVE: ["BLOCKED", "INACTIVE"],
      BLOCKED: ["ACTIVE", "INACTIVE"],
      INACTIVE: ["ACTIVE"],
    },
  },
  vehicles: {
    feature: "MST-03",
    resource: "vehicles",
    title: "Vehicles",
    singular: "vehicle",
    description: "Vendor-owned fleet with capacity and GPS identity.",
    fields: [
      ref("vendorId", "Vendor ID"),
      ref("registrationNumber", "Registration number"),
      ref("vehicleType", "Vehicle type"),
      ref("make", "Make", false),
      ref("model", "Model", false),
      number("modelYear", "Model year", false),
      number("capacityMilli", "Capacity milli-units"),
      ref("gpsDeviceId", "GPS device ID", false),
    ],
    transitions: {
      ACTIVE: ["BLOCKED", "INACTIVE"],
      BLOCKED: ["ACTIVE", "INACTIVE"],
      INACTIVE: ["ACTIVE"],
    },
  },
  drivers: {
    feature: "MST-03",
    resource: "drivers",
    title: "Drivers",
    singular: "driver",
    description: "Licensed, portal-linked drivers and safety eligibility.",
    fields: [
      ref("vendorId", "Vendor ID"),
      ref("code", "Driver code"),
      ref("displayName", "Display name"),
      ref("mobile", "Mobile"),
      ref("licenceNumber", "Licence number"),
      ref("licenceClass", "Licence class"),
      date("licenceValidTo", "Licence valid to"),
      ref("emergencyContact", "Emergency contact", false),
      ref("portalMembershipId", "Portal membership ID", false),
    ],
    transitions: {
      ACTIVE: ["BLOCKED", "INACTIVE"],
      BLOCKED: ["ACTIVE", "INACTIVE"],
      INACTIVE: ["ACTIVE"],
    },
  },
  indents: {
    feature: "OPS-01",
    resource: "indents",
    title: "Indents",
    singular: "indent",
    description:
      "Client-filtered, SLA-bound demand with immutable commercial snapshot.",
    fields: [
      ref("indentNo", "Indent number"),
      ref("clientId", "Client ID"),
      ref("clientLocationId", "Client location ID"),
      ref("laneId", "Lane ID"),
      number("requestedVehicles", "Requested vehicles"),
      number("quantityMilli", "Quantity milli-units"),
      instant("pickupWindowStart", "Pickup start"),
      instant("pickupWindowEnd", "Pickup end"),
      instant("committedPlacementAt", "Override commitment", false),
      {
        key: "commitmentOverrideReason",
        label: "Override reason",
        kind: "textarea",
      },
      ref("ownerMembershipId", "Owner membership", false),
      {
        key: "source",
        label: "Source",
        kind: "select",
        required: true,
        options: ["MANUAL", "COPY", "IMPORT", "API"],
      },
      ref("sourceReference", "Source reference", false),
      ref("cargoType", "Cargo type", false),
      ref("bodyType", "Body type", false),
    ],
    transitions: {
      DRAFT: ["OPEN", "CANCELLED"],
      OPEN: ["PARTIALLY_ALLOCATED", "FULFILLED", "CANCELLED"],
      PARTIALLY_ALLOCATED: ["FULFILLED", "CANCELLED"],
      FULFILLED: ["CLOSED"],
    },
  },
  allocations: {
    feature: "OPS-02",
    resource: "allocations",
    title: "Vendor allocation",
    singular: "allocation",
    description:
      "Split demand, eligible vendor offers and append-only assignments.",
    fields: [
      ref("indentId", "Indent ID"),
      ref("vendorId", "Vendor ID"),
      number("allottedVehicles", "Allotted vehicles"),
      number("offeredRateMinor", "Offered rate"),
      {
        key: "offerChannel",
        label: "Offer channel",
        kind: "select",
        required: true,
        options: ["PORTAL", "PHONE_VERIFIED", "EMAIL", "WHATSAPP_VERIFIED"],
      },
      instant("offeredAt", "Offered at"),
      instant("expiresAt", "Expires at"),
      ref("ownerMembershipId", "Owner membership", false),
    ],
    transitions: {
      OFFERED: ["ACCEPTED", "REJECTED", "EXPIRED"],
      ACCEPTED: ["VEHICLE_ASSIGNED", "CANCELLED"],
      VEHICLE_ASSIGNED: ["NTP_RELEASED", "CANCELLED"],
      NTP_RELEASED: ["PLACED", "CANCELLED"],
    },
  },
  trips: {
    feature: "OPS-03",
    resource: "trips",
    title: "Trips",
    singular: "trip",
    description:
      "Assigned driver execution, append-only milestones and privacy-bounded GPS.",
    fields: [],
    transitions: {
      PLANNED: ["AT_ORIGIN", "CANCELLED"],
      AT_ORIGIN: ["LOADED", "CANCELLED"],
      LOADED: ["IN_TRANSIT"],
      IN_TRANSIT: ["AT_DESTINATION"],
      AT_DESTINATION: ["DELIVERED"],
    },
  },
  pod: {
    feature: "DOC-01",
    resource: "pod-tasks",
    title: "POD tasks",
    singular: "POD task",
    description:
      "Delivery-created POD review, correction and client submission.",
    fields: [],
    transitions: {
      AWAITING_POD: ["RECEIVED"],
      RECEIVED: ["UNDER_REVIEW"],
      UNDER_REVIEW: ["ACCEPTED", "REJECTED", "CORRECTION_REQUIRED"],
      REJECTED: ["CORRECTION_REQUIRED"],
      CORRECTION_REQUIRED: ["UNDER_REVIEW", "ACCEPTED"],
      ACCEPTED: ["SUBMITTED_TO_CLIENT"],
      SUBMITTED_TO_CLIENT: ["CLOSED"],
    },
  },
  invoices: {
    feature: "FIN-01",
    resource: "invoices",
    title: "Client invoices",
    singular: "invoice",
    description:
      "Server-calculated billing lines, posting lock and compensating reversal.",
    fields: [
      ref("invoiceNo", "Invoice number"),
      ref("clientId", "Client ID"),
      ref("clientLocationId", "Client location ID"),
      date("invoiceDate", "Invoice date"),
      ref("currency", "Currency"),
      number("creditDays", "Credit days"),
      {
        key: "lines",
        label: "Billable lines (JSON)",
        kind: "json",
        required: true,
      },
    ],
    transitions: {
      DRAFT: ["PENDING_APPROVAL"],
      PENDING_APPROVAL: ["APPROVED", "REJECTED"],
      REJECTED: ["PENDING_APPROVAL"],
      APPROVED: ["POSTED"],
      POSTED: ["SUBMITTED", "REVERSED"],
      SUBMITTED: ["REVERSED"],
    },
  },
  receipts: {
    feature: "FIN-02",
    resource: "receipts",
    title: "Receipts",
    singular: "receipt",
    description:
      "Append-only receipt allocation, deduction, on-account and reversal ledger.",
    fields: [
      ref("receiptRef", "Receipt reference"),
      ref("clientId", "Client ID"),
      date("paymentDate", "Payment date"),
      number("amountMinor", "Amount minor units"),
      {
        key: "mode",
        label: "Payment mode",
        kind: "select",
        required: true,
        options: ["BANK_TRANSFER", "CHEQUE", "CASH", "CARD", "OTHER"],
      },
      ref("instrumentNo", "Instrument / UTR"),
      ref("bankReference", "Bank reference", false),
    ],
    transitions: {
      UNRECONCILED: ["PENDING_APPROVAL"],
      PENDING_APPROVAL: ["RECONCILED", "UNRECONCILED"],
      RECONCILED: ["REVERSED"],
    },
  },
  vendorBills: {
    feature: "FIN-03",
    resource: "vendor-bills",
    title: "Vendor bills",
    singular: "vendor bill",
    description:
      "Trip-rate validation, maker-checker approval and verified-bank settlement.",
    fields: [],
    transitions: {},
  },
  configuration: {
    feature: "CFG-01",
    resource: "configurations",
    title: "Tenant configuration",
    singular: "configuration draft",
    description:
      "Typed, effective-dated publish and rollback versions with tenant-local invalidation.",
    fields: [
      {
        key: "namespace",
        label: "Namespace",
        kind: "select",
        required: true,
        options: [
          "branding",
          "locale",
          "operations",
          "documents",
          "finance",
          "alerts",
          "numbering",
          "integrations",
        ],
      },
      {
        key: "value",
        label: "Configuration JSON",
        kind: "json",
        required: true,
      },
      instant("effectiveFrom", "Effective from"),
      instant("effectiveTo", "Effective to", false),
    ],
    transitions: { DRAFT: ["PUBLISHED"], PUBLISHED: ["SUPERSEDED"] },
  },
} as const satisfies Record<string, CanonicalManifest>;
