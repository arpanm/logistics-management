import { expect, type APIResponse, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export const adminCredentials = {
  email: process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
  password: process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
};

export type TenantFixture = ReturnType<typeof tenantFixture>;

export function tenantFixture(label: string) {
  const suffix = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 8)
    .toUpperCase();
  const code = `${label
    .replace(/[^A-Z0-9]/gi, "")
    .slice(0, 8)
    .toUpperCase()}-${suffix}`;
  return {
    name: `${label} ${suffix} Logistics`,
    code,
    legalName: `${label} ${suffix} Logistics Limited`,
    taxIdentifier: `TAX-${suffix}`,
    line1: "17 Operations Avenue",
    line2: "Control Tower",
    city: "Kolkata",
    region: "West Bengal",
    postalCode: "700001",
    country: "IN",
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    currency: "INR",
    fiscalMonth: "4",
    fiscalDay: "1",
    entityName: `${label} Legal Entity`,
    entityCode: `LE-${suffix}`,
    supportName: "Operations Support",
    supportEmail: `support-${suffix.toLowerCase()}@test.local`,
    supportMobile: "+919999999999",
    ownerName: `${label} Owner`,
    ownerEmail: `owner-${suffix.toLowerCase()}@test.local`,
    shortName: label.slice(0, 8),
    primaryColor: "#16324f",
    accentColor: "#d97706",
  };
}

export function tenantPayload(data: TenantFixture) {
  return {
    name: data.name,
    code: data.code,
    legalName: data.legalName,
    taxIdentifier: data.taxIdentifier,
    address: {
      line1: data.line1,
      line2: data.line2,
      city: data.city,
      region: data.region,
      postalCode: data.postalCode,
      country: data.country,
    },
    timezone: data.timezone,
    locale: data.locale,
    currency: data.currency,
    fiscalYearStart: {
      month: Number(data.fiscalMonth),
      day: Number(data.fiscalDay),
    },
    legalEntity: {
      name: data.entityName,
      code: data.entityCode,
    },
    support: {
      name: data.supportName,
      email: data.supportEmail,
      mobile: data.supportMobile,
    },
    owner: { name: data.ownerName, email: data.ownerEmail },
    branding: {
      shortName: data.shortName,
      primaryColor: data.primaryColor,
      accentColor: data.accentColor,
    },
    active: true,
  };
}

export async function login(
  page: Page,
  email = adminCredentials.email,
  password = adminCredentials.password,
) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

export async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "logistics_csrf",
  );
  expect(
    cookie,
    "authenticated session exposes its CSRF double-submit cookie",
  ).toBeTruthy();
  return cookie!.value;
}

export async function api(
  page: Page,
  path: string,
  options: {
    method?: string;
    data?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<APIResponse> {
  const method = options.method ?? "GET";
  const headers = { ...options.headers };
  if (!/^(GET|HEAD)$/i.test(method)) headers["X-CSRF-Token"] = await csrf(page);
  return page.request.fetch(`/api/v1${path}`, {
    method,
    data: options.data,
    headers,
    failOnStatusCode: false,
  });
}

export async function provisionViaApi(page: Page, data: TenantFixture) {
  const response = await api(page, "/platform/tenants", {
    method: "POST",
    headers: { "Idempotency-Key": `e2e-${crypto.randomUUID()}` },
    data: tenantPayload(data),
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{
    tenant: { id: string; code: string; version: number };
    invitation: { id: string; expiresAt: string };
    invitationUrl: string;
  }>;
}

export async function openTenantForm(page: Page) {
  const button = page.getByRole("button", { name: "Create tenant" });
  if (await button.isVisible()) await button.click();
  await expect(page.getByRole("heading", { name: "New tenant" })).toBeVisible();
}

export async function fillTenantForm(page: Page, data: TenantFixture) {
  await page.getByLabel("Tenant name").fill(data.name);
  await page.getByLabel("Tenant code").fill(data.code);
  await page.getByLabel("Legal name").fill(data.legalName);
  await page.getByLabel("GSTIN / tax identifier").fill(data.taxIdentifier);
  await page.getByLabel("Short name").fill(data.shortName);
  await page.getByLabel("Address line 1").fill(data.line1);
  await page.getByLabel("Address line 2").fill(data.line2);
  await page.getByLabel("City").fill(data.city);
  await page.getByLabel("State / region").fill(data.region);
  await page.getByLabel("Postal code").fill(data.postalCode);
  await page.getByLabel("Country code").fill(data.country);
  await page.getByLabel("Timezone").fill(data.timezone);
  await page.getByLabel("Locale").fill(data.locale);
  await page.getByLabel("Currency").fill(data.currency);
  await page.getByLabel("Fiscal month").fill(data.fiscalMonth);
  await page.getByLabel("Fiscal day").fill(data.fiscalDay);
  await page.getByLabel("Entity name").fill(data.entityName);
  await page.getByLabel("Entity code").fill(data.entityCode);
  await page
    .getByRole("group", { name: "Support contact" })
    .getByLabel("Name")
    .fill(data.supportName);
  await page
    .getByRole("group", { name: "Support contact" })
    .getByLabel("Email")
    .fill(data.supportEmail);
  await page.getByLabel("Mobile (E.164)").fill(data.supportMobile);
  await page
    .getByRole("group", { name: "First tenant owner" })
    .getByLabel("Name")
    .fill(data.ownerName);
  await page
    .getByRole("group", { name: "First tenant owner" })
    .getByLabel("Email")
    .fill(data.ownerEmail);
}

export async function acceptInvitation(
  page: Page,
  invitationUrl: string,
  displayName: string,
  password = "OwnerPassword!234",
) {
  await page.goto(invitationUrl);
  await expect(page.getByRole("heading", { name: /^Join / })).toBeVisible();
  const newAccountName = page.getByLabel("Your name");
  if (await newAccountName.isVisible()) {
    await newAccountName.fill(displayName);
    await page.getByLabel("Create password").fill(password);
    await page.getByLabel("Confirm password").fill(password);
  } else {
    await expect(
      page.getByText("This email already has an account", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("Existing account password").fill(password);
  }
  await page.getByLabel(/I accept/).check();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page).toHaveURL(/\/app\/setup/);
  await expect(
    page.getByRole("heading", { name: "Setup checklist" }),
  ).toBeVisible();
}

export async function createProbe(page: Page, label: string, note: string) {
  const response = await api(page, "/tenant/probes", {
    method: "POST",
    headers: { "Idempotency-Key": `e2e-probe-${crypto.randomUUID()}` },
    data: { label, note },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{
    id: string;
    label: string;
    note: string;
  }>;
}

export async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

export async function expectNoSeriousAccessibilityViolations(
  page: Page,
  surface: string,
) {
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = scan.violations
    .filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    }));
  expect(
    violations,
    `${surface} has no serious/critical Axe violations`,
  ).toEqual([]);
}
