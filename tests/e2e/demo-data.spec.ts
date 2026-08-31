import { expect, test, type Page } from "@playwright/test";
import {
  DEMO_RECORDS,
  localDemoBaseURL,
  loginDemoUser,
} from "../fixtures/demo-data";

test.setTimeout(120_000);

const row = (page: Page, reference: string) =>
  page.getByRole("row").filter({ hasText: reference });

test("E2E-DEMO-001 platform and tenant owners open the seeded tenant, operations and control-tower story", async ({
  browser,
  page,
}, testInfo) => {
  const platformContext = await browser.newContext({
    baseURL: localDemoBaseURL(testInfo),
  });
  try {
    const platform = await platformContext.newPage();
    await loginDemoUser(platform, testInfo, "platform");
    await platform.getByLabel("Search tenants").fill("DEMO");
    const filtered = platform.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/api/v1/platform/tenants?") &&
        response.url().includes("search=DEMO"),
    );
    await platform.getByRole("button", { name: "Apply filters" }).click();
    expect((await filtered).status()).toBe(200);
    const demoTenant = platform
      .getByRole("article")
      .filter({ hasText: "Demo Logistics India" });
    await expect(demoTenant).toContainText("DEMO");
    await expect(demoTenant).toContainText("ACTIVE");
  } finally {
    await platformContext.close();
  }

  await loginDemoUser(page, testInfo, "owner");

  await page.goto("/app/operations");
  await expect(
    page.getByRole("heading", { name: "Open indent workbench" }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search" })
    .fill(DEMO_RECORDS.openIndent);
  const openIndent = row(page, DEMO_RECORDS.openIndent);
  await expect(openIndent).toContainText(DEMO_RECORDS.clientName);
  await expect(
    openIndent.getByRole("button", { name: "Allocate truck" }),
  ).toBeEnabled();

  await page.goto("/app/control");
  await expect(
    page.getByRole("heading", { name: "Control tower" }),
  ).toBeVisible();
  await page.getByLabel("Search visible scope").fill(DEMO_RECORDS.openIndent);
  await page
    .getByRole("button")
    .filter({ hasText: DEMO_RECORDS.clientName })
    .click();
  const location = page
    .getByRole("row")
    .filter({ hasText: DEMO_RECORDS.clientLocation });
  await location.getByRole("button", { name: "View records" }).click();
  await expect(row(page, DEMO_RECORDS.openIndent)).toBeVisible();
});

test("E2E-DEMO-002 traffic executive sees stable demand, allocation and trip records", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "traffic");

  await page.goto("/app/operations");
  await page
    .getByRole("searchbox", { name: "Search" })
    .fill(DEMO_RECORDS.offeredIndent);
  const offered = row(page, DEMO_RECORDS.offeredIndent);
  await expect(offered).toContainText(/Partially allocated/i);
  await expect(
    offered.getByRole("button", { name: "Allocate truck" }),
  ).toBeEnabled();

  await page.getByRole("link", { name: "Truck allocations" }).click();
  await page
    .getByRole("searchbox", { name: "Search" })
    .fill(DEMO_RECORDS.offeredIndent);
  await expect(row(page, DEMO_RECORDS.offeredIndent)).toContainText("OFFERED", {
    ignoreCase: true,
  });

  await page.getByRole("link", { name: "Trips", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search" })
    .fill(DEMO_RECORDS.liveIndent);
  const liveTrip = row(page, DEMO_RECORDS.liveIndent);
  await expect(liveTrip).toContainText(DEMO_RECORDS.liveLr);
  await expect(liveTrip).toContainText("IN TRANSIT", { ignoreCase: true });
});

test("E2E-DEMO-003 E2E-DEMO-004 finance executive reconciles seeded invoice, vendor bill and payout registers", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "finance");

  await page.goto("/app/finance");
  await expect(
    page.getByRole("heading", {
      name: "Billing, collections and payables",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pending client invoices" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "All invoices" }).first().click();
  await page
    .getByRole("searchbox", { name: "Search" })
    .fill(DEMO_RECORDS.submittedInvoice);
  const invoice = row(page, DEMO_RECORDS.submittedInvoice);
  await expect(invoice).toContainText("SUBMITTED", { ignoreCase: true });
  await expect(invoice).toContainText(DEMO_RECORDS.clientName);

  await page.getByRole("link", { name: "Collections & receipts" }).click();
  await expect(row(page, DEMO_RECORDS.receipt)).toContainText(
    DEMO_RECORDS.clientName,
  );

  await page.getByRole("link", { name: "Vendor payables" }).click();
  const bill = row(page, DEMO_RECORDS.vendorBill);
  await expect(bill).toContainText(DEMO_RECORDS.vendorName);
  await expect(bill).toContainText("PAID", { ignoreCase: true });

  await page.getByRole("link", { name: "Payment runs" }).click();
  const payout = row(page, DEMO_RECORDS.payoutBatch);
  await expect(payout).toContainText("PAID", { ignoreCase: true });
  await expect(payout).toContainText("DEMO-UTR-000001");
});

test("E2E-DEMO-005 vendor and client accounts land in their scoped portals", async ({
  browser,
}, testInfo) => {
  for (const account of ["vendor", "client"] as const) {
    const context = await browser.newContext({
      baseURL: localDemoBaseURL(testInfo),
    });
    try {
      const page = await context.newPage();
      const effective = await loginDemoUser(page, testInfo, account);
      expect(effective.portalAudience).toBe(account.toUpperCase());
      await expect(
        page.getByText("Only server-authorized work items"),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  }
});
