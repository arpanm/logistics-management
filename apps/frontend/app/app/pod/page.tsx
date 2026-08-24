import { TransactionWorkspace } from "../operations/_components/transaction-workspace";

export default function PodPage() {
  return (
    <TransactionWorkspace
      feature="DOC-01"
      module="pod"
      resource="proofs"
      title="Proof of delivery"
      description="Receipt, review, correction, client submission, and POD ageing."
      fields={[
        { key: "lrNo", label: "LR no", required: true },
        { key: "indentNo", label: "Indent no", required: true },
        { key: "clientCode", label: "Client code", required: true },
        { key: "locationCode", label: "Location code", required: true },
        { key: "invoiceNos", label: "Invoice no(s)" },
        { key: "vehicleNo", label: "Vehicle no", required: true },
        {
          key: "loadingDate",
          label: "Loading date",
          kind: "date",
          required: true,
        },
        {
          key: "deliveryDate",
          label: "Delivery date",
          kind: "date",
          required: true,
        },
        { key: "receivedDate", label: "POD received date", kind: "date" },
        {
          key: "mode",
          label: "POD mode",
          kind: "select",
          options: ["PHYSICAL", "DIGITAL", "OTP", "SIGNATURE"],
          required: true,
        },
        { key: "receiverName", label: "Receiver name" },
        {
          key: "shortageDamageRemarks",
          label: "Shortage / damage remarks",
          kind: "textarea",
        },
        {
          key: "submissionReference",
          label: "Client acknowledgement / reference",
        },
      ]}
      queues={[
        "Awaiting POD",
        "Under review",
        "Correction required",
        "Prior-period",
        "Received not submitted",
      ]}
      reports={[
        "POD register",
        "Ageing and carryover",
        "Value at risk",
        "Closure rate",
        "Rejected/corrections",
      ]}
    />
  );
}
