import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loginDemoUser } from "../fixtures/demo-data";
import { expectNoSeriousAccessibilityViolations } from "../fixtures/fnd01";
import { actorPage, seedFnd02 } from "../fixtures/fnd02";
import {
  applyTextResize,
  expectContainedModal,
  expectDocumentContained,
  expectMobileRecords,
  expectResponsiveDialogLayout,
} from "../fixtures/responsive-ui";

test.setTimeout(180_000);

type ControlResponse = {
  lens: string;
  rows: Array<{ id: string; reference: string }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    hasPrevious: boolean;
    hasNext: boolean;
    sort: string;
    direction: string;
  };
};

const controlCases = [
  ["UIREG-CTL-API-001", "placement"],
  ["UIREG-CTL-API-002", "pod"],
  ["UIREG-CTL-API-003", "collection"],
  ["UIREG-CTL-API-004", "trip"],
  ["UIREG-CTL-API-005", "vendor-payable"],
] as const;

for (const [id, lens] of controlCases) {
  test(`${id} ${lens} lens returns a real bounded PostgreSQL page`, async ({
    page,
  }, testInfo) => {
    await loginDemoUser(page, testInfo, "owner");
    const response = await page.request.get(
      `/api/v1/control-workbench/${lens}?page=1&pageSize=25&sort=updatedAt&direction=desc`,
    );
    const text = await response.text();
    expect(response.status(), text).toBe(200);
    const body = JSON.parse(text) as ControlResponse;
    expect(body.lens).toBe(lens);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThanOrEqual(25);
    expect(new Set(body.rows.map((row) => row.id)).size).toBe(body.rows.length);
    expect(body.rows.every((row) => Boolean(row.reference))).toBe(true);
    expect(body.pagination).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      direction: "desc",
      hasPrevious: false,
    });
    expect(body.pagination.total).toBeGreaterThanOrEqual(body.rows.length);
    expect(body.pagination.pageCount).toBe(
      Math.ceil(body.pagination.total / body.pagination.pageSize),
    );
  });
}

const operationsRoutes = [
  ["/app/operations", "Open indent workbench", "dashboard"],
  ["/app/operations/indents", "Indent register", "indents"],
  ["/app/operations/allocations", "Truck allocations", "allocations"],
  ["/app/operations/trips", "Trip execution", "trips"],
] as const;

async function expectOperationsRoutes(
  page: Page,
  testInfo: TestInfo,
  width: 320 | 390,
) {
  await page.setViewportSize({ width, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  for (const [route, heading, endpoint] of operationsRoutes) {
    await test.step(`${route} is contained at ${width}px`, async () => {
      const read = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/api/v1/operations/${endpoint}`),
      );
      await page.goto(route);
      expect((await read).status()).toBe(200);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectMobileRecords(page, "Operations records");
    });
  }
}

test("UIREG-OPS-008 all Operations tabs use contained mobile records at 320px", async ({
  page,
}, testInfo) => {
  await expectOperationsRoutes(page, testInfo, 320);
});

test("UIREG-OPS-009 all Operations tabs use contained mobile records at 390px and an action opens a modal sheet", async ({
  page,
}, testInfo) => {
  await expectOperationsRoutes(page, testInfo, 390);
  await page.goto("/app/operations");
  const trigger = page.getByRole("button", { name: "Create indent" });
  await expectContainedModal(
    page,
    trigger,
    page.getByRole("dialog", { name: "Create indent" }),
  );
});

const financeRoutes = [
  "/app/finance",
  "/app/finance/invoices",
  "/app/finance/receipts",
  "/app/finance/vendor-bills",
  "/app/finance/payment-runs",
] as const;

async function expectFinanceRoutes(
  page: Page,
  testInfo: TestInfo,
  width: 320 | 390,
) {
  await page.setViewportSize({ width, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  for (const route of financeRoutes) {
    await test.step(`${route} is contained at ${width}px`, async () => {
      const read = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes("/api/v1/tenant/finance/workbench"),
      );
      await page.goto(route);
      expect((await read).status()).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Billing, collections and payables",
        }),
      ).toBeVisible();
      await expectMobileRecords(page, "Records");
    });
  }
}

test("UIREG-FIN-010 all Finance tabs use contained mobile records at 320px", async ({
  page,
}, testInfo) => {
  await expectFinanceRoutes(page, testInfo, 320);
});

test("UIREG-FIN-011 all Finance tabs use contained mobile records at 390px and an action opens a modal sheet", async ({
  page,
}, testInfo) => {
  await expectFinanceRoutes(page, testInfo, 390);
  await page.goto("/app/finance/invoices");
  const records = page.getByLabel("Records").filter({ visible: true });
  const trigger = records.getByRole("button", { name: "Edit" }).first();
  await expectContainedModal(
    page,
    trigger,
    page.getByRole("dialog", { name: "Edit invoice draft" }),
  );
});

test("UIREG-DETAIL-012 Users detail is an immediate labelled modal and restores its trigger", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/access/users");
  await expect(
    page.getByRole("heading", { name: "User directory" }),
  ).toBeVisible();
  const trigger = page.getByRole("button", { name: "View details" }).first();
  await expectContainedModal(
    page,
    trigger,
    page.getByRole("dialog", { name: "User access details" }),
  );
});

test("UIREG-DETAIL-013 actual POD detail is a discoverable labelled modal and restores its trigger", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/pod");
  await expect(page.getByRole("heading", { name: "POD tasks" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "View details" }).first();
  await expectContainedModal(page, trigger);
});

test("UIREG-DETAIL-014 UIREG-A11Y-015 UI02-A11Y-014 shared modal remains viewport-contained, background-inert and Axe-clean", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/access/users");
  const trigger = page.getByRole("button", { name: "View details" }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "User access details" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>(".app-shell");
        return Boolean(shell?.inert);
      }),
    )
    .toBe(true);
  await expectNoSeriousAccessibilityViolations(
    page,
    "mobile user detail modal",
  );
  await expectDocumentContained(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("UI02-OPS-001 Operations create sheet reflows at all required widths", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  for (const viewport of [
    { width: 320, height: 568, columns: 1 },
    { width: 390, height: 844, columns: 1 },
    { width: 768, height: 1024, columns: 2 },
    { width: 1440, height: 900, columns: 2 },
  ] as const) {
    await test.step(`${viewport.width}px`, async () => {
      await page.setViewportSize(viewport);
      await page.goto("/app/operations");
      const trigger = page.getByRole("button", { name: "Create indent" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Create indent" });
      await expectResponsiveDialogLayout(page, dialog, viewport.columns);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});

test("UI02-FIN-002 Finance invoice, collection, payable and payment actions use the shared modal contract", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemoUser(page, testInfo, "owner");
  const cases = [
    ["/app/finance/invoices", /Edit/, /Edit invoice draft/],
    ["/app/finance/receipts", /Add follow-up/, /Record collection follow-up/],
    [
      "/app/finance/vendor-bills",
      /Create vendor bill|Dispute|Add to payment run/,
      /Create vendor bill|Dispute vendor bill|Create payment run/,
    ],
    [
      "/app/finance/payment-runs",
      /Mark paid|Mark failed|Reverse/,
      /Record bank payment|Mark payment failed|Reverse payment/,
    ],
  ] as const;
  for (const [route, action, title] of cases) {
    await test.step(route, async () => {
      await page.goto(route);
      await expect(
        page.getByRole("heading", {
          name: "Billing, collections and payables",
        }),
      ).toBeVisible();
      const trigger = page
        .getByLabel("Records")
        .filter({ visible: true })
        .getByRole("button", { name: action })
        .first();
      await expectContainedModal(
        page,
        trigger,
        page.getByRole("dialog", { name: title }),
      );
    });
  }
});

test("UI02-SHEET-003 long Create user sheet keeps its scroll body and actions separate and restores focus", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/access/users");
  const trigger = page.getByRole("button", { name: "Create user" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create user invitation" });
  await expectResponsiveDialogLayout(page, dialog, 1);
  await dialog.getByLabel("Scope").scrollIntoViewIfNeeded();
  await expect(dialog.getByLabel("Scope")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Review and send invitation" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("UI02-REC-004 reconciliation metrics filter and reset the real POD queue", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  await page.goto("/app/pod");
  const queue = page
    .getByRole("heading", { name: "Scoped work queue" })
    .locator("..");
  const initial = Number(await queue.locator(".count").textContent());
  const reportResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/v1/domain/pod-tasks/report"),
  );
  await page.getByRole("button", { name: "Reconciled report" }).click();
  expect((await reportResponse).status()).toBe(200);
  const filters = page.getByLabel("Reconciliation status filters");
  const metric = filters.getByRole("button").first();
  const expected = Number(await metric.locator("strong").textContent());
  await metric.click();
  await expect(metric).toHaveAttribute("aria-pressed", "true");
  await expect(queue.locator(".count")).toHaveText(String(expected));
  await page.getByRole("button", { name: /^Remove Status:/ }).click();
  await expect(queue.locator(".count")).toHaveText(String(initial));
});

test("UI02-USERS-007 User directory is list-first and Create user is capability-gated", async ({
  browser,
  page,
}, testInfo) => {
  const fixture = await seedFnd02(page, testInfo, "SCOPES_ONLY");
  const owner = await actorPage(browser, fixture.actors.owner);
  const auditor = await actorPage(browser, fixture.actors.auditor);
  try {
    await owner.page.goto("/app/access/users");
    await expect(
      owner.page.getByRole("heading", { name: "Users", level: 2 }),
    ).toBeVisible();
    const create = owner.page.getByRole("button", { name: "Create user" });
    await expect(create).toBeVisible();
    await create.click();
    const dialog = owner.page.getByRole("dialog", {
      name: "Create user invitation",
    });
    await expect(dialog).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();

    await auditor.page.goto("/app/access/users");
    await expect(
      auditor.page.getByRole("heading", { name: "Users", level: 2 }),
    ).toBeVisible();
    await expect(
      auditor.page.getByRole("button", { name: "Create user" }),
    ).toHaveCount(0);
  } finally {
    await owner.context.close();
    await auditor.context.close();
  }
});

test("UI02-DETAIL-005 User and POD details use labelled structured values without raw JSON", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemoUser(page, testInfo, "owner");

  await page.goto("/app/access/users");
  await page.getByRole("button", { name: "View details" }).first().click();
  const user = page.getByRole("dialog", { name: "User access details" });
  await expect(user).toBeVisible();
  await expect(user.locator("dl").first()).toBeVisible();
  await expect(user.locator("pre")).toHaveCount(0);
  await expect(user).not.toContainText(/\{\s*"|\[\s*\{/);
  await page.keyboard.press("Escape");

  await page.goto("/app/pod");
  await page.getByRole("button", { name: "View details" }).first().click();
  const pod = page.getByRole("dialog");
  await expect(pod.locator(".ui-detail-list").first()).toBeVisible();
  await expect(pod.locator("pre")).toHaveCount(0);
  await expect(pod).not.toContainText(/\{\s*"|\[\s*\{/);
  const labels = await pod.locator(".ui-detail-list dt").allTextContents();
  expect(labels.length).toBeGreaterThan(3);
  expect(
    labels.every((label) => !label.includes("_") && /^[A-Z]/.test(label)),
  ).toBe(true);
  await expect(pod.locator(".ui-detail-secondary").first()).toBeVisible();
  await expectDocumentContained(page);
});

test("UI02-TABS-006 dense route navigation and in-page tabs keep current state, roving focus and owned overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await loginDemoUser(page, testInfo, "owner");

  await page.goto("/app/finance/invoices");
  const finance = page.getByRole("navigation", { name: "Finance workbench" });
  await expect(
    finance.getByRole("link", { name: "All invoices" }),
  ).toHaveAttribute("aria-current", "page");
  const paymentRuns = finance.getByRole("link", { name: "Payment runs" });
  await paymentRuns.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/finance\/payment-runs$/);
  await expect(paymentRuns).toHaveAttribute("aria-current", "page");
  await expectDocumentContained(page);

  await page.goto("/app/operations/allocations");
  const allocationTabs = page.getByRole("tablist", {
    name: "Allocation workspace",
  });
  const register = allocationTabs.getByRole("tab", { name: "All allocations" });
  await expect(register).toHaveAttribute("aria-selected", "true");
  await expect(register).toHaveAttribute(
    "aria-controls",
    "operations-allocation-register-panel",
  );
  await register.focus();
  await page.keyboard.press("ArrowRight");
  const rules = allocationTabs.getByRole("tab", {
    name: "Auto-allocation rules",
  });
  await expect(rules).toBeFocused();
  await expect(rules).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator("#operations-allocation-rules-panel[role=tabpanel]"),
  ).toBeVisible();
  await expectDocumentContained(page);

  await page.goto("/app/control?lens=collection");
  const controlTabs = page.getByRole("tablist", { name: "Control tower lens" });
  const collection = controlTabs.getByRole("tab", { name: "Collection" });
  await collection.focus();
  await page.keyboard.press("ArrowRight");
  await expect(controlTabs.getByRole("tab", { name: "Trips" })).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "control-tab-trip",
  );
  await expectDocumentContained(page);
});

test("UI02-SHARED-012 UI02-ZOOM-013 shared responsive surfaces remain contained at four widths and 200% text", async ({
  page,
}, testInfo) => {
  await loginDemoUser(page, testInfo, "owner");
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [route, heading] of [
      ["/app/operations", "Open indent workbench"],
      ["/app/finance", "Billing, collections and payables"],
      ["/app/access/users", "User directory"],
      ["/app/pod", "POD tasks"],
      ["/app/control?lens=collection", "Control tower"],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectDocumentContained(page);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/control?lens=collection");
  await applyTextResize(page);
  await expect(
    page.getByRole("tablist", { name: "Control tower lens" }),
  ).toBeVisible();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expectDocumentContained(page);
});
