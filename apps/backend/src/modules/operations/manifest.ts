export type FieldKind =
  | "text"
  | "textarea"
  | "datetime"
  | "date"
  | "integer"
  | "minor-unit"
  | "select"
  | "reference"
  | "attachment";

export type TransactionField = {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  immutableAfter?: string;
  options?: readonly string[];
  reference?: string;
};

export type TransactionManifest = {
  feature: "OPS-01" | "OPS-02" | "OPS-03";
  module: "operations";
  resource: string;
  title: string;
  tenantScoped: true;
  idempotentCreates: true;
  optimisticConcurrency: true;
  fields: readonly TransactionField[];
  statuses: readonly string[];
  transitions: Readonly<Record<string, readonly string[]>>;
  queues: readonly { key: string; label: string; orderBy: string }[];
  reports: readonly {
    key: string;
    label: string;
    measures: readonly string[];
  }[];
  events: readonly string[];
};

const commonIndentFields = [
  { key: "indentNo", label: "Indent No", kind: "text", required: true },
  {
    key: "indentAt",
    label: "Indent Date & Time",
    kind: "datetime",
    required: true,
  },
  {
    key: "clientId",
    label: "Client Code",
    kind: "reference",
    reference: "clients",
    required: true,
  },
  {
    key: "locationId",
    label: "Location Code",
    kind: "reference",
    reference: "client-locations",
    required: true,
  },
  { key: "origin", label: "Origin", kind: "text", required: true },
  { key: "destination", label: "Destination", kind: "text", required: true },
  {
    key: "truckTypeId",
    label: "Truck Type",
    kind: "reference",
    reference: "truck-types",
    required: true,
  },
  {
    key: "quantityMilliTonnes",
    label: "Quantity / Weight (MT)",
    kind: "integer",
    required: true,
  },
  { key: "cargoType", label: "Cargo Type", kind: "text" },
  { key: "bodyType", label: "Body Type", kind: "text" },
  {
    key: "requestedVehicles",
    label: "Requested Vehicles",
    kind: "integer",
    required: true,
  },
  {
    key: "pickupWindowStart",
    label: "Pickup Window Start",
    kind: "datetime",
    required: true,
  },
  {
    key: "pickupWindowEnd",
    label: "Pickup Window End",
    kind: "datetime",
    required: true,
  },
  { key: "contact", label: "Pickup Contact", kind: "text" },
  {
    key: "specialInstructions",
    label: "Special Instructions",
    kind: "textarea",
  },
  {
    key: "contractId",
    label: "Contract / Lane",
    kind: "reference",
    reference: "contracts",
    required: true,
  },
  {
    key: "source",
    label: "Source",
    kind: "select",
    options: ["MANUAL", "COPY", "IMPORT", "API"],
    required: true,
  },
  { key: "sourceReference", label: "Source Reference", kind: "text" },
  {
    key: "committedPlacementAt",
    label: "Committed Placement",
    kind: "datetime",
    required: true,
  },
  {
    key: "commitmentOverrideReason",
    label: "Commitment Override Reason",
    kind: "textarea",
  },
  {
    key: "ownerMembershipId",
    label: "Placement Owner",
    kind: "reference",
    reference: "users",
  },
  { key: "attachments", label: "Attachments", kind: "attachment" },
] as const satisfies readonly TransactionField[];

export const indentManifest = {
  feature: "OPS-01",
  module: "operations",
  resource: "indents",
  title: "Indent capture and lifecycle",
  tenantScoped: true,
  idempotentCreates: true,
  optimisticConcurrency: true,
  fields: commonIndentFields,
  statuses: [
    "DRAFT",
    "OPEN",
    "PARTIALLY_ALLOCATED",
    "FULFILLED",
    "CANCELLED",
    "CLOSED",
  ],
  transitions: {
    DRAFT: ["OPEN", "CANCELLED"],
    OPEN: ["PARTIALLY_ALLOCATED", "FULFILLED", "CANCELLED"],
    PARTIALLY_ALLOCATED: ["FULFILLED", "CANCELLED"],
    FULFILLED: ["CLOSED"],
    CANCELLED: [],
    CLOSED: [],
  },
  queues: [
    {
      key: "open",
      label: "Open and unassigned",
      orderBy: "committedPlacementAt asc",
    },
    {
      key: "approaching",
      label: "Approaching commitment",
      orderBy: "commitmentRisk desc",
    },
    {
      key: "overrides",
      label: "SLA override review",
      orderBy: "updatedAt asc",
    },
  ],
  reports: [
    {
      key: "register",
      label: "Indent register",
      measures: ["requestedVehicles", "eligibleDemand"],
    },
    {
      key: "demand",
      label: "Demand analysis",
      measures: ["requestedVehicles", "quantityMilliTonnes"],
    },
    {
      key: "cancellations",
      label: "Cancellation analysis",
      measures: ["cancelledVehicles", "vendorCostMinor"],
    },
  ],
  events: [
    "indent.submitted",
    "indent.cancelled",
    "indent.commitment_overridden",
    "indent.unowned",
  ],
} as const satisfies TransactionManifest;

export const allocationManifest = {
  feature: "OPS-02",
  module: "operations",
  resource: "allocations",
  title: "Vendor allocation and placement",
  tenantScoped: true,
  idempotentCreates: true,
  optimisticConcurrency: true,
  fields: [
    {
      key: "indentId",
      label: "Indent",
      kind: "reference",
      reference: "indents",
      required: true,
    },
    {
      key: "vendorId",
      label: "Vendor",
      kind: "reference",
      reference: "eligible-vendors",
      required: true,
    },
    {
      key: "allottedVehicles",
      label: "Allotted Quantity",
      kind: "integer",
      required: true,
    },
    {
      key: "offeredRateMinor",
      label: "Offered Rate",
      kind: "minor-unit",
      required: true,
    },
    {
      key: "offerChannel",
      label: "Offer Channel",
      kind: "select",
      options: ["PORTAL", "PHONE_VERIFIED", "EMAIL", "WHATSAPP_VERIFIED"],
      required: true,
    },
    { key: "offeredAt", label: "Offered At", kind: "datetime", required: true },
    { key: "responseAt", label: "Response At", kind: "datetime" },
    {
      key: "acceptanceStatus",
      label: "Acceptance",
      kind: "select",
      options: ["OFFERED", "ACCEPTED", "REJECTED", "EXPIRED"],
      required: true,
    },
    { key: "rejectionReason", label: "Rejection Reason", kind: "textarea" },
    {
      key: "ownerMembershipId",
      label: "Owner",
      kind: "reference",
      reference: "users",
    },
    {
      key: "vehicleId",
      label: "Eligible Vehicle",
      kind: "reference",
      reference: "eligible-vehicles",
    },
    {
      key: "driverId",
      label: "Eligible Driver",
      kind: "reference",
      reference: "eligible-drivers",
    },
    {
      key: "actualReportingAt",
      label: "Actual Reporting Time",
      kind: "datetime",
    },
    {
      key: "placementStatus",
      label: "Placement Status",
      kind: "select",
      options: ["PLACED", "AWAITED", "NTP", "CANCELLED"],
      required: true,
    },
    { key: "delayReason", label: "NTP / Delay Reason", kind: "textarea" },
    { key: "remarks", label: "Remarks", kind: "textarea" },
    {
      key: "gateEvidence",
      label: "Gate / Geofence Evidence",
      kind: "attachment",
    },
  ],
  statuses: [
    "OFFERED",
    "ACCEPTED",
    "REJECTED",
    "EXPIRED",
    "AWAITED",
    "PLACED",
    "NTP",
    "CANCELLED",
  ],
  transitions: {
    OFFERED: ["ACCEPTED", "REJECTED", "EXPIRED"],
    ACCEPTED: ["AWAITED", "PLACED", "NTP", "CANCELLED"],
    AWAITED: ["PLACED", "NTP", "CANCELLED"],
    REJECTED: [],
    EXPIRED: [],
    PLACED: [],
    NTP: ["PLACED", "CANCELLED"],
    CANCELLED: [],
  },
  queues: [
    {
      key: "risk",
      label: "Placement risk",
      orderBy: "commitmentRisk desc, committedPlacementAt asc",
    },
    { key: "offers", label: "Vendor responses", orderBy: "offerExpiresAt asc" },
    { key: "ntp", label: "Unresolved NTP", orderBy: "ageingHours desc" },
  ],
  reports: [
    {
      key: "fill",
      label: "Client / location fill",
      measures: ["allotted", "placed", "pending", "fillBasisPoints"],
    },
    {
      key: "vendor",
      label: "Vendor allocation cards",
      measures: ["allotted", "placed", "ntp", "responseMinutes"],
    },
    {
      key: "delays",
      label: "Delay reason Pareto",
      measures: ["count", "ageingHours"],
    },
  ],
  events: [
    "allocation.offered",
    "allocation.accepted",
    "allocation.rejected",
    "placement.confirmed",
    "placement.ntp",
    "assignment.replaced",
  ],
} as const satisfies TransactionManifest;

export const tripManifest = {
  feature: "OPS-03",
  module: "operations",
  resource: "trips",
  title: "Trip execution",
  tenantScoped: true,
  idempotentCreates: true,
  optimisticConcurrency: true,
  fields: [
    {
      key: "allocationId",
      label: "Placement",
      kind: "reference",
      reference: "allocations",
      required: true,
    },
    { key: "lrNo", label: "LR No", kind: "text" },
    {
      key: "vehicleId",
      label: "Vehicle",
      kind: "reference",
      reference: "vehicles",
      required: true,
    },
    {
      key: "driverId",
      label: "Driver",
      kind: "reference",
      reference: "drivers",
      required: true,
    },
    { key: "gateInAt", label: "Origin Gate-in", kind: "datetime" },
    { key: "loadingStartedAt", label: "Loading Start", kind: "datetime" },
    { key: "loadingCompletedAt", label: "Loading End", kind: "datetime" },
    {
      key: "loadedQuantityMilliTonnes",
      label: "Loaded Weight (MT)",
      kind: "integer",
    },
    { key: "packages", label: "Packages", kind: "integer" },
    { key: "challanNo", label: "Challan", kind: "text" },
    { key: "ewayBillNo", label: "E-way Bill", kind: "text" },
    { key: "sealNo", label: "Seal No", kind: "text" },
    { key: "departedAt", label: "Departure", kind: "datetime" },
    {
      key: "destinationArrivalAt",
      label: "Destination Arrival",
      kind: "datetime",
    },
    { key: "unloadingStartedAt", label: "Unloading Start", kind: "datetime" },
    { key: "unloadingCompletedAt", label: "Unloading End", kind: "datetime" },
    {
      key: "deliveredQuantityMilliTonnes",
      label: "Delivered Weight (MT)",
      kind: "integer",
    },
    { key: "receiverName", label: "Receiver", kind: "text" },
    {
      key: "receiverEvidence",
      label: "OTP / Signature / Stamp",
      kind: "attachment",
    },
    { key: "shortageDamage", label: "Shortage / Damage", kind: "textarea" },
    { key: "photos", label: "Evidence Photos", kind: "attachment" },
  ],
  statuses: [
    "PLANNED",
    "AT_ORIGIN",
    "LOADING",
    "IN_TRANSIT",
    "AT_DESTINATION",
    "UNLOADING",
    "DELIVERED",
    "EXCEPTION",
    "CANCELLED",
  ],
  transitions: {
    PLANNED: ["AT_ORIGIN", "CANCELLED"],
    AT_ORIGIN: ["LOADING", "EXCEPTION"],
    LOADING: ["IN_TRANSIT", "EXCEPTION"],
    IN_TRANSIT: ["AT_DESTINATION", "EXCEPTION"],
    AT_DESTINATION: ["UNLOADING", "EXCEPTION"],
    UNLOADING: ["DELIVERED", "EXCEPTION"],
    EXCEPTION: [
      "AT_ORIGIN",
      "LOADING",
      "IN_TRANSIT",
      "AT_DESTINATION",
      "UNLOADING",
      "CANCELLED",
    ],
    DELIVERED: [],
    CANCELLED: [],
  },
  queues: [
    {
      key: "live",
      label: "Live trips",
      orderBy: "etaRisk desc, expectedDeliveryAt asc",
    },
    {
      key: "field-actions",
      label: "Assigned field actions",
      orderBy: "milestoneDueAt asc",
    },
    {
      key: "offline-conflicts",
      label: "Offline sync conflicts",
      orderBy: "receivedAt asc",
    },
  ],
  reports: [
    {
      key: "milestones",
      label: "Milestone status",
      measures: ["onTime", "late", "missing"],
    },
    {
      key: "tat",
      label: "Loading / transit / unloading TAT",
      measures: ["loadingMinutes", "transitMinutes", "unloadingMinutes"],
    },
    {
      key: "exceptions",
      label: "Trip exceptions",
      measures: [
        "stoppageMinutes",
        "routeDeviationCount",
        "shortageMilliTonnes",
      ],
    },
  ],
  events: [
    "trip.created",
    "trip.event.recorded",
    "trip.offline_conflict",
    "trip.exception",
    "trip.delivery_completed",
  ],
} as const satisfies TransactionManifest;

export const operationsManifests = [
  indentManifest,
  allocationManifest,
  tripManifest,
] as const;
export const operationsNavigation = [
  {
    feature: "OPS-01",
    label: "Indents",
    href: "/app/operations/indents",
    module: "operations",
  },
  {
    feature: "OPS-02",
    label: "Placement",
    href: "/app/operations/allocations",
    module: "operations",
  },
  {
    feature: "OPS-03",
    label: "Trips",
    href: "/app/operations/trips",
    module: "operations",
  },
] as const;
