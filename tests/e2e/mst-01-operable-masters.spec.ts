import { expect, test, type Page } from "@playwright/test";
import {
  acceptInvitation,
  api,
  expectNoPageOverflow,
  expectNoSeriousAccessibilityViolations,
  login,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";
import { actorPage, seedFnd02 } from "../fixtures/fnd02";

test.setTimeout(120_000);

const unique = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
const useRealTestControls = process.env.MST01_REAL_TEST_CONTROLS === "true";

type MstCounts = {
  organizationNodes: number;
  closureRows: number;
  employees: number;
  assignments: number;
  audits: number;
  outbox: number;
};

async function testControl<T>(page: Page, path: string, data: object) {
  const response = await api(page, `/domain/masters/test-controls/${path}`, {
    method: "POST",
    data,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as T;
}

async function ownerTenant(page: Page, label: string) {
  const tenant = tenantFixture(label);
  await login(page);
  const provisioned = await provisionViaApi(page, tenant);
  await acceptInvitation(page, provisioned.invitationUrl, tenant.ownerName);
  return { tenant, provisioned };
}

async function createNodeThroughUi(
  page: Page,
  input: {
    code: string;
    name: string;
    nodeType: "LEGAL_ENTITY" | "REGION" | "BRANCH" | "TEAM";
    parentId?: string;
    address?: { pin: string; line1: string };
  },
) {
  await page.getByLabel("Code", { exact: true }).fill(input.code);
  await page.getByLabel("Name", { exact: true }).fill(input.name);
  await page.getByLabel("Node type").selectOption(input.nodeType);
  if (input.parentId)
    await page
      .getByLabel("Parent node", { exact: true })
      .selectOption(input.parentId);
  await page.getByLabel("Timezone").selectOption("Asia/Kolkata");
  if (input.address) {
    await page.getByLabel("Address line 1").fill(input.address.line1);
    const postalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/api/v1/domain/masters/postal-localities") &&
        response.url().includes(`postalCode=${input.address!.pin}`),
    );
    await page.getByLabel("PIN code").fill(input.address.pin);
    expect((await postalResponse).status()).toBe(200);
    const locality = page.getByLabel("Locality");
    if (await locality.isVisible()) await locality.selectOption({ index: 1 });
    await expect(
      page.locator(".derived-fields span").filter({ hasText: /^CityKolkata$/ }),
    ).toBeVisible();
    await expect(
      page
        .locator(".derived-fields span")
        .filter({ hasText: /^StateWest Bengal$/ }),
    ).toBeVisible();
    await page.getByLabel("Latitude (Optional)").fill("22.5726");
    await page.getByLabel("Longitude (Optional)").fill("88.3639");
    await page.getByLabel("Radius (km)").fill("3");
  }
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/domain/masters/organization"),
  );
  await page.getByRole("button", { name: "Create node" }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string; version: number };
}

async function createOrganizationApi(
  page: Page,
  input: {
    code: string;
    name: string;
    nodeType: "LEGAL_ENTITY" | "REGION" | "BRANCH" | "TEAM";
    parentId?: string | null;
  },
) {
  const response = await api(page, "/domain/masters/organization", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      ...input,
      parentId: input.parentId ?? null,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      activeTo: null,
      address: null,
      geofence: null,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string; version: number };
}

async function assignRoleAtScope(
  owner: Page,
  membershipId: string,
  roleId: string,
  scopeNodeId: string,
) {
  const detailResponse = await api(
    owner,
    `/tenant/access/users/${membershipId}`,
  );
  expect(detailResponse.status(), await detailResponse.text()).toBe(200);
  const detail = (await detailResponse.json()) as { version: number };
  const assignments = [
    {
      roleId,
      grants: [
        {
          scopeNodeId,
          actions: ["READ", "CREATE", "UPDATE", "EXPORT"],
        },
      ],
    },
  ];
  const previewResponse = await api(
    owner,
    `/tenant/access/users/${membershipId}/preview`,
    {
      method: "POST",
      data: { expectedVersion: detail.version, assignments },
    },
  );
  expect(previewResponse.status(), await previewResponse.text()).toBe(200);
  const preview = (await previewResponse.json()) as { fingerprint: string };
  const update = await api(owner, `/tenant/access/users/${membershipId}`, {
    method: "PATCH",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      expectedVersion: detail.version,
      assignments,
      reason: "Move regional administration to the canonical North hierarchy",
      previewFingerprint: preview.fingerprint,
    },
  });
  expect(update.status(), await update.text()).toBe(200);
}

test("E2E-MST01-01 FSUX-E2E-001 FSUX-E2E-002 permitted hub, hierarchy, PIN/geofence, employee and assignment journey", async ({
  page,
}) => {
  await ownerTenant(page, "Mst01Primary");
  await page.goto("/app/masters");
  await expect(page.getByRole("heading", { name: "Masters" })).toBeVisible();
  await page
    .locator("main")
    .getByRole("link", { name: "Organization & geography" })
    .click();
  const legalEntity = await createNodeThroughUi(page, {
    code: unique("LEGAL"),
    name: "Primary legal entity",
    nodeType: "LEGAL_ENTITY",
  });

  const region = await createNodeThroughUi(page, {
    code: unique("NORTH"),
    name: "North region",
    nodeType: "REGION",
    parentId: legalEntity.id,
  });
  const branchCode = unique("BLR");
  const branch = await createNodeThroughUi(page, {
    code: branchCode,
    name: "Kolkata branch",
    nodeType: "BRANCH",
    parentId: region.id,
    address: { pin: "700001", line1: "17 Operations Avenue" },
  });

  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill(branchCode);
  await page
    .getByRole("treeitem")
    .filter({ hasText: branchCode })
    .getByRole("button")
    .click();
  await expect(page.getByText("700001", { exact: false })).toBeVisible();
  await expect(page.getByText("Kolkata, West Bengal")).toBeVisible();

  await page.goto("/app/masters/employees");
  const employeeCode = unique("EMP");
  await page.getByLabel("Employee code").fill(employeeCode);
  await page.getByLabel("Display name").fill("MST primary employee");
  await page.getByLabel("Designation").fill("Traffic manager");
  await page.getByLabel("Mobile (Optional)").fill("+91 99999 99999");
  await page.getByLabel("Search Home organization node").fill(branchCode);
  const home = page.getByLabel("Home organization node", { exact: true });
  await expect(home.locator(`option[value="${branch.id}"]`)).toHaveCount(1);
  await home.selectOption(branch.id);
  await page
    .getByLabel("Search permitted active regions")
    .locator("..")
    .locator("select")
    .selectOption(region.id);
  const employeeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/domain/masters/employees"),
  );
  const employeeForm = page
    .getByRole("button", { name: "Create employee" })
    .locator("xpath=ancestor::form");
  await employeeForm.getByRole("button", { name: "Create employee" }).click();
  const createdEmployeeResponse = await employeeResponse;
  expect(createdEmployeeResponse.status()).toBe(201);
  const createdEmployee = (await createdEmployeeResponse.json()) as {
    id: string;
  };
  await expect(employeeForm.getByRole("status")).toHaveText(
    "Employee created.",
  );
  await expect(employeeForm.getByLabel("Employee code")).toHaveValue("");
  await expect(employeeForm.getByLabel("Display name")).toHaveValue("");
  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill(employeeCode);
  await page.getByRole("button", { name: "View" }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page
    .getByRole("button", { name: "Save changes" })
    .locator("xpath=ancestor::form");
  await editForm.getByLabel("Designation").fill("Senior traffic manager");
  await editForm
    .getByLabel("Reason for change")
    .fill("Promote after the operational ownership review");
  const updateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response
        .url()
        .endsWith(`/api/v1/domain/masters/employees/${createdEmployee.id}`),
  );
  await editForm.getByRole("button", { name: "Save changes" }).click();
  expect((await updateResponse).status()).toBe(200);
  await expect(editForm.getByRole("status")).toHaveText("Employee updated.");
  await expect(editForm.getByLabel("Designation")).toHaveValue(
    "Senior traffic manager",
  );
  await expect(editForm.getByLabel("Employee code")).toHaveValue(employeeCode);
  await expect(editForm.getByLabel("Reason for change")).toHaveValue("");

  await expect(
    page.getByRole("heading", { name: "Add operational assignment" }),
    "MST-01 requires an operator-facing assignment form with searchable references",
  ).toBeVisible();
  await page.getByLabel("Assignment type").selectOption("QUEUE_OWNER");
  await page.getByLabel("Search Organization node").fill(branchCode);
  const assignmentNode = page.getByLabel("Organization node (Optional)", {
    exact: true,
  });
  await expect(
    assignmentNode.locator("option").filter({ hasText: "Kolkata branch" }),
  ).toHaveCount(1);
  await assignmentNode.selectOption({ label: "Kolkata branch" });
  await page.getByLabel("Effective from").fill("2026-08-25T09:00");
  const assignmentResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/domain/commands/assignments/bulk"),
  );
  await page.getByRole("button", { name: "Add assignment" }).click();
  expect((await assignmentResponse).status()).toBe(201);
  const impact = (await (
    await api(page, `/domain/masters/employees/${createdEmployee.id}/impact`)
  ).json()) as {
    categories: { assignments: { count: number } };
  };
  expect(impact.categories.assignments.count).toBe(1);
});

test("E2E-MST01-02 validation is accessible and creates no partial records", async ({
  page,
}) => {
  await ownerTenant(page, "Mst01Validation");
  await page.goto("/app/masters/locations");
  const legalCode = unique("LEGAL");
  const legalEntity = await createOrganizationApi(page, {
    code: legalCode,
    name: "Validation legal entity",
    nodeType: "LEGAL_ENTITY",
  });
  const region = await createOrganizationApi(page, {
    code: unique("REGION"),
    name: "Validation region",
    nodeType: "REGION",
    parentId: legalEntity.id,
  });
  await page.reload();
  const before = (await (
    await api(page, "/domain/masters/organization")
  ).json()) as {
    total: number;
  };
  const badCode = unique("BAD");
  const auditBefore = (await (
    await api(
      page,
      `/tenant/access/reports/audit-log?search=${encodeURIComponent(badCode)}`,
    )
  ).json()) as { total: number };
  const exactBefore = useRealTestControls
    ? await testControl<MstCounts>(page, "counts", {})
    : null;
  await page.getByLabel("Code", { exact: true }).fill(badCode);
  await page.getByLabel("Name", { exact: true }).fill("Invalid branch");
  await page.getByLabel("Node type").selectOption("BRANCH");
  // A legal entity is not an offered parent for a branch. Submit without a parent,
  // with reversed dates and an unknown PIN, and prove no partial write occurs.
  await expect(
    page
      .getByLabel("Parent node", { exact: true })
      .locator(`option[value="${legalEntity.id}"]`),
  ).toHaveCount(0);
  await page.getByLabel("Active from").fill("2026-08-25");
  await page.getByLabel("Active to (Optional)").fill("2026-08-24");
  await page.getByLabel("Address line 1").fill("Retain this address");
  const postalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("postalCode=999999"),
  );
  await page.getByLabel("PIN code").fill("999999");
  expect((await postalResponse).status()).toBe(404);
  await expect(
    page.getByText("This PIN code is not in the postal directory", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create node" }).click();
  const after = (await (
    await api(page, "/domain/masters/organization")
  ).json()) as { total: number };
  expect(after.total).toBe(before.total);
  await expect(page.getByLabel("Address line 1")).toHaveValue(
    "Retain this address",
  );
  await expect(page.getByLabel("Parent node", { exact: true })).toBeFocused();
  await expect
    .soft(
      page.getByLabel("PIN code"),
      "the PIN error must be programmatically associated with its field",
    )
    .toHaveAttribute("aria-invalid", "true");

  // Correct hierarchy/date/PIN, but submit an incomplete polygon. Server-side
  // validation must still leave organization, audit, and downstream state clean.
  await page.getByLabel("Parent node", { exact: true }).selectOption(region.id);
  await page.getByLabel("Active to (Optional)").fill("");
  const validPostal = page.waitForResponse((response) =>
    response.url().includes("postalCode=700001"),
  );
  await page.getByLabel("PIN code").fill("700001");
  expect((await validPostal).status()).toBe(200);
  await page.getByLabel("Method").selectOption("POLYGON");
  await page
    .getByRole("textbox", { name: /Polygon vertices/ })
    .fill("22.572600,88.363900\n22.573000,88.364500");
  await page.getByRole("button", { name: "Create node" }).click();
  await expect(
    page.locator(".error").filter({ hasText: /polygon|vertices/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /Polygon vertices/ }),
  ).toBeFocused();
  const afterFence = (await (
    await api(page, "/domain/masters/organization")
  ).json()) as { total: number };
  expect(afterFence.total).toBe(before.total);
  const auditAfter = (await (
    await api(
      page,
      `/tenant/access/reports/audit-log?search=${encodeURIComponent(badCode)}`,
    )
  ).json()) as { total: number };
  expect(auditAfter.total).toBe(auditBefore.total);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/masters/employees");
  const employeesBefore = (await (
    await api(page, "/domain/masters/employees")
  ).json()) as { total: number };
  await page.getByLabel("Employee code").fill(unique("BAD-MOBILE"));
  await page.getByLabel("Display name").fill("Invalid mobile employee");
  await page.getByLabel("Designation").fill("Traffic executive");
  await page.getByLabel("Mobile (Optional)").fill("12345");
  await page.getByLabel("Search Home organization node").fill(legalCode);
  const homeNode = page.getByLabel("Home organization node", { exact: true });
  await expect(
    homeNode.locator(`option[value="${legalEntity.id}"]`),
  ).toHaveCount(1);
  await homeNode.selectOption(legalEntity.id);
  const invalidEmployeeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/domain/masters/employees"),
  );
  await page.getByRole("button", { name: "Create employee" }).click();
  expect((await invalidEmployeeResponse).status()).toBe(400);
  await expect(
    page.locator(".error").filter({ hasText: "mobile" }),
  ).toBeVisible();
  const employeesAfter = (await (
    await api(page, "/domain/masters/employees")
  ).json()) as { total: number };
  expect(employeesAfter.total).toBe(employeesBefore.total);
  if (exactBefore) {
    const exactAfter = await testControl<MstCounts>(page, "counts", {});
    expect(exactAfter).toEqual(exactBefore);
  }
  await expectNoPageOverflow(page);
});

test("E2E-MST01-03 tenant, role and scope restrictions are enforced in UI and API", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "ACCESS_MATRIX");
  const owner = await actorPage(browser, fixture.actors.owner);
  const root = await createOrganizationApi(owner.page, {
    code: unique("MATRIX-LE"),
    name: "Matrix legal entity",
    nodeType: "LEGAL_ENTITY",
  });
  const north = await createOrganizationApi(owner.page, {
    code: unique("NORTH-LE"),
    name: "North region",
    nodeType: "REGION",
    parentId: root.id,
  });
  const south = await createOrganizationApi(owner.page, {
    code: unique("SOUTH-LE"),
    name: "South region",
    nodeType: "REGION",
    parentId: root.id,
  });
  const northDetail = (await (
    await api(owner.page, `/domain/masters/organization/${north.id}`)
  ).json()) as { authorizationScopeNodeId: string };
  await assignRoleAtScope(
    owner.page,
    fixture.actors.regional.membershipId,
    fixture.roles.TENANT_OWNER,
    northDetail.authorizationScopeNodeId,
  );
  const regional = await actorPage(browser, fixture.actors.regional);
  const before = await api(regional.page, "/domain/masters/organization");
  expect(before.status(), await before.text()).toBe(200);
  const scopedList = (await before.json()) as {
    permissions: { canCreate: boolean; canUpdate: boolean };
    items: Array<{ id: string; name: string }>;
  };
  expect(scopedList.permissions).toMatchObject({
    canCreate: true,
    canUpdate: true,
  });
  expect(scopedList.items.map((item) => item.id)).toContain(north.id);
  expect(scopedList.items.map((item) => item.id)).not.toContain(south.id);
  expect(
    (
      await api(regional.page, `/domain/masters/organization/${north.id}`)
    ).status(),
  ).toBe(200);
  expect(
    (
      await api(regional.page, `/domain/masters/organization/${south.id}`)
    ).status(),
  ).toBe(404);

  const northChild = await api(regional.page, "/domain/masters/organization", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      code: unique("NORTH-REGION"),
      name: "North scoped region",
      nodeType: "BRANCH",
      parentId: north.id,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      activeTo: null,
      address: {
        line1: "1 North scoped road",
        line2: null,
        country: "IN",
        postalCode: "700001",
        postalLocalityId: "70000100-0000-4000-8000-000000000001",
      },
      geofence: null,
    },
  });
  expect(northChild.status(), await northChild.text()).toBe(201);
  const northChildBody = (await northChild.json()) as {
    id: string;
    version: number;
  };
  const southDenied = await api(regional.page, "/domain/masters/organization", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      code: unique("SOUTH-DENIED"),
      name: "South denied region",
      nodeType: "BRANCH",
      parentId: south.id,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      activeTo: null,
      address: {
        line1: "1 South scoped road",
        line2: null,
        country: "IN",
        postalCode: "700001",
        postalLocalityId: "70000100-0000-4000-8000-000000000001",
      },
      geofence: null,
    },
  });
  expect(southDenied.status()).toBe(404);
  const northUpdate = await api(
    regional.page,
    `/domain/masters/organization/${northChildBody.id}`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        name: "North scoped region updated",
        expectedVersion: northChildBody.version,
        reason: "Verify scoped update action",
      },
    },
  );
  expect(northUpdate.status(), await northUpdate.text()).toBe(200);
  const southUpdate = await api(
    regional.page,
    `/domain/masters/organization/${south.id}`,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        name: "Forbidden south update",
        expectedVersion: south.version,
        reason: "Verify scoped denial",
      },
    },
  );
  expect(southUpdate.status()).toBe(404);
  await regional.page.goto("/app/masters/locations");
  await expect(
    regional.page.getByRole("heading", { name: "Create organization node" }),
  ).toBeVisible();
  await regional.page.getByLabel("Node type").selectOption("BRANCH");
  await expect(
    regional.page
      .getByLabel("Parent node", { exact: true })
      .locator(`option[value="${north.id}"]`),
  ).toHaveCount(1);
  await expect(
    regional.page
      .getByLabel("Parent node", { exact: true })
      .locator(`option[value="${south.id}"]`),
  ).toHaveCount(0);

  const client = await actorPage(browser, fixture.actors.client);
  const clientList = await api(client.page, "/domain/masters/organization");
  expect(clientList.status(), await clientList.text()).toBe(403);
  const clientDenied = await api(client.page, "/domain/masters/organization", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      code: unique("CLIENT-DENIED"),
      name: "Client viewer denied node",
      nodeType: "LEGAL_ENTITY",
      parentId: null,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      activeTo: null,
      address: null,
      geofence: null,
    },
  });
  expect(clientDenied.status()).toBe(403);
  await client.page.goto("/app/masters/locations");
  await expect(
    client.page.getByRole("heading", { name: "Create organization node" }),
  ).toHaveCount(0);

  const firstTenant = tenantFixture("Mst01TenantA");
  const secondTenant = tenantFixture("Mst01TenantB");
  await login(page);
  const provisionedA = await provisionViaApi(page, firstTenant);
  const provisionedB = await provisionViaApi(page, secondTenant);
  const ownerAContext = await browser.newContext();
  const ownerBContext = await browser.newContext();
  const ownerAPage = await ownerAContext.newPage();
  const ownerBPage = await ownerBContext.newPage();
  await acceptInvitation(
    ownerAPage,
    provisionedA.invitationUrl,
    firstTenant.ownerName,
  );
  await acceptInvitation(
    ownerBPage,
    provisionedB.invitationUrl,
    secondTenant.ownerName,
  );
  const known = await createOrganizationApi(ownerAPage, {
    code: unique("PRIVATE"),
    name: "Tenant A private organization",
    nodeType: "LEGAL_ENTITY",
  });
  const foreign = await api(
    ownerBPage,
    `/domain/masters/organization/${known.id}`,
  );
  expect(foreign.status()).toBe(404);
  await owner.context.close();
  await regional.context.close();
  await client.context.close();
  await ownerAContext.close();
  await ownerBContext.close();
});

test("E2E-MST01-04 PIN recovery and reassignment/deactivation are operable", async ({
  page,
}) => {
  await ownerTenant(page, "Mst01Recovery");
  await page.goto("/app/masters/locations");
  await page.getByLabel("Address line 1").fill("Preserved address line");
  const ambiguous = page.waitForResponse((response) =>
    response.url().includes("postalCode=110001"),
  );
  await page.getByLabel("PIN code").fill("110001");
  expect((await ambiguous).status()).toBe(200);
  const locality = page.getByLabel("Locality");
  await expect(locality.locator("option")).toHaveCount(3);
  const parliament = locality
    .locator("option")
    .filter({ hasText: "Parliament Street" });
  await locality.selectOption((await parliament.getAttribute("value")) ?? "");
  await expect(
    page
      .locator(".derived-fields span")
      .filter({ hasText: /^LocalityParliament Street$/ }),
  ).toBeVisible();
  if (useRealTestControls) {
    await testControl(page, "postal/fail-next", { postalCode: "500016" });
    const transientFailure = page.waitForResponse(
      (response) =>
        response.url().includes("postalCode=500016") &&
        response.status() === 503,
    );
    await page.getByLabel("PIN code").fill("500016");
    expect((await transientFailure).status()).toBe(503);
    await expect(page.getByLabel("Address line 1")).toHaveValue(
      "Preserved address line",
    );
    const transientRetry = page.waitForResponse(
      (response) =>
        response.url().includes("postalCode=500016") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Retry PIN lookup" }).click();
    expect((await transientRetry).status()).toBe(200);
    await expect(page.getByLabel("Address line 1")).toHaveValue(
      "Preserved address line",
    );

    const postal = await api(
      page,
      "/domain/masters/postal-localities?postalCode=700001",
    );
    expect(postal.status(), await postal.text()).toBe(200);
    const postalBody = (await postal.json()) as {
      items: Array<{ id: string }>;
    };
    const postalLocalityId = postalBody.items[0]!.id;
    const beforeStale = await testControl<MstCounts>(page, "counts", {});
    await testControl(page, "postal/stale-next", { postalLocalityId });
    const stalePayload = {
      code: unique("STALE-PIN"),
      name: "Stale postal selection",
      nodeType: "LEGAL_ENTITY",
      parentId: null,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      activeTo: null,
      address: {
        line1: "Postal race address",
        line2: null,
        country: "IN",
        postalCode: "700001",
        postalLocalityId,
      },
      geofence: null,
    };
    const stale = await api(page, "/domain/masters/organization", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: stalePayload,
    });
    expect(stale.status(), await stale.text()).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "POSTAL_REFERENCE_CHANGED",
    });
    expect(await testControl<MstCounts>(page, "counts", {})).toEqual(
      beforeStale,
    );
    const staleRetry = await api(page, "/domain/masters/organization", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: stalePayload,
    });
    expect(staleRetry.status(), await staleRetry.text()).toBe(201);
  }
  const unknown = page.waitForResponse((response) =>
    response.url().includes("postalCode=999999"),
  );
  await page.getByLabel("PIN code").fill("999999");
  expect((await unknown).status()).toBe(404);
  await expect(page.getByLabel("Address line 1")).toHaveValue(
    "Preserved address line",
  );
  await expect
    .soft(
      page.getByRole("button", { name: "Retry PIN lookup" }),
      "postal lookup failures require a specific retry control that preserves inputs",
    )
    .toBeVisible();
  const retried = page.waitForResponse((response) =>
    response.url().includes("postalCode=999999"),
  );
  const retry = page.getByRole("button", { name: "Retry PIN lookup" });
  if (await retry.isVisible()) {
    await retry.click();
    expect((await retried).status()).toBe(404);
    await expect(page.getByLabel("Address line 1")).toHaveValue(
      "Preserved address line",
    );
  }

  await page.goto("/app/masters/employees");
  const employees = (await (
    await api(page, "/domain/masters/employees")
  ).json()) as { items: Array<{ id: string; displayName: string }> };
  let currentId = employees.items.find(
    (employee) => employee.displayName === "Current manager",
  )?.id;
  let replacementId = employees.items.find(
    (employee) => employee.displayName === "Replacement manager",
  )?.id;
  if (!currentId || !replacementId) {
    const organizations = (await (
      await api(page, "/domain/masters/organization")
    ).json()) as { items: Array<{ id: string }> };
    const root =
      organizations.items[0] ??
      (await createOrganizationApi(page, {
        code: unique("LEGAL"),
        name: "Recovery legal entity",
        nodeType: "LEGAL_ENTITY",
      }));
    for (const label of ["Current manager", "Replacement manager"]) {
      const response = await api(page, "/domain/masters/employees", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: {
          employeeCode: unique("MGR"),
          displayName: label,
          designation: "Manager",
          email: null,
          mobile: null,
          managerId: null,
          homeNodeId: root.id,
          regionIds: [],
          linkedMembershipId: null,
          activeFrom: "2026-08-25",
          activeTo: null,
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      const employee = (await response.json()) as { id: string };
      if (label === "Current manager") currentId = employee.id;
      else replacementId = employee.id;
    }
    await page.reload();
  }
  expect(currentId).toBeTruthy();
  expect(replacementId).toBeTruthy();
  const assignment = await api(page, "/domain/commands/assignments/bulk", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      items: [
        {
          employeeId: currentId,
          assignmentType: "QUEUE_OWNER",
          organizationNodeId: (
            (await (
              await api(page, "/domain/masters/organization")
            ).json()) as { items: Array<{ id: string }> }
          ).items[0]!.id,
          effectiveFrom: "2026-08-25T03:30:00.000Z",
        },
      ],
    },
  });
  expect(assignment.status(), await assignment.text()).toBe(201);
  await page.reload();
  const currentRow = page
    .getByRole("row")
    .filter({ hasText: "Current manager" });
  const impactResponse = page.waitForResponse((response) =>
    response
      .url()
      .endsWith(`/api/v1/domain/masters/employees/${currentId}/impact`),
  );
  await currentRow.getByRole("button", { name: "View" }).click();
  const beforeImpact = (await (await impactResponse).json()) as {
    categories: { assignments: { count: number } };
  };
  expect(beforeImpact.categories.assignments.count).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Reassign and deactivate" }),
    "impact counts and replacement controls must be rendered before deactivation",
  ).toBeVisible();
  await page
    .getByLabel("Search Replacement employee")
    .fill("Replacement manager");
  const replacement = page.getByLabel("Replacement employee", {
    exact: true,
  });
  await expect(
    replacement.locator(`option[value="${replacementId}"]`),
  ).toHaveCount(1);
  await replacement.selectOption(replacementId!);
  const reassignForm = page
    .getByRole("heading", { name: "Reassign and deactivate" })
    .locator("..");
  await reassignForm
    .getByLabel("Reason")
    .fill("Transfer responsibilities for deactivation");
  const reassigned = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/domain/commands/employees/${currentId}/reassign-deactivate`,
        ),
  );
  await reassignForm
    .getByRole("button", {
      name: "Reassign responsibilities and deactivate",
    })
    .click();
  expect((await reassigned).status()).toBe(200);
  const current = await api(page, `/domain/masters/employees/${currentId}`);
  expect(await current.json()).toMatchObject({ state: "INACTIVE" });
  const replacementImpact = (await (
    await api(page, `/domain/masters/employees/${replacementId}/impact`)
  ).json()) as {
    categories: { assignments: { count: number } };
  };
  expect(replacementImpact.categories.assignments.count).toBe(1);
});

test("E2E-MST01-05 hierarchy/report/export reconciliation is accessible on mobile", async ({
  page,
}) => {
  await ownerTenant(page, "Mst01Report");
  const first = await createOrganizationApi(page, {
    code: unique("REPORT"),
    name: "Report root one",
    nodeType: "LEGAL_ENTITY",
  });
  expect(first.id).toBeTruthy();
  await createOrganizationApi(page, {
    code: unique("REPORT"),
    name: "Report root two",
    nodeType: "LEGAL_ENTITY",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/masters/locations");
  const canonical = (await (
    await api(page, "/domain/masters/organization")
  ).json()) as {
    total: number;
    items: Array<{ name: string; state: string }>;
  };
  await expect(page.getByRole("treeitem")).toHaveCount(canonical.total);
  await page.getByLabel("State").selectOption("ACTIVE");
  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill("Report root one");
  const matching = canonical.items.filter(
    (item) => item.state === "ACTIVE" && item.name === "Report root one",
  );
  await expect(page.getByRole("treeitem")).toHaveCount(matching.length);
  await expect(page.getByText("Report root two")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
  const employeesLink = page
    .getByRole("navigation", { name: "Masters" })
    .getByRole("link", { name: "Employees & ownership" });
  await employeesLink.focus();
  await expect(employeesLink).toBeFocused();
  await employeesLink.press("Enter");
  await expect(page).toHaveURL(/\/app\/masters\/employees$/);
  const report = (await (
    await api(page, "/domain/masters/ownership-report")
  ).json()) as {
    total: number;
    owned: number;
    unowned: number;
    inactiveOwner: number;
    noEscalation: number;
  };
  const coverage = page
    .getByRole("heading", { name: "Ownership coverage" })
    .locator("..");
  await expect(
    coverage
      .locator("article", { hasText: "Resources reviewed" })
      .locator("strong"),
  ).toHaveText(String(report.total));
  await expect(
    coverage.locator("article", { hasText: "Owned" }).locator("strong"),
  ).toHaveText(String(report.owned));
  await expect(
    coverage.locator("article", { hasText: "Exceptions" }).locator("strong"),
  ).toHaveText(
    String(report.unowned + report.inactiveOwner + report.noEscalation),
  );
  const download = page.waitForEvent("download");
  const exportLink = page.getByRole("link", {
    name: "Export permission-scoped CSV",
  });
  await exportLink.focus();
  await expect(exportLink).toBeFocused();
  await exportLink.press("Enter");
  expect((await download).suggestedFilename()).toContain("ownership");
  const evaluateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith("/api/v1/domain/masters/ownership-alerts/evaluate"),
  );
  const refreshAlerts = page.getByRole("button", {
    name: "Refresh ownership alerts",
  });
  await refreshAlerts.focus();
  await expect(refreshAlerts).toBeFocused();
  await refreshAlerts.press("Enter");
  expect((await evaluateResponse).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Open ownership alerts" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(
    page,
    "MST-01 organization mobile",
  );
});

test("E2E-MST01-07 temporary exception is visible, alerted and reactivatable", async ({
  page,
}) => {
  await ownerTenant(page, "Mst01Exception");
  const code = unique("EXCEPTION");
  const target = await createOrganizationApi(page, {
    code,
    name: "Temporary exception organization",
    nodeType: "LEGAL_ENTITY",
  });
  await page.goto("/app/masters/locations");
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill(code);
  await page.getByRole("treeitem").getByRole("button").click();
  await expect(
    page.getByRole("heading", { name: "Temporary deactivation exception" }),
  ).toBeVisible();
  const exceptionForm = page
    .getByRole("heading", { name: "Temporary deactivation exception" })
    .locator("..");
  await exceptionForm
    .getByLabel("Reason")
    .fill("Temporary operational exception requires privileged review");
  await exceptionForm.getByLabel("Review by").fill("2026-09-01");
  const deactivated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/domain/masters/organization/${target.id}/exception-deactivate`,
        ),
  );
  await exceptionForm
    .getByRole("button", { name: "Deactivate with temporary exception" })
    .click();
  expect((await deactivated).status()).toBe(200);
  expect(
    await (await api(page, `/domain/masters/organization/${target.id}`)).json(),
  ).toMatchObject({
    state: "INACTIVE",
  });

  const exceptionReport = (await (
    await api(page, "/domain/masters/exceptions")
  ).json()) as {
    items: Array<{ id: string; targetId: string; state: string }>;
  };
  const exception = exceptionReport.items.find(
    (item) => item.targetId === target.id,
  );
  expect(exception).toMatchObject({ state: "OPEN" });
  await page.goto("/app/masters/employees");
  const report = page.getByRole("region", {
    name: "Temporary deactivation exception report",
  });
  const reportRow = report
    .getByRole("row")
    .filter({ hasText: "Temporary exception organization" });
  await expect(reportRow).toContainText("OPEN");

  await page.goto("/app/alerts");
  await expect
    .soft(
      page.getByText("Master deactivation exception requires review"),
      "the privileged exception must be visible in the operational alert queue",
    )
    .toBeVisible();

  await page.goto("/app/masters/employees");
  const reactivateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/api/v1/domain/masters/exceptions/${exception!.id}/reactivate`,
        ),
  );
  await page
    .getByRole("region", { name: "Temporary deactivation exception report" })
    .getByRole("row")
    .filter({ hasText: "Temporary exception organization" })
    .getByRole("button", { name: "Reactivate" })
    .click();
  expect((await reactivateResponse).status()).toBe(200);
  expect(
    await (await api(page, `/domain/masters/organization/${target.id}`)).json(),
  ).toMatchObject({
    state: "ACTIVE",
  });
  await expect(
    page
      .getByRole("region", {
        name: "Temporary deactivation exception report",
      })
      .getByRole("row")
      .filter({ hasText: "Temporary exception organization" }),
  ).toContainText("RESOLVED");
});

test("MST01-C-006 server pagination and references find records beyond 50", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ownerTenant(page, "Mst01Pagination");
  const suffix = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 6)
    .toUpperCase();
  const roots: Array<{ id: string; code: string; name: string }> = [];
  for (let index = 0; index < 60; index += 1) {
    const code = `PG${suffix}${String(index).padStart(2, "0")}`;
    const created = await createOrganizationApi(page, {
      code,
      name: `A pagination root ${String(index).padStart(2, "0")}`,
      nodeType: "LEGAL_ENTITY",
    });
    roots.push({ ...created, code, name: `A pagination root ${index}` });
  }
  const targetRootCode = `ZZROOT${suffix}`;
  const targetRoot = await createOrganizationApi(page, {
    code: targetRootCode,
    name: "ZZ target pagination root",
    nodeType: "LEGAL_ENTITY",
  });
  const targetRegionCode = `ZZREG${suffix}`;
  const targetRegion = await createOrganizationApi(page, {
    code: targetRegionCode,
    name: "ZZ target pagination region",
    nodeType: "REGION",
    parentId: targetRoot.id,
  });

  const employees: Array<{ id: string; employeeCode: string }> = [];
  for (let index = 0; index < 60; index += 1) {
    const employeeCode = `PE${suffix}${String(index).padStart(2, "0")}`;
    const response = await api(page, "/domain/masters/employees", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        employeeCode,
        displayName: `A pagination employee ${String(index).padStart(2, "0")}`,
        designation: "Executive",
        email: null,
        mobile: null,
        managerId: null,
        homeNodeId: roots[index]!.id,
        regionIds: [],
        linkedMembershipId: null,
        activeFrom: "2026-08-25",
        activeTo: null,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    employees.push({
      id: String(((await response.json()) as { id: string }).id),
      employeeCode,
    });
  }
  const targetEmployeeCode = `ZZEMP${suffix}`;
  const targetEmployeeResponse = await api(page, "/domain/masters/employees", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      employeeCode: targetEmployeeCode,
      displayName: "ZZ target pagination employee",
      designation: "Manager",
      email: null,
      mobile: null,
      managerId: null,
      homeNodeId: targetRoot.id,
      regionIds: [targetRegion.id],
      linkedMembershipId: null,
      activeFrom: "2026-08-25",
      activeTo: null,
    },
  });
  expect(
    targetEmployeeResponse.status(),
    await targetEmployeeResponse.text(),
  ).toBe(201);
  const targetEmployee = (await targetEmployeeResponse.json()) as {
    id: string;
  };

  await page.goto("/app/masters/locations");
  const organizationTotal = (await (
    await api(page, "/domain/masters/organization?limit=1&offset=0")
  ).json()) as { total: number };
  await expect(page.getByRole("treeitem")).toHaveCount(50);
  await page
    .getByRole("button", { name: "Load more organization nodes" })
    .click();
  await expect(page.getByRole("treeitem")).toHaveCount(organizationTotal.total);
  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill(targetRootCode);
  await expect(page.getByRole("treeitem")).toHaveCount(1);
  await expect(page.getByRole("treeitem")).toContainText(targetRootCode);
  await page.getByLabel("Node type").selectOption("REGION");
  await page.getByLabel("Search Parent node").fill(targetRootCode);
  await expect(
    page
      .getByLabel("Parent node", { exact: true })
      .locator(`option[value="${targetRoot.id}"]`),
  ).toHaveCount(1);

  await page.goto("/app/masters/employees");
  const employeeTotal = (await (
    await api(page, "/domain/masters/employees?limit=1&offset=0")
  ).json()) as { total: number };
  const employeeDirectory = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Employee directory" }),
  });
  await expect(employeeDirectory.getByRole("row")).toHaveCount(51);
  await page.getByRole("button", { name: "Load more employees" }).click();
  await expect(employeeDirectory.getByRole("row")).toHaveCount(
    employeeTotal.total + 1,
  );
  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill(targetEmployeeCode);
  const targetRow = employeeDirectory
    .getByRole("row")
    .filter({ hasText: targetEmployeeCode });
  await expect(targetRow).toHaveCount(1);

  await page.getByLabel("Search Manager").fill(targetEmployeeCode);
  await expect(
    page
      .getByLabel("Manager (Optional)", { exact: true })
      .locator(`option[value="${targetEmployee.id}"]`),
  ).toHaveCount(1);
  await page.getByLabel("Search Home organization node").fill(targetRootCode);
  await expect(
    page
      .getByLabel("Home organization node", { exact: true })
      .locator(`option[value="${targetRoot.id}"]`),
  ).toHaveCount(1);
  await page
    .getByLabel("Search permitted active regions")
    .fill(targetRegionCode);
  await expect(
    page
      .getByLabel("Search permitted active regions")
      .locator("..")
      .locator("select")
      .locator(`option[value="${targetRegion.id}"]`),
  ).toHaveCount(1);
  await targetRow.getByRole("button", { name: "View" }).click();
  await page
    .getByLabel("Search Replacement employee")
    .fill(employees[59]!.employeeCode);
  await expect(
    page
      .getByLabel("Replacement employee", { exact: true })
      .locator(`option[value="${employees[59]!.id}"]`),
  ).toHaveCount(1);
});
