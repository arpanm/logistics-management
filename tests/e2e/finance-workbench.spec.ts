import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectNoPageOverflow,
  expectNoSeriousAccessibilityViolations,
} from "../fixtures/fnd01";
import {
  createDraftInvoice,
  createWorkbenchWorld,
  grantFinanceAtRoot,
  makeDeliveredServiceInvoiceEligible,
  openActorSession,
  responseJson,
  workbenchApi,
  type WorkbenchWorld,
} from "../fixtures/ops-fin-ctl";

test.setTimeout(180_000);

const row = (page: Page, value: string) =>
  page.getByRole("row").filter({ hasText: value });

async function worldFor(
  browser: Parameters<typeof createWorkbenchWorld>[0],
  testInfo: TestInfo,
) {
  return createWorkbenchWorld(browser, testInfo);
}

async function clickFinanceAction(page: Page, value: string, action: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/tenant/finance/"),
  );
  await row(page, value)
    .getByRole("button", { name: action, exact: true })
    .click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBeLessThan(300);
  await expect(page.getByRole("status")).toBeVisible();
}

async function createPostedInvoice(
  browser: Parameters<typeof openActorSession>[0],
  world: WorkbenchWorld,
  invoiceNo: string,
) {
  const invoice = await createDraftInvoice(world, invoiceNo);
  const submitted = await workbenchApi<Record<string, unknown>>(
    world.page,
    `/tenant/finance/invoices/${invoice.id}/actions`,
    {
      method: "POST",
      data: { action: "SUBMIT", expectedVersion: Number(invoice.version) },
    },
  );
  await grantFinanceAtRoot(world, "multiRole");
  const checker = await openActorSession(browser, world, "multiRole");
  let approved: Record<string, unknown>;
  try {
    approved = await workbenchApi<Record<string, unknown>>(
      checker.page,
      `/tenant/finance/invoices/${invoice.id}/actions`,
      {
        method: "POST",
        data: {
          action: "APPROVE",
          expectedVersion: Number(submitted.version),
        },
      },
    );
  } finally {
    await checker.context.close();
  }
  return workbenchApi<Record<string, unknown>>(
    world.page,
    `/tenant/finance/invoices/${invoice.id}/actions`,
    {
      method: "POST",
      data: { action: "POST", expectedVersion: Number(approved.version) },
    },
  );
}

test("OFC-FIN-E2E-012 OFC-FIN-E2E-013 OFC-FIN-E2E-014 FSUX-E2E-004 finance dashboard creates an exact invoice and exposes lifecycle CTAs", async ({
  browser,
}, testInfo) => {
  const world = await worldFor(browser, testInfo);
  try {
    await makeDeliveredServiceInvoiceEligible(world);
    const invoiceNo = `UIINV-${world.suffix}`;
    await world.page.goto("/app/finance");
    await expect(
      world.page.getByRole("heading", {
        name: "Billing, collections and payables",
      }),
    ).toBeVisible();
    for (const heading of [
      "Pending client invoices",
      "Collections requiring follow-up",
      "Vendor bills requiring action",
      "Payment runs requiring action",
    ])
      await expect(
        world.page.getByRole("heading", { name: heading }),
      ).toBeVisible();

    await world.page
      .getByRole("link", { name: "All invoices" })
      .first()
      .click();
    await world.page.getByText("Create invoice from eligible services").click();
    await world.page.getByLabel("Invoice number").fill(invoiceNo);
    const service = world.page.getByLabel("Trip / LR / POD");
    await service.selectOption(String(world.graph.trip.id));
    await world.page.getByLabel("Charge code").selectOption("LINE_HAUL");
    await expect(world.page.getByLabel("Rate (minor units)")).toHaveValue(
      "300003",
    );
    const invoiceCreateForm = world.page
      .getByRole("button", { name: "Create draft invoice" })
      .locator("xpath=ancestor::form");
    const createdPromise = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/tenant/finance/invoices"),
    );
    await world.page
      .getByRole("button", { name: "Create draft invoice" })
      .click();
    const createdResponse = await createdPromise;
    const created = await responseJson<Record<string, unknown>>(
      createdResponse,
      201,
    );
    expect(created).toMatchObject({ total_minor: "354004" });
    await expect(invoiceCreateForm.getByRole("status")).toContainText(
      /invoice.*created|draft.*created/i,
    );
    await expect(invoiceCreateForm.getByLabel("Invoice number")).toHaveValue(
      "",
    );
    await expect(invoiceCreateForm.getByLabel("Trip / LR / POD")).toHaveValue(
      "",
    );
    await expect(row(world.page, invoiceNo)).toContainText("DRAFT");

    await clickFinanceAction(world.page, invoiceNo, "Submit");
    const current = await workbenchApi<{
      items: Array<Record<string, unknown>>;
    }>(
      world.page,
      `/tenant/finance/invoices?search=${encodeURIComponent(invoiceNo)}`,
    );
    const submitted = current.items.find((item) => item.id === created.id)!;
    const ownerApproval = await workbenchApi<{ code: string }>(
      world.page,
      `/tenant/finance/invoices/${created.id}/actions`,
      {
        method: "POST",
        data: {
          action: "APPROVE",
          expectedVersion: Number(submitted.version),
        },
      },
      409,
    );
    expect(ownerApproval.code).toBe("SEGREGATION_REQUIRED");

    await grantFinanceAtRoot(world, "multiRole");
    const checker = await openActorSession(browser, world, "multiRole");
    try {
      await checker.page.goto(`/app/finance/invoices?search=${invoiceNo}`);
      await checker.page.getByLabel("Search").fill(invoiceNo);
      await clickFinanceAction(checker.page, invoiceNo, "Approve");
    } finally {
      await checker.context.close();
    }
    await world.page.reload();
    await world.page.getByLabel("Search").fill(invoiceNo);
    await clickFinanceAction(world.page, invoiceNo, "Post");
    await row(world.page, invoiceNo)
      .getByRole("button", { name: "Acknowledge" })
      .click();
    const acknowledge = world.page.getByRole("dialog", {
      name: "Acknowledge client submission",
    });
    await expect(acknowledge.getByLabel("Acknowledged at")).toHaveAttribute(
      "type",
      "datetime-local",
    );
  } finally {
    await world.close();
  }
});

test("OFC-FIN-E2E-018 OFC-FIN-AUTH-015 all-invoice filters preserve scoped canonical records without raw JSON", async ({
  browser,
}, testInfo) => {
  const primary = await worldFor(browser, testInfo);
  const foreign = await worldFor(browser, testInfo);
  try {
    const invoiceNo = `FILTER-${primary.suffix}`;
    const invoice = await createDraftInvoice(primary, invoiceNo);
    await primary.page.goto("/app/finance/invoices");
    await primary.page.getByLabel("Search").fill(invoiceNo);
    await expect(row(primary.page, invoiceNo)).toContainText("DRAFT");
    await primary.page.getByLabel("Status").selectOption("DRAFT");
    await expect(row(primary.page, invoiceNo)).toBeVisible();
    await primary.page.getByLabel("Status").selectOption("POSTED");
    await expect(primary.page.getByText("No records")).toBeVisible();
    await primary.page.getByRole("button", { name: "Clear" }).click();
    await expect(primary.page.locator("main")).not.toContainText(
      `\"id\":\"${invoice.id}\"`,
    );

    const leaked = await workbenchApi<{
      items: Array<Record<string, unknown>>;
    }>(
      foreign.page,
      `/tenant/finance/invoices?search=${encodeURIComponent(invoiceNo)}`,
    );
    expect(leaked.items).toHaveLength(0);
    const client = await openActorSession(browser, primary, "client");
    try {
      const denied = await client.page.request.post(
        `/api/v1/tenant/finance/invoices/${invoice.id}/actions`,
        {
          data: { action: "SUBMIT", expectedVersion: Number(invoice.version) },
        },
      );
      expect([401, 403]).toContain(denied.status());
    } finally {
      await client.context.close();
    }
  } finally {
    await primary.close();
    await foreign.close();
  }
});

test("OFC-FIN-E2E-019 collections records a receipt, allocation and follow-up against a posted invoice", async ({
  browser,
}, testInfo) => {
  const world = await worldFor(browser, testInfo);
  try {
    const invoiceNo = `COL-${world.suffix}`;
    const posted = await createPostedInvoice(browser, world, invoiceNo);
    await workbenchApi(
      world.page,
      `/tenant/finance/invoices/${posted.id}/actions`,
      {
        method: "POST",
        data: {
          action: "ACKNOWLEDGE",
          expectedVersion: Number(posted.version),
          acknowledgedAt: "2026-08-27T06:30:00.000Z",
        },
      },
    );
    await world.page.goto("/app/finance/receipts");
    await expect(
      world.page.getByRole("heading", {
        name: "Collection priority dashboard",
      }),
    ).toBeVisible();
    await world.page.getByText("Record bank receipt").click();
    const receiptRef = `RCPT-${world.suffix}`;
    await world.page.getByLabel("Receipt reference").fill(receiptRef);
    await world.page
      .getByLabel("Client")
      .selectOption(String(world.graph.client.id));
    await world.page.getByLabel("Amount received (minor units)").fill("150002");
    await world.page
      .getByLabel("UTR / instrument number")
      .fill(`UTR-${world.suffix}`);
    const receiptPromise = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/tenant/finance/receipts"),
    );
    await world.page.getByRole("button", { name: "Record receipt" }).click();
    expect((await receiptPromise).status()).toBe(201);
    await expect(row(world.page, receiptRef)).toContainText("150002");

    const receiptSelect = world.page.getByLabel("Receipt", { exact: true });
    const receiptValue = await receiptSelect
      .locator("option")
      .filter({ hasText: receiptRef })
      .getAttribute("value");
    await receiptSelect.selectOption(receiptValue!);
    const invoiceSelect = world.page.getByLabel("Invoice", { exact: true });
    const invoiceValue = await invoiceSelect
      .locator("option")
      .filter({ hasText: invoiceNo })
      .getAttribute("value");
    await invoiceSelect.selectOption(invoiceValue!);
    await world.page.getByLabel("Allocation (minor units)").fill("100001");
    const allocationPromise = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/v1/domain/receipts/") &&
        response.url().endsWith("/allocations"),
    );
    await world.page.getByRole("button", { name: "Allocate receipt" }).click();
    expect((await allocationPromise).status()).toBe(201);

    await row(world.page, invoiceNo)
      .getByRole("button", { name: "Add follow-up" })
      .click();
    const followup = world.page.getByRole("dialog", {
      name: "Record collection follow-up",
    });
    await followup.getByLabel("Outcome").selectOption("PROMISE_TO_PAY");
    await followup
      .getByLabel("Follow-up note")
      .fill("Customer confirmed balance date");
    await followup.getByLabel("Promise date (optional)").fill("2026-09-01");
    await followup.getByRole("button", { name: "Confirm" }).click();
    await expect(world.page.getByRole("status")).toContainText("follow-up", {
      ignoreCase: true,
    });
  } finally {
    await world.close();
  }
});

test("OFC-FIN-E2E-021 OFC-FIN-AUTH-022 vendor payable and payment-run CTAs enforce maker-checker and bank verification", async ({
  browser,
}, testInfo) => {
  const world = await worldFor(browser, testInfo);
  try {
    await makeDeliveredServiceInvoiceEligible(world);
    await grantFinanceAtRoot(world, "regional");
    await grantFinanceAtRoot(world, "multiRole");
    const bank = await workbenchApi<Record<string, unknown>>(
      world.page,
      `/domain/commands/vendors/${world.graph.vendor.id}/banks`,
      {
        method: "POST",
        data: {
          accountHolder: "Acceptance Vendor",
          accountNumber: "123456789012",
          ifsc: "HDFC0001234",
        },
      },
      201,
    );
    const regional = await openActorSession(browser, world, "regional");
    await workbenchApi(
      regional.page,
      `/domain/commands/vendor-banks/${bank.id}/decision`,
      {
        method: "POST",
        data: {
          expectedState: "PENDING_VERIFICATION",
          decision: "VERIFIED",
          reason: "Independent acceptance verification",
        },
      },
    );

    await world.page.goto("/app/finance/vendor-bills");
    const billNo = `VB-${world.suffix}`;
    await world.page
      .getByRole("button", { name: "Create vendor bill" })
      .click();
    const billDialog = world.page.getByRole("dialog", {
      name: "Create vendor bill",
    });
    await billDialog.getByLabel("Vendor invoice / reference").fill(billNo);
    await billDialog.getByLabel("GST amount (minor units)").fill("21600");
    await billDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(row(world.page, billNo)).toBeVisible();
    await clickFinanceAction(world.page, billNo, "Submit");

    await regional.page.goto("/app/finance/vendor-bills");
    await clickFinanceAction(regional.page, billNo, "Verify");
    await regional.context.close();
    const approver = await openActorSession(browser, world, "multiRole");
    try {
      await approver.page.goto("/app/finance/vendor-bills");
      await clickFinanceAction(approver.page, billNo, "Approve");
    } finally {
      await approver.context.close();
    }

    await world.page.reload();
    await row(world.page, billNo)
      .getByRole("button", { name: "Add to payment run" })
      .click();
    const payment = world.page.getByRole("dialog", {
      name: "Create payment run",
    });
    await payment
      .getByLabel("Verified bank account")
      .selectOption(String(bank.id));
    await payment.getByLabel("Payment amount (minor units)").fill("139200");
    const batchNo = `PAY-${world.suffix}`;
    await payment.getByLabel("Payment batch number").fill(batchNo);
    await payment.getByRole("button", { name: "Confirm" }).click();

    const paymentApprover = await openActorSession(browser, world, "multiRole");
    try {
      await paymentApprover.page.goto("/app/finance/payment-runs");
      await clickFinanceAction(paymentApprover.page, batchNo, "Approve");
    } finally {
      await paymentApprover.context.close();
    }
    await world.page.goto("/app/finance/payment-runs");
    await clickFinanceAction(world.page, batchNo, "Submit to bank");
    await row(world.page, batchNo)
      .getByRole("button", { name: "Mark paid" })
      .click();
    const paid = world.page.getByRole("dialog", {
      name: "Record bank payment",
    });
    await paid
      .getByLabel("Bank UTR / transaction reference")
      .fill(`BANK-${world.suffix}`);
    await paid.getByRole("button", { name: "Confirm" }).click();
    await expect(row(world.page, batchNo)).toContainText("PAID");
  } finally {
    await world.close();
  }
});

test("OFC-A11Y-E2E-032 finance dashboard is keyboard-labelled, responsive and free of serious Axe findings", async ({
  browser,
}, testInfo) => {
  const world = await worldFor(browser, testInfo);
  try {
    await createDraftInvoice(world, `A11Y-${world.suffix}`);
    await world.page.goto("/app/finance");
    await expectNoSeriousAccessibilityViolations(
      world.page,
      "finance workbench",
    );
    await expectNoPageOverflow(world.page);
    await expect(
      world.page.getByRole("navigation", { name: "Finance workbench" }),
    ).toBeVisible();
  } finally {
    await world.close();
  }
});
