import {
  expect,
  type Browser,
  type Page,
  type WorkerInfo,
} from "@playwright/test";
import { api } from "./fnd01";
import { actorPage, type ActorFixture, type Fnd02Fixture } from "./fnd02";
import { login as loginPlatform } from "./fnd01";

export type JsonRecord = Record<string, unknown>;

export type GapWorld = {
  fixture: Fnd02Fixture;
  owner: ActorFixture;
  platformPage: Page;
  page: Page;
  close: () => Promise<void>;
  suffix: string;
};

export async function createGapWorld(
  browser: Browser,
  workerInfo: WorkerInfo,
): Promise<GapWorld> {
  const platformContext = await browser.newContext();
  const platformPage = await platformContext.newPage();
  await loginPlatform(platformPage);
  const namespace =
    `G${workerInfo.workerIndex}-${crypto.randomUUID().slice(0, 7)}`
      .replace(/[^A-Z0-9-]/gi, "-")
      .toUpperCase()
      .slice(0, 12);
  const seed = await api(platformPage, "/test/fnd02/fixtures", {
    method: "POST",
    headers: {
      "Idempotency-Key": `gap-fixture-${namespace}`,
      Origin: "http://127.0.0.1:3000",
    },
    data: { namespace, scenario: "ACCESS_MATRIX" },
  });
  const seeded = await expectJson<Omit<Fnd02Fixture, "namespace">>(seed, 201);
  const fixture: Fnd02Fixture = { ...seeded, namespace };
  expect(fixture.scenario).toBe("ACCESS_MATRIX");
  const session = await actorPage(browser, fixture.actors.owner);
  return {
    fixture,
    owner: fixture.actors.owner,
    platformPage,
    page: session.page,
    close: async () => {
      await session.context.close();
      await platformContext.close();
    },
    suffix: namespace.replaceAll("-", "").slice(-7),
  };
}

export function idempotency(label: string) {
  return `gap-${label}-${crypto.randomUUID()}`;
}

export async function domain(
  page: Page,
  path: string,
  options: {
    method?: string;
    data?: unknown;
    key?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.method && !/^(GET|HEAD)$/i.test(options.method))
    headers["Idempotency-Key"] = options.key ?? idempotency(path);
  return api(page, `/domain${path}`, {
    method: options.method,
    data: options.data,
    headers,
  });
}

export async function expectJson<T = JsonRecord>(
  response: Awaited<ReturnType<typeof api>>,
  status: number | number[],
): Promise<T> {
  const text = await response.text();
  expect(
    Array.isArray(status) ? status : [status],
    `HTTP ${response.status()}: ${text}`,
  ).toContain(response.status());
  return (text ? JSON.parse(text) : {}) as T;
}

export async function createResource<T extends JsonRecord = JsonRecord>(
  page: Page,
  resource: string,
  data: unknown,
  key = idempotency(resource),
) {
  return expectJson<T>(
    await domain(page, `/${resource}`, { method: "POST", data, key }),
    201,
  );
}

export async function listResource(page: Page, resource: string) {
  return expectJson<{ items: JsonRecord[]; total: number }>(
    await domain(page, `/${resource}`),
    200,
  );
}

export async function reportResource(page: Page, resource: string) {
  return expectJson<{
    total: number;
    rows: Array<{ state: string; count: number }>;
  }>(await domain(page, `/${resource}/report`), 200);
}

export async function createOrganizationPair(world: GapWorld) {
  const root = await createResource(world.page, "organization-nodes", {
    code: `R${world.suffix}`,
    name: `Gap Region ${world.suffix}`,
    nodeType: "REGION",
    timezone: "Asia/Kolkata",
    postalCodes: ["700001"],
    geofence: {},
    activeFrom: "2026-01-01",
  });
  const child = await createResource(world.page, "organization-nodes", {
    code: `B${world.suffix}`,
    name: `Gap Branch ${world.suffix}`,
    nodeType: "BRANCH",
    parentId: root.id,
    timezone: "Asia/Kolkata",
    postalCodes: ["700002"],
    geofence: {},
    activeFrom: "2026-01-01",
  });
  return { root, child };
}

export type MasterGraph = {
  organization: JsonRecord;
  branch: JsonRecord;
  employee: JsonRecord;
  client: JsonRecord;
  origin: JsonRecord;
  destination: JsonRecord;
  contract: JsonRecord;
  vendor: JsonRecord;
};

export type CommercialGraph = MasterGraph & {
  contractVersion: JsonRecord;
  lane: JsonRecord;
};
export type OperationalGraph = CommercialGraph & {
  indent: JsonRecord;
  allocation: JsonRecord;
  vehicle: JsonRecord;
  driver: JsonRecord;
  trip: JsonRecord;
};

const masterGraphs = new WeakMap<GapWorld, Promise<MasterGraph>>();

export function createMasterGraph(world: GapWorld): Promise<MasterGraph> {
  const existing = masterGraphs.get(world);
  if (existing) return existing;
  const created = (async () => {
    const organization = await createResource(
      world.page,
      "organization-nodes",
      {
        code: `LE${world.suffix}`,
        name: `Legal Entity ${world.suffix}`,
        nodeType: "LEGAL_ENTITY",
        authorizationScopeNodeId: world.fixture.scopes.root,
        timezone: "Asia/Kolkata",
        postalCodes: ["700001"],
        geofence: {},
        activeFrom: "2026-01-01",
      },
    );
    const branch = await createResource(world.page, "organization-nodes", {
      code: `BR${world.suffix}`,
      name: `Branch ${world.suffix}`,
      nodeType: "BRANCH",
      parentId: organization.id,
      timezone: "Asia/Kolkata",
      postalCodes: ["700002"],
      geofence: {},
      activeFrom: "2026-01-01",
    });
    const employee = await createResource(world.page, "employees", {
      employeeCode: `EM${world.suffix}`,
      displayName: `Manager ${world.suffix}`,
      email: `manager-${world.suffix.toLowerCase()}@test.local`,
      homeNodeId: branch.id,
      linkedMembershipId: world.owner.membershipId,
      activeFrom: "2026-01-01",
    });
    const client = await createResource(world.page, "clients", {
      code: `CL${world.suffix}`,
      legalName: `Client ${world.suffix} Limited`,
      industry: "Logistics",
      billingEntityId: organization.id,
      accountManagerEmployeeId: employee.id,
      authorizationScopeNodeId: world.fixture.scopes.alpha,
      taxIdentifier: `GST${world.suffix}`,
      escalationEmail: `client-${world.suffix.toLowerCase()}@test.local`,
      creditDays: 30,
      podMode: "DIGITAL",
    });
    const location = async (code: string, name: string, postal: string) =>
      createResource(world.page, "client-locations", {
        clientId: client.id,
        code: `${code}${world.suffix}`,
        name: `${name} ${world.suffix}`,
        locationType: "WAREHOUSE",
        organizationNodeId: branch.id,
        managerEmployeeId: employee.id,
        authorizationScopeNodeId: world.fixture.scopes.alpha,
        geofence: { postal },
      });
    const origin = await location("OR", "Origin", "700002");
    const destination = await location("DS", "Destination", "700003");
    const contract = await createResource(world.page, "contracts", {
      clientId: client.id,
      code: `CT${world.suffix}`,
      name: `Contract ${world.suffix}`,
      effectiveFrom: "2026-01-01",
      creditDays: 30,
      podMode: "DIGITAL",
      documentRequirements: ["SIGNED_POD"],
      terms: { currency: "INR" },
    });
    const vendor = await createResource(world.page, "vendors", {
      code: `VN${world.suffix}`,
      legalName: `Vendor ${world.suffix} Limited`,
      pan: `PAN${world.suffix}`,
      gstin: `GST${world.suffix}`,
      tdsBasisPoints: 100,
      paymentTermsDays: 15,
      authorizationScopeNodeId: world.fixture.scopes.vendor,
    });
    return {
      organization,
      branch,
      employee,
      client,
      origin,
      destination,
      contract,
      vendor,
    };
  })();
  masterGraphs.set(world, created);
  return created;
}

const commercialGraphs = new WeakMap<GapWorld, Promise<CommercialGraph>>();

export function createCommercialGraph(
  world: GapWorld,
): Promise<CommercialGraph> {
  const existing = commercialGraphs.get(world);
  if (existing) return existing;
  const created = (async () => {
    const graph = await createMasterGraph(world);
    const contractVersion = await expectJson<JsonRecord>(
      await domain(
        world.page,
        `/commands/contracts/${graph.contract.id}/versions`,
        {
          method: "POST",
          data: {
            expectedVersion: graph.contract.version,
            creditDays: 30,
            podMode: "DIGITAL",
            documentRequirements: ["SIGNED_POD"],
            terms: { currency: "INR" },
            reason: "Create deterministic acceptance version",
          },
        },
      ),
      201,
    );
    const lane = await createResource(world.page, "lanes", {
      contractVersionId: contractVersion.id,
      code: `LN${world.suffix}`,
      originLocationId: graph.origin.id,
      destinationLocationId: graph.destination.id,
      truckType: "32FT",
      cargoType: "GENERAL",
      quantityMinMilli: 1000,
      quantityMaxMilli: 100000,
      priority: 10,
      placementMinutes: 1440,
      transitMinutes: 2880,
      podMinutes: 10080,
      rateMinor: 125000,
      taxBasisPoints: 1800,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    return { ...graph, contractVersion, lane };
  })();
  commercialGraphs.set(world, created);
  return created;
}

const operationalGraphs = new WeakMap<GapWorld, Promise<OperationalGraph>>();

export function createOperationalGraph(
  world: GapWorld,
): Promise<OperationalGraph> {
  const existing = operationalGraphs.get(world);
  if (existing) return existing;
  const created = (async () => {
    const graph = await createCommercialGraph(world);
    let contract = await expectJson<JsonRecord>(
      await domain(world.page, `/contracts/${graph.contract.id}`),
      200,
    );
    for (const toState of ["PENDING_APPROVAL", "APPROVED", "PUBLISHED"]) {
      contract = await expectJson<JsonRecord>(
        await domain(world.page, `/contracts/${graph.contract.id}/transition`, {
          method: "POST",
          data: {
            expectedVersion: contract.version,
            toState,
            reason: "Deterministic acceptance publication",
          },
        }),
        200,
      );
    }
    let indent = await createResource(world.page, "indents", {
      indentNo: `IN${world.suffix}`,
      clientId: graph.client.id,
      clientLocationId: graph.origin.id,
      laneId: graph.lane.id,
      requestedVehicles: 2,
      quantityMilli: 2000,
      pickupWindowStart: "2026-08-26T06:00:00.000Z",
      pickupWindowEnd: "2026-08-26T10:00:00.000Z",
      ownerMembershipId: world.owner.membershipId,
      source: "MANUAL",
      sourceReference: `UI-${world.suffix}`,
      cargoType: "GENERAL",
      bodyType: "32FT",
    });
    indent = await expectJson<JsonRecord>(
      await domain(world.page, `/indents/${indent.id}/transition`, {
        method: "POST",
        data: {
          expectedVersion: indent.version,
          toState: "OPEN",
          reason: "Open deterministic acceptance indent",
        },
      }),
      200,
    );
    const vendor = await expectJson<JsonRecord>(
      await domain(world.page, `/vendors/${graph.vendor.id}/transition`, {
        method: "POST",
        data: {
          expectedVersion: graph.vendor.version,
          toState: "ACTIVE",
          reason: "Activate acceptance vendor",
        },
      }),
      200,
    );
    const vehicle = await createResource(world.page, "vehicles", {
      vendorId: vendor.id,
      registrationNumber: `WB${world.suffix}`.slice(0, 14),
      vehicleType: "32FT",
      capacityMilli: 100000,
      gpsDeviceId: `GPS-${world.suffix}`,
    });
    const driver = await createResource(world.page, "drivers", {
      vendorId: vendor.id,
      code: `DR${world.suffix}`,
      displayName: `Driver ${world.suffix}`,
      mobile: `+919${world.suffix.replace(/\D/g, "").padEnd(9, "7").slice(0, 9)}`,
      licenceNumber: `DL${world.suffix}`,
      licenceClass: "HMV",
      licenceValidTo: "2030-12-31",
    });
    for (const [subjectType, subjectId] of [
      ["VEHICLE", vehicle.id],
      ["DRIVER", driver.id],
    ] as const) {
      const compliance = await expectJson<JsonRecord>(
        await domain(world.page, "/commands/compliance", {
          method: "POST",
          data: {
            subjectType,
            subjectId,
            requirementCode: `${subjectType}_ACTIVE`,
            validFrom: "2026-01-01",
            validTo: "2030-12-31",
          },
        }),
        201,
      );
      await expectJson(
        await domain(
          world.page,
          `/commands/compliance/${compliance.id}/decision`,
          {
            method: "POST",
            data: {
              decision: "VERIFIED",
              reason: "Verified for acceptance trip",
            },
          },
        ),
        200,
      );
    }
    const allocation = await createResource(world.page, "allocations", {
      indentId: indent.id,
      vendorId: vendor.id,
      allottedVehicles: 1,
      offeredRateMinor: "120000",
      offerChannel: "PORTAL",
      offeredAt: "2026-08-25T01:00:00.000Z",
      expiresAt: "2026-08-27T01:00:00.000Z",
      ownerMembershipId: world.owner.membershipId,
    });
    const accepted = await expectJson<JsonRecord>(
      await domain(
        world.page,
        `/commands/allocations/${allocation.id}/respond`,
        {
          method: "POST",
          data: {
            decision: "ACCEPTED",
            expectedVersion: allocation.version,
            reason: "Accept deterministic allocation",
          },
        },
      ),
      200,
    );
    await expectJson(
      await domain(world.page, `/allocations/${allocation.id}/assign`, {
        method: "POST",
        data: { vehicleId: vehicle.id, driverId: driver.id },
      }),
      201,
    );
    const trip = await expectJson<JsonRecord>(
      await domain(world.page, "/trips/create", {
        method: "POST",
        data: {
          allocationId: allocation.id,
          tripNo: `TR${world.suffix}`,
          lrNo: `LR${world.suffix}`,
          plannedPickupAt: "2026-08-26T06:00:00.000Z",
          plannedDeliveryAt: "2026-08-27T06:00:00.000Z",
          trackingConsentFrom: "2026-08-25T00:00:00.000Z",
          trackingConsentTo: "2026-08-28T00:00:00.000Z",
        },
      }),
      201,
    );
    return {
      ...graph,
      contract,
      vendor,
      indent,
      allocation: accepted,
      vehicle,
      driver,
      trip,
    };
  })();
  operationalGraphs.set(world, created);
  return created;
}
