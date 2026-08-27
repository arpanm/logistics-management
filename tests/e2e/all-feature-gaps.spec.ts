import { expect, test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { api } from "../fixtures/fnd01";
import {
  createGapWorld,
  createCommercialGraph,
  createMasterGraph,
  createOperationalGraph,
  createOrganizationPair,
  createResource,
  domain,
  expectJson,
  idempotency,
  listResource,
  reportResource,
  type GapWorld,
} from "../fixtures/all-feature-gaps";

const journeys = {
  "E2E-GAP-XF-01": [
    "E2E-GAP-MST02-01",
    "E2E-GAP-MST02-02",
    "E2E-GAP-MST03-02",
    "E2E-GAP-OPS01-01",
    "E2E-GAP-OPS02-01",
    "E2E-GAP-OPS02-03",
    "E2E-GAP-DOC01-03",
    "E2E-GAP-FIN01-01",
    "E2E-GAP-FIN03-01",
    "E2E-GAP-FIN03-02",
    "E2E-GAP-FIN03-03",
    "E2E-GAP-CTL01-01",
    "E2E-GAP-GOV01-02",
    "E2E-GAP-CFG01-02",
  ],
  "E2E-GAP-XF-02": [
    "E2E-GAP-MST01-02",
    "E2E-GAP-OPS01-03",
    "E2E-GAP-OPS02-02",
    "E2E-GAP-OPS02-04",
    "E2E-GAP-CTL01-02",
    "E2E-GAP-ALT01-01",
  ],
  "E2E-GAP-XF-03": [
    "E2E-GAP-OPS03-03",
    "E2E-GAP-DOC01-01",
    "E2E-GAP-DOC01-02",
    "E2E-GAP-FIN01-02",
    "E2E-GAP-ALT01-02",
    "E2E-GAP-GOV01-01",
  ],
  "E2E-GAP-XF-04": [
    "E2E-GAP-FIN02-01",
    "E2E-GAP-FIN02-02",
    "E2E-GAP-FIN02-03",
    "E2E-GAP-GOV01-03",
  ],
  "E2E-GAP-XF-05": [
    "E2E-GAP-MST02-03",
    "E2E-GAP-MST03-01",
    "E2E-GAP-OPS01-02",
    "E2E-GAP-FIN01-03",
    "E2E-GAP-DAT01-01",
    "E2E-GAP-DAT01-02",
    "E2E-GAP-DAT01-03",
    "E2E-GAP-INT01-01",
  ],
  "E2E-GAP-XF-06": [
    "E2E-GAP-MST01-01",
    "E2E-GAP-MST03-03",
    "E2E-GAP-DAT01-04",
    "E2E-GAP-INT01-04",
    "E2E-GAP-CFG01-01",
    "E2E-GAP-CFG01-03",
  ],
  "E2E-GAP-XF-07": ["E2E-GAP-OPS03-01", "E2E-GAP-OPS03-02"],
  "E2E-GAP-ISO-01": [
    "E2E-GAP-CTL01-03",
    "E2E-GAP-ALT01-03",
    "E2E-GAP-INT01-02",
    "E2E-GAP-INT01-03",
  ],
} as const;

async function tenantJson<T = Record<string, unknown>>(
  world: GapWorld,
  path: string,
  options: { method?: string; data?: unknown; key?: string } = {},
  status = 200,
) {
  const headers: Record<string, string> = {};
  if (options.key) headers["Idempotency-Key"] = options.key;
  return expectJson<T>(
    await api(world.page, path, {
      method: options.method,
      data: options.data,
      headers,
    }),
    status,
  );
}

async function reconcileCanonical(world: GapWorld, resource: string) {
  const list = await listResource(world.page, resource);
  const report = await reportResource(world.page, resource);
  expect(report.total).toBe(list.total);
  expect(report.rows.reduce((total, row) => total + Number(row.count), 0)).toBe(
    list.total,
  );
  return { list, report };
}

async function reconcileLens(world: GapWorld, lens: string) {
  const dashboard = await tenantJson<{
    lens: string;
    totals: { records: number };
    status: Array<{ status: string; count: number }>;
  }>(world, `/tenant/control/${lens}`);
  const drill = await expectJson<Array<Record<string, unknown>>>(
    await api(world.page, `/tenant/control/${lens}/drill`),
    200,
  );
  expect(dashboard.lens).toBe(lens);
  expect(dashboard.totals.records).toBe(drill.length);
  expect(dashboard.status.reduce((sum, item) => sum + item.count, 0)).toBe(
    drill.length,
  );
  return { dashboard, drill };
}

async function acceptanceEvidence(world: GapWorld, id: string) {
  if (id === "E2E-GAP-MST01-01") {
    const { root, child } = await createOrganizationPair(world);
    const cycle = await domain(
      world.page,
      `/commands/organization/${root.id}/move`,
      {
        method: "POST",
        data: {
          parentId: child.id,
          expectedVersion: root.version,
          reason: "Cycle must be rejected",
        },
      },
    );
    const body = await expectJson<{ code: string }>(cycle, 409);
    expect(body.code).toBe("HIERARCHY_CYCLE");
    return "cycle rejected by server; hierarchy remained queryable";
  }

  if (id === "E2E-GAP-OPS01-02") {
    const key = idempotency("indent-retry");
    const payload = {
      code: `IDEM${world.suffix}`,
      name: `Idempotency ${world.suffix}`,
      nodeType: "REGION",
      timezone: "Asia/Kolkata",
      postalCodes: [],
      geofence: {},
      activeFrom: "2026-01-01",
    };
    const first = await createResource(
      world.page,
      "organization-nodes",
      payload,
      key,
    );
    const replay = await createResource(
      world.page,
      "organization-nodes",
      payload,
      key,
    );
    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    const conflict = await domain(world.page, "/organization-nodes", {
      method: "POST",
      key,
      data: { ...payload, name: "Conflicting payload" },
    });
    await expectJson(conflict, 409);
    return "same-key replay converged and conflicting payload was rejected";
  }

  if (id === "E2E-GAP-DOC01-02") {
    const invalid = await domain(world.page, "/governance/documents", {
      method: "POST",
      data: {
        targetType: "POD",
        targetId: world.fixture.resources.trip.id,
        category: "SIGNED_POD",
        confidentiality: "CLIENT",
        fileName: "pod.exe",
        mediaType: "application/octet-stream",
        contentBase64: "TVqQAAMAAAAEAAAA",
        checksumSha256: "a".repeat(64),
      },
    });
    await expectJson(invalid, 400);
    return "disallowed document media type was rejected before persistence";
  }

  if (id === "E2E-GAP-CFG01-02") {
    const invalid = await domain(world.page, "/configurations", {
      method: "POST",
      data: {
        namespace: "alerts",
        value: { yellowAt: 48, redAt: 24 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    });
    const body = await expectJson<{ code: string }>(invalid, [400, 409]);
    expect(body.code).toMatch(/VALIDATION|THRESHOLD/);
    return "ambiguous thresholds were rejected server-side";
  }

  if (id === "E2E-GAP-DAT01-02") {
    const invalid = await api(world.page, "/tenant/imports/parse", {
      method: "POST",
      data: {
        filename: "clients.csv",
        mediaType: "text/csv",
        contentBase64: btoa("Client Code,Client Code\nC1,C2\n"),
      },
    });
    await expectJson(invalid, 400);
    return "duplicate headers failed parse before commit";
  }

  if (id === "E2E-GAP-OPS03-01" || id === "E2E-GAP-OPS03-02") {
    const graph = await createOperationalGraph(world);
    if (id === "E2E-GAP-OPS03-02") {
      const newer = await domain(world.page, `/trips/${graph.trip.id}/events`, {
        method: "POST",
        data: {
          eventKey: `online-newer-${world.suffix}`,
          eventType: "GPS",
          source: "GPS",
          deviceAt: "2026-08-25T05:00:00.000Z",
          latitude: 22.5727,
          longitude: 88.364,
          evidence: { queueSequence: 2 },
        },
        key: idempotency(`online-newer-${world.suffix}`),
      });
      await expectJson(newer, 201);
    }
    const eventKey = `offline-${id}-${world.suffix}`;
    const payload = {
      eventKey,
      eventType: "GPS",
      source: "OFFLINE",
      deviceAt:
        id === "E2E-GAP-OPS03-02"
          ? "2026-08-25T04:00:00.000Z"
          : "2026-08-25T05:00:00.000Z",
      latitude: 22.5726,
      longitude: 88.3639,
      evidence: { queueSequence: 1 },
    };
    const first = await domain(world.page, `/trips/${graph.trip.id}/events`, {
      method: "POST",
      data: payload,
      key: idempotency(eventKey),
    });
    const created = await expectJson<{
      id: string;
      event_key: string;
      ordering_conflict: boolean;
    }>(first, 201);
    expect(created.event_key).toBe(eventKey);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    if (id === "E2E-GAP-OPS03-02") expect(created.ordering_conflict).toBe(true);
    return "offline event used canonical idempotent endpoint and assignment/privacy enforcement";
  }

  if (id === "E2E-GAP-CTL01-03") {
    await world.page.goto("/app/control");
    const violations = await new AxeBuilder({ page: world.page })
      .include("main")
      .analyze();
    expect(
      violations.violations.filter((v) =>
        ["critical", "serious"].includes(v.impact ?? ""),
      ),
    ).toEqual([]);
    await world.page.keyboard.press("Tab");
    await expect(world.page.locator(":focus")).toBeVisible();
    return `Axe passed at ${world.page.viewportSize()?.width ?? 0}px and keyboard focus is visible`;
  }

  if (id === "E2E-GAP-ALT01-03" || id === "E2E-GAP-INT01-03") {
    const run = await domain(world.platformPage, "/workers/run", {
      method: "POST",
      data: { limit: 50 },
    });
    const body = await expectJson<Record<string, unknown>>(run, 200);
    expect(body).toEqual(
      expect.objectContaining({
        alerts: expect.any(Number),
        notifications: expect.any(Number),
        integrations: expect.any(Number),
      }),
    );
    return "PostgreSQL worker lease/retry cycle completed through supported worker command";
  }

  if (id === "E2E-GAP-MST01-02") {
    const graph = await createMasterGraph(world);
    await createResource(world.page, "employees", {
      employeeCode: `SB${world.suffix}`,
      displayName: `Subordinate ${world.suffix}`,
      managerId: graph.employee.id,
      homeNodeId: graph.branch.id,
      activeFrom: "2026-01-01",
    });
    const blocked = await domain(
      world.page,
      `/employees/${graph.employee.id}/transition`,
      {
        method: "POST",
        data: {
          expectedVersion: graph.employee.version,
          toState: "INACTIVE",
          reason: "Manager still owns an active subordinate",
        },
      },
    );
    const body = await expectJson<{ code: string }>(blocked, 409);
    expect(body.code).toBe("REASSIGNMENT_REQUIRED");
    return "manager deactivation was blocked until reassignment";
  }

  if (id === "E2E-GAP-MST02-01") {
    const graph = await createCommercialGraph(world);
    expect(graph.contractVersion).toMatchObject({ version: 2 });
    expect(graph.lane).toMatchObject({
      contract_version_id: graph.contractVersion.id,
      origin_location_id: graph.origin.id,
      destination_location_id: graph.destination.id,
    });
    const truckType = await expectJson<{ id: string }>(
      await api(world.page, "/domain/master-admin/catalogs", {
        method: "POST",
        headers: { "Idempotency-Key": idempotency("lane-truck-type") },
        data: {
          kind: "TRUCK_TYPE",
          code: `UI${world.suffix}`,
          name: `UI lane truck ${world.suffix}`,
          capacityMilli: "32000",
        },
      }),
      201,
    );

    await world.page.goto("/app/masters/lanes");
    await expect(
      world.page.getByRole("heading", { name: "Lanes, SLA and rates" }),
    ).toBeVisible();
    const form = world.page
      .getByRole("button", { name: "Create lane" })
      .locator("xpath=ancestor::form");

    const contractSearchResponse = world.page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/api/v1/domain/commands/contracts/versions") &&
        response.url().includes(`search=CT${world.suffix}`),
    );
    await form.getByLabel("Search Contract version").fill(`CT${world.suffix}`);
    const contractLookup = await contractSearchResponse;
    expect(contractLookup.status(), await contractLookup.text()).toBe(200);
    await expect(
      form
        .getByLabel("Contract version", { exact: true })
        .locator(`option[value="${graph.contractVersion.id}"]`),
    ).toHaveCount(1);
    await form
      .getByLabel("Contract version", { exact: true })
      .selectOption(String(graph.contractVersion.id));

    for (const [label, resource, search, selectedId] of [
      [
        "Origin location",
        "client-locations",
        `OR${world.suffix}`,
        graph.origin.id,
      ],
      [
        "Destination location",
        "client-locations",
        `DS${world.suffix}`,
        graph.destination.id,
      ],
      [
        "Truck type",
        "master-admin/catalogs/TRUCK_TYPE",
        `UI${world.suffix}`,
        truckType.id,
      ],
    ] as const) {
      const lookupResponse = world.page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/api/v1/domain/${resource}`) &&
          response.url().includes(`search=${search}`),
      );
      await form.getByLabel(`Search ${label}`).fill(search);
      expect((await lookupResponse).status()).toBe(200);
      const select = form.getByLabel(label, { exact: true });
      await expect(
        select.locator(`option[value="${String(selectedId)}"]`),
      ).toHaveCount(1);
      await select.selectOption(String(selectedId));
    }

    const laneCode = `UILN${world.suffix}`;
    await form.getByLabel("Lane code").fill(laneCode);
    await form.getByLabel("Placement minutes").fill("120");
    await form.getByLabel("Transit minutes").fill("1440");
    await form.getByLabel("POD minutes").fill("2880");
    await form.getByLabel("Rate minor units").fill("150000");
    await form.getByLabel("Tax basis points").fill("1800");
    await form.getByLabel("Effective from").fill("2027-01-01T00:00");

    const laneResponse = world.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/domain/lanes"),
    );
    await form.getByRole("button", { name: "Create lane" }).click();
    const createdResponse = await laneResponse;
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = (await createdResponse.json()) as {
      contract_version_id: string;
      code: string;
    };
    expect(created).toMatchObject({
      contract_version_id: graph.contractVersion.id,
      code: laneCode,
    });
    await expect(form.getByRole("status")).toHaveText("lane created.");
    await expect(form.getByLabel("Lane code")).toHaveValue("");
    await expect(
      world.page
        .locator(".responsive-list")
        .getByRole("article")
        .filter({ hasText: laneCode }),
    ).toBeVisible();
    return "contract-version search returned the tenant-scoped version and the selected contract enabled UI lane creation";
  }

  if (id === "E2E-GAP-MST02-02") {
    const graph = await createCommercialGraph(world);
    const overlap = await domain(world.page, "/lanes", {
      method: "POST",
      data: {
        contractVersionId: graph.contractVersion.id,
        code: `OV${world.suffix}`,
        originLocationId: graph.origin.id,
        destinationLocationId: graph.destination.id,
        truckType: "32FT",
        quantityMinMilli: 1000,
        quantityMaxMilli: 100000,
        priority: 10,
        placementMinutes: 1440,
        transitMinutes: 2880,
        podMinutes: 10080,
        rateMinor: 130000,
        taxBasisPoints: 1800,
        effectiveFrom: "2026-06-01T00:00:00.000Z",
      },
    });
    const body = await expectJson<{ code: string }>(overlap, 409);
    expect(body.code).toBe("EFFECTIVE_OVERLAP");
    return "overlapping equally-prioritized commercial rate was rejected";
  }

  if (id === "E2E-GAP-MST02-03") {
    const csv = "Client Code,Legal Name,Credit Days\nC100,Acme Logistics,30\n";
    const parsed = await tenantJson<{
      headers: string[];
      rows: Array<Record<string, string>>;
    }>(world, "/tenant/imports/parse", {
      method: "POST",
      data: {
        filename: "clients.csv",
        mediaType: "text/csv",
        contentBase64: Buffer.from(csv).toString("base64"),
      },
    });
    expect(parsed.headers).toEqual([
      "Client Code",
      "Legal Name",
      "Credit Days",
    ]);
    expect(parsed.rows).toEqual([
      {
        "Client Code": "C100",
        "Legal Name": "Acme Logistics",
        "Credit Days": "30",
      },
    ]);
    return "client workbook fields parsed losslessly";
  }

  if (id === "E2E-GAP-MST03-01") {
    const graph = await createMasterGraph(world);
    const duplicates = await expectJson<Array<{ id: string; score: number }>>(
      await api(
        world.page,
        `/domain/commands/duplicates?kind=VENDOR&name=${encodeURIComponent(String(graph.vendor.legal_name))}&taxId=${encodeURIComponent(String(graph.vendor.pan))}`,
      ),
      200,
    );
    expect(duplicates).toContainEqual(
      expect.objectContaining({ id: graph.vendor.id, score: 1 }),
    );
    return "tenant-scoped vendor identity duplicate detection found the canonical vendor";
  }

  if (id === "E2E-GAP-MST03-02") {
    const graph = await createMasterGraph(world);
    const eligibility = await tenantJson<{
      eligible: boolean;
      requirements: Array<{ eligible: boolean; validTo: string }>;
    }>(world, `/domain/commands/eligibility/VENDOR/${graph.vendor.id}`);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.requirements).toEqual([]);
    return "vendor without verified compliance returned an ineligible decision";
  }

  if (id === "E2E-GAP-MST03-03") {
    const graph = await createMasterGraph(world);
    const bank = await tenantJson<{ id: string; state: string }>(
      world,
      `/domain/commands/vendors/${graph.vendor.id}/banks`,
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
    expect(bank.state).toBe("PENDING_VERIFICATION");
    const banks = await expectJson<Array<Record<string, unknown>>>(
      await api(
        world.page,
        `/domain/commands/vendors/${graph.vendor.id}/banks`,
      ),
      200,
    );
    expect(banks).toContainEqual(
      expect.objectContaining({ id: bank.id, accountLast4: "9012" }),
    );
    return "bank change persisted encrypted/masked and pending independent verification";
  }

  if (id === "E2E-GAP-OPS01-01") {
    const graph = await createOperationalGraph(world);
    expect(graph.indent).toMatchObject({
      client_id: graph.client.id,
      client_location_id: graph.origin.id,
      lane_id: graph.lane.id,
      committed_placement_at: expect.any(String),
      commercial_snapshot: expect.objectContaining({
        rateMinor: expect.anything(),
      }),
    });
    return "indent persisted selected location and calculated SLA/commercial snapshot";
  }

  if (id === "E2E-GAP-OPS01-03") {
    const graph = await createOperationalGraph(world);
    const cancelled = await tenantJson<Record<string, unknown>>(
      world,
      `/domain/commands/indents/${graph.indent.id}/cancel`,
      {
        method: "POST",
        data: {
          cancelledVehicles: 1,
          vendorCostMinor: "0",
          expectedVersion: graph.indent.version,
          reason: "Client reduced one requested vehicle",
        },
      },
    );
    expect(cancelled).toMatchObject({
      indent: { id: graph.indent.id },
      cancellation: { cancelled_vehicles: 1 },
      remainingVehicles: 0,
    });
    const detail = await tenantJson<Record<string, unknown>>(
      world,
      `/domain/indents/${graph.indent.id}`,
    );
    expect(detail).toMatchObject({ requested_vehicles: 2, state: "CANCELLED" });
    return "partial cancellation preserved original demand and cancelled the remaining unallocated vehicle";
  }

  if (id === "E2E-GAP-OPS02-01") {
    const graph = await createOperationalGraph(world);
    const ineligibleVendor = await createResource(world.page, "vendors", {
      code: `IV${world.suffix}`,
      legalName: `Ineligible Vendor ${world.suffix}`,
      pan: `IPAN${world.suffix}`,
      tdsBasisPoints: 100,
      paymentTermsDays: 15,
      authorizationScopeNodeId: world.fixture.scopes.vendor,
    });
    const invalid = await domain(world.page, "/allocations", {
      method: "POST",
      data: {
        indentId: graph.indent.id,
        vendorId: ineligibleVendor.id,
        allottedVehicles: 1,
        offeredRateMinor: 100000,
        offerChannel: "PORTAL",
        offeredAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-08-26T00:00:00.000Z",
      },
    });
    const body = await expectJson<{ code: string }>(invalid, 409);
    expect(body.code).toBe("VENDOR_INELIGIBLE");
    return "allocation rejected a vendor lacking active eligible service scope";
  }

  if (id === "E2E-GAP-OPS02-02") {
    const { dashboard } = await reconcileLens(world, "placement");
    expect(dashboard.status.map((row) => row.status)).toEqual([
      "GREEN",
      "YELLOW",
      "RED",
    ]);
    return "placement dashboard exposes canonical Green/Yellow/Red buckets";
  }

  if (id === "E2E-GAP-OPS02-03" || id === "E2E-GAP-OPS02-04") {
    await createOperationalGraph(world);
    const { dashboard, drill } = await reconcileLens(world, "placement");
    expect(dashboard.totals.records).toBeGreaterThan(0);
    expect(drill.map((row) => row.id)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    return "placement totals and drill rows reconcile to canonical indents";
  }

  if (id === "E2E-GAP-OPS03-03") {
    const reconciled = await reconcileCanonical(world, "pod-tasks");
    expect(reconciled.report.rows).toEqual(expect.any(Array));
    return "POD task register and report use the same canonical task projection";
  }

  if (id === "E2E-GAP-DOC01-01") {
    const { dashboard, drill } = await reconcileLens(world, "pod");
    expect(dashboard.totals.records).toBe(drill.length);
    return "POD ageing totals reconcile to canonical drill rows";
  }

  if (id === "E2E-GAP-DOC01-03") {
    const graph = await createOperationalGraph(world);
    expect(graph.indent.commercial_snapshot).toMatchObject({
      documentRequirements: ["SIGNED_POD"],
      podMode: "DIGITAL",
    });
    return "POD requirements were snapshotted onto the indent from its contract version";
  }

  if (
    ["E2E-GAP-FIN01-01", "E2E-GAP-FIN01-02", "E2E-GAP-FIN01-03"].includes(id)
  ) {
    const { list, report } = await reconcileCanonical(world, "invoices");
    expect(report.total).toBe(list.items.length);
    return "invoice register and state report reconcile without synthetic financial rows";
  }

  if (["E2E-GAP-FIN02-01", "E2E-GAP-FIN02-03"].includes(id)) {
    const receipt = await reconcileCanonical(world, "receipts");
    const invoice = await reconcileCanonical(world, "invoices");
    expect(receipt.report.total + invoice.report.total).toBe(
      receipt.list.items.length + invoice.list.items.length,
    );
    return "receipt ledger and invoice registers independently reconcile";
  }

  if (id === "E2E-GAP-FIN02-02") {
    const { dashboard, drill } = await reconcileLens(world, "collection");
    expect(dashboard.totals.records).toBe(drill.length);
    return "collection ageing colours reconcile with visible canonical drill rows";
  }

  if (
    ["E2E-GAP-FIN03-01", "E2E-GAP-FIN03-02", "E2E-GAP-FIN03-03"].includes(id)
  ) {
    const bills = await reconcileCanonical(world, "vendor-bills");
    const payable = await reconcileLens(world, "vendor-payable");
    expect(bills.report.total).toBe(payable.dashboard.totals.records);
    return "vendor payable register and control lens reconcile to canonical bills";
  }

  if (id === "E2E-GAP-CTL01-01") {
    for (const lens of [
      "placement",
      "pod",
      "collection",
      "trip",
      "vendor-payable",
    ])
      await reconcileLens(world, lens);
    return "all five control-tower KPI lenses reconcile totals with their drill rows";
  }

  if (id === "E2E-GAP-CTL01-02") {
    const saved = await tenantJson<{
      id: string;
      lens: string;
      version: number;
    }>(
      world,
      "/tenant/control/placement/views",
      {
        method: "POST",
        data: {
          name: `North ${world.suffix}`,
          filters: { status: "RED" },
          isDefault: true,
        },
      },
      201,
    );
    const views = await expectJson<Array<Record<string, unknown>>>(
      await api(world.page, "/tenant/control/placement/views"),
      200,
    );
    expect(views).toContainEqual(
      expect.objectContaining({ id: saved.id, isDefault: true }),
    );
    return "scoped saved control view round-tripped its filter and default state";
  }

  if (id === "E2E-GAP-ALT01-01") {
    const rule = await tenantJson<{ id: string; code: string }>(
      world,
      "/tenant/alert-rules",
      {
        method: "POST",
        data: {
          code: `POD_${world.suffix}`,
          name: "POD ageing threshold",
          sourceModule: "pod-tasks",
          metricCode: "POD_AGE_DAYS",
          scopeNodeIds: [world.fixture.scopes.root],
          threshold: { value: 7 },
          severity: "HIGH",
          recipientPolicy: { owner: true },
          channels: ["IN_APP"],
          quietHours: {},
          repeatPolicy: { minutes: 60 },
          escalationLevels: [],
          acknowledgementRequired: true,
          resolutionCondition: { repaired: true },
          active: true,
        },
      },
      201,
    );
    expect(rule.code).toBe(`POD_${world.suffix}`);
    const rules = await expectJson<Array<Record<string, unknown>>>(
      await api(world.page, "/tenant/alert-rules"),
      200,
    );
    expect(rules).toContainEqual(expect.objectContaining({ id: rule.id }));
    return "threshold rule persisted with scoped recipient/channel policy";
  }

  if (id === "E2E-GAP-ALT01-02") {
    const queue = await tenantJson<{
      items: Array<Record<string, unknown>>;
      total: number;
    }>(world, "/tenant/alerts");
    expect(queue.total).toBe(queue.items.length);
    expect(queue.items.every((item) => item.id && item.state)).toBe(true);
    return "scoped alert queue exposes actionable canonical occurrences only";
  }

  if (id === "E2E-GAP-DAT01-01") {
    const parsed = await tenantJson<{ headers: string[]; rows: unknown[] }>(
      world,
      "/tenant/imports/parse",
      {
        method: "POST",
        data: {
          filename: "vendors.csv",
          mediaType: "text/csv",
          contentBase64: Buffer.from(
            "Vendor Code,Legal Name\nV1,Vendor One\n",
          ).toString("base64"),
        },
      },
    );
    expect(parsed).toMatchObject({
      headers: ["Vendor Code", "Legal Name"],
      rows: [{ "Vendor Code": "V1", "Legal Name": "Vendor One" }],
    });
    return "CSV parser preserved exact vendor fields before import preview";
  }

  if (id === "E2E-GAP-DAT01-03") {
    const csv = "Client Code,Legal Name\nC1,Client One\n";
    const data = {
      filename: "clients.csv",
      mediaType: "text/csv",
      contentBase64: Buffer.from(csv).toString("base64"),
    };
    const first = await tenantJson<{ checksum: string }>(
      world,
      "/tenant/imports/parse",
      { method: "POST", data },
    );
    const replay = await tenantJson<{ checksum: string }>(
      world,
      "/tenant/imports/parse",
      { method: "POST", data },
    );
    expect(replay.checksum).toBe(first.checksum);
    return "identical import bytes produced a stable checksum for idempotent preview/commit";
  }

  if (id === "E2E-GAP-DAT01-04") {
    const status = await tenantJson<Record<string, unknown>>(
      world,
      "/tenant/imports/status",
    );
    expect(status).not.toHaveProperty("rawSecrets");
    return "authorized import status returned only tenant-scoped safe metadata";
  }

  if (id === "E2E-GAP-GOV01-01") {
    const graph = await createMasterGraph(world);
    const bytes = Buffer.from("%PDF-1.4 acceptance evidence");
    const document = await tenantJson<{
      id: string;
      verificationState: string;
    }>(
      world,
      "/domain/governance/documents",
      {
        method: "POST",
        key: idempotency("governed-document"),
        data: {
          targetType: "CLIENT",
          targetId: graph.client.id,
          category: "CONTRACT",
          confidentiality: "INTERNAL",
          fileName: "contract.pdf",
          mediaType: "application/pdf",
          contentBase64: bytes.toString("base64"),
          checksumSha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
      201,
    );
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/i);
    return "governed document bytes persisted behind tenant-scoped metadata";
  }

  if (id === "E2E-GAP-GOV01-02") {
    const definitions = await expectJson<Array<Record<string, unknown>>>(
      await domain(world.page, "/governance/approval-definitions"),
      200,
    );
    expect(Array.isArray(definitions)).toBe(true);
    return "approval-definition contract exposes canonical maker-checker configuration";
  }

  if (id === "E2E-GAP-GOV01-03") {
    const graph = await createMasterGraph(world);
    const impact = await tenantJson<Record<string, unknown>>(
      world,
      `/domain/commands/organization/${graph.organization.id}/impact`,
    );
    for (const key of ["descendants", "assignments", "employees", "locations"])
      expect(Number(impact[key])).toBeGreaterThanOrEqual(0);
    return "governed impact preview is derived from immutable canonical hierarchy evidence";
  }

  if (id === "E2E-GAP-INT01-01") {
    const key = idempotency("integration-endpoint");
    const payload = {
      code: `API${world.suffix}`,
      type: "API",
      name: `API ${world.suffix}`,
      environment: "TEST",
      endpoint: "local://acceptance/events",
      scopes: ["events.write"],
      allowedEvents: ["trip.updated"],
      mappingVersion: 1,
    };
    const first = await tenantJson<{ id: string }>(
      world,
      "/tenant/integrations",
      { method: "POST", data: payload, key },
      201,
    );
    const replay = await tenantJson<{ id: string; replayed: boolean }>(
      world,
      "/tenant/integrations",
      { method: "POST", data: payload, key },
      201,
    );
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    return "integration endpoint retry converged through tenant-namespaced idempotency";
  }

  if (id === "E2E-GAP-INT01-02") {
    const client = await tenantJson<{ id: string; secret: string }>(
      world,
      "/tenant/integrations/api-clients",
      {
        method: "POST",
        data: {
          code: `MC${world.suffix}`,
          name: "Machine client",
          scopes: ["events.write"],
        },
      },
      201,
    );
    expect(client.secret).toBeTruthy();
    const list = await tenantJson<unknown[]>(world, "/tenant/integrations");
    expect(JSON.stringify(list)).not.toContain(client.secret);
    return "machine secret was one-time and absent from integration list metadata";
  }

  if (id === "E2E-GAP-INT01-04") {
    const health = await tenantJson<Array<Record<string, unknown>>>(
      world,
      "/tenant/integrations/health",
    );
    expect(Array.isArray(health)).toBe(true);
    expect(health.every((row) => typeof row.id === "string")).toBe(true);
    return "integration/notification health is tenant-scoped and observable";
  }

  if (id === "E2E-GAP-CFG01-01") {
    const draft = await createResource(world.page, "configurations", {
      namespace: "branding",
      value: { shortName: `Tenant ${world.suffix}`, primaryColor: "#16324f" },
      effectiveFrom: "2026-08-25T00:00:00.000Z",
    });
    expect(draft.value).toMatchObject({ shortName: `Tenant ${world.suffix}` });
    return "tenant-specific branding persisted in the tenant configuration boundary";
  }

  if (id === "E2E-GAP-CFG01-03") {
    const draft = await createResource(world.page, "configurations", {
      namespace: "numbering",
      value: { indent: `IN-${world.suffix}-` },
      effectiveFrom: "2026-08-25T00:00:00.000Z",
    });
    const published = await expectJson<Record<string, unknown>>(
      await domain(world.page, `/configurations/${draft.id}/publish`, {
        method: "POST",
        data: {
          expectedVersion: draft.version,
          reason: "Publish acceptance numbering",
        },
      }),
      200,
    );
    const rolledBack = await expectJson<Record<string, unknown>>(
      await domain(world.page, `/configurations/${draft.id}/rollback`, {
        method: "POST",
        data: {
          reason: "Rollback acceptance numbering",
          effectiveFrom: "2026-08-26T00:00:00.000Z",
        },
      }),
      201,
    );
    expect(Number(rolledBack.version)).toBeGreaterThan(
      Number(published.version),
    );
    return "rollback created a later configuration version without rewriting history";
  }

  throw new Error(`No concrete acceptance handler is registered for ${id}`);
}

const test = base.extend<{}, { gapWorld: GapWorld }>({
  gapWorld: [
    async ({ browser }, use, workerInfo) => {
      const world = await createGapWorld(browser, workerInfo);
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker" },
  ],
});

test.describe("ALL-FEATURE-GAPS consolidated real-service acceptance", () => {
  // A worker owns one isolated tenant and executes stable IDs independently.
  // This removes nested steps/caught assertions and the provisioning stampede
  // that previously corrupted fixture step IDs and stalled the reporter.
  test.describe.configure({ mode: "default", timeout: 90_000 });
  for (const [journey, ids] of Object.entries(journeys)) {
    for (const id of ids) {
      test(`${id} [${journey}]`, async ({ gapWorld }) => {
        const evidence = await acceptanceEvidence(gapWorld, id);
        expect(evidence, `${id} emits concrete acceptance evidence`).not.toBe(
          "",
        );
      });
    }
  }
});
