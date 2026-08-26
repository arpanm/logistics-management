import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { withPlatform, type Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { InvitationEmailDeliveryService } from "../../invitation-email.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
@Injectable()
export class OperationalWorkerService {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Optional()
    @Inject(InvitationEmailDeliveryService)
    private readonly invitationEmail?: InvitationEmailDeliveryService,
  ) {}
  private platform(actor: SessionActor) {
    if (!actor.platformAdmin)
      throw new AppError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "Platform administrator access is required",
      );
  }

  async run(actor: SessionActor, limit = 50) {
    this.platform(actor);
    const invitations = this.invitationEmail
      ? await this.invitationEmail.processPending(limit)
      : 0;
    return withPlatform(this.app.db, async (tx) => ({
      invitations,
      documents: await this.documentScans(tx, limit),
      approvals: await this.expireApprovals(tx),
      offers: await this.expireOffers(tx),
      alerts: await this.evaluateAlerts(tx, limit),
      notifications: await this.notificationDeliveries(tx, limit),
      integrations: await this.integrationDeliveries(tx, limit),
      accounting: await this.accountingProjection(tx, limit),
    }));
  }

  private async documentScans(tx: Tx, limit: number) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT v.id,v.tenant_id AS "tenantId",v.document_id AS "documentId",v.content FROM app.governed_document_versions v LEFT JOIN app.document_scan_results s ON s.tenant_id=v.tenant_id AND s.document_version_id=v.id WHERE v.malware_state='PENDING' AND s.id IS NULL ORDER BY v.created_at,v.id FOR UPDATE OF v SKIP LOCKED LIMIT $1`,
      limit,
    );
    let rejectedCount = 0;
    for (const row of rows) {
      const content = row.content as Buffer;
      const rejected = content.includes(
        Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
      );
      // The local adapter can positively identify the EICAR test signature,
      // but it is not an antivirus engine and must never attest arbitrary
      // content as clean.
      if (!rejected) continue;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.document_scan_results(tenant_id,document_version_id,scanner,signature_version,outcome,reason_code) VALUES($1::uuid,$2::uuid,'EICAR_SIGNATURE_CHECK','1','REJECTED','MALWARE_SIGNATURE')`,
        row.tenantId,
        row.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.governed_documents SET verification_state='QUARANTINED',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        row.tenantId,
        row.documentId,
      );
      rejectedCount++;
    }
    return rejectedCount;
  }

  private expireApprovals(tx: Tx) {
    return tx.$executeRawUnsafe(
      `UPDATE app.approval_instances SET state='EXPIRED',completed_at=now(),version=version+1 WHERE state='PENDING' AND expires_at<=now()`,
    );
  }

  private expireOffers(tx: Tx) {
    return tx.$executeRawUnsafe(
      `UPDATE app.allocations SET state='EXPIRED',updated_at=now(),version=version+1 WHERE state='OFFERED' AND expires_at<=now()`,
    );
  }

  private async evaluateAlerts(tx: Tx, limit: number) {
    const rules = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT * FROM app.alert_rules WHERE active ORDER BY tenant_id,code LIMIT $1`,
      limit,
    );
    let evaluated = 0;
    for (const rule of rules) {
      const observations = await this.observations(tx, rule);
      for (const observation of observations) {
        const threshold = Number(
          (rule.threshold as Record<string, unknown>)?.value ?? 0,
        );
        const value = Number(observation.value ?? 0),
          matched = value >= threshold,
          key = `${String(rule.code)}:${String(observation.id)}:${new Date().toISOString().slice(0, 10)}`;
        const inserted = await tx.$executeRawUnsafe(
          `INSERT INTO app.alert_rule_evaluations(tenant_id,rule_id,evaluation_key,observed_value,boundary_value,matched,source_record_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid) ON CONFLICT(tenant_id,rule_id,evaluation_key) DO NOTHING`,
          rule.tenant_id,
          rule.id,
          key,
          value,
          threshold,
          matched,
          observation.id,
        );
        if (!inserted) continue;
        evaluated++;
        const dedup = `rule:${String(rule.id)}:source:${String(observation.id)}`;
        if (matched) {
          const alert = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.operational_alerts(tenant_id,rule_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,evidence,owner_membership_id,due_at) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11::uuid,$12::timestamptz) ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET occurrence_count=app.operational_alerts.occurrence_count+1,last_seen_at=now(),severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,state=CASE WHEN app.operational_alerts.state='RESOLVED' THEN 'OPEN' ELSE app.operational_alerts.state END,resolved_at=null,updated_at=now(),version=app.operational_alerts.version+1 RETURNING id,owner_membership_id AS "ownerMembershipId"`,
              rule.tenant_id,
              rule.id,
              dedup,
              rule.source_module,
              observation.id,
              rule.code,
              rule.severity,
              rule.name,
              `${String(rule.name)} threshold reached`,
              JSON.stringify({ value, threshold }),
              observation.ownerMembershipId ?? null,
              observation.dueAt ?? null,
            )
          )[0]!;
          if (alert.ownerMembershipId)
            for (const channel of rule.channels as string[])
              await tx.$executeRawUnsafe(
                `INSERT INTO app.notification_deliveries(tenant_id,alert_id,membership_id,channel,destination_hash) VALUES($1::uuid,$2::uuid,$3::uuid,$4,encode(digest($5,'sha256'),'hex')) ON CONFLICT DO NOTHING`,
                rule.tenant_id,
                alert.id,
                alert.ownerMembershipId,
                channel,
                `${rule.tenant_id}:${alert.ownerMembershipId}:${channel}`,
              );
        } else
          await tx.$executeRawUnsafe(
            `UPDATE app.operational_alerts SET state='RESOLVED',resolved_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND deduplication_key=$2 AND state<>'RESOLVED'`,
            rule.tenant_id,
            dedup,
          );
      }
    }
    return evaluated;
  }

  private observations(tx: Tx, rule: Row) {
    const metric = String(rule.metric_code ?? "");
    if (metric === "PLACEMENT_OVERDUE_MINUTES")
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,greatest(0,extract(epoch FROM(now()-committed_placement_at))/60) value,owner_membership_id AS "ownerMembershipId",committed_placement_at AS "dueAt" FROM app.indents WHERE tenant_id=$1::uuid AND state IN ('OPEN','PARTIALLY_ALLOCATED')`,
        rule.tenant_id,
      );
    if (metric === "POD_AGE_DAYS")
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT p.id,greatest(0,extract(day FROM(now()-p.delivered_at))) value,i.owner_membership_id AS "ownerMembershipId",p.delivered_at AS "dueAt" FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE p.tenant_id=$1::uuid AND p.received_at IS NULL`,
        rule.tenant_id,
      );
    if (metric === "INVOICE_OVERDUE_DAYS")
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,greatest(0,current_date-due_date) value,null::uuid AS "ownerMembershipId",due_date AS "dueAt" FROM app.client_invoices WHERE tenant_id=$1::uuid AND state IN ('POSTED','SUBMITTED')`,
        rule.tenant_id,
      );
    if (metric === "COMPLIANCE_EXPIRY_DAYS")
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,greatest(0,current_date-valid_to) value,null::uuid AS "ownerMembershipId",valid_to AS "dueAt" FROM app.compliance_records WHERE tenant_id=$1::uuid AND verification_state='VERIFIED'`,
        rule.tenant_id,
      );
    return Promise.resolve([]);
  }

  private async notificationDeliveries(tx: Tx, limit: number) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT d.id,d.tenant_id AS "tenantId",d.attempts FROM app.notification_deliveries d WHERE d.state IN ('PENDING','FAILED') AND d.available_at<=now() ORDER BY d.available_at,d.id FOR UPDATE SKIP LOCKED LIMIT $1`,
      limit,
    );
    for (const row of rows) {
      const attempt = Number(row.attempts) + 1;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.notification_delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,safe_error_code) VALUES($1::uuid,$2::uuid,$3,'SUPPRESSED','LOCAL_ADAPTER_UNAVAILABLE')`,
        row.tenantId,
        row.id,
        attempt,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.notification_deliveries SET state='SUPPRESSED',attempts=$1,leased_at=now(),delivered_at=null,safe_error_code='LOCAL_ADAPTER_UNAVAILABLE' WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        attempt,
        row.tenantId,
        row.id,
      );
    }
    return rows.length;
  }

  private async integrationDeliveries(tx: Tx, limit: number) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT d.*,e.endpoint,e.integration_type,e.retry_policy FROM app.integration_deliveries d JOIN app.integration_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id WHERE d.state IN ('PENDING','FAILED') AND d.available_at<=now() ORDER BY d.available_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1`,
      limit,
    );
    for (const row of rows) {
      const attempt = Number(row.attempts) + 1,
        maxAttempts = Number(
          (row.retry_policy as Record<string, unknown>)?.maxAttempts ?? 3,
        );
      const outcome = attempt >= maxAttempts ? "DEAD_LETTER" : "RETRY";
      await tx.$executeRawUnsafe(
        `INSERT INTO app.integration_delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,status_code,latency_ms,safe_error_code) VALUES($1::uuid,$2::uuid,$3,$4,$5,0,$6)`,
        row.tenant_id,
        row.id,
        attempt,
        outcome,
        null,
        "LOCAL_ADAPTER_UNAVAILABLE",
      );
      if (outcome === "RETRY")
        await tx.$executeRawUnsafe(
          `UPDATE app.integration_deliveries SET state='FAILED',attempts=$1,available_at=now()+make_interval(secs=>least(3600,power(2,$1)::int*30)),last_error_code='LOCAL_ADAPTER_UNAVAILABLE',updated_at=now(),version=version+1 WHERE id=$2::uuid`,
          attempt,
          row.id,
        );
      else {
        await tx.$executeRawUnsafe(
          `UPDATE app.integration_deliveries SET state='DEAD_LETTER',attempts=$1,last_error_code='LOCAL_ADAPTER_UNAVAILABLE',updated_at=now(),version=version+1 WHERE id=$2::uuid`,
          attempt,
          row.id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.integration_dead_letters(id,tenant_id,delivery_id,reason_code,safe_error) VALUES($1::uuid,$2::uuid,$1::uuid,'LOCAL_ADAPTER_UNAVAILABLE','No external provider is configured') ON CONFLICT(tenant_id,delivery_id) DO UPDATE SET resolved_at=null,resolution_reason=null,updated_at=now()`,
          row.id,
          row.tenant_id,
        );
      }
    }
    return rows.length;
  }

  private async accountingProjection(tx: Tx, limit: number) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT o.id,o.tenant_id AS "tenantId",o.aggregate_type AS "type",o.aggregate_id AS "aggregateId",o.event_type AS "eventType",o.payload FROM app.outbox_events o WHERE o.state='PENDING' AND o.event_type IN ('invoices.posted.v1','receipts.reconciled.v1','vendor-bills.approved.v1','payment-batches.paid.v1') ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT $1`,
      limit,
    );
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.accounting_reconciliation_entries(tenant_id,document_type,document_id,event_key,state,amount_minor) VALUES($1::uuid,$2,$3::uuid,$4,'PENDING',$5) ON CONFLICT(tenant_id,event_key) DO NOTHING`,
        row.tenantId,
        row.type,
        row.aggregateId,
        `${row.eventType}:${row.aggregateId}`,
        String(
          payload.totalMinor ??
            payload.amountMinor ??
            payload.payableMinor ??
            "0",
        ),
      );
    }
    return rows.length;
  }
}
