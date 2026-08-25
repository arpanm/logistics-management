import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  acceptInvitation,
  api,
  fillTenantForm,
  login,
  openTenantForm,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";
import { accessApi, actorPage, seedFnd02 } from "../fixtures/fnd02";

test.setTimeout(90_000);

const suffix = () =>
  crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
const json = async <T>(response: { json(): Promise<unknown> }) =>
  (await response.json()) as T;

async function ownerTenant(page: Page, label: string) {
  const tenant = tenantFixture(label);
  await login(page);
  const provisioned = await provisionViaApi(page, tenant);
  await acceptInvitation(page, provisioned.invitationUrl, tenant.ownerName);
  return { tenant, provisioned };
}

async function twoOwners(browser: Browser, admin: Page, label: string) {
  await login(admin);
  const tenantA = tenantFixture(`${label}A`);
  const tenantB = tenantFixture(`${label}B`);
  const provisionedA = await provisionViaApi(admin, tenantA);
  const provisionedB = await provisionViaApi(admin, tenantB);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await acceptInvitation(pageA, provisionedA.invitationUrl, tenantA.ownerName);
  await acceptInvitation(pageB, provisionedB.invitationUrl, tenantB.ownerName);
  return {
    tenantA,
    tenantB,
    provisionedA,
    provisionedB,
    contextA,
    contextB,
    pageA,
    pageB,
  };
}

test("E2E-FOUND-FND01-01 permitted platform UI provision persists tenant detail", async ({
  page,
}) => {
  const tenant = tenantFixture("FoundUi");
  await login(page);
  await page.goto("/platform/tenants");
  await openTenantForm(page);
  await fillTenantForm(page, tenant);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  const created = await json<{ tenant: { id: string; code: string } }>(
    response,
  );
  const detail = await api(page, `/platform/tenants/${created.tenant.id}`);
  expect(detail.status(), await detail.text()).toBe(200);
  expect(await detail.json()).toMatchObject({
    tenant: { code: tenant.code, name: tenant.name, status: "ACTIVE" },
  });
});

test("E2E-FOUND-FND01-02 invalid UI provision creates no partial tenant", async ({
  page,
}) => {
  const tenant = tenantFixture("FoundBad");
  await login(page);
  await page.goto("/platform/tenants");
  await openTenantForm(page);
  await fillTenantForm(page, tenant);
  await page.getByLabel("Timezone").fill("Invalid/Timezone");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  expect((await responsePromise).status()).toBe(400);
  const list = await api(page, `/platform/tenants?search=${tenant.code}`);
  expect((await json<{ total: number }>(list)).total).toBe(0);
});

test("E2E-FOUND-FND01-03 tenant owner is unauthorized for another tenant and platform", async ({
  browser,
  page,
}) => {
  const setup = await twoOwners(browser, page, "FoundIso");
  const platform = await api(setup.pageA, "/platform/tenants");
  expect(platform.status()).toBe(403);
  const foreign = await api(
    setup.pageA,
    `/platform/tenants/${setup.provisionedB.tenant.id}`,
  );
  expect(foreign.status()).toBe(403);
  await setup.contextA.close();
  await setup.contextB.close();
});

test("E2E-FOUND-FND01-04 stale lifecycle fails and valid deactivate-reactivate recovers", async ({
  page,
}) => {
  const tenant = tenantFixture("FoundRecover");
  await login(page);
  const provisioned = await provisionViaApi(page, tenant);
  const stale = await api(
    page,
    `/platform/tenants/${provisioned.tenant.id}/deactivate`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `stale-${suffix()}` },
      data: {
        expectedVersion: 999,
        reason: "Stale lifecycle acceptance attempt",
        confirmationCode: tenant.code,
      },
    },
  );
  expect(stale.status()).toBe(409);
  const deactivated = await api(
    page,
    `/platform/tenants/${provisioned.tenant.id}/deactivate`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `deactivate-${suffix()}` },
      data: {
        expectedVersion: provisioned.tenant.version,
        reason: "Acceptance lifecycle deactivation",
        confirmationCode: tenant.code,
      },
    },
  );
  expect(deactivated.status(), await deactivated.text()).toBe(200);
  const inactive = await json<{ version: number; status: string }>(deactivated);
  expect(inactive.status).toBe("INACTIVE");
  const reactivated = await api(
    page,
    `/platform/tenants/${provisioned.tenant.id}/reactivate`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `reactivate-${suffix()}` },
      data: {
        expectedVersion: inactive.version,
        reason: "Acceptance lifecycle reactivation",
      },
    },
  );
  expect(reactivated.status(), await reactivated.text()).toBe(200);
  expect(await reactivated.json()).toMatchObject({ status: "ACTIVE" });
});

test("E2E-FOUND-FND01-05 platform report reconciles provisioned tenant list", async ({
  page,
}) => {
  const tenant = tenantFixture("FoundReport");
  await login(page);
  await provisionViaApi(page, tenant);
  const list = await json<{ total: number; items: Array<{ code: string }> }>(
    await api(page, `/platform/tenants?search=${tenant.code}`),
  );
  const report = await json<{
    totals: { total: number; active: number };
    tenants: Array<{ code: string; status: string }>;
  }>(await api(page, "/platform/report"));
  expect(list.total).toBe(1);
  expect(list.items[0]?.code).toBe(tenant.code);
  expect(report.tenants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: tenant.code, status: "ACTIVE" }),
    ]),
  );
  expect(report.totals.total).toBe(report.tenants.length);
});

test("E2E-FOUND-FND02-01 permitted owner creates proof through UI and API persists it", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  const label = `UI proof ${suffix()}`;
  await owner.page.goto("/app/access/probes");
  await expect(owner.page.getByLabel("Scope")).not.toHaveValue("");
  await owner.page.getByLabel("Label").fill(label);
  const responsePromise = owner.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/tenant/access/probes"),
  );
  await owner.page.getByRole("button", { name: "Create proof" }).click();
  expect((await responsePromise).status()).toBe(201);
  const list = await json<{ items: Array<{ label: string }> }>(
    await accessApi(owner.page, `/probes?search=${encodeURIComponent(label)}`),
  );
  expect(list.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ label })]),
  );
  await owner.context.close();
});

test("E2E-FOUND-FND02-02 required UI validation creates no proof", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  const before = await json<{ total: number }>(
    await accessApi(owner.page, "/probes"),
  );
  await owner.page.goto("/app/access/probes");
  await owner.page.getByRole("button", { name: "Create proof" }).click();
  expect(
    await owner.page
      .getByLabel("Label")
      .evaluate((element: HTMLInputElement) => element.checkValidity()),
  ).toBe(false);
  const after = await json<{ total: number }>(
    await accessApi(owner.page, "/probes"),
  );
  expect(after.total).toBe(before.total);
  await owner.context.close();
});

test("E2E-FOUND-FND02-03 regional actor cannot read another tenant resource", async ({
  browser,
  page,
}, testInfo) => {
  const tenantA = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantB = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const regional = await actorPage(browser, tenantA.actors.regional);
  const response = await accessApi(
    regional.page,
    `/probes/${tenantB.resources.north!.id}`,
  );
  expect(response.status()).toBe(404);
  expect(await response.json()).toMatchObject({
    message: "Resource not found",
  });
  await regional.context.close();
});

test("E2E-FOUND-FND02-04 stale proof update fails and current version recovers", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  const target = fixture.resources.north!;
  const stale = await accessApi(owner.page, `/probes/${target.id}`, {
    method: "PATCH",
    data: { expectedVersion: 999, status: "COMPLETED" },
  });
  expect(stale.status()).toBe(409);
  const valid = await accessApi(owner.page, `/probes/${target.id}`, {
    method: "PATCH",
    data: { expectedVersion: target.version, status: "COMPLETED" },
  });
  expect(valid.status(), await valid.text()).toBe(200);
  expect(await valid.json()).toMatchObject({ status: "COMPLETED" });
  await owner.context.close();
});

test("E2E-FOUND-FND02-05 report and alert counts reconcile seeded evidence", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "REPORTS");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.page.goto("/app/access/reports");
  await owner.page.getByLabel("Report").selectOption("failed-logins");
  await expect(
    owner.page.getByRole("heading", { name: "Reports and alerts" }),
  ).toBeVisible();
  const failures = await json<{ items: Array<{ count: number }> }>(
    await accessApi(owner.page, "/reports/failed-logins"),
  );
  const alerts = await json<{ total: number; items: Array<{ type: string }> }>(
    await accessApi(owner.page, "/alerts"),
  );
  expect(
    failures.items.reduce((total, item) => total + Number(item.count), 0),
  ).toBe(1);
  expect(alerts.total).toBe(fixture.expected.alerts);
  expect(alerts.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "REPEATED_LOGIN_FAILURES" }),
    ]),
  );
  await owner.context.close();
});

type MasterCase = {
  feature: "MST01" | "MST02" | "MST03";
  resource: "organization-nodes" | "clients" | "vehicles";
  route: string;
  createButton: string;
  invalidLabel: string;
};

const masters: readonly MasterCase[] = [
  {
    feature: "MST01",
    resource: "organization-nodes",
    route: "/app/masters/locations",
    createButton: "Create organization node",
    invalidLabel: "Code",
  },
  {
    feature: "MST02",
    resource: "clients",
    route: "/app/masters/parties",
    createButton: "Create client",
    invalidLabel: "Client code",
  },
  {
    feature: "MST03",
    resource: "vehicles",
    route: "/app/masters/fleet",
    createButton: "Create vehicle",
    invalidLabel: "Vendor ID",
  },
] as const;

async function canonicalMutation(
  page: Page,
  path: string,
  data: Record<string, unknown>,
) {
  return api(page, `/domain${path}`, {
    method: "POST",
    headers: { "Idempotency-Key": `foundation-${crypto.randomUUID()}` },
    data,
  });
}

async function createDependency(
  page: Page,
  resource: "organization-nodes" | "vendors",
  data: Record<string, unknown>,
) {
  const response = await canonicalMutation(page, `/${resource}`, data);
  expect(response.status(), await response.text()).toBe(201);
  return json<{ id: string }>(response);
}

async function canonicalPayload(page: Page, entry: MasterCase, code: string) {
  if (entry.feature === "MST01")
    return {
      code,
      name: `Region ${code}`,
      nodeType: "REGION",
      timezone: "Asia/Kolkata",
      postalCodes: ["700001"],
      geofence: {},
      activeFrom: "2026-01-01",
    };
  if (entry.feature === "MST02") {
    const entity = await createDependency(page, "organization-nodes", {
      code: `LE${suffix()}`,
      name: `Legal entity ${code}`,
      nodeType: "LEGAL_ENTITY",
      timezone: "Asia/Kolkata",
      postalCodes: ["700001"],
      geofence: {},
      activeFrom: "2026-01-01",
    });
    return {
      code,
      legalName: `Client ${code} Limited`,
      billingEntityId: entity.id,
      creditDays: 30,
      podMode: "DIGITAL",
    };
  }
  const vendor = await createDependency(page, "vendors", {
    code: `VN${suffix()}`,
    legalName: `Vendor ${code} Limited`,
    tdsBasisPoints: 0,
    paymentTermsDays: 15,
  });
  return {
    vendorId: vendor.id,
    registrationNumber: `WB${suffix()}`,
    vehicleType: "32FT",
    capacityMilli: 10_000,
  };
}

async function fillCanonicalForm(
  page: Page,
  entry: MasterCase,
  payload: Record<string, unknown>,
) {
  if (entry.feature === "MST01") {
    await page.getByLabel("Code", { exact: true }).fill(String(payload.code));
    await page.getByLabel("Name").fill(String(payload.name));
    await page.getByLabel("Node type").selectOption(String(payload.nodeType));
    await page.getByLabel("Timezone").fill(String(payload.timezone));
    await page.getByLabel("Postal codes (JSON array)").fill('["700001"]');
    await page.getByLabel("Geofence (JSON)").fill("{}");
    await page.getByLabel("Active from").fill(String(payload.activeFrom));
    return;
  }
  if (entry.feature === "MST02") {
    await page.getByLabel("Client code").fill(String(payload.code));
    await page.getByLabel("Legal name").fill(String(payload.legalName));
    await page
      .getByLabel("Billing entity node ID")
      .fill(String(payload.billingEntityId));
    await page.getByLabel("Credit days").fill(String(payload.creditDays));
    await page.getByLabel("POD mode").selectOption(String(payload.podMode));
    return;
  }
  await page.getByLabel("Vendor ID").fill(String(payload.vendorId));
  await page
    .getByLabel("Registration number")
    .fill(String(payload.registrationNumber));
  await page.getByLabel("Vehicle type").fill(String(payload.vehicleType));
  await page
    .getByLabel("Capacity milli-units")
    .fill(String(payload.capacityMilli));
}

for (const entry of masters) {
  const endpoint = `/domain/${entry.resource}`;

  test(`E2E-FOUND-${entry.feature}-01 permitted UI create persists API record`, async ({
    page,
  }) => {
    await ownerTenant(page, `${entry.feature}Ui`);
    const code = `${entry.feature}-${suffix()}`;
    const payload = await canonicalPayload(page, entry, code);
    await page.goto(entry.route);
    await fillCanonicalForm(page, entry, payload);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/v1${endpoint}`),
    );
    await page.getByRole("button", { name: entry.createButton }).click();
    expect((await responsePromise).status()).toBe(201);
    const list = await json<{ items: Array<{ id: string }> }>(
      await api(page, endpoint),
    );
    expect(list.items.length).toBeGreaterThan(0);
  });

  test(`E2E-FOUND-${entry.feature}-02 invalid UI create has no partial mutation`, async ({
    page,
  }) => {
    await ownerTenant(page, `${entry.feature}Bad`);
    const before = await json<{ total: number }>(await api(page, endpoint));
    await page.goto(entry.route);
    await page.getByRole("button", { name: entry.createButton }).click();
    expect(
      await page
        .getByLabel(entry.invalidLabel, { exact: true })
        .evaluate((element: HTMLInputElement) => element.checkValidity()),
    ).toBe(false);
    const after = await json<{ total: number }>(await api(page, endpoint));
    expect(after.total).toBe(before.total);
  });

  test(`E2E-FOUND-${entry.feature}-03 cross-tenant detail is hidden`, async ({
    browser,
    page,
  }) => {
    const setup = await twoOwners(browser, page, `${entry.feature}Iso`);
    const code = `${entry.feature}-${suffix()}`;
    const payload = await canonicalPayload(setup.pageA, entry, code);
    const createdResponse = await canonicalMutation(
      setup.pageA,
      `/${entry.resource}`,
      payload,
    );
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await json<{ id: string }>(createdResponse);
    const foreign = await api(setup.pageB, `${endpoint}/${created.id}`);
    expect(foreign.status()).toBe(404);
    expect(await foreign.json()).toMatchObject({
      message: "Resource not found",
    });
    await setup.contextA.close();
    await setup.contextB.close();
  });

  test(`E2E-FOUND-${entry.feature}-04 stale version fails and state transition recovers`, async ({
    page,
  }) => {
    await ownerTenant(page, `${entry.feature}Recover`);
    const code = `${entry.feature}-${suffix()}`;
    const payload = await canonicalPayload(page, entry, code);
    const created = await json<{ id: string; version: number }>(
      await canonicalMutation(page, `/${entry.resource}`, payload),
    );
    const stale = await canonicalMutation(
      page,
      `/${entry.resource}/${created.id}/transition`,
      {
        toState: "INACTIVE",
        expectedVersion: 999,
        reason: "Stale acceptance transition",
      },
    );
    expect(stale.status()).toBe(409);
    const inactive = await canonicalMutation(
      page,
      `/${entry.resource}/${created.id}/transition`,
      {
        toState: "INACTIVE",
        expectedVersion: created.version,
        reason: "Canonical acceptance deactivation",
      },
    );
    expect(inactive.status(), await inactive.text()).toBe(200);
    expect(await inactive.json()).toMatchObject({ state: "INACTIVE" });
  });

  test(`E2E-FOUND-${entry.feature}-05 report reconciles list status totals`, async ({
    page,
  }) => {
    await ownerTenant(page, `${entry.feature}Report`);
    const firstPayload = await canonicalPayload(
      page,
      entry,
      `${entry.feature}-${suffix()}`,
    );
    const first = await json<{ id: string; version: number }>(
      await canonicalMutation(page, `/${entry.resource}`, firstPayload),
    );
    const secondPayload = await canonicalPayload(
      page,
      entry,
      `${entry.feature}-${suffix()}`,
    );
    expect(
      (
        await canonicalMutation(page, `/${entry.resource}`, secondPayload)
      ).status(),
    ).toBe(201);
    const transition = await canonicalMutation(
      page,
      `/${entry.resource}/${first.id}/transition`,
      {
        toState: "INACTIVE",
        expectedVersion: first.version,
        reason: "Report state reconciliation",
      },
    );
    expect(transition.status(), await transition.text()).toBe(200);
    const list = await json<{
      total: number;
      items: Array<{ state: string }>;
    }>(await api(page, endpoint));
    const report = await json<{
      rows: Array<{ state: string; count: number }>;
    }>(await api(page, `${endpoint}/report`));
    expect(
      report.rows.reduce((total, row) => total + Number(row.count), 0),
    ).toBe(list.total);
    for (const row of report.rows)
      expect(
        list.items.filter((item) => item.state === row.state),
      ).toHaveLength(Number(row.count));
  });
}
