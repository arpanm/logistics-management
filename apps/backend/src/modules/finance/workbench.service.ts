import { Inject, Injectable } from "@nestjs/common";
import { withTenant, type Prisma } from "@logistics/db";
import type { SessionActor } from "@logistics/auth";
import { AppError, AppService } from "../../app.service.js";
import {
  canonicalJson,
  sha256,
  tenantKeyHash,
} from "../control/idempotency.js";
import { roundBasisPointMinor } from "./provider.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type TenantActor = SessionActor & { membershipId?: string | null };

const asBigInt = (value: string, field: string) => {
  if (!/^-?(0|[1-9]\d*)$/.test(value))
    throw new AppError(
      400,
      "VALIDATION_FAILED",
      `${field} must be exact minor units`,
    );
  return BigInt(value);
};
const jsonSafe = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );

@Injectable()
export class FinanceWorkbenchService {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private tenant(actor: TenantActor) {
    if (!actor.activeTenantId || !actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "Select a tenant first",
      );
    return actor.activeTenantId;
  }

  private async assertInternal(tx: Tx, actor: TenantActor) {
    const member = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT portal_audience AS audience FROM app.tenant_memberships
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND user_id=$3::uuid AND status='ACTIVE'`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
      )
    )[0];
    if (member?.audience !== "INTERNAL")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Finance workbench is for internal users",
      );
  }

  private async allowed(
    tx: Tx,
    actor: TenantActor,
    capability: "finance.read" | "finance.admin",
    action: "READ" | "CREATE" | "UPDATE" | "APPROVE",
    resource: "invoices" | "receipts" | "vendor-bills" | "clients" | "vendors",
    id: string,
  ) {
    const tenant = this.tenant(actor);
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid) allowed`,
        tenant,
        actor.membershipId,
        actor.userId,
        capability,
        action,
        resource,
        id,
      )
    )[0];
    if (row?.allowed !== true && row?.allowed !== "t")
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private async audit(
    tx: Tx,
    actor: TenantActor,
    action: string,
    type: string,
    id: string,
    correlationId: string,
    before: Row | null,
    after: Row,
    reason?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9)`,
      this.tenant(actor),
      actor.userId,
      action,
      type,
      id,
      correlationId,
      before ? jsonSafe(before) : null,
      jsonSafe(after),
      reason ?? null,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
       VALUES($1::uuid,'TENANT',$2,$3::uuid,$4,$5::jsonb,$6) ON CONFLICT(deduplication_key) DO NOTHING`,
      this.tenant(actor),
      type,
      id,
      action,
      JSON.stringify({ id, action }),
      `${action}:${id}:${sha256(jsonSafe(after)).slice(0, 24)}`,
    );
  }

  private async replay(
    tx: Tx,
    actor: TenantActor,
    route: string,
    key: string,
    body: unknown,
  ) {
    if (!key || key.length < 8 || key.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const operation = `finance-workbench:${route}`;
    const keyHash = tenantKeyHash(this.tenant(actor), key);
    const requestHash = sha256(canonicalJson(body));
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${this.tenant(actor)}:${actor.userId}:${operation}:${keyHash}`,
    );
    const prior = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT request_hash AS "requestHash",response_json AS response
         FROM app.idempotency_records
         WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
        this.tenant(actor),
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (prior && prior.requestHash !== requestHash)
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for different input",
      );
    return {
      operation,
      keyHash,
      requestHash,
      prior: prior?.response as Row | undefined,
    };
  }

  private remember(
    tx: Tx,
    actor: TenantActor,
    replay: { operation: string; keyHash: string; requestHash: string },
    resourceId: string,
    response: Row,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      this.tenant(actor),
      actor.userId,
      replay.operation,
      replay.keyHash,
      replay.requestHash,
      resourceId,
      jsonSafe(response),
    );
  }

  async dashboard(actor: TenantActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.assertInternal(tx, actor);
      const [
        metrics,
        invoices,
        collections,
        receipts,
        bills,
        batches,
        vendorServices,
      ] = await Promise.all([
        tx.$queryRawUnsafe<Row[]>(
          `SELECT
              (SELECT count(*)::int FROM app.trips t JOIN app.pod_tasks p ON p.tenant_id=t.tenant_id AND p.trip_id=t.id
                WHERE t.tenant_id=$1::uuid AND t.state='DELIVERED' AND p.state IN ('ACCEPTED','SUBMITTED_TO_CLIENT','CLOSED')
                AND NOT EXISTS(SELECT 1 FROM app.invoice_service_links l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id)
                AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','pod-tasks',p.id)) AS "unbilledServices",
              (SELECT count(*)::int FROM app.client_invoices i WHERE i.tenant_id=$1::uuid AND i.state IN ('DRAFT','PENDING_APPROVAL','APPROVED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',i.id)) AS "invoiceWork",
              (SELECT count(*)::int FROM app.client_invoices i WHERE i.tenant_id=$1::uuid AND i.state='POSTED' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',i.id)) AS "postedUnsubmitted",
              (SELECT count(*)::int FROM app.receipts r WHERE r.tenant_id=$1::uuid AND r.state<>'REVERSED' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','receipts',r.id) AND r.amount_minor>coalesce((SELECT sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END) FROM app.receipt_ledger_entries e WHERE e.tenant_id=r.tenant_id AND e.receipt_id=r.id),0)) AS "unallocatedReceipts",
              (SELECT count(*)::int FROM app.vendor_bills b WHERE b.tenant_id=$1::uuid AND b.state NOT IN ('PAID','REVERSED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','vendor-bills',b.id)) AS "vendorPayables",
              (SELECT count(*)::int FROM app.trips t WHERE t.tenant_id=$1::uuid AND t.state='DELIVERED' AND NOT EXISTS(SELECT 1 FROM app.vendor_bill_lines l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id) AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','trips',t.id)) AS "unbilledVendorServices"`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT i.id,i.invoice_no AS "invoiceNo",c.legal_name AS client,i.state,i.invoice_date AS "invoiceDate",i.due_date AS "dueDate",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN i.total_minor::text ELSE '••••' END AS "totalMinor",i.version
             FROM app.client_invoices i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
             WHERE i.tenant_id=$1::uuid AND i.state IN ('DRAFT','REJECTED','PENDING_APPROVAL','APPROVED','POSTED')
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',i.id)
             ORDER BY CASE i.state WHEN 'PENDING_APPROVAL' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'POSTED' THEN 2 ELSE 3 END,i.created_at LIMIT 500`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT i.id,i.invoice_no AS "invoiceNo",c.legal_name AS client,i.due_date AS "dueDate",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN i.total_minor::text ELSE '••••' END AS "totalMinor",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN greatest(i.total_minor-coalesce((SELECT sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END) FROM app.receipt_ledger_entries e WHERE e.tenant_id=i.tenant_id AND e.invoice_id=i.id),0),0)::text ELSE '••••' END AS "openMinor",
              CASE WHEN current_date>i.due_date+45 THEN 'RED' WHEN current_date>i.due_date+30 THEN 'YELLOW' ELSE 'GREEN' END priority,
              (SELECT max(f.created_at) FROM app.collection_followups f WHERE f.tenant_id=i.tenant_id AND f.invoice_id=i.id) AS "lastFollowupAt",i.version
             FROM app.client_invoices i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
             WHERE i.tenant_id=$1::uuid AND i.state IN ('POSTED','SUBMITTED')
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',i.id)
             GROUP BY i.id,c.legal_name HAVING i.total_minor-coalesce((SELECT sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END) FROM app.receipt_ledger_entries e WHERE e.tenant_id=i.tenant_id AND e.invoice_id=i.id),0)>0
             ORDER BY priority DESC,i.due_date NULLS LAST LIMIT 500`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT r.id,r.receipt_ref AS "receiptRef",c.legal_name AS client,r.payment_date AS "paymentDate",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','receipts',r.id) THEN r.amount_minor::text ELSE '••••' END AS "amountMinor",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','receipts',r.id) THEN (r.amount_minor-coalesce(sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END),0))::text ELSE '••••' END AS "unallocatedMinor",r.state,r.version
             FROM app.receipts r JOIN app.clients c ON c.tenant_id=r.tenant_id AND c.id=r.client_id
             LEFT JOIN app.receipt_ledger_entries e ON e.tenant_id=r.tenant_id AND e.receipt_id=r.id
             WHERE r.tenant_id=$1::uuid AND r.state<>'REVERSED'
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','receipts',r.id)
             GROUP BY r.id,c.legal_name HAVING r.amount_minor>coalesce(sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END),0)
             ORDER BY r.payment_date LIMIT 50`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT b.id,b.vendor_id AS "vendorId",b.vendor_invoice_no AS "vendorInvoiceNo",v.legal_name AS vendor,b.state,b.invoice_date AS "invoiceDate",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','vendor-bills',b.id) THEN b.payable_minor::text ELSE '••••' END AS "payableMinor",
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','vendor-bills',b.id) THEN (b.payable_minor-coalesce(sum(pa.amount_minor) FILTER(WHERE pb.id IS NOT NULL),0))::text ELSE '••••' END AS "outstandingMinor",b.version
             FROM app.vendor_bills b JOIN app.vendors v ON v.tenant_id=b.tenant_id AND v.id=b.vendor_id
             LEFT JOIN app.payment_allocations pa ON pa.tenant_id=b.tenant_id AND pa.vendor_bill_id=b.id
             LEFT JOIN app.payment_batches pb ON pb.tenant_id=pa.tenant_id AND pb.id=pa.payment_batch_id AND pb.state='PAID'
             WHERE b.tenant_id=$1::uuid
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','vendor-bills',b.id)
             GROUP BY b.id,v.legal_name ORDER BY CASE WHEN b.state IN ('VALIDATION_EXCEPTION','DISPUTED') THEN 0 WHEN b.state LIKE 'PENDING_%' THEN 1 ELSE 2 END,b.invoice_date DESC LIMIT 500`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT p.id,p.batch_no AS "batchNo",p.state,
              CASE WHEN NOT EXISTS(SELECT 1 FROM app.payment_allocations sx WHERE sx.tenant_id=p.tenant_id AND sx.payment_batch_id=p.id AND NOT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','vendor-bills',sx.vendor_bill_id)) THEN p.total_minor::text ELSE '••••' END AS "totalMinor",
              CASE WHEN NOT EXISTS(SELECT 1 FROM app.payment_allocations sx WHERE sx.tenant_id=p.tenant_id AND sx.payment_batch_id=p.id AND NOT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.bank_detail.read','READ','vendor-bills',sx.vendor_bill_id)) THEN p.utr ELSE CASE WHEN p.utr IS NULL THEN NULL ELSE '••••' END END AS utr,
              p.version,count(a.id)::int AS allocations
             FROM app.payment_batches p LEFT JOIN app.payment_allocations a ON a.tenant_id=p.tenant_id AND a.payment_batch_id=p.id
             WHERE p.tenant_id=$1::uuid AND EXISTS(SELECT 1 FROM app.payment_allocations x WHERE x.tenant_id=p.tenant_id AND x.payment_batch_id=p.id AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','vendor-bills',x.vendor_bill_id)) GROUP BY p.id ORDER BY p.created_at DESC LIMIT 500`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT t.id,t.id AS "tripId",t.trip_no AS "tripNo",t.lr_no AS "lrNo",v.id AS "vendorId",v.legal_name AS vendor,
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.commercial_rate.read','READ','vendors',v.id) THEN a.offered_rate_minor::text ELSE '••••' END AS "expectedMinor"
             FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id
             JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
             WHERE t.tenant_id=$1::uuid AND t.state='DELIVERED'
               AND NOT EXISTS(SELECT 1 FROM app.vendor_bill_lines l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id)
               AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','trips',t.id)
             ORDER BY t.updated_at LIMIT 100`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
      ]);
      return {
        asOf: new Date().toISOString(),
        metrics: metrics[0] ?? {},
        queues: {
          invoices,
          collections,
          unallocatedReceipts: receipts,
          vendorBills: bills,
          paymentRuns: batches,
          vendorServices,
        },
      };
    });
  }

  async invoices(
    actor: TenantActor,
    filters: {
      search: string;
      status: string;
      clientId: string;
      from: string;
      to: string;
    },
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT i.id,i.invoice_no AS "invoiceNo",i.client_id AS "clientId",c.legal_name AS client,
            i.invoice_date AS "invoiceDate",i.acknowledged_at AS "acknowledgedAt",i.due_date AS "dueDate",
            i.currency,i.credit_days AS "creditDays",
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN i.taxable_minor::text ELSE '••••' END AS "taxableMinor",
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN i.tax_minor::text ELSE '••••' END AS "taxMinor",
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN i.total_minor::text ELSE '••••' END AS "totalMinor",i.state,i.version,
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',i.id) THEN greatest(i.total_minor-coalesce((SELECT sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END) FROM app.receipt_ledger_entries e WHERE e.tenant_id=i.tenant_id AND e.invoice_id=i.id),0),0)::text ELSE '••••' END AS "openMinor"
         FROM app.client_invoices i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
         WHERE i.tenant_id=$1::uuid
           AND ($4='' OR i.state=$4)
           AND (nullif($5,'') IS NULL OR i.client_id=nullif($5,'')::uuid)
           AND (nullif($6,'') IS NULL OR i.invoice_date>=nullif($6,'')::date)
           AND (nullif($7,'') IS NULL OR i.invoice_date<=nullif($7,'')::date)
           AND ($8='' OR i.invoice_no ILIKE '%'||$8||'%' OR c.legal_name ILIKE '%'||$8||'%')
           AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',i.id)
         ORDER BY i.invoice_date DESC,i.created_at DESC LIMIT 500`,
        tenant,
        actor.membershipId,
        actor.userId,
        filters.status,
        filters.clientId,
        filters.from,
        filters.to,
        filters.search,
      );
      return {
        items: rows,
        count: rows.length,
        asOf: new Date().toISOString(),
      };
    });
  }

  async receipts(actor: TenantActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT r.id,r.receipt_ref AS "receiptRef",r.client_id AS "clientId",c.legal_name AS client,
            r.payment_date AS "paymentDate",
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','receipts',r.id) THEN r.amount_minor::text ELSE '••••' END AS "amountMinor",r.mode,
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.bank_detail.read','READ','receipts',r.id) THEN r.instrument_no ELSE '••••' END AS "instrumentNo",
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.bank_detail.read','READ','receipts',r.id) THEN r.bank_reference ELSE CASE WHEN r.bank_reference IS NULL THEN NULL ELSE '••••' END END AS "bankReference",r.state,r.version,
            CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','receipts',r.id) THEN (r.amount_minor-coalesce(sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) ELSE abs(e.amount_minor) END),0))::text ELSE '••••' END AS "unallocatedMinor"
         FROM app.receipts r JOIN app.clients c ON c.tenant_id=r.tenant_id AND c.id=r.client_id
         LEFT JOIN app.receipt_ledger_entries e ON e.tenant_id=r.tenant_id AND e.receipt_id=r.id
         WHERE r.tenant_id=$1::uuid
           AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','receipts',r.id)
         GROUP BY r.id,c.legal_name ORDER BY r.payment_date DESC,r.created_at DESC LIMIT 500`,
        tenant,
        actor.membershipId,
        actor.userId,
      );
      return {
        items: rows,
        count: rows.length,
        asOf: new Date().toISOString(),
      };
    });
  }

  async references(actor: TenantActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.assertInternal(tx, actor);
      const [services, charges, banks, clients] = await Promise.all([
        tx.$queryRawUnsafe<Row[]>(
          `SELECT t.id AS "tripId",p.id AS "podTaskId",t.trip_no AS "tripNo",t.lr_no AS "lrNo",i.client_id AS "clientId",i.client_location_id AS "clientLocationId",i.lane_id AS "laneId",c.legal_name AS client,p.state AS "podState"
           FROM app.trips t JOIN app.pod_tasks p ON p.tenant_id=t.tenant_id AND p.trip_id=t.id
           JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id
           JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
           WHERE t.tenant_id=$1::uuid AND t.state='DELIVERED' AND p.state IN ('ACCEPTED','SUBMITTED_TO_CLIENT','CLOSED')
           AND NOT EXISTS(SELECT 1 FROM app.invoice_service_links l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id)
           AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','pod-tasks',p.id)
           ORDER BY t.updated_at LIMIT 200`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT DISTINCT ON (lane_id,charge_code) lane_id AS "laneId",charge_code AS code,basis,
              CASE WHEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.commercial_rate.read','READ','lanes',lane_id) THEN amount_minor::text ELSE '••••' END AS "rateMinor",tax_basis_points AS "taxBasisPoints"
           FROM app.client_rate_lines WHERE tenant_id=$1::uuid AND state='PUBLISHED' AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','lanes',lane_id)
           ORDER BY lane_id,charge_code,priority DESC,effective_from DESC`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT b.id AS "bankVersionId",v.id AS "vendorId",v.legal_name AS vendor,b.account_holder AS "accountHolder",b.ifsc,b.version
           FROM app.vendor_bank_versions b JOIN app.vendors v ON v.tenant_id=b.tenant_id AND v.id=b.vendor_id
           WHERE b.tenant_id=$1::uuid AND b.state='VERIFIED'
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','vendors',v.id)
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.bank_detail.read','READ','vendors',v.id)
           ORDER BY v.legal_name`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Row[]>(
          `SELECT id,legal_name AS name,code FROM app.clients
           WHERE tenant_id=$1::uuid AND state='ACTIVE'
             AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','clients',id)
           ORDER BY legal_name LIMIT 500`,
          tenant,
          actor.membershipId,
          actor.userId,
        ),
      ]);
      return { services, charges, banks, clients };
    });
  }

  async createReceipt(
    actor: TenantActor,
    input: CreateReceipt,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "clients",
        input.clientId,
      );
      const replay = await this.replay(
        tx,
        actor,
        "receipts:create",
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const amount = asBigInt(input.amountMinor, "amountMinor");
      if (amount <= 0n)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Receipt amount must be positive",
        );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.receipts(tenant_id,receipt_ref,client_id,payment_date,amount_minor,mode,instrument_no,bank_reference,created_by)
           VALUES($1::uuid,$2,$3::uuid,$4::date,$5,$6,$7,$8,$9::uuid)
           RETURNING id,receipt_ref AS "receiptRef",state,amount_minor::text AS "amountMinor",version`,
          tenant,
          input.receiptRef,
          input.clientId,
          input.paymentDate,
          amount.toString(),
          input.mode,
          input.instrumentNo,
          input.bankReference ?? null,
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "receipt.created",
        "receipt",
        String(row.id),
        correlationId,
        null,
        row,
      );
      await this.remember(tx, actor, replay, String(row.id), row);
      return row;
    });
  }

  async createInvoice(
    actor: TenantActor,
    input: CreateInvoice,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "clients",
        input.clientId,
      );
      const replay = await this.replay(
        tx,
        actor,
        "invoices:create",
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      if (
        new Set(input.lines.map((line) => line.tripId)).size !==
        input.lines.length
      )
        throw new AppError(
          400,
          "DUPLICATE_SERVICE",
          "A trip can appear only once in an invoice",
        );
      let taxable = 0n,
        tax = 0n;
      const calculated = [] as Array<
        CreateInvoice["lines"][number] & {
          quantity: bigint;
          rate: bigint;
          taxable: bigint;
          tax: bigint;
          total: bigint;
        }
      >;
      for (const line of input.lines) {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `${tenant}:invoice-service:${line.tripId}`,
        );
        const eligible = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT r.amount_minor::text AS "rateMinor",r.tax_basis_points AS "taxBasisPoints"
             FROM app.trips t JOIN app.pod_tasks p ON p.tenant_id=t.tenant_id AND p.trip_id=t.id
             JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id
             JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id
             JOIN app.client_rate_lines r ON r.tenant_id=i.tenant_id AND r.lane_id=i.lane_id AND r.charge_code=$7
             WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND p.id=$3::uuid
               AND i.client_id=$4::uuid AND i.client_location_id=$5::uuid
               AND t.state='DELIVERED' AND p.state IN ('ACCEPTED','SUBMITTED_TO_CLIENT','CLOSED')
               AND r.state='PUBLISHED' AND r.effective_from<=now() AND (r.effective_to IS NULL OR r.effective_to>now())
               AND app.domain_resource_authorized($1::uuid,$6::uuid,$8::uuid,'finance.admin','CREATE','pod-tasks',p.id)
               AND NOT EXISTS(SELECT 1 FROM app.invoice_service_links l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id)
             ORDER BY r.priority DESC,r.effective_from DESC LIMIT 1`,
            tenant,
            line.tripId,
            line.podTaskId,
            input.clientId,
            input.clientLocationId,
            actor.membershipId,
            line.chargeCode,
            actor.userId,
          )
        )[0];
        if (!eligible)
          throw new AppError(
            409,
            "SERVICE_NOT_ELIGIBLE",
            "A selected trip, POD, or charge is no longer eligible",
          );
        if (
          String(eligible.rateMinor) !== line.rateMinor ||
          Number(eligible.taxBasisPoints) !== line.taxBasisPoints
        )
          throw new AppError(
            409,
            "RATE_CHANGED",
            "A published charge changed; refresh the invoice preview",
          );
        const quantity = asBigInt(line.quantityMilli, "quantityMilli");
        if (quantity <= 0n)
          throw new AppError(
            400,
            "VALIDATION_FAILED",
            "quantityMilli must be positive",
          );
        const rate = asBigInt(line.rateMinor, "rateMinor");
        const lineTaxable = (quantity * rate) / 1000n;
        const lineTax = roundBasisPointMinor(
          lineTaxable,
          BigInt(line.taxBasisPoints),
        );
        taxable += lineTaxable;
        tax += lineTax;
        calculated.push({
          ...line,
          quantity,
          rate,
          taxable: lineTaxable,
          tax: lineTax,
          total: lineTaxable + lineTax,
        });
      }
      const invoice = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.client_invoices(tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,state,created_by)
         VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::date,$6,$7,$8,$9,$10,'DRAFT',$11::uuid) RETURNING id,invoice_no AS "invoiceNo",state,total_minor::text AS "totalMinor",version`,
          tenant,
          input.invoiceNo,
          input.clientId,
          input.clientLocationId,
          input.invoiceDate,
          input.currency,
          input.creditDays,
          taxable.toString(),
          tax.toString(),
          (taxable + tax).toString(),
          actor.userId,
        )
      )[0]!;
      for (const [index, line] of calculated.entries()) {
        const inserted = (
          await tx.$queryRawUnsafe<Row[]>(
            `INSERT INTO app.client_invoice_lines(tenant_id,invoice_id,line_no,charge_code,quantity_milli,rate_minor,taxable_minor,tax_basis_points,tax_minor,total_minor,rate_snapshot)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
            tenant,
            invoice.id,
            index + 1,
            line.chargeCode,
            line.quantity.toString(),
            line.rate.toString(),
            line.taxable.toString(),
            line.taxBasisPoints,
            line.tax.toString(),
            line.total.toString(),
            JSON.stringify({
              source: "FINANCE_WORKBENCH",
              chargeCode: line.chargeCode,
              rateMinor: line.rateMinor,
            }),
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.invoice_service_links(tenant_id,invoice_line_id,trip_id,pod_task_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
          tenant,
          inserted.id,
          line.tripId,
          line.podTaskId,
        );
      }
      await this.audit(
        tx,
        actor,
        "invoice.created",
        "client_invoice",
        String(invoice.id),
        correlationId,
        null,
        invoice,
      );
      await this.remember(tx, actor, replay, String(invoice.id), invoice);
      return invoice;
    });
  }

  async invoiceAction(
    actor: TenantActor,
    id: string,
    input: InvoiceAction,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      const scopedAction = ["APPROVE", "REJECT", "POST", "REVERSE"].includes(
        input.action,
      )
        ? "APPROVE"
        : "UPDATE";
      await this.allowed(
        tx,
        actor,
        "finance.admin",
        scopedAction,
        "invoices",
        id,
      );
      const replay = await this.replay(
        tx,
        actor,
        `invoices:${id}:action`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Invoice changed; refresh and try again",
        );
      const state = String(before.state);
      if (input.action === "REVERSE") {
        if (!["POSTED", "SUBMITTED"].includes(state))
          throw new AppError(
            409,
            "STATE_CONFLICT",
            `REVERSE is not available from ${state}`,
          );
        if (!input.reversalInvoiceNo || !input.reason)
          throw new AppError(
            400,
            "VALIDATION_FAILED",
            "Reversal invoice number and reason are required",
          );
        const reversal = (
          await tx.$queryRawUnsafe<Row[]>(
            `INSERT INTO app.client_invoices(tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,state,reversal_of,created_by,posted_at)
             VALUES($1::uuid,$2,$3::uuid,$4::uuid,current_date,$5,$6,$7,$8,$9,'POSTED',$10::uuid,$11::uuid,now())
             RETURNING id,invoice_no AS "invoiceNo",state,total_minor::text AS "totalMinor",version`,
            tenant,
            input.reversalInvoiceNo,
            before.client_id,
            before.client_location_id,
            before.currency,
            before.credit_days,
            (-BigInt(String(before.taxable_minor))).toString(),
            (-BigInt(String(before.tax_minor))).toString(),
            (-BigInt(String(before.total_minor))).toString(),
            id,
            actor.userId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.client_invoice_lines(tenant_id,invoice_id,line_no,charge_code,quantity_milli,rate_minor,taxable_minor,tax_basis_points,tax_minor,total_minor,rate_snapshot)
           SELECT tenant_id,$1::uuid,line_no,'REVERSAL:'||charge_code,-quantity_milli,rate_minor,-taxable_minor,tax_basis_points,-tax_minor,-total_minor,rate_snapshot||jsonb_build_object('reversalOfLineId',id)
           FROM app.client_invoice_lines WHERE tenant_id=$2::uuid AND invoice_id=$3::uuid`,
          reversal.id,
          tenant,
          id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.client_invoices SET state='REVERSED',version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenant,
          id,
        );
        await this.audit(
          tx,
          actor,
          "invoice.reversed",
          "client_invoice",
          id,
          correlationId,
          before,
          reversal,
          input.reason,
        );
        await this.remember(tx, actor, replay, String(reversal.id), reversal);
        return reversal;
      }
      const rules: Record<string, { from: string[]; to: string }> = {
        SUBMIT: { from: ["DRAFT", "REJECTED"], to: "PENDING_APPROVAL" },
        APPROVE: { from: ["PENDING_APPROVAL"], to: "APPROVED" },
        REJECT: { from: ["PENDING_APPROVAL"], to: "REJECTED" },
        POST: { from: ["APPROVED"], to: "POSTED" },
        ACKNOWLEDGE: { from: ["POSTED"], to: "SUBMITTED" },
      };
      const rule = rules[input.action];
      if (!rule.from.includes(state))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          `${input.action} is not available from ${state}`,
        );
      if (input.action === "REJECT" && !input.reason)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "A rejection reason is required",
        );
      if (
        input.action === "APPROVE" &&
        String(before.created_by) === actor.userId
      )
        throw new AppError(
          409,
          "SEGREGATION_REQUIRED",
          "Maker cannot approve their own invoice",
        );
      const acknowledged =
        input.action === "ACKNOWLEDGE" ? input.acknowledgedAt : null;
      if (input.action === "ACKNOWLEDGE" && !acknowledged)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Acknowledgement date is required",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.client_invoices SET state=$1,posted_at=CASE WHEN $1='POSTED' THEN now() ELSE posted_at END,
          acknowledged_at=coalesce($2::timestamptz,acknowledged_at),due_date=CASE WHEN $2::timestamptz IS NOT NULL THEN ($2::timestamptz AT TIME ZONE 'UTC')::date+credit_days ELSE due_date END,version=version+1
         WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING id,invoice_no AS "invoiceNo",state,total_minor::text AS "totalMinor",due_date AS "dueDate",version`,
          rule.to,
          acknowledged,
          tenant,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        `invoice.${input.action.toLowerCase()}`,
        "client_invoice",
        id,
        correlationId,
        before,
        after,
        input.reason,
      );
      await this.remember(tx, actor, replay, id, after);
      return after;
    });
  }

  async updateInvoice(
    actor: TenantActor,
    id: string,
    input: UpdateInvoice,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(tx, actor, "finance.admin", "UPDATE", "invoices", id);
      const replay = await this.replay(
        tx,
        actor,
        `invoices:${id}:update`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Invoice changed; refresh and try again",
        );
      if (!["DRAFT", "REJECTED"].includes(String(before.state)))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          "Only draft or rejected invoices can be edited",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.client_invoices SET invoice_no=$1,invoice_date=$2::date,credit_days=$3,version=version+1
           WHERE tenant_id=$4::uuid AND id=$5::uuid
           RETURNING id,invoice_no AS "invoiceNo",invoice_date AS "invoiceDate",credit_days AS "creditDays",state,total_minor::text AS "totalMinor",version`,
          input.invoiceNo,
          input.invoiceDate,
          input.creditDays,
          tenant,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "invoice.updated",
        "client_invoice",
        id,
        correlationId,
        before,
        after,
      );
      await this.remember(tx, actor, replay, id, after);
      return after;
    });
  }

  async addInvoiceNote(
    actor: TenantActor,
    id: string,
    input: InvoiceNote,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(tx, actor, "finance.admin", "UPDATE", "invoices", id);
      const replay = await this.replay(
        tx,
        actor,
        `invoices:${id}:notes:create`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const invoice = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id,state,version FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid AND state IN ('POSTED','SUBMITTED')`,
          tenant,
          id,
        )
      )[0];
      if (!invoice)
        throw new AppError(
          409,
          "STATE_CONFLICT",
          "Notes are available only for posted invoices",
        );
      const unsignedAmount = asBigInt(input.amountMinor, "amountMinor");
      if (unsignedAmount <= 0n)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Memo amount must be positive",
        );
      const amount =
        input.noteType === "CREDIT_NOTE" ? -unsignedAmount : unsignedAmount;
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.invoice_notes(tenant_id,invoice_id,note_type,amount_minor,reason,evidence,actor_id)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,'{}'::jsonb,$6::uuid)
           RETURNING id,note_type AS "noteType",amount_minor::text AS "amountMinor",reason,created_at AS "createdAt"`,
          tenant,
          id,
          input.noteType,
          amount.toString(),
          input.reason,
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "invoice.note_created",
        "client_invoice",
        id,
        correlationId,
        null,
        row,
        input.reason,
      );
      await this.remember(tx, actor, replay, String(row.id), row);
      return row;
    });
  }

  async followUp(
    actor: TenantActor,
    id: string,
    input: FollowUp,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(tx, actor, "finance.admin", "UPDATE", "invoices", id);
      const replay = await this.replay(
        tx,
        actor,
        `invoices:${id}:followups:create`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.collection_followups(tenant_id,invoice_id,outcome,note,promised_at,promised_minor,next_followup_at,actor_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6,$7::timestamptz,$8::uuid) RETURNING id,created_at AS "createdAt"`,
          tenant,
          id,
          input.outcome,
          input.note,
          input.promisedAt ?? null,
          input.promisedMinor ?? null,
          input.nextFollowupAt ?? null,
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "collection.followup",
        "client_invoice",
        id,
        correlationId,
        null,
        row,
      );
      await this.remember(tx, actor, replay, String(row.id), row);
      return row;
    });
  }

  async vendorAction(
    actor: TenantActor,
    id: string,
    input: VendorAction,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      const scopedAction = ["VERIFY", "APPROVE", "PAY"].includes(input.action)
        ? "APPROVE"
        : "UPDATE";
      await this.allowed(
        tx,
        actor,
        "finance.admin",
        scopedAction,
        "vendor-bills",
        id,
      );
      const replay = await this.replay(
        tx,
        actor,
        `vendor-bills:${id}:action`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.vendor_bills WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (
        input.action === "PAY" &&
        input.batchNo &&
        input.amountMinor &&
        input.bankVersionId
      ) {
        const existingBatch = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT p.id,p.batch_no AS "batchNo",p.state,p.total_minor::text AS "totalMinor",p.version FROM app.payment_batches p JOIN app.payment_allocations a ON a.tenant_id=p.tenant_id AND a.payment_batch_id=p.id WHERE p.tenant_id=$1::uuid AND p.batch_no=$2 AND p.bank_version_id=$3::uuid AND a.vendor_bill_id=$4::uuid AND a.amount_minor=$5 LIMIT 1`,
            tenant,
            input.batchNo,
            input.bankVersionId,
            id,
            input.amountMinor,
          )
        )[0];
        if (existingBatch) {
          await this.remember(
            tx,
            actor,
            replay,
            String(existingBatch.id),
            existingBatch,
          );
          return existingBatch;
        }
      }
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Vendor bill changed; refresh and try again",
        );
      const rules: Record<string, { from: string[]; to: string }> = {
        SUBMIT: {
          from: ["DRAFT", "VALIDATION_EXCEPTION"],
          to: "PENDING_OPERATIONAL_VERIFICATION",
        },
        VERIFY: {
          from: ["PENDING_OPERATIONAL_VERIFICATION"],
          to: "PENDING_FINANCE_APPROVAL",
        },
        APPROVE: { from: ["PENDING_FINANCE_APPROVAL"], to: "APPROVED" },
        DISPUTE: {
          from: [
            "VALIDATION_EXCEPTION",
            "PENDING_OPERATIONAL_VERIFICATION",
            "PENDING_FINANCE_APPROVAL",
          ],
          to: "DISPUTED",
        },
      };
      if (input.action === "PAY") {
        const result = await this.createPayment(
          tx,
          actor,
          id,
          before,
          input,
          correlationId,
        );
        await this.remember(tx, actor, replay, String(result.id), result);
        return result;
      }
      const rule = rules[input.action];
      if (!rule?.from.includes(String(before.state)))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          `${input.action} is not available from ${String(before.state)}`,
        );
      if (
        input.action === "APPROVE" &&
        String(before.created_by) === actor.userId
      )
        throw new AppError(
          409,
          "SEGREGATION_REQUIRED",
          "Maker cannot approve their own vendor bill",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.vendor_bills SET state=$1,verified_by=CASE WHEN $1='PENDING_FINANCE_APPROVAL' THEN $2::uuid ELSE verified_by END,approved_by=CASE WHEN $1='APPROVED' THEN $2::uuid ELSE approved_by END,version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING id,state,payable_minor::text AS "payableMinor",version`,
          rule.to,
          actor.userId,
          tenant,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        `vendor_bill.${input.action.toLowerCase()}`,
        "vendor_bill",
        id,
        correlationId,
        before,
        after,
        input.reason,
      );
      await this.remember(tx, actor, replay, id, after);
      return after;
    });
  }

  async createVendorBill(
    actor: TenantActor,
    input: CreateVendorBill,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.allowed(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "vendors",
        input.vendorId,
      );
      const replay = await this.replay(
        tx,
        actor,
        "vendor-bills:create",
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      if (
        new Set(input.lines.map((line) => line.tripId)).size !==
        input.lines.length
      )
        throw new AppError(
          400,
          "DUPLICATE_SERVICE",
          "A trip can appear only once in a vendor bill",
        );
      let taxable = 0n;
      const lines = [] as Array<{
        tripId: string;
        expected: bigint;
        claimed: bigint;
        variance: bigint;
      }>;
      for (const line of input.lines) {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `${tenant}:vendor-service:${line.tripId}`,
        );
        const eligible = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT a.offered_rate_minor::text AS "expectedMinor" FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND a.vendor_id=$3::uuid AND t.state='DELIVERED' AND app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'finance.admin','CREATE','trips',t.id) AND NOT EXISTS(SELECT 1 FROM app.vendor_bill_lines l WHERE l.tenant_id=t.tenant_id AND l.trip_id=t.id)`,
            tenant,
            line.tripId,
            input.vendorId,
            actor.membershipId,
            actor.userId,
          )
        )[0];
        if (!eligible)
          throw new AppError(
            409,
            "SERVICE_NOT_ELIGIBLE",
            "A selected vendor service is no longer eligible",
          );
        const expected = BigInt(String(eligible.expectedMinor)),
          claimed = asBigInt(line.claimedMinor, "claimedMinor");
        if (claimed < 0n)
          throw new AppError(
            400,
            "VALIDATION_FAILED",
            "Claimed amount cannot be negative",
          );
        taxable += claimed;
        lines.push({
          tripId: line.tripId,
          expected,
          claimed,
          variance: claimed - expected,
        });
      }
      const vendor = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT tds_basis_points FROM app.vendors WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenant,
          input.vendorId,
        )
      )[0]!;
      const gst = asBigInt(input.gstMinor, "gstMinor"),
        deduction = asBigInt(input.deductionMinor ?? "0", "deductionMinor"),
        advance = asBigInt(input.advanceMinor ?? "0", "advanceMinor");
      if (gst < 0n || deduction < 0n || advance < 0n)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "GST, deduction and advance cannot be negative",
        );
      const tds =
          (taxable * BigInt(Number(vendor.tds_basis_points)) + 5000n) / 10000n,
        payable = taxable + gst - tds - deduction - advance;
      if (payable < 0n)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Payable total cannot be negative",
        );
      const hasVariance = lines.some((line) => line.variance !== 0n);
      const bill = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.vendor_bills(tenant_id,vendor_id,vendor_invoice_no,invoice_date,taxable_minor,gst_minor,tds_minor,deduction_minor,advance_minor,payable_minor,state,created_by) VALUES($1::uuid,$2::uuid,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12::uuid) RETURNING id,vendor_invoice_no AS "vendorInvoiceNo",state,payable_minor::text AS "payableMinor",version`,
          tenant,
          input.vendorId,
          input.vendorInvoiceNo,
          input.invoiceDate,
          taxable.toString(),
          gst.toString(),
          tds.toString(),
          deduction.toString(),
          advance.toString(),
          payable.toString(),
          hasVariance ? "VALIDATION_EXCEPTION" : "DRAFT",
          actor.userId,
        )
      )[0]!;
      for (const line of lines)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.vendor_bill_lines(tenant_id,vendor_bill_id,trip_id,rate_snapshot,expected_minor,claimed_minor,variance_minor,validation_state) VALUES($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,$7,$8)`,
          tenant,
          bill.id,
          line.tripId,
          JSON.stringify({
            source: "ALLOCATION_OFFER",
            expectedMinor: line.expected.toString(),
          }),
          line.expected.toString(),
          line.claimed.toString(),
          line.variance.toString(),
          line.variance === 0n ? "MATCHED" : "VARIANCE",
        );
      await this.audit(
        tx,
        actor,
        "vendor_bill.created",
        "vendor_bill",
        String(bill.id),
        correlationId,
        null,
        bill,
      );
      await this.remember(tx, actor, replay, String(bill.id), bill);
      return bill;
    });
  }

  private async createPayment(
    tx: Tx,
    actor: TenantActor,
    id: string,
    before: Row,
    input: VendorAction,
    correlationId: string,
  ) {
    if (!["APPROVED", "PART_PAID"].includes(String(before.state)))
      throw new AppError(
        409,
        "STATE_CONFLICT",
        "Only approved bills can be paid",
      );
    if (!input.bankVersionId || !input.amountMinor || !input.batchNo)
      throw new AppError(
        400,
        "VALIDATION_FAILED",
        "Bank, amount, and batch number are required",
      );
    const amount = asBigInt(input.amountMinor, "amountMinor");
    if (amount <= 0n)
      throw new AppError(400, "VALIDATION_FAILED", "Payment must be positive");
    const tenant = this.tenant(actor);
    const bank = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT id FROM app.vendor_bank_versions WHERE tenant_id=$1::uuid AND id=$2::uuid AND vendor_id=$3::uuid AND state='VERIFIED'`,
        tenant,
        input.bankVersionId,
        before.vendor_id,
      )
    )[0];
    if (!bank)
      throw new AppError(
        409,
        "BANK_NOT_VERIFIED",
        "Select a current verified vendor bank account",
      );
    const paid = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT coalesce(sum(a.amount_minor),0)::text paid FROM app.payment_allocations a JOIN app.payment_batches p ON p.tenant_id=a.tenant_id AND p.id=a.payment_batch_id AND p.state NOT IN ('FAILED','REVERSED') WHERE a.tenant_id=$1::uuid AND a.vendor_bill_id=$2::uuid`,
        tenant,
        id,
      )
    )[0];
    const outstanding =
      BigInt(String(before.payable_minor)) - BigInt(String(paid?.paid ?? "0"));
    if (amount > outstanding)
      throw new AppError(
        409,
        "OVERPAYMENT_BLOCKED",
        "Payment exceeds vendor bill outstanding",
      );
    const batch = (
      await tx.$queryRawUnsafe<Row[]>(
        `INSERT INTO app.payment_batches(tenant_id,batch_no,bank_version_id,total_minor,state,maker_id) VALUES($1::uuid,$2,$3::uuid,$4,'PENDING_APPROVAL',$5::uuid) RETURNING id,batch_no AS "batchNo",state,total_minor::text AS "totalMinor",version`,
        tenant,
        input.batchNo,
        input.bankVersionId,
        amount.toString(),
        actor.userId,
      )
    )[0]!;
    await tx.$executeRawUnsafe(
      `INSERT INTO app.payment_allocations(tenant_id,payment_batch_id,vendor_bill_id,amount_minor) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,
      tenant,
      batch.id,
      id,
      amount.toString(),
    );
    await this.audit(
      tx,
      actor,
      "vendor_payment.created",
      "payment_batch",
      String(batch.id),
      correlationId,
      null,
      batch,
      input.reason,
    );
    return batch;
  }

  async paymentBatchAction(
    actor: TenantActor,
    id: string,
    input: PaymentBatchAction,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.assertInternal(tx, actor);
      const billIds = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT DISTINCT vendor_bill_id AS id FROM app.payment_allocations WHERE tenant_id=$1::uuid AND payment_batch_id=$2::uuid`,
        tenant,
        id,
      );
      if (!billIds.length)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      for (const bill of billIds)
        await this.allowed(
          tx,
          actor,
          "finance.admin",
          ["APPROVE", "MARK_PAID", "REVERSE"].includes(input.action)
            ? "APPROVE"
            : "UPDATE",
          "vendor-bills",
          bill.id,
        );
      const replay = await this.replay(
        tx,
        actor,
        `payment-runs:${id}:action`,
        idempotencyKey,
        input,
      );
      if (replay.prior) return replay.prior;
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.payment_batches WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Payment run changed; refresh and try again",
        );
      const rules: Record<string, { from: string[]; to: string }> = {
        APPROVE: { from: ["PENDING_APPROVAL"], to: "APPROVED" },
        SUBMIT: { from: ["APPROVED"], to: "SUBMITTED" },
        MARK_PAID: { from: ["SUBMITTED"], to: "PAID" },
        FAIL: { from: ["SUBMITTED"], to: "FAILED" },
        REVERSE: { from: ["PAID"], to: "REVERSED" },
      };
      const rule = rules[input.action];
      if (!rule.from.includes(String(before.state)))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          `${input.action} is not available from ${String(before.state)}`,
        );
      if (
        input.action === "APPROVE" &&
        String(before.maker_id) === actor.userId
      )
        throw new AppError(
          409,
          "SEGREGATION_REQUIRED",
          "Payment maker cannot approve the same run",
        );
      if (input.action === "MARK_PAID" && !input.utr)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "UTR is required to mark a payment run paid",
        );
      if (input.action === "REVERSE")
        await tx.$executeRawUnsafe(
          `INSERT INTO app.payment_allocations(tenant_id,payment_batch_id,vendor_bill_id,amount_minor,reversal_of) SELECT tenant_id,payment_batch_id,vendor_bill_id,-amount_minor,id FROM app.payment_allocations WHERE tenant_id=$1::uuid AND payment_batch_id=$2::uuid AND reversal_of IS NULL`,
          tenant,
          id,
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.payment_batches SET state=$1,checker_id=CASE WHEN $1='APPROVED' THEN $2::uuid ELSE checker_id END,utr=coalesce($3,utr),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid RETURNING id,batch_no AS "batchNo",state,total_minor::text AS "totalMinor",utr,version`,
          rule.to,
          actor.userId,
          input.utr ?? null,
          tenant,
          id,
        )
      )[0]!;
      if (input.action === "MARK_PAID" || input.action === "REVERSE")
        await tx.$executeRawUnsafe(
          `UPDATE app.vendor_bills b SET state=CASE WHEN paid.paid_minor<=0 THEN 'APPROVED' WHEN paid.paid_minor>=b.payable_minor THEN 'PAID' ELSE 'PART_PAID' END,version=version+1 FROM (SELECT a.vendor_bill_id,sum(CASE WHEN p.state='PAID' THEN a.amount_minor ELSE 0 END) AS paid_minor FROM app.payment_allocations a JOIN app.payment_batches p ON p.tenant_id=a.tenant_id AND p.id=a.payment_batch_id WHERE a.tenant_id=$1::uuid AND a.vendor_bill_id=ANY($2::uuid[]) GROUP BY a.vendor_bill_id) paid WHERE b.tenant_id=$1::uuid AND b.id=paid.vendor_bill_id`,
          tenant,
          billIds.map((b) => b.id),
        );
      await this.audit(
        tx,
        actor,
        `payment_batch.${input.action.toLowerCase()}`,
        "payment_batch",
        id,
        correlationId,
        before,
        after,
        input.reason,
      );
      await this.remember(tx, actor, replay, id, after);
      return after;
    });
  }
}

export type CreateInvoice = {
  invoiceNo: string;
  invoiceDate: string;
  clientId: string;
  clientLocationId: string;
  currency: string;
  creditDays: number;
  lines: Array<{
    tripId: string;
    podTaskId: string;
    chargeCode: string;
    quantityMilli: string;
    rateMinor: string;
    taxBasisPoints: number;
  }>;
};
export type InvoiceAction = {
  action: "SUBMIT" | "APPROVE" | "REJECT" | "POST" | "ACKNOWLEDGE" | "REVERSE";
  expectedVersion: number;
  acknowledgedAt?: string;
  reversalInvoiceNo?: string;
  reason?: string;
};
export type UpdateInvoice = {
  expectedVersion: number;
  invoiceNo: string;
  invoiceDate: string;
  creditDays: number;
};
export type InvoiceNote = {
  noteType: "CREDIT_NOTE" | "DEBIT_NOTE";
  amountMinor: string;
  reason: string;
};
export type CreateReceipt = {
  receiptRef: string;
  clientId: string;
  paymentDate: string;
  amountMinor: string;
  mode: "NEFT" | "RTGS" | "IMPS" | "CHEQUE" | "UPI" | "ADJUSTMENT";
  instrumentNo: string;
  bankReference?: string;
};
export type FollowUp = {
  outcome: string;
  note: string;
  promisedAt?: string;
  promisedMinor?: string;
  nextFollowupAt?: string;
};
export type VendorAction = {
  action: "SUBMIT" | "VERIFY" | "APPROVE" | "DISPUTE" | "PAY";
  expectedVersion: number;
  reason?: string;
  bankVersionId?: string;
  amountMinor?: string;
  batchNo?: string;
};
export type CreateVendorBill = {
  vendorInvoiceNo: string;
  invoiceDate: string;
  vendorId: string;
  gstMinor: string;
  deductionMinor?: string;
  advanceMinor?: string;
  lines: Array<{ tripId: string; claimedMinor: string }>;
};
export type PaymentBatchAction = {
  action: "APPROVE" | "SUBMIT" | "MARK_PAID" | "FAIL" | "REVERSE";
  expectedVersion: number;
  utr?: string;
  reason?: string;
};
