import type { IntelligenceModuleManifest } from "../control/module-contract.js";

export const alertsManifest: IntelligenceModuleManifest = {
  code: "ALT-01",
  name: "Alerts, escalation and work queues",
  capabilityPrefix: "alerts",
  navigation: { label: "Alerts", href: "/app/alerts" },
  entities: [
    {
      code: "alert_rule",
      label: "Alert rule",
      fields: [
        "sourceModule",
        "eventType",
        "metricCode",
        "threshold",
        "severity",
        "recipientPolicy",
        "channels",
        "quietHours",
        "repeatPolicy",
        "escalationLevels",
        "resolutionCondition",
      ],
      states: ["ACTIVE", "INACTIVE"],
    },
    {
      code: "alert",
      label: "Alert",
      fields: ["type", "severity", "record", "owner", "dueAt", "evidence"],
      states: ["OPEN", "ACKNOWLEDGED", "SNOOZED", "ESCALATED", "RESOLVED"],
    },
  ],
  reports: [
    {
      code: "open-alerts",
      label: "Open alerts",
      drillBy: ["severity", "owner", "sourceModule", "alertType"],
    },
    {
      code: "alert-performance",
      label: "Acknowledgement and resolution",
      drillBy: ["owner", "alertType"],
    },
    {
      code: "repeat-breaches",
      label: "Repeat breaches",
      drillBy: ["sourceModule", "record"],
    },
    {
      code: "delivery-failures",
      label: "Alert delivery failures",
      drillBy: ["channel", "state"],
    },
  ],
};

export const baselineAlertTypes = [
  "INDENT_UNOWNED",
  "PLACEMENT_PRE_BREACH",
  "PLACEMENT_YELLOW",
  "PLACEMENT_RED",
  "NTP_UNRESOLVED",
  "TRIP_MILESTONE_LATE",
  "ROUTE_DEVIATION",
  "GPS_SILENT",
  "SHORTAGE_DAMAGE",
  "POD_YELLOW",
  "POD_RED",
  "POD_PRIOR_PERIOD",
  "POD_REJECTED",
  "INVOICE_UNBILLED",
  "COLLECTION_YELLOW",
  "COLLECTION_RED",
  "PROMISE_BROKEN",
  "VENDOR_BILL_MISSING",
  "PAYABLE_OVERDUE",
  "PAYMENT_BLOCKED",
  "PAYMENT_FAILED",
  "MASTER_EXPIRY",
  "IMPORT_FAILED",
  "INTEGRATION_FAILED",
  "PRIVILEGED_SECURITY_EVENT",
] as const;
