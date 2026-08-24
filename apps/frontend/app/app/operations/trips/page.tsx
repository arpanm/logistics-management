import { TransactionWorkspace } from "../_components/transaction-workspace";

export default function TripsPage() {
  return (
    <TransactionWorkspace
      feature="OPS-03"
      module="operations"
      resource="trips"
      title="Trips"
      description="Mobile-first milestone, evidence, ETA, exception, and offline-sync workflow."
      fields={[
        { key: "allocationCode", label: "Placement", required: true },
        { key: "lrNo", label: "LR no" },
        { key: "vehicleNo", label: "Vehicle", required: true },
        { key: "driverCode", label: "Driver", required: true },
        {
          key: "eventType",
          label: "Milestone event",
          kind: "select",
          options: [
            "GATE_IN",
            "LOADING_START",
            "LOADING_END",
            "DEPARTURE",
            "CHECKPOINT",
            "DESTINATION_ARRIVAL",
            "UNLOADING_START",
            "DELIVERY_COMPLETED",
            "EXCEPTION",
          ],
          required: true,
        },
        {
          key: "eventAt",
          label: "Original event time",
          kind: "datetime-local",
          required: true,
        },
        {
          key: "quantityMilliTonnes",
          label: "Quantity (milli-tonnes)",
          kind: "number",
        },
        { key: "documentRefs", label: "LR / challan / e-way bill / seal" },
        {
          key: "exceptionNotes",
          label: "Shortage, damage, detention, or exception",
          kind: "textarea",
        },
      ]}
      queues={["Live trips", "Assigned field actions", "Offline conflicts"]}
      reports={[
        "Milestones and ETA",
        "Turnaround and transit TAT",
        "Route/stoppage exceptions",
        "Field completeness",
      ]}
    />
  );
}
