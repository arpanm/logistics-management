import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  accessApi,
  actorPage,
  expectAccessibleResponsive,
  inviteThroughUi,
  loginActor,
  rawSensitiveValues,
  seedFnd02,
  type ActorFixture,
  type Fnd02Fixture,
  type ResourceFixture,
} from "../fixtures/fnd02";

const requiredActor = (
  fixture: Fnd02Fixture,
  key: keyof Fnd02Fixture["actors"],
) => {
  const actor = fixture.actors[key];
  expect(actor, `fixture actor ${String(key)}`).toBeTruthy();
  return actor as ActorFixture;
};

const requiredResource = (fixture: Fnd02Fixture, key: string) => {
  const resource = fixture.resources[key];
  expect(resource, `fixture resource ${key}`).toBeTruthy();
  return resource as ResourceFixture;
};

async function body(response: APIResponse) {
  return (await response.json()) as Record<string, unknown>;
}

async function expectDenied(response: APIResponse) {
  expect(response.status()).toBe(404);
  expect(await body(response)).toMatchObject({
    code: "RESOURCE_NOT_FOUND",
    message: "Resource not found",
  });
}

async function operationPreview(
  page: Page,
  capability: string,
  action: string,
  resourceId: string,
) {
  const response = await accessApi(page, "/operations/preview", {
    method: "POST",
    data: { capability, action, resourceId },
  });
  expect(response.status(), await response.text()).toBe(200);
  return body(response);
}

test("E2E-FND02-01: invitation validation, identity verification, MFA, and role home", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "SCOPES_ONLY");
  const ownerSession = await actorPage(browser, fixture.actors.owner);
  const owner = ownerSession.page;
  await owner.goto("/app/access/users");
  await expect(
    owner.getByRole("heading", { name: "User directory" }),
  ).toBeVisible();

  const before = await accessApi(owner, "/users");
  const beforeCount = Number((await body(before)).total);
  const invalidResponse = owner.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/tenant/access/users"),
  );
  await owner
    .getByRole("button", { name: /Review.*send invitation|Send invitation/ })
    .click();
  expect((await invalidResponse).status()).toBe(400);
  const validationAlert = owner.locator("main [role=alert]");
  await expect(validationAlert).toBeFocused();
  await expect(validationAlert).toContainText(
    /highlighted fields|Email or mobile|required/i,
  );
  const afterInvalid = await accessApi(owner, "/users");
  expect(Number((await body(afterInvalid)).total)).toBe(beforeCount);

  const suffix = fixture.namespace.slice(-8).toLowerCase();
  const invited = await inviteThroughUi(owner, {
    displayName: `Regional ${suffix}`,
    employeeCode: `RM-${suffix}`.toUpperCase(),
    email: `regional-${suffix}@test.local`,
    portalAudience: "INTERNAL",
    roleName: "Regional Manager",
    scopePath: "North",
    actions: ["READ", "CREATE", "UPDATE", "EXPORT"],
  });
  expect(invited.response.status(), await invited.response.text()).toBe(201);
  const pendingCard = owner
    .locator("article.access-card")
    .filter({ hasText: `RM-${suffix}`.toUpperCase() });
  await pendingCard.getByRole("button", { name: "View details" }).click();
  const activationPanel = owner.getByRole("dialog");
  await expect(
    activationPanel.getByRole("heading", { name: "Pending activation" }),
  ).toBeVisible();
  const activationResponse = owner.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/tenant/access/users/${invited.body.membershipId}/invitations/resend`,
        ),
  );
  await activationPanel
    .getByRole("button", { name: "Generate new activation link" })
    .click();
  expect((await activationResponse).status()).toBe(200);
  const activationLink = activationPanel.getByLabel("New activation link");
  await expect(activationLink).toHaveValue(
    /^http:\/\/127\.0\.0\.1:3000\/accept-access\?token=/,
  );
  const activationUrl = await activationLink.inputValue();
  await activationPanel
    .getByRole("button", { name: "Close user details" })
    .click();

  const invitedContext = await browser.newContext();
  const invitedPage = await invitedContext.newPage();
  await invitedPage.goto(activationUrl);
  await expect(
    invitedPage.getByRole("heading", { name: "Accept access invitation" }),
  ).toBeVisible();
  await expect(invitedPage).toHaveURL(/\/accept-access$/);
  await invitedPage.getByLabel("Display name").fill(`Regional ${suffix}`);
  await invitedPage.getByLabel("Create password").fill("RegionalPass!234");
  await invitedPage.getByLabel("Confirm password").fill("RegionalPass!234");
  await invitedPage.getByRole("checkbox", { name: /I accept/i }).check();
  await invitedPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitedPage).toHaveURL(/\/mfa$/);

  const setupResponse = invitedPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/auth/mfa/totp/setup"),
  );
  await invitedPage
    .getByRole("button", { name: "Set up authenticator" })
    .click();
  const setup = (await (await setupResponse).json()) as {
    testCodes: [string, string];
  };
  expect(setup.testCodes).toHaveLength(2);
  await invitedPage.getByLabel(/First.*code/).fill(setup.testCodes[0]);
  await invitedPage.getByLabel(/Next.*code/).fill(setup.testCodes[1]);
  await invitedPage.getByRole("button", { name: "Verify" }).click();
  await expect(
    invitedPage.getByText("MFA is active", { exact: false }),
  ).toBeVisible();
  await expect(invitedPage.locator("li code")).toHaveCount(10);
  await invitedPage.getByRole("button", { name: /saved.*codes/i }).click();
  await expect(invitedPage).toHaveURL(/\/app$/);
  await expect(
    invitedPage.getByRole("heading", { name: "Operations access home" }),
  ).toBeVisible();
  const effective = await accessApi(invitedPage, "/effective");
  expect(effective.status()).toBe(200);
  expect(await body(effective)).toMatchObject({ home: "/app" });

  const directory = await accessApi(owner, `/users?search=RM-${suffix}`);
  expect(Number((await body(directory)).total)).toBe(1);
  await expectAccessibleResponsive(invitedPage, "role-appropriate access home");
  await invitedContext.close();
  await ownerSession.context.close();
});

test("E2E-FND02-02: access lifecycle invalidates two sessions and restores narrower access", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const kam = requiredActor(fixture, "kam");
  const northDiagnostic = requiredResource(fixture, "north");
  const ownerSession = await actorPage(browser, fixture.actors.owner);
  const first = await actorPage(browser, kam);
  const second = await actorPage(browser, kam);

  await ownerSession.page.goto("/app/access/probes");
  await expect(
    ownerSession.page.getByRole("heading", { name: "Permission tester" }),
  ).toBeVisible();
  const diagnosticCard = ownerSession.page
    .locator("article.access-card")
    .filter({ hasText: northDiagnostic.label });
  await diagnosticCard
    .getByRole("button", { name: "Test read permission" })
    .click();
  await expect(
    ownerSession.page
      .getByRole("status")
      .filter({
        has: ownerSession.page.getByRole("heading", {
          name: "Permission decision",
        }),
      })
      .getByText("Allowed", { exact: true }),
  ).toBeVisible();

  const current = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}`,
  );
  const currentUser = await body(current);
  const preview = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}/preview`,
    {
      method: "POST",
      data: {
        expectedVersion: Number(currentUser.version),
        assignments: currentUser.assignments,
      },
    },
  );
  expect(preview.status(), await preview.text()).toBe(200);
  const previewBody = await body(preview);
  const changed = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": `change-${fixture.namespace}` },
      data: {
        expectedVersion: Number(currentUser.version),
        assignments: currentUser.assignments,
        reason: "Reconfirm narrow Alpha client access",
        previewFingerprint: previewBody.fingerprint,
      },
    },
  );
  expect(changed.status(), await changed.text()).toBe(200);

  for (const actor of [first, second]) {
    const stale = await accessApi(actor.page, "/effective");
    expect(stale.status()).toBe(401);
    expect(await body(stale)).toMatchObject({ code: "SESSION_STALE" });
    await actor.page.goto("/app/access/probes");
    await expect(actor.page).toHaveURL(/\/login\?reason=access-changed$/);
  }

  const refreshed = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}`,
  );
  let lifecycleUser = await body(refreshed);
  const reset = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}/sessions/reset`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `reset-${fixture.namespace}` },
      data: {
        expectedVersion: Number(lifecycleUser.version),
        reason: "Security session reset",
      },
    },
  );
  expect(reset.status(), await reset.text()).toBe(200);
  lifecycleUser = await body(
    await accessApi(ownerSession.page, `/users/${kam.membershipId}`),
  );
  const suspension = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}/suspend`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `suspend-${fixture.namespace}` },
      data: {
        expectedVersion: Number(lifecycleUser.version),
        reason: "Access review suspension",
      },
    },
  );
  expect(suspension.status(), await suspension.text()).toBe(200);
  await first.context.clearCookies();
  await first.page.goto("/login");
  await first.page.getByLabel(/Email|Email or mobile/).fill(kam.email);
  await first.page.getByLabel("Password").fill(kam.password);
  await first.page
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(first.page.locator("main [role=alert]")).toContainText(
    /incorrect|unavailable/i,
  );

  lifecycleUser = await body(
    await accessApi(ownerSession.page, `/users/${kam.membershipId}`),
  );
  const reactivate = await accessApi(
    ownerSession.page,
    `/users/${kam.membershipId}/reactivate`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `reactivate-${fixture.namespace}` },
      data: {
        expectedVersion: Number(lifecycleUser.version),
        reason: "Access review completed",
      },
    },
  );
  expect(reactivate.status(), await reactivate.text()).toBe(200);
  await loginActor(first.page, kam);
  await first.page.goto("/app/access/probes");
  await expect(
    first.page.getByRole("heading", {
      name: requiredResource(fixture, "client").label,
    }),
  ).toBeVisible();
  await expect(
    first.page.getByRole("heading", {
      name: requiredResource(fixture, "south").label,
    }),
  ).toHaveCount(0);

  const changes = await accessApi(
    ownerSession.page,
    "/reports/permission-changes",
  );
  expect(changes.status(), await changes.text()).toBe(200);
  expect(await changes.text()).toMatch(
    /identity\.access\.changed|identity\.membership\.(suspended|active)|identity\.sessions\.reset/,
  );

  await ownerSession.context.close();
  await first.context.close();
  await second.context.close();
});

test("E2E-FND02-03: internal scope and multi-role preview match all enforced operations", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const north = requiredResource(fixture, "north");
  const south = requiredResource(fixture, "south");
  const alpha = requiredResource(fixture, "client");
  const regionalSession = await actorPage(
    browser,
    requiredActor(fixture, "regional"),
  );
  const kamSession = await actorPage(browser, requiredActor(fixture, "kam"));
  const multiSession = await actorPage(
    browser,
    requiredActor(fixture, "multiRole"),
  );

  for (const [resource, allowed] of [
    [north, true],
    [south, false],
  ] as const) {
    const preview = await operationPreview(
      regionalSession.page,
      "probe.read",
      "READ",
      resource.id,
    );
    expect(preview.allowed).toBe(allowed);
    const actual = await accessApi(
      regionalSession.page,
      `/probes/${resource.id}`,
    );
    expect(actual.status()).toBe(allowed ? 200 : 404);
  }
  const createPreview = await operationPreview(
    regionalSession.page,
    "probe.create",
    "CREATE",
    north.id,
  );
  expect(createPreview.allowed).toBe(true);
  const created = await accessApi(regionalSession.page, "/probes", {
    method: "POST",
    headers: { "Idempotency-Key": `create-${fixture.namespace}` },
    data: {
      label: `Created ${fixture.namespace}`,
      resourceType: "WORK_ITEM",
      scopeNodeIds: [fixture.scopes.north],
      status: "OPEN",
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const updatePreview = await operationPreview(
    regionalSession.page,
    "probe.update",
    "UPDATE",
    north.id,
  );
  expect(updatePreview.allowed).toBe(true);
  const updated = await accessApi(regionalSession.page, `/probes/${north.id}`, {
    method: "PATCH",
    data: { expectedVersion: north.version, label: `${north.label} updated` },
  });
  expect(updated.status(), await updated.text()).toBe(200);
  const approvePreview = await operationPreview(
    regionalSession.page,
    "probe.approve",
    "APPROVE",
    north.id,
  );
  expect(approvePreview.allowed).toBe(false);
  await expectDenied(
    await accessApi(regionalSession.page, `/probes/${north.id}/approve`, {
      method: "POST",
      data: {
        expectedVersion: Number((await body(updated)).version),
        reason: "Representative approval attempt",
      },
    }),
  );
  const exportPreview = await operationPreview(
    regionalSession.page,
    "probe.export",
    "EXPORT",
    north.id,
  );
  expect(exportPreview.allowed).toBe(true);
  const exported = await accessApi(regionalSession.page, "/probes/export");
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain(north.label);

  expect(
    (await operationPreview(kamSession.page, "probe.read", "READ", alpha.id))
      .allowed,
  ).toBe(true);
  expect(
    (await operationPreview(kamSession.page, "probe.read", "READ", south.id))
      .allowed,
  ).toBe(false);
  expect(
    (await operationPreview(multiSession.page, "probe.read", "READ", south.id))
      .allowed,
  ).toBe(false);

  const adminPreview = await operationPreview(
    regionalSession.page,
    "identity.user.admin",
    "ADMIN",
    north.id,
  );
  expect(adminPreview.allowed).toBe(false);
  await expectDenied(
    await accessApi(
      regionalSession.page,
      `/users/${fixture.actors.owner.membershipId}/sessions/reset`,
      {
        method: "POST",
        headers: { "Idempotency-Key": `admin-deny-${fixture.namespace}` },
        data: { expectedVersion: 1, reason: "Representative admin denial" },
      },
    ),
  );
  await regionalSession.page.goto("/app/access/probes");
  await expect(
    regionalSession.page.getByRole("heading", {
      name: `${north.label} updated`,
    }),
  ).toBeVisible();
  await expect(
    regionalSession.page.getByRole("heading", { name: south.label }),
  ).toHaveCount(0);

  await regionalSession.context.close();
  await kamSession.context.close();
  await multiSession.context.close();
});

test("E2E-FND02-04: direct API ID guessing is non-leaking and produces correlated denial audits", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const foreignSeedContext = await browser.newContext();
  const foreignSeedPage = await foreignSeedContext.newPage();
  const foreignFixture = await seedFnd02(
    foreignSeedPage,
    testInfo,
    "ACCESS_MATRIX",
  );
  await foreignSeedContext.close();
  const regional = await actorPage(browser, requiredActor(fixture, "regional"));
  const owner = await actorPage(browser, fixture.actors.owner);
  const candidates = [
    requiredResource(fixture, "south").id,
    requiredResource(foreignFixture, "north").id,
    crypto.randomUUID(),
  ];
  const publicShapes: string[] = [];
  for (const [index, id] of candidates.entries()) {
    const correlationId = `${fixture.namespace}-denial-${index}`;
    const response = await accessApi(
      regional.page,
      `/probes/${id}?tenantId=${foreignFixture.tenantA.id}`,
      {
        headers: {
          "X-Correlation-Id": correlationId,
          "X-Tenant-Id": foreignFixture.tenantA.id,
        },
      },
    );
    expect(response.status()).toBe(404);
    const result = await body(response);
    publicShapes.push(
      JSON.stringify({
        code: result.code,
        message: result.message,
        keys: Object.keys(result)
          .filter((key) => key !== "correlationId")
          .sort(),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(id);
    const evidence = await accessApi(
      owner.page,
      `/reports/security-events?correlationId=${encodeURIComponent(correlationId)}`,
    );
    expect(evidence.status()).toBe(200);
    const eventRows = (await body(evidence)).items as Array<
      Record<string, unknown>
    >;
    const matches = eventRows.filter(
      (row) => row.correlationId === correlationId,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      eventType: "AUTHORIZATION_DENIED",
      outcome: "DENIED",
    });
    expect(String(matches[0]?.safeTargetHash)).not.toContain(id);
    expect(JSON.stringify(matches[0])).not.toContain(id);
  }
  expect(new Set(publicShapes).size).toBe(1);

  const broad = await accessApi(
    regional.page,
    `/probes?search=&tenantId=${foreignFixture.tenantA.id}`,
  );
  const broadText = await broad.text();
  expect(broadText).not.toContain(requiredResource(fixture, "south").label);
  expect(broadText).not.toContain(requiredResource(foreignFixture, "north").id);
  const csv = await accessApi(
    regional.page,
    `/probes/export?tenantId=${foreignFixture.tenantA.id}`,
  );
  const csvText = await csv.text();
  expect(csvText).not.toContain(requiredResource(fixture, "south").label);
  expect(csvText).not.toContain(requiredResource(foreignFixture, "north").id);

  await regional.context.close();
  await owner.context.close();
});

test("E2E-FND02-05: Vendor, Driver, and Client portals enforce scope, reassignment, and masking", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "PORTALS");
  const vendor = await actorPage(browser, requiredActor(fixture, "vendor"));
  const driverA = await actorPage(browser, requiredActor(fixture, "driverA"));
  const client = await actorPage(browser, requiredActor(fixture, "client"));
  const owner = await actorPage(browser, fixture.actors.owner);

  await vendor.page.goto("/portal/vendor");
  await expect(
    vendor.page.getByRole("heading", { name: "Vendor portal" }),
  ).toBeVisible();
  await expect(
    vendor.page.getByRole("heading", {
      name: requiredResource(fixture, "vendor").label,
    }),
  ).toBeVisible();
  await expect(
    vendor.page.getByRole("heading", {
      name: requiredResource(fixture, "north").label,
    }),
  ).toHaveCount(0);

  await driverA.page.goto("/portal/driver");
  await expect(
    driverA.page.getByRole("heading", { name: "Driver portal" }),
  ).toBeVisible();
  const driverTrip = requiredResource(fixture, "trip");
  await expect(
    driverA.page.getByRole("heading", { name: driverTrip.label }),
  ).toBeVisible();
  await expect(
    driverA.page.getByRole("heading", {
      name: requiredResource(fixture, "north").label,
    }),
  ).toHaveCount(0);

  await client.page.goto("/portal/client");
  await expect(
    client.page.getByRole("heading", { name: "Client portal" }),
  ).toBeVisible();
  await expect(
    client.page.getByRole("heading", {
      name: requiredResource(fixture, "client").label,
    }),
  ).toBeVisible();
  await expect(
    client.page.getByRole("heading", {
      name: requiredResource(fixture, "south").label,
    }),
  ).toHaveCount(0);

  // Internal margin 5000 is a substring of the explicitly permitted vendor
  // payment 125000, so assert that field structurally instead of by substring.
  const sensitive = rawSensitiveValues(fixture).filter((raw) => raw !== "5000");
  for (const session of [vendor, driverA, client]) {
    const html = await session.page.locator("body").innerText();
    const json = await (await accessApi(session.page, "/probes")).text();
    for (const raw of sensitive) {
      expect(html).not.toContain(raw);
      expect(json).not.toContain(raw);
    }
    expect(json).not.toContain('"internalMargin":{"value":5000');
  }
  expect(await (await accessApi(vendor.page, "/probes")).text()).toContain(
    '"payment":{"value":125000,"masked":false}',
  );
  for (const session of [driverA, client])
    expect(
      await (await accessApi(session.page, "/probes")).text(),
    ).not.toContain("125000");
  const vendorExport = await accessApi(vendor.page, "/probes/export");
  expect(vendorExport.status()).toBe(404);
  expect(await vendorExport.text()).not.toContain("internalMargin");

  const driverB = requiredActor(fixture, "driverB");
  const reassigned = await accessApi(
    owner.page,
    `/probes/${driverTrip.id}/reassign`,
    {
      method: "POST",
      data: {
        expectedVersion: driverTrip.version,
        assignedUserId: driverB.userId,
        reason: "Replacement driver assigned",
      },
    },
  );
  expect(reassigned.status(), await reassigned.text()).toBe(200);
  expect((await accessApi(driverA.page, "/effective")).status()).toBe(401);
  const driverBSession = await actorPage(browser, driverB);
  await driverBSession.page.goto("/portal/driver");
  await expect(
    driverBSession.page.getByRole("heading", { name: driverTrip.label }),
  ).toBeVisible();
  const action = await accessApi(
    driverBSession.page,
    `/probes/${driverTrip.id}`,
    {
      method: "PATCH",
      data: {
        expectedVersion: Number((await body(reassigned)).version),
        status: "COMPLETED",
      },
    },
  );
  expect(action.status(), await action.text()).toBe(200);

  for (const session of [vendor, driverA, client, owner, driverBSession])
    await session.context.close();
});

test("E2E-FND02-06: reports and alerts reconcile access evidence on accessible desktop and mobile surfaces", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "REPORTS");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.page.goto("/app/access/reports");
  await expect(
    owner.page.getByRole("heading", { name: "Activity & audit" }),
  ).toBeVisible();
  await expect(owner.page.getByLabel("Search")).toBeVisible();

  for (const [option, type, tableLabel] of [
    ["Users", "users", "Users results"],
    ["Role assignments", "roles", "Roles results"],
    ["Dormant users", "dormant", "Dormant results"],
    ["Failed logins", "failed-logins", "Failed Logins results"],
    ["Active sessions", "sessions", "Sessions results"],
    ["Privileged actions", "privileged-actions", "Privileged Actions results"],
    ["Permission changes", "permission-changes", "Permission Changes results"],
    [
      "Authentication & authorization events",
      "security-events",
      "Security Events results",
    ],
  ] as const) {
    await owner.page
      .getByLabel("Evidence view")
      .selectOption({ label: option });
    await expect(
      owner.page.getByRole("status", { name: /Loading report/ }),
    ).toHaveCount(0);
    const response = await accessApi(owner.page, `/reports/${type}`);
    expect(response.status(), await response.text()).toBe(200);
    const report = await body(response);
    expect(Number(report.total)).toBeGreaterThanOrEqual(0);
    if (Number(report.total) > 0)
      await expect(
        owner.page.locator(`[aria-label="${tableLabel}"] table`),
      ).toBeVisible();
    else
      await expect(owner.page.getByText("No matching evidence.")).toBeVisible();
    await expect(owner.page.locator("main pre")).toHaveCount(0);
  }
  const alerts = await accessApi(owner.page, "/alerts");
  expect(alerts.status()).toBe(200);
  const alertBody = await body(alerts);
  expect(Number(alertBody.total)).toBe(fixture.expected.alerts);
  expect(JSON.stringify(alertBody)).toContain("REPEATED_LOGIN_FAILURES");

  await expectAccessibleResponsive(owner.page, "identity reports and alerts");
  for (const route of [
    "/app/access/users",
    "/app/access/roles",
    "/app/access/probes",
    "/app/access/reports",
  ]) {
    await owner.page.goto(route);
    await expectAccessibleResponsive(owner.page, route);
  }
  for (const key of ["vendor", "driverA", "client"] as const) {
    const actor = requiredActor(fixture, key);
    const session = await actorPage(browser, actor);
    await session.page.goto(actor.home);
    await expectAccessibleResponsive(session.page, `${key} portal`);
    await session.context.close();
  }
  await owner.context.close();
});

test("E2E-FND02-07: structured user administration and pending activation link copy", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await owner.page.goto("/app/access/users");

  const regionalCard = owner.page
    .locator("article.access-card")
    .filter({ hasText: "FX-REGIONAL" });
  await regionalCard.getByRole("button", { name: "View details" }).click();
  const details = owner.page.getByRole("dialog");
  await expect(details.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(
    details.getByText("Employee code", { exact: true }),
  ).toBeVisible();
  await expect(
    details.locator('[aria-label="Role and scope assignments"] table'),
  ).toBeVisible();
  await expect(details.locator("pre")).toHaveCount(0);
  await details.getByRole("button", { name: "Close user details" }).click();

  await regionalCard.getByRole("button", { name: "Suspend" }).click();
  await expect(
    owner.page
      .locator("article.access-card")
      .filter({ hasText: "FX-REGIONAL" })
      .getByText("SUSPENDED", { exact: true }),
  ).toBeVisible();
  await owner.page
    .locator("article.access-card")
    .filter({ hasText: "FX-REGIONAL" })
    .getByRole("button", { name: "Reactivate" })
    .click();
  await expect(
    owner.page
      .locator("article.access-card")
      .filter({ hasText: "FX-REGIONAL" })
      .getByText("ACTIVE", { exact: true }),
  ).toBeVisible();

  const suffix = fixture.namespace.slice(-8).toLowerCase();
  const invited = await inviteThroughUi(owner.page, {
    displayName: `Pending ${suffix}`,
    employeeCode: `PN-${suffix}`.toUpperCase(),
    email: `pending-${suffix}@test.local`,
    portalAudience: "INTERNAL",
    roleName: "Regional Manager",
    scopePath: "North",
    actions: ["READ"],
  });
  expect(invited.response.status(), await invited.response.text()).toBe(201);

  const pendingCard = owner.page
    .locator("article.access-card")
    .filter({ hasText: `PN-${suffix}`.toUpperCase() });
  await pendingCard.getByRole("button", { name: "View details" }).click();
  const pendingDetails = owner.page.getByRole("dialog");
  await expect(
    pendingDetails.getByRole("heading", { name: "Pending activation" }),
  ).toBeVisible();
  const rotateResponse = owner.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/tenant/access/users/${invited.body.membershipId}/invitations/resend`,
        ),
  );
  await pendingDetails
    .getByRole("button", { name: "Generate new activation link" })
    .click();
  expect((await rotateResponse).status()).toBe(200);
  const link = pendingDetails.getByLabel("New activation link");
  await expect(link).toHaveValue(
    /^http:\/\/127\.0\.0\.1:3000\/accept-access\?token=/,
  );
  expect(await link.inputValue()).not.toBe(invited.body.invitationUrl);
  await pendingDetails
    .getByRole("button", { name: "Copy activation link" })
    .click();
  await expect(pendingDetails.getByRole("status")).toHaveText(
    "Activation link copied.",
  );
  expect(await owner.page.evaluate(() => navigator.clipboard.readText())).toBe(
    await link.inputValue(),
  );

  await owner.context.close();
});

test("E2E-FND02-08: permission tester explains authorization and does not mutate records", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  const before = await accessApi(owner.page, "/probes");
  expect(before.status(), await before.text()).toBe(200);
  const beforeBody = await body(before);

  await owner.page.goto("/app/access/probes");
  await expect(
    owner.page.getByRole("heading", { name: "Permission tester" }),
  ).toBeVisible();
  await expect(
    owner.page.getByText(/administrators and support/i),
  ).toBeVisible();
  await expect(
    owner.page.getByText(/makes no business transaction/i),
  ).toBeVisible();
  await expect(
    owner.page.getByRole("heading", { name: "How to use this diagnostic" }),
  ).toBeVisible();

  const north = requiredResource(fixture, "north");
  const northCard = owner.page
    .locator("article.access-card")
    .filter({ hasText: north.label });
  await northCard.getByRole("button", { name: "Test read permission" }).click();
  const decision = owner.page.getByRole("status").filter({
    has: owner.page.getByRole("heading", { name: "Permission decision" }),
  });
  await expect(decision.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(decision.locator("pre")).toHaveCount(0);

  const after = await accessApi(owner.page, "/probes");
  expect(after.status(), await after.text()).toBe(200);
  const afterBody = await body(after);
  expect(afterBody.total).toBe(beforeBody.total);
  expect(afterBody.items).toEqual(beforeBody.items);
  await owner.context.close();
});

test("E2E-FND02-09: searchable activity and audit tables are separate from actionable alerts", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "REPORTS");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.page.goto("/app/access/reports");
  await expect(
    owner.page.getByRole("heading", { name: "Activity & audit" }),
  ).toBeVisible();
  await expect(owner.page.getByText(/immutable audit evidence/i)).toBeVisible();
  const alertsPanel = owner.page.locator("section.panel").filter({
    has: owner.page.getByRole("heading", { name: "Security alerts" }),
  });
  await expect(
    alertsPanel.getByText(/separate from the immutable audit log/i),
  ).toBeVisible();

  const auditLoaded = owner.page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/tenant/access/reports/audit-log"),
  );
  await owner.page.getByLabel("Evidence view").selectOption("audit-log");
  expect((await auditLoaded).status()).toBe(200);
  const auditTable = owner.page.locator(
    '[aria-label="Audit Log results"] table',
  );
  await expect(auditTable).toBeVisible();
  await expect(
    auditTable.getByRole("columnheader", { name: "Actor" }),
  ).toBeVisible();
  await expect(
    auditTable.getByRole("columnheader", { name: "Action" }),
  ).toBeVisible();

  const apiAudit = await accessApi(owner.page, "/reports/audit-log");
  expect(apiAudit.status(), await apiAudit.text()).toBe(200);
  const auditBody = await body(apiAudit);
  const firstItem = (auditBody.items as Array<Record<string, unknown>>)[0];
  const searchTerm = String(
    firstItem?.action ?? firstItem?.actor ?? "identity",
  );
  await owner.page.getByLabel("Search").fill(searchTerm);
  await expect(owner.page.getByText("Loading report…")).toHaveCount(0);
  const filtered = await accessApi(
    owner.page,
    `/reports/audit-log?search=${encodeURIComponent(searchTerm)}`,
  );
  expect(filtered.status(), await filtered.text()).toBe(200);
  const filteredBody = await body(filtered);
  await expect(auditTable.getByRole("row")).toHaveCount(
    Number(filteredBody.total) + 1,
  );
  await expect(owner.page.locator("main pre")).toHaveCount(0);

  await owner.page.getByLabel("Search").fill("");
  await expect(owner.page.getByText("Loading report…")).toHaveCount(0);
  const alert = alertsPanel.locator("article.access-card").first();
  await expect(alert).toBeVisible();
  if (await alert.getByRole("button", { name: "Acknowledge" }).isVisible()) {
    await alert.getByRole("button", { name: "Acknowledge" }).click();
    await expect(alert.getByText(/Acknowledged/i)).toBeVisible();
  }
  await alert.getByRole("button", { name: "Resolve" }).click();
  await expect(alert.getByText(/Resolved/i)).toBeVisible();
  await expect(
    alert.getByRole("button", { name: /Acknowledge|Resolve/ }),
  ).toHaveCount(0);

  expect(
    Number((await body(await accessApi(owner.page, "/alerts"))).total),
  ).toBe(fixture.expected.alerts);
  await owner.context.close();
});

test("E2E-FND02-10: client repeat login, password recovery, reset rotation, replay rejection, and shared-identity protection", async ({
  browser,
  page,
}, testInfo) => {
  test.slow();
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const suffix = fixture.namespace.slice(-7).toLowerCase();
  const email = `recovery-client-${suffix}@test.local`;
  const firstPassword = "ClientRecovery!234";
  const replacementPassword = "ClientReplacement!234";
  const employeeCode = `CR-${suffix}`.toUpperCase();

  const invited = await inviteThroughUi(owner.page, {
    displayName: `Recovery Client ${suffix}`,
    employeeCode,
    email,
    portalAudience: "CLIENT",
    roleName: "Client Viewer",
    scopePath: "Alpha",
    actions: ["READ"],
  });
  expect(invited.response.status(), await invited.response.text()).toBe(201);
  const pendingCard = owner.page
    .locator("article.access-card")
    .filter({ hasText: employeeCode });
  await pendingCard.getByRole("button", { name: "View details" }).click();
  const pendingDetails = owner.page.getByRole("dialog");
  await expect(
    pendingDetails.getByRole("heading", { name: "Pending activation" }),
  ).toBeVisible();
  const activationResponse = owner.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/tenant/access/users/${invited.body.membershipId}/invitations/resend`,
        ),
  );
  await pendingDetails
    .getByRole("button", { name: "Generate new activation link" })
    .click();
  expect((await activationResponse).status()).toBe(200);
  const activationUrl = await pendingDetails
    .getByLabel("New activation link")
    .inputValue();
  expect(activationUrl).toMatch(/\/accept-access\?token=/);
  await pendingDetails
    .getByRole("button", { name: "Close user details" })
    .click();

  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  await client.goto(activationUrl);
  await expect(
    client.getByRole("heading", { name: "Accept access invitation" }),
  ).toBeVisible();
  await client.getByLabel("Display name").fill(`Recovery Client ${suffix}`);
  await expect(
    client.getByText(/Create a password you will remember/i),
  ).toBeVisible();
  await client.getByLabel("Create password").fill(firstPassword);
  await client.getByLabel("Confirm password").fill(firstPassword);
  await client.getByRole("checkbox", { name: /I accept/i }).check();
  await client.getByRole("button", { name: "Accept invitation" }).click();
  await expect(client).toHaveURL(/\/portal\/client$/);

  await client.getByRole("button", { name: "Sign out" }).click();
  await expect(client).toHaveURL(/\/login$/);
  await client.getByLabel("Email or mobile").fill(email);
  await client.getByLabel("Password").fill(firstPassword);
  await client.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(client).toHaveURL(/\/portal\/client$/);

  await client.getByRole("button", { name: "Sign out" }).click();
  await client.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(client).toHaveURL(/\/forgot-password$/);
  const requestReset = async (identifier: string) => {
    await client.getByLabel("Email or mobile").fill(identifier);
    await client.getByLabel(/Workspace code/).fill(fixture.tenantA.code);
    const responsePromise = client.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/auth/password-reset/request"),
    );
    await client
      .getByRole("button", { name: "Request password reset" })
      .click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    return (await client.getByRole("status").textContent())?.trim();
  };
  const knownMessage = await requestReset(email);
  const unknownMessage = await requestReset(`missing-${suffix}@test.local`);
  expect(knownMessage).toBe(
    "If eligible, a recovery request was recorded; contact your workspace administrator if delivery is unavailable.",
  );
  expect(unknownMessage).toBe(knownMessage);

  await owner.page.goto("/app/access/users");
  const activeCard = owner.page
    .locator("article.access-card")
    .filter({ hasText: employeeCode });
  await activeCard.getByRole("button", { name: "View details" }).click();
  const activeDetails = owner.page.getByRole("dialog");
  await expect(
    activeDetails.getByRole("heading", { name: "Password recovery" }),
  ).toBeVisible();
  const adminResetResponse = owner.page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/tenant/access/users/${invited.body.membershipId}/password-reset`,
        ),
  );
  await activeDetails
    .getByRole("button", { name: "Generate password reset link" })
    .click();
  const generatedResponse = await adminResetResponse;
  expect(generatedResponse.status(), await generatedResponse.text()).toBe(200);
  expect(generatedResponse.headers()["cache-control"]).toContain("no-store");
  const resetInput = activeDetails.getByLabel("One-time password reset link");
  const resetUrl = await resetInput.inputValue();
  expect(resetUrl).toMatch(/\/reset-password#token=/);
  await activeDetails
    .getByRole("button", { name: "Copy password reset link" })
    .click();
  await expect(activeDetails.getByRole("status")).toHaveText(
    "Password reset link copied.",
  );
  expect(await owner.page.evaluate(() => navigator.clipboard.readText())).toBe(
    resetUrl,
  );
  await activeDetails.getByRole("button", { name: "Done" }).click();
  await expect(
    activeDetails.getByLabel("One-time password reset link"),
  ).toHaveCount(0);

  const previewResetResponse = client.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/auth/password-reset/preview"),
  );
  await client.goto(resetUrl);
  const previewResponse = await previewResetResponse;
  expect(previewResponse.status(), await previewResponse.text()).toBe(200);
  expect(previewResponse.url()).not.toContain("token=");
  await expect(
    client.getByRole("heading", { name: "Create a new password" }),
  ).toBeVisible();
  await expect(client).toHaveURL(/\/reset-password$/);
  await client.getByLabel("New password").fill(replacementPassword);
  await client.getByLabel("Confirm new password").fill(replacementPassword);
  const completeResetResponse = client.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/auth/password-reset/complete"),
  );
  await client.getByRole("button", { name: "Reset password" }).click();
  const completeResponse = await completeResetResponse;
  expect(completeResponse.status(), await completeResponse.text()).toBe(200);
  expect(completeResponse.url()).not.toContain("token=");
  await expect(client.getByRole("status")).toContainText(
    "Password reset complete",
  );

  const replay = await clientContext.newPage();
  await replay.goto(resetUrl);
  await expect(replay.getByRole("alert")).toContainText(
    "Password reset link is invalid or expired",
  );
  await replay.close();

  await client.getByRole("link", { name: "Sign in" }).click();
  await client.getByLabel("Email or mobile").fill(email);
  await client.getByLabel("Password").fill(firstPassword);
  await client.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(client.getByRole("alert")).toContainText(
    "Email or password is incorrect",
  );
  await client.getByLabel("Password").fill(replacementPassword);
  await client.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(client).toHaveURL(/\/portal\/client$/);

  const secondFixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const secondOwner = await actorPage(browser, secondFixture.actors.owner);
  const sharedInvite = await inviteThroughUi(secondOwner.page, {
    displayName: `Shared Recovery ${suffix}`,
    employeeCode: `SH-${suffix}`.toUpperCase(),
    email,
    portalAudience: "CLIENT",
    roleName: "Client Viewer",
    scopePath: "Alpha",
    actions: ["READ"],
  });
  expect(
    sharedInvite.response.status(),
    await sharedInvite.response.text(),
  ).toBe(201);
  expect(sharedInvite.body.invitationUrl).toMatch(/\/accept-access\?token=/);
  const sharedContext = await browser.newContext();
  const shared = await sharedContext.newPage();
  await shared.goto(String(sharedInvite.body.invitationUrl));
  await expect(shared.getByLabel("Current password")).toBeVisible();
  await shared.getByLabel("Display name").fill(`Shared Recovery ${suffix}`);
  await shared.getByLabel("Current password").fill(replacementPassword);
  await shared.getByRole("checkbox", { name: /I accept/i }).check();
  await shared.getByRole("button", { name: "Accept invitation" }).click();
  await expect(shared).toHaveURL(/\/portal\/client$/);

  await activeDetails
    .getByRole("button", { name: "Generate password reset link" })
    .click();
  await expect(owner.page.locator("main [role=alert]")).toContainText(
    "multiple workspaces",
  );
  await expect(
    activeDetails.getByLabel("One-time password reset link"),
  ).toHaveCount(0);

  await sharedContext.close();
  await secondOwner.context.close();
  await clientContext.close();
  await owner.context.close();
});

test("FND02-X-001: access screens expose keyboard focus, names, errors, dialogs, and status semantics", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "SCOPES_ONLY");
  const owner = await actorPage(browser, fixture.actors.owner);
  await owner.page.goto("/app/access/users");
  await owner.page.keyboard.press("Tab");
  await expect(
    owner.page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await owner.page.keyboard.press("Enter");
  await expect(owner.page.locator("#main")).toBeFocused();
  await owner.page
    .getByRole("button", { name: /Review.*send invitation|Send invitation/ })
    .click();
  await expect(owner.page.locator("main [role=alert]")).toBeFocused();
  for (const label of [
    "Display name",
    "Employee code",
    "Email",
    "Mobile (E.164)",
  ])
    await expect(
      owner.page.getByLabel(label, { exact: true }),
    ).toHaveAccessibleName(label);
  for (const label of ["Role", "Scope"])
    await expect(
      owner.page
        .locator("label", { hasText: new RegExp(`^${label}`) })
        .locator("select"),
    ).toHaveAccessibleName(label);
  await expectAccessibleResponsive(
    owner.page,
    "access validation and keyboard semantics",
  );
  await owner.context.close();
});

test("FND02-X-002: access UI handles loading, empty, forbidden, error, retry, and narrow reflow without duplicate mutation", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "SCOPES_ONLY");
  const owner = await actorPage(browser, fixture.actors.owner);
  let failOnce = true;
  const probesRoute = "**/api/v1/tenant/access/probes";
  await owner.page.route(probesRoute, async (route) => {
    if (failOnce && route.request().method() === "GET") {
      failOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TEMPORARY",
          message: "Scoped work queue is temporarily unavailable",
        }),
      });
    } else await route.continue();
  });
  await owner.page.goto("/app/access/probes");
  await expect(owner.page.locator("main [role=alert]")).toContainText(
    "temporarily unavailable",
  );
  await owner.page.getByRole("button", { name: "Retry" }).click();
  await expect(
    owner.page.getByRole("heading", {
      name: requiredResource(fixture, "north").label,
    }),
  ).toBeVisible();
  await expect(owner.page.getByText("Loading work queue…")).toHaveCount(0);
  await expectAccessibleResponsive(owner.page, "access work queue recovery");
  await owner.page.unroute(probesRoute);
  await owner.context.close();
});
