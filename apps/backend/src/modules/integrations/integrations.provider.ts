import { Inject, Injectable } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { withTenant } from "@logistics/db";
import type { Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";
import {
  canonicalJson,
  sha256,
  tenantKeyHash,
} from "../control/idempotency.js";

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;

@Injectable()
export class IntegrationsProvider {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private async assertInternal(tx: Tx, actor: TenantActor, id: string) {
    const member = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT status,portal_audience AS audience FROM app.tenant_memberships
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND user_id=$3::uuid`,
        id,
        actor.membershipId,
        actor.userId,
      )
    )[0];
    if (member?.status !== "ACTIVE" || member.audience !== "INTERNAL")
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  private validateDelivery(input: {
    endpointId: string;
    direction: string;
    eventId: string;
    eventType: string;
    mappingVersion: number;
    payload: unknown;
  }) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.endpointId,
      ) ||
      !["INBOUND", "OUTBOUND"].includes(input.direction) ||
      input.eventId.length < 2 ||
      input.eventId.length > 120 ||
      input.eventType.length < 2 ||
      input.eventType.length > 120 ||
      !Number.isInteger(input.mappingVersion) ||
      input.mappingVersion < 1 ||
      Buffer.byteLength(canonicalJson(input.payload), "utf8") > 16_384
    )
      throw new AppError(400, "VALIDATION_FAILED", "Delivery input is invalid");
  }

  private async idempotent(
    tx: Tx,
    actor: TenantActor,
    operation: string,
    key: string,
    input: unknown,
    mutate: () => Promise<Row>,
  ) {
    const id = tenantId(actor);
    if (!key || key.length < 8 || key.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = tenantKeyHash(id, key);
    const requestHash = tenantKeyHash(id, canonicalJson(input));
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${id}:${actor.userId}:${operation}:${keyHash}`,
    );
    const prior = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash,response_json FROM app.idempotency_records
         WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
        id,
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key was used for different input",
        );
      return { ...(prior.response_json as Row), replayed: true };
    }
    const result = await mutate();
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      id,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      result.id,
      JSON.stringify(result),
    );
    return result;
  }

  private async audit(
    tx: Tx,
    actor: TenantActor,
    action: string,
    targetType: "integration_endpoint" | "integration_delivery",
    targetId: string,
    correlationId: string,
    reason?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,reason)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7)`,
      actor.activeTenantId,
      actor.userId,
      action,
      targetType,
      targetId,
      correlationId,
      reason ?? null,
    );
  }

  async endpoints(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,integration_type AS type,name,environment,endpoint,scopes,allowed_events AS "allowedEvents",mapping_version AS "mappingVersion",rate_limit AS "rateLimit",retry_policy AS "retryPolicy",state,last_success_at AS "lastSuccessAt",last_failure_at AS "lastFailureAt",version FROM app.integration_endpoints WHERE tenant_id=$1::uuid ORDER BY name`,
        id,
      ),
    );
  }

  async createEndpoint(
    actor: TenantActor,
    input: {
      code: string;
      type: string;
      name: string;
      environment: string;
      endpoint?: string;
      credentialReference?: string;
      scopes: string[];
      allowedEvents: string[];
      mappingVersion: number;
      rateLimit?: unknown;
      retryPolicy?: unknown;
    },
    idempotencyKey: string,
    correlationId: string = crypto.randomUUID(),
  ) {
    const id = tenantId(actor);
    const key = idempotencyKey;
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      return this.idempotent(
        tx,
        actor,
        "integration-endpoint.create",
        key,
        input,
        async () => {
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.integration_endpoints(tenant_id,code,integration_type,name,environment,endpoint,credential_reference,scopes,allowed_events,mapping_version,rate_limit,retry_policy)
       VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,$11::jsonb,$12::jsonb) RETURNING id,code,name,state,version`,
              id,
              input.code,
              input.type,
              input.name,
              input.environment,
              input.endpoint ?? null,
              input.credentialReference ?? null,
              input.scopes,
              input.allowedEvents,
              input.mappingVersion,
              JSON.stringify(input.rateLimit ?? {}),
              JSON.stringify(input.retryPolicy ?? {}),
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "integration.endpoint_created",
            "integration_endpoint",
            String(row.id),
            correlationId,
          );
          return row;
        },
      );
    });
  }

  async mappings(actor: TenantActor, endpointId: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,endpoint_id AS "endpointId",version,schema,mapping,mapping_hash AS "mappingHash",created_at AS "createdAt" FROM app.integration_mapping_versions WHERE tenant_id=$1::uuid AND endpoint_id=$2::uuid ORDER BY version DESC`,
        id,
        endpointId,
      ),
    );
  }

  async createMapping(
    actor: TenantActor,
    endpointId: string,
    input: {
      schema: Record<string, unknown>;
      mapping: Record<string, unknown>;
    },
    correlationId: string,
  ) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const endpoint = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.integration_endpoints WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          id,
          endpointId,
        )
      )[0];
      if (!endpoint)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const version = Number(
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT coalesce(max(version),0)+1 next FROM app.integration_mapping_versions WHERE tenant_id=$1::uuid AND endpoint_id=$2::uuid`,
            id,
            endpointId,
          )
        )[0]?.next ?? 1,
      );
      const mappingHash = sha256(
        canonicalJson({ schema: input.schema, mapping: input.mapping }),
      );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.integration_mapping_versions(tenant_id,endpoint_id,version,schema,mapping,mapping_hash,created_by) VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,$6,$7::uuid) RETURNING id,endpoint_id AS "endpointId",version,mapping_hash AS "mappingHash",created_at AS "createdAt"`,
          id,
          endpointId,
          version,
          JSON.stringify(input.schema),
          JSON.stringify(input.mapping),
          mappingHash,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `UPDATE app.integration_endpoints SET mapping_version=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        version,
        id,
        endpointId,
      );
      await this.audit(
        tx,
        actor,
        "integration.mapping_created",
        "integration_endpoint",
        endpointId,
        correlationId,
      );
      return row;
    });
  }

  async createApiClient(
    actor: TenantActor,
    input: { code: string; name: string; scopes: string[]; expiresAt?: string },
    correlationId: string,
  ) {
    const id = tenantId(actor),
      secret = `lg_${randomBytes(32).toString("base64url")}`;
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.api_clients(tenant_id,code,name,credential_hash,scopes,expires_at) VALUES($1::uuid,$2,$3,$4,$5::text[],$6::timestamptz) RETURNING id,code,name,scopes,state,expires_at AS "expiresAt"`,
          id,
          input.code,
          input.name,
          sha256(secret),
          input.scopes,
          input.expiresAt ?? null,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "integration.credential_created",
        "integration_endpoint",
        String(row.id),
        correlationId,
      );
      return { ...row, secret };
    });
  }

  async rotateApiClient(
    actor: TenantActor,
    clientId: string,
    correlationId: string,
  ) {
    const id = tenantId(actor),
      secret = `lg_${randomBytes(32).toString("base64url")}`;
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const old = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT * FROM app.api_clients WHERE tenant_id=$1::uuid AND id=$2::uuid AND state<>'REVOKED' FOR UPDATE`,
          id,
          clientId,
        )
      )[0];
      if (!old)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const code =
        `${String(old.code).slice(0, 31)}-R${Date.now().toString(36).toUpperCase()}`.slice(
          0,
          40,
        );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.api_clients(tenant_id,code,name,credential_hash,scopes,rotated_from,expires_at) VALUES($1::uuid,$2,$3,$4,$5::text[],$6::uuid,$7::timestamptz) RETURNING id,code,name,scopes,state,expires_at AS "expiresAt"`,
          id,
          code,
          old.name,
          sha256(secret),
          old.scopes,
          clientId,
          old.expires_at ?? null,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `UPDATE app.api_clients SET state='ROTATING',expires_at=least(coalesce(expires_at,now()+interval '24 hours'),now()+interval '24 hours') WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        id,
        clientId,
      );
      await this.audit(
        tx,
        actor,
        "integration.credential_rotated",
        "integration_endpoint",
        clientId,
        correlationId,
      );
      return { ...row, secret };
    });
  }

  async ingestWebhook(input: {
    tenantCode: string;
    clientCode: string;
    token: string;
    signature: string;
    eventKey: string;
    eventType: string;
    payload: unknown;
    correlationId: string;
  }) {
    const tenant = (
      await this.app.db.$queryRawUnsafe<Array<Row>>(
        `SELECT id FROM app.tenants WHERE code=$1 AND status='ACTIVE'`,
        input.tenantCode,
      )
    )[0];
    if (!tenant)
      throw new AppError(
        401,
        "MACHINE_AUTH_FAILED",
        "Machine authentication failed",
      );
    return withTenant(this.app.db, String(tenant.id), async (tx) => {
      const client = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,credential_hash,scopes,state,expires_at FROM app.api_clients WHERE tenant_id=$1::uuid AND code=$2`,
          tenant.id,
          input.clientCode,
        )
      )[0];
      if (
        !client ||
        client.state === "REVOKED" ||
        (client.expires_at &&
          new Date(String(client.expires_at)) <= new Date()) ||
        sha256(input.token) !== client.credential_hash
      )
        throw new AppError(
          401,
          "MACHINE_AUTH_FAILED",
          "Machine authentication failed",
        );
      if (
        !(client.scopes as string[]).includes(input.eventType) &&
        !(client.scopes as string[]).includes("*")
      )
        throw new AppError(403, "EVENT_NOT_ALLOWED", "Event is not allowed");
      const expected = createHmac("sha256", input.token)
        .update(canonicalJson(input.payload))
        .digest("hex");
      const a = Buffer.from(expected),
        b = Buffer.from(input.signature.toLowerCase());
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new AppError(
          401,
          "SIGNATURE_INVALID",
          "Webhook signature is invalid",
        );
      const payloadHash = sha256(canonicalJson(input.payload));
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.webhook_events(tenant_id,api_client_id,event_key,event_type,payload_hash,signature_version,correlation_id,state,processed_at) VALUES($1::uuid,$2::uuid,$3,$4,$5,1,$6,'PROCESSED',now()) ON CONFLICT(tenant_id,api_client_id,event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id,event_key AS "eventKey",event_type AS "eventType",payload_hash AS "payloadHash",state,received_at AS "receivedAt"`,
          tenant.id,
          client.id,
          input.eventKey,
          input.eventType,
          payloadHash,
          input.correlationId,
        )
      )[0]!;
      return row;
    });
  }

  async recordDelivery(
    actor: TenantActor,
    input: {
      endpointId: string;
      direction: "INBOUND" | "OUTBOUND";
      eventId: string;
      eventType: string;
      mappingVersion: number;
      payload: unknown;
      correlationId: string;
    },
    idempotencyKey: string,
  ) {
    const id = tenantId(actor);
    this.validateDelivery(input);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const endpoint = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,allowed_events AS "allowedEvents" FROM app.integration_endpoints WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          id,
          input.endpointId,
        )
      )[0];
      if (!endpoint || endpoint.state !== "ACTIVE")
        throw new AppError(
          409,
          "INTEGRATION_INACTIVE",
          "Integration is not active",
        );
      const allowed = endpoint.allowedEvents as string[];
      if (allowed.length && !allowed.includes(input.eventType))
        throw new AppError(
          403,
          "EVENT_NOT_ALLOWED",
          "Event is not allowed for this integration",
        );
      const key = idempotencyKey;
      return this.idempotent(
        tx,
        actor,
        "integration-delivery.enqueue",
        key,
        { ...input, correlationId: undefined },
        async () => {
          const payloadHash = sha256(canonicalJson(input.payload));
          const rows = await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.integration_deliveries(tenant_id,endpoint_id,direction,event_id,event_type,mapping_version,payload_hash,correlation_id)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,endpoint_id,event_id) DO NOTHING
           RETURNING id,state,attempts,version`,
            id,
            input.endpointId,
            input.direction,
            input.eventId,
            input.eventType,
            input.mappingVersion,
            payloadHash,
            input.correlationId,
          );
          if (rows[0]) return rows[0];
          const existing = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,state,attempts,version,direction,event_type AS "eventType",mapping_version AS "mappingVersion",payload_hash AS "payloadHash"
             FROM app.integration_deliveries WHERE tenant_id=$1::uuid AND endpoint_id=$2::uuid AND event_id=$3`,
              id,
              input.endpointId,
              input.eventId,
            )
          )[0]!;
          if (
            existing.direction !== input.direction ||
            existing.eventType !== input.eventType ||
            Number(existing.mappingVersion) !== input.mappingVersion ||
            existing.payloadHash !== payloadHash
          )
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Event identifier was used for different input",
            );
          return existing;
        },
      );
    });
  }

  async recordFailedDelivery(
    actor: TenantActor,
    input: {
      endpointId: string;
      direction: "INBOUND" | "OUTBOUND";
      eventId: string;
      eventType: string;
      mappingVersion: number;
      payload: unknown;
      correlationId: string;
      reasonCode?: string;
      safeError?: string;
      expectedVersion: number;
    },
    idempotencyKey: string,
    correlationId: string = crypto.randomUUID(),
  ) {
    const id = tenantId(actor);
    this.validateDelivery(input);
    if (
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      (input.reasonCode?.length ?? 0) > 80 ||
      (input.safeError?.length ?? 0) > 500
    )
      throw new AppError(
        400,
        "VALIDATION_FAILED",
        "Delivery failure input is invalid",
      );
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      return this.idempotent(
        tx,
        actor,
        "integration-delivery.fail",
        idempotencyKey,
        { ...input, correlationId: undefined },
        async () => {
          const endpoint = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,state,allowed_events AS "allowedEvents" FROM app.integration_endpoints WHERE tenant_id=$1::uuid AND id=$2::uuid`,
              id,
              input.endpointId,
            )
          )[0];
          if (!endpoint || endpoint.state !== "ACTIVE")
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const allowed = endpoint.allowedEvents as string[];
          if (allowed.length && !allowed.includes(input.eventType))
            throw new AppError(
              403,
              "EVENT_NOT_ALLOWED",
              "Event is not allowed for this integration",
            );
          const payloadHash = sha256(canonicalJson(input.payload));
          let delivery = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.integration_deliveries(tenant_id,endpoint_id,direction,event_id,event_type,mapping_version,payload_hash,state,attempts,last_error_code,correlation_id)
               VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,'PENDING',0,null,$8)
               ON CONFLICT(tenant_id,endpoint_id,event_id) DO NOTHING
               RETURNING id,state,attempts,version,direction,event_type AS "eventType",mapping_version AS "mappingVersion",payload_hash AS "payloadHash"`,
              id,
              input.endpointId,
              input.direction,
              input.eventId,
              input.eventType,
              input.mappingVersion,
              payloadHash,
              input.correlationId,
            )
          )[0];
          delivery = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,state,attempts,version,direction,event_type AS "eventType",mapping_version AS "mappingVersion",payload_hash AS "payloadHash"
               FROM app.integration_deliveries WHERE tenant_id=$1::uuid AND id=coalesce($2::uuid,
                 (SELECT id FROM app.integration_deliveries WHERE tenant_id=$1::uuid AND endpoint_id=$3::uuid AND event_id=$4)) FOR UPDATE`,
              id,
              delivery?.id ?? null,
              input.endpointId,
              input.eventId,
            )
          )[0]!;
          if (
            delivery.direction !== input.direction ||
            delivery.eventType !== input.eventType ||
            Number(delivery.mappingVersion) !== input.mappingVersion ||
            delivery.payloadHash !== payloadHash
          )
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Event identifier was used for different input",
            );
          if (Number(delivery.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Delivery changed; reload and retry",
            );
          if (!["PENDING", "FAILED"].includes(String(delivery.state)))
            throw new AppError(
              409,
              "DELIVERY_STATE_CONFLICT",
              "Delivery is not eligible to fail",
            );
          delivery = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.integration_deliveries SET state='DEAD_LETTER',attempts=attempts+1,last_error_code=$1,updated_at=now(),version=version+1
               WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4
               RETURNING id,state,attempts,version`,
              input.reasonCode ?? "DELIVERY_FAILED",
              id,
              delivery.id,
              input.expectedVersion,
            )
          )[0]!;
          const dead = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.integration_dead_letters(id,tenant_id,delivery_id,reason_code,safe_error)
             VALUES($1::uuid,$2::uuid,$1::uuid,$3,$4)
             ON CONFLICT(tenant_id,delivery_id) DO UPDATE SET
               reason_code=EXCLUDED.reason_code,safe_error=EXCLUDED.safe_error,resolved_at=null,resolution_reason=null,updated_at=now()
             RETURNING id,replay_count AS "replayCount",resolved_at AS "resolvedAt"`,
              delivery.id,
              id,
              input.reasonCode ?? "DELIVERY_FAILED",
              input.safeError ??
                "Delivery failed after the configured retry policy",
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.integration_endpoints SET last_failure_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            id,
            input.endpointId,
          );
          const result = {
            id: delivery.id,
            code: input.eventId,
            name: "Failed delivery",
            status: delivery.state,
            data: {
              endpointId: input.endpointId,
              direction: input.direction,
              eventType: input.eventType,
              deadLetterId: dead.id,
            },
            attempts: delivery.attempts,
            version: delivery.version,
          };
          await this.audit(
            tx,
            actor,
            "integration.delivery_failed",
            "integration_delivery",
            String(delivery.id),
            correlationId,
            input.reasonCode,
          );
          return result;
        },
      );
    });
  }

  async deliveries(actor: TenantActor, state = "") {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT d.id,d.direction,d.event_id AS "eventId",d.event_type AS "eventType",d.mapping_version AS "mappingVersion",d.state,d.attempts,d.last_error_code AS "lastErrorCode",d.correlation_id AS "correlationId",d.created_at AS "createdAt",e.name AS integration
       FROM app.integration_deliveries d JOIN app.integration_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id
       WHERE d.tenant_id=$1::uuid AND ($2='' OR d.state=$2) ORDER BY d.created_at DESC LIMIT 250`,
        id,
        state,
      ),
    );
  }

  async deliveryDetail(actor: TenantActor, deliveryId: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT d.id,d.event_id AS code,concat('Delivery ',d.event_id) AS name,d.state AS status,d.direction,
             d.endpoint_id AS "endpointId",d.event_type AS "eventType",d.mapping_version AS "mappingVersion",
             d.attempts,d.last_error_code AS "lastErrorCode",d.correlation_id AS "correlationId",d.version
           FROM app.integration_deliveries d WHERE d.tenant_id=$1::uuid AND d.id=$2::uuid`,
          id,
          deliveryId,
        )
      )[0];
      if (!row)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        data: {
          endpointId: row.endpointId,
          direction: row.direction,
          eventType: row.eventType,
          mappingVersion: row.mappingVersion,
          attempts: row.attempts,
          lastErrorCode: row.lastErrorCode,
          correlationId: row.correlationId,
        },
        version: row.version,
      };
    });
  }

  async deliveryReport(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT state AS status,count(*)::int count FROM app.integration_deliveries
         WHERE tenant_id=$1::uuid GROUP BY state ORDER BY state`,
        id,
      );
      return {
        feature: "INT-01",
        module: "integrations",
        resource: "delivery",
        dimensions: ["status"],
        rows,
      };
    });
  }

  async deadLetters(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT dl.id,dl.delivery_id AS "deliveryId",dl.reason_code AS "reasonCode",dl.safe_error AS "safeError",dl.replay_count AS "replayCount",dl.resolved_at AS "resolvedAt",dl.created_at AS "createdAt",d.event_type AS "eventType",d.version AS "deliveryVersion",e.name AS integration
       FROM app.integration_dead_letters dl JOIN app.integration_deliveries d ON d.tenant_id=dl.tenant_id AND d.id=dl.delivery_id JOIN app.integration_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id
       WHERE dl.tenant_id=$1::uuid ORDER BY dl.created_at DESC LIMIT 250`,
        id,
      ),
    );
  }

  async replay(
    actor: TenantActor,
    deadLetterId: string,
    reason: string,
    idempotencyKey: string,
    expectedVersion: number,
    correlationId: string = crypto.randomUUID(),
  ) {
    const id = tenantId(actor);
    if (reason.trim().length < 5)
      throw new AppError(400, "REASON_REQUIRED", "A replay reason is required");
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      return this.idempotent(
        tx,
        actor,
        "integration-dead-letter.replay",
        idempotencyKey,
        { deadLetterId, reason, expectedVersion },
        async () => {
          const delivery = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,state,version FROM app.integration_deliveries
               WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              id,
              deadLetterId,
            )
          )[0];
          if (!delivery)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const dead = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,delivery_id AS "deliveryId",resolved_at AS "resolvedAt" FROM app.integration_dead_letters
               WHERE tenant_id=$1::uuid AND delivery_id=$2::uuid FOR UPDATE`,
              id,
              deadLetterId,
            )
          )[0];
          if (!dead)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(delivery.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Delivery changed; reload and retry",
            );
          if (delivery.state !== "DEAD_LETTER" || dead.resolvedAt)
            throw new AppError(
              409,
              "DELIVERY_STATE_CONFLICT",
              "Delivery is not eligible for replay",
            );
          const changed = await tx.$executeRawUnsafe(
            `UPDATE app.integration_deliveries SET state='PENDING',available_at=now(),leased_at=null,last_error_code=null,updated_at=now(),version=version+1
             WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='DEAD_LETTER' AND version=$3`,
            id,
            dead.deliveryId,
            expectedVersion,
          );
          if (changed !== 1)
            throw new AppError(
              409,
              "DELIVERY_STATE_CONFLICT",
              "Delivery is not eligible for replay",
            );
          const result = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.integration_dead_letters SET replay_count=replay_count+1,resolved_at=now(),resolution_reason=$1,updated_at=now()
             WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING id,replay_count AS "replayCount",resolved_at AS "resolvedAt"`,
              reason,
              id,
              dead.id,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "integration.dead_letter_replayed",
            "integration_delivery",
            String(dead.deliveryId),
            correlationId,
            reason,
          );
          return result;
        },
      );
    });
  }

  async health(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT e.id,e.name,e.integration_type AS type,e.state,e.last_success_at AS "lastSuccessAt",e.last_failure_at AS "lastFailureAt",
        count(d.id)::int deliveries,count(d.id) FILTER(WHERE d.state='FAILED')::int failed,count(d.id) FILTER(WHERE d.state='DEAD_LETTER')::int "deadLetters"
       FROM app.integration_endpoints e LEFT JOIN app.integration_deliveries d ON d.tenant_id=e.tenant_id AND d.endpoint_id=e.id
       WHERE e.tenant_id=$1::uuid GROUP BY e.id ORDER BY e.name`,
        id,
      ),
    );
  }
}
