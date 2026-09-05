import { describe, expect, it } from "vitest";
import {
  capabilityAllowsAction,
  effectiveHome,
  evaluatePolicy,
  maskSensitive,
  portalHome,
  type PolicyInput,
} from "./index.js";

const base: PolicyInput = {
  tenantId: "tenant-a",
  userId: "user-a",
  capability: "probe.read",
  action: "READ",
  assignments: [
    {
      id: "north-reader",
      active: true,
      capabilities: ["probe.read"],
      grants: [{ nodeId: "north", action: "READ", active: true }],
    },
  ],
  resource: { tenantId: "tenant-a", nodeIds: ["north-branch"] },
  ancestorsByNode: { "north-branch": ["north", "tenant-root"] },
  identityActive: true,
  membershipActive: true,
  sessionCurrent: true,
};

describe("FND02-U-001 centralized capability evaluation", () => {
  it("allows only the canonical capability/action combination", () => {
    expect(evaluatePolicy(base)).toMatchObject({
      allowed: true,
      assignmentId: "north-reader",
    });
    expect(evaluatePolicy({ ...base, action: "EXPORT" })).toMatchObject({
      allowed: false,
      reason: "CAPABILITY_MISSING",
    });
    expect(capabilityAllowsAction("probe.export", "EXPORT")).toBe(true);
    expect(capabilityAllowsAction("probe.read", "UPDATE")).toBe(false);
  });
  it.each([
    [{ identityActive: false }, "INACTIVE"],
    [{ membershipActive: false }, "INACTIVE"],
    [{ sessionCurrent: false }, "SESSION_STALE"],
    [{ mfaRequired: true, mfaSatisfied: false }, "MFA_REQUIRED"],
    [{ policyBlocked: true }, "POLICY_BLOCKED"],
  ] as const)("system block %# denies", (change, reason) => {
    expect(evaluatePolicy({ ...base, ...change })).toMatchObject({
      allowed: false,
      reason,
    });
  });
});

describe("FND02-U-002 typed hierarchy and same-assignment boundary", () => {
  it("matches exact and descendant scopes but not siblings or other tenants", () => {
    expect(evaluatePolicy(base).allowed).toBe(true);
    expect(
      evaluatePolicy({
        ...base,
        resource: { tenantId: "tenant-a", nodeIds: ["south"] },
        ancestorsByNode: { south: ["tenant-root"] },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy({
        ...base,
        resource: { tenantId: "tenant-b", nodeIds: ["north"] },
      }).allowed,
    ).toBe(false);
  });
  it("does not cross-combine a capability and scope from different roles", () => {
    const split = {
      ...base,
      assignments: [
        {
          id: "cap",
          active: true,
          capabilities: ["probe.read"],
          grants: [{ nodeId: "south", action: "READ" as const, active: true }],
        },
        {
          id: "scope",
          active: true,
          capabilities: ["probe.update"],
          grants: [{ nodeId: "north", action: "READ" as const, active: true }],
        },
      ],
    };
    expect(evaluatePolicy(split)).toMatchObject({
      allowed: false,
      reason: "SCOPE_MISMATCH",
    });
  });
  it("uses half-open grant expiry", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    expect(
      evaluatePolicy({
        ...base,
        now,
        assignments: [
          {
            ...base.assignments[0]!,
            grants: [
              { nodeId: "north", action: "READ", active: true, expiresAt: now },
            ],
          },
        ],
      }).allowed,
    ).toBe(false);
  });
});

describe("FND02-U-003/FND02-U-004 actor boundaries", () => {
  it("limits regional and client actors to configured hierarchy", () => {
    expect(evaluatePolicy(base).allowed).toBe(true);
    expect(
      evaluatePolicy({
        ...base,
        resource: { tenantId: "tenant-a", nodeIds: ["beta"] },
        ancestorsByNode: { beta: ["south"] },
      }).allowed,
    ).toBe(false);
  });
  it("requires the current server-resolved assigned driver", () => {
    const tripBase = {
      ...base,
      assignments: [
        {
          ...base.assignments[0]!,
          grants: [
            {
              nodeId: "north",
              scopeType: "ASSIGNED_TRIP" as const,
              action: "READ" as const,
              active: true,
            },
          ],
        },
      ],
    };
    expect(
      evaluatePolicy({
        ...tripBase,
        resource: {
          ...base.resource,
          requiresCurrentAssignment: true,
          assignedUserId: "user-a",
        },
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy({
        ...tripBase,
        resource: { ...base.resource, requiresCurrentAssignment: true },
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_MISMATCH" });
    expect(
      evaluatePolicy({
        ...tripBase,
        resource: {
          ...base.resource,
          requiresCurrentAssignment: true,
          assignedUserId: "other-driver",
        },
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_MISMATCH" });
    expect(
      evaluatePolicy({
        ...base,
        resource: { ...base.resource, assignedUserId: "other-user" },
      }).allowed,
    ).toBe(true);
  });
});

describe("FND02-U-005 sensitive serialization", () => {
  it("returns stable non-reconstructable masks and nulls", () => {
    expect(maskSensitive("tax_identifier", "ABCDE1234F", false)).toEqual({
      value: "••••234F",
      masked: true,
    });
    expect(maskSensitive("bank_detail", "1234567890", false)).toEqual({
      value: "••••7890",
      masked: true,
    });
    expect(maskSensitive("mobile", "+919876543210", false)).toEqual({
      value: "+91 ••••••10",
      masked: true,
    });
    expect(maskSensitive("commercial_rate", 12345, false)).toEqual({
      value: null,
      masked: true,
    });
    expect(maskSensitive("payment", 54321, true)).toEqual({
      value: 54321,
      masked: false,
    });
  });
});

describe("FND02-U-006/FND02-U-008 preview and home", () => {
  it("is deterministic for identical policy input", () =>
    expect(evaluatePolicy(base)).toEqual(evaluatePolicy(base)));
  it.each([
    ["INTERNAL", "/app/control"],
    ["VENDOR", "/portal/vendor"],
    ["DRIVER", "/portal/driver"],
    ["CLIENT", "/portal/client"],
  ] as const)("resolves %s without role-name checks", (audience, home) =>
    expect(portalHome(audience)).toBe(home),
  );

  it.each([
    [["control.dashboard.read"], "/app/control"],
    [["operations.read"], "/app/operations"],
    [["finance.read"], "/app/finance"],
    [["identity.user.read"], "/app/access/users"],
    [["governance.read"], "/app/governance/policies"],
    [["configuration.read"], "/app/configuration/settings"],
    [["probe.read"], "/app/setup"],
    [["operations.admin"], "/app/no-access"],
    [[], "/app/no-access"],
  ] as const)(
    "selects the first permitted INTERNAL home",
    (capabilities, home) =>
      expect(effectiveHome("INTERNAL", capabilities)).toBe(home),
  );

  it("keeps external audiences in their dedicated portals", () => {
    expect(effectiveHome("VENDOR", ["control.dashboard.read"])).toBe(
      "/portal/vendor",
    );
  });
});
