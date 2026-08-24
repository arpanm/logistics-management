import { Injectable } from "@nestjs/common";
import { withTenant } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";

type Row = Record<string, unknown>;
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
  constructor(private readonly app: AppService) {}

  async queue(actor: TenantActor, state = "", severity = "") {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,alert_type AS type,severity,state,title,summary,source_module AS "sourceModule",source_record_id AS "sourceRecordId",
          owner_membership_id AS "ownerMembershipId",due_at AS "dueAt",occurrence_count AS "occurrenceCount",evidence,last_seen_at AS "lastSeenAt",version
         FROM app.operational_alerts WHERE tenant_id=$1::uuid AND ($2='' OR state=$2) AND ($3='' OR severity=$3)
         ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'WARNING' THEN 3 ELSE 4 END,due_at NULLS LAST,last_seen_at DESC LIMIT 250`,
        id,
        state,
        severity,
      );
      return { items, total: items.length, asOf: new Date().toISOString() };
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
  ) {
    const id = tenantId(actor);
    if ((action === "RESOLVE" || action === "SNOOZE") && !input.reason?.trim())
      throw new AppError(400, "REASON_REQUIRED", "A reason is required");
    return withTenant(this.app.db, id, async (tx) => {
      const current = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,version FROM app.operational_alerts WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          id,
          alertId,
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
      return updated;
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
    const id = tenantId(actor);
    return withTenant(
      this.app.db,
      id,
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.operational_alerts(tenant_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,evidence)
       VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET occurrence_count=app.operational_alerts.occurrence_count+1,
         severity=EXCLUDED.severity,last_seen_at=now(),evidence=EXCLUDED.evidence,updated_at=now(),version=app.operational_alerts.version+1
       RETURNING id,state,severity,occurrence_count AS "occurrenceCount",version`,
            id,
            input.deduplicationKey,
            input.sourceModule,
            input.sourceRecordId ?? null,
            input.type,
            input.severity,
            input.title,
            input.summary,
            JSON.stringify(input.evidence ?? {}),
          )
        )[0]!,
    );
  }
}
