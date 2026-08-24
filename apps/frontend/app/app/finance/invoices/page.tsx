import { TransactionWorkspace } from "../../operations/_components/transaction-workspace";

export default function InvoicesPage() {
  return (
    <TransactionWorkspace
      feature="FIN-01"
      module="finance"
      resource="invoices"
      title="Client invoices"
      description="Unbilled eligibility, exact charges and tax, maker-checker approval, posting, and acknowledgement."
      fields={[
        {
          key: "invoiceDate",
          label: "Invoice date",
          kind: "date",
          required: true,
        },
        { key: "clientCode", label: "Client", required: true },
        { key: "locationCode", label: "Location", required: true },
        { key: "billingMonth", label: "Billing month", required: true },
        { key: "tripLrRefs", label: "Trips / LRs", required: true },
        {
          key: "taxableMinor",
          label: "Taxable value (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "taxMinor",
          label: "GST / tax (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "totalMinor",
          label: "Total (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "creditDays",
          label: "Credit days",
          kind: "number",
          required: true,
        },
        {
          key: "submissionAt",
          label: "Acknowledged submission",
          kind: "datetime-local",
        },
        { key: "submissionReference", label: "Submission reference" },
        { key: "notes", label: "Notes", kind: "textarea" },
      ]}
      queues={[
        "Unbilled services",
        "Drafts",
        "Approval",
        "Posted not submitted",
      ]}
      reports={[
        "Billing register",
        "Tax summary",
        "Billing leakage",
        "Rate variance",
        "Profitability",
      ]}
    />
  );
}
