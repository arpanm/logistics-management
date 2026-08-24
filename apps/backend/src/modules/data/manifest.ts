import type { IntelligenceModuleManifest } from "../control/module-contract.js";

export const dataManifest: IntelligenceModuleManifest = {
  code: "DAT-01",
  name: "Bulk import, correction and export",
  capabilityPrefix: "data",
  navigation: { label: "Data imports", href: "/app/data" },
  entities: [
    {
      code: "import_job",
      label: "Import job",
      fields: [
        "dataset",
        "filename",
        "checksum",
        "sourceTimezone",
        "importMode",
        "headerMap",
        "summary",
      ],
      states: [
        "UPLOADED",
        "MAPPED",
        "VALIDATED",
        "COMMIT_QUEUED",
        "COMMITTED",
        "FAILED",
        "CORRECTED",
      ],
    },
  ],
  reports: [
    {
      code: "import-history",
      label: "Import history",
      drillBy: ["dataset", "state", "uploader"],
    },
    {
      code: "import-errors",
      label: "Row errors",
      drillBy: ["dataset", "job", "row", "column"],
    },
    {
      code: "source-freshness",
      label: "Source freshness",
      drillBy: ["dataset", "state"],
    },
    {
      code: "import-reconciliation",
      label: "Import reconciliation",
      drillBy: ["dataset", "disposition"],
    },
  ],
};

export const importProfiles = {
  CLIENT: ["Client Code", "Client Name", "Account Manager", "Credit Days"],
  LOCATION: [
    "Client Code",
    "Location Code",
    "Location Name",
    "Committed Placement TAT (Hrs)",
  ],
  VENDOR: [
    "Vendor Code",
    "Vendor Name",
    "Contact 1",
    "Onboarded By (Emp Code)",
    "Onboarding Date",
  ],
  INDENT_PLACEMENT: [
    "Indent No",
    "Indent Date & Time",
    "Client Code",
    "Location Code",
    "Origin",
    "Destination",
    "Truck Type",
    "Committed Placement Date & Time",
    "Placement Status",
  ],
  POD: [
    "LR No",
    "Client Code",
    "Location Code",
    "Invoice No",
    "Vehicle No",
    "Loading Date",
    "Delivery Date",
  ],
  INVOICE_COLLECTION: [
    "Invoice No",
    "Invoice Date",
    "Client Code",
    "Location Code",
    "Total Invoice Amount",
  ],
  PAYMENT_RECEIPT: [
    "Receipt Ref",
    "Client Code",
    "Payment Date",
    "Amount Received",
    "Payment Mode",
  ],
} as const;
