import type { SessionActor } from "@logistics/auth";

export type IntelligenceModuleManifest = {
  code: "CTL-01" | "ALT-01" | "DAT-01" | "INT-01";
  name: string;
  capabilityPrefix: string;
  navigation: { label: string; href: string };
  entities: ReadonlyArray<{
    code: string;
    label: string;
    fields: readonly string[];
    states?: readonly string[];
  }>;
  reports: ReadonlyArray<{
    code: string;
    label: string;
    drillBy: readonly string[];
  }>;
};

export type TenantActor = SessionActor & { membershipId?: string | null };

export function tenantId(actor: TenantActor): string {
  if (!actor.activeTenantId) throw new Error("Active tenant required");
  return actor.activeTenantId;
}
