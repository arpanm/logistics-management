import { expect, test, type Page } from "@playwright/test";
import {
  acceptInvitation,
  api,
  login,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";

const routes = [
  ["/app/masters/locations", "Locations"],
  ["/app/masters/parties", "Clients and vendors"],
  ["/app/masters/fleet", "Fleet and drivers"],
  ["/app/operations/indents", "Indents"],
  ["/app/operations/allocations", "Vendor allocations"],
  ["/app/operations/trips", "Trips"],
  ["/app/pod", "Proof of delivery"],
  ["/app/finance/invoices", "Client invoices"],
  ["/app/finance/receipts", "Receipts and collections"],
  ["/app/finance/vendor-bills", "Vendor bills and payments"],
  ["/app/control", "Control tower"],
  ["/app/alerts", "Alerts and work queue"],
  ["/app/data", "Data imports"],
  ["/app/integrations", "Integrations"],
  ["/app/governance/policies", "Governance policies"],
  ["/app/configuration/settings", "Configuration"],
] as const;

async function expectHealthyRoute(page: Page, route: string, heading: string) {
  await page.goto(route, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(new RegExp(`${route.replaceAll("/", "\\/")}$`));
  await expect(
    page.getByRole("heading", { name: heading, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
}

test("rapid smoke: all feature routes plus kernel create/list/detail/transition", async ({
  page,
}) => {
  page.on("pageerror", (error) =>
    console.error(`RAPID_PAGE_ERROR: ${error.message}\n${error.stack ?? ""}`),
  );

  const tenant = tenantFixture("RapidAll");
  await login(page);
  const provisioned = await provisionViaApi(page, tenant);
  await acceptInvitation(page, provisioned.invitationUrl, tenant.ownerName);

  const suffix = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 8)
    .toUpperCase();
  const createdResponse = await api(page, "/modules/masters/locations", {
    method: "POST",
    headers: { "Idempotency-Key": `rapid-${suffix}` },
    data: {
      code: `RAPID-${suffix}`,
      name: `Rapid location ${suffix}`,
      data: {
        locationType: "BRANCH",
        address: "Rapid smoke address",
        timezone: "Asia/Kolkata",
      },
    },
  });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = (await createdResponse.json()) as {
    id: string;
    code: string;
    name: string;
    status: string;
    version: number;
  };
  expect(created).toMatchObject({
    code: `RAPID-${suffix}`,
    name: `Rapid location ${suffix}`,
    status: "DRAFT",
  });

  const listResponse = await api(
    page,
    `/modules/masters/locations?search=${encodeURIComponent(created.code)}`,
  );
  expect(listResponse.status(), await listResponse.text()).toBe(200);
  const listed = (await listResponse.json()) as {
    items: Array<{ id: string; code: string }>;
  };
  expect(listed.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: created.id, code: created.code }),
    ]),
  );

  const detailResponse = await api(
    page,
    `/modules/masters/locations/${created.id}`,
  );
  expect(detailResponse.status(), await detailResponse.text()).toBe(200);
  expect(await detailResponse.json()).toMatchObject({
    id: created.id,
    version: created.version,
    snapshots: expect.any(Array),
    events: expect.any(Array),
  });

  const transitionResponse = await api(
    page,
    `/modules/masters/locations/${created.id}/transition`,
    {
      method: "POST",
      data: { toStatus: "ACTIVE", expectedVersion: created.version },
    },
  );
  expect(transitionResponse.status(), await transitionResponse.text()).toBe(
    200,
  );
  expect(await transitionResponse.json()).toMatchObject({
    id: created.id,
    status: "ACTIVE",
    version: created.version + 1,
  });

  await page.goto("/app/masters/locations", { waitUntil: "networkidle" });
  await page.getByLabel("Search").fill(created.code);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const card = page
    .locator("article.record-card")
    .filter({ hasText: created.code });
  await expect(card).toContainText("ACTIVE");
  await card.getByRole("button", { name: "View details" }).click();
  await expect(
    page.getByRole("heading", { name: created.name, level: 2 }),
  ).toBeVisible();
  await expect(
    page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: created.name, level: 2 }),
    }),
  ).toContainText(/Status:\s*ACTIVE/);

  for (const [route, heading] of routes)
    await test.step(`${route} loads without a fatal alert`, async () => {
      await expectHealthyRoute(page, route, heading);
    });
});
