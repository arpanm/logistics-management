import { describe, expect, it } from "vitest";
import {
  JURIGARI_ADOPTION_CONFIRMATION,
  JURIGARI_PRODUCTION_CONFIRMATION,
  JURIGARI_TWELVE_CHARACTER_CONFIRMATION,
  jurigariSeedConfig,
} from "./jurigari-demo-config.js";

const key = Buffer.alloc(32, 11).toString("base64");
const base = {
  JURIGARI_DATA_ENABLED: "true",
  MFA_ENCRYPTION_KEY: key,
  JURIGARI_USER_PASSWORD: `${"A".repeat(16)}!1`,
};

describe("Jurigari seed configuration", () => {
  it("requires explicit opt-in and a protected password", () => {
    expect(() => jurigariSeedConfig({})).toThrow("JURIGARI_DATA_ENABLED=true");
    expect(() =>
      jurigariSeedConfig({
        JURIGARI_DATA_ENABLED: "true",
        MFA_ENCRYPTION_KEY: key,
      }),
    ).toThrow("JURIGARI_USER_PASSWORD");
  });

  it("fixes the two dedicated owner identities without exposing a password", () => {
    expect(jurigariSeedConfig(base)).toMatchObject({
      tenantOwnerEmail: "piyana10@gmail.com",
      operationsEmail: "siddhartha09@gmail.com",
      financeEmail: "siddhartha09@gmail.com",
    });
  });

  it("requires exact production confirmation", () => {
    expect(() =>
      jurigariSeedConfig({ ...base, APP_ENV: "production" }),
    ).toThrow(JURIGARI_PRODUCTION_CONFIRMATION);
  });

  it("does not weaken the production default for a 12-15 character password", () => {
    const production = {
      ...base,
      APP_ENV: "production",
      JURIGARI_DATA_PRODUCTION_CONFIRM: JURIGARI_PRODUCTION_CONFIRMATION,
      JURIGARI_USER_PASSWORD: `${"A".repeat(9)}!1?`,
    };
    expect(() => jurigariSeedConfig(production)).toThrow(
      "JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD=true",
    );
    expect(() =>
      jurigariSeedConfig({
        ...production,
        JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD: "true",
        JURIGARI_12_CHAR_PASSWORD_CONFIRM: "wrong",
      }),
    ).toThrow(JURIGARI_TWELVE_CHARACTER_CONFIRMATION);
    expect(
      jurigariSeedConfig({
        ...production,
        JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD: "true",
        JURIGARI_12_CHAR_PASSWORD_CONFIRM:
          JURIGARI_TWELVE_CHARACTER_CONFIRMATION,
      }).password,
    ).toHaveLength(12);
  });

  it("accepts a 16+ character production password without the narrow exception", () => {
    expect(
      jurigariSeedConfig({
        ...base,
        APP_ENV: "production",
        JURIGARI_DATA_PRODUCTION_CONFIRM: JURIGARI_PRODUCTION_CONFIRMATION,
      }).appEnv,
    ).toBe("production");
  });

  it("requires an exact confirmation and UUID to adopt an existing tenant", () => {
    expect(() =>
      jurigariSeedConfig({ ...base, JURIGARI_ADOPT_TENANT_ID: "not-a-uuid" }),
    ).toThrow(JURIGARI_ADOPTION_CONFIRMATION);
    expect(() =>
      jurigariSeedConfig({
        ...base,
        JURIGARI_ADOPT_TENANT_ID: "not-a-uuid",
        JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM: JURIGARI_ADOPTION_CONFIRMATION,
      }),
    ).toThrow("tenantId must be a version-4 UUID");
    expect(
      jurigariSeedConfig({
        ...base,
        JURIGARI_ADOPT_TENANT_ID: "415f88a2-675a-476c-8031-87c3ff1ae23b",
        JURIGARI_ADOPT_LEGAL_ENTITY_ID: "8fa9ddab-d6fa-4e31-a9c0-ab5527889b54",
        JURIGARI_ADOPT_ROOT_ORGANIZATION_ID:
          "59d8d9fb-9c0b-413f-b7c3-9ff0a2d8cd12",
        JURIGARI_ADOPT_TENANT_SCOPE_ID: "a22b8bf4-9b96-46d6-bff4-9dbf12673926",
        JURIGARI_ADOPT_LEGAL_SCOPE_ID: "d10ed9f1-ef94-4a31-a334-8d060d12d9ec",
        JURIGARI_ADOPT_OWNER_MEMBERSHIP_ID:
          "d13a6a02-a72f-4c4d-8934-c28673270c61",
        JURIGARI_ADOPT_OWNER_EMPLOYEE_ID:
          "5f060f59-2708-4c57-a593-612d6d37f76e",
        JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM: JURIGARI_ADOPTION_CONFIRMATION,
      }).adoption?.tenantId,
    ).toBe("415f88a2-675a-476c-8031-87c3ff1ae23b");
  });
});
