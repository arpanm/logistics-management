import { describe, expect, it } from "vitest";
import {
  csvCell,
  inviteAcceptSchema,
  loginSchema,
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
    city: "Kolkata",
    region: "West Bengal",
    postalCode: "700001",
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
    const parsed = tenantCreateSchema.parse(validTenant);
    expect(parsed.code).toBe("ACME-A");
    expect(parsed.currency).toBe("INR");
    expect(parsed.owner.email).toBe("owner@acme.test");
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
  it("rejects branding colours that fail the defined WCAG AA text contrast", () => {
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        branding: { ...validTenant.branding, primaryColor: "#FFFFFF" },
      }),
    ).toThrow(/WCAG AA/);
    expect(() =>
      tenantCreateSchema.parse({
        ...validTenant,
        branding: { ...validTenant.branding, accentColor: "#14213D" },
      }),
    ).toThrow(/WCAG AA/);
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
