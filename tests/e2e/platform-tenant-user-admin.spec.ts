import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  adminCredentials,
  api,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";
import { actorPage, loginActor, seedFnd02 } from "../fixtures/fnd02";

type PlatformUser = {
  id: string;
  displayName: string;
  employeeCode: string;
  portalAudience: "INTERNAL" | "VENDOR" | "DRIVER" | "CLIENT";
  membershipStatus: "INVITED" | "ACTIVE" | "SUSPENDED";
  activationStatus: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  version: number;
  destination: string;
  roles: Array<{ code: string; name: string }>;
  activeSessions: number;
  onboarding: {
    status: string;
    percent: number;
    checks: Record<string, boolean | null>;
    explanations: Record<string, string>;
  };
  permittedActions: string[];
};

type TenantDetail = {
  tenant: {
    id: string;
    code: string;
    setup_complete: number;
    setup_total: number;
  };
  checklist: Array<{
    key: string;
    label: string;
    state: string;
    version: number;
  }>;
  availableRoles: Array<{
    id: string;
    code: string;
    name: string;
    portalAudiences: string[];
    privilegeLevel: string;
  }>;
  setupEvidence: Array<{
    key: string;
    label: string;
    count: number;
    records: Array<{
      id: string;
      code: string;
      name: string;
      state: string;
      type?: string;
      version: number;
    }>;
  }>;
};

const responseBody = async <T>(response: APIResponse) =>
  (await response.json()) as T;

async function platformUser(
  page: Page,
  tenantId: string,
  membershipId: string,
) {
  const response = await api(
    page,
    `/platform/tenants/${tenantId}/users/${membershipId}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return responseBody<PlatformUser>(response);
}

test("E2E-PLATFORM-USERS-001: platform admin manages profiles and sees derived onboarding evidence", async ({
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantId = fixture.tenantA.id;
  const target = fixture.actors.regional;

  const listResponse = await api(
    page,
    `/platform/tenants/${tenantId}/users?membershipStatus=ACTIVE&activationStatus=ACCEPTED&page=1`,
  );
  expect(listResponse.status(), await listResponse.text()).toBe(200);
  const list = await responseBody<{
    items: PlatformUser[];
    total: number;
    page: number;
    pageSize: number;
  }>(listResponse);
  expect(list.total).toBeGreaterThan(0);
  expect(list.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: target.membershipId,
        membershipStatus: "ACTIVE",
        activationStatus: "ACCEPTED",
        destination: expect.stringMatching(/\*|•/),
        onboarding: expect.objectContaining({
          status: expect.any(String),
          percent: expect.any(Number),
          checks: expect.any(Object),
        }),
        permittedActions: expect.any(Array),
      }),
    ]),
  );

  const before = await platformUser(page, tenantId, target.membershipId);
  expect(before.onboarding.percent).toBeGreaterThanOrEqual(0);
  expect(before.onboarding.percent).toBeLessThanOrEqual(100);

  const displayName = `Platform managed ${fixture.namespace}`;
  const profileKey = `profile-${fixture.namespace}`;
  const profileInput = {
    displayName,
    employeeCode: before.employeeCode,
    portalAudience: before.portalAudience,
    expectedVersion: before.version,
    reason: "Correct tenant onboarding identity data",
  };
  const update = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": profileKey },
      data: profileInput,
    },
  );
  expect(update.status(), await update.text()).toBe(200);
  const updated = await responseBody<PlatformUser>(update);
  expect(updated).toMatchObject({
    id: target.membershipId,
    displayName,
    version: before.version + 1,
  });
  const profileReplay = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": profileKey },
      data: profileInput,
    },
  );
  expect(profileReplay.status(), await profileReplay.text()).toBe(200);
  expect(await responseBody(profileReplay)).toEqual(updated);
  const profileConflict = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": profileKey },
      data: { ...profileInput, reason: "Different profile request body" },
    },
  );
  expect(profileConflict.status()).toBe(409);
  expect(await responseBody(profileConflict)).toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });

  const aggregateResponse = await api(page, `/platform/tenants/${tenantId}`);
  expect(aggregateResponse.status(), await aggregateResponse.text()).toBe(200);
  const aggregate = await responseBody<TenantDetail>(aggregateResponse);
  expect(await platformUser(page, tenantId, target.membershipId)).toMatchObject(
    {
      id: target.membershipId,
      displayName,
    },
  );
  const branding = aggregate.checklist.find((item) => item.key === "branding");
  expect(branding).toBeTruthy();
  const external = await platformUser(
    page,
    tenantId,
    fixture.actors.vendor.membershipId,
  );
  expect(external).toMatchObject({
    portalAudience: "VENDOR",
    onboarding: {
      status: "BLOCKED",
      checks: { personaLinkage: false },
      explanations: {
        personaLinkage: "Active external persona linkage required",
      },
    },
  });

  await page.goto(`/platform/tenants/${tenantId}`);
  await expect(
    page.getByRole("heading", { name: "Tenant users" }),
  ).toBeVisible();
  await expect(page.getByText(displayName, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Setup checklist" }),
  ).toBeVisible();
  await page
    .getByRole("row", { name: new RegExp(displayName) })
    .getByRole("button", { name: "View / manage" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Access, onboarding and security" }),
  ).toBeVisible();
  const onboarding = page
    .getByRole("heading", { name: "Access, onboarding and security" })
    .locator("..");
  await expect(
    onboarding.getByRole("listitem").filter({ hasText: /^profile:/i }),
  ).toContainText("Complete");
  await expect(
    onboarding.getByRole("listitem").filter({ hasText: /^activation:/i }),
  ).toContainText("Complete");
  await expect(
    onboarding.getByRole("listitem").filter({ hasText: /^access:/i }),
  ).toContainText("Complete");
  await expect(
    page.getByRole("button", { name: "Disable user and revoke sessions" }),
  ).toBeVisible();
  const profile = page
    .getByRole("heading", { name: "Tenant profile" })
    .locator("..");
  await expect(profile.getByLabel("Display name")).toHaveValue(displayName);
  const browserEditedName = `${displayName} UI`;
  await profile.getByLabel("Display name").fill(browserEditedName);
  await profile
    .getByLabel("Reason")
    .fill("Confirm the platform profile form persists this correction");
  const profileResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response
        .url()
        .endsWith(
          `/api/v1/platform/tenants/${tenantId}/users/${target.membershipId}/profile`,
        ),
  );
  await profile.getByRole("button", { name: "Save tenant profile" }).click();
  expect((await profileResponse).status()).toBe(200);
  await expect(page.getByRole("status")).toContainText(
    "Tenant-specific user profile updated",
  );
  await expect(
    page.getByRole("heading", { name: browserEditedName }),
  ).toBeVisible();

  const setup = page
    .getByRole("heading", { name: "Setup checklist" })
    .locator("..");
  await expect(
    setup.getByText(
      "Read-only canonical progress. Complete each area through its underlying organization, access, master-data, commercial or import workflow.",
    ),
  ).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "Branding" }).locator(".."),
  ).toContainText(branding!.state);
  await expect(
    setup.getByRole("button", { name: /Mark complete|Reopen/ }),
  ).toHaveCount(0);
  await expect(setup.locator("form")).toHaveCount(0);
});

test("E2E-PLATFORM-USERS-002: suspend revokes sessions and reactivate restores sign-in", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantId = fixture.tenantA.id;
  const target = fixture.actors.kam;
  const targetSession = await actorPage(browser, target);
  const before = await platformUser(page, tenantId, target.membershipId);

  const suspendKey = `suspend-${fixture.namespace}`;
  const suspend = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/suspend`,
    {
      method: "POST",
      headers: { "Idempotency-Key": suspendKey },
      data: {
        expectedVersion: before.version,
        reason: "Platform review requires temporary access suspension",
      },
    },
  );
  expect(suspend.status(), await suspend.text()).toBe(200);
  const suspended = await responseBody<PlatformUser>(suspend);
  expect(suspended).toMatchObject({
    id: target.membershipId,
    membershipStatus: "SUSPENDED",
    version: before.version + 1,
    activeSessions: 0,
  });
  const suspendReplay = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/suspend`,
    {
      method: "POST",
      headers: { "Idempotency-Key": suspendKey },
      data: {
        expectedVersion: before.version,
        reason: "Platform review requires temporary access suspension",
      },
    },
  );
  expect(suspendReplay.status(), await suspendReplay.text()).toBe(200);
  expect(await responseBody(suspendReplay)).toEqual(suspended);
  const suspendConflict = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/suspend`,
    {
      method: "POST",
      headers: { "Idempotency-Key": suspendKey },
      data: {
        expectedVersion: before.version,
        reason: "Different suspension request body",
      },
    },
  );
  expect(suspendConflict.status()).toBe(409);
  expect(await responseBody(suspendConflict)).toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });

  const revokedSession = await api(targetSession.page, "/auth/me");
  expect(revokedSession.status()).toBe(401);
  expect(await responseBody(revokedSession)).toMatchObject({
    code: "UNAUTHENTICATED",
  });

  await page.goto(`/platform/tenants/${tenantId}`);
  await page
    .getByRole("row", { name: /Fixture kam/ })
    .getByRole("button", { name: "View / manage" })
    .click();
  await expect(page.getByRole("button", { name: "Enable user" })).toBeVisible();

  const reactivate = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/reactivate`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `reactivate-${fixture.namespace}` },
      data: {
        expectedVersion: suspended.version,
        reason: "Platform review completed and access is approved",
      },
    },
  );
  expect(reactivate.status(), await reactivate.text()).toBe(200);
  expect(await responseBody(reactivate)).toMatchObject({
    membershipStatus: "ACTIVE",
  });

  await page.reload();
  await page
    .getByRole("row", { name: /Fixture kam/ })
    .getByRole("button", { name: "View / manage" })
    .click();
  await expect(
    page.getByRole("button", { name: "Disable user and revoke sessions" }),
  ).toBeVisible();

  await targetSession.context.clearCookies();
  await loginActor(targetSession.page, target);
  await expect(targetSession.page).not.toHaveURL(/\/login(?:\?|$)/);
  await targetSession.context.close();
});

test("E2E-PLATFORM-USERS-003: platform user management denies tenant and cross-tenant access", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantAId = fixture.tenantA.id;
  const target = fixture.actors.regional;
  const foreignTenant = tenantFixture("PlatformUserIso");
  const provisioned = await provisionViaApi(page, foreignTenant);
  const invitedDirectory = await responseBody<{ items: PlatformUser[] }>(
    await api(page, `/platform/tenants/${provisioned.tenant.id}/users`),
  );
  expect(invitedDirectory.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        membershipStatus: "INVITED",
        activationStatus: "PENDING",
      }),
    ]),
  );

  const crossTenant = await api(
    page,
    `/platform/tenants/${provisioned.tenant.id}/users/${target.membershipId}`,
  );
  expect(crossTenant.status()).toBe(404);
  expect(await responseBody(crossTenant)).toMatchObject({
    code: "NOT_FOUND",
    message: "Resource not found",
  });

  const tenantOwner = await actorPage(browser, fixture.actors.owner);
  const platformList = await api(
    tenantOwner.page,
    `/platform/tenants/${tenantAId}/users`,
  );
  expect(platformList.status()).toBe(403);
  expect(await responseBody(platformList)).toMatchObject({ code: "FORBIDDEN" });

  const malformed = await api(
    page,
    "/platform/tenants/not-a-uuid/users/not-a-membership",
  );
  expect(malformed.status()).toBe(400);
  expect(await responseBody(malformed)).toMatchObject({
    code: "VALIDATION_FAILED",
  });

  const before = await platformUser(page, tenantAId, target.membershipId);
  const destinationInjection = await api(
    page,
    `/platform/tenants/${tenantAId}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": `identity-${fixture.namespace}` },
      data: {
        displayName: before.displayName,
        employeeCode: before.employeeCode,
        portalAudience: before.portalAudience,
        invitedEmail: `replacement-${fixture.namespace.toLowerCase()}@test.local`,
        expectedVersion: before.version,
        reason: "Reject destination fields from profile updates",
      },
    },
  );
  expect(destinationInjection.status()).toBe(400);
  expect(await responseBody(destinationInjection)).toMatchObject({
    code: "VALIDATION_FAILED",
    message: "Check the highlighted fields",
    fields: expect.any(Object),
  });

  const crossTenantMutation = await api(
    page,
    `/platform/tenants/${provisioned.tenant.id}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": `cross-${fixture.namespace}` },
      data: {
        displayName: before.displayName,
        employeeCode: before.employeeCode,
        portalAudience: before.portalAudience,
        expectedVersion: before.version,
        reason: "Cross tenant mutation must be rejected",
      },
    },
  );
  expect(crossTenantMutation.status()).toBe(404);
  expect(await responseBody(crossTenantMutation)).toMatchObject({
    code: "NOT_FOUND",
  });

  const ownerBefore = await platformUser(
    page,
    tenantAId,
    fixture.actors.owner.membershipId,
  );
  const finalOwner = await api(
    page,
    `/platform/tenants/${tenantAId}/users/${fixture.actors.owner.membershipId}/suspend`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `final-owner-${fixture.namespace}` },
      data: {
        expectedVersion: ownerBefore.version,
        reason: "Exercise final tenant owner protection",
      },
    },
  );
  expect(finalOwner.status()).toBe(409);
  expect(await responseBody(finalOwner)).toMatchObject({
    code: "FINAL_OWNER_PROTECTED",
  });

  const stale = await api(
    page,
    `/platform/tenants/${tenantAId}/users/${target.membershipId}/profile`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": `stale-${fixture.namespace}` },
      data: {
        displayName: "Stale overwrite must not persist",
        employeeCode: before.employeeCode,
        portalAudience: before.portalAudience,
        expectedVersion: before.version - 1,
        reason: "Exercise optimistic concurrency protection",
      },
    },
  );
  expect(stale.status()).toBe(409);
  expect(await responseBody(stale)).toMatchObject({ code: "VERSION_CONFLICT" });
  expect(
    await platformUser(page, tenantAId, target.membershipId),
  ).toMatchObject({
    displayName: before.displayName,
    version: before.version,
  });

  await tenantOwner.context.close();
});

test("E2E-PLATFORM-USERS-004 FSUX-E2E-007: platform admin invites a tenant user and sees actionable master evidence", async ({
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantId = fixture.tenantA.id;
  const aggregate = await responseBody<TenantDetail>(
    await api(page, `/platform/tenants/${tenantId}`),
  );
  const role = aggregate.availableRoles.find((candidate) =>
    candidate.portalAudiences.includes("INTERNAL"),
  );
  expect(role).toBeTruthy();
  expect(aggregate.setupEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "organization",
        count: expect.any(Number),
        records: expect.any(Array),
      }),
      expect.objectContaining({
        key: "users",
        count: expect.any(Number),
        records: expect.any(Array),
      }),
      expect.objectContaining({
        key: "vendors",
        count: expect.any(Number),
        records: expect.any(Array),
      }),
    ]),
  );

  const suffix = fixture.namespace.toLowerCase();
  const input = {
    displayName: `Platform invite ${fixture.namespace}`,
    employeeCode: `PI-${fixture.namespace}`,
    email: `platform-invite-${suffix}@test.local`,
    portalAudience: "INTERNAL",
    roleIds: [role!.id],
    expiresInHours: 72,
    reason: "Platform administrator adds the requested tenant user",
    tenantWideAccessConfirmed: true,
  };
  const key = `platform-invite-${fixture.namespace}`;
  const createdResponse = await api(page, `/platform/tenants/${tenantId}/users`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    data: input,
  });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = await responseBody<{
    membershipId: string;
    invitationUrl: string | null;
    shownOnce: boolean;
  }>(createdResponse);
  expect(created).toMatchObject({
    membershipId: expect.any(String),
    invitationUrl: expect.stringMatching(/\/accept-access\?token=/),
    shownOnce: true,
  });
  const replay = await api(page, `/platform/tenants/${tenantId}/users`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    data: input,
  });
  expect(replay.status(), await replay.text()).toBe(201);
  expect(await responseBody(replay)).toMatchObject({
    membershipId: created.membershipId,
    invitationUrl: null,
    shownOnce: true,
  });

  await page.goto(`/platform/tenants/${tenantId}`);
  await expect(page.getByRole("button", { name: "Add user" })).toBeVisible();
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(
    page.getByRole("heading", { name: "Tenant user invitation" }),
  ).toBeVisible();
  await expect(page.getByText(input.displayName, { exact: true })).toBeVisible();
  const invite = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Tenant user invitation" }),
  });
  await invite.getByLabel("Display name").fill(`UI invite ${fixture.namespace}`);
  await invite.getByLabel("Employee code").fill(`UI-${fixture.namespace}`);
  await invite
    .getByLabel("Email (optional)")
    .fill(`ui-invite-${suffix}@test.local`);
  await invite.getByLabel("Portal audience").selectOption("INTERNAL");
  await invite.getByLabel("Compatible role").selectOption(role!.id);
  await invite
    .getByLabel("Reason")
    .fill("Create another tenant invitation through the platform form");
  await invite
    .getByRole("checkbox", { name: /tenant-wide\/root scope access/i })
    .check();
  const uiInvitation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/v1/platform/tenants/${tenantId}/users`),
  );
  await invite.getByRole("button", { name: "Create invitation" }).click();
  expect((await uiInvitation).status()).toBe(201);
  await expect(invite.getByRole("status")).toContainText(
    /invitation.*created/i,
  );
  await expect(invite.getByLabel("Display name")).toHaveValue("");
  await expect(invite.getByLabel("Employee code")).toHaveValue("");
  await expect(invite.getByLabel("Email (optional)")).toHaveValue("");
  await expect(
    invite.getByRole("button", { name: "Copy user activation link" }),
  ).toBeVisible();
  const refreshedAggregate = await responseBody<TenantDetail>(
    await api(page, `/platform/tenants/${tenantId}`),
  );
  const masters = page
    .getByRole("heading", { name: "Onboarding and master data" })
    .locator("..");
  await expect(masters).toBeVisible();
  for (const evidence of refreshedAggregate.setupEvidence.filter(
    (item) => item.records.length,
  )) {
    await expect(
      masters.getByRole("heading", {
        name: `${evidence.label} · ${evidence.count}`,
      }),
    ).toBeVisible();
    await expect(
      masters.getByText(evidence.records[0]!.name, { exact: true }),
    ).toBeVisible();
  }
  for (const label of [
    "Approved/published contracts",
    "Import jobs",
    "Active roles",
  ]) {
    const stage = masters.getByRole("heading", { name: new RegExp(label) }).locator("..");
    await expect(stage.getByText("Read-only", { exact: false })).toBeVisible();
    await expect(stage.getByRole("button", { name: "Edit" })).toHaveCount(0);
  }

  for (const [key, resourceType] of [
    ["organization", "organization"],
    ["clients", "client"],
    ["vendors", "vendor"],
  ] as const) {
    const editableStage = refreshedAggregate.setupEvidence.find(
      (item) => item.key === key,
    );
    expect(editableStage?.records.length).toBeGreaterThan(0);
    const record = editableStage!.records[0]!;
    const stage = masters
      .getByRole("heading", {
        name: `${editableStage!.label} · ${editableStage!.count}`,
      })
      .locator("..");
    const row = stage.getByRole("row", { name: new RegExp(record.code) });
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByLabel("Name").fill(`${record.name} Platform`);
    await row
      .getByLabel("Reason")
      .fill("Correct the representative master-data record name");
    const masterUpdate = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response
          .url()
          .endsWith(
            `/api/v1/platform/tenants/${tenantId}/master-data/${resourceType}/${record.id}`,
          ),
    );
    await row.getByRole("button", { name: "Save" }).click();
    expect((await masterUpdate).status()).toBe(200);
  }

  const configuration = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Configuration" }),
  });
  await configuration.getByRole("button", { name: "Edit" }).click();
  await configuration
    .getByLabel("Legal name")
    .fill(`${fixture.namespace} Updated Logistics`);
  await configuration
    .getByLabel("Reason")
    .fill("Correct the tenant configuration from Platform support");
  const configurationUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response
        .url()
        .endsWith(`/api/v1/platform/tenants/${tenantId}/configuration`),
  );
  await configuration.getByRole("button", { name: "Save" }).click();
  expect((await configurationUpdate).status()).toBe(200);
});

test("E2E-PLATFORM-USERS-005 FSUX-E2E-007: explicit detail edit, destination reveal, and password-reset link are operable", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const tenantId = fixture.tenantA.id;
  const target = fixture.actors.regional;
  const before = await platformUser(page, tenantId, target.membershipId);

  const failedStepUp = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/reveal-destination`,
    {
      method: "POST",
      data: {
        expectedVersion: before.version,
        reason: "Reject reveal without valid administrator step-up",
        currentPassword: "IncorrectPlatformPassword!234",
      },
    },
  );
  expect(failedStepUp.status()).toBe(403);
  expect(await responseBody(failedStepUp)).toMatchObject({
    code: "STEP_UP_FAILED",
  });

  const reveal = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/reveal-destination`,
    {
      method: "POST",
      data: {
        expectedVersion: before.version,
        reason: "Verify the tenant user login destination for support",
        currentPassword: adminCredentials.password,
      },
    },
  );
  expect(reveal.status(), await reveal.text()).toBe(200);
  expect(reveal.headers()["cache-control"]).toContain("no-store");
  expect(await responseBody(reveal)).toMatchObject({
    membershipId: target.membershipId,
    email: target.email,
    source: "TENANT_MEMBERSHIP",
  });

  const resetKey = `platform-reset-${fixture.namespace}`;
  const resetInput = {
    expectedVersion: before.version,
    reason: "Generate a one-time recovery link for the tenant user",
    currentPassword: adminCredentials.password,
    expiresInHours: 1,
  };
  const reset = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/password-reset`,
    {
      method: "POST",
      headers: { "Idempotency-Key": resetKey },
      data: resetInput,
    },
  );
  expect(reset.status(), await reset.text()).toBe(200);
  const resetBody = await responseBody<{ resetUrl: string | null; shownOnce: boolean }>(reset);
  expect(resetBody).toMatchObject({
    resetUrl: expect.stringMatching(/\/reset-password#token=/),
    shownOnce: true,
  });
  const resetReplay = await api(
    page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/password-reset`,
    {
      method: "POST",
      headers: { "Idempotency-Key": resetKey },
      data: resetInput,
    },
  );
  expect(resetReplay.status(), await resetReplay.text()).toBe(200);
  expect(await responseBody(resetReplay)).toMatchObject({
    resetUrl: null,
    shownOnce: true,
  });

  await page.goto(`/platform/tenants/${tenantId}`);
  await page
    .getByRole("row", { name: new RegExp(before.displayName) })
    .getByRole("button", { name: "View / manage" })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit user details" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit user details" }).click();
  await expect(page.getByRole("heading", { name: "Tenant profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Edit user details" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal email" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate password reset link" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy email" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy reset link" }),
  ).toHaveCount(0);
  const destination = page.locator("form").filter({
    has: page.getByRole("button", { name: "Reveal email" }),
  });
  const revealReason = "Reveal the email for an audited support verification";
  await destination
    .getByLabel("Current Platform Admin password")
    .fill("IncorrectPlatformPassword!234");
  await destination.getByLabel("Reason for reveal").fill(revealReason);
  const deniedRevealResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/platform/tenants/${tenantId}/users/${target.membershipId}/reveal-destination`,
        ),
  );
  await destination.getByRole("button", { name: "Reveal email" }).click();
  expect((await deniedRevealResponse).status()).toBe(403);
  await expect(destination.getByRole("alert")).toContainText(
    /password|step-up/i,
  );
  await expect(
    destination.getByLabel("Current Platform Admin password"),
  ).toHaveValue("");
  await expect(destination.getByLabel("Reason for reveal")).toHaveValue(
    revealReason,
  );
  await expect(
    page
      .locator("form")
      .filter({
        has: page.getByRole("button", {
          name: "Generate password reset link",
        }),
      })
      .getByRole("alert"),
  ).toHaveCount(0);
  await destination
    .getByLabel("Current Platform Admin password")
    .fill(adminCredentials.password);
  await expect(destination.getByLabel("Reason for reveal")).toHaveValue(
    revealReason,
  );
  const revealResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/platform/tenants/${tenantId}/users/${target.membershipId}/reveal-destination`,
        ),
  );
  await destination.getByRole("button", { name: "Reveal email" }).click();
  expect((await revealResponse).status()).toBe(200);
  await expect(page.getByText(target.email, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide" })).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByText(target.email, { exact: true })).toHaveCount(0);

  const recovery = page.locator("form").filter({
    has: page.getByRole("button", { name: "Generate password reset link" }),
  });
  await recovery
    .getByLabel("Current Platform Admin password")
    .fill(adminCredentials.password);
  await recovery
    .getByLabel("Reason")
    .fill("Generate a support recovery link through the platform UI");
  const recoveryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/platform/tenants/${tenantId}/users/${target.membershipId}/password-reset`,
        ),
  );
  await recovery
    .getByRole("button", { name: "Generate password reset link" })
    .click();
  expect((await recoveryResponse).status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "Copy reset link" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(
    page.getByRole("button", { name: "Copy reset link" }),
  ).toHaveCount(0);

  const tenantActor = await actorPage(browser, fixture.actors.owner);
  const deniedReveal = await api(
    tenantActor.page,
    `/platform/tenants/${tenantId}/users/${target.membershipId}/reveal-destination`,
    {
      method: "POST",
      data: {
        expectedVersion: before.version,
        reason: "Tenant actor must not reveal platform dossier email",
        currentPassword: adminCredentials.password,
      },
    },
  );
  expect(deniedReveal.status()).toBe(403);
  await tenantActor.context.close();
});
