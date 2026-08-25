import { describe, expect, it } from "vitest";
import {
  employeeMasterCreateSchema,
  geofenceSchema,
  organizationMasterCreateSchema,
  organizationParentAllowed,
} from "./canonical.js";

describe("MST01 hierarchy and structured geography", () => {
  const organization = {
    code: "NORTH-01",
    name: "North Region",
    nodeType: "REGION" as const,
    parentId: "10000000-0000-4000-8000-000000000001",
    timezone: "Asia/Kolkata",
    activeFrom: "2026-08-25",
  };
  it.each([
    ["REGION", "LEGAL_ENTITY"],
    ["BRANCH", "REGION"],
    ["TEAM", "BRANCH"],
    ["TEAM", "HUB"],
    ["HUB", "REGION"],
    ["HUB", "BRANCH"],
  ])("allows %s below %s", (child, parent) => {
    expect(organizationParentAllowed(child, parent)).toBe(true);
  });
  it.each([
    ["LEGAL_ENTITY", "REGION"],
    ["REGION", "BRANCH"],
    ["BRANCH", "LEGAL_ENTITY"],
    ["TEAM", "REGION"],
    ["HUB", "LEGAL_ENTITY"],
  ])("rejects %s below %s", (child, parent) => {
    expect(organizationParentAllowed(child, parent)).toBe(false);
  });
  it("requires a PIN-derived address for physical operating nodes", () => {
    expect(() =>
      organizationMasterCreateSchema.parse({
        code: "BLR",
        name: "Bengaluru",
        nodeType: "BRANCH",
        parentId: "10000000-0000-4000-8000-000000000001",
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      }),
    ).toThrow(/PIN-derived physical address/);
  });
  it.each([
    ["equal effective dates", { activeTo: "2026-08-25" }, true],
    ["reversed effective dates", { activeTo: "2026-08-24" }, false],
    ["maximum code", { code: `A${"1".repeat(39)}` }, true],
    ["overlong code", { code: `A${"1".repeat(40)}` }, false],
    ["one-character code", { code: "A" }, false],
    ["maximum name", { name: "N".repeat(160) }, true],
    ["overlong name", { name: "N".repeat(161) }, false],
    ["maximum timezone", { timezone: "T".repeat(80) }, true],
    ["overlong timezone", { timezone: "T".repeat(81) }, false],
    ["unknown field", { city: "Caller supplied" }, false],
    ["invalid calendar date", { activeFrom: "2026-02-30" }, false],
  ])("MST01-U-001 validates %s", (_case, change, valid) => {
    expect(
      organizationMasterCreateSchema.safeParse({
        ...organization,
        ...change,
      }).success,
    ).toBe(valid);
  });
  it("rejects free-text city/state and malformed PIN values", () => {
    expect(() =>
      organizationMasterCreateSchema.parse({
        code: "HUB-A",
        name: "Hub A",
        nodeType: "HUB",
        parentId: "10000000-0000-4000-8000-000000000001",
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
        address: {
          line1: "Office",
          country: "IN",
          postalCode: "50016",
          postalLocalityId: "50001600-0000-4000-8000-000000000001",
          city: "Hyderabad",
        },
      }),
    ).toThrow();
  });
  it("validates accessible geofence modes without JSON-shaped user input", () => {
    expect(
      geofenceSchema.parse({
        mode: "POINT_RADIUS",
        point: { lat: 17.443, lng: 78.462 },
        radiusKm: 5,
      }),
    ).toBeTruthy();
    expect(() =>
      geofenceSchema.parse({ mode: "POLYGON", points: [{ lat: 1, lng: 2 }] }),
    ).toThrow();
    expect(() =>
      geofenceSchema.parse({
        mode: "POLYGON",
        points: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 0, lng: 1 },
          { lat: 1, lng: 0 },
        ],
      }),
    ).toThrow(/must not intersect/);
    expect(() =>
      geofenceSchema.parse({
        mode: "POLYGON",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
          { lat: 1, lng: 0 },
          { lat: 0, lng: 0 },
        ],
      }),
    ).toThrow(/distinct/);
    expect(() =>
      geofenceSchema.parse({ mode: "DYNAMIC_RADIUS", radiusKm: 5 }),
    ).toThrow();
    expect(() =>
      geofenceSchema.parse({
        mode: "POLYGON",
        points: [
          { lat: 0, lng: 0 },
          { lat: 1, lng: 1 },
          { lat: 2, lng: 2 },
        ],
      }),
    ).toThrow(/non-zero area/);
    expect(() =>
      geofenceSchema.parse({
        mode: "POLYGON",
        points: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 2 },
          { lat: 0, lng: 1 },
          { lat: 1, lng: 0 },
        ],
      }),
    ).toThrow(/overlap/);
    expect(() =>
      organizationMasterCreateSchema.parse({
        code: "DYNAMIC",
        name: "Dynamic without address",
        nodeType: "REGION",
        parentId: "10000000-0000-4000-8000-000000000001",
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
        geofence: {
          mode: "DYNAMIC_RADIUS",
          radiusKm: 5,
          contextualAnchor: "ORGANIZATION_ADDRESS",
        },
      }),
    ).toThrow(/PIN-derived organization address/);
  });
  it.each([
    ["minimum coordinates", { lat: -90, lng: -180 }, 0.000001, true],
    ["maximum coordinates", { lat: 90, lng: 180 }, 1000, true],
    ["latitude below minimum", { lat: -90.000001, lng: 0 }, 1, false],
    ["latitude above maximum", { lat: 90.000001, lng: 0 }, 1, false],
    ["longitude below minimum", { lat: 0, lng: -180.000001 }, 1, false],
    ["longitude above maximum", { lat: 0, lng: 180.000001 }, 1, false],
    ["zero radius", { lat: 0, lng: 0 }, 0, false],
    ["negative radius", { lat: 0, lng: 0 }, -0.000001, false],
    ["radius above maximum", { lat: 0, lng: 0 }, 1000.000001, false],
  ])("MST01-U-004 validates %s", (_case, point, radiusKm, valid) => {
    expect(
      geofenceSchema.safeParse({ mode: "POINT_RADIUS", point, radiusKm })
        .success,
    ).toBe(valid);
  });
  it.each([
    [0.000001, true],
    [1000, true],
    [0, false],
    [1000.000001, false],
  ])("MST01-U-004 validates dynamic radius %s", (radiusKm, valid) => {
    expect(
      geofenceSchema.safeParse({
        mode: "DYNAMIC_RADIUS",
        radiusKm,
        contextualAnchor: "ORGANIZATION_ADDRESS",
      }).success,
    ).toBe(valid);
  });
});

describe("MST01 employee master", () => {
  const employee = {
    employeeCode: "EMP-01",
    displayName: "Employee One",
    designation: "Manager",
    homeNodeId: "10000000-0000-4000-8000-000000000001",
    activeFrom: "2026-08-25",
  };
  it("normalizes contact data and requires structured references", () => {
    const value = employeeMasterCreateSchema.parse({
      employeeCode: "EMP-01",
      displayName: " Employee One ",
      designation: "Manager",
      email: "EMPLOYEE@EXAMPLE.TEST",
      mobile: "+91 99999-99999",
      homeNodeId: "10000000-0000-4000-8000-000000000001",
      regionIds: ["20000000-0000-4000-8000-000000000001"],
      activeFrom: "2026-08-25",
    });
    expect(value.email).toBe("employee@example.test");
    expect(value.mobile).toBe("+919999999999");
  });
  it("rejects an effective end before start", () => {
    expect(() =>
      employeeMasterCreateSchema.parse({
        employeeCode: "EMP-01",
        displayName: "Employee One",
        designation: "Manager",
        homeNodeId: "10000000-0000-4000-8000-000000000001",
        activeFrom: "2026-08-25",
        activeTo: "2026-08-24",
      }),
    ).toThrow(/Active end/);
  });
  it.each([
    ["omitted optional fields", {}, true],
    [
      "null optional fields",
      { email: null, mobile: null, activeTo: null },
      true,
    ],
    ["equal effective dates", { activeTo: "2026-08-25" }, true],
    ["reversed effective dates", { activeTo: "2026-08-24" }, false],
    ["invalid email", { email: "employee-at-example.test" }, false],
    ["overlong email", { email: `${"a".repeat(245)}@example.test` }, false],
    ["invalid local mobile", { mobile: "9999999999" }, false],
    ["invalid short E.164", { mobile: "+1234" }, false],
    ["invalid code punctuation", { employeeCode: "EMP 01" }, false],
    ["one-character code", { employeeCode: "E" }, false],
    ["overlong code", { employeeCode: `E${"1".repeat(40)}` }, false],
    ["invalid calendar date", { activeFrom: "2026-13-01" }, false],
    ["unknown field", { ownerMembership: "opaque" }, false],
  ])("MST01-U-002 validates %s", (_case, change, valid) => {
    expect(
      employeeMasterCreateSchema.safeParse({ ...employee, ...change }).success,
    ).toBe(valid);
  });
});
