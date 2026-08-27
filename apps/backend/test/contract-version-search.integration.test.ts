import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantCreateSchema } from "@logistics/domain";
import { withTenant } from "@logistics/db";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { AppService } from "../src/app.service.js";

const tenantInput = (code: string, ownerEmail: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Limited`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Contract Search Road",
      line2: "",
      postalCode: "700001",
      postalLocalityId: "70000100-0000-4000-8000-000000000001",
      country: "IN",
    },
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    currency: "INR",
    fiscalYearStart: { month: 4, day: 1 },
    legalEntity: { name: `${code} Entity`, code },
    support: { name: "Support", email: `support-${ownerEmail}` },
    owner: { name: `${code} Owner`, email: ownerEmail },
    branding: {
      shortName: code,
      primaryColor: "#16324F",
      accentColor: "#D97706",
    },
    active: true,
  });

type Fixture = {
  tenantId: string;
  sessionToken: string;
  matchingVersionId: string;
  nonMatchingVersionId: string;
  originLocationId: string;
  destinationLocationId: string;
};

describe.sequential("contract-version search and lane prerequisite", () => {
  const service = new AppService();
  let http: INestApplication | undefined;
  let tenantA: Fixture;
  let tenantB: Fixture;

  const provisionFixture = async (
    platform: Awaited<ReturnType<AppService["session"]>>,
    code: string,
    ownerEmail: string,
  ): Promise<Fixture> => {
    const provisioned = await service.provision(
      platform,
      tenantInput(code, ownerEmail),
      `contract-search-${code}`,
      `contract-search-${code}`,
    );
    const accepted = await service.acceptInvitation(
      String(provisioned.invitationUrl).split("token=")[1]!,
      `${code} Owner`,
      "OwnerPassword!234",
      `contract-search-accept-${code}`,
    );
    const tenantId = String(provisioned.tenant.id);
    const rows = await withTenant(service.db, tenantId, async (tx) => {
      const root = (
        await tx.$queryRawUnsafe<
          Array<{ id: string; authorizationScopeNodeId: string }>
        >(
          `SELECT id,authorization_scope_node_id AS "authorizationScopeNodeId"
             FROM app.organization_nodes
            WHERE tenant_id=$1::uuid AND parent_id IS NULL AND node_type='LEGAL_ENTITY'
            ORDER BY active_from,id LIMIT 1`,
          tenantId,
        )
      )[0]!;
      const client = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.clients(
             tenant_id,code,legal_name,billing_entity_id,authorization_scope_node_id
           ) VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid) RETURNING id`,
          tenantId,
          `${code}-CLIENT`,
          `${code} Client`,
          root.id,
          root.authorizationScopeNodeId,
        )
      )[0]!;
      const contract = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.contracts(
             tenant_id,client_id,code,name,state,current_version,effective_from,created_by
           ) VALUES($1::uuid,$2::uuid,$3,$4,'PUBLISHED',1,current_date,$5::uuid)
           RETURNING id`,
          tenantId,
          client.id,
          `${code}-TEST`,
          `${code} Test Contract`,
          accepted.user.id,
        )
      )[0]!;
      const matchingVersion = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.contract_versions(
             tenant_id,contract_id,version,credit_days,pod_mode,snapshot_hash,created_by,published_at
           ) VALUES($1::uuid,$2::uuid,1,30,'DIGITAL',$3,$4::uuid,now()) RETURNING id`,
          tenantId,
          contract.id,
          `${code}-matching-version`,
          accepted.user.id,
        )
      )[0]!;
      const nonMatchingContract = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.contracts(
             tenant_id,client_id,code,name,state,current_version,effective_from,created_by
           ) VALUES($1::uuid,$2::uuid,$3,$4,'DRAFT',1,current_date,$5::uuid)
           RETURNING id`,
          tenantId,
          client.id,
          `${code}-ZZZ`,
          `${code} Unrelated Agreement`,
          accepted.user.id,
        )
      )[0]!;
      const nonMatchingVersion = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.contract_versions(
             tenant_id,contract_id,version,credit_days,pod_mode,snapshot_hash,created_by
           ) VALUES($1::uuid,$2::uuid,1,0,'PHYSICAL',$3,$4::uuid) RETURNING id`,
          tenantId,
          nonMatchingContract.id,
          `${code}-non-matching-version`,
          accepted.user.id,
        )
      )[0]!;
      const locations = await tx.$queryRawUnsafe<
        Array<{ id: string; code: string }>
      >(
        `INSERT INTO app.client_locations(
           tenant_id,client_id,code,name,location_type,organization_node_id,authorization_scope_node_id
         ) VALUES
           ($1::uuid,$2::uuid,$3,$4,'PICKUP',$5::uuid,$6::uuid),
           ($1::uuid,$2::uuid,$7,$8,'DELIVERY',$5::uuid,$6::uuid)
         RETURNING id,code`,
        tenantId,
        client.id,
        `${code}-DEST`,
        `${code} Destination`,
        root.id,
        root.authorizationScopeNodeId,
        `${code}-ORIGIN`,
        `${code} Origin`,
      );
      return {
        matchingVersionId: matchingVersion.id,
        nonMatchingVersionId: nonMatchingVersion.id,
        originLocationId: locations.find(
          (location) => location.code === `${code}-ORIGIN`,
        )!.id,
        destinationLocationId: locations.find(
          (location) => location.code === `${code}-DEST`,
        )!.id,
      };
    });
    return { tenantId, sessionToken: accepted.sessionToken, ...rows };
  };

  beforeAll(async () => {
    const login = await service.login(
      process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
      process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
      undefined,
      "contract-search-platform-login",
    );
    if (!("sessionToken" in login))
      throw new Error("Expected platform session");
    const platform = await service.session(login.sessionToken);
    tenantA = await provisionFixture(
      platform,
      "CVSEARCHA",
      "contract-search-a@test.local",
    );
    tenantB = await provisionFixture(
      platform,
      "CVSEARCHB",
      "contract-search-b@test.local",
    );
    http = await NestFactory.create(AppModule, { logger: false });
    http.setGlobalPrefix("api/v1");
    http.use(cookieParser());
    await http.init();
  });

  afterAll(async () => {
    if (http) await http.close();
    await service.onModuleDestroy();
  });

  it("MST02-CONTRACT-SEARCH-I-001: returns searchable contract versions with the parent contract state", async () => {
    await request(http!.getHttpServer())
      .get("/api/v1/domain/commands/contracts/versions?search=Test")
      .expect(401);

    const response = await request(http!.getHttpServer())
      .get("/api/v1/domain/commands/contracts/versions?search=Test")
      .set("Cookie", `logistics_session=${tenantA.sessionToken}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tenantA.matchingVersionId,
          code: "CVSEARCHA-TEST",
          version: 1,
          state: "PUBLISHED",
        }),
      ]),
    );
    expect(
      response.body.items.some(
        (item: { id: string }) => item.id === tenantA.nonMatchingVersionId,
      ),
    ).toBe(false);
    expect(
      response.body.items.some(
        (item: { id: string }) => item.id === tenantB.matchingVersionId,
      ),
    ).toBe(false);
  });

  it("MST02-CONTRACT-SEARCH-I-002: selected version is a valid lane foreign-key prerequisite", async () => {
    const response = await request(http!.getHttpServer())
      .get("/api/v1/domain/commands/contracts/versions?search=Test")
      .set("Cookie", `logistics_session=${tenantA.sessionToken}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const selected = response.body.items.find(
      (item: { id: string }) => item.id === tenantA.matchingVersionId,
    );
    expect(selected).toBeTruthy();

    const lane = await withTenant(service.db, tenantA.tenantId, async (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; contractVersionId: string }>>(
        `INSERT INTO app.contract_lanes(
           tenant_id,contract_version_id,code,origin_location_id,destination_location_id,truck_type
         ) VALUES($1::uuid,$2::uuid,'SEARCH-LANE',$3::uuid,$4::uuid,'32FT')
         RETURNING id,contract_version_id AS "contractVersionId"`,
        tenantA.tenantId,
        selected.id,
        tenantA.originLocationId,
        tenantA.destinationLocationId,
      ),
    );
    expect(lane[0]).toMatchObject({
      contractVersionId: tenantA.matchingVersionId,
    });
  });

  it("MST02-CONTRACT-SEARCH-I-003: tenant B sees only its own matching version", async () => {
    const response = await request(http!.getHttpServer())
      .get("/api/v1/domain/commands/contracts/versions?search=Test")
      .set("Cookie", `logistics_session=${tenantB.sessionToken}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      response.body.items.map((item: { id: string }) => item.id),
    ).toContain(tenantB.matchingVersionId);
    expect(
      response.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(tenantA.matchingVersionId);
  });
});
