import {
  expect,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";

export const DEMO_TENANT = {
  code: "DEMO",
  name: "Demo Logistics India",
} as const;

export const DEMO_RECORDS = {
  clientCode: "DEMO-RETAIL",
  clientName: "Demo Retail India Limited",
  clientLocation: "Bengaluru Distribution Centre",
  vendorCode: "DEMO-FLEET",
  vendorName: "Demo Fleet Services Private Limited",
  laneCode: "BLR-HYD",
  openIndent: "DEMO-IND-OPEN",
  offeredIndent: "DEMO-IND-OFFERED",
  liveIndent: "DEMO-IND-LIVE",
  liveTrip: "DEMO-TRIP-LIVE",
  liveLr: "DEMO-LR-LIVE",
  deliveredTrip: "DEMO-TRIP-DONE",
  submittedInvoice: "DEMO-INV-POSTED",
  draftInvoice: "DEMO-INV-DRAFT",
  receipt: "DEMO-RCPT-001",
  vendorBill: "DEMO-VBILL-001",
  payoutBatch: "DEMO-PAYOUT-001",
} as const;

export const DEMO_ACCOUNTS = {
  platform: {
    email: process.env.E2E_PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
    home: "/platform/tenants",
    heading: "Tenants",
  },
  owner: {
    email: "demo.owner@logistics.test",
    home: "/app",
    heading: "Operations access home",
  },
  traffic: {
    email: "demo.operations@logistics.test",
    home: "/app",
    heading: "Operations access home",
  },
  finance: {
    email: "demo.finance@logistics.test",
    home: "/app",
    heading: "Operations access home",
  },
  vendor: {
    email: "demo.vendor@logistics.test",
    home: "/portal/vendor",
    heading: "Vendor portal",
  },
  client: {
    email: "demo.client@logistics.test",
    home: "/portal/client",
    heading: "Client portal",
  },
} as const;

export type DemoAccount = keyof typeof DEMO_ACCOUNTS;

type EffectiveAccess = {
  home: string;
  portalAudience: "PLATFORM" | "INTERNAL" | "VENDOR" | "CLIENT";
};

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function localDemoBaseURL(testInfo: TestInfo) {
  const configured = String(
    testInfo.project.use.baseURL ??
      process.env.E2E_BASE_URL ??
      "http://127.0.0.1:3000",
  );
  const target = new URL(configured);
  if (!localHosts.has(target.hostname)) {
    throw new Error(
      `Demo credential journeys are local-only; refusing Playwright target ${target.origin}.`,
    );
  }
  return target.origin;
}

async function json<T>(response: APIResponse, expectedStatus = 200) {
  const text = await response.text();
  expect(response.status(), text).toBe(expectedStatus);
  return JSON.parse(text) as T;
}

export async function loginDemoUser(
  page: Page,
  testInfo: TestInfo,
  accountName: DemoAccount,
) {
  localDemoBaseURL(testInfo);
  const account = DEMO_ACCOUNTS[accountName];
  const password =
    accountName === "platform"
      ? (process.env.E2E_PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234")
      : (process.env.E2E_DEMO_USER_PASSWORD ?? "DemoAccess!234");

  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email or mobile").fill(account.email);
  await page.getByLabel("Password").fill(password);

  const firstLogin = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/auth/login"),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const first = await json<{
    requiresTenantSelection?: boolean;
    tenants?: Array<{ code: string }>;
  }>(await firstLogin);

  if (first.requiresTenantSelection) {
    expect(first.tenants?.map((tenant) => tenant.code)).toContain(
      DEMO_TENANT.code,
    );
    await page.getByLabel("Workspace").selectOption(DEMO_TENANT.code);
    const selectedLogin = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/auth/login"),
    );
    await page.getByRole("button", { name: "Continue to workspace" }).click();
    await json(await selectedLogin);
  }

  if (accountName === "platform") {
    await expect(page).toHaveURL(/\/platform\/tenants$/);
    await expect(
      page.getByRole("heading", { name: account.heading }),
    ).toBeVisible();
    return { home: account.home, portalAudience: "PLATFORM" } as const;
  }

  await expect(page).toHaveURL(/\/app$/);
  const effective = await json<EffectiveAccess>(
    await page.request.get("/api/v1/tenant/access/effective"),
  );
  expect(effective.home).toBe(account.home);

  await page.goto(account.home);
  await expect(
    page.getByRole("heading", { name: account.heading }),
  ).toBeVisible();
  return effective;
}
