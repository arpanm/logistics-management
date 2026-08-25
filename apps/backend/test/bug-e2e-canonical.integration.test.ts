import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantCreateSchema } from "@logistics/domain";
import { withTenant } from "@logistics/db";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { hash as passwordHash } from "argon2";
import { AppService } from "../src/app.service.js";
import { AlertsProvider } from "../src/modules/alerts/alerts.provider.js";
import { IntegrationsProvider } from "../src/modules/integrations/integrations.provider.js";
import { KernelService } from "../src/modules/kernel/kernel.service.js";
import { AppModule } from "../src/app.module.js";

const tenantInput = (code: string, owner: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Limited`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Canonical Road",
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
  "BUG-E2E canonical report, alert and integration paths",
  () => {
    const app = new AppService();
    const alerts = new AlertsProvider(app);
    const integrations = new IntegrationsProvider(app);
    const kernel = new KernelService(app, alerts, integrations);
    let platform: Awaited<ReturnType<AppService["session"]>>;
    let owner: Awaited<ReturnType<AppService["session"]>>;
    let ownerB: Awaited<ReturnType<AppService["session"]>>;
    let tenantId = "";
    let http: INestApplication;

    beforeAll(async () => {
      const login = await app.login(
        process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
        process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
        undefined,
        "bug-e2e-platform-login",
      );
      if (!("sessionToken" in login))
        throw new Error("Expected platform session");
      platform = await app.session(login.sessionToken);
      const tenant = await app.provision(
        platform,
        tenantInput("BUG-CANON", "bug-canon-owner@test.local"),
        "bug-canon-provision",
        "bug-canon-provision",
      );
      tenantId = String(tenant.tenant.id);
      const accepted = await app.acceptInvitation(
        String(tenant.invitationUrl).split("token=")[1]!,
        "Canonical Owner",
        "OwnerPassword!234",
        "bug-canon-accept",
      );
      owner = await app.session(accepted.sessionToken);
      const tenantB = await app.provision(
        platform,
        tenantInput("BUG-OTHER", "bug-other-owner@test.local"),
        "bug-other-provision",
        "bug-other-provision",
      );
      const acceptedB = await app.acceptInvitation(
        String(tenantB.invitationUrl).split("token=")[1]!,
        "Other Owner",
        "OwnerPassword!234",
        "bug-other-accept",
      );
      ownerB = await app.session(acceptedB.sessionToken);
      await withTenant(app.db, tenantId, async (tx) => {
        const user = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.users(email,display_name,password_hash) VALUES('bug-portal@test.local','Portal User',$1) RETURNING id`,
            await passwordHash("PortalPassword!234"),
          )
        )[0]!;
        const membership = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,portal_audience,status)
             VALUES($1::uuid,$2::uuid,'bug-portal@test.local','Portal User','BUG-PORTAL','VENDOR','ACTIVE') RETURNING id`,
            tenantId,
            user.id,
          )
        )[0]!;
        const role = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='VENDOR_OWNER'`,
            tenantId,
          )
        )[0]!;
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            tenantId,
            membership.id,
            role.id,
          )
        )[0]!;
        const root = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
            tenantId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action) VALUES($1::uuid,$2::uuid,$3::uuid,'READ')`,
          tenantId,
          assignment.id,
          root.id,
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

    it("BUG-E2E-001: platform totals and rows reconcile while provisioning commits concurrently", async () => {
      const provisions = Array.from({ length: 6 }, (_, index) =>
        app.provision(
          platform,
          tenantInput(`BUG-RPT-${index}`, `bug-report-${index}@test.local`),
          `bug-report-provision-${index}`,
          `bug-report-provision-${index}`,
        ),
      );
      const reports = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const report = await app.platformReport(platform);
          expect(report.totals.total).toBe(report.tenants.length);
          expect(report.totals.active).toBe(
            report.tenants.filter((tenant) => tenant.status === "ACTIVE")
              .length,
          );
          expect(report.totals.inactive).toBe(
            report.tenants.filter((tenant) => tenant.status === "INACTIVE")
              .length,
          );
          return report;
        }),
      );
      await Promise.all(provisions);
      expect(reports).toHaveLength(20);
      const final = await app.platformReport(platform);
      expect(final.totals.total).toBe(final.tenants.length);
    });

    it("BUG-E2E-008/009/010: supported alert creation is canonical, idempotent and version safe", async () => {
      const input = {
        code: "POD-BREACH-001",
        name: "Delayed POD",
        data: {
          type: "POD_OVERDUE",
          severity: "HIGH",
          summary: "POD crossed the configured SLA",
        },
      };
      const created = await kernel.create(
        owner,
        "alerts",
        "alert",
        input,
        "bug-alert-create",
        "bug-alert-create-key",
      );
      await expect(
        alerts.createOccurrence(
          owner,
          {
            code: "MISSING-KEY",
            title: "Missing key",
            type: "POD_OVERDUE",
            severity: "HIGH",
            summary: "Must not persist without a key",
          },
          "",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      const replay = await kernel.create(
        owner,
        "alerts",
        "alert",
        input,
        "bug-alert-create-replay",
        "bug-alert-create-key",
      );
      expect(replay).toMatchObject({ id: created.id, replayed: true });
      await expect(
        alerts.createOccurrence(
          owner,
          {
            code: input.code,
            title: input.name,
            type: "POD_OVERDUE",
            severity: "CRITICAL",
            summary: "Changed payload",
          },
          "bug-alert-create-key",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await alerts.queue(owner)).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.id, occurrenceCount: 1 }),
        ]),
      );

      const acknowledged = await alerts.act(
        owner,
        String(created.id),
        "ACKNOWLEDGE",
        { expectedVersion: Number(created.version) },
        "bug-alert-ack-key",
      );
      const acknowledgedReplay = await alerts.act(
        owner,
        String(created.id),
        "ACKNOWLEDGE",
        { expectedVersion: Number(created.version) },
        "bug-alert-ack-key",
      );
      expect(acknowledgedReplay).toMatchObject({
        id: created.id,
        state: "ACKNOWLEDGED",
        replayed: true,
      });
      await expect(
        alerts.act(
          owner,
          String(created.id),
          "RESOLVE",
          { reason: "POD received", expectedVersion: Number(created.version) },
          "bug-alert-stale-key",
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const resolved = await alerts.act(
        owner,
        String(created.id),
        "RESOLVE",
        {
          reason: "POD received and verified",
          expectedVersion: Number(acknowledged.version),
        },
        "bug-alert-resolve-key",
      );
      expect(resolved).toMatchObject({ state: "RESOLVED" });
      expect(
        await kernel.detail(owner, "alerts", "alert", String(created.id)),
      ).toMatchObject({
        id: created.id,
        status: "RESOLVED",
        version: resolved.version,
      });
      await expect(
        alerts.detail(ownerB, String(created.id)),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      const report = await alerts.report(owner);
      const queue = await alerts.queue(owner);
      expect(report.rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(
        queue.total,
      );
      const audits = await withTenant(app.db, tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ action: string; count: number }>>(
          `SELECT action,count(*)::int count FROM audit.audit_events
           WHERE tenant_id=$1::uuid AND target_id=$2::uuid AND action LIKE 'alert.%'
           GROUP BY action ORDER BY action`,
          tenantId,
          created.id,
        ),
      );
      expect(audits).toEqual([
        { action: "alert.acknowledge", count: 1 },
        { action: "alert.occurrence_recorded", count: 1 },
        { action: "alert.resolve", count: 1 },
      ]);
    });

    it("BUG-E2E-011/012: failed delivery, dead letter, replay and health share one canonical store", async () => {
      const endpoint = await integrations.createEndpoint(
        owner,
        {
          code: "BUG-WEBHOOK",
          type: "WEBHOOK",
          name: "Canonical webhook",
          environment: "test",
          endpoint: "https://example.test/events",
          credentialReference: "secret/bug-webhook",
          scopes: [],
          allowedEvents: ["trip.updated.v1", "trip.created.v1"],
          mappingVersion: 1,
        },
        "bug-endpoint-create-key",
      );
      await expect(
        integrations.createEndpoint(
          owner,
          {
            code: "NO-KEY",
            type: "WEBHOOK",
            name: "Missing key endpoint",
            environment: "test",
            scopes: [],
            allowedEvents: [],
            mappingVersion: 1,
          },
          "",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      const input = {
        code: "DELIVERY-BUG-001",
        name: "Failed outbound delivery",
        data: {
          endpointId: String(endpoint.id),
          direction: "OUTBOUND",
          eventType: "trip.updated.v1",
          payload: { tripId: "TRIP-001", secret: "must-not-persist" },
          expectedVersion: 1,
        },
      };
      const failed = await kernel.create(
        owner,
        "integrations",
        "delivery",
        input,
        "bug-delivery-failed",
        "bug-delivery-failed-key",
      );
      const duplicate = await kernel.create(
        owner,
        "integrations",
        "delivery",
        input,
        "bug-delivery-failed-retry",
        "bug-delivery-failed-key",
      );
      expect(duplicate).toMatchObject({ id: failed.id, replayed: true });
      expect(await integrations.deadLetters(owner)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: failed.id,
            deliveryId: failed.id,
            replayCount: 0,
          }),
        ]),
      );
      const replay = await integrations.replay(
        owner,
        String(failed.id),
        "Remote endpoint recovered",
        "bug-dead-letter-replay-key",
        Number(failed.version),
      );
      expect(replay).toMatchObject({ id: failed.id, replayCount: 1 });
      const replayRetry = await integrations.replay(
        owner,
        String(failed.id),
        "Remote endpoint recovered",
        "bug-dead-letter-replay-key",
        Number(failed.version),
      );
      expect(replayRetry).toMatchObject({
        id: failed.id,
        replayCount: 1,
        replayed: true,
      });
      const afterReplay = await integrations.deliveryDetail(
        owner,
        String(failed.id),
      );
      const failedAgain = await kernel.create(
        owner,
        "integrations",
        "delivery",
        {
          ...input,
          data: {
            ...input.data,
            expectedVersion: Number(afterReplay.version),
          },
        },
        "bug-delivery-failed-again",
        "bug-delivery-failed-again-key",
      );
      expect(failedAgain).toMatchObject({ status: "DEAD_LETTER", attempts: 2 });
      const replayAgain = await integrations.replay(
        owner,
        String(failed.id),
        "Remote endpoint recovered again",
        "bug-dead-letter-replay-again-key",
        Number(failedAgain.version),
      );
      expect(replayAgain).toMatchObject({ replayCount: 2 });
      await expect(
        integrations.replay(
          ownerB,
          String(failed.id),
          "Foreign replay attempt",
          "bug-foreign-replay-key",
          Number(failedAgain.version),
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      const current = await integrations.deliveryDetail(
        owner,
        String(failed.id),
      );
      for (const [key, changed] of [
        ["direction", { direction: "INBOUND" as const }],
        ["eventType", { eventType: "trip.created.v1" }],
        ["mappingVersion", { mappingVersion: 2 }],
      ] as const) {
        await expect(
          kernel.create(
            owner,
            "integrations",
            "delivery",
            {
              ...input,
              data: {
                ...input.data,
                ...changed,
                expectedVersion: Number(current.version),
              },
            },
            `bug-delivery-immutable-${key}`,
            `bug-delivery-immutable-${key}-key`,
          ),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      }
      await expect(
        kernel.create(
          owner,
          "integrations",
          "delivery",
          {
            ...input,
            data: {
              ...input.data,
              expectedVersion: Number(current.version) - 1,
            },
          },
          "bug-delivery-stale-failure",
          "bug-delivery-stale-failure-key",
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const concurrencyStart = await kernel.create(
        owner,
        "integrations",
        "delivery",
        {
          ...input,
          data: {
            ...input.data,
            expectedVersion: Number(current.version),
          },
        },
        "bug-delivery-concurrency-start",
        "bug-delivery-concurrency-start-key",
      );
      await expect(
        integrations.replay(
          owner,
          String(failed.id),
          "Stale recovery attempt",
          "bug-delivery-stale-replay-key",
          Number(current.version),
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const concurrent = await Promise.allSettled([
        kernel.create(
          owner,
          "integrations",
          "delivery",
          {
            ...input,
            data: {
              ...input.data,
              expectedVersion: Number(concurrencyStart.version),
            },
          },
          "bug-delivery-concurrent-failure",
          "bug-delivery-concurrent-failure-key",
        ),
        integrations.replay(
          owner,
          String(failed.id),
          "Concurrent recovery attempt",
          "bug-delivery-concurrent-replay-key",
          Number(concurrencyStart.version),
        ),
      ]);
      expect(concurrent[1]?.status).toBe("fulfilled");
      expect(concurrent[0]?.status).toBe("rejected");
      if (concurrent[0]?.status === "rejected") {
        const reason = concurrent[0].reason as {
          code?: string;
          status?: number;
        };
        expect(reason.status).not.toBe(500);
        expect(["DELIVERY_STATE_CONFLICT", "VERSION_CONFLICT"]).toContain(
          reason.code,
        );
      }
      const afterConcurrent = await integrations.deliveryDetail(
        owner,
        String(failed.id),
      );
      expect(afterConcurrent).toMatchObject({
        status: "PENDING",
        version: Number(concurrencyStart.version) + 1,
      });
      const deliveries = await integrations.deliveries(owner);
      expect(deliveries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: failed.id, state: "PENDING" }),
        ]),
      );
      const health = await integrations.health(owner);
      expect(health.find((row) => row.id === endpoint.id)).toMatchObject({
        deliveries: 1,
        failed: 0,
        deadLetters: 0,
      });
      expect(JSON.stringify(deliveries)).not.toContain("must-not-persist");
      const persisted = await withTenant(app.db, tenantId, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ leaked: boolean; audits: number; endpointAudits: number }>
        >(
          `SELECT EXISTS(
             SELECT 1 FROM app.idempotency_records WHERE tenant_id=$1::uuid AND response_json::text LIKE '%must-not-persist%'
             UNION ALL SELECT 1 FROM app.integration_dead_letters WHERE tenant_id=$1::uuid AND safe_error LIKE '%must-not-persist%'
           ) leaked,
           (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_id=$2::uuid
             AND action IN ('integration.delivery_failed','integration.dead_letter_replayed')) audits,
           (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_id=$3::uuid
             AND action='integration.endpoint_created') "endpointAudits"`,
          tenantId,
          failed.id,
          endpoint.id,
        ),
      );
      expect(persisted[0]).toEqual({
        leaked: false,
        audits: 6,
        endpointAudits: 1,
      });
    });

    it("BUG-E2E-008..012 HTTP: auth, CSRF, idempotency, isolation and canonical adapter contracts", async () => {
      const login = async (
        identifier: string,
        password: string,
        tenantCode: string,
      ) => {
        const response = await request(http.getHttpServer())
          .post("/api/v1/auth/login")
          .send({ identifier, password, tenantCode });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const cookies = response.headers["set-cookie"] as unknown as string[];
        return {
          cookie: cookies.map((item) => item.split(";")[0]).join("; "),
          csrf: decodeURIComponent(
            cookies
              .find((item) => item.startsWith("logistics_csrf="))!
              .split(";")[0]!
              .split("=")
              .slice(1)
              .join("="),
          ),
        };
      };
      const ownerSession = await login(
        "bug-canon-owner@test.local",
        "OwnerPassword!234",
        "BUG-CANON",
      );
      const mutation = (path: string) =>
        request(http.getHttpServer())
          .post(path)
          .set("Cookie", ownerSession.cookie)
          .set("X-CSRF-Token", ownerSession.csrf)
          .set("Origin", "http://127.0.0.1:3000");
      const alertPayload = {
        code: "HTTP-ALERT",
        name: "HTTP alert",
        data: {
          type: "POD_OVERDUE",
          severity: "HIGH",
          summary: "HTTP canonical alert",
        },
      };
      await request(http.getHttpServer())
        .get("/api/v1/modules/alerts/alert")
        .expect(401);
      await request(http.getHttpServer())
        .post("/api/v1/modules/alerts/alert")
        .set("Cookie", ownerSession.cookie)
        .set("Idempotency-Key", "http-alert-no-csrf")
        .send(alertPayload)
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe("CSRF_INVALID"));
      const missingAlertKey = await mutation(
        "/api/v1/modules/alerts/alert",
      ).send(alertPayload);
      expect(missingAlertKey.status, JSON.stringify(missingAlertKey.body)).toBe(
        400,
      );
      expect(missingAlertKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const created = await mutation("/api/v1/modules/alerts/alert")
        .set("Idempotency-Key", "http-alert-create-key")
        .send(alertPayload);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const reordered = await mutation("/api/v1/modules/alerts/alert")
        .set("Idempotency-Key", "http-alert-create-key")
        .send({
          data: {
            summary: "HTTP canonical alert",
            severity: "HIGH",
            type: "POD_OVERDUE",
          },
          name: "HTTP alert",
          code: "HTTP-ALERT",
        });
      expect(reordered.status).toBe(201);
      expect(reordered.body).toMatchObject({
        id: created.body.id,
        replayed: true,
      });
      await mutation("/api/v1/modules/alerts/alert")
        .set("Idempotency-Key", "http-alert-create-key")
        .send({
          ...alertPayload,
          data: { ...alertPayload.data, summary: "Changed input" },
        })
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe("IDEMPOTENCY_CONFLICT"));
      await mutation(`/api/v1/tenant/alerts/${created.body.id}/actions`)
        .send({ action: "ACKNOWLEDGE", expectedVersion: created.body.version })
        .expect(400)
        .expect(({ body }) =>
          expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED"),
        );
      const acknowledged = await mutation(
        `/api/v1/tenant/alerts/${created.body.id}/actions`,
      )
        .set("Idempotency-Key", "http-alert-action-key")
        .send({ action: "ACKNOWLEDGE", expectedVersion: created.body.version });
      expect(acknowledged.status).toBe(200);
      const acknowledgedReplay = await mutation(
        `/api/v1/tenant/alerts/${created.body.id}/actions`,
      )
        .set("Idempotency-Key", "http-alert-action-key")
        .send({ action: "ACKNOWLEDGE", expectedVersion: created.body.version });
      expect(acknowledgedReplay.body).toMatchObject({
        id: created.body.id,
        replayed: true,
      });

      const concurrentPayload = {
        ...alertPayload,
        code: "HTTP-CONCURRENT",
        name: "Concurrent alert",
      };
      const concurrent = await Promise.all([
        mutation("/api/v1/modules/alerts/alert")
          .set("Idempotency-Key", "http-alert-concurrent-key")
          .send(concurrentPayload),
        mutation("/api/v1/modules/alerts/alert")
          .set("Idempotency-Key", "http-alert-concurrent-key")
          .send(concurrentPayload),
      ]);
      expect(concurrent.map((item) => item.status)).toEqual([201, 201]);
      expect(concurrent[0]!.body.id).toBe(concurrent[1]!.body.id);

      const detail = await request(http.getHttpServer())
        .get(`/api/v1/modules/alerts/alert/${created.body.id}`)
        .set("Cookie", ownerSession.cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(created.body.id);
      const list = await request(http.getHttpServer())
        .get("/api/v1/modules/alerts/alert")
        .set("Cookie", ownerSession.cookie);
      const report = await request(http.getHttpServer())
        .get("/api/v1/modules/alerts/alert/report")
        .set("Cookie", ownerSession.cookie);
      expect(list.status).toBe(200);
      expect(report.status).toBe(200);
      expect(
        report.body.rows.reduce(
          (sum: number, row: { count: number }) => sum + Number(row.count),
          0,
        ),
      ).toBe(list.body.total);
      await request(http.getHttpServer())
        .patch(`/api/v1/modules/alerts/alert/${created.body.id}`)
        .set("Cookie", ownerSession.cookie)
        .set("X-CSRF-Token", ownerSession.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "http-alert-patch-key")
        .send({ expectedVersion: created.body.version, name: "Unsupported" })
        .expect(405)
        .expect(({ body }) => expect(body.code).toBe("METHOD_NOT_ALLOWED"));

      const portal = await login(
        "bug-portal@test.local",
        "PortalPassword!234",
        "BUG-CANON",
      );
      await request(http.getHttpServer())
        .get("/api/v1/modules/alerts/alert")
        .set("Cookie", portal.cookie)
        .expect(403);
      const other = await login(
        "bug-other-owner@test.local",
        "OwnerPassword!234",
        "BUG-OTHER",
      );
      await request(http.getHttpServer())
        .get(`/api/v1/modules/alerts/alert/${created.body.id}`)
        .set("Cookie", other.cookie)
        .expect(404);
      const otherCreated = await request(http.getHttpServer())
        .post("/api/v1/modules/alerts/alert")
        .set("Cookie", other.cookie)
        .set("X-CSRF-Token", other.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "http-alert-create-key")
        .send(alertPayload);
      expect(otherCreated.status).toBe(201);
      expect(otherCreated.body.id).not.toBe(created.body.id);

      const endpointPayload = {
        code: "HTTP-HOOK",
        type: "WEBHOOK",
        name: "HTTP webhook",
        environment: "test",
        endpoint: "https://example.test/hook",
        scopes: [],
        allowedEvents: ["trip.updated.v1"],
        mappingVersion: 1,
      };
      await mutation("/api/v1/tenant/integrations")
        .send(endpointPayload)
        .expect(400)
        .expect(({ body }) =>
          expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED"),
        );
      const endpoint = await mutation("/api/v1/tenant/integrations")
        .set("Idempotency-Key", "http-endpoint-create-key")
        .send(endpointPayload);
      expect(endpoint.status).toBe(201);
      const deliveryPayload = {
        code: "HTTP-DELIVERY",
        name: "HTTP failed delivery",
        data: {
          endpointId: endpoint.body.id,
          direction: "OUTBOUND",
          eventType: "trip.updated.v1",
          expectedVersion: 1,
          payload: { secret: "http-secret-not-stored" },
        },
      };
      await request(http.getHttpServer())
        .get("/api/v1/modules/integrations/delivery")
        .set("Cookie", portal.cookie)
        .expect(403);
      await request(http.getHttpServer())
        .post("/api/v1/modules/integrations/delivery")
        .set("Cookie", portal.cookie)
        .set("X-CSRF-Token", portal.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "http-portal-delivery-create-key")
        .send(deliveryPayload)
        .expect(403);
      await mutation("/api/v1/modules/integrations/delivery")
        .send(deliveryPayload)
        .expect(400)
        .expect(({ body }) =>
          expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED"),
        );
      const delivery = await mutation("/api/v1/modules/integrations/delivery")
        .set("Idempotency-Key", "http-delivery-fail-key")
        .send(deliveryPayload);
      expect(delivery.status, JSON.stringify(delivery.body)).toBe(201);
      const deliveryDetail = await request(http.getHttpServer())
        .get(`/api/v1/modules/integrations/delivery/${delivery.body.id}`)
        .set("Cookie", ownerSession.cookie);
      const deliveryList = await request(http.getHttpServer())
        .get("/api/v1/modules/integrations/delivery")
        .set("Cookie", ownerSession.cookie);
      const deliveryReport = await request(http.getHttpServer())
        .get("/api/v1/modules/integrations/delivery/report")
        .set("Cookie", ownerSession.cookie);
      expect(deliveryDetail.body).toMatchObject({
        id: delivery.body.id,
        status: "DEAD_LETTER",
      });
      expect(
        deliveryList.body.items.some(
          (item: { id: string }) => item.id === delivery.body.id,
        ),
      ).toBe(true);
      expect(
        deliveryReport.body.rows.reduce(
          (sum: number, row: { count: number }) => sum + Number(row.count),
          0,
        ),
      ).toBe(deliveryList.body.total);
      await request(http.getHttpServer())
        .patch(`/api/v1/modules/integrations/delivery/${delivery.body.id}`)
        .set("Cookie", ownerSession.cookie)
        .set("X-CSRF-Token", ownerSession.csrf)
        .set("Origin", "http://127.0.0.1:3000")
        .set("Idempotency-Key", "http-delivery-patch-key")
        .send({ expectedVersion: delivery.body.version, name: "Unsupported" })
        .expect(405);
      await request(http.getHttpServer())
        .get(`/api/v1/modules/integrations/delivery/${delivery.body.id}`)
        .set("Cookie", other.cookie)
        .expect(404);
      await request(http.getHttpServer())
        .post(
          `/api/v1/tenant/integrations/dead-letters/${delivery.body.id}/replay`,
        )
        .set("Cookie", ownerSession.cookie)
        .set("Idempotency-Key", "http-delivery-replay-no-csrf")
        .send({
          reason: "Remote service recovered",
          expectedVersion: delivery.body.version,
        })
        .expect(403)
        .expect(({ body }) => expect(body.code).toBe("CSRF_INVALID"));
      await mutation(
        `/api/v1/tenant/integrations/dead-letters/${delivery.body.id}/replay`,
      )
        .send({
          reason: "Remote service recovered",
          expectedVersion: delivery.body.version,
        })
        .expect(400)
        .expect(({ body }) =>
          expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED"),
        );
      const replayDelivery = await mutation(
        `/api/v1/tenant/integrations/dead-letters/${delivery.body.id}/replay`,
      )
        .set("Idempotency-Key", "http-delivery-replay-key")
        .send({
          reason: "Remote service recovered",
          expectedVersion: delivery.body.version,
        });
      expect(replayDelivery.status).toBe(200);
      expect(replayDelivery.body).toMatchObject({ replayCount: 1 });
    });
  },
);
