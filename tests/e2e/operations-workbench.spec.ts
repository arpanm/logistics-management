import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectNoPageOverflow,
  expectNoSeriousAccessibilityViolations,
} from "../fixtures/fnd01";
import {
  createWorkbenchWorld,
  openActorSession,
  seedSecondEligibleAsset,
  workbenchApi,
} from "../fixtures/ops-fin-ctl";

test.setTimeout(150_000);

const reference = (
  value: Record<string, unknown>,
  camel: string,
  snake: string,
) => String(value[camel] ?? value[snake]);

function tableRow(page: Page, value: string) {
  return page.getByRole("row").filter({ hasText: value });
}

async function submitDialog(page: Page, buttonName: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() !== "GET" &&
      response.url().includes("/api/v1/operations/"),
  );
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBeLessThan(300);
  await expect(page.getByRole("status")).toContainText("Saved");
}

async function createWorld(
  browser: Parameters<typeof createWorkbenchWorld>[0],
  testInfo: TestInfo,
) {
  return createWorkbenchWorld(browser, testInfo);
}

test("OFC-OPS-E2E-001 OFC-OPS-E2E-002 OFC-OPS-E2E-003 open-indent landing creates, updates and allocates real demand", async ({
  browser,
}, testInfo) => {
  const world = await createWorld(browser, testInfo);
  try {
    const indentNo = reference(world.graph.indent, "indentNo", "indent_no");
    await world.page.goto("/app/operations");
    await expect(
      world.page.getByRole("heading", { name: "Open indent workbench" }),
    ).toBeVisible();
    await expect(world.page.getByText("All open indents")).toBeVisible();
    const existing = tableRow(world.page, indentNo);
    await expect(existing).toContainText(indentNo);
    await expect(
      existing.getByRole("button", { name: "Edit indent" }),
    ).toBeVisible();
    await expect(
      existing.getByRole("button", { name: "Allocate truck" }),
    ).toBeEnabled();

    await existing.getByRole("button", { name: "Edit indent" }).click();
    await world.page.getByLabel("Requested vehicles").fill("3");
    await world.page
      .getByLabel("Commitment override reason (optional)")
      .fill("Customer expanded deterministic acceptance demand");
    await submitDialog(world.page, "Confirm action");
    await expect(tableRow(world.page, indentNo)).toContainText(
      "truck(s) awaiting",
    );

    const createdNo = `UI-${world.suffix}`;
    await world.page.getByRole("button", { name: "Create indent" }).click();
    await world.page.getByLabel("Indent number").fill(createdNo);
    await world.page
      .getByLabel("Client")
      .selectOption(String(world.graph.client.id));
    await world.page
      .getByLabel("Client location")
      .selectOption(String(world.graph.origin.id));
    await world.page
      .getByLabel("Contract lane")
      .selectOption(String(world.graph.lane.id));
    await world.page.getByLabel("Requested vehicles").fill("1");
    await world.page.getByLabel("Quantity (thousandths)").fill("1000");
    await world.page.getByLabel("Pickup starts").fill("2026-08-28T09:00");
    await world.page.getByLabel("Pickup ends").fill("2026-08-28T12:00");
    await submitDialog(world.page, "Confirm action");
    await world.page.getByRole("searchbox", { name: "Search" }).fill(createdNo);
    await expect(tableRow(world.page, createdNo)).toBeVisible();

    await world.page.getByRole("searchbox", { name: "Search" }).fill(indentNo);
    await tableRow(world.page, indentNo)
      .getByRole("button", { name: "Allocate truck" })
      .click();
    await expect(
      world.page.getByRole("dialog", { name: "Allocate trucks" }),
    ).toBeVisible();
    await world.page
      .getByLabel("Eligible vendor")
      .selectOption(String(world.graph.vendor.id));
    await world.page.getByLabel("Truck quantity").fill("1");
    await world.page.getByLabel("Offer rate (minor units)").fill("120000");
    await submitDialog(world.page, "Confirm action");

    await world.page.getByRole("link", { name: "Truck allocations" }).click();
    await world.page.getByRole("searchbox", { name: "Search" }).fill(indentNo);
    const offered = world.page
      .getByRole("row")
      .filter({ hasText: indentNo })
      .filter({
        has: world.page.getByRole("button", { name: "Accept", exact: true }),
      });
    await expect(offered).toHaveCount(1);
    const acceptResponse = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/v1/operations/allocations/") &&
        response.url().endsWith("/transition"),
    );
    await offered.getByRole("button", { name: "Accept", exact: true }).click();
    expect((await acceptResponse).status()).toBe(200);
    await expect(
      world.page
        .getByRole("row")
        .filter({ hasText: indentNo })
        .filter({
          has: world.page.getByRole("button", {
            name: "Assign truck & driver",
          }),
        }),
    ).toHaveCount(1);
  } finally {
    await world.close();
  }
});

test("OFC-OPS-E2E-004 OFC-OPS-E2E-007 OFC-OPS-E2E-008 allocation register and trip CTAs persist each valid transition", async ({
  browser,
}, testInfo) => {
  const world = await createWorld(browser, testInfo);
  try {
    await seedSecondEligibleAsset(world);
    const tripNo = reference(world.graph.trip, "tripNo", "trip_no");
    await world.page.goto("/app/operations/allocations");
    await expect(
      world.page.getByRole("heading", { name: "Truck allocations" }),
    ).toBeVisible();
    await expect(
      world.page.getByRole("tab", { name: "All allocations" }),
    ).toHaveAttribute("aria-selected", "true");
    await world.page
      .getByRole("tab", { name: "Auto-allocation rules" })
      .click();
    await expect(
      world.page.getByRole("heading", { name: "Auto-allocation rules" }),
    ).toBeVisible();
    await world.page.getByRole("tab", { name: "All allocations" }).click();

    await world.page.getByRole("link", { name: "Trips", exact: true }).click();
    await world.page.getByRole("searchbox", { name: "Search" }).fill(tripNo);
    const actions = [
      ["Accept trip", {}],
      ["Start / gate-in", { "Odometer km (optional)": "100" }],
      [
        "Confirm loading",
        { "Loaded quantity (thousandths) (optional)": "1000" },
      ],
      ["Start transit", { "Odometer km (optional)": "150" }],
      ["Arrival / unload", { "Odometer km (optional)": "200" }],
      [
        "End & deliver",
        { "Odometer km (optional)": "205", "Receiver name": "Receiving Desk" },
      ],
    ] as const;
    for (const [label, fields] of actions) {
      await tableRow(world.page, tripNo)
        .getByRole("button", { name: label })
        .click();
      const dialog = world.page.getByRole("dialog", { name: label });
      await expect(dialog).toBeVisible();
      for (const [field, value] of Object.entries(fields))
        await dialog.getByLabel(field).fill(value);
      await submitDialog(world.page, "Confirm action");
    }
    await expect(tableRow(world.page, tripNo)).toContainText("DELIVERED", {
      ignoreCase: true,
    });
    const pods = await workbenchApi<{ items: Array<Record<string, unknown>> }>(
      world.page,
      "/domain/pod-tasks",
    );
    expect(pods.items).toContainEqual(
      expect.objectContaining({ trip_id: world.graph.trip.id }),
    );
  } finally {
    await world.close();
  }
});

test("OFC-OPS-AUTH-010 OFC-A11Y-E2E-032 operations enforces tenant/role scope and remains accessible", async ({
  browser,
}, testInfo) => {
  const primary = await createWorld(browser, testInfo);
  const foreign = await createWorld(browser, testInfo);
  try {
    const denied = await workbenchApi<{ code: string }>(
      foreign.page,
      `/operations/indents/${primary.graph.indent.id}/eligible-vendors`,
      {},
      404,
    );
    expect(denied.code).toBe("RESOURCE_NOT_FOUND");

    const client = await openActorSession(browser, primary, "client");
    try {
      const response = await client.page.request.get(
        "/api/v1/operations/dashboard?limit=20",
      );
      expect([403, 404]).toContain(response.status());
    } finally {
      await client.context.close();
    }

    await primary.page.goto("/app/operations");
    await expectNoSeriousAccessibilityViolations(
      primary.page,
      "operations workbench",
    );
    await expectNoPageOverflow(primary.page);
  } finally {
    await primary.close();
    await foreign.close();
  }
});
