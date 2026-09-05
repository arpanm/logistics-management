import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { tenantCreateSchema } from "@logistics/domain";
import { withPlatform, withTenant } from "@logistics/db";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppService } from "../src/app.service.js";
import { AppModule } from "../src/app.module.js";
import { resolveUniqueConversationReference } from "../src/modules/conversation/conversation-commands.js";
import { ConversationService } from "../src/modules/conversation/conversation.service.js";

describe.sequential(
  "INT-02 conversational tenant isolation and idempotency integration — Implemented / Not Run",
  () => {
    const app = new AppService();
    const conversation = new ConversationService(app, {} as never, {} as never);
    let ownerA: Awaited<ReturnType<AppService["session"]>>;
    let ownerB: Awaited<ReturnType<AppService["session"]>>;
    let tenantA = "";
    let tenantB = "";
    let tenantCodeA = "";
    let ownerEmailA = "";
    let http: INestApplication;

    const tenantInput = async (code: string, email: string) => {
      const locality = await withPlatform(app.db, async (tx) =>
        tx.$queryRawUnsafe<
          Array<{ id: string; postal_code: string; country: string }>
        >(
          `SELECT l.id,l.postal_code,l.country
           FROM postal_reference.postal_localities l
           JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id
           WHERE v.active AND v.status='ACTIVE' AND l.active AND l.country='IN'
           ORDER BY l.postal_code,l.id LIMIT 1`,
        ),
      );
      if (!locality[0]) throw new Error("Active postal fixture is required");
      return tenantCreateSchema.parse({
        name: `${code} Logistics`,
        code,
        legalName: `${code} Logistics Limited`,
        taxIdentifier: `TAX-${code}`,
        address: {
          line1: "1 Conversation Test Road",
          line2: "",
          postalCode: locality[0].postal_code,
          postalLocalityId: locality[0].id,
          country: locality[0].country,
        },
        timezone: "Asia/Kolkata",
        locale: "en-IN",
        currency: "INR",
        fiscalYearStart: { month: 4, day: 1 },
        legalEntity: { name: `${code} Entity`, code },
        support: {
          name: "Support",
          email: `${code.toLowerCase()}-support@test.local`,
        },
        owner: { name: `${code} Owner`, email },
        branding: {
          shortName: code,
          primaryColor: "#16324F",
          accentColor: "#D97706",
        },
        active: true,
      });
    };

    beforeAll(async () => {
      const platformLogin = await app.login(
        process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
        process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        undefined,
        "int02-platform-login",
      );
      if (!("sessionToken" in platformLogin))
        throw new Error("Expected platform session");
      const platform = await app.session(platformLogin.sessionToken);
      const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
      const codeA = `CVA${suffix}`;
      const codeB = `CVB${suffix}`;
      tenantCodeA = codeA;
      ownerEmailA = `int02-owner-a-${suffix}@test.local`;
      const provisionedA = await app.provision(
        platform,
        await tenantInput(codeA, ownerEmailA),
        `int02-provision-a-${suffix}`,
        `int02-provision-a-${suffix}`,
      );
      const provisionedB = await app.provision(
        platform,
        await tenantInput(codeB, `int02-owner-b-${suffix}@test.local`),
        `int02-provision-b-${suffix}`,
        `int02-provision-b-${suffix}`,
      );
      tenantA = String(provisionedA.tenant.id);
      tenantB = String(provisionedB.tenant.id);
      const acceptedA = await app.acceptInvitation(
        String(provisionedA.invitationUrl).split("token=")[1]!,
        "Conversation Owner A",
        "ConversationOwner!234",
        `int02-accept-a-${suffix}`,
      );
      const acceptedB = await app.acceptInvitation(
        String(provisionedB.invitationUrl).split("token=")[1]!,
        "Conversation Owner B",
        "ConversationOwner!234",
        `int02-accept-b-${suffix}`,
      );
      ownerA = await app.session(acceptedA.sessionToken);
      ownerB = await app.session(acceptedB.sessionToken);
      http = await NestFactory.create(AppModule, { logger: false });
      http.setGlobalPrefix("api/v1");
      http.use(cookieParser());
      await http.init();
    });

    afterAll(async () => {
      await http.close();
      await app.onModuleDestroy();
    });

    const httpSession = async () => {
      const login = await request(http.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          identifier: ownerEmailA,
          password: "ConversationOwner!234",
          tenantCode: tenantCodeA,
        });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const cookies = login.headers["set-cookie"] as unknown as string[];
      return {
        cookie: cookies.map((value) => value.split(";")[0]).join("; "),
        csrf: decodeURIComponent(
          cookies
            .find((value) => value.startsWith("logistics_csrf="))!
            .split(";")[0]!
            .split("=")
            .slice(1)
            .join("="),
        ),
      };
    };

    it("INT02-API-SEC-001: isolates threads and references across two tenants", async () => {
      const created = await conversation.create(
        ownerA,
        { title: "Tenant A private thread" },
        "int02-thread-tenant-a",
      );
      await expect(
        conversation.detail(ownerB, String(created.id)),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

      const foreignVendor = await withTenant(app.db, tenantB, async (tx) => {
        const scope = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.authorization_scope_nodes
             WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
            tenantB,
          )
        )[0]!;
        return (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.vendors(tenant_id,code,legal_name,authorization_scope_node_id)
             VALUES($1::uuid,'FOREIGN-INT02','Foreign Tenant Vendor',$2::uuid)
             RETURNING id`,
            tenantB,
            scope.id,
          )
        )[0]!;
      });
      await withTenant(app.db, tenantA, async (tx) => {
        await expect(
          resolveUniqueConversationReference(
            tx,
            ownerA,
            "vendor",
            foreignVendor.id,
          ),
        ).rejects.toMatchObject({ status: 404, code: "REFERENCE_NOT_FOUND" });
      });
    });

    it("INT02-IDEM-001: replays browser message and confirmation exactly once", async () => {
      const thread = await conversation.create(
        ownerA,
        { title: "Idempotent browser commands" },
        "int02-idempotent-thread",
      );
      const firstMessage = await conversation.submit(
        ownerA,
        String(thread.id),
        { text: "create probe label Conversation Security", attachments: [] },
        "int02-idempotent-message-first",
        "int02-idempotent-message-key",
      );
      const replayedMessage = await conversation.submit(
        ownerA,
        String(thread.id),
        { text: "create probe label Conversation Security", attachments: [] },
        "int02-idempotent-message-replay",
        "int02-idempotent-message-key",
      );
      expect(replayedMessage).toMatchObject({
        replayed: true,
        message: { id: firstMessage.message.id },
      });
      const proposal = firstMessage.proposal;
      if (!proposal) throw new Error("Expected a command proposal");
      const firstConfirmation = await conversation.confirm(
        ownerA,
        String(proposal.id),
        Number(proposal.version),
        "int02-confirmation-key",
        "int02-confirmation-first",
      );
      const replayedConfirmation = await conversation.confirm(
        ownerA,
        String(proposal.id),
        Number(proposal.version),
        "int02-confirmation-key",
        "int02-confirmation-replay",
      );
      expect(replayedConfirmation).toMatchObject({
        replayed: true,
        execution: { id: firstConfirmation.execution.id },
      });
      const rows = await withTenant(app.db, tenantA, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::int AS count FROM app.authorization_probe_records
           WHERE tenant_id=$1::uuid AND label='Conversation Security'`,
          tenantA,
        ),
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("INT02-API-001: exposes create/list/message/confirm/cancel with CSRF and version contracts", async () => {
      const session = await httpSession();
      await request(http.getHttpServer())
        .post("/api/v1/conversations/threads")
        .set("Cookie", session.cookie)
        .set("Idempotency-Key", "int02-http-missing-csrf")
        .send({ title: "Rejected without CSRF" })
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe("CSRF_INVALID"));

      const created = await request(http.getHttpServer())
        .post("/api/v1/conversations/threads")
        .set("Cookie", session.cookie)
        .set("X-CSRF-Token", session.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "int02-http-create-thread")
        .send({ title: "HTTP conversation contract" })
        .expect(201);
      const listed = await request(http.getHttpServer())
        .get("/api/v1/conversations/threads")
        .set("Cookie", session.cookie)
        .expect(200);
      expect(listed.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.body.id }),
        ]),
      );

      const cancellable = await request(http.getHttpServer())
        .post(`/api/v1/conversations/threads/${created.body.id}/messages`)
        .set("Cookie", session.cookie)
        .set("X-CSRF-Token", session.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "int02-http-cancel-message")
        .send({ text: "create probe label HTTP Cancelled", attachments: [] })
        .expect(201);
      await request(http.getHttpServer())
        .post(
          `/api/v1/conversations/proposals/${cancellable.body.proposal.id}/cancel`,
        )
        .set("Cookie", session.cookie)
        .set("X-CSRF-Token", session.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .send({ expectedVersion: cancellable.body.proposal.version })
        .expect(200)
        .expect(({ body }) => expect(body.proposal.state).toBe("CANCELLED"));

      const confirmable = await request(http.getHttpServer())
        .post(`/api/v1/conversations/threads/${created.body.id}/messages`)
        .set("Cookie", session.cookie)
        .set("X-CSRF-Token", session.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "int02-http-confirm-message")
        .send({ text: "create probe label HTTP Confirmed", attachments: [] })
        .expect(201);
      await request(http.getHttpServer())
        .post(
          `/api/v1/conversations/proposals/${confirmable.body.proposal.id}/confirm`,
        )
        .set("Cookie", session.cookie)
        .set("X-CSRF-Token", session.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "int02-http-confirm-proposal")
        .send({ expectedVersion: confirmable.body.proposal.version })
        .expect(200)
        .expect(({ body }) => expect(body.proposal.state).toBe("EXECUTED"));
    });

    it("INT02-AUTH-002: limits a scoped role and requires explicit tenant selection for a shared identity", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
      const scoped = await withPlatform(app.db, async (tx) => {
        const root = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.authorization_scope_nodes
             WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
            tenantA,
          )
        )[0]!;
        const north = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id)
             VALUES($1::uuid,'REGION',$2,$3,$4::uuid) RETURNING id`,
            tenantA,
            `N-${suffix}`,
            `North ${suffix}`,
            root.id,
          )
        )[0]!;
        const south = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id)
             VALUES($1::uuid,'REGION',$2,$3,$4::uuid) RETURNING id`,
            tenantA,
            `S-${suffix}`,
            `South ${suffix}`,
            root.id,
          )
        )[0]!;
        const northVendor = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.vendors(tenant_id,code,legal_name,authorization_scope_node_id)
             VALUES($1::uuid,$2,$3,$4::uuid) RETURNING id`,
            tenantA,
            `NV-${suffix}`,
            `North Vendor ${suffix}`,
            north.id,
          )
        )[0]!;
        const southVendor = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.vendors(tenant_id,code,legal_name,authorization_scope_node_id)
             VALUES($1::uuid,$2,$3,$4::uuid) RETURNING id`,
            tenantA,
            `SV-${suffix}`,
            `South Vendor ${suffix}`,
            south.id,
          )
        )[0]!;
        const passwordHash = await argon2.hash("ScopedOperator!234", {
          type: argon2.argon2id,
        });
        const user = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.users(email,display_name,password_hash)
             VALUES($1,$2,$3) RETURNING id`,
            `int02-scoped-${suffix}@test.local`,
            "INT-02 Scoped Operator",
            passwordHash,
          )
        )[0]!;
        const membership = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
             VALUES($1::uuid,$2::uuid,$3,$4,$5,'ACTIVE') RETURNING id`,
            tenantA,
            user.id,
            `int02-scoped-${suffix}@test.local`,
            "INT-02 Scoped Operator",
            `SC-${suffix}`,
          )
        )[0]!;
        const role = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='REGIONAL_MANAGER'`,
            tenantA,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
           VALUES($1::uuid,$2::uuid,'conversation.use') ON CONFLICT DO NOTHING`,
          tenantA,
          role.id,
        );
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id)
             VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            tenantA,
            membership.id,
            role.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
           VALUES($1::uuid,$2::uuid,$3::uuid,'READ')`,
          tenantA,
          assignment.id,
          north.id,
        );
        const session = await app.newSession(tx, user.id, tenantA);
        return { northVendor, southVendor, session };
      });
      const scopedActor = await app.session(scoped.session.sessionToken);
      await withTenant(app.db, tenantA, async (tx) => {
        await expect(
          resolveUniqueConversationReference(
            tx,
            scopedActor,
            "vendor",
            scoped.northVendor.id,
          ),
        ).resolves.toMatchObject({ id: scoped.northVendor.id });
        await expect(
          resolveUniqueConversationReference(
            tx,
            scopedActor,
            "vendor",
            scoped.southVendor.id,
          ),
        ).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
      });

      const platformLogin = await app.login(
        process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
        process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        undefined,
        `int02-shared-platform-${suffix}`,
      );
      if (!("sessionToken" in platformLogin))
        throw new Error("Expected platform session");
      const third = await app.provision(
        await app.session(platformLogin.sessionToken),
        await tenantInput(
          `CVC${suffix.slice(0, 6).toUpperCase()}`,
          ownerEmailA,
        ),
        `int02-shared-provision-${suffix}`,
        `int02-shared-provision-${suffix}`,
      );
      await app.acceptInvitation(
        String(third.invitationUrl).split("token=")[1]!,
        "Conversation Owner A",
        "ConversationOwner!234",
        `int02-shared-accept-${suffix}`,
      );
      await expect(
        app.login(
          ownerEmailA,
          "ConversationOwner!234",
          undefined,
          `int02-shared-login-${suffix}`,
        ),
      ).resolves.toMatchObject({ requiresTenantSelection: true });
    });

    it("INT02-WA-009: links a challenge and treats a revoked binding as unlinked", async () => {
      Object.assign(app.config, {
        WHATSAPP_PROVIDER: "meta",
        WHATSAPP_ADDRESS_PEPPER: "p".repeat(32),
        WHATSAPP_ADDRESS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      });
      const challenge = await conversation.createWhatsappChallenge(ownerB);
      const mobile = "+919876543210";
      await expect(
        conversation.acceptWhatsapp(
          "wamid.link",
          mobile,
          `LINK ${challenge.code}`,
          "a".repeat(64),
          "int02-whatsapp-link",
        ),
      ).resolves.toMatchObject({ linked: true });
      await withPlatform(app.db, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE app.whatsapp_bindings SET state='REVOKED',revoked_at=now()
           WHERE tenant_id=$1::uuid AND membership_id=$2::uuid`,
          tenantB,
          ownerB.membershipId,
        ),
      );
      await expect(
        conversation.acceptWhatsapp(
          "wamid.revoked",
          mobile,
          "show status",
          "b".repeat(64),
          "int02-whatsapp-revoked",
        ),
      ).rejects.toMatchObject({ code: "WHATSAPP_NOT_LINKED" });
    });

    it("INT02-AUTH-001: revalidates membership state after session issuance", async () => {
      await withPlatform(app.db, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE app.tenant_memberships SET status='SUSPENDED',auth_version=auth_version+1
           WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantA,
          ownerA.membershipId,
        ),
      );
      await expect(conversation.list(ownerA)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("INT02-MIG-001: enforces RLS and immutable provider receipts", async () => {
      const rows = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            relname: string;
            relforcerowsecurity: boolean;
            policies: number;
          }>
        >(
          `SELECT c.relname,c.relforcerowsecurity,count(p.policyname)::int AS policies
           FROM pg_class c
           JOIN pg_namespace n ON n.oid=c.relnamespace
           LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
           WHERE n.nspname='app' AND c.relname IN (
             'conversation_threads','conversation_messages','conversation_proposals',
             'conversation_executions','whatsapp_bindings','whatsapp_channel_preferences',
             'conversation_channel_deliveries'
           )
           GROUP BY c.relname,c.relforcerowsecurity`,
        ),
      );
      expect(rows).toHaveLength(7);
      expect(
        rows.every((row) => row.relforcerowsecurity && row.policies > 0),
      ).toBe(true);
      const receiptTrigger = await withPlatform(app.db, (tx) =>
        tx.$queryRawUnsafe<Array<{ enabled: boolean }>>(
          `SELECT t.tgenabled<>'D' AS enabled FROM pg_trigger t
           JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='app' AND c.relname='conversation_provider_receipts'
             AND t.tgname='conversation_provider_receipts_immutable'`,
        ),
      );
      expect(receiptTrigger).toEqual([{ enabled: true }]);
    });
  },
);
