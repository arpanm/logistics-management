import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../src/app.service.js";
import { AccessService } from "../src/access.service.js";
import { tenantCreateSchema } from "@logistics/domain";
import { withPlatform, withTenant } from "@logistics/db";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module.js";

const tenantInput = (code: string, owner: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Limited`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Scope Road",
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
    support: { name: "Support", email: `support-${owner}` },
    owner: { name: `${code} Owner`, email: owner },
    branding: {
      shortName: code,
      primaryColor: "#16324F",
      accentColor: "#D97706",
    },
    active: true,
  });

describe.sequential(
  "FND-02 identity, scoped access and security integration",
  () => {
    const app = new AppService();
    const access = new AccessService(app);
    let platform: Awaited<ReturnType<AppService["session"]>>;
    let owner: Awaited<ReturnType<AppService["session"]>>;
    let ownerToken = "";
    let tenantA = "",
      tenantB = "",
      ownerMembership = "";
    let root = "",
      north = "",
      south = "",
      alpha = "";
    let tenantBInvitation = "";
    let regionalRole = "",
      regionalMembership = "",
      regionalToken = "";
    let regional: Awaited<ReturnType<AppService["session"]>>;
    let northProbe = "",
      southProbe = "";
    let http: INestApplication;

    beforeAll(async () => {
      const login = await app.login(
        process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
        process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        undefined,
        "fnd02-platform-login",
      );
      if (!("sessionToken" in login))
        throw new Error("Expected platform session");
      platform = await app.session(login.sessionToken);
      const a = await app.provision(
        platform,
        tenantInput("FND02-A", "fnd02-owner-a@test.local"),
        "fnd02-tenant-a",
        "fnd02-provision-a",
      );
      const b = await app.provision(
        platform,
        tenantInput("FND02-B", "fnd02-owner-b@test.local"),
        "fnd02-tenant-b",
        "fnd02-provision-b",
      );
      tenantA = String(a.tenant.id);
      tenantB = String(b.tenant.id);
      tenantBInvitation = String(b.invitationUrl).split("token=")[1]!;
      const accepted = await app.acceptInvitation(
        String(a.invitationUrl).split("token=")[1]!,
        "FND02 Owner A",
        "OwnerPassword!234",
        "fnd02-owner-accept",
      );
      ownerToken = accepted.sessionToken;
      owner = await app.session(ownerToken);
      ownerMembership = String(owner.membershipId);
      await withTenant(app.db, tenantA, async (tx) => {
        root = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
              tenantA,
            )
          )[0]!.id,
        );
        north = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'REGION','NORTH','North',$2::uuid) RETURNING id`,
              tenantA,
              root,
            )
          )[0]!.id,
        );
        south = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'REGION','SOUTH','South',$2::uuid) RETURNING id`,
              tenantA,
              root,
            )
          )[0]!.id,
        );
        alpha = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'CLIENT','ALPHA','Alpha Client',$2::uuid) RETURNING id`,
              tenantA,
              north,
            )
          )[0]!.id,
        );
        regionalRole = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='REGIONAL_MANAGER'`,
              tenantA,
            )
          )[0]!.id,
        );
      });
      http = await NestFactory.create(AppModule, { logger: false });
      http.setGlobalPrefix("api/v1");
      http.use(cookieParser());
      await http.init();
    });
    afterAll(async () => {
      await http.close();
      await app.onModuleDestroy();
    });

    it("FND02-M-001: clean migration and runtime provisioning create deterministic owner authorization", async () => {
      await expect(app.ready()).resolves.toMatchObject({
        latestMigration: "202608250016_fnd01_postal_owner_handoff_contract",
        migrationCount: 15,
      });
      const facts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            roles: number;
            roots: number;
            assignments: number;
            grants: number;
          }>
        >(
          `SELECT (SELECT count(*) FROM app.roles WHERE tenant_id=$1::uuid)::int roles,
       (SELECT count(*) FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT')::int roots,
       (SELECT count(*) FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid)::int assignments,
       (SELECT count(*) FROM app.scope_grants g JOIN app.membership_role_assignments a ON a.id=g.assignment_id WHERE g.tenant_id=$1::uuid AND a.membership_id=$2::uuid)::int grants`,
          tenantA,
          ownerMembership,
        ),
      );
      expect(facts[0]).toEqual({
        roles: 13,
        roots: 1,
        assignments: 1,
        grants: 1,
      });
      const ownerCapabilities = await access.effective(
        owner,
        "fnd02-effective-owner",
      );
      expect(ownerCapabilities.capabilities).toContain("identity.user.admin");
      expect(ownerCapabilities.capabilities).toContain("probe.export");
    });

    it("FND02-M-002: catalog introspection proves FORCE RLS, policies and tenant-leading indexes", async () => {
      const expected = [
        "access_invitations",
        "authorization_probe_records",
        "authorization_scope_nodes",
        "membership_role_assignments",
        "role_capabilities",
        "roles",
        "scope_grants",
        "security_alerts",
        "security_events",
      ];
      const rows = await app.db.$queryRawUnsafe<
        Array<{
          name: string;
          rls: boolean;
          forced: boolean;
          policies: number;
          tenant_index: boolean;
        }>
      >(
        `
      SELECT c.relname name,c.relrowsecurity rls,c.relforcerowsecurity forced,
       (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) policies,
       EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' WHERE i.indrelid=c.oid AND (i.indkey::smallint[])[0]=a.attnum) tenant_index
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
        expected,
      );
      expect(rows.map((r) => r.name)).toEqual(expected.sort());
      for (const row of rows)
        expect(row).toMatchObject({
          rls: true,
          forced: true,
          policies: 1,
          tenant_index: true,
        });
      const unset = await app.db.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int count FROM app.roles`,
      );
      expect(unset[0]?.count).toBe(0);
      const onlyA = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
          `SELECT DISTINCT tenant_id FROM app.roles`,
        ),
      );
      expect(onlyA.map((r) => String(r.tenant_id))).toEqual([tenantA]);
      const all = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
          `SELECT DISTINCT tenant_id FROM app.roles ORDER BY tenant_id`,
        ),
      );
      const platformTenants = new Set(all.map((r) => String(r.tenant_id)));
      expect(platformTenants.has(tenantA)).toBe(true);
      expect(platformTenants.has(tenantB)).toBe(true);
      const tenantBRows = await withTenant(app.db, tenantB, (tx) =>
        tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
          `SELECT DISTINCT tenant_id FROM app.roles`,
        ),
      );
      expect(tenantBRows.map((r) => String(r.tenant_id))).toEqual([tenantB]);
      await expect(
        withTenant(app.db, tenantA, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO app.roles(tenant_id,code,name,portal_audiences) VALUES($1::uuid,'FORGED','Forged',ARRAY['INTERNAL']::text[])`,
            tenantB,
          ),
        ),
      ).rejects.toBeTruthy();
      await expect(
        app.db.$executeRawUnsafe(
          `INSERT INTO app.roles(tenant_id,code,name,portal_audiences) VALUES($1::uuid,'UNSET','Unset',ARRAY['INTERNAL']::text[])`,
          tenantA,
        ),
      ).rejects.toBeTruthy();
      await expect(
        withTenant(app.db, tenantB, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'REGION','FOREIGN','Foreign',$2::uuid)`,
            tenantB,
            root,
          ),
        ),
      ).rejects.toBeTruthy();
      await expect(
        withTenant(app.db, tenantB, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO app.authorization_probe_records(tenant_id,label,scope_node_ids) VALUES($1::uuid,'Foreign probe',$2::uuid[])`,
            tenantB,
            [north],
          ),
        ),
      ).rejects.toBeTruthy();
      await expect(
        withPlatform(app.db, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE app.capability_catalog SET description='mutable' WHERE code='probe.read'`,
          ),
        ),
      ).rejects.toThrow(/migration-managed/);
    });

    it("FND02-I-001/FND02-I-002/FND02-C-001/FND02-C-002: invitation is normalized, idempotent, single-use, hashed and collision-safe", async () => {
      const payload = {
        displayName: "Regional User",
        employeeCode: "RM-001",
        email: "regional@test.local",
        authenticationMethod: "LOCAL_PASSWORD" as const,
        portalAudience: "INTERNAL" as const,
        assignments: [
          {
            roleId: regionalRole,
            grants: [
              {
                scopeNodeId: north,
                actions: ["READ", "CREATE", "UPDATE", "EXPORT"] as Array<
                  "READ" | "CREATE" | "UPDATE" | "EXPORT"
                >,
              },
            ],
          },
        ],
        expiresInHours: 72,
        reason: "Regional operations access",
      };
      const invited = await access.invite(
        owner,
        payload,
        "fnd02-regional-invite",
        "fnd02-invite",
      );
      regionalMembership = String(invited.membershipId);
      const inviteUrl = String(invited.invitationUrl);
      expect(inviteUrl).toContain("/accept-access?token=");
      const replay = await access.invite(
        owner,
        payload,
        "fnd02-regional-invite",
        "fnd02-invite-replay",
      );
      expect(replay).toMatchObject({
        replayed: true,
        membershipId: regionalMembership,
      });
      expect(replay.invitationUrl).toBeUndefined();
      const stored = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ token_hash: string; response_json: Record<string, unknown> }>
        >(
          `SELECT i.token_hash,r.response_json FROM app.access_invitations i JOIN app.idempotency_records r ON r.resource_id=$1::uuid WHERE i.membership_id=$1::uuid`,
          regionalMembership,
        ),
      );
      const plaintext = inviteUrl.split("token=")[1]!;
      expect(stored[0]?.token_hash).not.toContain(plaintext);
      expect(stored[0]?.response_json).not.toHaveProperty("invitationUrl");
      const pendingDetail = (await access.userDetail(
        owner,
        regionalMembership,
        "fnd02-activation-detail",
      )) as Record<string, unknown>;
      const rotationKeys = [
        "fnd02-activation-rotate-a",
        "fnd02-activation-rotate-b",
      ];
      const rotations = await Promise.allSettled(
        rotationKeys.map((rotationKey, index) =>
          access.resendInvitation(
            owner,
            regionalMembership,
            Number(pendingDetail.version),
            "Administrator generated a replacement activation link",
            rotationKey,
            `fnd02-activation-rotate-request-${index}`,
          ),
        ),
      );
      const winners = rotations
        .map((result, index) => ({ result, index }))
        .filter(
          (
            entry,
          ): entry is {
            result: PromiseFulfilledResult<
              Awaited<ReturnType<typeof access.resendInvitation>>
            >;
            index: number;
          } => entry.result.status === "fulfilled",
        );
      const losers = rotations.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toMatchObject({ code: "VERSION_CONFLICT" });
      const rotated = winners[0]!.result.value;
      expect(rotated.version).toBe(Number(pendingDetail.version) + 1);
      expect(rotated.invitationUrl).toContain("/accept-access?token=");
      await expect(access.invitationPreview(plaintext)).rejects.toMatchObject({
        code: "INVITATION_INVALID",
      });
      const rotationReplay = await access.resendInvitation(
        owner,
        regionalMembership,
        Number(pendingDetail.version),
        "Administrator generated a replacement activation link",
        rotationKeys[winners[0]!.index]!,
        "fnd02-activation-rotate-replay",
      );
      expect(rotationReplay.replayed).toBe(true);
      expect(rotationReplay.invitationUrl).toBeUndefined();
      await expect(
        access.resendInvitation(
          owner,
          regionalMembership,
          Number(pendingDetail.version),
          "Administrator generated a stale replacement activation link",
          "fnd02-activation-rotate-stale",
          "fnd02-activation-rotate-stale-request",
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const currentPlaintext = String(rotated.invitationUrl).split(
        "token=",
      )[1]!;
      const accepted = await access.acceptInvitation(
        currentPlaintext,
        { displayName: "Regional User", password: "RegionalPass!234" },
        "fnd02-regional-accept",
      );
      regionalToken = accepted.sessionToken;
      regional = await app.session(regionalToken);
      await expect(
        access.acceptInvitation(
          currentPlaintext,
          { displayName: "Regional User", password: "RegionalPass!234" },
          "fnd02-regional-replay",
        ),
      ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
      expect(regional.activeTenantId).toBe(tenantA);
      const acceptedOwnerB = await app.acceptInvitation(
        tenantBInvitation,
        "FND02 Owner B",
        "OwnerBPassword!234",
        "fnd02-owner-b-accept",
      );
      const ownerB = await app.session(acceptedOwnerB.sessionToken);
      const bFixture = await withTenant(app.db, tenantB, async (tx) => {
        const rootId = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
              tenantB,
            )
          )[0]!.id,
        );
        const roleId = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='REGIONAL_MANAGER'`,
              tenantB,
            )
          )[0]!.id,
        );
        return { rootId, roleId };
      });
      const existingInvite = await access.invite(
        ownerB,
        {
          displayName: "Regional User",
          employeeCode: "RM-B-001",
          email: "regional@test.local",
          authenticationMethod: "LOCAL_PASSWORD",
          portalAudience: "INTERNAL",
          assignments: [
            {
              roleId: bFixture.roleId,
              grants: [{ scopeNodeId: bFixture.rootId, actions: ["READ"] }],
            },
          ],
          expiresInHours: 72,
          reason: "Approved regional access in tenant B",
        },
        "fnd02-existing-invite",
        "fnd02-existing-invite",
      );
      const existingToken = String(existingInvite.invitationUrl).split(
        "token=",
      )[1]!;
      for (let attempt = 1; attempt <= 4; attempt++)
        await expect(
          access.acceptInvitation(
            existingToken,
            {
              displayName: "Regional User",
              currentPassword: "WrongExistingPassword",
            },
            `fnd02-existing-wrong-${attempt}`,
          ),
        ).rejects.toMatchObject({ code: "INVITATION_ACCEPTANCE_FAILED" });
      await expect(
        access.acceptInvitation(
          existingToken,
          {
            displayName: "Regional User",
            currentPassword: "WrongExistingPassword",
          },
          "fnd02-existing-wrong-5",
        ),
      ).rejects.toMatchObject({ code: "INVITATION_THROTTLED", status: 429 });
      const invitationFailures = await withTenant(app.db, tenantB, (tx) =>
        tx.$queryRawUnsafe<Array<{ events: number; alerts: number }>>(
          `SELECT (SELECT count(*) FROM app.security_events WHERE tenant_id=$1::uuid AND event_type='INVITATION_ACCEPTANCE_FAILED')::int events,
                (SELECT count(*) FROM app.security_alerts WHERE tenant_id=$1::uuid AND alert_type='INVITATION_ACCEPTANCE_FAILED')::int alerts`,
          tenantB,
        ),
      );
      expect(invitationFailures[0]).toEqual({ events: 5, alerts: 1 });
      await expect(
        access.acceptInvitation(
          existingToken,
          { displayName: "Regional User", currentPassword: "RegionalPass!234" },
          "fnd02-existing-correct",
        ),
      ).resolves.toMatchObject({ activeTenantId: tenantB });
    });

    it("FND02-A-001/FND02-A-002/FND02-A-006/FND02-C-003/FND02-C-004: SQL scope precedes list/detail/export and preview matches enforcement", async () => {
      const northCreated = await access.createProbe(
        owner,
        {
          label: "North Alpha",
          resourceType: "CLIENT_STATUS",
          scopeNodeIds: [alpha],
          status: "OPEN",
          taxIdentifier: "GSTNORTH1234",
          mobile: "+919876543210",
          bankDetail: "BANK00001234",
          commercialRateMinor: 12500,
          paymentMinor: 45000,
          internalMarginMinor: 9000,
        },
        "fnd02-probe-north",
        "fnd02-probe-north",
      );
      const southCreated = await access.createProbe(
        owner,
        {
          label: "South Beta",
          resourceType: "CLIENT_STATUS",
          scopeNodeIds: [south],
          status: "OPEN",
          taxIdentifier: "GSTSOUTH5678",
          internalMarginMinor: 8000,
        },
        "fnd02-probe-south",
        "fnd02-probe-south",
      );
      northProbe = String(northCreated.id);
      southProbe = String(southCreated.id);
      const visible = await access.listProbes(
        regional,
        "",
        "fnd02-regional-list",
      );
      expect(visible.total).toBe(1);
      expect(visible.items[0]).toMatchObject({
        id: northProbe,
        taxIdentifier: { value: "••••1234", masked: true },
        internalMargin: { value: null, masked: true },
      });
      const previewAllow = await access.previewOperation(
        regional,
        "probe.read",
        "READ",
        northProbe,
        "fnd02-preview-north",
      );
      const previewDeny = await access.previewOperation(
        regional,
        "probe.read",
        "READ",
        southProbe,
        "fnd02-preview-south",
      );
      expect(previewAllow.allowed).toBe(true);
      expect(previewDeny.allowed).toBe(false);
      for (const [capability, action, allowed] of [
        ["probe.create", "CREATE", true],
        ["probe.update", "UPDATE", true],
        ["probe.export", "EXPORT", true],
        ["probe.approve", "APPROVE", false],
        ["identity.user.admin", "ADMIN", false],
        ["probe.read", "UPDATE", false],
      ] as const)
        expect(
          (
            await access.previewOperation(
              regional,
              capability,
              action,
              northProbe,
              `fnd02-preview-${action}`,
            )
          ).allowed,
        ).toBe(allowed);
      await expect(
        access.probe(regional, southProbe, "fnd02-denied-south"),
      ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
      const exported = await access.exportProbes(
        regional,
        "",
        "fnd02-regional-export",
      );
      expect(exported.map((r) => r.id)).toEqual([northProbe]);
      expect(JSON.stringify(exported)).not.toContain("GSTNORTH");
    });

    it("FND02-A-007/FND02-A-008/FND02-A-009: denial is non-leaking, durable, correlated exactly once and secondary channels are masked", async () => {
      const unknown = crypto.randomUUID();
      for (const id of [southProbe, unknown])
        await expect(
          access.probe(regional, id, `deny-${id}`),
        ).rejects.toMatchObject({
          status: 404,
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found",
        });
      const denials = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            correlation_id: string;
            metadata: Record<string, unknown>;
            safe_target_hash: string;
          }>
        >(
          `SELECT correlation_id,metadata,safe_target_hash FROM app.security_events WHERE tenant_id=$1::uuid AND correlation_id=ANY($2::text[]) ORDER BY correlation_id`,
          tenantA,
          [`deny-${southProbe}`, `deny-${unknown}`],
        ),
      );
      expect(denials).toHaveLength(2);
      expect(new Set(denials.map((d) => d.correlation_id))).toEqual(
        new Set([`deny-${southProbe}`, `deny-${unknown}`]),
      );
      expect(JSON.stringify(denials)).not.toContain("South Beta");
      expect(
        JSON.stringify(
          await access.reports(
            owner,
            "security-events",
            "fnd02-security-report",
          ),
        ),
      ).not.toContain("GSTSOUTH5678");
    });

    it("FND02-I-003/FND02-I-006/FND02-I-007/FND02-A-010: access edit fingerprint/version is atomic and invalidates sessions immediately", async () => {
      const detail = (await access.userDetail(
        owner,
        regionalMembership,
        "fnd02-user-detail",
      )) as Record<string, unknown>;
      expect(detail.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            roleId: regionalRole,
            grants: expect.arrayContaining([
              expect.objectContaining({
                scopeNodeId: north,
                actions: ["CREATE", "EXPORT", "READ", "UPDATE"],
              }),
            ]),
          }),
        ]),
      );
      const assignments = [
        {
          roleId: regionalRole,
          grants: [
            {
              scopeNodeId: south,
              actions: ["READ", "EXPORT"] as Array<"READ" | "EXPORT">,
            },
          ],
        },
      ];
      const preview = await access.preview(
        owner,
        regionalMembership,
        { expectedVersion: Number(detail.version), assignments },
        "fnd02-access-preview",
      );
      const updated = await access.updateAccess(
        owner,
        regionalMembership,
        {
          expectedVersion: Number(detail.version),
          assignments,
          reason: "Move regional responsibility south",
          previewFingerprint: preview.fingerprint,
        },
        "fnd02-access-update",
        "fnd02-access-update",
      );
      expect(Number(updated.authorizationVersion)).toBeGreaterThan(
        Number(detail.authorizationVersion),
      );
      await expect(app.session(regionalToken)).rejects.toMatchObject({
        code: "SESSION_STALE",
      });
      await expect(
        access.updateAccess(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(detail.version),
            assignments,
            reason: "Stale concurrent access change",
            previewFingerprint: preview.fingerprint,
          },
          "fnd02-access-stale",
          "fnd02-access-stale",
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const facts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ audits: number; events: number }>>(
          `SELECT (SELECT count(*) FROM audit.audit_events WHERE tenant_id=$1::uuid AND action='identity.access.changed' AND target_id=$2::uuid)::int audits,(SELECT count(*) FROM app.outbox_events WHERE tenant_id=$1::uuid AND event_type='identity.access.changed.v1' AND aggregate_id=$2::uuid)::int events`,
          tenantA,
          regionalMembership,
        ),
      );
      expect(facts[0]).toEqual({ audits: 1, events: 1 });
    });

    it("FND02-I-006/FND02-I-007: concurrent access writers have one winner and invalid mixed input rolls back completely", async () => {
      const current = (await access.userDetail(
        owner,
        regionalMembership,
        "fnd02-concurrent-detail",
      )) as Record<string, unknown>;
      const northAssignments = [
        {
          roleId: regionalRole,
          grants: [
            {
              scopeNodeId: north,
              actions: ["READ", "EXPORT"] as Array<"READ" | "EXPORT">,
            },
          ],
        },
      ];
      const southAssignments = [
        {
          roleId: regionalRole,
          grants: [
            {
              scopeNodeId: south,
              actions: ["READ", "EXPORT"] as Array<"READ" | "EXPORT">,
            },
          ],
        },
      ];
      const [northPreview, southPreview] = await Promise.all([
        access.preview(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(current.version),
            assignments: northAssignments,
          },
          "fnd02-concurrent-preview-north",
        ),
        access.preview(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(current.version),
            assignments: southAssignments,
          },
          "fnd02-concurrent-preview-south",
        ),
      ]);
      const results = await Promise.allSettled([
        access.updateAccess(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(current.version),
            assignments: northAssignments,
            reason: "Concurrent north responsibility update",
            previewFingerprint: northPreview.fingerprint,
          },
          "fnd02-concurrent-north",
          "fnd02-concurrent-north",
        ),
        access.updateAccess(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(current.version),
            assignments: southAssignments,
            reason: "Concurrent south responsibility update",
            previewFingerprint: southPreview.fingerprint,
          },
          "fnd02-concurrent-south",
          "fnd02-concurrent-south",
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const after = (await access.userDetail(
        owner,
        regionalMembership,
        "fnd02-concurrent-after",
      )) as Record<string, unknown>;
      const beforeFacts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ assignments: number; grants: number }>>(
          `SELECT (SELECT count(*) FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid)::int assignments,(SELECT count(*) FROM app.scope_grants g JOIN app.membership_role_assignments a ON a.id=g.assignment_id WHERE g.tenant_id=$1::uuid AND a.membership_id=$2::uuid)::int grants`,
          tenantA,
          regionalMembership,
        ),
      );
      await expect(
        access.updateAccess(
          owner,
          regionalMembership,
          {
            expectedVersion: Number(after.version),
            assignments: [
              ...northAssignments,
              {
                roleId: crypto.randomUUID(),
                grants: [{ scopeNodeId: north, actions: ["READ"] }],
              },
            ],
            reason: "Invalid mixed access must roll back",
            previewFingerprint: "0".repeat(64),
          },
          "fnd02-invalid-mixed",
          "fnd02-invalid-mixed",
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      const afterInvalid = (await access.userDetail(
        owner,
        regionalMembership,
        "fnd02-invalid-after",
      )) as Record<string, unknown>;
      const afterFacts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ assignments: number; grants: number }>>(
          `SELECT (SELECT count(*) FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid)::int assignments,(SELECT count(*) FROM app.scope_grants g JOIN app.membership_role_assignments a ON a.id=g.assignment_id WHERE g.tenant_id=$1::uuid AND a.membership_id=$2::uuid)::int grants`,
          tenantA,
          regionalMembership,
        ),
      );
      expect(afterInvalid.version).toBe(after.version);
      expect(afterFacts[0]).toEqual(beforeFacts[0]);
    });

    it("FND02-A-002/FND02-A-006: KAM and disjoint multi-role permissions never form a scope cross-product", async () => {
      const roleRows = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string; code: string }>>(
          `SELECT id,code FROM app.roles WHERE tenant_id=$1::uuid AND code=ANY(ARRAY['KEY_ACCOUNT_MANAGER','FINANCE_EXECUTIVE'])`,
          tenantA,
        ),
      );
      const roleMap = Object.fromEntries(
        roleRows.map((row) => [row.code, String(row.id)]),
      );
      const kamInvite = await access.invite(
        owner,
        {
          displayName: "KAM Alpha",
          employeeCode: "KAM-001",
          email: "kam-alpha@test.local",
          authenticationMethod: "LOCAL_PASSWORD",
          portalAudience: "INTERNAL",
          assignments: [
            {
              roleId: roleMap.KEY_ACCOUNT_MANAGER!,
              grants: [
                {
                  scopeNodeId: alpha,
                  actions: ["READ", "CREATE", "UPDATE", "EXPORT"],
                },
              ],
            },
          ],
          expiresInHours: 72,
          reason: "Approved key-account access for Alpha",
        },
        "fnd02-kam-invite",
        "fnd02-kam-invite",
      );
      const kamAccepted = await access.acceptInvitation(
        String(kamInvite.invitationUrl).split("token=")[1]!,
        { displayName: "KAM Alpha", password: "KamPassword!234" },
        "fnd02-kam-accept",
      );
      const kam = await app.session(kamAccepted.sessionToken);
      expect(
        (await access.listProbes(kam, "", "fnd02-kam-list")).items.map(
          (row) => row.id,
        ),
      ).toEqual([northProbe]);
      const multiInvite = await access.invite(
        owner,
        {
          displayName: "Multi Role",
          employeeCode: "MULTI-001",
          email: "multi@test.local",
          authenticationMethod: "LOCAL_PASSWORD",
          portalAudience: "INTERNAL",
          assignments: [
            {
              roleId: regionalRole,
              grants: [{ scopeNodeId: north, actions: ["READ"] }],
            },
            {
              roleId: roleMap.FINANCE_EXECUTIVE!,
              grants: [{ scopeNodeId: south, actions: ["APPROVE"] }],
            },
          ],
          expiresInHours: 72,
          reason: "Approved privileged finance boundary",
        },
        "fnd02-multi-invite",
        "fnd02-multi-invite",
      );
      const multiAccepted = await access.acceptInvitation(
        String(multiInvite.invitationUrl).split("token=")[1]!,
        { displayName: "Multi Role", password: "MultiPassword!234" },
        "fnd02-multi-accept",
      );
      const multi = await app.session(multiAccepted.sessionToken);
      expect(
        (
          await access.previewOperation(
            multi,
            "probe.read",
            "READ",
            northProbe,
            "fnd02-multi-read-north",
          )
        ).allowed,
      ).toBe(true);
      expect(
        (
          await access.previewOperation(
            multi,
            "probe.approve",
            "APPROVE",
            southProbe,
            "fnd02-multi-approve-south",
          )
        ).allowed,
      ).toBe(true);
      expect(
        (
          await access.previewOperation(
            multi,
            "probe.approve",
            "APPROVE",
            northProbe,
            "fnd02-multi-cross-product",
          )
        ).allowed,
      ).toBe(false);
    });

    it("FND02-A-003/FND02-A-004/FND02-A-005/FND02-I-005: external portals, masking and live driver reassignment stay constrained", async () => {
      const fixture = await withTenant(app.db, tenantA, async (tx) => {
        const vendor = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'VENDOR','RED','Red Vendor',$2::uuid) RETURNING id`,
              tenantA,
              north,
            )
          )[0]!.id,
        );
        const trip = String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,'ASSIGNED_TRIP','TRIP-1','Assigned Trip 1',$2::uuid) RETURNING id`,
              tenantA,
              north,
            )
          )[0]!.id,
        );
        const roles = await tx.$queryRawUnsafe<
          Array<{ id: string; code: string }>
        >(
          `SELECT id,code FROM app.roles WHERE tenant_id=$1::uuid AND code=ANY(ARRAY['VENDOR_OWNER','DRIVER','CLIENT_VIEWER'])`,
          tenantA,
        );
        return {
          vendor,
          trip,
          roles: Object.fromEntries(roles.map((r) => [r.code, String(r.id)])),
        };
      });
      const inviteAndAccept = async (
        name: string,
        employeeCode: string,
        email: string,
        audience: "VENDOR" | "DRIVER" | "CLIENT",
        roleId: string,
        scopeNodeId: string,
      ) => {
        const invitation = await access.invite(
          owner,
          {
            displayName: name,
            employeeCode,
            email,
            authenticationMethod: "LOCAL_PASSWORD",
            portalAudience: audience,
            assignments: [
              {
                roleId,
                grants: [
                  {
                    scopeNodeId,
                    actions:
                      audience === "DRIVER" ? ["READ", "UPDATE"] : ["READ"],
                  },
                ],
              },
            ],
            expiresInHours: 72,
            reason: `Approved ${audience.toLowerCase()} portal access`,
          },
          `fnd02-${employeeCode}-invite`,
          `fnd02-${employeeCode}-invite`,
        );
        const accepted = await access.acceptInvitation(
          String(invitation.invitationUrl).split("token=")[1]!,
          { displayName: name, password: "PortalPassword!234" },
          `fnd02-${employeeCode}-accept`,
        );
        return {
          actor: await app.session(accepted.sessionToken),
          token: accepted.sessionToken,
        };
      };
      const vendor = await inviteAndAccept(
        "Vendor Red",
        "VEND-001",
        "vendor-red@test.local",
        "VENDOR",
        fixture.roles.VENDOR_OWNER!,
        fixture.vendor,
      );
      const driver = await inviteAndAccept(
        "Driver One",
        "DRV-001",
        "driver-one@test.local",
        "DRIVER",
        fixture.roles.DRIVER!,
        fixture.trip,
      );
      const driverTwo = await inviteAndAccept(
        "Driver Two",
        "DRV-002",
        "driver-two@test.local",
        "DRIVER",
        fixture.roles.DRIVER!,
        fixture.trip,
      );
      const client = await inviteAndAccept(
        "Client Alpha",
        "CLI-001",
        "client-alpha@test.local",
        "CLIENT",
        fixture.roles.CLIENT_VIEWER!,
        alpha,
      );
      const vendorProbe = await access.createProbe(
        owner,
        {
          label: "Red Payment",
          resourceType: "PAYMENT",
          scopeNodeIds: [fixture.vendor],
          status: "OPEN",
          paymentMinor: 125000,
          commercialRateMinor: 120000,
          internalMarginMinor: 5000,
          bankDetail: "BANK-RED-1234",
        },
        "fnd02-vendor-probe",
        "fnd02-vendor-probe",
      );
      const tripProbe = await access.createProbe(
        owner,
        {
          label: "Driver Trip",
          resourceType: "TRIP",
          scopeNodeIds: [fixture.trip],
          assignedUserId: driver.actor.userId,
          status: "OPEN",
          mobile: "+919899999999",
        },
        "fnd02-driver-probe",
        "fnd02-driver-probe",
      );
      const clientProbe = await access.createProbe(
        owner,
        {
          label: "Alpha Status",
          resourceType: "CLIENT_STATUS",
          scopeNodeIds: [alpha],
          status: "OPEN",
          internalMarginMinor: 7000,
        },
        "fnd02-client-probe",
        "fnd02-client-probe",
      );
      const vendorRows = await access.listProbes(
        vendor.actor,
        "",
        "fnd02-vendor-list",
      );
      expect(vendorRows.items.map((row) => row.id)).toEqual([vendorProbe.id]);
      expect(vendorRows.items[0]).toMatchObject({
        internalMargin: { value: null, masked: true },
        bankDetail: { value: "••••1234", masked: true },
      });
      const driverRows = await access.listProbes(
        driver.actor,
        "",
        "fnd02-driver-list",
      );
      expect(driverRows.items.map((row) => row.id)).toEqual([tripProbe.id]);
      const clientRows = await access.listProbes(
        client.actor,
        "",
        "fnd02-client-list",
      );
      expect(new Set(clientRows.items.map((row) => row.id))).toEqual(
        new Set([northProbe, clientProbe.id]),
      );
      expect(
        clientRows.items.every(
          (row) =>
            row.internalMargin.masked && row.internalMargin.value === null,
        ),
      ).toBe(true);
      await expect(
        access.probe(
          vendor.actor,
          String(clientProbe.id),
          "fnd02-vendor-client-deny",
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await access.reassignProbe(
        owner,
        String(tripProbe.id),
        Number(tripProbe.version),
        driverTwo.actor.userId,
        "Driver assignment changed operationally",
        "fnd02-driver-reassign",
      );
      await expect(app.session(driver.token)).rejects.toMatchObject({
        code: "SESSION_STALE",
      });
      await expect(app.session(driverTwo.token)).rejects.toMatchObject({
        code: "SESSION_STALE",
      });
      const driverTwoLogin = await app.login(
        "driver-two@test.local",
        "PortalPassword!234",
        "FND02-A",
        "fnd02-driver-two-login",
      );
      if (!("sessionToken" in driverTwoLogin))
        throw new Error("Expected reassigned driver login");
      const reassignedRows = await access.listProbes(
        await app.session(driverTwoLogin.sessionToken),
        "",
        "fnd02-driver-two-list",
      );
      expect(reassignedRows.items.map((row) => row.id)).toEqual([tripProbe.id]);
    });

    it("FND02-C-001/FND02-C-006: HTTP contracts enforce opaque cookies, CSRF and origin on access mutations", async () => {
      const login = await request(http.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          identifier: "fnd02-owner-a@test.local",
          password: "OwnerPassword!234",
          tenantCode: "FND02-A",
        });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const cookies = login.headers["set-cookie"] as unknown as string[];
      expect(
        cookies.some(
          (cookie) =>
            cookie.startsWith("logistics_session=") &&
            cookie.includes("HttpOnly") &&
            cookie.includes("SameSite=Lax"),
        ),
      ).toBe(true);
      const cookieHeader = cookies
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const csrf = decodeURIComponent(
        cookies
          .find((cookie) => cookie.startsWith("logistics_csrf="))!
          .split(";")[0]!
          .split("=")
          .slice(1)
          .join("="),
      );
      const payload = {
        code: "HTTP-ROLE",
        name: "HTTP Role",
        description: "Contract fixture",
        portalAudiences: ["INTERNAL"],
        capabilities: ["probe.read"],
        reason: "Approved contract role creation",
      };
      await request(http.getHttpServer())
        .post("/api/v1/tenant/access/roles")
        .set("Cookie", cookieHeader)
        .set("Idempotency-Key", "fnd02-http-no-csrf")
        .send(payload)
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe("CSRF_INVALID"));
      await request(http.getHttpServer())
        .post("/api/v1/tenant/access/roles")
        .set("Cookie", cookieHeader)
        .set("X-CSRF-Token", csrf)
        .set("Origin", "https://evil.invalid")
        .set("Idempotency-Key", "fnd02-http-origin")
        .send(payload)
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe("ORIGIN_INVALID"));
      const created = await request(http.getHttpServer())
        .post("/api/v1/tenant/access/roles")
        .set("Cookie", cookieHeader)
        .set("X-CSRF-Token", csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "fnd02-http-success")
        .send(payload);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({
        code: "HTTP-ROLE",
        name: "HTTP Role",
      });
    });

    it("FND02-C-006: test fixture API is platform/CSRF/idempotency protected and returns scoped E2E contracts without stored passwords", async () => {
      const login = await request(http.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          identifier: process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
          password: process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        });
      expect(login.status).toBe(200);
      const cookies = login.headers["set-cookie"] as unknown as string[];
      const cookieHeader = cookies
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const csrf = decodeURIComponent(
        cookies
          .find((cookie) => cookie.startsWith("logistics_csrf="))!
          .split(";")[0]!
          .split("=")
          .slice(1)
          .join("="),
      );
      const payload = { namespace: "HOOKA", scenario: "PORTALS" };
      await request(http.getHttpServer())
        .post("/api/v1/test/fnd02/fixtures")
        .set("Cookie", cookieHeader)
        .set("Idempotency-Key", "fnd02-hook-no-csrf")
        .send(payload)
        .expect(403);
      const created = await request(http.getHttpServer())
        .post("/api/v1/test/fnd02/fixtures")
        .set("Cookie", cookieHeader)
        .set("X-CSRF-Token", csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "fnd02-hook-create")
        .send(payload)
        .expect(201);
      expect(created.body).toMatchObject({
        scenario: "PORTALS",
        tenantA: { code: "HOOKA-POR" },
        expected: { resources: 5, alerts: 0 },
      });
      expect(Object.keys(created.body.actors)).toEqual(
        expect.arrayContaining([
          "owner",
          "regional",
          "kam",
          "multiRole",
          "vendor",
          "driverA",
          "driverB",
          "client",
          "auditor",
        ]),
      );
      expect(created.body.actors.driverA).toMatchObject({
        password: "FixturePassword!234",
        home: "/portal/driver",
      });
      expect(created.body.resources.trip).toHaveProperty("id");
      const vendorLogin = await request(http.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          identifier: created.body.actors.vendor.email,
          password: created.body.actors.vendor.password,
        })
        .expect(200);
      const vendorCookie = (
        vendorLogin.headers["set-cookie"] as unknown as string[]
      )
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const vendorProbes = await request(http.getHttpServer())
        .get("/api/v1/tenant/access/probes")
        .set("Cookie", vendorCookie)
        .expect(200);
      expect(vendorProbes.body.items).toEqual([
        expect.objectContaining({
          label: "Red Payment",
          payment: { value: 125000, masked: false },
          internalMargin: { value: null, masked: true },
        }),
      ]);
      const replay = await request(http.getHttpServer())
        .post("/api/v1/test/fnd02/fixtures")
        .set("Cookie", cookieHeader)
        .set("X-CSRF-Token", csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "fnd02-hook-create")
        .send(payload)
        .expect(201);
      expect(replay.body).toMatchObject({
        replayed: true,
        tenantA: created.body.tenantA,
      });
      expect(replay.body.actors.driverA.password).toBe("FixturePassword!234");
      const stored = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ response_json: unknown }>>(
          `SELECT response_json FROM app.idempotency_records WHERE operation='test.fnd02.fixture:PORTALS' AND key_hash=encode(digest($1,'sha256'),'hex')`,
          "fnd02-hook-create",
        ),
      );
      expect(JSON.stringify(stored[0]?.response_json)).not.toContain(
        "FixturePassword!234",
      );
      const mfaFixture = await request(http.getHttpServer())
        .post("/api/v1/test/fnd02/fixtures")
        .set("Cookie", cookieHeader)
        .set("X-CSRF-Token", csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "fnd02-hook-mfa")
        .send({ namespace: "HOOKM", scenario: "SCOPES_ONLY" })
        .expect(201);
      const policy = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ policy: string }>>(
          `SELECT value->>'mfaPolicy' AS policy FROM app.tenant_configuration WHERE tenant_id=$1::uuid AND namespace='security'`,
          mfaFixture.body.tenantA.id,
        ),
      );
      expect(policy[0]?.policy).toBe("OFF");
    });

    it("FND02-I-004/FND02-C-005/FND02-C-006: required MFA uses restricted session, AES-GCM, sequential TOTP and one-time recovery state", async () => {
      for (let attempt = 1; attempt <= 4; attempt++)
        await expect(
          app.login(
            "regional@test.local",
            "WrongPassword!234",
            "FND02-A",
            `fnd02-failed-${attempt}`,
          ),
        ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      let failureAlerts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM app.security_alerts WHERE tenant_id=$1::uuid AND alert_type='REPEATED_LOGIN_FAILURES'`,
          tenantA,
        ),
      );
      expect(failureAlerts[0]?.count).toBe(0);
      await expect(
        app.login(
          "regional@test.local",
          "WrongPassword!234",
          "FND02-A",
          "fnd02-failed-5",
        ),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      failureAlerts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number; occurrence_count: number }>>(
          `SELECT count(*)::int count,max(occurrence_count)::int occurrence_count FROM app.security_alerts WHERE tenant_id=$1::uuid AND alert_type='REPEATED_LOGIN_FAILURES'`,
          tenantA,
        ),
      );
      expect(failureAlerts[0]).toMatchObject({ count: 1, occurrence_count: 1 });
      await expect(
        app.login(
          "unknown-person@test.local",
          "WrongPassword!234",
          "FND02-A",
          "fnd02-unknown-failed",
        ),
      ).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
        message: "Email or password is incorrect",
      });
      await withTenant(app.db, tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value) VALUES($1::uuid,'security',1,'{"mfaPolicy":"ALL"}'::jsonb)`,
          tenantA,
        ),
      );
      const role = String(
        (
          await withTenant(app.db, tenantA, (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='CLIENT_VIEWER'`,
              tenantA,
            ),
          )
        )[0]!.id,
      );
      const invited = await access.invite(
        owner,
        {
          displayName: "MFA User",
          employeeCode: "MFA-001",
          mobile: "+919811111111",
          authenticationMethod: "LOCAL_PASSWORD",
          portalAudience: "CLIENT",
          assignments: [
            {
              roleId: role,
              grants: [{ scopeNodeId: alpha, actions: ["READ"] }],
            },
          ],
          expiresInHours: 72,
          reason: "Approved client portal MFA access",
        },
        "fnd02-mfa-invite",
        "fnd02-mfa-invite",
      );
      const accepted = await access.acceptInvitation(
        String(invited.invitationUrl).split("token=")[1]!,
        { displayName: "MFA User", password: "MfaUserPass!234" },
        "fnd02-mfa-accept",
      );
      expect(accepted.mfaRequired).toBe(true);
      await expect(app.session(accepted.sessionToken)).rejects.toMatchObject({
        code: "MFA_REQUIRED",
      });
      const restricted = await app.session(accepted.sessionToken, true);
      for (let attempt = 1; attempt <= 4; attempt++)
        await expect(
          access.challengeMfa(
            restricted,
            "000000",
            `fnd02-mfa-invalid-${attempt}`,
          ),
        ).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
      await expect(
        access.challengeMfa(restricted, "000000", "fnd02-mfa-invalid-5"),
      ).rejects.toMatchObject({ code: "MFA_THROTTLED", status: 429 });
      const mfaFailures = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ events: number; alerts: number }>>(
          `SELECT (SELECT count(*) FROM app.security_events WHERE tenant_id=$1::uuid AND event_type='MFA_CHALLENGE_FAILED')::int events,
                (SELECT count(*) FROM app.security_alerts WHERE tenant_id=$1::uuid AND alert_type='MFA_CHALLENGE_FAILED')::int alerts`,
          tenantA,
        ),
      );
      expect(mfaFailures[0]).toEqual({ events: 5, alerts: 1 });
      const setup = await access.setupMfa(restricted, "fnd02-mfa-setup");
      expect(String(setup.provisioningUri)).toContain("otpauth://totp/");
      expect(setup.testCodes).toHaveLength(2);
      const confirmed = await access.confirmMfa(
        restricted,
        String(setup.factorId),
        setup.testCodes as [string, string],
        "fnd02-mfa-confirm",
      );
      expect(confirmed.recoveryCodes).toHaveLength(10);
      await expect(app.session(accepted.sessionToken)).rejects.toMatchObject({
        code: "MFA_REQUIRED",
      });
      const acknowledged = await access.acknowledgeRecoveryCodes(
        restricted,
        String(setup.factorId),
        "fnd02-mfa-ack",
      );
      const full = await app.session(acknowledged.sessionToken);
      await expect(
        access.effective(full, "fnd02-mfa-full"),
      ).resolves.toMatchObject({ home: "/portal/client" });
      await expect(
        access.confirmMfa(
          restricted,
          String(setup.factorId),
          setup.testCodes as [string, string],
          "fnd02-mfa-reuse",
        ),
      ).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
      const factor = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ encrypted_secret: string }>>(
          `SELECT encrypted_secret FROM app.mfa_factors WHERE id=$1::uuid`,
          setup.factorId,
        ),
      );
      expect(factor[0]?.encrypted_secret.split(".")).toHaveLength(3);
      expect(factor[0]?.encrypted_secret).not.toContain("otpauth");
      const restrictedLogin = await app.login(
        "+919811111111",
        "MfaUserPass!234",
        "FND02-A",
        "fnd02-mfa-login-recovery",
      );
      if (!("sessionToken" in restrictedLogin))
        throw new Error("Expected restricted MFA login");
      expect(restrictedLogin.mfaRequired).toBe(true);
      const recoveryActor = await app.session(
        restrictedLogin.sessionToken,
        true,
      );
      const recovered = await access.recoverMfa(
        recoveryActor,
        confirmed.recoveryCodes[0]!,
        "fnd02-mfa-recovery",
      );
      await expect(app.session(recovered.sessionToken)).resolves.toMatchObject({
        assuranceLevel: "MFA",
      });
      const secondLogin = await app.login(
        "+919811111111",
        "MfaUserPass!234",
        "FND02-A",
        "fnd02-mfa-login-reuse",
      );
      if (!("sessionToken" in secondLogin))
        throw new Error("Expected second restricted login");
      await expect(
        access.recoverMfa(
          await app.session(secondLogin.sessionToken, true),
          confirmed.recoveryCodes[0]!,
          "fnd02-mfa-recovery-reuse",
        ),
      ).rejects.toMatchObject({ code: "MFA_CHALLENGE_INVALID" });
    });

    it("FND02-R-001/FND02-R-002/FND02-R-003/FND02-R-004/FND02-R-005: reports and alerts reconcile to canonical tenant rows", async () => {
      const users = await access.reports(owner, "users", "fnd02-report-users");
      const canonical = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM app.tenant_memberships WHERE tenant_id=$1::uuid`,
          tenantA,
        ),
      );
      expect(users.total).toBe(canonical[0]?.count);
      const roles = await access.reports(owner, "roles", "fnd02-report-roles");
      const canonicalRoles = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM app.roles WHERE tenant_id=$1::uuid`,
          tenantA,
        ),
      );
      expect(roles.total).toBe(canonicalRoles[0]?.count);
      const changes = await access.reports(
        owner,
        "permission-changes",
        "fnd02-report-changes",
      );
      expect(Array.isArray(changes.items)).toBe(true);
      const auditSearch = await access.reports(
        owner,
        "audit-log",
        "fnd02-report-audit-search",
        "replacement activation",
      );
      expect(auditSearch.items.length).toBeGreaterThan(0);
      expect(
        auditSearch.items.every((row) =>
          [row.action, row.targetType, row.reason, row.correlationId]
            .map(String)
            .join(" ")
            .toLowerCase()
            .includes("replacement activation"),
        ),
      ).toBe(true);
      await expect(
        access.reports(owner, "raw-json", "fnd02-report-unknown"),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      const alerts = await access.alerts(owner, "fnd02-report-alerts");
      const canonicalAlerts = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int count FROM app.security_alerts WHERE tenant_id=$1::uuid`,
          tenantA,
        ),
      );
      expect(alerts.total).toBe(canonicalAlerts[0]?.count);
      expect(
        alerts.items.some((row) => row.type === "REPEATED_LOGIN_FAILURES"),
      ).toBe(true);
      const failures = await access.reports(
        owner,
        "failed-logins",
        "fnd02-report-failures",
      );
      expect(
        failures.items.reduce((sum, row) => sum + Number(row.count), 0),
      ).toBe(5);
      const dormant = await access.reports(
        owner,
        "dormant",
        "fnd02-report-dormant",
      );
      expect(dormant.items.every((row) => "neverLoggedIn" in row)).toBe(true);
      expect(JSON.stringify({ users, roles, changes, alerts })).not.toContain(
        "RegionalPass!234",
      );
    });

    it("FND02-I-006 final-owner serialization prevents tenant lockout", async () => {
      const detail = (await access.userDetail(
        owner,
        ownerMembership,
        "fnd02-owner-detail",
      )) as Record<string, unknown>;
      await expect(
        access.lifecycle(
          owner,
          ownerMembership,
          Number(detail.version),
          "Attempt to remove the final active owner",
          "SUSPENDED",
          "fnd02-final-owner",
          "fnd02-final-owner",
        ),
      ).rejects.toMatchObject({ code: "FINAL_OWNER_REQUIRED" });
    });
  },
);
