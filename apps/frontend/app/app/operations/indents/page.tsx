import { TransactionWorkspace } from "../_components/transaction-workspace";

export default function IndentsPage() {
  return (
    <TransactionWorkspace
      feature="OPS-01"
      module="operations"
      resource="indents"
      title="Indents"
      description="Traceable, owned and SLA-bound customer vehicle demand."
      fields={[
        {
          key: "indentAt",
          label: "Indent date and time",
          kind: "datetime-local",
          required: true,
        },
        { key: "clientCode", label: "Client code", required: true },
        { key: "locationCode", label: "Location code", required: true },
        { key: "origin", label: "Origin", required: true },
        { key: "destination", label: "Destination", required: true },
        { key: "truckType", label: "Truck type", required: true },
        {
          key: "requestedVehicles",
          label: "Requested vehicles",
          kind: "number",
          required: true,
        },
        {
          key: "weightMilliTonnes",
          label: "Weight (milli-tonnes)",
          kind: "number",
        },
        {
          key: "pickupWindowStart",
          label: "Pickup window start",
          kind: "datetime-local",
          required: true,
        },
        {
          key: "committedPlacementAt",
          label: "Committed placement",
          kind: "datetime-local",
          required: true,
        },
        {
          key: "instructions",
          label: "Special instructions",
          kind: "textarea",
        },
      ]}
      queues={[
        "Open and unassigned",
        "Approaching commitment",
        "SLA overrides",
      ]}
      reports={[
        "Indent register",
        "Demand analysis",
        "Cancellations",
        "Source completeness",
      ]}
    />
  );
}
