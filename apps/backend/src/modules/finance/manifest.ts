export type FinanceFeature = "FIN-01" | "FIN-02" | "FIN-03";
export type FinanceManifest = {
  feature: FinanceFeature;
  module: "finance";
  resource: string;
  title: string;
  initialStatus: string;
  statuses: readonly string[];
  fields: readonly {
    key: string;
    label: string;
    kind: string;
    required?: boolean;
    immutableAfter?: string;
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

export const invoiceManifest = {
  feature: "FIN-01",
  module: "finance",
  resource: "invoices",
  title: "Client billing",
  initialStatus: "DRAFT",
  statuses: [
    "DRAFT",
    "PENDING_APPROVAL",
    "REJECTED",
    "APPROVED",
    "POSTED",
    "SUBMITTED",
    "REVERSED",
  ],
  fields: [
    {
      key: "invoiceNo",
      label: "Invoice No",
      kind: "text",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "invoiceDate",
      label: "Invoice Date",
      kind: "date",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "clientId",
      label: "Client",
      kind: "reference",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "locationId",
      label: "Location",
      kind: "reference",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "billingMonth",
      label: "Billing Month",
      kind: "month",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "serviceIds",
      label: "Trips / LRs",
      kind: "references",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "lines",
      label: "Taxable / charge / credit lines",
      kind: "money-lines",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "taxTotalMinor",
      label: "GST / Tax",
      kind: "minor-unit",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "totalMinor",
      label: "Total Invoice Amount",
      kind: "minor-unit",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "creditDays",
      label: "Credit Days",
      kind: "integer",
      required: true,
      immutableAfter: "POSTED",
    },
    {
      key: "submissionAt",
      label: "Acknowledged Submission Date",
      kind: "datetime",
    },
    { key: "submissionMode", label: "Submission Mode", kind: "select" },
    { key: "submissionReference", label: "Submission Reference", kind: "text" },
    { key: "attachments", label: "Attachments", kind: "attachment" },
  ],
  transitions: [
    {
      from: ["DRAFT", "REJECTED"],
      to: "PENDING_APPROVAL",
      label: "Submit for approval",
    },
    { from: ["PENDING_APPROVAL"], to: "APPROVED", label: "Approve" },
    {
      from: ["PENDING_APPROVAL"],
      to: "REJECTED",
      label: "Reject",
      reasonRequired: true,
    },
    { from: ["APPROVED"], to: "POSTED", label: "Post" },
    {
      from: ["POSTED"],
      to: "SUBMITTED",
      label: "Record client acknowledgement",
    },
    {
      from: ["POSTED", "SUBMITTED"],
      to: "REVERSED",
      label: "Reverse",
      reasonRequired: true,
    },
  ],
  queues: [
    "unbilled-services",
    "drafts",
    "approval",
    "posted-unsubmitted",
    "accounting-export-failures",
  ],
  reports: [
    "billing-register",
    "unbilled",
    "tax-summary",
    "billing-leakage",
    "rate-variance",
    "profitability",
  ],
} as const satisfies FinanceManifest;

export const receiptManifest = {
  feature: "FIN-02",
  module: "finance",
  resource: "receipts",
  title: "Receipts and collections",
  initialStatus: "UNRECONCILED",
  statuses: ["UNRECONCILED", "PENDING_APPROVAL", "RECONCILED", "REVERSED"],
  fields: [
    { key: "receiptRef", label: "Receipt Ref", kind: "text", required: true },
    { key: "clientId", label: "Client", kind: "reference", required: true },
    { key: "paymentDate", label: "Payment Date", kind: "date", required: true },
    {
      key: "amountMinor",
      label: "Amount Received",
      kind: "minor-unit",
      required: true,
    },
    { key: "mode", label: "Mode", kind: "select", required: true },
    {
      key: "instrumentNo",
      label: "UTR / Instrument No",
      kind: "text",
      required: true,
    },
    {
      key: "bankAccountId",
      label: "Bank Account",
      kind: "reference",
      required: true,
    },
    { key: "source", label: "Source", kind: "select", required: true },
    {
      key: "allocations",
      label: "Invoice Allocations / Deductions",
      kind: "money-lines",
    },
    { key: "attachment", label: "Attachment", kind: "attachment" },
  ],
  transitions: [
    {
      from: ["UNRECONCILED"],
      to: "PENDING_APPROVAL",
      label: "Submit reconciliation",
    },
    {
      from: ["PENDING_APPROVAL"],
      to: "RECONCILED",
      label: "Approve reconciliation",
    },
    {
      from: ["RECONCILED"],
      to: "REVERSED",
      label: "Reverse with compensating entry",
      reasonRequired: true,
    },
  ],
  queues: [
    "unallocated-receipts",
    "collection-priority",
    "broken-promises",
    "deductions",
    "no-follow-up",
  ],
  reports: [
    "receipt-register",
    "invoice-balances",
    "ageing",
    "soa",
    "promise-to-pay",
    "follow-up-productivity",
  ],
} as const satisfies FinanceManifest;

export const vendorBillManifest = {
  feature: "FIN-03",
  module: "finance",
  resource: "vendor-bills",
  title: "Vendor bills and payments",
  initialStatus: "DRAFT",
  statuses: [
    "DRAFT",
    "VALIDATION_EXCEPTION",
    "PENDING_OPERATIONAL_VERIFICATION",
    "PENDING_FINANCE_APPROVAL",
    "APPROVED",
    "PART_PAID",
    "PAID",
    "DISPUTED",
    "REVERSED",
  ],
  fields: [
    {
      key: "vendorInvoiceNo",
      label: "Vendor Invoice / Reference",
      kind: "text",
      required: true,
    },
    { key: "vendorId", label: "Vendor", kind: "reference", required: true },
    { key: "invoiceDate", label: "Invoice Date", kind: "date", required: true },
    {
      key: "servicePeriod",
      label: "Service Period",
      kind: "date-range",
      required: true,
    },
    {
      key: "tripIds",
      label: "Trips / LRs",
      kind: "references",
      required: true,
    },
    {
      key: "lines",
      label: "Taxable Lines",
      kind: "money-lines",
      required: true,
    },
    { key: "gstMinor", label: "GST", kind: "minor-unit", required: true },
    { key: "tdsMinor", label: "TDS", kind: "minor-unit", required: true },
    { key: "advanceMinor", label: "Advances", kind: "minor-unit" },
    { key: "deductionMinor", label: "Deductions", kind: "minor-unit" },
    {
      key: "payableMinor",
      label: "Payable Total",
      kind: "minor-unit",
      required: true,
    },
    {
      key: "bankAccountId",
      label: "Verified Bank Account",
      kind: "reference",
      required: true,
    },
    {
      key: "attachment",
      label: "Vendor Bill",
      kind: "attachment",
      required: true,
    },
  ],
  transitions: [
    {
      from: ["DRAFT", "VALIDATION_EXCEPTION"],
      to: "PENDING_OPERATIONAL_VERIFICATION",
      label: "Submit",
    },
    {
      from: ["PENDING_OPERATIONAL_VERIFICATION"],
      to: "PENDING_FINANCE_APPROVAL",
      label: "Verify operations",
    },
    {
      from: ["PENDING_FINANCE_APPROVAL"],
      to: "APPROVED",
      label: "Approve finance",
    },
    {
      from: ["PENDING_OPERATIONAL_VERIFICATION", "PENDING_FINANCE_APPROVAL"],
      to: "DISPUTED",
      label: "Dispute",
      reasonRequired: true,
    },
    { from: ["APPROVED"], to: "PART_PAID", label: "Record partial payment" },
    {
      from: ["APPROVED", "PART_PAID"],
      to: "PAID",
      label: "Record full payment",
    },
    {
      from: ["PART_PAID", "PAID"],
      to: "REVERSED",
      label: "Reverse payment",
      reasonRequired: true,
    },
  ],
  queues: [
    "unbilled-vendor-services",
    "validation-exceptions",
    "approval",
    "payment-run",
    "disputes",
    "failed-payments",
  ],
  reports: [
    "payable-ageing",
    "vendor-ledger",
    "deductions-disputes",
    "payment-run",
    "tds-gst",
    "contribution-margin",
  ],
} as const satisfies FinanceManifest;

export const financeManifests = [
  invoiceManifest,
  receiptManifest,
  vendorBillManifest,
] as const;
export const financeNavigation = [
  {
    feature: "FIN-01",
    label: "Client billing",
    href: "/app/finance/invoices",
    module: "finance",
  },
  {
    feature: "FIN-02",
    label: "Collections",
    href: "/app/finance/receipts",
    module: "finance",
  },
  {
    feature: "FIN-03",
    label: "Vendor payables",
    href: "/app/finance/vendor-bills",
    module: "finance",
  },
] as const;
