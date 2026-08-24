export type PodManifest = {
  feature: "DOC-01";
  module: "pod";
  resource: "proofs";
  initialStatus: "AWAITING_POD";
  statuses: readonly string[];
  fields: readonly {
    key: string;
    label: string;
    kind: string;
    required?: boolean;
  }[];
  transitions: readonly {
    from: readonly string[];
    to: string;
    label: string;
    reasonRequired?: boolean;
  }[];
  queues: readonly string[];
  reports: readonly string[];
};

export const podManifest = {
  feature: "DOC-01",
  module: "pod",
  resource: "proofs",
  initialStatus: "AWAITING_POD",
  statuses: [
    "AWAITING_POD",
    "RECEIVED",
    "UNDER_REVIEW",
    "ACCEPTED",
    "SUBMITTED_TO_CLIENT",
    "CLOSED",
    "REJECTED",
    "CORRECTION_REQUIRED",
  ],
  fields: [
    { key: "lrNo", label: "LR No", kind: "text", required: true },
    { key: "indentNo", label: "Indent No", kind: "text", required: true },
    {
      key: "clientId",
      label: "Client Code",
      kind: "reference",
      required: true,
    },
    {
      key: "locationId",
      label: "Location Code",
      kind: "reference",
      required: true,
    },
    { key: "invoiceIds", label: "Invoice No(s)", kind: "references" },
    { key: "invoiceDate", label: "Invoice Date", kind: "date" },
    { key: "vehicleNo", label: "Vehicle No", kind: "text", required: true },
    { key: "truckType", label: "Truck Type", kind: "text" },
    { key: "loadingDate", label: "Loading Date", kind: "date", required: true },
    {
      key: "deliveryDate",
      label: "Delivery Date",
      kind: "date",
      required: true,
    },
    { key: "receivedDate", label: "POD Received Date", kind: "date" },
    { key: "submittedAt", label: "Submitted to Client", kind: "datetime" },
    { key: "mode", label: "POD Mode", kind: "select", required: true },
    { key: "receiverName", label: "Receiver Name", kind: "text" },
    { key: "stampPresent", label: "Stamp Present", kind: "boolean" },
    {
      key: "shortageDamageRemarks",
      label: "Shortage / Damage Remarks",
      kind: "textarea",
    },
    {
      key: "documents",
      label: "POD / discrepancy documents",
      kind: "attachment",
      required: true,
    },
    {
      key: "ocrConfirmation",
      label: "Confirmed Extracted Values",
      kind: "json",
    },
    { key: "submissionChannel", label: "Submission Channel", kind: "select" },
    {
      key: "submissionAcknowledgement",
      label: "Acknowledgement / Reference",
      kind: "text",
    },
  ],
  transitions: [
    { from: ["AWAITING_POD"], to: "RECEIVED", label: "Record receipt" },
    { from: ["RECEIVED"], to: "UNDER_REVIEW", label: "Start review" },
    {
      from: ["UNDER_REVIEW", "CORRECTION_REQUIRED"],
      to: "ACCEPTED",
      label: "Accept",
    },
    {
      from: ["UNDER_REVIEW"],
      to: "REJECTED",
      label: "Reject",
      reasonRequired: true,
    },
    {
      from: ["UNDER_REVIEW", "REJECTED"],
      to: "CORRECTION_REQUIRED",
      label: "Request correction",
      reasonRequired: true,
    },
    {
      from: ["ACCEPTED"],
      to: "SUBMITTED_TO_CLIENT",
      label: "Submit to client",
    },
    { from: ["SUBMITTED_TO_CLIENT"], to: "CLOSED", label: "Close" },
  ],
  queues: [
    "awaiting-pod",
    "under-review",
    "correction-required",
    "received-not-submitted",
    "prior-period",
  ],
  reports: [
    "pod-register",
    "ageing",
    "value-at-risk",
    "closure-rate",
    "rejected-corrections",
    "vendor-driver-client-location",
  ],
} as const satisfies PodManifest;

export const podNavigation = [
  { feature: "DOC-01", label: "POD", href: "/app/pod", module: "pod" },
] as const;
