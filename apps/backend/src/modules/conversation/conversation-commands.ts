import type { SessionActor } from "@logistics/auth";
import type { Prisma } from "@logistics/db";
import { vendorCommandSchema } from "@logistics/domain";
import { z } from "zod";
import { AppError } from "../../app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
export type ConversationActor = SessionActor & { membershipId?: string | null };

const uuid = z.string().uuid();
const reference = z.string().trim().min(1).max(200);

export const clientConversationSchema = z
  .object({
    code: z.string(),
    legalName: z.string(),
    billingEntity: reference,
    industry: z.string().optional(),
    creditDays: z.number(),
    podMode: z.string(),
    taxIdentifier: z.string().optional(),
    escalationEmail: z.string().optional(),
    escalationMobile: z.string().optional(),
  })
  .strict();
export const vendorConversationSchema = vendorCommandSchema.pick({
  code: true,
  legalName: true,
  pan: true,
  gstin: true,
  tdsBasisPoints: true,
  paymentTermsDays: true,
});
export const receiptConversationSchema = z
  .object({
    receiptRef: z.string().trim().min(2).max(80),
    client: reference,
    paymentDate: z.string().date(),
    amountMinor: z.string().regex(/^[1-9]\d*$/),
    mode: z.enum(["CASH", "CHEQUE", "BANK_TRANSFER", "CARD", "OTHER"]),
    instrumentNo: z.string().trim().max(120).nullish(),
    bankReference: z.string().trim().max(120).nullish(),
  })
  .strict();

const operationResource = z.enum(["indent", "allocation", "trip", "pod"]);
const financeResource = z.enum(["invoice", "receipt", "vendor_bill"]);
export const statusConversationSchema = z
  .object({
    resource: z.union([operationResource, financeResource]),
    targetRef: reference,
    expectedVersion: z.number().int().positive(),
    toState: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]*$/),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export const approvalConversationSchema = z
  .object({
    instanceRef: reference,
    expectedVersion: z.number().int().positive(),
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: z.string().trim().min(5).max(1000),
  })
  .strict();
export const referenceSearchSchema = z
  .object({
    resource: z.enum([
      "client",
      "vendor",
      "vehicle",
      "driver",
      "lane",
      "indent",
      "allocation",
      "trip",
      "invoice",
      "receipt",
      "vendor_bill",
      "approval",
    ]),
    search: z.string().trim().min(1).max(120),
  })
  .strict();
export const statusReportSchema = z
  .object({
    resource: z.enum([
      "clients",
      "vendors",
      "vehicles",
      "drivers",
      "indents",
      "allocations",
      "trips",
      "pods",
      "invoices",
      "receipts",
      "vendor_bills",
      "approvals",
    ]),
    state: z.string().trim().toUpperCase().max(40).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

type ResourceDefinition = {
  table: string;
  domainResource: string;
  capability: "masters" | "operations" | "pod" | "finance" | "governance";
  ref: string;
  label: string;
};
const definitions: Record<string, ResourceDefinition> = {
  client: {
    table: "clients",
    domainResource: "clients",
    capability: "masters",
    ref: "code",
    label: "legal_name",
  },
  vendor: {
    table: "vendors",
    domainResource: "vendors",
    capability: "masters",
    ref: "code",
    label: "legal_name",
  },
  vehicle: {
    table: "vehicles",
    domainResource: "vehicles",
    capability: "masters",
    ref: "registration_number",
    label: "registration_number",
  },
  driver: {
    table: "drivers",
    domainResource: "drivers",
    capability: "masters",
    ref: "code",
    label: "display_name",
  },
  lane: {
    table: "contract_lanes",
    domainResource: "lanes",
    capability: "masters",
    ref: "code",
    label: "code",
  },
  indent: {
    table: "indents",
    domainResource: "indents",
    capability: "operations",
    ref: "indent_no",
    label: "indent_no",
  },
  allocation: {
    table: "allocations",
    domainResource: "allocations",
    capability: "operations",
    ref: "id",
    label: "id",
  },
  trip: {
    table: "trips",
    domainResource: "trips",
    capability: "operations",
    ref: "trip_no",
    label: "trip_no",
  },
  pod: {
    table: "pod_tasks",
    domainResource: "pod-tasks",
    capability: "pod",
    ref: "id",
    label: "id",
  },
  invoice: {
    table: "client_invoices",
    domainResource: "invoices",
    capability: "finance",
    ref: "invoice_no",
    label: "invoice_no",
  },
  receipt: {
    table: "receipts",
    domainResource: "receipts",
    capability: "finance",
    ref: "receipt_ref",
    label: "receipt_ref",
  },
  vendor_bill: {
    table: "vendor_bills",
    domainResource: "vendor-bills",
    capability: "finance",
    ref: "bill_no",
    label: "bill_no",
  },
};

function tenant(actor: ConversationActor) {
  if (!actor.activeTenantId || !actor.membershipId)
    throw new AppError(
      403,
      "TENANT_CONTEXT_REQUIRED",
      "An active tenant is required",
    );
  return actor.activeTenantId;
}

export async function resolveConversationReference(
  tx: Tx,
  actor: ConversationActor,
  resource: string,
  search: string,
  action = "READ",
  capabilityOverride?: string,
) {
  if (resource === "approval") {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT i.id,i.id::text AS reference,(i.target_type || ' approval') AS label,i.state,i.version
       FROM app.approval_instances i
       WHERE i.tenant_id=$1::uuid AND (i.id::text=$2 OR i.id::text ILIKE $3)
         AND CASE upper(i.target_type)
           WHEN 'CLIENT' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'clients',i.target_id)
           WHEN 'VENDOR' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'vendors',i.target_id)
           WHEN 'INDENT' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'indents',i.target_id)
           WHEN 'ALLOCATION' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'allocations',i.target_id)
           WHEN 'TRIP' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'trips',i.target_id)
           WHEN 'POD' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'pod-tasks',i.target_id)
           WHEN 'INVOICE' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'invoices',i.target_id)
           WHEN 'RECEIPT' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'receipts',i.target_id)
           WHEN 'VENDOR_BILL' THEN app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'governance.admin',$6,'vendor-bills',i.target_id)
           ELSE false END
       ORDER BY i.created_at DESC LIMIT 6`,
      tenant(actor),
      search,
      `%${search}%`,
      actor.membershipId,
      actor.userId,
      action,
    );
    return rows;
  }
  const definition = definitions[resource];
  if (!definition)
    throw new AppError(
      400,
      "REFERENCE_TYPE_INVALID",
      "Reference type is not supported",
    );
  const rows = await tx.$queryRawUnsafe<Array<Row>>(
    `SELECT r.id,r.${definition.ref}::text AS reference,r.${definition.label}::text AS label,coalesce(to_jsonb(r)->>'state','ACTIVE') AS state,(to_jsonb(r)->>'version')::int AS version
     FROM app.${definition.table} r
     WHERE r.tenant_id=$1::uuid AND (r.id::text=$2 OR r.${definition.ref}::text ILIKE $3 OR r.${definition.label}::text ILIKE $3)
       AND app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,$6,$7,$8,r.id)
     ORDER BY CASE WHEN r.id::text=$2 OR lower(r.${definition.ref}::text)=lower($2) THEN 0 ELSE 1 END,r.${definition.label} LIMIT 6`,
    tenant(actor),
    search,
    `%${search}%`,
    actor.membershipId,
    actor.userId,
    capabilityOverride ??
      `${definition.capability}.${action === "READ" ? "read" : "admin"}`,
    action,
    definition.domainResource,
  );
  return rows;
}

export async function resolveUniqueConversationReference(
  tx: Tx,
  actor: ConversationActor,
  resource: string,
  search: string,
  action = "READ",
  capabilityOverride?: string,
) {
  const rows = await resolveConversationReference(
    tx,
    actor,
    resource,
    search,
    action,
    capabilityOverride,
  );
  if (!rows.length)
    throw new AppError(
      404,
      "REFERENCE_NOT_FOUND",
      `No permitted ${resource.replace("_", " ")} matches “${search}”`,
    );
  if (rows.length > 1)
    throw new AppError(
      409,
      "REFERENCE_AMBIGUOUS",
      `Multiple permitted ${resource.replace("_", " ")} records match “${search}”: ${rows
        .slice(0, 5)
        .map((row) => `${row.reference} (${row.label})`)
        .join(", ")}`,
    );
  return rows[0]!;
}

async function resolveBillingEntity(
  tx: Tx,
  actor: ConversationActor,
  search: string,
) {
  const rows = await tx.$queryRawUnsafe<Array<Row>>(
    `SELECT id,code AS reference,name AS label,state,version FROM app.organization_nodes
     WHERE tenant_id=$1::uuid AND node_type='LEGAL_ENTITY' AND state='ACTIVE'
       AND (id::text=$2 OR code ILIKE $3 OR name ILIKE $3)
       AND app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'masters.admin','CREATE','organization-nodes',id)
     ORDER BY CASE WHEN id::text=$2 OR lower(code)=lower($2) THEN 0 ELSE 1 END,name LIMIT 6`,
    tenant(actor),
    search,
    `%${search}%`,
    actor.membershipId,
    actor.userId,
  );
  if (!rows.length)
    throw new AppError(
      404,
      "REFERENCE_NOT_FOUND",
      `No active billing entity matches “${search}”`,
    );
  if (rows.length > 1)
    throw new AppError(
      409,
      "REFERENCE_AMBIGUOUS",
      `Multiple billing entities match “${search}”: ${rows.map((row) => row.reference).join(", ")}`,
    );
  return rows[0]!;
}

/** Resolve human references before persisting a proposal; never guess among matches. */
export async function prepareConversationWrite(
  tx: Tx,
  actor: ConversationActor,
  intent: string,
  raw: Record<string, unknown>,
) {
  if (intent === "CLIENT_CREATE") {
    const input = clientConversationSchema.parse(raw);
    const billing = await resolveBillingEntity(tx, actor, input.billingEntity);
    return { ...input, billingEntity: String(billing.id) };
  }
  if (intent === "RECORD_RECEIPT") {
    const input = receiptConversationSchema.parse(raw);
    const client = await resolveUniqueConversationReference(
      tx,
      actor,
      "client",
      input.client,
      "CREATE",
      "finance.admin",
    );
    return { ...input, client: String(client.id) };
  }
  if (
    intent === "OPERATIONS_STATUS_UPDATE" ||
    intent === "FINANCE_STATUS_UPDATE"
  ) {
    const input = statusConversationSchema.parse(raw);
    if (input.toState === "REVERSED")
      throw new AppError(
        409,
        "COMPENSATING_ENTRY_REQUIRED",
        "Financial reversals require the dedicated compensating-entry workflow",
      );
    const action =
      input.toState.includes("APPROV") || input.toState === "POSTED"
        ? "APPROVE"
        : "UPDATE";
    const target = await resolveUniqueConversationReference(
      tx,
      actor,
      input.resource,
      input.targetRef,
      action,
    );
    return { ...input, targetRef: String(target.id) };
  }
  if (intent === "APPROVAL_DECIDE") {
    const input = approvalConversationSchema.parse(raw);
    const target = await resolveUniqueConversationReference(
      tx,
      actor,
      "approval",
      input.instanceRef,
      "APPROVE",
    );
    const instance = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.current_step,d.steps FROM app.approval_instances i
         JOIN app.approval_definitions d ON d.tenant_id=i.tenant_id AND d.id=i.definition_id
         WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid AND i.state='PENDING'`,
        tenant(actor),
        target.id,
      )
    )[0];
    const steps =
      (instance?.steps as Array<{ roleId?: string }> | undefined) ?? [];
    const roleId = steps[Number(instance?.current_step ?? 0) - 1]?.roleId;
    if (!roleId || !uuid.safeParse(roleId).success)
      throw new AppError(
        409,
        "APPROVAL_CONFIGURATION_INVALID",
        "The current approval step has no valid required role",
      );
    return { ...input, instanceRef: String(target.id), roleId };
  }
  return raw;
}

export async function executeConversationRead(
  tx: Tx,
  actor: ConversationActor,
  intent: string,
  raw: Record<string, unknown>,
) {
  if (intent === "REFERENCE_SEARCH") {
    const input = referenceSearchSchema.parse(raw);
    const items = await resolveConversationReference(
      tx,
      actor,
      input.resource,
      input.search,
    );
    return {
      resource: input.resource,
      items,
      total: items.length,
      ambiguous: items.length > 1,
    };
  }
  if (intent === "STATUS_REPORT") {
    const input = statusReportSchema.parse(raw);
    if (input.resource === "approvals") {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT state,count(*)::int AS count FROM app.approval_instances i WHERE tenant_id=$1::uuid AND ($2::text IS NULL OR state=$2)
         AND CASE upper(i.target_type)
           WHEN 'CLIENT' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','clients',i.target_id)
           WHEN 'VENDOR' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','vendors',i.target_id)
           WHEN 'INDENT' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','indents',i.target_id)
           WHEN 'ALLOCATION' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','allocations',i.target_id)
           WHEN 'TRIP' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','trips',i.target_id)
           WHEN 'POD' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','pod-tasks',i.target_id)
           WHEN 'INVOICE' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','invoices',i.target_id)
           WHEN 'RECEIPT' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','receipts',i.target_id)
           WHEN 'VENDOR_BILL' THEN app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'governance.read','READ','vendor-bills',i.target_id)
           ELSE false END GROUP BY state ORDER BY state`,
        tenant(actor),
        input.state ?? null,
        actor.membershipId,
        actor.userId,
      );
      return {
        resource: input.resource,
        rows,
        total: rows.reduce((sum, row) => sum + Number(row.count), 0),
        asOf: new Date().toISOString(),
      };
    }
    const singular =
      input.resource === "pods"
        ? "pod"
        : input.resource.endsWith("s")
          ? input.resource.slice(0, -1)
          : input.resource;
    const definition = definitions[singular];
    if (!definition)
      throw new AppError(
        400,
        "REPORT_TYPE_INVALID",
        "Report type is not supported",
      );
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT coalesce(to_jsonb(r)->>'state','ACTIVE') AS state,count(*)::int AS count FROM app.${definition.table} r
       WHERE r.tenant_id=$1::uuid AND ($2::text IS NULL OR coalesce(to_jsonb(r)->>'state','ACTIVE')=$2)
         AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,$5,'READ',$6,r.id)
       GROUP BY 1 ORDER BY 1 LIMIT $7`,
      tenant(actor),
      input.state ?? null,
      actor.membershipId,
      actor.userId,
      `${definition.capability}.read`,
      definition.domainResource,
      input.limit,
    );
    return {
      resource: input.resource,
      rows,
      total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      asOf: new Date().toISOString(),
    };
  }
  if (intent === "OPERATIONAL_INSIGHT") {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 'open indents' AS metric,count(*)::int AS count FROM app.indents r WHERE r.tenant_id=$1::uuid AND r.state IN ('OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',r.id)
       UNION ALL SELECT 'active trips',count(*)::int FROM app.trips r WHERE r.tenant_id=$1::uuid AND r.state NOT IN ('DELIVERED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',r.id)
       UNION ALL SELECT 'invoice approvals',count(*)::int FROM app.client_invoices r WHERE r.tenant_id=$1::uuid AND r.state='PENDING_APPROVAL' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',r.id)`,
      tenant(actor),
      actor.membershipId,
      actor.userId,
    );
    return {
      title: "Items needing attention",
      rows,
      asOf: new Date().toISOString(),
      note: "Deterministic counts from records in your permitted scope; no predictive claim is made.",
    };
  }
  throw new AppError(400, "INTENT_UNSUPPORTED", "Query is not supported");
}
