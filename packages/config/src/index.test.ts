import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

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
