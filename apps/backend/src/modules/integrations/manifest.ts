import type { IntelligenceModuleManifest } from "../control/module-contract.js";

export const integrationsManifest: IntelligenceModuleManifest = {
  code: "INT-01",
  name: "Integrations and delivery health",
  capabilityPrefix: "integrations",
  navigation: { label: "Integrations", href: "/app/integrations" },
  entities: [
    {
      code: "integration_endpoint",
      label: "Integration",
      fields: [
        "type",
        "name",
        "environment",
        "endpoint",
        "credentialReference",
        "scopes",
        "allowedEvents",
        "mappingVersion",
        "rateLimit",
        "retryPolicy",
      ],
      states: ["ACTIVE", "PAUSED", "ERROR", "INACTIVE"],
    },
    {
      code: "delivery",
      label: "Delivery",
      fields: [
        "direction",
        "eventId",
        "eventType",
        "mappingVersion",
        "payloadHash",
        "correlationId",
      ],
      states: ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "DEAD_LETTER"],
    },
  ],
  reports: [
    {
      code: "integration-health",
      label: "Integration health",
      drillBy: ["type", "state", "endpoint"],
    },
    {
      code: "delivery-log",
      label: "Deliveries",
      drillBy: ["endpoint", "eventType", "state"],
    },
    {
      code: "dead-letters",
      label: "Dead letters",
      drillBy: ["endpoint", "reasonCode"],
    },
    {
      code: "mapping-reconciliation",
      label: "Mapping and reconciliation",
      drillBy: ["endpoint", "mappingVersion"],
    },
  ],
};

export const integrationTypes = [
  "API",
  "WEBHOOK",
  "NOTIFICATION",
  "GPS",
  "ACCOUNTING",
  "MIGRATION",
] as const;
