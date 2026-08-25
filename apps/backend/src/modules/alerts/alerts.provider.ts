import { Inject, Injectable } from "@nestjs/common";
import { withTenant } from "@logistics/db";
import type { Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";
import { canonicalJson, tenantKeyHash } from "../control/idempotency.js";

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
type AlertAction =
  | "ACKNOWLEDGE"
  | "ASSIGN"
  | "COMMENT"
  | "SNOOZE"
  | "ESCALATE"
  | "RESOLVE"
  | "AUTO_RESOLVE"
  | "REOPEN";

const nextState: Record<AlertAction, string | null> = {
  ACKNOWLEDGE: "ACKNOWLEDGED",
  ASSIGN: null,
  COMMENT: null,
  SNOOZE: "SNOOZED",
  ESCALATE: "ESCALATED",
  RESOLVE: "RESOLVED",
  AUTO_RESOLVE: "RESOLVED",
  REOPEN: "OPEN",
};

@Injectable()
export class AlertsProvider {
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

  private async assertRuleScope(
    tx: Tx,
    actor: TenantActor,
    id: string,
    capability: "alerts.read" | "alerts.admin",
    action: "READ" | "UPDATE",
    scopeNodeIds: string[],
  ) {
    const row = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid[]) allowed`,
        id,
        actor.membershipId,
        actor.userId,
        capability,
        action,
        scopeNodeIds,
      )
    )[0];
    if (row?.allowed !== true && row?.allowed !== "t")
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  private async assertRule(
    tx: Tx,
    actor: TenantActor,
    id: string,
    ruleId: string,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT app.alert_rule_authorized($1::uuid,$2::uuid,$3::uuid,'alerts.admin','UPDATE',$4::uuid) allowed`,
        id,
        actor.membershipId,
        actor.userId,
        ruleId,
      )
    )[0];
    if (row?.allowed !== true && row?.allowed !== "t")
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
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
    targetId: string,
    correlationId: string,
    reason?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,reason)
       VALUES($1::uuid,$2::uuid,$3,'operational_alert',$4::uuid,$5,$6)`,
      actor.activeTenantId,
      actor.userId,
      action,
      targetId,
      correlationId,
      reason ?? null,
    );
  }

  async queue(actor: TenantActor, state = "", severity = "") {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,alert_type AS type,severity,state,title,summary,source_module AS "sourceModule",source_record_id AS "sourceRecordId",
          owner_membership_id AS "ownerMembershipId",due_at AS "dueAt",occurrence_count AS "occurrenceCount",evidence,last_seen_at AS "lastSeenAt",version
         FROM app.operational_alerts oa WHERE tenant_id=$1::uuid AND ($2='' OR state=$2) AND ($3='' OR severity=$3)
         AND app.operational_alert_authorized($1::uuid,$4::uuid,$5::uuid,'alerts.read',oa.id)
         ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'WARNING' THEN 3 ELSE 4 END,due_at NULLS LAST,last_seen_at DESC LIMIT 250`,
        id,
        state,
        severity,
        actor.membershipId,
        actor.userId,
      );
      return { items, total: items.length, asOf: new Date().toISOString() };
    });
  }

  async rules(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name,source_module AS "sourceModule",event_type AS "eventType",metric_code AS "metricCode",scope_node_ids AS "scopeNodeIds",threshold,severity,recipient_policy AS "recipientPolicy",channels,quiet_hours AS "quietHours",repeat_policy AS "repeatPolicy",escalation_levels AS "escalationLevels",acknowledgement_required AS "acknowledgementRequired",resolution_condition AS "resolutionCondition",active,version
         FROM app.alert_rules WHERE tenant_id=$1::uuid
         AND app.alert_rule_authorized($1::uuid,$2::uuid,$3::uuid,'alerts.read','READ',id)
         ORDER BY code`,
        id,
        actor.membershipId,
        actor.userId,
      );
    });
  }

  async saveRule(
    actor: TenantActor,
    input: {
      id?: string;
      code: string;
      name: string;
      sourceModule: string;
      eventType?: string;
      metricCode: string;
      scopeNodeIds: string[];
      threshold: Record<string, unknown>;
      severity: string;
      recipientPolicy: Record<string, unknown>;
      channels: string[];
      quietHours: Record<string, unknown>;
      repeatPolicy: Record<string, unknown>;
      escalationLevels: unknown[];
      acknowledgementRequired: boolean;
      resolutionCondition: Record<string, unknown>;
      active: boolean;
      expectedVersion?: number;
    },
    correlationId: string,
  ) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      if (input.id) await this.assertRule(tx, actor, id, input.id);
      for (const node of input.scopeNodeIds)
        if (
          !(
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='ACTIVE'`,
              id,
              node,
            )
          )[0]
        )
          throw new AppError(400, "SCOPE_INVALID", "Alert scope is invalid");
      await this.assertRuleScope(
        tx,
        actor,
        id,
        "alerts.admin",
        "UPDATE",
        input.scopeNodeIds,
      );
      const row = input.id
        ? (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.alert_rules SET name=$1,event_type=$2,metric_code=$3,scope_node_ids=$4::uuid[],threshold=$5::jsonb,severity=$6,recipient_policy=$7::jsonb,channels=$8::text[],quiet_hours=$9::jsonb,repeat_policy=$10::jsonb,escalation_levels=$11::jsonb,acknowledgement_required=$12,resolution_condition=$13::jsonb,active=$14,updated_at=now(),version=version+1 WHERE tenant_id=$15::uuid AND id=$16::uuid AND version=$17 RETURNING *`,
              input.name,
              input.eventType ?? null,
              input.metricCode,
              input.scopeNodeIds,
              JSON.stringify(input.threshold),
              input.severity,
              JSON.stringify(input.recipientPolicy),
              input.channels,
              JSON.stringify(input.quietHours),
              JSON.stringify(input.repeatPolicy),
              JSON.stringify(input.escalationLevels),
              input.acknowledgementRequired,
              JSON.stringify(input.resolutionCondition),
              input.active,
              id,
              input.id,
              input.expectedVersion,
            )
          )[0]
        : (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,event_type,metric_code,scope_node_ids,threshold,severity,recipient_policy,channels,quiet_hours,repeat_policy,escalation_levels,acknowledgement_required,resolution_condition,active) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid[],$8::jsonb,$9,$10::jsonb,$11::text[],$12::jsonb,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17) RETURNING *`,
              id,
              input.code,
              input.name,
              input.sourceModule,
              input.eventType ?? null,
              input.metricCode,
              input.scopeNodeIds,
              JSON.stringify(input.threshold),
              input.severity,
              JSON.stringify(input.recipientPolicy),
              input.channels,
              JSON.stringify(input.quietHours),
              JSON.stringify(input.repeatPolicy),
              JSON.stringify(input.escalationLevels),
              input.acknowledgementRequired,
              JSON.stringify(input.resolutionCondition),
              input.active,
            )
          )[0];
      if (!row)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Alert rule changed; reload and retry",
        );
      await this.audit(
        tx,
        actor,
        input.id ? "alert.rule_updated" : "alert.rule_created",
        String(row.id),
        correlationId,
      );
      return row;
    });
  }

  async act(
    actor: TenantActor,
    alertId: string,
    action: AlertAction,
    input: {
      reason?: string;
      ownerMembershipId?: string;
      snoozedUntil?: string;
      expectedVersion: number;
    },
    idempotencyKey: string,
    correlationId: string = crypto.randomUUID(),
  ) {
    const id = tenantId(actor);
    if ((action === "RESOLVE" || action === "SNOOZE") && !input.reason?.trim())
      throw new AppError(400, "REASON_REQUIRED", "A reason is required");
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const key = idempotencyKey;
      return this.idempotent(
        tx,
        actor,
        "operational-alert.action",
        key,
        { alertId, action, input },
        async () => {
          const current = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,state,version FROM app.operational_alerts WHERE tenant_id=$1::uuid AND id=$2::uuid AND app.operational_alert_authorized($1::uuid,$3::uuid,$4::uuid,'alerts.admin',id) FOR UPDATE`,
              id,
              alertId,
              actor.membershipId,
              actor.userId,
            )
          )[0];
          if (!current)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(current.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Alert changed; reload and retry",
            );
          const state = nextState[action] ?? String(current.state);
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.operational_alerts SET state=$1,owner_membership_id=coalesce($2::uuid,owner_membership_id),
             snoozed_until=CASE WHEN $1='SNOOZED' THEN $3::timestamptz ELSE snoozed_until END,
             resolved_at=CASE WHEN $1='RESOLVED' THEN now() WHEN $1='OPEN' THEN null ELSE resolved_at END,
             updated_at=now(),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid RETURNING id,state,version`,
              state,
              input.ownerMembershipId ?? null,
              input.snoozedUntil ?? null,
              id,
              alertId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO app.operational_alert_actions(tenant_id,alert_id,actor_id,action,reason,payload) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)`,
            id,
            alertId,
            actor.userId,
            action,
            input.reason ?? null,
            JSON.stringify({
              ownerMembershipId: input.ownerMembershipId,
              snoozedUntil: input.snoozedUntil,
            }),
          );
          await this.audit(
            tx,
            actor,
            `alert.${action.toLowerCase()}`,
            alertId,
            correlationId,
            input.reason,
          );
          return updated;
        },
      );
    });
  }

  async createOccurrence(
    actor: TenantActor,
    input: {
      code: string;
      title: string;
      type: string;
      severity: string;
      summary: string;
      sourceModule?: string;
      sourceRecordId?: string;
      evidence?: unknown;
    },
    idempotencyKey: string,
    correlationId: string = crypto.randomUUID(),
  ) {
    const id = tenantId(actor);
    if (
      !["INFO", "WARNING", "HIGH", "CRITICAL"].includes(input.severity) ||
      input.code.length < 2 ||
      input.code.length > 80 ||
      input.title.trim().length < 2 ||
      input.title.length > 160 ||
      input.type.length < 2 ||
      input.type.length > 80 ||
      input.summary.trim().length < 2 ||
      input.summary.length > 500 ||
      (input.sourceRecordId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.sourceRecordId,
        )) ||
      Buffer.byteLength(canonicalJson(input.evidence ?? {}), "utf8") > 16_384
    )
      throw new AppError(400, "VALIDATION_FAILED", "Severity is invalid");
    const key = idempotencyKey;
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      if (input.sourceRecordId) {
        const source = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.module_records WHERE tenant_id=$1::uuid AND id=$2::uuid
           UNION ALL SELECT id FROM app.tenant_probe_records WHERE tenant_id=$1::uuid AND id=$2::uuid
           UNION ALL SELECT $2::uuid WHERE app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,
             CASE WHEN $5 IN ('organization-nodes','employees','clients','client-locations','contracts','lanes','vendors','vehicles','drivers') THEN 'masters.read'
                  WHEN $5 IN ('indents','allocations','trips') THEN 'operations.read' WHEN $5='pod-tasks' THEN 'pod.read'
                  WHEN $5 IN ('invoices','receipts','vendor-bills') THEN 'finance.read' WHEN $5='configurations' THEN 'configuration.read' ELSE '__invalid__' END,
             'READ',$5,$2::uuid) LIMIT 1`,
          id,
          input.sourceRecordId,
          actor.membershipId,
          actor.userId,
          input.sourceModule ?? "alerts",
        );
        if (!source[0])
          throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      }
      return this.idempotent(
        tx,
        actor,
        "operational-alert.create",
        key,
        input,
        async () => {
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.operational_alerts(tenant_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,evidence)
             VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9::jsonb)
             ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET
               occurrence_count=app.operational_alerts.occurrence_count+1,
               severity=EXCLUDED.severity,title=EXCLUDED.title,summary=EXCLUDED.summary,
               state=CASE WHEN app.operational_alerts.state='RESOLVED' THEN 'OPEN' ELSE app.operational_alerts.state END,
               resolved_at=CASE WHEN app.operational_alerts.state='RESOLVED' THEN null ELSE app.operational_alerts.resolved_at END,
               last_seen_at=now(),evidence=EXCLUDED.evidence,updated_at=now(),version=app.operational_alerts.version+1
             RETURNING id,deduplication_key AS code,title AS name,state AS status,alert_type,severity,summary,evidence,occurrence_count AS "occurrenceCount",version`,
              id,
              input.code.toUpperCase(),
              input.sourceModule ?? "alerts",
              input.sourceRecordId ?? null,
              input.type,
              input.severity,
              input.title,
              input.summary,
              JSON.stringify(input.evidence ?? {}),
            )
          )[0]!;
          const authorized = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT app.operational_alert_authorized($1::uuid,$2::uuid,$3::uuid,'alerts.admin',$4::uuid) allowed`,
              id,
              actor.membershipId,
              actor.userId,
              row.id,
            )
          )[0]?.allowed;
          if (!authorized)
            throw new AppError(
              403,
              "FORBIDDEN",
              "Action is not permitted for this alert scope",
            );
          const result = {
            id: row.id,
            code: row.code,
            name: row.name,
            status: row.status,
            data: {
              type: row.alert_type,
              severity: row.severity,
              summary: row.summary,
              evidence: row.evidence,
              occurrenceCount: row.occurrenceCount,
            },
            version: row.version,
          };
          await this.audit(
            tx,
            actor,
            "alert.occurrence_recorded",
            String(row.id),
            correlationId,
          );
          return result;
        },
      );
    });
  }

  async detail(actor: TenantActor, alertId: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,deduplication_key AS code,title AS name,state AS status,alert_type,severity,summary,evidence,occurrence_count AS "occurrenceCount",version
           FROM app.operational_alerts WHERE tenant_id=$1::uuid AND id=$2::uuid AND app.operational_alert_authorized($1::uuid,$3::uuid,$4::uuid,'alerts.read',id)`,
          id,
          alertId,
          actor.membershipId,
          actor.userId,
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
          type: row.alert_type,
          severity: row.severity,
          summary: row.summary,
          evidence: row.evidence,
          occurrenceCount: row.occurrenceCount,
        },
        version: row.version,
      };
    });
  }

  async report(actor: TenantActor) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.assertInternal(tx, actor, id);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT state AS status,count(*)::int count FROM app.operational_alerts WHERE tenant_id=$1::uuid AND app.operational_alert_authorized($1::uuid,$2::uuid,$3::uuid,'alerts.read',id) GROUP BY state ORDER BY state`,
        id,
        actor.membershipId,
        actor.userId,
      );
      return {
        feature: "ALT-01",
        module: "alerts",
        resource: "alert",
        dimensions: ["status"],
        rows,
      };
    });
  }

  async upsertOccurrence(
    actor: TenantActor,
    input: {
      deduplicationKey: string;
      sourceModule: string;
      sourceRecordId?: string;
      type: string;
      severity: string;
      title: string;
      summary: string;
      evidence?: unknown;
    },
  ) {
    return this.createOccurrence(
      actor,
      {
        code: input.deduplicationKey,
        title: input.title,
        type: input.type,
        severity: input.severity,
        summary: input.summary,
        sourceModule: input.sourceModule,
        sourceRecordId: input.sourceRecordId,
        evidence: input.evidence,
      },
      `alert-occurrence:${input.deduplicationKey}:${crypto.randomUUID()}`,
    );
  }
}
