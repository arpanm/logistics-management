import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEMO_CREDENTIALS,
  DEMO_PRODUCTION_CONFIRMATION,
  demoSeedConfig,
} from "./demo-seed-config.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe("demo seed configuration", () => {
  it("requires an explicit opt-in", () => {
    expect(() => demoSeedConfig({})).toThrow("DEMO_DATA_ENABLED=true");
  });

  it("requires a second explicit production confirmation", () => {
    expect(() =>
      demoSeedConfig({ DEMO_DATA_ENABLED: "true", APP_ENV: "production" }),
    ).toThrow(DEMO_PRODUCTION_CONFIRMATION);
  });

  it("uses disposable documented defaults outside production", () => {
    expect(
      demoSeedConfig({
        DEMO_DATA_ENABLED: "true",
        MFA_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toMatchObject(DEFAULT_DEMO_CREDENTIALS);
  });

  it("resolves the independent existing platform administrator", () => {
    expect(
      demoSeedConfig({
        DEMO_DATA_ENABLED: "true",
        MFA_ENCRYPTION_KEY: encryptionKey,
        PLATFORM_ADMIN_EMAIL: " Existing.Admin@Example.test ",
      }).platformAdminEmail,
    ).toBe("existing.admin@example.test");
  });

  it("accepts production only with the exact confirmation", () => {
    expect(
      demoSeedConfig({
        DEMO_DATA_ENABLED: "true",
        APP_ENV: "production",
        DEMO_DATA_PRODUCTION_CONFIRM: DEMO_PRODUCTION_CONFIRMATION,
        DEMO_USER_PASSWORD: "ProductionDemo!2345",
        MFA_ENCRYPTION_KEY: encryptionKey,
      }).appEnv,
    ).toBe("production");
  });

  it("rejects the public default password in production", () => {
    expect(() =>
      demoSeedConfig({
        DEMO_DATA_ENABLED: "true",
        APP_ENV: "production",
        DEMO_DATA_PRODUCTION_CONFIRM: DEMO_PRODUCTION_CONFIRMATION,
      }),
    ).toThrow("non-default DEMO_USER_PASSWORD");
  });

  it("requires at least sixteen characters in production", () => {
    expect(() =>
      demoSeedConfig({
        DEMO_DATA_ENABLED: "true",
        APP_ENV: "production",
        DEMO_DATA_PRODUCTION_CONFIRM: DEMO_PRODUCTION_CONFIRMATION,
        DEMO_USER_PASSWORD: "TooShort!234",
        MFA_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toThrow("at least 16 characters");
  });

  it("requires the runtime encryption key used for protected bank data", () => {
    expect(() => demoSeedConfig({ DEMO_DATA_ENABLED: "true" })).toThrow(
      "MFA_ENCRYPTION_KEY",
    );
  });
});
