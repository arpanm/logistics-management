import { TransactionWorkspace } from "../../operations/_components/transaction-workspace";

export default function VendorBillsPage() {
  return (
    <TransactionWorkspace
      feature="FIN-03"
      module="finance"
      resource="vendor-bills"
      title="Vendor bills and payments"
      description="Trip-backed validation, segregated approval, verified-bank payments, remittance, and margin."
      fields={[
        { key: "vendorCode", label: "Vendor", required: true },
        {
          key: "invoiceDate",
          label: "Invoice date",
          kind: "date",
          required: true,
        },
        { key: "servicePeriod", label: "Service period", required: true },
        { key: "tripLrRefs", label: "Trips / LRs", required: true },
        {
          key: "taxableMinor",
          label: "Taxable value (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "gstMinor",
          label: "GST (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "tdsMinor",
          label: "TDS (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "deductionsMinor",
          label: "Deductions (minor units)",
          kind: "number",
        },
        {
          key: "advancesMinor",
          label: "Advances (minor units)",
          kind: "number",
        },
        {
          key: "payableMinor",
          label: "Payable total (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "verifiedBankAccount",
          label: "Verified bank account",
          required: true,
        },
        {
          key: "varianceReason",
          label: "Three-way variance / dispute reason",
          kind: "textarea",
        },
      ]}
      queues={[
        "Unbilled vendor services",
        "Validation exceptions",
        "Approvals",
        "Payment run",
        "Disputes",
      ]}
      reports={[
        "Payable ageing",
        "Vendor ledger",
        "Deductions/disputes",
        "Payment run",
        "TDS/GST",
        "Contribution margin",
      ]}
    />
  );
}
