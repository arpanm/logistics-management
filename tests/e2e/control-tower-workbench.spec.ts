import { expect, test, type TestInfo } from "@playwright/test";
import {
  expectNoPageOverflow,
  expectNoSeriousAccessibilityViolations,
} from "../fixtures/fnd01";
import {
  createDraftInvoice,
  createWorkbenchWorld,
  makeDeliveredServiceInvoiceEligible,
  workbenchApi,
} from "../fixtures/ops-fin-ctl";

test.setTimeout(180_000);

async function seededControlWorld(
  browser: Parameters<typeof createWorkbenchWorld>[0],
  testInfo: TestInfo,
) {
  const world = await createWorkbenchWorld(browser, testInfo);
  await makeDeliveredServiceInvoiceEligible(world);
  await createDraftInvoice(world, `CTL-INV-${world.suffix}`);
  await workbenchApi(
    world.page,
    "/tenant/finance/vendor-bills",
    {
      method: "POST",
      data: {
        vendorInvoiceNo: `CTL-VB-${world.suffix}`,
        invoiceDate: "2026-08-27",
        vendorId: world.graph.vendor.id,
        gstMinor: "21600",
        lines: [{ tripId: world.graph.trip.id, claimedMinor: "120000" }],
      },
    },
    201,
  );
  return world;
}

const value = (record: Record<string, unknown>, camel: string, snake: string) =>
  String(record[camel] ?? record[snake]);

test("OFC-CTL-E2E-024 all five prototype-parity lenses render canonical KPIs, definitions and rows", async ({
  browser,
}, testInfo) => {
  const world = await seededControlWorld(browser, testInfo);
  try {
    await world.page.goto("/app/control");
    await expect(
      world.page.getByRole("heading", { name: "Control tower" }),
    ).toBeVisible();
    const lenses = [
      ["POD vs Invoice", "Delivery records, POD closure"],
      ["Collection", "Submitted invoices, receipts"],
      ["Trips", "Live execution, ETA risk"],
      ["Vendor Payable", "Verification, approval, disputes"],
      ["Placement", "Demand, placement ageing"],
    ] as const;
    for (const [lens, description] of lenses) {
      const responsePromise = world.page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes("/api/v1/control-workbench/") &&
          !response.url().endsWith("/access"),
      );
      await world.page.getByRole("tab", { name: lens }).click();
      expect((await responsePromise).status()).toBe(200);
      await expect(
        world.page.getByText(description, { exact: false }),
      ).toBeVisible();
      await expect(
        world.page.getByLabel(`${lens} key performance indicators`),
      ).toBeVisible();
      await expect(world.page.getByRole("status")).toContainText("As of");
      await expect(world.page.getByText("Ageing guide:")).toBeVisible();
    }
    await world.page.getByRole("tab", { name: "Placement" }).click();
    await expect(
      world.page.getByRole("link", { name: "Open allocation register" }),
    ).toBeVisible();
  } finally {
    await world.close();
  }
});

test("OFC-CTL-E2E-025 client-location-record drill reconciles breadcrumbs and contextual workflow links", async ({
  browser,
}, testInfo) => {
  const world = await seededControlWorld(browser, testInfo);
  try {
    const clientName = value(world.graph.client, "legalName", "legal_name");
    const locationName = value(world.graph.origin, "name", "name");
    const indentNo = value(world.graph.indent, "indentNo", "indent_no");
    await world.page.goto("/app/control");
    await world.page
      .getByRole("button")
      .filter({ hasText: clientName })
      .click();
    await expect(
      world.page.getByRole("heading", { name: "Location board" }),
    ).toBeVisible();
    const locationRow = world.page
      .getByRole("row")
      .filter({ hasText: locationName });
    await locationRow.getByRole("button", { name: "View records" }).click();
    await expect(
      world.page.getByRole("heading", { name: "indent register" }),
    ).toBeVisible();
    await expect(
      world.page.getByRole("row").filter({ hasText: indentNo }),
    ).toBeVisible();
    await expect(
      world.page.getByRole("link", { name: "Open in Operations" }),
    ).toHaveAttribute("href", new RegExp(`/app/operations/indents\\?search=`));

    const crumbs = world.page.getByRole("navigation", {
      name: "Drill-down breadcrumb",
    });
    await expect(
      crumbs.getByRole("button", { name: clientName }),
    ).toBeVisible();
    await crumbs.getByRole("button", { name: clientName }).click();
    await expect(
      world.page.getByRole("heading", { name: "Location board" }),
    ).toBeVisible();
    await crumbs.getByRole("button", { name: "All clients" }).click();
    await expect(
      world.page.getByRole("heading", { name: "Client portfolio" }),
    ).toBeVisible();
  } finally {
    await world.close();
  }
});

test("OFC-CTL-E2E-026 OFC-CTL-E2E-027 search, risk, saved view, pause/resume and visible CSV remain consistent", async ({
  browser,
}, testInfo) => {
  const world = await seededControlWorld(browser, testInfo);
  try {
    const indentNo = value(world.graph.indent, "indentNo", "indent_no");
    await world.page.goto("/app/control");
    await world.page.getByLabel("Search visible scope").fill(indentNo);
    await expect(world.page.getByText("1 scoped portfolios")).toBeVisible();
    await world.page.getByLabel("Traffic light").selectOption("GREEN");
    await world.page.getByRole("button", { name: "Save current view" }).click();
    const viewName = `Green ${world.suffix}`;
    await world.page.getByLabel("View name").fill(viewName);
    const savePromise = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/control-workbench/placement/views"),
    );
    await world.page.getByRole("button", { name: "Save view" }).click();
    expect((await savePromise).status()).toBe(201);
    await expect(world.page.getByLabel("View name")).toHaveCount(0);
    await expect(world.page.getByLabel("Search visible scope")).toHaveValue(
      indentNo,
    );
    await expect(world.page.getByLabel("Traffic light")).toHaveValue("GREEN");
    await expect(
      world.page
        .getByLabel("Saved filter / view")
        .getByRole("option", { name: viewName }),
    ).toHaveCount(1);

    await world.page
      .getByRole("button", { name: "Pause live refresh" })
      .click();
    await expect(
      world.page.getByRole("button", { name: "Resume live refresh" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(world.page.getByRole("status")).toContainText("PAUSED");
    await world.page
      .getByRole("button", { name: "Resume live refresh" })
      .click();

    const downloadPromise = world.page.waitForEvent("download");
    await world.page
      .getByRole("button", { name: "Download visible CSV" })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/placement.*\.csv$/);
    const stream = await download.createReadStream();
    let csv = "";
    for await (const chunk of stream) csv += chunk.toString();
    expect(csv).toContain(indentNo);
    expect(csv).toContain("GREEN");
    expect(csv).not.toContain("undefined");
  } finally {
    await world.close();
  }
});

test("OFC-CTL-AUTH-029 OFC-A11Y-E2E-032 control tower derives tenant scope server-side and is accessible", async ({
  browser,
}, testInfo) => {
  const primary = await seededControlWorld(browser, testInfo);
  const foreign = await seededControlWorld(browser, testInfo);
  try {
    const indentNo = value(primary.graph.indent, "indentNo", "indent_no");
    const foreignRows = await workbenchApi<{
      rows: Array<Record<string, unknown>>;
    }>(
      foreign.page,
      `/control-workbench/placement?search=${encodeURIComponent(indentNo)}`,
    );
    expect(foreignRows.rows).toHaveLength(0);
    const foreignCsv = await workbenchApi<{ content: string }>(
      foreign.page,
      `/control-workbench/placement/export?search=${encodeURIComponent(indentNo)}`,
    );
    expect(foreignCsv.content).not.toContain(indentNo);

    await primary.page.goto("/app/control");
    await expectNoSeriousAccessibilityViolations(primary.page, "control tower");
    await expectNoPageOverflow(primary.page);
    await expect(
      primary.page.getByRole("tablist", { name: "Control tower lens" }),
    ).toBeVisible();
  } finally {
    await primary.close();
    await foreign.close();
  }
});
