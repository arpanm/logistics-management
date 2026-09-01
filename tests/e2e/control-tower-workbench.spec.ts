import {
  expect,
  test,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";
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

type ControlScopePayload = {
  portfolios: Array<{ id: string; name: string }>;
  locations: Array<{
    id: string;
    name: string;
    recordCount: number;
    green: number;
    yellow: number;
    red: number;
  }>;
};

async function controlScopePayload(response: APIResponse) {
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  return JSON.parse(text) as ControlScopePayload;
}

const locationSnapshot = (payload: ControlScopePayload) =>
  payload.locations
    .map(({ id, name, recordCount, green, yellow, red }) => ({
      id,
      name,
      recordCount,
      green,
      yellow,
      red,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

async function expectLocationBoardMatches(
  page: Page,
  payload: ControlScopePayload,
) {
  const board = page.getByLabel("Location summaries");
  await expect(board).toBeVisible();
  await expect(board.locator("article")).toHaveCount(payload.locations.length);
  const rendered = (await board.locator("article strong").allTextContents())
    .map((name) => name.trim())
    .sort();
  expect(rendered).toEqual(
    payload.locations.map((location) => location.name).sort(),
  );
}

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

test("BUG-CTL-027 non-placement portfolio scope never exposes stale locations and survives refresh and URL restore", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  const lenses = [
    ["pod", "POD vs Invoice"],
    ["collection", "Collection"],
    ["trip", "Trips"],
    ["vendor-payable", "Vendor Payable"],
  ] as const;
  for (const [slug, label] of lenses) {
    const unfilteredPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        !response.url().includes("clientId=") &&
        !response.url().includes("/views"),
    );
    await page.goto(`/app/control?lens=${slug}`);
    const unfiltered = await controlScopePayload(await unfilteredPromise);
    expect(unfiltered.portfolios.length, `${label} portfolios`).toBeGreaterThan(
      1,
    );
    const portfolio = unfiltered.portfolios[0]!;
    const panel = page.getByRole("tabpanel");
    const portfolioButton = panel.getByRole("button").filter({
      has: panel.getByRole("heading", {
        level: 3,
        name: portfolio.name,
        exact: true,
      }),
    });
    await expect(portfolioButton).toBeVisible();

    const scopedPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        response
          .url()
          .includes(`clientId=${encodeURIComponent(portfolio.id)}`) &&
        !response.url().includes("/views"),
    );
    const synchronousLocationNames = await portfolioButton.evaluate(
      (button) => {
        (button as HTMLButtonElement).click();
        return Array.from(
          document.querySelectorAll(
            '[aria-label="Location summaries"] article strong',
          ),
          (node) => node.textContent?.trim() ?? "",
        );
      },
    );
    expect(
      synchronousLocationNames,
      `${label} hides the unfiltered location board in the click task`,
    ).toEqual([]);
    const scoped = await controlScopePayload(await scopedPromise);
    expect(
      scoped.locations.length,
      `${label} scoped locations`,
    ).toBeGreaterThan(0);
    const scopedIds = new Set(scoped.locations.map((location) => location.id));
    const stale = unfiltered.locations.filter(
      (location) => !scopedIds.has(location.id),
    );
    expect(
      stale.length,
      `${label} has an out-of-scope location`,
    ).toBeGreaterThan(0);
    await expectLocationBoardMatches(page, scoped);
    const board = page.getByLabel("Location summaries");
    for (const location of stale)
      await expect(board).not.toContainText(location.name);

    const scopedUrl = page.url();
    const parsed = new URL(scopedUrl);
    expect(parsed.searchParams.get("lens")).toBe(slug);
    expect(parsed.searchParams.get("clientId")).toBe(portfolio.id);

    const pauseRefreshPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        response
          .url()
          .includes(`clientId=${encodeURIComponent(portfolio.id)}`) &&
        !response.url().includes("/views"),
    );
    await page.getByRole("button", { name: "Pause live refresh" }).click();
    const pausedRefresh = await controlScopePayload(await pauseRefreshPromise);
    expect(locationSnapshot(pausedRefresh)).toEqual(locationSnapshot(scoped));
    await expectLocationBoardMatches(page, pausedRefresh);
    const resume = page.getByRole("button", { name: "Resume live refresh" });
    await expect(resume).toHaveAttribute("aria-pressed", "true");

    const resumeRefreshPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        response
          .url()
          .includes(`clientId=${encodeURIComponent(portfolio.id)}`) &&
        !response.url().includes("/views"),
    );
    await resume.click();
    const resumedRefresh = await controlScopePayload(
      await resumeRefreshPromise,
    );
    expect(locationSnapshot(resumedRefresh)).toEqual(locationSnapshot(scoped));
    await expectLocationBoardMatches(page, resumedRefresh);
    await expect(
      page.getByRole("button", { name: "Pause live refresh" }),
    ).toHaveAttribute("aria-pressed", "false");

    await page.goto("/app");
    const restoredPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/api/v1/control-workbench/${slug}?`) &&
        response
          .url()
          .includes(`clientId=${encodeURIComponent(portfolio.id)}`) &&
        !response.url().includes("/views"),
    );
    await page.goto(scopedUrl);
    const restored = await controlScopePayload(await restoredPromise);
    expect(locationSnapshot(restored)).toEqual(locationSnapshot(scoped));
    await expectLocationBoardMatches(page, restored);
    await expect(page).toHaveURL(
      new RegExp(`(?:\\?|&)clientId=${portfolio.id}(?:&|$)`),
    );
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
  for (const vendor of payload.vendors) {
    expect(vendor).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        vendor: expect.any(String),
        allotted: expect.any(Number),
        placed: expect.any(Number),
        ntp: expect.any(Number),
      }),
    );
    expect(vendor.id).not.toBe("");
    expect(vendor.vendor).not.toBe("");
    for (const total of [vendor.allotted, vendor.placed, vendor.ntp]) {
      expect(Number.isInteger(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
    }
    expect(vendor.placed + vendor.ntp).toBeLessThanOrEqual(vendor.allotted);
  }
  const section = page
    .getByRole("heading", { name: "Vendor allocation" })
    .locator("xpath=ancestor::section[1]");
  await expect(section).toBeVisible();
  for (const projected of payload.vendors) {
    const vendor = section
      .locator("article")
      .filter({ hasText: projected.vendor });
    await expect(vendor).toHaveCount(1);
    await expect(vendor).not.toContainText(/undefined|NaN/);
    const totals = Object.entries({
      Allotted: projected.allotted,
      Placed: projected.placed,
      NTP: projected.ntp,
    });
    for (const [label, expected] of totals) {
      const field = vendor.locator("dl > div").filter({ hasText: label });
      await expect(field.locator("dd")).toHaveText(String(expected));
    }
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
