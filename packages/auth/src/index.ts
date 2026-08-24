export const CAPABILITY = {
  platformAdmin: "platform:admin",
  tenantOwner: "tenant:owner",
} as const;
export type SessionActor = {
  userId: string;
  email: string;
  platformAdmin: boolean;
  activeTenantId: string | null;
  contextVersion: number;
  csrfToken: string;
};
export function requirePlatform(actor: SessionActor): void {
  if (!actor.platformAdmin) throw new Error("FORBIDDEN");
}
export function requireTenant(actor: SessionActor): string {
  if (!actor.activeTenantId) throw new Error("TENANT_CONTEXT_REQUIRED");
  return actor.activeTenantId;
}
