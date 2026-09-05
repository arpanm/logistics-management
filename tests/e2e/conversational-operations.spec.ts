import { expect, test } from "@playwright/test";
import { loginDemoUser } from "../fixtures/demo-data";

test.setTimeout(120_000);

test("INT02-E2E-001 signed-in tenant actor receives a safe clarification without a mutation", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/assistant");

  await expect(page.getByLabel("Assistant workspace")).toBeVisible();
  await expect(page.getByText("demo.owner@logistics.test")).toBeVisible();
  await expect(
    page.getByText("What can I ask?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Conversation language")).toHaveValue("en");
  const start = page.getByRole("button", { name: "Start conversation" });
  if (await start.isVisible()) await start.click();
  else await page.getByRole("button", { name: "New", exact: true }).click();

  const message = `Please teleport shipment ${Date.now()} to the moon`;
  await page.getByLabel("Message the assistant").fill(message);
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      /\/api\/v1\/conversations\/threads\/[^/]+\/messages$/.test(
        new URL(item.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Send" }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("log")).toContainText(message);
  await expect(page.getByRole("log")).toContainText(
    /could not safely match|available action|please state/i,
  );
  await expect(
    page.getByRole("button", { name: "Confirm and execute" }),
  ).toHaveCount(0);
});

test("INT02-E2E-002 a structured write is previewed and explicitly confirmed once", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/assistant");
  const start = page.getByRole("button", { name: "Start conversation" });
  if (await start.isVisible()) await start.click();
  else await page.getByRole("button", { name: "New", exact: true }).click();

  const label = `INT02-${Date.now()}`;
  await page
    .getByLabel("Message the assistant")
    .fill(`Create a probe with label ${label}, note conversational E2E`);
  await page.getByRole("button", { name: "Send" }).click();

  const review = page.getByRole("button", { name: "Review and confirm" });
  await expect(review).toBeVisible();
  await expect(page.getByLabel(/structured change preview/i)).toContainText(
    label,
  );
  await review.click();
  const confirmation = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      /\/api\/v1\/conversations\/proposals\/[^/]+\/confirm$/.test(
        new URL(item.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Confirm and execute" }).click();
  expect((await confirmation).status()).toBe(200);
  await expect(
    page.getByText("The approved action was executed and audited."),
  ).toBeVisible();
});

test("INT02-E2E-004 governed document upload shows preparation and quarantine state", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/assistant");
  const start = page.getByRole("button", { name: "Start conversation" });
  if (await start.isVisible()) await start.click();
  else await page.getByRole("button", { name: "New", exact: true }).click();

  await page.getByLabel("Attach files").setInputFiles({
    name: "delivery-note.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nINT-02 governed upload fixture\n%%EOF"),
  });
  await expect(page.getByText("Attachment ready to send.")).toBeVisible();
  await page
    .getByLabel("Message the assistant")
    .fill("Store the attached delivery note for governed review");
  await page.getByRole("button", { name: "Send" }).click();

  const statuses = page.getByLabel("Conversation attachment status");
  await expect(statuses).toContainText("delivery-note.pdf");
  await expect(statuses).toContainText("Quarantined");
});

test("INT02-E2E-003 mobile workspace has a usable sticky composer and no horizontal page overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/assistant");

  const start = page.getByRole("button", { name: "Start conversation" });
  if (await start.isVisible()) await start.click();
  await expect(page.getByLabel("Message the assistant")).toBeVisible();
  await expect(page.getByText(/Up to \d+ files/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
