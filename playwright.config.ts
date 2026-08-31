import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // These are the active canonical acceptance suites. Earlier rapid generic-
  // kernel suites were superseded when the domain modules became canonical.
  testMatch: [
    "fnd-01-tenant-foundation.spec.ts",
    "fnd-02-identity-access.spec.ts",
    "mst-01-operable-masters.spec.ts",
    "all-features-foundation-masters.spec.ts",
    "all-feature-gaps.spec.ts",
    "access-master-remediation.spec.ts",
    "operations-workbench.spec.ts",
    "finance-workbench.spec.ts",
    "control-tower-workbench.spec.ts",
    "platform-tenant-user-admin.spec.ts",
    "demo-data.spec.ts",
  ],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 2,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], channel: "chrome" },
    },
  ],
  outputDir: "test-results",
});
