import { describe, expect, it } from "vitest";
import {
  accessAcceptSchema,
  accessInviteSchema,
  csvCell,
  inviteAcceptSchema,
  loginSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  passwordResetPreviewSchema,
  adminPasswordResetSchema,
  probeCreateSchema,
  sha256,
  tenantCreateSchema,
  tenantCreateSchemaFor,
} from "./index.js";

const validTenant = {
  name: "Acme Logistics",
  code: "acme-a",
  legalName: "Acme Logistics Private Limited",
  taxIdentifier: "gst-123",
  address: {
    line1: "1 Market Road",
    line2: "",
    postalCode: "700001",
    postalLocalityId: "70000100-0000-4000-8000-000000000001",
    country: "in",
  },
  timezone: "Asia/Kolkata",
  locale: "en-IN",
  currency: "inr",
  fiscalYearStart: { month: 4, day: 1 },
  legalEntity: { name: "Acme Logistics", code: "acme" },
  support: {
    name: "Support Desk",
    email: "HELP@ACME.TEST",
    mobile: "+919999999999",
  },
  owner: { name: "Tenant Owner", email: "OWNER@ACME.TEST" },
  branding: {
    shortName: "Acme",
    primaryColor: "#16324F",
    accentColor: "#D97706",
  },
  active: true,
};

describe("FND01-U-001 tenant validation and normalization", () => {
  it("normalizes codes, tax identifiers, country, currency, and emails", () => {
    const parsed = tenantCreateSchema.parse({
      ...validTenant,
      support: { ...validTenant.support, mobile: "+91 99999-99999" },
    });
    expect(parsed.code).toBe("ACME-A");
    expect(parsed.currency).toBe("INR");
    expect(parsed.owner.email).toBe("owner@acme.test");
    expect(parsed.support.mobile).toBe("+919999999999");
  });
  it.each([
    { timezone: "Mars/Base" },
    { locale: "not_a_locale" },
    { currency: "RUPEE" },
    { fiscalYearStart: { month: 2, day: 29 } },
  ])("rejects invalid bounded business input %o", (change) => {
    expect(() =>
      tenantCreateSchema.parse({ ...validTenant, ...change }),
    ).toThrow();
  });
  it("rejects unknown fields and malformed contact data", () => {
    expect(() =>
      tenantCreateSchema.parse({ ...validTenant, unexpected: true }),
    ).toThrow();
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        support: { ...validTenant.support, mobile: "999" },
      }),
    ).toThrow();
  });
  it("uses configurable ISO catalogs and rejects unsupported country/currency values", () => {
    const catalog = tenantCreateSchemaFor(["IN"], ["INR"]);
    expect(catalog.parse(validTenant).currency).toBe("INR");
    expect(() =>
      catalog.parse({
        ...validTenant,
        address: { ...validTenant.address, country: "US" },
      }),
    ).toThrow(/Unsupported country code/);
    expect(() => catalog.parse({ ...validTenant, currency: "USD" })).toThrow(
      /Unsupported currency code/,
    );
  });
  it.each(["012345", "12345", "1234567", "１２３４５６", "123 456"])(
    "rejects non-canonical Indian PIN %s",
    (postalCode) => {
      expect(() =>
        tenantCreateSchema.parse({
          ...validTenant,
          address: { ...validTenant.address, postalCode },
        }),
      ).toThrow(/valid 6-digit PIN/);
    },
  );
  it("requires a locality reference and rejects caller-derived city/state", () => {
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        address: { ...validTenant.address, postalLocalityId: undefined },
      }),
    ).toThrow();
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        address: {
          ...validTenant.address,
          city: "Kolkata",
          region: "West Bengal",
        },
      }),
    ).toThrow();
  });
  it("accepts brand colours because the UI derives an accessible foreground", () => {
    expect(
      tenantCreateSchema.parse({
        ...validTenant,
        branding: {
          ...validTenant.branding,
          primaryColor: "#BD45BF",
          accentColor: "#8B6D4B",
        },
      }).branding,
    ).toEqual({
      ...validTenant.branding,
      primaryColor: "#BD45BF",
      accentColor: "#8B6D4B",
    });
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        branding: { ...validTenant.branding, primaryColor: "purple" },
      }),
    ).toThrow();
  });
});

describe("FND01-U-002 security material", () => {
  it("produces deterministic one-way SHA-256 hashes without exposing input", async () => {
    const value = await sha256("opaque-token");
    expect(value).toHaveLength(64);
    expect(value).not.toContain("opaque-token");
    expect(value).toBe(await sha256("opaque-token"));
  });
  it("requires a 12-character confirmed invitation password", () => {
    expect(() =>
      inviteAcceptSchema.parse({
        displayName: "Owner",
        password: "short",
        passwordConfirmation: "short",
        termsAccepted: true,
      }),
    ).toThrow();
    expect(
      inviteAcceptSchema.parse({
        displayName: "Owner",
        password: "LongPassword1!",
        passwordConfirmation: "LongPassword1!",
        termsAccepted: true,
      }).termsAccepted,
    ).toBe(true);
  });
});

describe("FND01-U-003 and FND01-U-004 input boundaries", () => {
  it("normalizes login tenant selection and rejects caller extensions", () => {
    expect(
      loginSchema.parse({
        email: " A@B.COM ",
        password: "LongPassword1!",
        tenantCode: "acme",
      }),
    ).toEqual({
      email: "a@b.com",
      password: "LongPassword1!",
      tenantCode: "ACME",
    });
    expect(() =>
      loginSchema.parse({
        email: "a@b.com",
        password: "LongPassword1!",
        tenantId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
  it("bounds probe payloads", () => {
    expect(() => probeCreateSchema.parse({ label: "x", note: "" })).toThrow();
    expect(() =>
      probeCreateSchema.parse({ label: "Valid", note: "x".repeat(2001) }),
    ).toThrow();
  });
});

describe("FND01-U-005 safe exports", () => {
  it.each(["=SUM(A1:A2)", "+cmd", "-2+3", "@hidden"])(
    "escapes spreadsheet-formula prefixes in %s",
    (value) => expect(csvCell(value)).toBe(`"'${value}"`),
  );
  it("quotes embedded quotes", () => expect(csvCell('a"b')).toBe('"a""b"'));
});

describe("FND02-U-007 invitation and authentication validation", () => {
  const roleId = crypto.randomUUID();
  const scopeNodeId = crypto.randomUUID();
  const access = {
    displayName: "Regional Manager",
    employeeCode: "RM-001",
    authenticationMethod: "LOCAL_PASSWORD",
    portalAudience: "INTERNAL",
    assignments: [
      { roleId, grants: [{ scopeNodeId, actions: ["READ", "CREATE"] }] },
    ],
    expiresInHours: 72,
  };
  it("accepts either normalized email or E.164 mobile", () => {
    expect(
      accessInviteSchema.parse({ ...access, email: " USER@EXAMPLE.TEST " })
        .email,
    ).toBe("user@example.test");
    expect(
      accessInviteSchema.parse({ ...access, mobile: "+91 98765 43210" }).mobile,
    ).toBe("+919876543210");
    expect(() => accessInviteSchema.parse(access)).toThrow(/Email or mobile/);
    expect(() =>
      accessInviteSchema.parse({ ...access, mobile: "9876" }),
    ).toThrow();
  });
  it("separates new-password and existing-current-password proof", () => {
    expect(
      accessAcceptSchema.parse({
        displayName: "User",
        currentPassword: "ExistingPassword!",
        termsAccepted: true,
      }).currentPassword,
    ).toBeTruthy();
    expect(
      accessAcceptSchema.parse({
        displayName: "User",
        password: "NewPassword!234",
        passwordConfirmation: "NewPassword!234",
        termsAccepted: true,
      }).password,
    ).toBeTruthy();
    expect(() =>
      accessAcceptSchema.parse({ displayName: "User", termsAccepted: true }),
    ).toThrow(/Credentials/);
  });
  it("FND02-AUTH-REC-U01 validates generic request and strong matching replacement passwords", () => {
    expect(
      passwordResetRequestSchema.parse({
        identifier: " USER@EXAMPLE.TEST ",
        tenantCode: "tenant-a",
      }),
    ).toEqual({ identifier: "USER@EXAMPLE.TEST", tenantCode: "TENANT-A" });
    expect(
      passwordResetCompleteSchema.parse({
        token: "t".repeat(43),
        password: "Replacement!234",
        passwordConfirmation: "Replacement!234",
      }).password,
    ).toBe("Replacement!234");
    expect(() =>
      passwordResetCompleteSchema.parse({
        token: "t".repeat(43),
        password: "Replacement!234",
        passwordConfirmation: "DifferentPass!234",
      }),
    ).toThrow(/Passwords do not match/);
    expect(
      adminPasswordResetSchema.parse({
        expectedVersion: 1,
        reason: "User requested recovery assistance",
      }).expiresInHours,
    ).toBe(1);
    expect(
      passwordResetPreviewSchema.parse({ token: "t".repeat(43) }).token,
    ).toHaveLength(43);
  });
});
