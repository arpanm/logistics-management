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
const filterSchema = z.object({
  search: z.string().trim().max(120).default(""),
  colour: z.enum(["GREEN", "YELLOW", "RED"]).optional(),
  clientId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  state: z.string().trim().max(60).optional(),
  ageingBucket: z.enum(["CURRENT", "31_45", "46_90", "OVER_90"]).optional(),
});

const lensCapability: Record<Lens, string> = {
  placement: "operations.read",
  pod: "pod.read",
  collection: "finance.read",
  trip: "operations.read",
  "vendor-payable": "finance.read",
};

const queries: Record<Lens, string> = {
  placement: `SELECT i.id,i.indent_no AS reference,c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,i.state,i.body_type AS "truckType",i.requested_vehicles AS demand,
    coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int AS allotted,
    coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int AS placed,
    string_agg(DISTINCT v.legal_name,', ') AS vendors,string_agg(DISTINCT vh.registration_number,', ') AS vehicles,string_agg(DISTINCT d.display_name,', ') AS drivers,
    max(aa.assigned_from) FILTER(WHERE a.state='PLACED') AS "placedAt",
    i.committed_placement_at AS "dueAt",i.updated_at AS "updatedAt",greatest(floor(extract(epoch FROM (coalesce(max(aa.assigned_from) FILTER(WHERE a.state='PLACED'),$4::timestamptz)-i.committed_placement_at))/3600),0)::int AS "ageHours",
    CASE WHEN coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)>=i.requested_vehicles THEN 'GREEN' WHEN $4::timestamptz>=i.committed_placement_at THEN 'RED' WHEN $4::timestamptz>=i.committed_placement_at-interval '24 hours' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
    LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id LEFT JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
    LEFT JOIN app.allocation_assignments aa ON aa.tenant_id=a.tenant_id AND aa.allocation_id=a.id AND aa.assigned_to IS NULL LEFT JOIN app.vehicles vh ON vh.tenant_id=aa.tenant_id AND vh.id=aa.vehicle_id LEFT JOIN app.drivers d ON d.tenant_id=aa.tenant_id AND d.id=aa.driver_id
    WHERE i.tenant_id=$1::uuid AND i.state IN ('OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id) GROUP BY i.id,c.id,c.legal_name,cl.id,cl.name`,
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
  private async rows(
    tx: Tx,
    actor: SessionActor,
    lens: Lens,
    raw: unknown,
    asOf: Date,
    timezone: string,
  ) {
    const filters = filterSchema.parse(raw);
    const available = await this.available(tx, actor);
    if (!available.includes(lens))
      throw new AppError(
        403,
        "FORBIDDEN",
        "This control-tower lens is not available for your role",
      );
    const parameters = [
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
      asOf.toISOString(),
      ...(["collection", "vendor-payable"].includes(lens) ? [timezone] : []),
    ];
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      queries[lens],
      ...parameters,
    );
    const needle = filters.search.toLocaleLowerCase();
    return {
      filters,
      rows: rows.filter(
        (row) =>
          (!filters.colour || row.colour === filters.colour) &&
          (!filters.clientId || row.clientId === filters.clientId) &&
          (!filters.locationId || row.locationId === filters.locationId) &&
          (!filters.vendorId || row.vendorId === filters.vendorId) &&
          (!filters.state || row.state === filters.state) &&
          (!filters.ageingBucket ||
            this.ageingBucket(row) === filters.ageingBucket) &&
          (!needle ||
            [
              row.reference,
              row.client,
              row.location,
              row.state,
              row.vehicle,
              row.vendors,
              row.driver,
              row.invoiceReferences,
            ].some((v) =>
              String(v ?? "")
                .toLocaleLowerCase()
                .includes(needle),
            )),
      ),
    };
  }
  private ageingBucket(row: Row) {
    const age = Number(row.ageDays ?? 0);
    return age <= 30
      ? "CURRENT"
      : age <= 45
        ? "31_45"
        : age <= 90
          ? "46_90"
          : "OVER_90";
  }
  async dashboard(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const asOf = new Date();
      const tenant = (
        await tx.$queryRawUnsafe<Array<{ timezone: string }>>(
          `SELECT timezone FROM app.tenants WHERE id=$1::uuid`,
          this.tenant(actor),
        )
      )[0]!;
      const { filters, rows } = await this.rows(
        tx,
        actor,
        lens,
        raw,
        asOf,
        tenant.timezone,
      );
      const count = (colour: string) =>
        rows.filter((r) => r.colour === colour).length;
      const sum = (key: string) =>
        rows
          .reduce((total, row) => total + BigInt(String(row[key] ?? 0)), 0n)
          .toString();
      const placementDemand = rows.reduce(
          (n, r) => n + Number(r.demand ?? 0),
          0,
        ),
        placementPlaced = rows.reduce((n, r) => n + Number(r.placed ?? 0), 0);
      const latest = rows.reduce<string | null>(
        (v, r) => (!v || String(r.updatedAt) > v ? String(r.updatedAt) : v),
        null,
      );
      const now = asOf;
      const invoiceValueAtRisk = new Map<string, bigint>();
      for (const row of rows.filter((item) => !item.completedAt)) {
        const values = Array.isArray(row.invoiceValues)
          ? (row.invoiceValues as Array<Record<string, unknown>>)
          : [];
        for (const value of values) {
          const identity = String(value.identity ?? "");
          if (identity && !invoiceValueAtRisk.has(identity))
            invoiceValueAtRisk.set(
              identity,
              BigInt(String(value.valueMinor ?? 0)),
            );
        }
      }
      const moneyVisible = !["pod", "collection", "vendor-payable"].includes(
        lens,
      )
        ? true
        : rows.every((row) => row.moneyVisible === true);
      const kpis =
        lens === "placement"
          ? {
              liveIndents: rows.length,
              green: count("GREEN"),
              yellow: count("YELLOW"),
              red: count("RED"),
              placed: placementPlaced,
              awaiting: Math.max(placementDemand - placementPlaced, 0),
              fillRate: placementDemand
                ? Math.round((placementPlaced * 10000) / placementDemand) / 100
                : 0,
            }
          : lens === "pod"
            ? {
                deliveryRecords: rows.length,
                received: rows.filter((r) => r.completedAt).length,
                pendingCurrent: rows.filter(
                  (r) => !r.completedAt && !r.priorPeriod,
                ).length,
                pendingPrior: rows.filter(
                  (r) => !r.completedAt && r.priorPeriod,
                ).length,
                valueAtRiskMinor: [...invoiceValueAtRisk.values()]
                  .reduce((total, value) => total + value, 0n)
                  .toString(),
                closureRate: rows.length
                  ? Math.round(
                      (rows.filter((r) => r.completedAt).length * 10000) /
                        rows.length,
                    ) / 100
                  : 0,
              }
            : lens === "collection"
              ? {
                  submitted: rows.length,
                  billedMinor: sum("valueMinor"),
                  receivedMinor: sum("receivedMinor"),
                  outstandingMinor: sum("balanceMinor"),
                  openInvoices: rows.filter(
                    (r) => BigInt(String(r.balanceMinor ?? 0)) > 0n,
                  ).length,
                  partPaid: rows.filter(
                    (r) =>
                      BigInt(String(r.receivedMinor ?? 0)) > 0n &&
                      BigInt(String(r.balanceMinor ?? 0)) > 0n,
                  ).length,
                  onHold: rows.filter((r) => r.hold).length,
                  over45Count: rows.filter(
                    (r) =>
                      Number(r.ageDays ?? 0) > 45 &&
                      BigInt(String(r.balanceMinor ?? 0)) > 0n,
                  ).length,
                  over45Minor: rows
                    .filter((r) => r.colour === "RED")
                    .reduce(
                      (n, r) => n + BigInt(String(r.balanceMinor ?? 0)),
                      0n,
                    )
                    .toString(),
                  oldestDays: rows.reduce(
                    (oldest, row) =>
                      BigInt(String(row.balanceMinor ?? 0)) > 0n
                        ? Math.max(oldest, Number(row.ageDays ?? 0))
                        : oldest,
                    0,
                  ),
                }
              : {
                  ...(lens === "trip"
                    ? {
                        active: rows.filter(
                          (r) =>
                            !["DELIVERED", "CANCELLED"].includes(
                              String(r.state),
                            ),
                        ).length,
                        atRisk: rows.filter(
                          (r) =>
                            r.colour !== "GREEN" &&
                            !["DELIVERED", "CANCELLED"].includes(
                              String(r.state),
                            ),
                        ).length,
                        delayed: rows.filter(
                          (r) =>
                            r.colour === "RED" &&
                            !["DELIVERED", "CANCELLED"].includes(
                              String(r.state),
                            ),
                        ).length,
                        gpsSilent: rows.filter(
                          (r) =>
                            !["DELIVERED", "CANCELLED"].includes(
                              String(r.state),
                            ) &&
                            (!r.lastGpsAt ||
                              now.getTime() -
                                new Date(String(r.lastGpsAt)).getTime() >
                                30 * 60 * 1000),
                        ).length,
                        loadingDetention: rows.filter(
                          (r) =>
                            r.state === "AT_ORIGIN" &&
                            now.getTime() -
                              new Date(String(r.updatedAt)).getTime() >
                              2 * 60 * 60 * 1000,
                        ).length,
                        unloadingDetention: rows.filter(
                          (r) =>
                            r.state === "AT_DESTINATION" &&
                            now.getTime() -
                              new Date(String(r.updatedAt)).getTime() >
                              2 * 60 * 60 * 1000,
                        ).length,
                        deliveryExceptions: rows.filter(
                          (r) => r.colour === "RED",
                        ).length,
                      }
                    : {
                        unbilled: rows.filter((r) => r.state === "DRAFT")
                          .length,
                        approvalPending: rows.filter((r) =>
                          [
                            "PENDING_OPERATIONAL_VERIFICATION",
                            "PENDING_FINANCE_APPROVAL",
                          ].includes(String(r.state)),
                        ).length,
                        due: rows.filter((r) => r.colour === "YELLOW").length,
                        overdue: rows.filter((r) => r.colour === "RED").length,
                        paymentBlocked: rows.filter((r) =>
                          ["VALIDATION_EXCEPTION", "DISPUTED"].includes(
                            String(r.state),
                          ),
                        ).length,
                        disputed: rows.filter((r) => r.state === "DISPUTED")
                          .length,
                        paid: rows.filter((r) => r.state === "PAID").length,
                        outstandingMinor: sum("balanceMinor"),
                      }),
                };
      const vendors =
        lens === "placement"
          ? await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT v.id,v.legal_name AS vendor,sum(a.allotted_vehicles)::int allotted,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state IN ('OFFERED','ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED')),0)::int ntp FROM app.allocations a JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=$1::uuid AND a.indent_id=ANY($4::uuid[]) AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id) GROUP BY v.id,v.legal_name ORDER BY ntp DESC,v.legal_name`,
              this.tenant(actor),
              actor.membershipId,
              actor.userId,
              rows.map((row) => row.id),
            )
          : [];
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
      const responseKpis = moneyVisible
        ? kpis
        : Object.fromEntries(
            Object.entries(kpis).map(([key, value]) => [
              key,
              key.toLowerCase().includes("minor") ? "••••" : value,
            ]),
          );
      const ageing =
        lens === "collection"
          ? (["CURRENT", "31_45", "46_90", "OVER_90"] as const).map(
              (bucket) => ({
                bucket,
                count: rows.filter(
                  (row) =>
                    this.ageingBucket(row) === bucket &&
                    BigInt(String(row.balanceMinor ?? 0)) > 0n,
                ).length,
                amountMinor: moneyVisible
                  ? rows
                      .filter((row) => this.ageingBucket(row) === bucket)
                      .reduce(
                        (total, row) =>
                          total + BigInt(String(row.balanceMinor ?? 0)),
                        0n,
                      )
                      .toString()
                  : "••••",
              }),
            )
          : [];
      return toJsonSafe({
        lens,
        asOf: now.toISOString(),
        timezone: tenant.timezone,
        moneyVisible,
        freshness: {
          lastCanonicalChange: latest,
          state:
            latest && now.getTime() - new Date(latest).getTime() < 300000
              ? "LIVE"
              : "DELAYED",
        },
        filters,
        kpis: responseKpis,
        rows: responseRows,
        vendors,
        ageing,
      });
    });
  }
  async exportCsv(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const asOf = new Date();
      const tenant = (
        await tx.$queryRawUnsafe<Array<{ timezone: string }>>(
          `SELECT timezone FROM app.tenants WHERE id=$1::uuid`,
          this.tenant(actor),
        )
      )[0]!;
      const { rows } = await this.rows(
        tx,
        actor,
        lens,
        raw,
        asOf,
        tenant.timezone,
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
          filters: filterSchema.parse(raw),
          rowCount: rows.length,
          columns,
        }),
      );
      return {
        filename: `control-${lens}-${new Date().toISOString().slice(0, 10)}.csv`,
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
        filters: filterSchema,
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
