import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
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
import { loginDemoUser } from "../fixtures/demo-data";

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

async function expectTopbarChildrenDoNotOverlap(page: Page) {
  const overlaps = await page.locator(".topbar > *").evaluateAll((nodes) => {
    const visible = nodes
      .map((node) => ({
        name:
          node.getAttribute("aria-label") ??
          node.textContent?.trim().replace(/\s+/g, " ") ??
          node.tagName,
        rect: node.getBoundingClientRect(),
        style: getComputedStyle(node),
      }))
      .filter(
        (entry) =>
          entry.style.display !== "none" &&
          entry.style.visibility !== "hidden" &&
          entry.rect.width > 0 &&
          entry.rect.height > 0,
      );
    const failures: string[] = [];
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const a = visible[left]!,
          b = visible[right]!;
        const width =
            Math.min(a.rect.right, b.rect.right) -
            Math.max(a.rect.left, b.rect.left),
          height =
            Math.min(a.rect.bottom, b.rect.bottom) -
            Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1)
          failures.push(`${a.name} overlaps ${b.name} by ${width}x${height}`);
      }
    }
    return failures;
  });
  expect(overlaps, "visible app-bar peers do not collide").toEqual([]);
}

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

test("UIM-E2E-001 responsive shell has one main landmark, contained app-bar peers and operable current navigation", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/control");
  await expect(
    page.getByRole("heading", { name: "Control tower" }),
  ).toBeVisible();

  await expect(page.getByRole("main")).toHaveCount(1);
  await expectNoPageOverflow(page);
  await expectTopbarChildrenDoNotOverlap(page);

  const compact = (page.viewportSize()?.width ?? 1280) < 1200;
  const menu = page.getByRole("button", { name: /Menu/ });
  if (compact) {
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const drawer = page.locator("#mobile-navigation");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("link", { name: "Control tower" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      drawer.getByRole("button", { name: "Close navigation" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(menu).toBeFocused();
  } else {
    await expect(menu).toBeHidden();
    const rail = page.getByRole("complementary", {
      name: "Primary navigation",
    });
    await expect(rail).toBeVisible();
    await expect(
      rail.getByRole("link", { name: "Control tower" }),
    ).toHaveAttribute("aria-current", "page");
  }
});

test("UIM-E2E-002 Control Tower tabs use roving keyboard focus and preserve the selected lens in the URL", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/control?lens=collection");
  const tablist = page.getByRole("tablist", { name: "Control tower lens" });
  const collection = tablist.getByRole("tab", { name: "Collection" });
  await expect(collection).toHaveAttribute("aria-selected", "true");
  await expect(collection).toHaveAttribute("tabindex", "0");
  await collection.focus();

  const tripResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/control-workbench/trip?") &&
      !response.url().includes("/views"),
  );
  await page.keyboard.press("ArrowRight");
  expect((await tripResponse).status()).toBe(200);
  const trips = tablist.getByRole("tab", { name: "Trips" });
  await expect(trips).toBeFocused();
  await expect(trips).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/(?:\?|&)lens=trip(?:&|$)/);
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "control-tab-trip",
  );

  await page.reload();
  await expect(page.getByRole("tab", { name: "Trips" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page).toHaveURL(/(?:\?|&)lens=trip(?:&|$)/);
});

test("UIM-E2E-003 rich demo provides dense five-lens results as desktop tables and equivalent mobile cards", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/control");
  const compact = (page.viewportSize()?.width ?? 1280) < 768;
  const lenses = [
    ["POD vs Invoice", "pod"],
    ["Collection", "collection"],
    ["Trips", "trip"],
    ["Vendor Payable", "vendor-payable"],
    ["Placement", "placement"],
  ] as const;

  for (const [label, slug] of lenses) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        !response.url().includes("/views"),
    );
    await page.getByRole("tab", { name: label }).click();
    const response = await responsePromise;
    const responseText = await response.text();
    expect(response.status(), responseText).toBe(200);
    const payload = JSON.parse(responseText) as {
      rows: Array<{ reference: string }>;
    };
    expect(
      payload.rows.length,
      `${label} showcase row volume`,
    ).toBeGreaterThanOrEqual(10);

    const panel = page.getByRole("tabpanel");
    const portfolio = panel
      .getByRole("button")
      .filter({ has: panel.getByRole("heading", { level: 3 }) })
      .first();
    await expect(portfolio).toBeVisible();
    const portfolioResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "GET" &&
        candidate.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        candidate.url().includes("clientId=") &&
        !candidate.url().includes("locationId="),
    );
    await portfolio.click();
    expect((await portfolioResponse).status()).toBe(200);

    const recordResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "GET" &&
        candidate.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        candidate.url().includes("locationId="),
    );
    await panel.getByRole("button", { name: "View records" }).first().click();
    const records = await recordResponse;
    const recordText = await records.text();
    expect(records.status(), recordText).toBe(200);
    const recordPayload = JSON.parse(recordText) as {
      rows: Array<{ reference: string }>;
    };
    expect(recordPayload.rows.length).toBeGreaterThan(0);

    const register = panel.getByRole("region", {
      name: new RegExp(
        `${slug === "vendor-payable" ? "vendor bill" : slug === "placement" ? "indent" : slug === "collection" ? "invoice" : slug === "pod" ? "POD" : "trip"} results table`,
        "i",
      ),
    });
    const cards = panel.locator("article");
    if (compact) {
      await expect(register).toBeHidden();
      await expect(cards.first()).toBeVisible();
      await expect(
        cards.first().getByRole("link", { name: "Open source record" }),
      ).toBeVisible();
      await expect(cards.first()).toContainText(
        recordPayload.rows[0]!.reference,
      );
    } else {
      await expect(register).toBeVisible();
      await expect(cards.first()).toBeHidden();
      await expect(
        register
          .getByRole("row")
          .filter({ hasText: recordPayload.rows[0]!.reference }),
      ).toBeVisible();
    }
    await expectNoPageOverflow(page);
  }
});

test("UI02-CTL-008 Collection opens directly and through tabs without rendering invalid placeholders", async ({
  page,
}, testInfo) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await loginDemoUser(page, testInfo, "owner");
  const direct = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/control-workbench/collection?"),
  );
  await page.goto("/app/control?lens=collection");
  const directResponse = await direct;
  const directText = await directResponse.text();
  expect(directResponse.status(), directText).toBe(200);
  const directPayload = JSON.parse(directText) as {
    rows: Array<Record<string, unknown>>;
  };
  const nullOptional = directPayload.rows.find(
    (row) => row.hold == null || row.nextFollowupAt == null,
  );
  expect(nullOptional).toBeTruthy();
  await expect(page.getByRole("tab", { name: "Collection" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(/undefined|NaN/);

  const narrowed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/control-workbench/collection?") &&
      response.url().includes("search="),
  );
  await page
    .getByLabel("Search visible scope")
    .fill(String(nullOptional!.reference));
  expect((await narrowed).status()).toBe(200);
  const panel = page.getByRole("tabpanel");
  await panel
    .getByRole("button")
    .filter({ hasText: String(nullOptional!.client) })
    .click();
  await panel.getByRole("button", { name: "View records" }).first().click();
  const record = panel
    .locator("article")
    .filter({ hasText: String(nullOptional!.reference) });
  await expect(record).toBeVisible();
  await expect(record).toContainText("—");

  await page.getByRole("tab", { name: "Placement" }).click();
  const collection = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/control-workbench/collection?"),
  );
  await page.getByRole("tab", { name: "Collection" }).click();
  expect((await collection).status()).toBe(200);
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expectNoPageOverflow(page);
  expect(pageErrors).toEqual([]);
});

test("UI02-CTL-008 masked Collection money and null optional values stay contained", async ({
  page,
}, testInfo) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginDemoUser(page, testInfo, "client");
  const response = await page.request.get(
    "/api/v1/control-workbench/collection?page=1&pageSize=25&sort=updatedAt&direction=desc",
  );
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  const payload = JSON.parse(text) as {
    moneyVisible: boolean;
    rows: Array<Record<string, unknown>>;
  };
  expect(payload.moneyVisible).toBe(false);
  expect(
    payload.rows.some(
      (row) => row.valueMinor === "••••" || row.balanceMinor === "••••",
    ),
  ).toBe(true);

  await page.goto("/app/control?lens=collection");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(page.getByRole("main")).toContainText("••••");
  await expect(page.getByRole("main")).not.toContainText(/undefined|NaN/);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("UI02-CTL-009 actionable KPIs filter each lens without card or page overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/control");
  for (const lens of [
    "Placement",
    "POD vs Invoice",
    "Collection",
    "Trips",
    "Vendor Payable",
  ]) {
    await page.getByRole("tab", { name: lens }).click();
    const metrics = page.getByLabel(`${lens} key performance indicators`);
    const metric = metrics.locator("button.ui-metric-card").first();
    await expect(metric).toBeVisible();
    const filtered = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/api/v1/control-workbench/") &&
        response.url().includes("kpi="),
    );
    await metric.click();
    expect((await filtered).status()).toBe(200);
    await expect(metric).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Applied filters")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "Clear", exact: true }).click();
  }
});

test("UI02-CTL-010 placement vendor projection renders real names and numeric quantities", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      candidate.url().includes("/api/v1/control-workbench/placement?"),
  );
  await page.goto("/app/control?lens=placement");
  const vendorResponse = await response;
  const responseText = await vendorResponse.text();
  expect(vendorResponse.status(), responseText).toBe(200);
  const payload = JSON.parse(responseText) as {
    vendors: Array<{
      id: string;
      vendor: string;
      allotted: number;
      placed: number;
      ntp: number;
    }>;
  };
  expect(payload.vendors.length).toBeGreaterThan(0);
  expect(
    payload.vendors.every(
      (vendor) =>
        Boolean(vendor.id && vendor.vendor) &&
        [vendor.allotted, vendor.placed, vendor.ntp].every(Number.isFinite),
    ),
  ).toBe(true);
  const section = page
    .getByRole("heading", { name: "Vendor allocation" })
    .locator("..")
    .locator("..");
  await expect(section).toBeVisible();
  const vendors = section.locator("article");
  await expect(vendors.first()).toBeVisible();
  expect(await vendors.count()).toBeGreaterThan(0);
  for (const vendor of await vendors.all()) {
    await expect(vendor.locator("strong").first()).not.toHaveText("");
    await expect(vendor).not.toContainText(/undefined|NaN/);
    const quantities = await vendor.locator("dd").allTextContents();
    expect(quantities).toHaveLength(3);
    expect(quantities.every((value) => /^\d+$/.test(value.trim()))).toBe(true);
  }
});

test("UI02-CTL-011 maximum-length portfolio context remains bounded and has a stable back action", async ({
  browser,
}, testInfo) => {
  const world = await seededControlWorld(browser, testInfo);
  const longName =
    "North Karnataka Strategic Enterprise Distribution Portfolio and Fulfilment Network";
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.tenant_id',$1,true)",
        world.fixture.tenantA.id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE app.clients SET legal_name=$1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid",
        longName,
        world.fixture.tenantA.id,
        world.graph.client.id,
      );
    });
    await world.page.setViewportSize({ width: 320, height: 844 });
    await world.page.goto("/app/control?lens=placement");
    const portfolio = world.page
      .getByRole("tabpanel")
      .getByRole("button")
      .filter({ hasText: longName });
    await expect(portfolio).toBeVisible();
    await portfolio.click();

    const breadcrumb = world.page.getByRole("navigation", {
      name: "Drill-down breadcrumb",
    });
    const context = breadcrumb.getByRole("button", { name: longName });
    await expect(context).toBeVisible();
    await expect(context).toHaveAccessibleName(longName);
    const [crumbBox, contextBox] = await Promise.all([
      breadcrumb.boundingBox(),
      context.boundingBox(),
    ]);
    expect(crumbBox).not.toBeNull();
    expect(contextBox).not.toBeNull();
    expect(contextBox!.x + contextBox!.width).toBeLessThanOrEqual(
      crumbBox!.x + crumbBox!.width + 1,
    );
    await expectNoPageOverflow(world.page);

    await breadcrumb.getByRole("button", { name: "All clients" }).click();
    await expect(
      world.page.getByRole("heading", { name: "Client portfolio" }),
    ).toBeVisible();
    await expect(portfolio).toBeVisible();
  } finally {
    await db.$disconnect();
    await world.close();
  }
});
