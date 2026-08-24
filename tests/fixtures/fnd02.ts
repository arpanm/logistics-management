import {
  expect,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  api,
  expectNoPageOverflow,
  expectNoSeriousAccessibilityViolations,
  login as loginPlatform,
} from "./fnd01";

export type Fnd02Scenario =
  | "SCOPES_ONLY"
  | "ACCESS_MATRIX"
  | "PORTALS"
  | "REPORTS";

export type ActorFixture = {
  userId: string;
  membershipId: string;
  email: string;
  password: string;
  tenantCode: string;
  home: string;
};

export type ResourceFixture = {
  id: string;
  label: string;
  version: number;
  raw?: Record<string, string | number | null>;
};

export type Fnd02Fixture = {
  namespace: string;
  scenario: Fnd02Scenario;
  tenantA: { id: string; code: string };
  actors: {
    owner: ActorFixture;
    regional: ActorFixture;
    kam: ActorFixture;
    multiRole: ActorFixture;
    vendor: ActorFixture;
    driverA: ActorFixture;
    driverB: ActorFixture;
    client: ActorFixture;
    auditor: ActorFixture;
  };
  roles: Record<string, string>;
  scopes: Record<string, string>;
  resources: Record<string, ResourceFixture>;
  expected: {
    resources: number;
    alerts: number;
  };
  replayed?: boolean;
};

export function fnd02Namespace(testInfo: TestInfo) {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 7);
  return `F${testInfo.workerIndex}${testInfo.retry}-${random}`
    .replace(/[^A-Z0-9-]/gi, "-")
    .toUpperCase()
    .slice(0, 12);
}

export async function seedFnd02(
  page: Page,
  testInfo: TestInfo,
  scenario: Fnd02Scenario,
) {
  await loginPlatform(page);
  const namespace = fnd02Namespace(testInfo);
  const response = await api(page, "/test/fnd02/fixtures", {
    method: "POST",
    headers: {
      "Idempotency-Key": `fixture-${namespace}`,
      Origin: "http://127.0.0.1:3000",
    },
    data: { namespace, scenario },
  });
  expect(response.status(), await response.text()).toBe(201);
  const fixture = {
    ...((await response.json()) as Omit<Fnd02Fixture, "namespace">),
    namespace,
  };
  expect(fixture.scenario).toBe(scenario);
  expect(fixture.tenantA.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  return fixture;
}

export async function loginActor(page: Page, actor: ActorFixture) {
  await page.goto("/login");
  await page.getByLabel(/Email|Email or mobile/).fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const workspace = page.getByLabel("Workspace");
  if (await workspace.isVisible()) {
    await workspace.selectOption(actor.tenantCode);
    await page.getByRole("button", { name: "Continue to workspace" }).click();
  }
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

export async function actorPage(browser: Browser, actor: ActorFixture) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginActor(page, actor);
  return { context, page };
}

export async function accessApi(
  page: Page,
  path: string,
  options: {
    method?: string;
    data?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return api(page, `/tenant/access${path}`, options);
}

export async function inviteThroughUi(
  page: Page,
  input: {
    displayName: string;
    employeeCode: string;
    email?: string;
    mobile?: string;
    portalAudience: "INTERNAL" | "VENDOR" | "DRIVER" | "CLIENT";
    roleName: string;
    scopePath: string;
    actions: Array<
      "READ" | "CREATE" | "UPDATE" | "APPROVE" | "EXPORT" | "ADMIN"
    >;
  },
) {
  await page.goto("/app/access/users");
  await expect(
    page.getByRole("heading", { name: "User directory" }),
  ).toBeVisible();
  await page.getByLabel("Display name").fill(input.displayName);
  await page.getByLabel("Employee code").fill(input.employeeCode);
  if (input.email)
    await page.getByLabel("Email", { exact: true }).fill(input.email);
  if (input.mobile) await page.getByLabel("Mobile (E.164)").fill(input.mobile);
  await page
    .locator("label", { hasText: "Portal audience" })
    .locator("select")
    .selectOption(input.portalAudience);
  await page
    .locator("label", { hasText: /^Role/ })
    .locator("select")
    .selectOption({ label: input.roleName });
  const scope = page.locator("label", { hasText: /^Scope/ }).locator("select");
  const option = scope
    .locator("option")
    .filter({ hasText: input.scopePath })
    .first();
  await scope.selectOption((await option.getAttribute("value")) ?? "");
  for (const action of [
    "READ",
    "CREATE",
    "UPDATE",
    "APPROVE",
    "EXPORT",
    "ADMIN",
  ] as const) {
    const checkbox = page.getByRole("checkbox", { name: action });
    if ((await checkbox.isChecked()) !== input.actions.includes(action))
      await checkbox.click();
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/tenant/access/users"),
  );
  await page
    .getByRole("button", { name: /Review.*send invitation|Send invitation/ })
    .click();
  const response = await responsePromise;
  return {
    response,
    body: (await response.json()) as {
      membershipId: string;
      invitationUrl?: string;
    },
  };
}

export async function expectAccessibleResponsive(page: Page, surface: string) {
  await expectNoSeriousAccessibilityViolations(page, surface);
  await expectNoPageOverflow(page);
}

export function rawSensitiveValues(fixture: Fnd02Fixture) {
  return [
    "FIXTURE-TAX-1234",
    "FIXTURE-BANK-1234",
    "120000",
    "5000",
    ...Object.values(fixture.resources)
      .flatMap((resource) => Object.values(resource.raw ?? {}))
      .filter((value): value is string | number => value !== null)
      .map(String),
  ];
}
