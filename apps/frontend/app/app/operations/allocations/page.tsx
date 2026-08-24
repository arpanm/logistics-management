import { TransactionWorkspace } from "../_components/transaction-workspace";

export default function AllocationsPage() {
  return (
    <TransactionWorkspace
      feature="OPS-02"
      module="operations"
      resource="allocations"
      title="Vendor allocations"
      description="Risk-ordered vendor offers, eligible assignments, and placement confirmation."
      fields={[
        { key: "indentCode", label: "Indent", required: true },
        { key: "vendorCode", label: "Eligible vendor", required: true },
        {
          key: "allottedVehicles",
          label: "Allotted vehicles",
          kind: "number",
          required: true,
        },
        {
          key: "offeredRateMinor",
          label: "Offered rate (minor units)",
          kind: "number",
          required: true,
        },
        {
          key: "offerChannel",
          label: "Offer channel",
          kind: "select",
          options: ["PORTAL", "PHONE_VERIFIED", "EMAIL", "WHATSAPP_VERIFIED"],
          required: true,
        },
        { key: "vehicleNo", label: "Eligible vehicle" },
        { key: "driverCode", label: "Eligible driver" },
        {
          key: "placementStatus",
          label: "Placement status",
          kind: "select",
          options: ["AWAITED", "PLACED", "NTP", "CANCELLED"],
          required: true,
        },
        {
          key: "actualReportingAt",
          label: "Actual reporting time",
          kind: "datetime-local",
        },
        { key: "delayReason", label: "NTP / delay reason", kind: "textarea" },
      ]}
      queues={["Commitment risk", "Vendor responses", "Unresolved NTP"]}
      reports={[
        "Client/location fill",
        "Vendor allocation cards",
        "Replacement history",
        "Delay reason Pareto",
      ]}
    />
  );
}
