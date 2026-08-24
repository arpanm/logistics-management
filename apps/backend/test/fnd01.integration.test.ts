import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, AppService } from "../src/app.service.js";
import { tenantCreateSchema } from "@logistics/domain";
import { withPlatform, withTenant } from "@logistics/db";

const input = (code: string, email: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Limited`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Main Road",
      line2: "",
      city: "Kolkata",
      region: "West Bengal",
      postalCode: "700001",
      country: "IN",
    },
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    currency: "INR",
    fiscalYearStart: { month: 4, day: 1 },
    legalEntity: { name: `${code} Entity`, code },
    support: { name: "Support Desk", email: `support-${email}` },
    owner: { name: "Owner", email },
    branding: {
      shortName: code,
      primaryColor: "#16324F",
      accentColor: "#D97706",
    },
    active: true,
  });

describe.sequential(
  "FND-01 integration, authorization, migration and reconciliation",
  () => {
    const service = new AppService();
    let admin: Awaited<ReturnType<AppService["session"]>>;
    let tenantA = "";
    let tenantB = "";
    let inviteA = "";
    beforeAll(async () => {
      const login = await service.login(
        process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
        process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        undefined,
        "test-login",
      );
      admin = await service.session(login.sessionToken);
    });
    afterAll(async () => service.onModuleDestroy());

    it("FND01-M-001: migration is re-runnable and required schemas exist", async () => {
      const rows = await service.db.$queryRawUnsafe<
        Array<{ schema_name: string }>
      >(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('app','audit','reporting') ORDER BY schema_name`,
      );
      expect(rows.map((r) => r.schema_name)).toEqual([
        "app",
        "audit",
        "reporting",
      ]);
      const sentinel = await service.db.$queryRawUnsafe<
        Array<{ count: number }>
      >(`SELECT count(*)::int count FROM fnd01_unrelated_sentinel.keep_me`);
      expect(sentinel[0]?.count).toBe(1);
      const migrations = await service.db.$queryRawUnsafe<
        Array<{ migration_name: string }>
      >(
        `SELECT migration_name FROM app._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`,
      );
      expect(migrations.map((row) => row.migration_name)).toEqual([
        "202608240001_fnd01_foundation",
        "202608240002_fnd01_security_hardening",
      ]);
      await expect(service.ready()).resolves.toMatchObject({
        status: "ready",
        migration: "ready",
        migrationCount: 2,
      });
    });

    it("FND01-A-006: every live tenant table has forced RLS, a policy, tenant-leading index and declared nullability", async () => {
      const expected: Record<string, boolean> = {
        "app.idempotency_records": true,
        "app.job_runs": true,
        "app.legal_entities": false,
        "app.outbox_events": true,
        "app.owner_invitations": false,
        "app.platform_alerts": true,
        "app.setup_checklist_items": false,
        "app.stored_documents": false,
        "app.tenant_configuration": false,
        "app.tenant_memberships": false,
        "app.tenant_probe_records": false,
        "audit.audit_events": true,
        "reporting.tenant_activity_projection": false,
      };
      const rows = await service.db.$queryRawUnsafe<
        Array<{
          table_key: string;
          nullable: boolean;
          rls: boolean;
          forced: boolean;
          policy_count: number;
          tenant_index: boolean;
        }>
      >(`
        SELECT n.nspname||'.'||c.relname table_key,NOT a.attnotnull nullable,
          c.relrowsecurity rls,c.relforcerowsecurity forced,
          (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) policy_count,
          EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid=c.oid AND (i.indkey::smallint[])[0]=a.attnum
          ) tenant_index
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
        WHERE n.nspname IN ('app','audit','reporting') AND c.relkind='r'
        ORDER BY table_key`);
      expect(rows.map((row) => row.table_key)).toEqual(Object.keys(expected));
      for (const row of rows) {
        expect(row.nullable, `${row.table_key} nullability`).toBe(
          expected[row.table_key],
        );
        expect(row.rls, `${row.table_key} RLS`).toBe(true);
        expect(row.forced, `${row.table_key} FORCE RLS`).toBe(true);
        expect(row.policy_count, `${row.table_key} policy`).toBeGreaterThan(0);
        expect(row.tenant_index, `${row.table_key} tenant-leading index`).toBe(
          true,
        );
      }
    });

    it("FND01-I-001/FND01-I-002: provisions atomic defaults and exactly one expiring invitation with safe replay", async () => {
      const a = await service.provision(
        admin,
        input("TENANT-A", "owner-a@test.local"),
        "test-key-tenant-a",
        "provision-a",
      );
      tenantA = String(a.tenant.id);
      inviteA = String(a.invitationUrl).split("token=")[1]!;
      const replay = await service.provision(
        admin,
        input("TENANT-A", "owner-a@test.local"),
        "test-key-tenant-a",
        "provision-a-replay",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.invitationUrl).toBeUndefined();
      await expect(
        service.provision(
          admin,
          input("TENANT-A-CHANGED", "changed@test.local"),
          "test-key-tenant-a",
          "provision-a-mismatch",
        ),
      ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      const facts = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            invites: number;
            configs: number;
            checklist: number;
            entities: number;
            events: number;
          }>
        >(
          `SELECT (SELECT count(*) FROM app.owner_invitations WHERE tenant_id=$1::uuid)::int invites,(SELECT count(*) FROM app.tenant_configuration WHERE tenant_id=$1::uuid)::int configs,(SELECT count(*) FROM app.setup_checklist_items WHERE tenant_id=$1::uuid)::int checklist,(SELECT count(*) FROM app.legal_entities WHERE tenant_id=$1::uuid)::int entities,(SELECT count(*) FROM app.outbox_events WHERE tenant_id=$1::uuid)::int events`,
          tenantA,
        ),
      );
      expect(facts[0]).toMatchObject({
        invites: 1,
        configs: 5,
        checklist: 8,
        entities: 1,
        events: 1,
      });
    });

    it("FND01-I-003: injected provisioning failure rolls back and reconciles one safe alert", async () => {
      await expect(
        service.provision(
          admin,
          input("TENANT-C", "owner-c@test.local"),
          "test-key-failure",
          "failure",
          true,
        ),
      ).rejects.toMatchObject({ code: "PROVISIONING_FAILED" });
      const facts = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenants: number; alerts: number }>>(
          `SELECT (SELECT count(*) FROM app.tenants WHERE code='TENANT-C')::int tenants,(SELECT count(*) FROM app.platform_alerts WHERE type='TENANT_PROVISIONING_FAILED')::int alerts`,
        ),
      );
      expect(facts[0]).toEqual({ tenants: 0, alerts: 1 });
    });

    it("FND01-C-002: invitation is one-time and creates tenant session", async () => {
      const accepted = await service.acceptInvitation(
        inviteA,
        "Tenant A Owner",
        "LongPassword1!",
        "accept-a",
      );
      expect(accepted.activeTenantId).toBe(tenantA);
      await expect(
        service.acceptInvitation(
          inviteA,
          "Tenant A Owner",
          "LongPassword1!",
          "replay-a",
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("FND01-A-001/A-002/A-005: database and service boundaries deny cross-tenant record, document, report and export access", async () => {
      const competingCreates = await Promise.allSettled([
        service.provision(
          admin,
          input("TENANT-B", "owner-b@test.local"),
          "test-key-tenant-b-one",
          "provision-b-one",
        ),
        service.provision(
          admin,
          input("TENANT-B", "owner-b-alternate@test.local"),
          "test-key-tenant-b-two",
          "provision-b-two",
        ),
      ]);
      const winner = competingCreates.find(
        (result) => result.status === "fulfilled",
      );
      const duplicate = competingCreates.find(
        (result) => result.status === "rejected",
      );
      expect(
        competingCreates.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(duplicate).toMatchObject({
        status: "rejected",
        reason: {
          status: 409,
          code: "TENANT_CODE_EXISTS",
          message: "Tenant code is already in use",
        },
      });
      if (!winner || winner.status !== "fulfilled")
        throw new Error(
          "Expected exactly one concurrent tenant creation winner",
        );
      const b = winner.value;
      tenantB = String(b.tenant.id);
      const duplicateFacts = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenants: number; invitations: number }>>(
          `SELECT (SELECT count(*) FROM app.tenants WHERE code='TENANT-B')::int tenants,(SELECT count(*) FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id WHERE t.code='TENANT-B')::int invitations`,
        ),
      );
      expect(duplicateFacts[0]).toEqual({ tenants: 1, invitations: 1 });
      const acceptedA = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        undefined,
        "owner-login",
      );
      const actorA = await service.session(acceptedA.sessionToken);
      const probeB = await withTenant(
        service.db,
        tenantB,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.tenant_probe_records(tenant_id,label,note) VALUES($1::uuid,'B secret','B only') RETURNING id`,
              tenantB,
            )
          )[0]!,
      );
      await expect(service.getProbe(actorA, probeB.id)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
      expect((await service.listProbes(actorA)).items).toHaveLength(0);
      expect(await service.exportProbes(actorA)).toHaveLength(0);
      const catalog = await service.db.$queryRawUnsafe<
        Array<{ table_name: string; is_nullable: string }>
      >(
        `SELECT table_name,is_nullable FROM information_schema.columns WHERE table_schema IN ('app','reporting') AND column_name='tenant_id' ORDER BY table_name`,
      );
      expect(catalog.length).toBeGreaterThanOrEqual(11);
      expect(
        catalog
          .filter((c) =>
            [
              "legal_entities",
              "tenant_memberships",
              "owner_invitations",
              "tenant_configuration",
              "setup_checklist_items",
              "tenant_probe_records",
              "stored_documents",
              "tenant_activity_projection",
            ].includes(c.table_name),
          )
          .every((c) => c.is_nullable === "NO"),
      ).toBe(true);
    });

    it("FND01-R-001: platform report reconciles canonical tenants without probe payload", async () => {
      const report = await service.platformReport(admin);
      expect(report.totals).toMatchObject({ total: 2, active: 2, inactive: 0 });
      expect(JSON.stringify(report)).not.toContain("B secret");
      expect(report.tenants).toHaveLength(2);
    });

    it("FND01-A-007: mixed platform/tenant operational tables isolate A from B and platform rows", async () => {
      const nonce = Date.now().toString();
      const ids = await withPlatform(service.db, async (tx) => {
        const result: Record<string, string[]> = {};
        const triples: Array<[string, string]> = [
          [tenantA, "a"],
          [tenantB, "b"],
          ["", "platform"],
        ];
        result.idempotency_records = [];
        result.outbox_events = [];
        result.job_runs = [];
        result.platform_alerts = [];
        result["audit.audit_events"] = [];
        for (const [tenantId, label] of triples) {
          const tenant = tenantId || null;
          const scope = tenant ? "TENANT" : "PLATFORM";
          result.idempotency_records.push(
            String(
              (
                await tx.$queryRawUnsafe<Array<{ id: string }>>(
                  `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,response_json) VALUES($1,$2::uuid,$3::uuid,$4,$5,'request','{}') RETURNING id`,
                  scope,
                  tenant,
                  admin.userId,
                  `rls-${label}-${nonce}`,
                  `key-${label}-${nonce}`,
                )
              )[0]!.id,
            ),
          );
          result.outbox_events.push(
            String(
              (
                await tx.$queryRawUnsafe<Array<{ id: string }>>(
                  `INSERT INTO app.outbox_events(scope,tenant_id,aggregate_type,event_type,payload,deduplication_key,state,processed_at) VALUES($1,$2::uuid,'rls','rls.test.v1','{}',$3,'PROCESSED',now()) RETURNING id`,
                  scope,
                  tenant,
                  `event-${label}-${nonce}`,
                )
              )[0]!.id,
            ),
          );
          result.job_runs.push(
            String(
              (
                await tx.$queryRawUnsafe<Array<{ id: string }>>(
                  `INSERT INTO app.job_runs(scope,tenant_id,job_type,job_key,state) VALUES($1,$2::uuid,'rls-test',$3,'COMPLETE') RETURNING id`,
                  scope,
                  tenant,
                  `job-${label}-${nonce}`,
                )
              )[0]!.id,
            ),
          );
          result.platform_alerts.push(
            String(
              (
                await tx.$queryRawUnsafe<Array<{ id: string }>>(
                  `INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary) VALUES($1::uuid,'RLS_TEST','INFO',$2,'RLS test') RETURNING id`,
                  tenant,
                  `alert-${label}-${nonce}`,
                )
              )[0]!.id,
            ),
          );
          result["audit.audit_events"].push(
            String(
              (
                await tx.$queryRawUnsafe<Array<{ id: string }>>(
                  `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id) VALUES($1::uuid,$2::uuid,'rls.test','test',$3) RETURNING id`,
                  tenant,
                  admin.userId,
                  `audit-${label}-${nonce}`,
                )
              )[0]!.id,
            ),
          );
        }
        return result;
      });
      for (const [table, rowIds] of Object.entries(ids)) {
        const qualified = table.includes(".") ? table : `app.${table}`;
        const visibleA = await withTenant(service.db, tenantA, (tx) =>
          tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${qualified} WHERE id=ANY($1::uuid[]) ORDER BY id`,
            rowIds,
          ),
        );
        expect(
          visibleA.map((row) => row.id),
          `${table} tenant A visibility`,
        ).toEqual([rowIds[0]]);
        const visibleB = await withTenant(service.db, tenantB, (tx) =>
          tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${qualified} WHERE id=ANY($1::uuid[]) ORDER BY id`,
            rowIds,
          ),
        );
        expect(
          visibleB.map((row) => row.id),
          `${table} tenant B visibility`,
        ).toEqual([rowIds[1]]);
        const visiblePlatform = await withPlatform(service.db, (tx) =>
          tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${qualified} WHERE id=ANY($1::uuid[])`,
            rowIds,
          ),
        );
        expect(visiblePlatform).toHaveLength(3);
      }
    });

    it("FND01-I-004/FND01-C-003: platform lifecycle is role protected and deactivation retains data while blocking tenant access", async () => {
      const ownerLogin = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        undefined,
        "owner-login-2",
      );
      const owner = await service.session(ownerLogin.sessionToken);
      await expect(service.listTenants(owner)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
      const detail = await service.tenantDetail(admin, tenantA);
      await withTenant(service.db, tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO app.job_runs(tenant_id,scope,job_type,job_key) VALUES($1::uuid,'TENANT','isolation-check','tenant-a-job')`,
          tenantA,
        ),
      );
      const before = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM app.setup_checklist_items WHERE tenant_id=$1::uuid`,
          tenantA,
        ),
      );
      await service.lifecycle(
        admin,
        tenantA,
        Number((detail.tenant as { version: number }).version),
        "Operational deactivation test",
        "INACTIVE",
        "deactivate-a",
        "lifecycle-deactivate-a",
        "TENANT-A",
      );
      expect(
        (
          await withPlatform(service.db, (tx) =>
            tx.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT count(*)::int count FROM app.setup_checklist_items WHERE tenant_id=$1::uuid`,
              tenantA,
            ),
          )
        )[0],
      ).toEqual(before[0]);
      await expect(
        service.session(ownerLogin.sessionToken),
      ).rejects.toBeInstanceOf(AppError);
      expect(await service.claimTenantJob(tenantA)).toBeNull();
      const after = await service.tenantDetail(admin, tenantA);
      await service.lifecycle(
        admin,
        tenantA,
        Number((after.tenant as { version: number }).version),
        "Operational reactivation test",
        "ACTIVE",
        "reactivate-a",
        "lifecycle-reactivate-a",
      );
      expect(await service.claimTenantJob(tenantA)).toMatchObject({
        tenantId: tenantA,
        jobKey: "tenant-a-job",
      });
      expect((await service.platformReport(admin)).totals.active).toBe(2);
    });

    it("FND01-I-005: lifecycle retries are stable and mismatched payloads conflict", async () => {
      const detail = await service.tenantDetail(admin, tenantB);
      const version = Number((detail.tenant as { version: number }).version);
      await expect(
        service.lifecycle(
          admin,
          tenantB,
          version,
          "Typed code confirmation validation",
          "INACTIVE",
          "lifecycle-b-confirmation",
          "lifecycle-b-bad-confirmation",
          "WRONG-CODE",
        ),
      ).rejects.toMatchObject({ status: 400, code: "CONFIRMATION_MISMATCH" });
      const first = await service.lifecycle(
        admin,
        tenantB,
        version,
        "Idempotent lifecycle validation",
        "INACTIVE",
        "lifecycle-b",
        "lifecycle-b-idempotency",
        "TENANT-B",
      );
      const retry = await service.lifecycle(
        admin,
        tenantB,
        version,
        "Idempotent lifecycle validation",
        "INACTIVE",
        "lifecycle-b-retry",
        "lifecycle-b-idempotency",
        "TENANT-B",
      );
      expect(retry).toEqual(first);
      await expect(
        service.lifecycle(
          admin,
          tenantB,
          version,
          "A materially different lifecycle reason",
          "INACTIVE",
          "lifecycle-b-mismatch",
          "lifecycle-b-idempotency",
          "TENANT-B",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
      const after = await service.tenantDetail(admin, tenantB);
      await service.lifecycle(
        admin,
        tenantB,
        Number((after.tenant as { version: number }).version),
        "Reactivate after idempotency validation",
        "ACTIVE",
        "lifecycle-b-active",
        "lifecycle-b-reactivate",
      );
    });

    it("FND01-C-004/FND01-A-008: checklist concurrency, probe idempotency and denial audit are enforced", async () => {
      const login = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        undefined,
        "owner-a-feature-login",
      );
      if (!("sessionToken" in login))
        throw new Error("Expected a tenant session");
      const owner = await service.session(login.sessionToken);
      const context = await service.tenantContext(owner);
      const branding = (
        context.checklist as Array<{ key: string; version: number }>
      ).find((item) => item.key === "branding")!;
      const updated = await service.updateChecklist(
        owner,
        "branding",
        branding.version,
        "NOT_STARTED",
        "branding-update",
      );
      expect(updated).toMatchObject({
        state: "NOT_STARTED",
        version: branding.version + 1,
      });
      await expect(
        service.updateChecklist(
          owner,
          "branding",
          branding.version,
          "COMPLETE",
          "branding-stale",
        ),
      ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });

      const created = await service.createProbe(
        owner,
        "A manifest",
        "Tenant A private note",
        "probe-create",
        "probe-idempotency-a",
      );
      const replay = await service.createProbe(
        owner,
        "A manifest",
        "Tenant A private note",
        "probe-replay",
        "probe-idempotency-a",
      );
      expect(replay).toEqual(created);
      await expect(
        service.createProbe(
          owner,
          "Changed manifest",
          "Tenant A private note",
          "probe-mismatch",
          "probe-idempotency-a",
        ),
      ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      const probeFacts = await withTenant(service.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ probes: number; audits: number }>>(
          `SELECT (SELECT count(*) FROM app.tenant_probe_records)::int probes,
             (SELECT count(*) FROM audit.audit_events WHERE action='setup.updated')::int audits`,
        ),
      );
      expect(probeFacts[0]).toEqual({ probes: 1, audits: 1 });
      const bProbe = await withTenant(service.db, tenantB, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM app.tenant_probe_records ORDER BY created_at LIMIT 1`,
        ),
      );
      await expect(
        service.getProbe(owner, bProbe[0]!.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const denial = await withTenant(service.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM audit.audit_events WHERE action='authorization.denied'`,
        ),
      );
      expect(denial[0]?.count).toBeGreaterThan(0);
    });

    it("FND01-C-005/FND01-A-009: existing identity linking verifies the old password and preserves global identity", async () => {
      const provisioned = await service.provision(
        admin,
        input("TENANT-D", "owner-a@test.local"),
        "tenant-d-link-key",
        "tenant-d-provision",
      );
      const tenantD = String(provisioned.tenant.id);
      const inviteD = String(provisioned.invitationUrl).split("token=")[1]!;
      const preview = await service.invitationPreview(inviteD);
      expect(preview.existingAccount).toBe(true);
      const before = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            id: string;
            display_name: string;
            password_hash: string;
            invited_name: string;
          }>
        >(
          `SELECT u.id,u.display_name,u.password_hash,m.invited_name FROM app.users u
           JOIN app.tenant_memberships m ON m.invited_email=u.email AND m.tenant_id=$1::uuid
           WHERE u.email='owner-a@test.local'`,
          tenantD,
        ),
      );
      expect(before[0]?.invited_name).toBe("Owner");
      await expect(
        service.acceptInvitation(
          inviteD,
          "Attacker rename",
          "WrongPassword1!",
          "tenant-d-wrong",
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: "INVITATION_ACCEPTANCE_FAILED",
      });
      const wrongFacts = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            status: string;
            accepted_at: Date | null;
            password_hash: string;
          }>
        >(
          `SELECT m.status,i.accepted_at,u.password_hash FROM app.tenant_memberships m
           JOIN app.owner_invitations i ON i.membership_id=m.id AND i.tenant_id=m.tenant_id
           JOIN app.users u ON u.email=m.invited_email WHERE m.tenant_id=$1::uuid`,
          tenantD,
        ),
      );
      expect(wrongFacts[0]).toMatchObject({
        status: "INVITED",
        accepted_at: null,
        password_hash: before[0]!.password_hash,
      });
      const attempts = await Promise.allSettled([
        service.acceptInvitation(
          inviteD,
          "Attacker rename",
          "LongPassword1!",
          "tenant-d-accept-one",
        ),
        service.acceptInvitation(
          inviteD,
          "Attacker rename",
          "LongPassword1!",
          "tenant-d-accept-two",
        ),
      ]);
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const after = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            display_name: string;
            password_hash: string;
            memberships: number;
          }>
        >(
          `SELECT u.display_name,u.password_hash,count(m.id)::int memberships FROM app.users u
           JOIN app.tenant_memberships m ON m.user_id=u.id AND m.status='ACTIVE'
           WHERE u.email='owner-a@test.local' GROUP BY u.id`,
        ),
      );
      expect(after[0]).toMatchObject({
        display_name: before[0]!.display_name,
        password_hash: before[0]!.password_hash,
        memberships: 2,
      });
      const selection = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        undefined,
        "multi-tenant-selection",
      );
      expect(selection).toMatchObject({ requiresTenantSelection: true });
      expect("tenants" in selection && selection.tenants).toHaveLength(2);
      const selected = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        "TENANT-A",
        "multi-tenant-selected",
      );
      expect(selected).toHaveProperty("sessionToken");
    });

    it("FND01-A-010: suspension is immediate, revokes sessions, and platform context is never implicit", async () => {
      await expect(service.session()).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
      });
      await expect(service.tenantContext(admin)).rejects.toMatchObject({
        status: 403,
        code: "TENANT_CONTEXT_REQUIRED",
      });
      const login = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        "TENANT-A",
        "suspension-login",
      );
      if (!("sessionToken" in login))
        throw new Error("Expected tenant session");
      const owner = await service.session(login.sessionToken);
      await service.setMembershipFixture(
        admin,
        { tenantId: tenantA, userId: owner.userId, status: "SUSPENDED" },
        "suspend-owner",
      );
      await expect(service.session(login.sessionToken)).rejects.toMatchObject({
        status: 401,
      });
      await service.setMembershipFixture(
        admin,
        { tenantId: tenantA, userId: owner.userId, status: "ACTIVE" },
        "reactivate-owner",
      );
      await expect(service.session(login.sessionToken)).rejects.toMatchObject({
        status: 401,
      });
      const fresh = await service.login(
        "owner-a@test.local",
        "LongPassword1!",
        "TENANT-A",
        "post-suspension-login",
      );
      expect(fresh).toHaveProperty("sessionToken");
      service.config.ENABLE_TEST_HOOKS = "false";
      try {
        await expect(
          service.setMembershipFixture(
            admin,
            { tenantId: tenantA, userId: owner.userId, status: "ACTIVE" },
            "disabled-fixture",
          ),
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      } finally {
        service.config.ENABLE_TEST_HOOKS = "true";
      }
    });

    it("FND01-R-003: event/job dispatch respects tenant lifecycle and repeated failures reconcile to one alert", async () => {
      const nonce = Date.now().toString();
      await withPlatform(service.db, async (tx) => {
        for (const [id, label] of [
          [tenantA, "a"],
          [tenantB, "b"],
        ]) {
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','dispatch','dispatch.test.v1','{}',$2)`,
            id,
            `dispatch-${label}-${nonce}`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.job_runs(tenant_id,scope,job_type,job_key,state,attempts,error_class) VALUES($1::uuid,'TENANT','reconcile-test',$2,'FAILED',3,'SAFE_FAILURE')`,
            id,
            `failed-${label}-${nonce}`,
          );
        }
      });
      expect(await service.claimTenantEvent(tenantA)).toMatchObject({
        tenantId: tenantA,
      });
      const detail = await service.tenantDetail(admin, tenantB);
      await service.lifecycle(
        admin,
        tenantB,
        Number((detail.tenant as { version: number }).version),
        "Dispatcher inactive tenant verification",
        "INACTIVE",
        "dispatch-deactivate-b",
        `dispatch-deactivate-${nonce}`,
        "TENANT-B",
      );
      expect(await service.claimTenantEvent(tenantB)).toBeNull();
      await service.reconcileRepeatedJobFailures();
      await service.reconcileRepeatedJobFailures();
      const alert = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number; occurrence_count: number }>>(
          `SELECT count(*)::int count,max(occurrence_count)::int occurrence_count FROM app.platform_alerts
           WHERE tenant_id=$1::uuid AND type='REPEATED_JOB_FAILURE'`,
          tenantA,
        ),
      );
      expect(alert[0]).toEqual({ count: 1, occurrence_count: 1 });
      const after = await service.tenantDetail(admin, tenantB);
      await service.lifecycle(
        admin,
        tenantB,
        Number((after.tenant as { version: number }).version),
        "Dispatcher test tenant reactivation",
        "ACTIVE",
        "dispatch-reactivate-b",
        `dispatch-reactivate-${nonce}`,
      );
    });

    it("FND01-R-002: audit mutation is rejected by database protection", async () => {
      await expect(
        withPlatform(service.db, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE audit.audit_events SET action='tampered'`,
          ),
        ),
      ).rejects.toBeTruthy();
    });

    it("FND01-I-006: concurrent same-key provisioning converges to one complete tenant", async () => {
      const request = input("TENANT-E", "owner-e@test.local");
      const results = await Promise.all([
        service.provision(
          admin,
          request,
          "tenant-e-concurrent-key",
          "tenant-e-one",
        ),
        service.provision(
          admin,
          request,
          "tenant-e-concurrent-key",
          "tenant-e-two",
        ),
      ]);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      const facts = await withPlatform(service.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ tenants: number; invitations: number; idempotency: number }>
        >(
          `SELECT (SELECT count(*) FROM app.tenants WHERE code='TENANT-E')::int tenants,
             (SELECT count(*) FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id WHERE t.code='TENANT-E')::int invitations,
             (SELECT count(*) FROM app.idempotency_records WHERE operation='tenant.provision' AND key_hash=encode(digest('tenant-e-concurrent-key','sha256'),'hex'))::int idempotency`,
        ),
      );
      expect(facts[0]).toEqual({ tenants: 1, invitations: 1, idempotency: 1 });
    });

    it("FND01-C-003: failed login attempts persist for PostgreSQL-backed throttling", async () => {
      await expect(
        service.login(
          "admin@local.test",
          "definitely-wrong",
          undefined,
          "failed-login",
        ),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      const attempts = await service.db.$queryRawUnsafe<
        Array<{ count: number }>
      >(`SELECT COALESCE(sum(attempts),0)::int count FROM app.login_attempts`);
      expect(attempts[0]?.count).toBe(1);
    });
  },
);
