import { expect, test as base, type Page } from "@playwright/test";
import {
  acceptInvitation,
  api,
  login,
  provisionViaApi,
  tenantFixture,
} from "../fixtures/fnd01";

type Field = {
  key: string;
  label: string;
  value: string;
  kind?: "select";
};

type Feature = {
  id: string;
  module: string;
  resource: string;
  route: string;
  heading: string;
  initialStatus: string;
  nextStatus: string;
  fields: readonly Field[];
  reconciliationKeys: readonly string[];
};

type RecordBody = {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
  data: Record<string, unknown>;
};

type WorkerPages = { primaryPage: Page; foreignPage: Page };

async function tenantOwner(page: Page, label: string) {
  await login(page);
  const fixture = tenantFixture(label);
  const provisioned = await provisionViaApi(page, fixture);
  await acceptInvitation(page, provisioned.invitationUrl, fixture.ownerName);
}

const acceptance = base.extend<{}, WorkerPages>({
  primaryPage: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await tenantOwner(page, `OF${workerInfo.workerIndex}A`);
      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
  foreignPage: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await tenantOwner(page, `OF${workerInfo.workerIndex}B`);
      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
});

acceptance.setTimeout(90_000);

const features: readonly Feature[] = [
  {
    id: "OPS01",
    module: "operations",
    resource: "indents",
    route: "/app/operations/indents",
    heading: "Indents",
    initialStatus: "DRAFT",
    nextStatus: "OPEN",
    fields: [
      {
        key: "indentAt",
        label: "Indent date and time",
        value: "2026-08-25T10:00",
      },
      { key: "clientCode", label: "Client code", value: "CLIENT-ALPHA" },
      { key: "locationCode", label: "Location code", value: "LOC-NORTH" },
      { key: "origin", label: "Origin", value: "Kolkata" },
      { key: "destination", label: "Destination", value: "Delhi" },
      { key: "truckType", label: "Truck type", value: "32FT-MXL" },
      { key: "requestedVehicles", label: "Requested vehicles", value: "3" },
      {
        key: "weightMilliTonnes",
        label: "Weight (milli-tonnes)",
        value: "18500",
      },
      {
        key: "pickupWindowStart",
        label: "Pickup window start",
        value: "2026-08-25T12:00",
      },
      {
        key: "committedPlacementAt",
        label: "Committed placement",
        value: "2026-08-26T12:00",
      },
      {
        key: "instructions",
        label: "Special instructions",
        value: "Seal and geo-stamped gate evidence required",
      },
    ],
    reconciliationKeys: ["clientCode", "locationCode", "requestedVehicles"],
  },
  {
    id: "OPS02",
    module: "operations",
    resource: "allocations",
    route: "/app/operations/allocations",
    heading: "Vendor allocations",
    initialStatus: "OFFERED",
    nextStatus: "ACCEPTED",
    fields: [
      { key: "indentCode", label: "Indent", value: "OPS01-LINK" },
      { key: "vendorCode", label: "Eligible vendor", value: "VENDOR-RED" },
      { key: "allottedVehicles", label: "Allotted vehicles", value: "2" },
      {
        key: "offeredRateMinor",
        label: "Offered rate (minor units)",
        value: "125000",
      },
      {
        key: "offerChannel",
        label: "Offer channel",
        value: "PORTAL",
        kind: "select",
      },
      { key: "vehicleNo", label: "Eligible vehicle", value: "WB01AB1234" },
      { key: "driverCode", label: "Eligible driver", value: "DRIVER-A" },
      {
        key: "placementStatus",
        label: "Placement status",
        value: "AWAITED",
        kind: "select",
      },
      {
        key: "actualReportingAt",
        label: "Actual reporting time",
        value: "2026-08-25T11:30",
      },
      { key: "delayReason", label: "NTP / delay reason", value: "No delay" },
    ],
    reconciliationKeys: ["indentCode", "vendorCode", "offeredRateMinor"],
  },
  {
    id: "OPS03",
    module: "operations",
    resource: "trips",
    route: "/app/operations/trips",
    heading: "Trips",
    initialStatus: "PLANNED",
    nextStatus: "AT_ORIGIN",
    fields: [
      { key: "allocationCode", label: "Placement", value: "ALLOC-001" },
      { key: "lrNo", label: "LR no", value: "LR-001" },
      { key: "vehicleNo", label: "Vehicle", value: "WB01AB1234" },
      { key: "driverCode", label: "Driver", value: "DRIVER-A" },
      {
        key: "eventType",
        label: "Milestone event",
        value: "GATE_IN",
        kind: "select",
      },
      {
        key: "eventAt",
        label: "Original event time",
        value: "2026-08-25T12:15",
      },
      {
        key: "quantityMilliTonnes",
        label: "Quantity (milli-tonnes)",
        value: "17500",
      },
      {
        key: "documentRefs",
        label: "LR / challan / e-way bill / seal",
        value: "LR-001 | CH-001 | EWB-001",
      },
      {
        key: "exceptionNotes",
        label: "Shortage, damage, detention, or exception",
        value: "Deterministic acceptance evidence",
      },
    ],
    reconciliationKeys: ["allocationCode", "lrNo", "quantityMilliTonnes"],
  },
  {
    id: "DOC01",
    module: "pod",
    resource: "proofs",
    route: "/app/pod",
    heading: "Proof of delivery",
    initialStatus: "AWAITING_POD",
    nextStatus: "RECEIVED",
    fields: [
      { key: "lrNo", label: "LR no", value: "LR-POD-001" },
      { key: "indentNo", label: "Indent no", value: "IND-POD-001" },
      { key: "clientCode", label: "Client code", value: "CLIENT-ALPHA" },
      { key: "locationCode", label: "Location code", value: "LOC-NORTH" },
      { key: "invoiceNos", label: "Invoice no(s)", value: "INV-001,INV-002" },
      { key: "vehicleNo", label: "Vehicle no", value: "WB01AB1234" },
      { key: "loadingDate", label: "Loading date", value: "2026-08-24" },
      { key: "deliveryDate", label: "Delivery date", value: "2026-08-25" },
      { key: "receivedDate", label: "POD received date", value: "2026-08-25" },
      { key: "mode", label: "POD mode", value: "DIGITAL", kind: "select" },
      { key: "receiverName", label: "Receiver name", value: "Client Receiver" },
      {
        key: "shortageDamageRemarks",
        label: "Shortage / damage remarks",
        value: "Nil shortage or damage",
      },
      {
        key: "submissionReference",
        label: "Client acknowledgement / reference",
        value: "ACK-POD-001",
      },
    ],
    reconciliationKeys: ["lrNo", "invoiceNos", "submissionReference"],
  },
  {
    id: "FIN01",
    module: "finance",
    resource: "invoices",
    route: "/app/finance/invoices",
    heading: "Client invoices",
    initialStatus: "DRAFT",
    nextStatus: "PENDING_APPROVAL",
    fields: [
      { key: "invoiceDate", label: "Invoice date", value: "2026-08-25" },
      { key: "clientCode", label: "Client", value: "CLIENT-ALPHA" },
      { key: "locationCode", label: "Location", value: "LOC-NORTH" },
      { key: "billingMonth", label: "Billing month", value: "2026-08" },
      { key: "tripLrRefs", label: "Trips / LRs", value: "TRIP-001 | LR-001" },
      {
        key: "taxableMinor",
        label: "Taxable value (minor units)",
        value: "100000",
      },
      { key: "taxMinor", label: "GST / tax (minor units)", value: "18000" },
      { key: "totalMinor", label: "Total (minor units)", value: "118000" },
      { key: "creditDays", label: "Credit days", value: "30" },
      {
        key: "submissionAt",
        label: "Acknowledged submission",
        value: "2026-08-25T14:00",
      },
      {
        key: "submissionReference",
        label: "Submission reference",
        value: "CLIENT-ACK-001",
      },
      { key: "notes", label: "Notes", value: "Exact INR minor-unit fixture" },
    ],
    reconciliationKeys: [
      "tripLrRefs",
      "taxableMinor",
      "taxMinor",
      "totalMinor",
    ],
  },
  {
    id: "FIN02",
    module: "finance",
    resource: "receipts",
    route: "/app/finance/receipts",
    heading: "Receipts and collections",
    initialStatus: "UNRECONCILED",
    nextStatus: "PENDING_APPROVAL",
    fields: [
      { key: "clientCode", label: "Client", value: "CLIENT-ALPHA" },
      { key: "paymentDate", label: "Payment date", value: "2026-08-25" },
      {
        key: "amountMinor",
        label: "Amount received (minor units)",
        value: "59000",
      },
      { key: "mode", label: "Mode", value: "NEFT", kind: "select" },
      {
        key: "instrumentNo",
        label: "UTR / instrument no",
        value: "UTR-RAPID-001",
      },
      { key: "bankAccount", label: "Bank account", value: "BANK-HDFC-001" },
      {
        key: "invoiceAllocations",
        label: "Invoice allocations, deductions, and references",
        value: "INV-001=59000",
      },
      {
        key: "followUpAt",
        label: "Follow-up date/time",
        value: "2026-08-26T10:00",
      },
      {
        key: "promiseToPay",
        label: "Promise to pay / next action",
        value: "Allocation confirmation",
      },
    ],
    reconciliationKeys: ["amountMinor", "instrumentNo", "invoiceAllocations"],
  },
  {
    id: "FIN03",
    module: "finance",
    resource: "vendor-bills",
    route: "/app/finance/vendor-bills",
    heading: "Vendor bills and payments",
    initialStatus: "DRAFT",
    nextStatus: "PENDING_OPERATIONAL_VERIFICATION",
    fields: [
      { key: "vendorCode", label: "Vendor", value: "VENDOR-RED" },
      { key: "invoiceDate", label: "Invoice date", value: "2026-08-25" },
      { key: "servicePeriod", label: "Service period", value: "2026-08" },
      { key: "tripLrRefs", label: "Trips / LRs", value: "TRIP-001 | LR-001" },
      {
        key: "taxableMinor",
        label: "Taxable value (minor units)",
        value: "80000",
      },
      { key: "gstMinor", label: "GST (minor units)", value: "14400" },
      { key: "tdsMinor", label: "TDS (minor units)", value: "800" },
      {
        key: "deductionsMinor",
        label: "Deductions (minor units)",
        value: "1000",
      },
      { key: "advancesMinor", label: "Advances (minor units)", value: "5000" },
      {
        key: "payableMinor",
        label: "Payable total (minor units)",
        value: "87600",
      },
      {
        key: "verifiedBankAccount",
        label: "Verified bank account",
        value: "BANK-VERIFIED-001",
      },
      {
        key: "varianceReason",
        label: "Three-way variance / dispute reason",
        value: "No variance",
      },
    ],
    reconciliationKeys: [
      "tripLrRefs",
      "taxableMinor",
      "gstMinor",
      "tdsMinor",
      "payableMinor",
    ],
  },
];

function endpoint(feature: Feature) {
  return `/modules/${feature.module}/${feature.resource}`;
}

function unique(feature: Feature, purpose: string) {
  const suffix = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 10)
    .toUpperCase();
  return {
    code: `${feature.id}-${purpose}-${suffix}`.slice(0, 40),
    name: `${feature.heading} ${purpose} ${suffix}`,
  };
}

function exactData(feature: Feature) {
  return Object.fromEntries(
    feature.fields.map((field) => [field.key, field.value]),
  );
}

async function createViaApi(page: Page, feature: Feature, purpose: string) {
  const identity = unique(feature, purpose);
  const response = await api(page, endpoint(feature), {
    method: "POST",
    headers: { "Idempotency-Key": `acceptance-${crypto.randomUUID()}` },
    data: { ...identity, data: exactData(feature) },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as RecordBody;
}

for (const feature of features) {
  acceptance(
    `${feature.id}-UI-001 permitted UI create persists exact values`,
    async ({ primaryPage }) => {
      const identity = unique(feature, "UI");
      await primaryPage.goto(feature.route);
      await expect(
        primaryPage.getByRole("heading", { name: feature.heading, level: 1 }),
      ).toBeVisible();
      await primaryPage.getByLabel("Code", { exact: true }).fill(identity.code);
      await primaryPage.getByLabel("Name", { exact: true }).fill(identity.name);
      for (const field of feature.fields) {
        if (field.kind === "select") {
          const input = primaryPage.getByRole("combobox", {
            name: field.label,
            exact: true,
          });
          await input.selectOption(field.value);
          await expect(input).toHaveValue(field.value);
        } else {
          await primaryPage
            .getByLabel(field.label, { exact: true })
            .fill(field.value);
        }
      }
      const createdResponse = primaryPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/api/v1${endpoint(feature)}`),
      );
      await primaryPage.getByRole("button", { name: "Create draft" }).click();
      const response = await createdResponse;
      expect(response.status(), await response.text()).toBe(201);
      const created = (await response.json()) as RecordBody;
      await expect(
        primaryPage.getByText(`${feature.heading} record created.`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        primaryPage.getByRole("heading", { name: identity.name, level: 3 }),
      ).toBeVisible();
      const detailResponse = await api(
        primaryPage,
        `${endpoint(feature)}/${created.id}`,
      );
      expect(detailResponse.status(), await detailResponse.text()).toBe(200);
      const detail = (await detailResponse.json()) as RecordBody;
      expect(detail).toMatchObject({
        code: identity.code,
        name: identity.name,
        status: feature.initialStatus,
        data: exactData(feature),
      });
    },
  );

  acceptance(
    `${feature.id}-VAL-002 validation prevents partial mutation`,
    async ({ primaryPage }) => {
      const beforeResponse = await api(primaryPage, endpoint(feature));
      expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);
      const before = (await beforeResponse.json()) as { total: number };
      await primaryPage.goto(feature.route);
      await primaryPage.getByRole("button", { name: "Create draft" }).click();
      await expect(
        primaryPage.getByLabel("Code", { exact: true }),
      ).toBeFocused();
      const invalidCount = await primaryPage.locator("form :invalid").count();
      expect(invalidCount).toBeGreaterThan(0);
      const afterResponse = await api(primaryPage, endpoint(feature));
      expect(afterResponse.status(), await afterResponse.text()).toBe(200);
      const after = (await afterResponse.json()) as { total: number };
      expect(after.total).toBe(before.total);
    },
  );

  acceptance(
    `${feature.id}-AUTH-003 cross-tenant direct ID access is denied`,
    async ({ primaryPage, foreignPage }) => {
      const created = await createViaApi(primaryPage, feature, "AUTH");
      const response = await api(
        foreignPage,
        `${endpoint(feature)}/${created.id}`,
      );
      expect(response.status(), await response.text()).toBe(404);
      const body = (await response.json()) as {
        code?: string;
        message?: string;
      };
      expect(body).toMatchObject({
        code: "RECORD_NOT_FOUND",
        message: "Resource not found",
      });
      expect(JSON.stringify(body)).not.toContain(created.code);
    },
  );

  acceptance(
    `${feature.id}-STATE-004 stale version transition is atomic`,
    async ({ primaryPage }) => {
      const created = await createViaApi(primaryPage, feature, "STATE");
      const first = await api(
        primaryPage,
        `${endpoint(feature)}/${created.id}/transition`,
        {
          method: "POST",
          data: {
            toStatus: feature.nextStatus,
            expectedVersion: created.version,
          },
        },
      );
      expect(first.status(), await first.text()).toBe(200);
      const transitioned = (await first.json()) as RecordBody;
      expect(transitioned).toMatchObject({
        status: feature.nextStatus,
        version: created.version + 1,
      });
      const stale = await api(
        primaryPage,
        `${endpoint(feature)}/${created.id}/transition`,
        {
          method: "POST",
          data: {
            toStatus: feature.nextStatus,
            expectedVersion: created.version,
          },
        },
      );
      expect(stale.status(), await stale.text()).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: "VERSION_CONFLICT",
        message: "The record changed; reload and retry",
      });
      const detailResponse = await api(
        primaryPage,
        `${endpoint(feature)}/${created.id}`,
      );
      const detail = (await detailResponse.json()) as RecordBody;
      expect(detail).toMatchObject({
        status: feature.nextStatus,
        version: created.version + 1,
      });
    },
  );

  acceptance(
    `${feature.id}-RPT-005 report reconciles with detail and exact downstream values`,
    async ({ primaryPage }) => {
      const created = await createViaApi(primaryPage, feature, "RPT");
      const transition = await api(
        primaryPage,
        `${endpoint(feature)}/${created.id}/transition`,
        {
          method: "POST",
          data: {
            toStatus: feature.nextStatus,
            expectedVersion: created.version,
          },
        },
      );
      expect(transition.status(), await transition.text()).toBe(200);
      const [listResponse, reportResponse, detailResponse] = await Promise.all([
        api(primaryPage, endpoint(feature)),
        api(primaryPage, `${endpoint(feature)}/report`),
        api(primaryPage, `${endpoint(feature)}/${created.id}`),
      ]);
      expect(listResponse.status(), await listResponse.text()).toBe(200);
      expect(reportResponse.status(), await reportResponse.text()).toBe(200);
      expect(detailResponse.status(), await detailResponse.text()).toBe(200);
      const list = (await listResponse.json()) as {
        items: RecordBody[];
        total: number;
      };
      const report = (await reportResponse.json()) as {
        feature: string;
        rows: { status: string; count: number }[];
      };
      const detail = (await detailResponse.json()) as RecordBody & {
        snapshots: unknown[];
        events: unknown[];
      };
      expect(report.feature).toBe(
        feature.id.replace(/^(OPS|DOC|FIN)(\d\d)$/, "$1-$2"),
      );
      expect(report.rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(
        list.total,
      );
      expect(
        report.rows.find((row) => row.status === feature.nextStatus)?.count,
      ).toBeGreaterThanOrEqual(1);
      expect(list.items.find((item) => item.id === created.id)).toMatchObject({
        status: feature.nextStatus,
      });
      for (const key of feature.reconciliationKeys)
        expect(detail.data[key]).toBe(exactData(feature)[key]);
      expect(detail.snapshots).toHaveLength(2);
      expect(detail.events).toHaveLength(2);
    },
  );
}
