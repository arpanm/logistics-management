import {
  expect,
  test,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";

test.setTimeout(90_000);

const password =
  process.env.E2E_JURIGARI_USER_PASSWORD ??
  process.env.JURIGARI_USER_PASSWORD ??
  "";

const accounts = [
  {
    id: "JGD-E2E-001",
    name: "Piyana",
    email: process.env.E2E_JURIGARI_PIYANA_EMAIL ?? "piyana10@gmail.com",
  },
  {
    id: "JGD-E2E-002",
    name: "Siddhartha",
    email:
      process.env.E2E_JURIGARI_SIDDHARTHA_EMAIL ?? "siddhartha09@gmail.com",
  },
] as const;

const records = {
  tenantCode: "JG",
  vendor: "Sahil Roadlines",
  vendorCode: "VEN-0142",
  lr: "JGL/24118",
  invoice: "INV-26-3427",
} as const;

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLocalTarget(testInfo: TestInfo) {
  const configured = String(
    testInfo.project.use.baseURL ??
      process.env.E2E_BASE_URL ??
      "http://127.0.0.1:3000",
  );
  const target = new URL(configured);
  if (!localHosts.has(target.hostname)) {
    throw new Error(
      `Jurigari credential journeys are local-only; refusing target ${target.origin}.`,
    );
  }
}

async function json<T>(response: APIResponse) {
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as T;
}

const visibleText = (page: Page, value: string) =>
  page.getByText(value, { exact: true }).filter({ visible: true }).first();

async function login(page: Page, testInfo: TestInfo, email: string) {
  assertLocalTarget(testInfo);
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email or mobile").fill(email);
  await page.getByLabel("Password").fill(password);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/auth/login"),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const result = await json<{
    requiresTenantSelection?: boolean;
    tenants?: Array<{ code: string }>;
  }>(await responsePromise);

  if (result.requiresTenantSelection) {
    expect(result.tenants?.map((tenant) => tenant.code)).toContain(
      records.tenantCode,
    );
    await page.getByLabel("Workspace").selectOption(records.tenantCode);
    const selectionPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/auth/login"),
    );
    await page.getByRole("button", { name: "Continue to workspace" }).click();
    await json(await selectionPromise);
  }

  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole("heading", { name: "Operations access home" }),
  ).toBeVisible();
}

async function verifyPersistentSession(page: Page, email: string) {
  const authPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/v1/auth/me"),
  );
  await page.reload();
  const me = await json<{
    user: { email: string; platformAdmin: boolean };
    activeTenantId: string | null;
    memberships: Array<{ code: string }>;
  }>(await authPromise);
  expect(me.user).toMatchObject({
    email,
    platformAdmin: false,
  });
  expect(me.activeTenantId).toBeTruthy();
  expect(me.memberships.map((membership) => membership.code)).toContain(
    records.tenantCode,
  );
  await expect(page).toHaveURL(/\/app$/);
}

async function verifyJurigariReferences(page: Page) {
  const vendorsPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/v1\/domain\/vendors(?:\?|$)/.test(response.url()),
  );
  await page.goto("/app/masters/vendors");
  await expect(
    page.getByRole("heading", { name: "Vendors", exact: true }),
  ).toBeVisible();
  const vendors = await json<{ items: Array<Record<string, unknown>> }>(
    await vendorsPromise,
  );
  expect(JSON.stringify(vendors.items)).toContain(records.vendorCode);
  await expect(visibleText(page, records.vendor)).toBeVisible();

  await page.goto("/app/operations/trips");
  await expect(
    page.getByRole("heading", { name: "Trip execution", exact: true }),
  ).toBeVisible();
  const tripsPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/operations/trips?") &&
      response.url().includes(encodeURIComponent(records.lr)),
  );
  await page.getByRole("searchbox", { name: "Search" }).fill(records.lr);
  const trips = await json<{ items: Array<Record<string, unknown>> }>(
    await tripsPromise,
  );
  expect(JSON.stringify(trips.items)).toContain(records.lr);

  await page.goto("/app/finance/invoices");
  await expect(
    page.getByRole("heading", {
      name: "Billing, collections and payables",
      exact: true,
    }),
  ).toBeVisible();
  const invoicesPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/tenant/finance/invoices?") &&
      response.url().includes(encodeURIComponent(records.invoice)),
  );
  await page.getByRole("searchbox", { name: "Search" }).fill(records.invoice);
  const invoices = await json<{ items: Array<Record<string, unknown>> }>(
    await invoicesPromise,
  );
  expect(JSON.stringify(invoices.items)).toContain(records.invoice);

  await page.goto("/app/control?lens=collection");
  await expect(
    page.getByRole("heading", { name: "Control tower", exact: true }),
  ).toBeVisible();
  const collectionPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/control-workbench/collection?") &&
      response.url().includes(encodeURIComponent(records.invoice)),
  );
  await page.getByLabel("Search visible scope").fill(records.invoice);
  const collection = await json<Record<string, unknown>>(
    await collectionPromise,
  );
  expect(JSON.stringify(collection)).toContain(records.invoice);
}

test.describe("Jurigari production-demo profile", () => {
  test.skip(
    !password,
    "Set E2E_JURIGARI_USER_PASSWORD (or JURIGARI_USER_PASSWORD) to the locally seeded Jurigari password.",
  );

  for (const account of accounts) {
    test(`${account.id} ${account.name} retains login and can trace the canonical demo chain`, async ({
      page,
    }, testInfo) => {
      await login(page, testInfo, account.email);
      await verifyPersistentSession(page, account.email);
      await verifyJurigariReferences(page);
    });
  }
});
