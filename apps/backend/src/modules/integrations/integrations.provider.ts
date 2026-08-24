import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { withTenant } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";

type Row = Record<string, unknown>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class IntegrationsProvider {
  constructor(private readonly app: AppService) {}

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
  ) {
    const id = tenantId(actor);
    return withTenant(
      this.app.db,
      id,
      async (tx) =>
        (
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
        )[0]!,
    );
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
  ) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
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
        sha(JSON.stringify(input.payload)),
        input.correlationId,
      );
      if (rows[0]) return rows[0];
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,attempts,version FROM app.integration_deliveries WHERE tenant_id=$1::uuid AND endpoint_id=$2::uuid AND event_id=$3`,
          id,
          input.endpointId,
          input.eventId,
        )
      )[0]!;
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

  async deadLetters(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT dl.id,dl.delivery_id AS "deliveryId",dl.reason_code AS "reasonCode",dl.safe_error AS "safeError",dl.replay_count AS "replayCount",dl.resolved_at AS "resolvedAt",dl.created_at AS "createdAt",d.event_type AS "eventType",e.name AS integration
       FROM app.integration_dead_letters dl JOIN app.integration_deliveries d ON d.tenant_id=dl.tenant_id AND d.id=dl.delivery_id JOIN app.integration_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id
       WHERE dl.tenant_id=$1::uuid ORDER BY dl.created_at DESC LIMIT 250`,
        id,
      ),
    );
  }

  async replay(actor: TenantActor, deadLetterId: string, reason: string) {
    const id = tenantId(actor);
    if (reason.trim().length < 5)
      throw new AppError(400, "REASON_REQUIRED", "A replay reason is required");
    return withTenant(this.app.db, id, async (tx) => {
      const dead = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT delivery_id AS "deliveryId",resolved_at AS "resolvedAt" FROM app.integration_dead_letters WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          id,
          deadLetterId,
        )
      )[0];
      if (!dead)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await tx.$executeRawUnsafe(
        `UPDATE app.integration_deliveries SET state='PENDING',available_at=now(),leased_at=null,last_error_code=null,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        id,
        dead.deliveryId,
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.integration_dead_letters SET replay_count=replay_count+1,resolved_at=now(),resolution_reason=$1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING id,"replay_count" AS "replayCount",resolved_at AS "resolvedAt"`,
          reason,
          id,
          deadLetterId,
        )
      )[0]!;
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
