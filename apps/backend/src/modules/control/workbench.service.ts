import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { csvCell, toJsonSafe } from "@logistics/domain";
import { withTenant, type Prisma } from "@logistics/db";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
export const controlLens = z.enum([
  "placement",
  "pod",
  "collection",
  "trip",
  "vendor-payable",
]);
type Lens = z.infer<typeof controlLens>;
export const controlKpiPredicate = z.enum([
  "all",
  "green",
  "yellow",
  "red",
  "received",
  "pending-current",
  "pending-prior",
  "open-invoices",
  "part-paid",
  "on-hold",
  "over-45",
  "active-trips",
  "at-risk-trips",
  "delayed-trips",
  "gps-silent",
  "loading-detention",
  "unloading-detention",
  "delivery-exception",
  "draft-bills",
  "approval-pending",
  "due-bills",
  "overdue-bills",
  "payment-blocked",
  "disputed",
  "paid",
]);
export type ControlKpiPredicate = z.infer<typeof controlKpiPredicate>;
export const controlFiltersSchema = z.object({
  search: z.string().trim().max(120).default(""),
  colour: z.enum(["GREEN", "YELLOW", "RED"]).optional(),
  clientId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  state: z.string().trim().max(60).optional(),
  ageingBucket: z.enum(["CURRENT", "31_45", "46_90", "OVER_90"]).optional(),
  kpi: controlKpiPredicate.optional(),
});
export const controlQuerySchema = controlFiltersSchema.extend({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  sort: z
    .enum([
      "reference",
      "client",
      "state",
      "risk",
      "dueAt",
      "updatedAt",
      "value",
      "balance",
    ])
    .default("updatedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type ControlQuery = z.infer<typeof controlQuerySchema>;

type PredicateDefinition = {
  sql: string;
  matches: (row: Row, asOf: Date) => boolean;
};
const activeTrip = (row: Row) =>
  !["DELIVERED", "CANCELLED"].includes(String(row.state));
const age = (row: Row) => Number(row.ageDays ?? 0);
const money = (row: Row, key: string) => BigInt(String(row[key] ?? 0));
export const kpiPredicateDefinitions: Record<
  ControlKpiPredicate,
  PredicateDefinition
> = {
  all: { sql: "TRUE", matches: () => true },
  green: { sql: `f.colour='GREEN'`, matches: (row) => row.colour === "GREEN" },
  yellow: {
    sql: `f.colour='YELLOW'`,
    matches: (row) => row.colour === "YELLOW",
  },
  red: { sql: `f.colour='RED'`, matches: (row) => row.colour === "RED" },
  received: {
    sql: `f."completedAt" IS NOT NULL`,
    matches: (row) => Boolean(row.completedAt),
  },
  "pending-current": {
    sql: `f."completedAt" IS NULL AND NOT f."priorPeriod"`,
    matches: (row) => !row.completedAt && !row.priorPeriod,
  },
  "pending-prior": {
    sql: `f."completedAt" IS NULL AND f."priorPeriod"`,
    matches: (row) => !row.completedAt && Boolean(row.priorPeriod),
  },
  "open-invoices": {
    sql: `f."balanceMinor">0`,
    matches: (row) => money(row, "balanceMinor") > 0n,
  },
  "part-paid": {
    sql: `f."receivedMinor">0 AND f."balanceMinor">0`,
    matches: (row) =>
      money(row, "receivedMinor") > 0n && money(row, "balanceMinor") > 0n,
  },
  "on-hold": { sql: `f.hold IS NOT NULL`, matches: (row) => Boolean(row.hold) },
  "over-45": {
    sql: `f."ageDays">45 AND f."balanceMinor">0`,
    matches: (row) => age(row) > 45 && money(row, "balanceMinor") > 0n,
  },
  "active-trips": {
    sql: `f.state NOT IN ('DELIVERED','CANCELLED')`,
    matches: activeTrip,
  },
  "at-risk-trips": {
    sql: `f.state NOT IN ('DELIVERED','CANCELLED') AND f.colour<>'GREEN'`,
    matches: (row) => activeTrip(row) && row.colour !== "GREEN",
  },
  "delayed-trips": {
    sql: `f.state NOT IN ('DELIVERED','CANCELLED') AND f.colour='RED'`,
    matches: (row) => activeTrip(row) && row.colour === "RED",
  },
  "gps-silent": {
    sql: `f.state NOT IN ('DELIVERED','CANCELLED') AND (f."lastGpsAt" IS NULL OR f."lastGpsAt"<$4::timestamptz-interval '30 minutes')`,
    matches: (row, asOf) =>
      activeTrip(row) &&
      (!row.lastGpsAt ||
        asOf.getTime() - new Date(String(row.lastGpsAt)).getTime() > 1_800_000),
  },
  "loading-detention": {
    sql: `f.state='AT_ORIGIN' AND f."updatedAt"<$4::timestamptz-interval '2 hours'`,
    matches: (row, asOf) =>
      row.state === "AT_ORIGIN" &&
      asOf.getTime() - new Date(String(row.updatedAt)).getTime() > 7_200_000,
  },
  "unloading-detention": {
    sql: `f.state='AT_DESTINATION' AND f."updatedAt"<$4::timestamptz-interval '2 hours'`,
    matches: (row, asOf) =>
      row.state === "AT_DESTINATION" &&
      asOf.getTime() - new Date(String(row.updatedAt)).getTime() > 7_200_000,
  },
  "delivery-exception": {
    sql: `f.colour='RED'`,
    matches: (row) => row.colour === "RED",
  },
  "draft-bills": {
    sql: `f.state='DRAFT'`,
    matches: (row) => row.state === "DRAFT",
  },
  "approval-pending": {
    sql: `f.state IN ('PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL')`,
    matches: (row) =>
      ["PENDING_OPERATIONAL_VERIFICATION", "PENDING_FINANCE_APPROVAL"].includes(
        String(row.state),
      ),
  },
  "due-bills": {
    sql: `f.colour='YELLOW'`,
    matches: (row) => row.colour === "YELLOW",
  },
  "overdue-bills": {
    sql: `f.colour='RED'`,
    matches: (row) => row.colour === "RED",
  },
  "payment-blocked": {
    sql: `f.state IN ('VALIDATION_EXCEPTION','DISPUTED')`,
    matches: (row) =>
      ["VALIDATION_EXCEPTION", "DISPUTED"].includes(String(row.state)),
  },
  disputed: {
    sql: `f.state='DISPUTED'`,
    matches: (row) => row.state === "DISPUTED",
  },
  paid: { sql: `f.state='PAID'`, matches: (row) => row.state === "PAID" },
};

export const kpiActionsByLens: Record<
  Lens,
  Record<string, ControlKpiPredicate>
> = {
  placement: {
    liveIndents: "all",
    green: "green",
    yellow: "yellow",
    red: "red",
  },
  pod: {
    deliveryRecords: "all",
    received: "received",
    pendingCurrent: "pending-current",
    pendingPrior: "pending-prior",
  },
  collection: {
    openInvoices: "open-invoices",
    partPaid: "part-paid",
    onHold: "on-hold",
    over45Count: "over-45",
    over45Minor: "over-45",
  },
  trip: {
    active: "active-trips",
    delayed: "delayed-trips",
    gpsSilent: "gps-silent",
    loadingDetention: "loading-detention",
    unloadingDetention: "unloading-detention",
  },
  "vendor-payable": {
    unbilled: "draft-bills",
    approvalPending: "approval-pending",
    paymentBlocked: "payment-blocked",
    disputed: "disputed",
    paid: "paid",
  },
};

export function parseControlQuery(lens: Lens, raw: unknown) {
  const query = controlQuerySchema.parse(raw);
  if (query.kpi && !Object.values(kpiActionsByLens[lens]).includes(query.kpi))
    throw new AppError(
      400,
      "INVALID_KPI_PREDICATE",
      "The KPI predicate is not available for this lens",
    );
  return query;
}
export function actionableKpiMeasure(
  lens: Lens,
  key: string,
  rows: Row[],
  asOf: Date,
) {
  const predicate = kpiActionsByLens[lens][key];
  if (!predicate) return undefined;
  const matched = rows.filter((row) =>
    kpiPredicateDefinitions[predicate].matches(row, asOf),
  );
  return key === "over45Minor"
    ? matched.reduce((total, row) => total + money(row, "balanceMinor"), 0n)
    : matched.length;
}
export function controlStableOrder(lens: Lens, input: ControlQuery) {
  const moneySort = ["pod", "collection", "vendor-payable"].includes(lens);
  const balanceSort = ["collection", "vendor-payable"].includes(lens);
  const sortColumns: Record<ControlQuery["sort"], string | null> = {
    reference: "f.reference",
    client: "f.client",
    state: "f.state",
    risk: "f.colour",
    dueAt: `f."dueAt"`,
    updatedAt: `f."updatedAt"`,
    value: moneySort ? `f."valueMinor"` : null,
    balance: balanceSort ? `f."balanceMinor"` : null,
  };
  const sortColumn = sortColumns[input.sort];
  if (!sortColumn)
    throw new AppError(
      400,
      "INVALID_SORT",
      "The sort field is not available for this lens",
    );
  const direction = input.direction.toUpperCase();
  return `${sortColumn} ${direction} NULLS LAST,f.id ${direction}`;
}

const lensCapability: Record<Lens, string> = {
  placement: "operations.read",
  pod: "pod.read",
  collection: "finance.read",
  trip: "operations.read",
  "vendor-payable": "finance.read",
};

const queries: Record<Lens, string> = {
  placement: `SELECT i.id,i.indent_no AS reference,c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,i.state,i.body_type AS "truckType",i.requested_vehicles AS demand,
    supply.allotted,supply.placed,supply.vendors,assets.vehicles,assets.drivers,assets."placedAt",
    i.committed_placement_at AS "dueAt",i.updated_at AS "updatedAt",greatest(floor(extract(epoch FROM (coalesce(assets."placedAt",$4::timestamptz)-i.committed_placement_at))/3600),0)::int AS "ageHours",
    CASE WHEN coalesce(assets."placedAt",$4::timestamptz)-i.committed_placement_at<=interval '24 hours' THEN 'GREEN' WHEN coalesce(assets."placedAt",$4::timestamptz)-i.committed_placement_at<=interval '48 hours' THEN 'YELLOW' ELSE 'RED' END colour
    FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int allotted,
        coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed,
        string_agg(DISTINCT v.legal_name,', ') vendors
      FROM app.allocations a LEFT JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
      WHERE a.tenant_id=i.tenant_id AND a.indent_id=i.id
    ) supply ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT vh.registration_number,', ') vehicles,
        string_agg(DISTINCT d.display_name,', ') drivers,
        max(aa.assigned_from) FILTER(WHERE a.state='PLACED') AS "placedAt"
      FROM app.allocations a
      JOIN app.allocation_assignments aa ON aa.tenant_id=a.tenant_id AND aa.allocation_id=a.id AND aa.assigned_to IS NULL
      LEFT JOIN app.vehicles vh ON vh.tenant_id=aa.tenant_id AND vh.id=aa.vehicle_id
      LEFT JOIN app.drivers d ON d.tenant_id=aa.tenant_id AND d.id=aa.driver_id
      WHERE a.tenant_id=i.tenant_id AND a.indent_id=i.id
    ) assets ON true
    WHERE i.tenant_id=$1::uuid AND i.state IN ('OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)`,
  pod: `SELECT p.id,t.trip_no AS reference,t.lr_no AS "secondaryReference",
    (SELECT string_agg(DISTINCT x.invoice_reference,', ') FROM app.pod_invoice_links x WHERE x.tenant_id=p.tenant_id AND x.pod_task_id=p.id) AS "invoiceReferences",
    (SELECT coalesce(jsonb_agg(jsonb_build_object('identity',coalesce(ci.id::text,'REFERENCE:'||x.invoice_reference),'valueMinor',coalesce(ci.total_minor,x.value_minor))), '[]'::jsonb) FROM app.pod_invoice_links x LEFT JOIN app.client_invoices ci ON ci.tenant_id=x.tenant_id AND ci.invoice_no=x.invoice_reference WHERE x.tenant_id=p.tenant_id AND x.pod_task_id=p.id) AS "invoiceValues",
    EXISTS(SELECT 1 FROM app.pod_invoice_links x JOIN app.client_invoices ci ON ci.tenant_id=x.tenant_id AND ci.invoice_no=x.invoice_reference WHERE x.tenant_id=p.tenant_id AND x.pod_task_id=p.id) AND NOT EXISTS(SELECT 1 FROM app.pod_invoice_links x LEFT JOIN app.client_invoices ci ON ci.tenant_id=x.tenant_id AND ci.invoice_no=x.invoice_reference WHERE x.tenant_id=p.tenant_id AND x.pod_task_id=p.id AND (ci.id IS NULL OR NOT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',ci.id))) AS "moneyVisible",
    c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,p.state,
    p.delivered_at AS "dueAt",p.received_at AS "completedAt",p.invoice_value_minor AS "valueMinor",p.prior_period AS "priorPeriod",vh.registration_number AS vehicle,i.body_type AS "truckType",t.planned_pickup_at AS "loadedAt",p.updated_at AS "updatedAt",
    greatest(floor(extract(epoch FROM (coalesce(p.received_at,$4::timestamptz)-p.delivered_at))/86400),0)::int AS "ageDays",
    CASE WHEN p.received_at IS NOT NULL THEN 'GREEN' WHEN p.prior_period OR $4::timestamptz>p.delivered_at+interval '15 days' THEN 'RED' WHEN $4::timestamptz>p.delivered_at+interval '7 days' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.vehicles vh ON vh.tenant_id=t.tenant_id AND vh.id=t.assigned_vehicle_id
    JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id
    JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
    WHERE p.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'pod.read','READ','pod-tasks',p.id)`,
  collection: `SELECT inv.id,inv.invoice_no AS reference,c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,inv.state,inv.total_minor AS "valueMinor",
    greatest(inv.total_minor-coalesce(sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) WHEN e.entry_type IN ('ALLOCATION','DEDUCTION') THEN abs(e.amount_minor) ELSE 0 END),0),0)::bigint AS "balanceMinor",
    coalesce(sum(CASE WHEN e.entry_type='REVERSAL' AND original.entry_type='ALLOCATION' THEN -abs(e.amount_minor) WHEN e.entry_type='ALLOCATION' THEN abs(e.amount_minor) ELSE 0 END),0)::bigint AS "receivedMinor",
    app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','invoices',inv.id) AS "moneyVisible",
    greatest((($4::timestamptz AT TIME ZONE $5)::date-coalesce(inv.acknowledged_at::date,inv.invoice_date)),0)::int AS "ageDays",inv.acknowledged_at AS "submittedAt",inv.due_date AS "contractDueDate",inv.created_at AS "updatedAt",
    CASE WHEN inv.state='REVERSED' OR greatest(inv.total_minor-coalesce(sum(CASE WHEN e.entry_type='REVERSAL' THEN -abs(e.amount_minor) WHEN e.entry_type IN ('ALLOCATION','DEDUCTION') THEN abs(e.amount_minor) ELSE 0 END),0),0)=0 THEN 'GREEN' WHEN ($4::timestamptz AT TIME ZONE $5)::date>coalesce(inv.acknowledged_at::date,inv.invoice_date)+45 THEN 'RED' WHEN ($4::timestamptz AT TIME ZONE $5)::date>coalesce(inv.acknowledged_at::date,inv.invoice_date)+30 THEN 'YELLOW' ELSE 'GREEN' END colour,
    (SELECT f.outcome FROM app.collection_followups f WHERE f.tenant_id=inv.tenant_id AND f.invoice_id=inv.id ORDER BY f.created_at DESC LIMIT 1) AS "followupOutcome",
    (SELECT f.next_followup_at FROM app.collection_followups f WHERE f.tenant_id=inv.tenant_id AND f.invoice_id=inv.id ORDER BY f.created_at DESC LIMIT 1) AS "nextFollowupAt",
    (SELECT n.reason FROM app.invoice_notes n WHERE n.tenant_id=inv.tenant_id AND n.invoice_id=inv.id AND n.note_type IN ('CREDIT_NOTE','DEBIT_NOTE') ORDER BY n.created_at DESC LIMIT 1) AS hold
    FROM app.client_invoices inv JOIN app.clients c ON c.tenant_id=inv.tenant_id AND c.id=inv.client_id JOIN app.client_locations cl ON cl.tenant_id=inv.tenant_id AND cl.id=inv.client_location_id
    LEFT JOIN app.receipt_ledger_entries e ON e.tenant_id=inv.tenant_id AND e.invoice_id=inv.id LEFT JOIN app.receipt_ledger_entries original ON original.tenant_id=e.tenant_id AND original.id=e.reverses_entry_id
    WHERE inv.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',inv.id) GROUP BY inv.id,c.id,c.legal_name,cl.id,cl.name`,
  trip: `SELECT t.id,t.trip_no AS reference,t.lr_no AS "secondaryReference",c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,t.state,t.planned_pickup_at AS "pickupAt",t.planned_delivery_at AS "dueAt",t.updated_at AS "updatedAt",vh.registration_number AS vehicle,d.display_name AS driver,
    (SELECT max(o.observed_at) FROM app.gps_device_observations o WHERE o.tenant_id=t.tenant_id AND o.trip_id=t.id) AS "lastGpsAt",
    (SELECT e.event_type FROM app.trip_events e WHERE e.tenant_id=t.tenant_id AND e.trip_id=t.id ORDER BY e.device_at DESC,e.received_at DESC LIMIT 1) AS "lastEvent",
    CASE WHEN t.state='DELIVERED' THEN 'GREEN' WHEN $4::timestamptz>t.planned_delivery_at THEN 'RED' WHEN $4::timestamptz>t.planned_delivery_at-interval '2 hours' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id JOIN app.vehicles vh ON vh.tenant_id=t.tenant_id AND vh.id=t.assigned_vehicle_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id
    WHERE t.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',t.id)`,
  "vendor-payable": `SELECT b.id,b.vendor_invoice_no AS reference,v.id AS "vendorId",v.id AS "clientId",v.id AS "locationId",v.legal_name AS client,'Vendor account' AS location,b.state,b.payable_minor AS "valueMinor",greatest(b.payable_minor-coalesce(sum(pa.amount_minor) FILTER(WHERE pb.state='PAID'),0),0)::bigint AS "balanceMinor",app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.payment.read','READ','vendor-bills',b.id) AS "moneyVisible",b.invoice_date AS "dueAt",greatest(($4::timestamptz AT TIME ZONE $5)::date-b.invoice_date,0)::int AS "ageDays",b.created_at AS "updatedAt",
    CASE WHEN b.state='PAID' THEN 'GREEN' WHEN b.state IN ('VALIDATION_EXCEPTION','DISPUTED') OR ($4::timestamptz AT TIME ZONE $5)::date>b.invoice_date+45 THEN 'RED' WHEN b.state IN ('PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL') OR ($4::timestamptz AT TIME ZONE $5)::date>b.invoice_date+30 THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.vendor_bills b JOIN app.vendors v ON v.tenant_id=b.tenant_id AND v.id=b.vendor_id LEFT JOIN app.payment_allocations pa ON pa.tenant_id=b.tenant_id AND pa.vendor_bill_id=b.id LEFT JOIN app.payment_batches pb ON pb.tenant_id=pa.tenant_id AND pb.id=pa.payment_batch_id
    WHERE b.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','vendor-bills',b.id) GROUP BY b.id,v.id,v.legal_name`,
};

@Injectable()
export class ControlWorkbenchService {
  constructor(@Inject(AppService) private readonly app: AppService) {}
  private tenant(actor: SessionActor) {
    if (!actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    return this.app.requireTenant(actor);
  }
  private async permit(tx: Tx, actor: SessionActor) {
    const found = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='control.dashboard.read' JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ('READ','ADMIN') WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) LIMIT 1`,
      this.tenant(actor),
      actor.membershipId,
    );
    if (!found.length)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Control tower access is not permitted",
      );
  }
  private async available(tx: Tx, actor: SessionActor) {
    await this.permit(tx, actor);
    const capabilities = await tx.$queryRawUnsafe<Array<{ code: string }>>(
      `SELECT DISTINCT c.capability_code AS code FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ('READ','ADMIN') WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())`,
      this.tenant(actor),
      actor.membershipId,
    );
    const allowed = new Set(capabilities.map((item) => item.code));
    return controlLens.options.filter((lens) =>
      allowed.has(lensCapability[lens]),
    );
  }
  async access(actor: SessionActor) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const lenses = await this.available(tx, actor);
      const tenant = (
        await tx.$queryRawUnsafe<
          Array<{ timezone: string; locale: string; currency: string }>
        >(
          `SELECT timezone,locale,currency FROM app.tenants WHERE id=$1::uuid`,
          this.tenant(actor),
        )
      )[0]!;
      return { lenses, ...tenant, refreshSeconds: 30 };
    });
  }
  private queryParts(lens: Lens, input: ControlQuery) {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const parameter = (value: unknown, cast = "") => {
      values.push(value);
      const baseCount = ["collection", "vendor-payable"].includes(lens) ? 5 : 4;
      return `$${baseCount + values.length}${cast}`;
    };
    if (input.search)
      conditions.push(
        `lower(concat_ws(' ',f.reference,f.client,f.location,f.state)) LIKE ${parameter(`%${input.search.toLocaleLowerCase()}%`)}`,
      );
    if (input.colour) conditions.push(`f.colour=${parameter(input.colour)}`);
    if (input.clientId)
      conditions.push(`f."clientId"=${parameter(input.clientId, "::uuid")}`);
    if (input.locationId)
      conditions.push(
        `f."locationId"=${parameter(input.locationId, "::uuid")}`,
      );
    if (input.vendorId) {
      if (lens !== "vendor-payable")
        throw new AppError(
          400,
          "INVALID_FILTER",
          "Vendor filtering is only available for vendor payable",
        );
      conditions.push(`f."vendorId"=${parameter(input.vendorId, "::uuid")}`);
    }
    if (input.state) conditions.push(`f.state=${parameter(input.state)}`);
    if (input.ageingBucket) {
      if (!["collection", "vendor-payable"].includes(lens))
        throw new AppError(
          400,
          "INVALID_FILTER",
          "Ageing filtering is only available for financial lenses",
        );
      const bucketSql = `CASE WHEN f."ageDays"<=30 THEN 'CURRENT' WHEN f."ageDays"<=45 THEN '31_45' WHEN f."ageDays"<=90 THEN '46_90' ELSE 'OVER_90' END`;
      conditions.push(`${bucketSql}=${parameter(input.ageingBucket)}`);
    }
    if (input.kpi) conditions.push(kpiPredicateDefinitions[input.kpi].sql);
    return {
      where: conditions.length ? conditions.join(" AND ") : "TRUE",
      values,
      order: controlStableOrder(lens, input),
    };
  }
  private kpiSql(lens: Lens) {
    const count = (predicate: ControlKpiPredicate) =>
      `count(*) FILTER(WHERE ${kpiPredicateDefinitions[predicate].sql})::int`;
    if (lens === "placement")
      return `jsonb_build_object('liveIndents',count(*)::int,'green',${count("green")},'yellow',${count("yellow")},'red',${count("red")},'placed',coalesce(sum(f.placed),0)::int,'awaiting',greatest(coalesce(sum(f.demand),0)-coalesce(sum(f.placed),0),0)::int,'fillRate',CASE WHEN coalesce(sum(f.demand),0)>0 THEN round(coalesce(sum(f.placed),0)::numeric*100/coalesce(sum(f.demand),0),2) ELSE 0 END)`;
    if (lens === "pod")
      return `jsonb_build_object('deliveryRecords',count(*)::int,'received',${count("received")},'pendingCurrent',${count("pending-current")},'pendingPrior',${count("pending-prior")},'valueAtRiskMinor',(SELECT coalesce(sum((item->>'valueMinor')::bigint),0)::text FROM (SELECT DISTINCT ON (item->>'identity') item FROM filtered pending CROSS JOIN LATERAL jsonb_array_elements(pending."invoiceValues") item WHERE pending."completedAt" IS NULL ORDER BY item->>'identity') unique_invoices),'closureRate',CASE WHEN count(*)>0 THEN round(${count("received")}::numeric*100/count(*),2) ELSE 0 END)`;
    if (lens === "collection")
      return `jsonb_build_object('submitted',count(*)::int,'billedMinor',coalesce(sum(f."valueMinor"),0)::text,'receivedMinor',coalesce(sum(f."receivedMinor"),0)::text,'outstandingMinor',coalesce(sum(f."balanceMinor"),0)::text,'openInvoices',${count("open-invoices")},'partPaid',${count("part-paid")},'onHold',${count("on-hold")},'over45Count',${count("over-45")},'over45Minor',coalesce(sum(f."balanceMinor") FILTER(WHERE ${kpiPredicateDefinitions["over-45"].sql}),0)::text,'oldestDays',coalesce(max(f."ageDays") FILTER(WHERE f."balanceMinor">0),0))`;
    if (lens === "trip")
      return `jsonb_build_object('active',${count("active-trips")},'atRisk',${count("at-risk-trips")},'delayed',${count("delayed-trips")},'gpsSilent',${count("gps-silent")},'loadingDetention',${count("loading-detention")},'unloadingDetention',${count("unloading-detention")},'deliveryExceptions',${count("delivery-exception")})`;
    return `jsonb_build_object('unbilled',${count("draft-bills")},'approvalPending',${count("approval-pending")},'due',${count("due-bills")},'overdue',${count("overdue-bills")},'paymentBlocked',${count("payment-blocked")},'disputed',${count("disputed")},'paid',${count("paid")},'outstandingMinor',coalesce(sum(f."balanceMinor"),0)::text)`;
  }
  private baseParameters(
    actor: SessionActor,
    lens: Lens,
    asOf: Date,
    timezone: string,
  ) {
    return [
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
      asOf.toISOString(),
      ...(["collection", "vendor-payable"].includes(lens) ? [timezone] : []),
    ];
  }
  private async records(
    tx: Tx,
    actor: SessionActor,
    lens: Lens,
    input: ControlQuery,
    asOf: Date,
    timezone: string,
    paginate: boolean,
  ) {
    if (!(await this.available(tx, actor)).includes(lens))
      throw new AppError(
        403,
        "FORBIDDEN",
        "This control-tower lens is not available for your role",
      );
    const parts = this.queryParts(lens, input);
    const parameters = [
      ...this.baseParameters(actor, lens, asOf, timezone),
      ...parts.values,
    ];
    let limit = "";
    if (paginate) {
      parameters.push(input.pageSize, (input.page - 1) * input.pageSize);
      limit = `LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`;
    }
    return tx.$queryRawUnsafe<Array<Row>>(
      `WITH base AS (${queries[lens]}),filtered AS (SELECT * FROM base f WHERE ${parts.where}) SELECT * FROM filtered f ORDER BY ${parts.order} ${limit}`,
      ...parameters,
    );
  }
  private async metadata(
    tx: Tx,
    actor: SessionActor,
    lens: Lens,
    input: ControlQuery,
    asOf: Date,
    timezone: string,
  ) {
    if (!(await this.available(tx, actor)).includes(lens))
      throw new AppError(
        403,
        "FORBIDDEN",
        "This control-tower lens is not available for your role",
      );
    const parts = this.queryParts(lens, input);
    const parameters = [
      ...this.baseParameters(actor, lens, asOf, timezone),
      ...parts.values,
    ];
    const moneyVisible = ["pod", "collection", "vendor-payable"].includes(lens)
      ? `coalesce(bool_and(f."moneyVisible"),true)`
      : "true";
    const demand =
      lens === "placement" ? "coalesce(sum(f.demand),0)::int" : "0";
    const placed =
      lens === "placement" ? "coalesce(sum(f.placed),0)::int" : "0";
    const value = ["pod", "collection", "vendor-payable"].includes(lens)
      ? `coalesce(sum(f."valueMinor"),0)::text`
      : "'0'::text";
    const balance = ["collection", "vendor-payable"].includes(lens)
      ? `coalesce(sum(f."balanceMinor"),0)::text`
      : "'0'::text";
    const portfolios = `(SELECT coalesce(jsonb_agg(to_jsonb(portfolio) ORDER BY portfolio.name),'[]'::jsonb) FROM (SELECT f."clientId" id,max(f.client) name,count(*)::int "recordCount",count(DISTINCT f."locationId")::int "locationCount",count(*) FILTER(WHERE f.colour='GREEN')::int green,count(*) FILTER(WHERE f.colour='YELLOW')::int yellow,count(*) FILTER(WHERE f.colour='RED')::int red,${demand} demand,${placed} placed,${value} "valueMinor",${balance} "balanceMinor",(SELECT coalesce(jsonb_agg(jsonb_build_object('id',signal."locationId",'name',signal.location,'colour',signal.colour) ORDER BY signal.location,signal."locationId"),'[]'::jsonb) FROM (SELECT scoped."locationId",max(scoped.location) location,CASE WHEN bool_or(scoped.colour='RED') THEN 'RED' WHEN bool_or(scoped.colour='YELLOW') THEN 'YELLOW' ELSE 'GREEN' END colour FROM filtered scoped WHERE scoped."clientId"=f."clientId" GROUP BY scoped."locationId") signal) signals FROM filtered f GROUP BY f."clientId") portfolio)`;
    const locations = `(SELECT coalesce(jsonb_agg(to_jsonb(location) ORDER BY location.name),'[]'::jsonb) FROM (SELECT f."locationId" id,max(f.location) name,count(*)::int "recordCount",count(*) FILTER(WHERE f.colour='GREEN')::int green,count(*) FILTER(WHERE f.colour='YELLOW')::int yellow,count(*) FILTER(WHERE f.colour='RED')::int red,${demand} demand,${placed} placed,${value} "valueMinor",${balance} "balanceMinor" FROM filtered f GROUP BY f."locationId") location)`;
    const ageing =
      lens === "collection"
        ? `(SELECT coalesce(jsonb_agg(to_jsonb(bucket) ORDER BY bucket.position),'[]'::jsonb) FROM (SELECT CASE WHEN f."ageDays"<=30 THEN 'CURRENT' WHEN f."ageDays"<=45 THEN '31_45' WHEN f."ageDays"<=90 THEN '46_90' ELSE 'OVER_90' END bucket,min(f."ageDays") position,count(*) FILTER(WHERE f."balanceMinor">0)::int count,coalesce(sum(f."balanceMinor"),0)::text "amountMinor" FROM filtered f GROUP BY 1) bucket)`
        : `'[]'::jsonb`;
    const vendors =
      lens === "placement"
        ? `(SELECT coalesce(jsonb_agg(jsonb_build_object('id',vendor_totals.id,'vendor',vendor_totals.vendor,'allotted',vendor_totals.allotted,'placed',vendor_totals.placed,'ntp',vendor_totals.ntp) ORDER BY vendor_totals.ntp DESC,vendor_totals.vendor,vendor_totals.id),'[]'::jsonb) FROM (SELECT v.id,v.legal_name vendor,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int allotted,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state IN ('OFFERED','ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED')),0)::int ntp FROM filtered f JOIN app.allocations a ON a.tenant_id=$1::uuid AND a.indent_id=f.id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id) GROUP BY v.id,v.legal_name) vendor_totals)`
        : `'[]'::jsonb`;
    return (
      await tx.$queryRawUnsafe<Array<Row>>(
        `WITH base AS (${queries[lens]}),
          filtered AS (SELECT * FROM base f WHERE ${parts.where}),
          summary AS (
            SELECT count(*)::int total,
              max(f."updatedAt") "lastCanonicalChange",
              ${moneyVisible} "moneyVisible",
              ${this.kpiSql(lens)} kpis
            FROM filtered f
          )
        SELECT summary.*,${portfolios} portfolios,${locations} locations,${ageing} ageing,${vendors} vendors
        FROM summary`,
        ...parameters,
      )
    )[0]!;
  }
  async dashboard(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const input = parseControlQuery(lens, raw);
      const asOf = new Date();
      const tenant = (
        await tx.$queryRawUnsafe<Array<{ timezone: string }>>(
          `SELECT timezone FROM app.tenants WHERE id=$1::uuid`,
          this.tenant(actor),
        )
      )[0]!;
      const metadata = await this.metadata(
        tx,
        actor,
        lens,
        input,
        asOf,
        tenant.timezone,
      );
      const rows = await this.records(
        tx,
        actor,
        lens,
        input,
        asOf,
        tenant.timezone,
        true,
      );
      const moneyVisible = metadata.moneyVisible === true;
      const moneyKeys = new Set([
        "valueMinor",
        "balanceMinor",
        "receivedMinor",
        "invoiceValues",
      ]);
      const responseRows = rows.map((row) =>
        row.moneyVisible === false
          ? Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                moneyKeys.has(key) ? "••••" : value,
              ]),
            )
          : row,
      );
      const kpis = metadata.kpis as Record<string, unknown>;
      const responseKpis = moneyVisible
        ? kpis
        : Object.fromEntries(
            Object.entries(kpis).map(([key, value]) => [
              key,
              key.toLowerCase().includes("minor") ? "••••" : value,
            ]),
          );
      const maskSummaries = (items: unknown) =>
        (Array.isArray(items) ? items : []).map((item) => {
          if (moneyVisible || !item || typeof item !== "object") return item;
          return { ...(item as Row), valueMinor: "••••", balanceMinor: "••••" };
        });
      const ageing = (
        Array.isArray(metadata.ageing) ? metadata.ageing : []
      ).map((bucket) =>
        moneyVisible || !bucket || typeof bucket !== "object"
          ? bucket
          : { ...(bucket as Row), amountMinor: "••••" },
      );
      const total = Number(metadata.total ?? 0);
      const latest = metadata.lastCanonicalChange
        ? String(metadata.lastCanonicalChange)
        : null;
      return toJsonSafe({
        lens,
        asOf: asOf.toISOString(),
        timezone: tenant.timezone,
        moneyVisible,
        freshness: {
          lastCanonicalChange: latest,
          state:
            latest && asOf.getTime() - new Date(latest).getTime() < 300_000
              ? "LIVE"
              : "DELAYED",
        },
        filters: input,
        kpis: responseKpis,
        kpiActions: kpiActionsByLens[lens],
        rows: responseRows,
        portfolios: maskSummaries(metadata.portfolios),
        locations: maskSummaries(metadata.locations),
        vendors: metadata.vendors ?? [],
        ageing,
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          pageCount: Math.ceil(total / input.pageSize),
          hasPrevious: input.page > 1,
          hasNext: input.page * input.pageSize < total,
          sort: input.sort,
          direction: input.direction,
        },
      });
    });
  }

  async exportCsv(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const input = parseControlQuery(lens, raw);
      const asOf = new Date();
      const tenant = (
        await tx.$queryRawUnsafe<Array<{ timezone: string }>>(
          `SELECT timezone FROM app.tenants WHERE id=$1::uuid`,
          this.tenant(actor),
        )
      )[0]!;
      const rows = await this.records(
        tx,
        actor,
        lens,
        input,
        asOf,
        tenant.timezone,
        false,
      );
      const columns = [
        "reference",
        "client",
        "location",
        "state",
        "colour",
        "dueAt",
        "valueMinor",
        "balanceMinor",
        "vehicle",
        "vendors",
        "drivers",
        "ageHours",
        "ageDays",
        "lastGpsAt",
        "lastEvent",
      ];
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,correlation_id,after_json) VALUES($1::uuid,$2::uuid,'control.view.exported','control-tower',$3,$4::jsonb)`,
        this.tenant(actor),
        actor.userId,
        crypto.randomUUID(),
        JSON.stringify({
          lens,
          filters: input,
          rowCount: rows.length,
          columns,
          asOf: asOf.toISOString(),
        }),
      );
      return {
        filename: `control-${lens}-${asOf.toISOString().slice(0, 10)}.csv`,
        rowCount: rows.length,
        asOf: asOf.toISOString(),
        filters: input,
        content: [
          columns,
          ...rows.map((row) =>
            columns.map((key) =>
              row.moneyVisible === false &&
              ["valueMinor", "balanceMinor", "receivedMinor"].includes(key)
                ? "••••"
                : (row[key] ?? ""),
            ),
          ),
        ]
          .map((line) => line.map((value) => csvCell(String(value))).join(","))
          .join("\r\n"),
      };
    });
  }
  async views(actor: SessionActor, lens: Lens) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      if (!(await this.available(tx, actor)).includes(lens))
        throw new AppError(
          403,
          "FORBIDDEN",
          "This control-tower lens is not available for your role",
        );
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,name,filters,is_default AS "isDefault",version FROM app.control_saved_views WHERE tenant_id=$1::uuid AND owner_id=$2::uuid AND lens=$3 ORDER BY is_default DESC,name`,
        this.tenant(actor),
        actor.userId,
        lens.replace("-", "_").toUpperCase(),
      );
    });
  }
  async saveView(actor: SessionActor, lens: Lens, raw: unknown) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        filters: controlFiltersSchema,
        isDefault: z.boolean().default(false),
      })
      .strict()
      .parse(raw);
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      if (!(await this.available(tx, actor)).includes(lens))
        throw new AppError(
          403,
          "FORBIDDEN",
          "This control-tower lens is not available for your role",
        );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.control_saved_views(tenant_id,owner_id,lens,name,filters,is_default) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,owner_id,lens,name) DO UPDATE SET filters=excluded.filters,is_default=excluded.is_default,updated_at=now(),version=app.control_saved_views.version+1 RETURNING id,name,filters,is_default AS "isDefault",version`,
          this.tenant(actor),
          actor.userId,
          lens.replace("-", "_").toUpperCase(),
          input.name,
          JSON.stringify(input.filters),
          input.isDefault,
        )
      )[0]!;
    });
  }
}
