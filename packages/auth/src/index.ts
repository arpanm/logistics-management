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
  membershipId?: string | null;
  userAuthVersion?: number;
  membershipAuthVersion?: number | null;
  assuranceLevel?: "PASSWORD" | "MFA" | "RESTRICTED_MFA";
};

export const SCOPE_ACTIONS = [
  "READ",
  "CREATE",
  "UPDATE",
  "APPROVE",
  "EXPORT",
  "ADMIN",
] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];
export const SCOPE_TYPES = [
  "TENANT",
  "LEGAL_ENTITY",
  "REGION",
  "BRANCH",
  "CLIENT",
  "LOCATION",
  "VENDOR",
  "ASSIGNED_TRIP",
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export type PolicyGrant = {
  nodeId: string;
  scopeType?: ScopeType;
  action: ScopeAction;
  active: boolean;
  expiresAt?: Date | null;
};
export type PolicyAssignment = {
  id: string;
  active: boolean;
  capabilities: readonly string[];
  grants: readonly PolicyGrant[];
};
export type ResourceDescriptor = {
  tenantId: string;
  nodeIds: readonly string[];
  assignedUserId?: string | null;
  requiresCurrentAssignment?: boolean;
  state?: string;
};
const CAPABILITY_ACTIONS: Readonly<Record<string, readonly ScopeAction[]>> = {
  "identity.user.read": ["READ"],
  "identity.user.admin": ["ADMIN"],
  "identity.role.read": ["READ"],
  "identity.role.admin": ["ADMIN"],
  "identity.session.admin": ["ADMIN"],
  "identity.mfa.admin": ["ADMIN"],
  "identity.report.read": ["READ"],
  "identity.audit.read": ["READ"],
  "probe.read": ["READ"],
  "probe.create": ["CREATE"],
  "probe.update": ["UPDATE"],
  "probe.approve": ["APPROVE"],
  "probe.export": ["EXPORT"],
};
export function capabilityAllowsAction(
  capability: string,
  action: ScopeAction,
): boolean {
  if (capability.startsWith("sensitive.") && capability.endsWith(".read"))
    return action === "READ";
  return (CAPABILITY_ACTIONS[capability] ?? []).includes(action);
}
export type PolicyInput = {
  tenantId: string;
  userId: string;
  capability: string;
  action: ScopeAction;
  assignments: readonly PolicyAssignment[];
  resource: ResourceDescriptor;
  ancestorsByNode: Readonly<Record<string, readonly string[]>>;
  identityActive: boolean;
  membershipActive: boolean;
  sessionCurrent: boolean;
  mfaRequired?: boolean;
  mfaSatisfied?: boolean;
  policyBlocked?: boolean;
  now?: Date;
};
export type PolicyDecision = {
  allowed: boolean;
  reason:
    | "ALLOWED"
    | "INACTIVE"
    | "SESSION_STALE"
    | "MFA_REQUIRED"
    | "POLICY_BLOCKED"
    | "CAPABILITY_MISSING"
    | "SCOPE_MISMATCH";
  assignmentId?: string;
  grantNodeId?: string;
};

const actionMatches = (granted: ScopeAction, requested: ScopeAction) =>
  granted === requested || granted === "ADMIN";

/** Pure deny-by-default policy oracle used by both preview and enforcement. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (!input.identityActive || !input.membershipActive)
    return { allowed: false, reason: "INACTIVE" };
  if (!input.sessionCurrent) return { allowed: false, reason: "SESSION_STALE" };
  if (input.mfaRequired && !input.mfaSatisfied)
    return { allowed: false, reason: "MFA_REQUIRED" };
  if (input.policyBlocked) return { allowed: false, reason: "POLICY_BLOCKED" };
  if (input.resource.tenantId !== input.tenantId)
    return { allowed: false, reason: "SCOPE_MISMATCH" };
  if (!capabilityAllowsAction(input.capability, input.action))
    return { allowed: false, reason: "CAPABILITY_MISSING" };
  let capabilityFound = false;
  const now = input.now ?? new Date();
  for (const assignment of input.assignments) {
    if (
      !assignment.active ||
      !assignment.capabilities.includes(input.capability)
    )
      continue;
    capabilityFound = true;
    for (const grant of assignment.grants) {
      if (
        !grant.active ||
        (grant.expiresAt && grant.expiresAt <= now) ||
        !actionMatches(grant.action, input.action)
      )
        continue;
      const matches = input.resource.nodeIds.some(
        (nodeId) =>
          nodeId === grant.nodeId ||
          (input.ancestorsByNode[nodeId] ?? []).includes(grant.nodeId),
      );
      if (matches)
        if (
          grant.scopeType === "ASSIGNED_TRIP" &&
          input.resource.requiresCurrentAssignment &&
          (!input.resource.assignedUserId ||
            input.resource.assignedUserId !== input.userId)
        )
          continue;
      if (matches)
        return {
          allowed: true,
          reason: "ALLOWED",
          assignmentId: assignment.id,
          grantNodeId: grant.nodeId,
        };
    }
  }
  return {
    allowed: false,
    reason: capabilityFound ? "SCOPE_MISMATCH" : "CAPABILITY_MISSING",
  };
}

export type SensitiveClass =
  | "tax_identifier"
  | "mobile"
  | "bank_detail"
  | "commercial_rate"
  | "payment"
  | "internal_margin";
export function maskSensitive(
  kind: SensitiveClass,
  value: string | number | null,
  allowed: boolean,
): { value: string | number | null; masked: boolean } {
  if (allowed) return { value, masked: false };
  if (value === null) return { value: null, masked: true };
  const text = String(value);
  if (kind === "tax_identifier" || kind === "bank_detail")
    return { value: `••••${text.slice(-4)}`, masked: true };
  if (kind === "mobile") {
    const digits = text.replace(/^\+/, "");
    const oneDigitCountries = new Set(["1", "7"]);
    const threeDigitCountries = new Set([
      "211",
      "212",
      "213",
      "216",
      "218",
      "220",
      "221",
      "222",
      "223",
      "224",
      "225",
      "226",
      "227",
      "228",
      "229",
      "230",
      "231",
      "232",
      "233",
      "234",
      "235",
      "236",
      "237",
      "238",
      "239",
      "240",
      "241",
      "242",
      "243",
      "244",
      "245",
      "246",
      "248",
      "249",
      "250",
      "251",
      "252",
      "253",
      "254",
      "255",
      "256",
      "257",
      "258",
      "260",
      "261",
      "262",
      "263",
      "264",
      "265",
      "266",
      "267",
      "268",
      "269",
    ]);
    const countryLength = oneDigitCountries.has(digits[0]!)
      ? 1
      : threeDigitCountries.has(digits.slice(0, 3))
        ? 3
        : 2;
    const country = digits.slice(0, countryLength);
    return { value: `+${country} ••••••${text.slice(-2)}`, masked: true };
  }
  return { value: null, masked: true };
}

export function portalHome(
  audience: "INTERNAL" | "VENDOR" | "DRIVER" | "CLIENT",
): string {
  return audience === "INTERNAL" ? "/app" : `/portal/${audience.toLowerCase()}`;
}
export function requirePlatform(actor: SessionActor): void {
  if (!actor.platformAdmin) throw new Error("FORBIDDEN");
}
export function requireTenant(actor: SessionActor): string {
  if (!actor.activeTenantId) throw new Error("TENANT_CONTEXT_REQUIRED");
  return actor.activeTenantId;
}
