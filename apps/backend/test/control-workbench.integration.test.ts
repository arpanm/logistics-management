import type { SessionActor } from "@logistics/auth";
import { withTenant } from "@logistics/db";
import {
  DEMO_CONTENT_HASH,
  DEMO_DATASET,
  DEMO_DATASET_VERSION,
  seedDemoData,
} from "../../../packages/db/src/demo-seed.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../src/app.service.js";
import { ControlWorkbenchService } from "../src/modules/control/workbench.service.js";

const lenses = [
  "placement",
  "pod",
  "collection",
  "trip",
  "vendor-payable",
] as const;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)(
  "CTL-01 PostgreSQL-backed workbench reconciliation",
  () => {
    const app = new AppService();
    const workbench = new ControlWorkbenchService(app);
    let actor: SessionActor;
    let originalOfferedAllocation:
      | {
          allottedVehicles: number;
          state: string;
          responseAt: Date | null;
          updatedAt: Date;
        }
      | undefined;

    beforeAll(async () => {
      const tenantId = "10000000-0000-4000-8000-000000000100";
      const [existingDemo] = await withTenant(app.db, tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id::text FROM app.tenants WHERE id=$1::uuid`,
          tenantId,
        ),
      );
      if (!existingDemo)
        await seedDemoData(
          {
            ...process.env,
            APP_ENV: "test",
            DEMO_DATA_ENABLED: "true",
            DEMO_ROTATE_PASSWORD: "false",
            DEMO_USER_PASSWORD:
              process.env.DEMO_USER_PASSWORD ?? "DemoControl!234",
            MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
          testDatabaseUrl,
        );
      else {
        const [currentMarker] = await withTenant(app.db, tenantId, (tx) =>
          tx.$queryRawUnsafe<Array<{ present: boolean }>>(
            `SELECT EXISTS(
               SELECT 1 FROM app.demo_bootstrap_runs
               WHERE tenant_id=$1::uuid AND dataset=$2 AND dataset_version=$3 AND content_hash=$4
             ) present`,
            tenantId,
            DEMO_DATASET,
            DEMO_DATASET_VERSION,
            DEMO_CONTENT_HASH,
          ),
        );
        if (!currentMarker?.present)
          throw new Error(
            "The existing DEMO fixture is stale; reconcile it with the protected demo password before running Control integration tests.",
          );
      }
      await withTenant(app.db, tenantId, async (tx) => {
        [originalOfferedAllocation] = await tx.$queryRawUnsafe<
          Array<{
            allottedVehicles: number;
            state: string;
            responseAt: Date | null;
            updatedAt: Date;
          }>
        >(
          `SELECT allotted_vehicles AS "allottedVehicles",state,response_at AS "responseAt",updated_at AS "updatedAt"
             FROM app.allocations
             WHERE tenant_id=$1::uuid AND id='10000000-0000-4000-8000-000000000811'`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.allocations SET allotted_vehicles=1,state='OFFERED',response_at=null,updated_at=now()
             WHERE tenant_id=$1::uuid AND id='10000000-0000-4000-8000-000000000811'`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.allocations(id,tenant_id,indent_id,vendor_id,allotted_vehicles,offered_rate_minor,offer_channel,offered_at,expires_at,state,owner_membership_id,created_by)
           VALUES('10000000-0000-4000-8000-000000000827',$1::uuid,'10000000-0000-4000-8000-000000000801','11000000-0000-4000-8000-000000700004',1,650000,'PORTAL',now()-interval '30 minutes',now()+interval '2 hours','OFFERED','10000000-0000-4000-8000-000000000402','10000000-0000-4000-8000-000000000003')
           ON CONFLICT(tenant_id,id) DO UPDATE SET allotted_vehicles=1,state='OFFERED',response_at=null,updated_at=now()`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.allocations(id,tenant_id,indent_id,vendor_id,allotted_vehicles,offered_rate_minor,offer_channel,offered_at,expires_at,response_at,state,owner_membership_id,created_by)
           VALUES('10000000-0000-4000-8000-000000000826',$1::uuid,'10000000-0000-4000-8000-000000000801','11000000-0000-4000-8000-000000700004',9,650000,'PORTAL',now()-interval '3 hours',now()-interval '1 hour',now()-interval '2 hours','REJECTED','10000000-0000-4000-8000-000000000402','10000000-0000-4000-8000-000000000003')
           ON CONFLICT(tenant_id,id) DO UPDATE SET allotted_vehicles=9,state='REJECTED',response_at=now()-interval '2 hours',updated_at=now()`,
          tenantId,
        );
        // Two assignment rows exercise assignment lifecycle history beside the
        // quantity aggregate. The schema deliberately permits only one current
        // row per allocation, so the fixture contains one historical and one
        // current assignment.
        await tx.$executeRawUnsafe(
          `INSERT INTO app.allocation_assignments(id,tenant_id,allocation_id,vehicle_id,driver_id,assigned_from,assigned_to,assigned_by) VALUES
            ('10000000-0000-4000-8000-000000000829',$1::uuid,'10000000-0000-4000-8000-000000000811','10000000-0000-4000-8000-000000000711','10000000-0000-4000-8000-000000000721',now()-interval '2 hours',now()-interval '1 hour','10000000-0000-4000-8000-000000000003'),
            ('10000000-0000-4000-8000-000000000830',$1::uuid,'10000000-0000-4000-8000-000000000811','10000000-0000-4000-8000-000000000712','10000000-0000-4000-8000-000000000722',now()-interval '1 hour',null,'10000000-0000-4000-8000-000000000003')
           ON CONFLICT(tenant_id,id) DO NOTHING`,
          tenantId,
        );
      });
      const [membership] = await withTenant(app.db, tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ authorizationVersion: number }>>(
          `SELECT authorization_version AS "authorizationVersion"
             FROM app.tenant_memberships
             WHERE tenant_id=$1::uuid AND id='10000000-0000-4000-8000-000000000401'`,
          tenantId,
        ),
      );
      if (!membership) throw new Error("Demo owner membership was not seeded");
      actor = {
        userId: "10000000-0000-4000-8000-000000000002",
        email: "demo.owner@logistics.test",
        platformAdmin: false,
        activeTenantId: tenantId,
        membershipId: "10000000-0000-4000-8000-000000000401",
        contextVersion: 0,
        csrfToken: "integration-test",
        userAuthVersion: 1,
        membershipAuthVersion: membership.authorizationVersion,
        assuranceLevel: "PASSWORD",
      };
    }, 180_000);

    afterAll(async () => {
      const tenantId = "10000000-0000-4000-8000-000000000100";
      await withTenant(app.db, tenantId, async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM app.allocation_assignments
             WHERE tenant_id=$1::uuid AND id IN ('10000000-0000-4000-8000-000000000829','10000000-0000-4000-8000-000000000830')`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM app.allocations
             WHERE tenant_id=$1::uuid AND id IN ('10000000-0000-4000-8000-000000000826','10000000-0000-4000-8000-000000000827')`,
          tenantId,
        );
        if (originalOfferedAllocation)
          await tx.$executeRawUnsafe(
            `UPDATE app.allocations SET allotted_vehicles=$2,state=$3,response_at=$4::timestamptz,updated_at=$5::timestamptz
               WHERE tenant_id=$1::uuid AND id='10000000-0000-4000-8000-000000000811'`,
            tenantId,
            originalOfferedAllocation.allottedVehicles,
            originalOfferedAllocation.state,
            originalOfferedAllocation.responseAt,
            originalOfferedAllocation.updatedAt,
          );
      });
      await app.onModuleDestroy();
    });

    it("CTL-DB-01 executes every lens with bounded stable pagination", async () => {
      const access = await workbench.access(actor);
      expect(access.lenses).toEqual(expect.arrayContaining([...lenses]));
      for (const lens of lenses) {
        const result = await workbench.dashboard(actor, lens, {
          page: 1,
          pageSize: 10,
          sort: "updatedAt",
          direction: "desc",
        });
        expect(result).toMatchObject({ lens });
        expect(result.pagination).toMatchObject({
          page: 1,
          pageSize: 10,
          sort: "updatedAt",
          direction: "desc",
        });
        expect(result.rows.length).toBeLessThanOrEqual(10);
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.pagination.total).toBeGreaterThanOrEqual(
          result.rows.length,
        );
      }
    });

    it("CTL-DB-02 reconciles placement quantities despite assignment fanout", async () => {
      const result = await workbench.dashboard(actor, "placement", {
        page: 1,
        pageSize: 100,
        sort: "reference",
        direction: "asc",
      });
      const expected = await withTenant(app.db, actor.activeTenantId!, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ id: string; allotted: number; placed: number }>
        >(
          `SELECT i.id,
              coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int allotted,
              coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed
            FROM app.indents i
            LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id
            WHERE i.tenant_id=$1::uuid AND i.id=ANY($2::uuid[])
            GROUP BY i.id`,
          actor.activeTenantId,
          result.rows.map((row) => row.id),
        ),
      );
      const byId = new Map(expected.map((row) => [row.id, row]));
      for (const row of result.rows)
        expect(row).toMatchObject({
          allotted: byId.get(String(row.id))?.allotted ?? 0,
          placed: byId.get(String(row.id))?.placed ?? 0,
        });
      const offered = result.rows.find(
        (row) => row.reference === "DEMO-IND-OFFERED",
      );
      expect(offered).toMatchObject({ allotted: 1, placed: 0 });
      const [assignmentFixture] = await withTenant(
        app.db,
        actor.activeTenantId!,
        (tx) =>
          tx.$queryRawUnsafe<Array<{ total: number; current: number }>>(
            `SELECT count(*)::int total,count(*) FILTER(WHERE assigned_to IS NULL)::int current
             FROM app.allocation_assignments
             WHERE tenant_id=$1::uuid AND allocation_id='10000000-0000-4000-8000-000000000811'`,
            actor.activeTenantId,
          ),
      );
      expect(assignmentFixture).toEqual({ total: 2, current: 1 });
    });

    it("CTL-DB-026 returns structured vendor metadata with independent zero-safe totals", async () => {
      const result = await workbench.dashboard(actor, "placement", {
        page: 1,
        pageSize: 100,
        sort: "reference",
        direction: "asc",
      });
      const expected = await withTenant(app.db, actor.activeTenantId!, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            id: string;
            vendor: string;
            allotted: number;
            placed: number;
            ntp: number;
          }>
        >(
          `SELECT v.id,v.legal_name vendor,
              coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int allotted,
              coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed,
              coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state IN ('OFFERED','ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED')),0)::int ntp
            FROM app.indents i
            JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id
            JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
            WHERE i.tenant_id=$1::uuid AND i.state IN ('OPEN','PARTIALLY_ALLOCATED')
              AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)
              AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id)
            GROUP BY v.id,v.legal_name
            ORDER BY ntp DESC,vendor,v.id`,
          actor.activeTenantId,
          actor.membershipId,
          actor.userId,
        ),
      );
      expect(result.vendors).toEqual(expected);
      for (const vendor of result.vendors as Array<Record<string, unknown>>) {
        expect(Object.keys(vendor).sort()).toEqual([
          "allotted",
          "id",
          "ntp",
          "placed",
          "vendor",
        ]);
        expect(vendor.vendor).toEqual(expect.any(String));
        expect(Number(vendor.allotted)).toBeGreaterThanOrEqual(
          Number(vendor.placed),
        );
      }
      expect(result.vendors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "11000000-0000-4000-8000-000000700004",
            allotted: 1,
            placed: 0,
            ntp: 1,
          }),
        ]),
      );
    });

    it("CTL-DB-03 keeps filter, sort, page and CSV export on one predicate", async () => {
      const first = await workbench.dashboard(actor, "trip", {
        page: 1,
        pageSize: 10,
        sort: "reference",
        direction: "asc",
      });
      const reference = String(first.rows[0]?.reference ?? "");
      expect(reference).not.toBe("");
      const filtered = await workbench.dashboard(actor, "trip", {
        search: reference,
        page: 1,
        pageSize: 10,
        sort: "reference",
        direction: "asc",
      });
      const exported = await workbench.exportCsv(actor, "trip", {
        search: reference,
        page: 1,
        pageSize: 10,
        sort: "reference",
        direction: "asc",
      });
      expect(filtered.pagination.total).toBe(exported.rowCount);
      expect(
        filtered.rows.every((row) => String(row.reference).includes(reference)),
      ).toBe(true);
      expect(exported.content).toContain(reference);
    });
  },
);
