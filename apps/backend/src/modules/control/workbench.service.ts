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
});

const queries: Record<Lens, string> = {
  placement: `SELECT i.id,i.indent_no AS reference,c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,i.state,i.body_type AS "truckType",i.requested_vehicles AS demand,
    coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int AS allotted,
    coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int AS placed,
    string_agg(DISTINCT v.legal_name,', ') AS vendors,string_agg(DISTINCT vh.registration_number,', ') AS vehicles,
    i.committed_placement_at AS "dueAt",i.updated_at AS "updatedAt",
    CASE WHEN i.state IN ('FULFILLED','CLOSED') OR coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)>=i.requested_vehicles THEN 'GREEN' WHEN now()>i.committed_placement_at+interval '48 hours' THEN 'RED' WHEN now()>i.committed_placement_at+interval '24 hours' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
    LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id LEFT JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
    LEFT JOIN app.allocation_assignments aa ON aa.tenant_id=a.tenant_id AND aa.allocation_id=a.id AND aa.assigned_to IS NULL LEFT JOIN app.vehicles vh ON vh.tenant_id=aa.tenant_id AND vh.id=aa.vehicle_id
    WHERE i.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id) GROUP BY i.id,c.id,c.legal_name,cl.id,cl.name`,
  pod: `SELECT p.id,t.trip_no AS reference,t.lr_no AS "secondaryReference",c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,p.state,
    p.delivered_at AS "dueAt",p.received_at AS "completedAt",p.invoice_value_minor AS "valueMinor",p.prior_period AS "priorPeriod",vh.registration_number AS vehicle,i.body_type AS "truckType",p.updated_at AS "updatedAt",
    CASE WHEN p.received_at IS NOT NULL THEN 'GREEN' WHEN p.prior_period OR now()>p.delivered_at+interval '15 days' THEN 'RED' WHEN now()>p.delivered_at+interval '7 days' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.vehicles vh ON vh.tenant_id=t.tenant_id AND vh.id=t.assigned_vehicle_id
    JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id
    JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
    WHERE p.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'pod.read','READ','pod-tasks',p.id)`,
  collection: `SELECT inv.id,inv.invoice_no AS reference,c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,inv.state,inv.total_minor AS "valueMinor",
    greatest(inv.total_minor-coalesce(sum(e.amount_minor),0),0)::bigint AS "balanceMinor",coalesce(sum(e.amount_minor),0)::bigint AS "receivedMinor",inv.acknowledged_at AS "dueAt",inv.due_date AS "contractDueDate",inv.created_at AS "updatedAt",
    CASE WHEN inv.state='REVERSED' OR greatest(inv.total_minor-coalesce(sum(e.amount_minor),0),0)=0 THEN 'GREEN' WHEN current_date>coalesce(inv.acknowledged_at::date,inv.invoice_date)+45 THEN 'RED' WHEN current_date>coalesce(inv.acknowledged_at::date,inv.invoice_date)+30 THEN 'YELLOW' ELSE 'GREEN' END colour,
    (SELECT f.outcome FROM app.collection_followups f WHERE f.tenant_id=inv.tenant_id AND f.invoice_id=inv.id ORDER BY f.created_at DESC LIMIT 1) AS "followupOutcome",
    (SELECT f.next_followup_at FROM app.collection_followups f WHERE f.tenant_id=inv.tenant_id AND f.invoice_id=inv.id ORDER BY f.created_at DESC LIMIT 1) AS "nextFollowupAt",
    (SELECT n.reason FROM app.invoice_notes n WHERE n.tenant_id=inv.tenant_id AND n.invoice_id=inv.id AND n.note_type IN ('CREDIT_NOTE','DEBIT_NOTE') ORDER BY n.created_at DESC LIMIT 1) AS hold
    FROM app.client_invoices inv JOIN app.clients c ON c.tenant_id=inv.tenant_id AND c.id=inv.client_id JOIN app.client_locations cl ON cl.tenant_id=inv.tenant_id AND cl.id=inv.client_location_id
    LEFT JOIN app.receipt_ledger_entries e ON e.tenant_id=inv.tenant_id AND e.invoice_id=inv.id
    WHERE inv.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'finance.read','READ','invoices',inv.id) GROUP BY inv.id,c.id,c.legal_name,cl.id,cl.name`,
  trip: `SELECT t.id,t.trip_no AS reference,t.lr_no AS "secondaryReference",c.id AS "clientId",c.legal_name AS client,cl.id AS "locationId",cl.name AS location,t.state,t.planned_delivery_at AS "dueAt",t.updated_at AS "updatedAt",vh.registration_number AS vehicle,d.display_name AS driver,
    CASE WHEN t.state='DELIVERED' THEN 'GREEN' WHEN now()>t.planned_delivery_at THEN 'RED' WHEN now()>t.planned_delivery_at-interval '2 hours' THEN 'YELLOW' ELSE 'GREEN' END colour
    FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id JOIN app.vehicles vh ON vh.tenant_id=t.tenant_id AND vh.id=t.assigned_vehicle_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id
    WHERE t.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',t.id)`,
  "vendor-payable": `SELECT b.id,b.vendor_invoice_no AS reference,v.id AS "vendorId",v.legal_name AS client,'Vendor' AS location,b.state,b.payable_minor AS "valueMinor",(b.payable_minor-coalesce(sum(pa.amount_minor) FILTER(WHERE pb.state='PAID'),0))::bigint AS "balanceMinor",b.invoice_date AS "dueAt",b.created_at AS "updatedAt",
    CASE WHEN b.state='PAID' THEN 'GREEN' WHEN b.state IN ('VALIDATION_EXCEPTION','DISPUTED') THEN 'RED' WHEN b.state IN ('PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL') THEN 'YELLOW' ELSE 'GREEN' END colour
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
  private async rows(tx: Tx, actor: SessionActor, lens: Lens, raw: unknown) {
    const filters = filterSchema.parse(raw);
    await this.permit(tx, actor);
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      queries[lens],
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
    );
    const needle = filters.search.toLocaleLowerCase();
    return {
      filters,
      rows: rows.filter(
        (row) =>
          (!filters.colour || row.colour === filters.colour) &&
          (!filters.clientId || row.clientId === filters.clientId) &&
          (!filters.locationId || row.locationId === filters.locationId) &&
          (!needle ||
            [
              row.reference,
              row.client,
              row.location,
              row.state,
              row.vehicle,
              row.vendors,
            ].some((v) =>
              String(v ?? "")
                .toLocaleLowerCase()
                .includes(needle),
            )),
      ),
    };
  }
  async dashboard(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const { filters, rows } = await this.rows(tx, actor, lens, raw);
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
      const now = new Date();
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
                valueAtRiskMinor: rows
                  .filter((r) => !r.completedAt)
                  .reduce((n, r) => n + BigInt(String(r.valueMinor ?? 0)), 0n)
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
                  over45Minor: rows
                    .filter((r) => r.colour === "RED")
                    .reduce(
                      (n, r) => n + BigInt(String(r.balanceMinor ?? 0)),
                      0n,
                    )
                    .toString(),
                }
              : {
                  records: rows.length,
                  green: count("GREEN"),
                  yellow: count("YELLOW"),
                  red: count("RED"),
                  valueMinor: sum("balanceMinor"),
                };
      const vendors =
        lens === "placement"
          ? await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT v.id,v.legal_name AS vendor,sum(a.allotted_vehicles)::int allotted,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state='PLACED'),0)::int placed,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state IN ('OFFERED','ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED')),0)::int ntp FROM app.allocations a JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id) GROUP BY v.id,v.legal_name ORDER BY ntp DESC,v.legal_name`,
              this.tenant(actor),
              actor.membershipId,
              actor.userId,
            )
          : [];
      return toJsonSafe({
        lens,
        asOf: now.toISOString(),
        freshness: {
          lastCanonicalChange: latest,
          state:
            latest && now.getTime() - new Date(latest).getTime() < 300000
              ? "LIVE"
              : "DELAYED",
        },
        filters,
        kpis,
        rows,
        vendors,
      });
    });
  }
  async exportCsv(actor: SessionActor, lens: Lens, raw: unknown) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const { rows } = await this.rows(tx, actor, lens, raw);
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
      ];
      return {
        filename: `control-${lens}-${new Date().toISOString().slice(0, 10)}.csv`,
        content: [
          columns,
          ...rows.map((row) => columns.map((key) => row[key] ?? "")),
        ]
          .map((line) => line.map((value) => csvCell(String(value))).join(","))
          .join("\r\n"),
      };
    });
  }
  async views(actor: SessionActor, lens: Lens) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.permit(tx, actor);
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
      await this.permit(tx, actor);
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
