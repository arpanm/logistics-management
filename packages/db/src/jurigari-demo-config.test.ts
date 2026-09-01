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
    ).toThrow("version-4 UUID");
    expect(
      jurigariSeedConfig({
        ...base,
        JURIGARI_ADOPT_TENANT_ID: "415f88a2-675a-476c-8031-87c3ff1ae23b",
        JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM: JURIGARI_ADOPTION_CONFIRMATION,
      }).adoptTenantId,
    ).toBe("415f88a2-675a-476c-8031-87c3ff1ae23b");
  });
});
