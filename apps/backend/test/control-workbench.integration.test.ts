import type { SessionActor } from "@logistics/auth";
import { withTenant } from "@logistics/db";
import { seedDemoData } from "../../../packages/db/src/demo-seed.js";
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
  "CTL-01 PostgreSQL-backed workbench reconciliation (Implemented / Not Run)",
  () => {
    const app = new AppService();
    const workbench = new ControlWorkbenchService(app);
    let actor: SessionActor;

    beforeAll(async () => {
      await seedDemoData(
        {
          ...process.env,
          APP_ENV: "test",
          DEMO_DATA_ENABLED: "true",
          DEMO_ROTATE_PASSWORD: "false",
          DEMO_USER_PASSWORD: "DemoControl!234",
          MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        testDatabaseUrl,
      );
      const tenantId = "10000000-0000-4000-8000-000000000100";
      await withTenant(app.db, tenantId, async (tx) => {
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

    afterAll(async () => app.onModuleDestroy());

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
