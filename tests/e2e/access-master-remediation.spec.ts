import { expect, test } from "@playwright/test";
import {
  acceptInvitation,
  login,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";
import { actorPage, seedFnd02 } from "../fixtures/fnd02";

test("E2E-RAPID-FND02-01: filtered directory exposes editable profile, invitation, sessions, MFA and history", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "SCOPES_ONLY");
  const ownerSession = await actorPage(browser, fixture.actors.owner);
  const owner = ownerSession.page;
  await owner.goto("/app/access/users");
  const filters = owner.getByRole("form", { name: "User directory filters" });
  await filters.getByLabel("Status").selectOption("ACTIVE");
  await filters.getByLabel("Portal audience").selectOption("INTERNAL");
  await expect(owner.getByText(/Page 1 of/)).toBeVisible();
  await owner
    .locator("article.access-card")
    .first()
    .getByRole("button", { name: "View details" })
    .click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByText("Invitation, sessions and MFA")).toBeVisible();
  await expect(dialog.getByText("Profile and security history")).toBeVisible();
  await dialog.getByText("Edit user profile").click();
  await dialog.getByLabel("Display name").fill("Rapid Directory Owner");
  const response = owner.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().includes("/tenant/access/remediation/users/") &&
      candidate.url().endsWith("/profile"),
  );
  await dialog.getByRole("button", { name: "Save profile" }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog.getByRole("status")).toContainText(
    "User profile updated",
  );
  await expect(dialog.getByLabel("Display name")).toHaveValue(
    "Rapid Directory Owner",
  );
  await ownerSession.context.close();
});

test("E2E-RAPID-MST03-01: configured catalogs drive fleet selection and vendor PIN derives address", async ({
  page,
}) => {
  const tenant = tenantFixture(
    `rapid-masters-${crypto.randomUUID().slice(0, 8)}`,
  );
  await login(page);
  const provisioned = await provisionViaApi(page, tenant);
  await acceptInvitation(page, provisioned.invitationUrl, tenant.ownerName);

  await page.goto("/app/masters/catalogs");
  await page.getByLabel("Reference kind").selectOption("TRUCK_TYPE");
  await page.getByLabel("Code").fill("LCV");
  await page.getByLabel("Name").fill("Light commercial vehicle");
  await page.getByLabel("Capacity milli-units (Optional)").fill("3500000");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("status")).toContainText("Master record created");

  await page.goto("/app/masters/vendors");
  await page.getByLabel("Vendor code").fill("PIN-VENDOR");
  await page.getByLabel("Legal name").fill("PIN Derived Vendor Pvt Ltd");
  await page.getByLabel("Address line 1").fill("1 Directory Road");
  const lookup = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      candidate.url().includes("postalCode=700001"),
  );
  await page.getByLabel("PIN code").fill("700001");
  expect((await lookup).status()).toBe(200);
  await expect(page.getByText("Directory-derived address")).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("status")).toContainText("Master record created");
  await expect(page.getByText("PIN Derived Vendor Pvt Ltd")).toBeVisible();
});
