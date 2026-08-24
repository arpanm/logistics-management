import { TransactionWorkspace } from "../../operations/_components/transaction-workspace";

export default function ReceiptsPage() {
  return (
    <TransactionWorkspace
      feature="FIN-02"
      module="finance"
      resource="receipts"
      title="Receipts and collections"
      description="Append-only allocation/reversal ledger, reconciliation, follow-up, ageing, and SOA."
      fields={[
        { key: "clientCode", label: "Client", required: true },
        {
          key: "paymentDate",
          label: "Payment date",
          kind: "date",
          required: true,
        },
        {
          key: "amountMinor",
          label: "Amount received (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "mode",
          label: "Mode",
          kind: "select",
          options: ["NEFT", "RTGS", "IMPS", "CHEQUE", "UPI", "ADJUSTMENT"],
          required: true,
        },
        { key: "instrumentNo", label: "UTR / instrument no", required: true },
        { key: "bankAccount", label: "Bank account", required: true },
        {
          key: "invoiceAllocations",
          label: "Invoice allocations, deductions, and references",
          kind: "textarea",
        },
        {
          key: "followUpAt",
          label: "Follow-up date/time",
          kind: "datetime-local",
        },
        {
          key: "promiseToPay",
          label: "Promise to pay / next action",
          kind: "textarea",
        },
      ]}
      queues={[
        "Unallocated receipts",
        "Collection priority",
        "Broken promises",
        "Deductions",
        "No follow-up",
      ]}
      reports={[
        "Receipt register",
        "Invoice balances",
        "Ageing buckets",
        "SOA",
        "Follow-up productivity",
      ]}
    />
  );
}
