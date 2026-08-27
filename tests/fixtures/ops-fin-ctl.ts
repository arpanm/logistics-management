import {
  expect,
  type APIResponse,
  type Browser,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { api } from "./fnd01";
import {
  createGapWorld,
  createOperationalGraph,
  createResource,
  expectJson,
  type GapWorld,
  type JsonRecord,
  type OperationalGraph,
} from "./all-feature-gaps";
import { actorPage } from "./fnd02";

export type WorkbenchWorld = GapWorld & { graph: OperationalGraph };

export async function createWorkbenchWorld(
  browser: Browser,
  testInfo: TestInfo,
): Promise<WorkbenchWorld> {
  const world = await createGapWorld(browser, testInfo);
  return { ...world, graph: await createOperationalGraph(world) };
}

export async function responseJson<T>(
  response: APIResponse,
  status: number | number[],
): Promise<T> {
  const text = await response.text();
  expect(Array.isArray(status) ? status : [status], text).toContain(
    response.status(),
  );
  return (text ? JSON.parse(text) : {}) as T;
}

export async function workbenchApi<T>(
  page: Page,
  path: string,
  options: { method?: string; data?: unknown; key?: string } = {},
  status: number | number[] = 200,
) {
  const response = await api(page, path, {
    method: options.method,
    data: options.data,
    headers:
      options.method && !/^(GET|HEAD)$/i.test(options.method)
        ? { "Idempotency-Key": options.key ?? crypto.randomUUID() }
        : undefined,
  });
  return responseJson<T>(response, status);
}

export async function currentTrip(page: Page, tripNo: string) {
  const result = await workbenchApi<{ items: JsonRecord[] }>(
    page,
    `/operations/trips?search=${encodeURIComponent(tripNo)}&limit=20`,
  );
  const trip = result.items.find((item) => item.tripNo === tripNo);
  expect(trip, `workbench contains ${tripNo}`).toBeTruthy();
  return trip!;
}

export async function performTripAction(
  page: Page,
  tripNo: string,
  action: "ACCEPT" | "START" | "LOAD" | "TRANSIT" | "UNLOAD" | "END",
  extra: Record<string, unknown> = {},
) {
  const trip = await currentTrip(page, tripNo);
  await workbenchApi(page, `/operations/trips/${trip.id}/action`, {
    method: "POST",
    data: {
      action,
      expectedVersion: Number(trip.version),
      occurredAt: new Date().toISOString(),
      ...extra,
    },
  });
  return currentTrip(page, tripNo);
}

export async function deliverTrip(world: WorkbenchWorld) {
  const tripNo = String(world.graph.trip.trip_no ?? world.graph.trip.tripNo);
  await performTripAction(world.page, tripNo, "START", { odometerKm: 100 });
  await performTripAction(world.page, tripNo, "LOAD", {
    loadQuantityMilli: 1000,
    sealNumber: `SEAL-${world.suffix}`,
  });
  await performTripAction(world.page, tripNo, "TRANSIT", {
    odometerKm: 150,
  });
  await performTripAction(world.page, tripNo, "UNLOAD", { odometerKm: 200 });
  return performTripAction(world.page, tripNo, "END", {
    odometerKm: 205,
    receiverName: "Acceptance Receiver",
  });
}

/**
 * Establishes deterministic finance preconditions in the real PostgreSQL test
 * schema. The browser/API behavior remains entirely unmocked; direct SQL is
 * limited to fixture state that otherwise depends on asynchronous document
 * scanning and multi-stage POD approval workers.
 */
export async function makeDeliveredServiceInvoiceEligible(
  world: WorkbenchWorld,
) {
  await deliverTrip(world);
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.tenant_id',$1,true)",
        world.fixture.tenantA.id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE app.pod_tasks SET state='ACCEPTED',received_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1::uuid AND trip_id=$2::uuid",
        world.fixture.tenantA.id,
        world.graph.trip.id,
      );
      await tx.$executeRawUnsafe(
        "INSERT INTO app.client_rate_lines(tenant_id,lane_id,charge_code,basis,amount_minor,tax_basis_points,effective_from,priority,state) SELECT $1::uuid,$2::uuid,'LINE_HAUL','PER_TRIP',300003,1800,now()-interval '1 day',100,'PUBLISHED' WHERE NOT EXISTS(SELECT 1 FROM app.client_rate_lines WHERE tenant_id=$1::uuid AND lane_id=$2::uuid AND charge_code='LINE_HAUL' AND state='PUBLISHED')",
        world.fixture.tenantA.id,
        world.graph.lane.id,
      );
    });
  } finally {
    await db.$disconnect();
  }
  const pods = await workbenchApi<{ items: JsonRecord[] }>(
    world.page,
    "/domain/pod-tasks",
  );
  const pod = pods.items.find((item) => item.trip_id === world.graph.trip.id);
  expect(pod).toMatchObject({ state: "ACCEPTED" });
  return pod!;
}

export async function createDraftInvoice(
  world: WorkbenchWorld,
  invoiceNo = `INV-${world.suffix}`,
) {
  return createResource(world.page, "invoices", {
    invoiceNo,
    clientId: world.graph.client.id,
    clientLocationId: world.graph.origin.id,
    invoiceDate: "2026-08-27",
    currency: "INR",
    creditDays: 30,
    lines: [
      {
        tripId: world.graph.trip.id,
        chargeCode: "LINE_HAUL",
        quantityMilli: "1000",
        rateMinor: "300003",
        taxBasisPoints: 1800,
      },
    ],
  });
}

export async function grantFinanceAtRoot(
  world: WorkbenchWorld,
  actor: "regional" | "multiRole",
) {
  const membership = world.fixture.actors[actor];
  const detail = await workbenchApi<{ version: number }>(
    world.page,
    `/tenant/access/users/${membership.membershipId}`,
  );
  const assignments = [
    {
      roleId: world.fixture.roles.FINANCE_EXECUTIVE,
      grants: [
        {
          scopeNodeId: world.fixture.scopes.root,
          actions: ["READ", "CREATE", "UPDATE", "APPROVE", "EXPORT", "ADMIN"],
        },
      ],
    },
  ];
  const preview = await workbenchApi<{ fingerprint: string }>(
    world.page,
    `/tenant/access/users/${membership.membershipId}/preview`,
    { method: "POST", data: { expectedVersion: detail.version, assignments } },
  );
  await workbenchApi(
    world.page,
    `/tenant/access/users/${membership.membershipId}`,
    {
      method: "PATCH",
      data: {
        expectedVersion: detail.version,
        assignments,
        reason: "Deterministic finance workbench acceptance scope",
        previewFingerprint: preview.fingerprint,
      },
    },
  );
}

export async function openActorSession(
  browser: Browser,
  world: WorkbenchWorld,
  actor: "regional" | "multiRole" | "auditor" | "client" | "vendor",
) {
  return actorPage(browser, world.fixture.actors[actor]);
}

export async function seedSecondEligibleAsset(world: WorkbenchWorld) {
  const vehicle = await createResource(world.page, "vehicles", {
    vendorId: world.graph.vendor.id,
    registrationNumber: `KA${world.suffix}`.slice(0, 14),
    vehicleType: "32FT",
    capacityMilli: 100000,
    gpsDeviceId: `GPS2-${world.suffix}`,
  });
  const driver = await createResource(world.page, "drivers", {
    vendorId: world.graph.vendor.id,
    code: `D2${world.suffix}`,
    displayName: `Second Driver ${world.suffix}`,
    mobile: `+918${world.suffix.replace(/\D/g, "").padEnd(9, "8").slice(0, 9)}`,
    licenceNumber: `DL2${world.suffix}`,
    licenceClass: "HMV",
    licenceValidTo: "2030-12-31",
  });
  for (const [subjectType, subjectId] of [
    ["VEHICLE", vehicle.id],
    ["DRIVER", driver.id],
  ] as const) {
    const compliance = await expectJson<JsonRecord>(
      await api(world.page, "/domain/commands/compliance", {
        method: "POST",
        data: {
          subjectType,
          subjectId,
          requirementCode: `${subjectType}_ACTIVE_SECOND`,
          validFrom: "2026-01-01",
          validTo: "2030-12-31",
        },
      }),
      201,
    );
    await expectJson(
      await api(
        world.page,
        `/domain/commands/compliance/${compliance.id}/decision`,
        {
          method: "POST",
          data: {
            decision: "VERIFIED",
            reason: "Verified for workbench allocation acceptance",
          },
        },
      ),
      200,
    );
  }
  return { vehicle, driver };
}
