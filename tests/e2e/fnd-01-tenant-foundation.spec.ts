import { expect, test } from "@playwright/test";
import {
  acceptInvitation,
  api,
  createProbe,
  expectNoSeriousAccessibilityViolations,
  expectNoPageOverflow,
  fillTenantForm,
  login,
  openTenantForm,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";

test.describe.configure({ mode: "serial" });

test("E2E-FND01-01: Platform Admin provisions a tenant and its owner accepts the single invitation", async ({
  page,
}) => {
  const tenant = tenantFixture("Indigo");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Tenants", exact: true }),
  ).toBeVisible();
  await openTenantForm(page);
  await fillTenantForm(page, tenant);

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const created = (await response.json()) as {
    tenant: { id: string };
    invitation: { expiresAt: string };
    invitationUrl: string;
  };
  expect(new Date(created.invitation.expiresAt).getTime()).toBeGreaterThan(
    Date.now(),
  );
  await expect(page.getByRole("status")).toContainText("Tenant provisioned");

  const detail = await api(page, `/platform/tenants/${created.tenant.id}`);
  expect(detail.status()).toBe(200);
  const detailBody = (await detail.json()) as {
    invitations: Array<{ acceptedAt: string | null }>;
    tenant: { setup_complete: number; setup_total: number };
  };
  expect(detailBody.invitations).toHaveLength(1);
  expect(detailBody.tenant).toMatchObject({
    setup_complete: 1,
    setup_total: 8,
  });

  await acceptInvitation(page, created.invitationUrl, tenant.ownerName);
  await expect(page.getByRole("heading", { name: tenant.name })).toBeVisible();
  await expect(
    page.getByText(
      `${tenant.locale} · ${tenant.currency} · ${tenant.timezone}`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Branding" }),
  ).toContainText("COMPLETE");
  await page.getByRole("button", { name: "Reopen branding setup" }).click();
  await expect(
    page.getByText("Branding setup reopened.", { exact: true }),
  ).toHaveText("Branding setup reopened.");
  await expect(
    page.getByRole("listitem").filter({ hasText: "Branding" }),
  ).toContainText("NOT STARTED");
  await page
    .getByRole("button", { name: "Mark branding setup complete" })
    .click();
  await expect(
    page.getByText("Branding setup marked complete.", { exact: true }),
  ).toHaveText("Branding setup marked complete.");
  await page.reload();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Branding" }),
  ).toContainText("COMPLETE");
  await expectNoSeriousAccessibilityViolations(page, "tenant setup");
  await expectNoPageOverflow(page);
});

test("E2E-FND01-02: validation focuses errors and creates no partial tenant state", async ({
  page,
}) => {
  const tenant = tenantFixture("Validate");
  await login(page);
  const tenantCount = async () =>
    (
      (await (
        await api(page, `/platform/tenants?search=${tenant.code}`)
      ).json()) as { total: number }
    ).total;
  expect(await tenantCount()).toBe(0);
  await openTenantForm(page);

  const provision = page.getByRole("button", { name: "Provision tenant" });
  await expect(provision).toBeDisabled();
  expect(
    await page
      .getByLabel("Tenant name")
      .evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false);
  expect(await tenantCount()).toBe(0);

  await fillTenantForm(page, tenant);
  await page.getByLabel("Locale").fill("not_a_locale");
  const invalidResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  expect((await invalidResponse).status()).toBe(400);
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Check the highlighted fields",
  );
  await expect(page.locator(".error[role=alert]")).toBeFocused();
  const locale = page.getByLabel("Locale");
  await expect(locale).toHaveAttribute("aria-invalid", "true");
  const describedBy = await locale.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toContainText("Invalid locale");
  await expect(
    page.locator('.error[role="alert"] a[href="#locale"]'),
  ).toContainText("locale");
  await expectNoSeriousAccessibilityViolations(page, "tenant form validation");
  expect(await tenantCount()).toBe(0);

  await locale.fill(tenant.locale);
  await expect(locale).not.toHaveAttribute("aria-invalid", "true");
  await expect(locale).not.toHaveAttribute("aria-describedby", /.+/);
  await page.getByRole("button", { name: "Provision tenant" }).click();
  await expect(page.getByRole("status")).toContainText("Tenant provisioned");
  expect(await tenantCount()).toBe(1);

  await openTenantForm(page);
  await page.getByLabel("PIN code").clear();
  await fillTenantForm(page, {
    ...tenant,
    ownerEmail: `duplicate-${tenant.ownerEmail}`,
  });
  await page.getByRole("button", { name: "Provision tenant" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Tenant code is already in use",
  );
  expect(await tenantCount()).toBe(1);
  await expectNoPageOverflow(page);
});

test("E2E-FND01-03: tenant owner cannot access platform or another tenant through HTTP, document, export, report, or WebSocket channels", async ({
  browser,
  page,
}) => {
  const tenantA = tenantFixture("Alpha");
  const tenantB = tenantFixture("Bravo");
  await login(page);
  const createdA = await provisionViaApi(page, tenantA);
  const createdB = await provisionViaApi(page, tenantB);

  const ownerAContext = await browser.newContext();
  const ownerAPage = await ownerAContext.newPage();
  await acceptInvitation(ownerAPage, createdA.invitationUrl, tenantA.ownerName);
  const probeA = await createProbe(
    ownerAPage,
    "Alpha retained",
    "Alpha membership suspension evidence",
  );
  const ownerBContext = await browser.newContext();
  const ownerBPage = await ownerBContext.newPage();
  await acceptInvitation(ownerBPage, createdB.invitationUrl, tenantB.ownerName);
  const secret = `BRAVO-SECRET-${crypto.randomUUID()}`;
  const probeB = await createProbe(ownerBPage, "Bravo confidential", secret);

  await expect(ownerAPage.getByLabel("Active tenant")).toHaveCount(0);
  await expect(ownerAPage.getByRole("link", { name: "Tenants" })).toHaveCount(
    0,
  );
  const platformDenied = await api(ownerAPage, "/platform/tenants");
  expect(platformDenied.status()).toBe(403);
  expect(JSON.stringify(await platformDenied.json())).not.toContain(
    tenantB.name,
  );

  for (const path of [
    `/tenant/probes/${probeB.id}`,
    `/tenant/probes/${probeB.id}/document`,
  ]) {
    const denied = await api(ownerAPage, path, {
      headers: { "X-Tenant-Id": createdB.tenant.id },
    });
    expect(denied.status()).toBe(404);
    expect(await denied.text()).not.toContain(secret);
  }
  const list = await api(
    ownerAPage,
    `/tenant/probes?tenantId=${createdB.tenant.id}&search=Bravo`,
  );
  expect(list.status()).toBe(200);
  expect(await list.text()).not.toContain(secret);
  const report = await api(
    ownerAPage,
    `/tenant/probes/report?tenantId=${createdB.tenant.id}`,
  );
  expect(report.status()).toBe(200);
  expect(await report.text()).not.toContain(secret);
  const exported = await api(
    ownerAPage,
    `/tenant/probes/export?tenantId=${createdB.tenant.id}`,
  );
  expect(exported.status()).toBe(200);
  expect(await exported.text()).not.toContain(secret);

  const websocket = await ownerAPage.request.get(
    "http://127.0.0.1:4000/api/v1/events",
    {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "X-Tenant-Id": createdB.tenant.id,
      },
      failOnStatusCode: false,
    },
  );
  expect(websocket.status()).toBe(404);
  expect(await websocket.text()).not.toContain(secret);

  const ownerIdentity = (await (await api(ownerAPage, "/auth/me")).json()) as {
    user: { id: string };
  };
  const suspended = await api(page, "/test/memberships/status", {
    method: "POST",
    data: {
      tenantId: createdA.tenant.id,
      userId: ownerIdentity.user.id,
      status: "SUSPENDED",
    },
  });
  expect(suspended.status(), await suspended.text()).toBe(200);
  for (const path of [
    "/tenant/context",
    "/tenant/probes",
    "/tenant/probes/report",
    "/tenant/probes/export",
    `/tenant/probes/${probeA.id}`,
    `/tenant/probes/${probeA.id}/document`,
  ]) {
    const denied = await api(ownerAPage, path);
    expect(denied.status(), `suspended current request ${path}`).toBe(401);
    expect(await denied.text()).not.toContain(
      "Alpha membership suspension evidence",
    );
  }
  await ownerAPage.reload();
  await expect(ownerAPage).toHaveURL(/\/login\?reason=access-changed$/);
  await ownerAContext.close();
  await ownerBContext.close();
});

test("E2E-FND01-04: provisioning failure rolls back and tenant deactivation/reactivation preserves data", async ({
  browser,
  page,
}) => {
  const tenantA = tenantFixture("Recover");
  const tenantC = tenantFixture("Failure");
  await login(page);
  const createdA = await provisionViaApi(page, tenantA);

  await openTenantForm(page);
  await fillTenantForm(page, tenantC);
  await page.route("**/api/v1/platform/tenants", async (route) => {
    if (route.request().method() === "POST") {
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-test-failure": "provision-after-defaults",
        },
      });
    } else await route.continue();
  });
  const failedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  expect((await failedResponse).status()).toBe(500);
  await expect(page.locator(".error[role=alert]")).toContainText(
    "retry with the same request",
  );
  const noPartial = (await (
    await api(page, `/platform/tenants?search=${tenantC.code}`)
  ).json()) as { total: number };
  expect(noPartial.total).toBe(0);
  await page.unroute("**/api/v1/platform/tenants");
  await page.getByRole("button", { name: "Provision tenant" }).click();
  await expect(page.getByRole("status")).toContainText("Tenant provisioned");
  const alertResponse = await api(page, "/platform/alerts");
  const alerts = (await alertResponse.json()) as Array<{
    type: string;
    summary: string;
  }>;
  expect(
    alerts.filter((alert) => alert.type === "TENANT_PROVISIONING_FAILED")
      .length,
  ).toBeGreaterThanOrEqual(1);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await acceptInvitation(ownerPage, createdA.invitationUrl, tenantA.ownerName);
  const marker = `retained-${crypto.randomUUID()}`;
  await createProbe(ownerPage, marker, "Survives lifecycle changes");
  await ownerPage.reload();
  await expect(ownerPage.getByText(marker)).toBeVisible();

  await page.goto(`/platform/tenants/${createdA.tenant.id}`);
  await expect(page.getByRole("heading", { name: tenantA.name })).toBeVisible();
  await page.getByLabel(`Type ${tenantA.code} to confirm`).fill(tenantA.code);
  await page.getByLabel("Reason").fill("Temporary operational suspension");
  await page.getByRole("button", { name: "Deactivate tenant" }).click();
  await expect(page.getByText("INACTIVE", { exact: true })).toBeVisible();
  await ownerPage.reload();
  await expect(ownerPage).toHaveURL(/\/login\?reason=access-changed$/);

  await page.getByLabel("Reason").fill("Operational service restored");
  await page.getByRole("button", { name: "Reactivate tenant" }).click();
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  await login(ownerPage, tenantA.ownerEmail, "OwnerPassword!234");
  await ownerPage.goto("/app/setup");
  await expect(ownerPage.getByText(marker)).toBeVisible();
  await ownerContext.close();
});

test("E2E-FND01-05: tenant switch clears stale tenant data and platform report reconciles", async ({
  browser,
  page,
}) => {
  const tenantA = tenantFixture("Indigo");
  const tenantB = {
    ...tenantFixture("Amber"),
    ownerEmail: tenantA.ownerEmail,
    timezone: "America/New_York",
    locale: "en-US",
    currency: "USD",
    primaryColor: "#7c2d12",
    accentColor: "#fbbf24",
  };
  await login(page);
  const createdA = await provisionViaApi(page, tenantA);
  const createdB = await provisionViaApi(page, tenantB);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await acceptInvitation(owner, createdA.invitationUrl, tenantA.ownerName);
  const aMarker = `INDIGO-${crypto.randomUUID()}`;
  await createProbe(owner, aMarker, "Tenant A only");
  await owner.goto(createdB.invitationUrl);
  await expect(
    owner.getByText("This email already has an account", { exact: false }),
  ).toBeVisible();
  await owner.getByLabel("Existing account password").fill("WrongPassword!234");
  await owner.getByLabel(/I accept/).check();
  await owner.getByRole("button", { name: "Accept invitation" }).click();
  await expect(owner.locator(".error[role=alert]")).toContainText(
    "Invitation or credentials could not be verified",
  );
  await expect(
    owner.getByRole("heading", { name: `Join ${tenantB.name}` }),
  ).toBeVisible();
  await owner.getByLabel("Existing account password").fill("OwnerPassword!234");
  await owner.getByRole("button", { name: "Accept invitation" }).click();
  await expect(owner).toHaveURL(/\/app\/setup/);
  await expect(
    owner.getByRole("heading", { name: tenantB.name }),
  ).toBeVisible();
  const bMarker = `AMBER-${crypto.randomUUID()}`;
  await createProbe(owner, bMarker, "Tenant B only");
  await owner.reload();

  await expect(
    owner.getByRole("heading", { name: tenantB.name }),
  ).toBeVisible();
  await expect(
    owner.getByText(
      `${tenantB.locale} · ${tenantB.currency} · ${tenantB.timezone}`,
    ),
  ).toBeVisible();
  await expect(owner.getByText(bMarker)).toBeVisible();
  await expect(owner.getByText(aMarker)).toHaveCount(0);
  await owner.getByLabel("Active tenant").selectOption(createdA.tenant.id);
  await expect(owner).toHaveURL(/context=\d+/);
  await expect(
    owner.getByRole("heading", { name: tenantA.name }),
  ).toBeVisible();
  await expect(owner.getByText(aMarker)).toBeVisible();
  await expect(owner.getByText(bMarker)).toHaveCount(0);
  await owner.getByLabel("Active tenant").selectOption(createdB.tenant.id);
  await expect(
    owner.getByRole("heading", { name: tenantB.name }),
  ).toBeVisible();

  await owner.getByRole("button", { name: "Sign out" }).click();
  await expect(owner).toHaveURL(/\/login$/);
  await owner.getByLabel("Email").fill(tenantA.ownerEmail);
  await owner.getByLabel("Password").fill("ReplacementPassword!234");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await expect(owner.locator(".error[role=alert]")).toContainText(
    "Email or password is incorrect",
  );
  await owner.getByLabel("Password").fill("OwnerPassword!234");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await expect(owner.getByLabel("Workspace")).toBeFocused();
  await expect(owner.getByLabel("Workspace").locator("option")).toHaveCount(3);
  await expect(owner.getByLabel("Workspace")).toContainText(tenantA.name);
  await expect(owner.getByLabel("Workspace")).toContainText(tenantB.name);
  await expect(owner.getByLabel("Workspace")).not.toContainText(aMarker);
  await owner.getByLabel("Workspace").selectOption(tenantA.code);
  await owner.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(owner).toHaveURL(/\/app$/);
  await owner.goto("/app/setup");
  await expect(
    owner.getByRole("heading", { name: tenantA.name }),
  ).toBeVisible();
  await expect(owner.getByText(aMarker)).toBeVisible();
  await expect(owner.getByText(bMarker)).toHaveCount(0);

  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.getByLabel("Email").fill(tenantA.ownerEmail);
  await owner.getByLabel("Password").fill("OwnerPassword!234");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.getByLabel("Workspace").selectOption(tenantB.code);
  await owner.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(owner).toHaveURL(/\/app$/);
  await owner.goto("/app/setup");
  await expect(
    owner.getByRole("heading", { name: tenantB.name }),
  ).toBeVisible();
  await expect(owner.getByText(bMarker)).toBeVisible();
  await expect(owner.getByText(aMarker)).toHaveCount(0);

  await page.goto("/platform/report");
  const reportResponse = await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/platform/report") &&
      response.status() === 200,
  );
  const canonical = (await reportResponse.json()) as {
    totals: { total: number; active: number; inactive: number };
  };
  await expect(
    page.getByRole("heading", { name: "Platform health" }),
  ).toBeVisible();
  await expect(
    page.getByText("Total tenants").locator("..").getByRole("strong"),
  ).toHaveText(String(canonical.totals.total));
  await expect(
    page.getByText("Active", { exact: true }).locator("..").getByRole("strong"),
  ).toHaveText(String(canonical.totals.active));
  await expect(
    page
      .getByText("Inactive", { exact: true })
      .locator("..")
      .getByRole("strong"),
  ).toHaveText(String(canonical.totals.inactive));
  await expect(
    page.getByRole("row", { name: new RegExp(tenantA.code) }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(tenantB.code) }),
  ).toBeVisible();
  await expect(page.getByText(aMarker)).toHaveCount(0);
  await expect(page.getByText(bMarker)).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page, "platform health report");
  await ownerContext.close();
});

test("FND01-X-001: primary screens expose keyboard focus, names, status, and error semantics", async ({
  page,
}) => {
  await page.goto("/login");
  await expectNoSeriousAccessibilityViolations(page, "login");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await page
    .getByLabel("Email")
    .fill(`missing-${crypto.randomUUID()}@test.local`);
  await page.getByLabel("Password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Email or password is incorrect",
  );
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toHaveAccessibleName("Welcome back");
  await expectNoSeriousAccessibilityViolations(page, "login error state");
});

test("FND01-X-002: narrow and desktop views avoid page overflow and recover from a failed read", async ({
  page,
}) => {
  await login(page);
  await expectNoPageOverflow(page);
  let failOnce = true;
  await page.route("**/api/v1/platform/report", async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TEMPORARY",
          message: "Health data is temporarily unavailable",
        }),
      });
    } else await route.continue();
  });
  await page.goto("/platform/report");
  await expect(page.locator(".error[role=alert]")).toContainText(
    "temporarily unavailable",
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", { name: "Tenant health detail" }),
  ).toBeVisible();
  await expect(
    page.locator('[aria-label="Tenant health table"]'),
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("E2E-FND01-PIN-01: PostgreSQL PIN lookup derives and persists a canonical tenant address", async ({
  browser,
  page,
}) => {
  const tenant = {
    ...tenantFixture("Postal"),
    postalCode: "110001",
    city: "New Delhi",
    region: "Delhi",
  };
  await login(page);
  await openTenantForm(page);
  await fillTenantForm(page, {
    ...tenant,
    postalCode: "700001",
    city: "Kolkata",
    region: "West Bengal",
  });

  const before = await api(page, `/platform/tenants?search=${tenant.code}`);
  expect(before.status()).toBe(200);
  expect(((await before.json()) as { total: number }).total).toBe(0);

  const pin = page.getByLabel("PIN code");
  await pin.fill("012345");
  await pin.blur();
  expect(
    await pin.evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false);
  await expect(
    page.getByRole("status").filter({ hasText: "Enter exactly six digits" }),
  ).toBeVisible();
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("State", { exact: true })).toHaveValue("");

  const unknownResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("postalCode=999999"),
  );
  await pin.fill("999999");
  expect((await unknownResponse).status()).toBe(404);
  await expect(
    page.getByRole("status").filter({ hasText: "not in the postal directory" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry PIN lookup" }),
  ).toBeVisible();
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("");

  const singleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("postalCode=700001"),
  );
  await pin.fill("700001");
  expect((await singleResponse).status()).toBe(200);
  await expect(page.getByLabel("City", { exact: true })).toHaveValue("Kolkata");
  await expect(page.getByLabel("State", { exact: true })).toHaveValue(
    "West Bengal",
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Derived Kolkata, West Bengal" }),
  ).toContainText("Kolkata GPO, Kolkata district");
  await expect(page.getByLabel("City", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByLabel("State", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );

  const ambiguousResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("postalCode=110001"),
  );
  await pin.fill("110001");
  expect((await ambiguousResponse).status()).toBe(200);
  const locality = page.getByLabel("Locality");
  await expect(locality).toBeVisible();
  await expect(locality).toHaveValue("");
  await expect(locality.locator("option")).toHaveText([
    "Select locality",
    "Connaught Place — New Delhi district",
    "Parliament Street — New Delhi district",
  ]);
  await locality.focus();
  await page.keyboard.press("c");
  await page.keyboard.press("Tab");
  await expect(locality).toHaveValue("11000100-0000-4000-8000-000000000001");
  await expect(page.getByLabel("City", { exact: true })).toHaveValue(
    "New Delhi",
  );
  await expect(page.getByLabel("State", { exact: true })).toHaveValue("Delhi");
  await expect(
    page.getByRole("status").filter({ hasText: "Derived New Delhi, Delhi" }),
  ).toContainText("Connaught Place, New Delhi district");

  await expectNoSeriousAccessibilityViolations(page, "tenant PIN lookup");
  await expectNoPageOverflow(page);
  const line1 = page.getByLabel("Address line 1");
  const line2 = page.getByLabel("Address line 2");
  await locality.evaluate((select: HTMLSelectElement) => {
    const stale = document.createElement("option");
    stale.value = "70000100-0000-4000-8000-000000000001";
    stale.text = "Previously selected locality";
    stale.selected = true;
    select.append(stale);
  });
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  const refreshedLookup = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("postalCode=110001"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  expect((await staleResponse).status()).toBe(409);
  expect((await refreshedLookup).status()).toBe(200);
  await expect(page.locator(".error[role=alert]")).toContainText(
    "selected locality is no longer valid",
  );
  await expect(line1).toHaveValue(tenant.line1);
  await expect(line2).toHaveValue(tenant.line2);
  await expect(locality).toHaveValue("");
  await expect(locality.locator("option")).toHaveText([
    "Select locality",
    "Connaught Place — New Delhi district",
    "Parliament Street — New Delhi district",
  ]);
  await locality.selectOption("11000100-0000-4000-8000-000000000001");
  await expect(locality).toHaveValue("11000100-0000-4000-8000-000000000001");

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/platform/tenants"),
  );
  await page.getByRole("button", { name: "Provision tenant" }).click();
  const response = await createdResponse;
  expect(response.status(), await response.text()).toBe(201);
  const created = (await response.json()) as {
    tenant: { id: string };
    invitationUrl: string;
  };

  const detailResponse = await api(
    page,
    `/platform/tenants/${created.tenant.id}`,
  );
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()) as {
    tenant: {
      address: {
        country: string;
        postalCode: string;
        postalLocalityId: string;
        locality: string;
        city: string;
        region: string;
        directoryVersion: string;
        postalReferenceStatus: string;
      };
    };
    invitations: unknown[];
  };
  expect(detail.tenant.address).toMatchObject({
    country: "IN",
    postalCode: "110001",
    postalLocalityId: "11000100-0000-4000-8000-000000000001",
    locality: "Connaught Place",
    city: "New Delhi",
    region: "Delhi",
    directoryVersion: "2026-08-25-fixture",
    postalReferenceStatus: "DIRECTORY",
  });
  expect(detail.invitations).toHaveLength(1);
  const after = await api(page, `/platform/tenants?search=${tenant.code}`);
  expect(((await after.json()) as { total: number }).total).toBe(1);

  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();
  const anonymousLookup = await api(
    anonymous,
    "/reference/postal-localities?country=IN&postalCode=700001",
  );
  expect(anonymousLookup.status()).toBe(401);
  expect(await anonymousLookup.text()).not.toContain("Kolkata GPO");
  await anonymousContext.close();

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await acceptInvitation(owner, created.invitationUrl, tenant.ownerName);
  const tenantOnlyLookup = await api(
    owner,
    "/reference/postal-localities?country=IN&postalCode=700001",
  );
  expect(tenantOnlyLookup.status()).toBe(403);
  expect(await tenantOnlyLookup.text()).not.toContain("Kolkata GPO");
  await ownerContext.close();
});
