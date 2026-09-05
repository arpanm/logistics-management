import { describe, expect, it } from "vitest";
import { isRequestOriginAllowed, loadConfig } from "./index.js";

const base = {
  DATABASE_URL: "postgresql://app:secret@127.0.0.1:5432/logistics",
  AUTH_SECRET: "a-production-grade-secret",
  PLATFORM_ADMIN_EMAIL: "admin@example.test",
  PLATFORM_ADMIN_PASSWORD: "ProductionPassword1!",
};

describe("FND-01 guarded test hooks", () => {
  it("allows the privileged failure hook in local E2E deployment", () => {
    expect(
      loadConfig({ ...base, APP_ENV: "local", ENABLE_TEST_HOOKS: "true" }),
    ).toMatchObject({ APP_ENV: "local", ENABLE_TEST_HOOKS: "true" });
  });

  it("refuses to start production when the hook is enabled", () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: "production",
        NODE_ENV: "production",
        ENABLE_TEST_HOOKS: "true",
      }),
    ).toThrow("Test hooks cannot be enabled in production");
  });
});

describe("local request origins", () => {
  const localConfig = {
    APP_ENV: "local" as const,
    FRONTEND_URL: "http://127.0.0.1:3000",
  };

  it("accepts equivalent loopback hostnames on the configured port", () => {
    expect(isRequestOriginAllowed("http://127.0.0.1:3000", localConfig)).toBe(
      true,
    );
    expect(isRequestOriginAllowed("http://localhost:3000", localConfig)).toBe(
      true,
    );
    expect(isRequestOriginAllowed("http://[::1]:3000", localConfig)).toBe(true);
  });

  it("rejects different ports, remote hosts, malformed origins, and production aliases", () => {
    expect(isRequestOriginAllowed("http://localhost:3001", localConfig)).toBe(
      false,
    );
    expect(
      isRequestOriginAllowed("http://example.test:3000", localConfig),
    ).toBe(false);
    expect(isRequestOriginAllowed("not-an-origin", localConfig)).toBe(false);
    expect(
      isRequestOriginAllowed("http://localhost:3000", {
        ...localConfig,
        APP_ENV: "production",
      }),
    ).toBe(false);
  });
});

describe("FND02-C-006 MFA encryption startup guard", () => {
  it("requires a valid 32-byte encryption key in production", () => {
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: "production",
        NODE_ENV: "production",
        ENABLE_TEST_HOOKS: "false",
      }),
    ).toThrow("MFA_ENCRYPTION_KEY is required");
    expect(() =>
      loadConfig({
        ...base,
        APP_ENV: "production",
        NODE_ENV: "production",
        ENABLE_TEST_HOOKS: "false",
        MFA_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      }),
    ).toThrow("32-byte");
    expect(
      loadConfig({
        ...base,
        APP_ENV: "production",
        NODE_ENV: "production",
        ENABLE_TEST_HOOKS: "false",
        MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      }).MFA_KEY_VERSION,
    ).toBe(1);
  });
});

describe("INT02-C-002 conversational provider startup guards", () => {
  it("keeps WhatsApp disabled without requiring provider secrets", () => {
    expect(loadConfig(base)).toMatchObject({
      CONVERSATION_INTENT_PROVIDER: "deterministic",
      WHATSAPP_PROVIDER: "disabled",
    });
  });

  it("supports the deterministic intent kill switch", () => {
    expect(
      loadConfig({ ...base, CONVERSATION_INTENT_PROVIDER: "disabled" })
        .CONVERSATION_INTENT_PROVIDER,
    ).toBe("disabled");
  });

  it("fails closed when WhatsApp secrets are incomplete", () => {
    expect(() => loadConfig({ ...base, WHATSAPP_PROVIDER: "meta" })).toThrow(
      "WHATSAPP_APP_SECRET",
    );
  });

  it("requires outbound Meta credentials before enabling the channel", () => {
    const secured = {
      ...base,
      WHATSAPP_PROVIDER: "meta",
      WHATSAPP_APP_SECRET: "a".repeat(32),
      WHATSAPP_VERIFY_TOKEN: "v".repeat(16),
      WHATSAPP_ADDRESS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
    };
    expect(() => loadConfig(secured)).toThrow("WHATSAPP_PHONE_NUMBER_ID");
    expect(() =>
      loadConfig({ ...secured, WHATSAPP_PHONE_NUMBER_ID: "123456789" }),
    ).toThrow("WHATSAPP_ACCESS_TOKEN");
    expect(
      loadConfig({
        ...secured,
        WHATSAPP_PHONE_NUMBER_ID: "123456789",
        WHATSAPP_ACCESS_TOKEN: "token-" + "x".repeat(24),
      }),
    ).toMatchObject({
      WHATSAPP_PROVIDER: "meta",
      WHATSAPP_GRAPH_API_VERSION: "v23.0",
      WHATSAPP_DELIVERY_MAX_ATTEMPTS: 5,
    });
  });
});
