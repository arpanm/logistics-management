import { Injectable } from "@nestjs/common";
import { withTenant } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { controlKpis } from "./manifest.js";
import { tenantId, type TenantActor } from "./module-contract.js";

type Row = Record<string, unknown>;
type Lens = keyof typeof controlKpis;
const lensQuery: Record<Lens, string> = {
  placement: `SELECT i.id,i.indent_no AS key,i.state,i.client_id AS "clientId",i.committed_placement_at AS "dueAt",i.requested_vehicles AS demand,coalesce(sum(a.allotted_vehicles) FILTER(WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0)::int supplied,
   CASE WHEN i.state IN ('FULFILLED','CLOSED') THEN 'GREEN' WHEN now()>=i.committed_placement_at THEN 'RED' WHEN now()>=i.committed_placement_at-interval '24 hours' THEN 'YELLOW' ELSE 'GREEN' END colour,i.updated_at AS "updatedAt"
   FROM app.indents i LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id WHERE i.tenant_id=$1::uuid AND ($2::uuid IS NULL OR i.client_id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.read','READ','indents',i.id) GROUP BY i.id`,
  pod: `SELECT p.id,t.trip_no AS key,p.state,i.client_id AS "clientId",p.delivered_at AS "dueAt",p.invoice_value_minor AS value,
   CASE WHEN p.received_at IS NOT NULL THEN 'GREEN' WHEN now()>=p.delivered_at+interval '15 days' THEN 'RED' WHEN now()>=p.delivered_at+interval '7 days' THEN 'YELLOW' ELSE 'GREEN' END colour,p.updated_at AS "updatedAt"
   FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE p.tenant_id=$1::uuid AND ($2::uuid IS NULL OR i.client_id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'pod.read','READ','pod-tasks',p.id)`,
  collection: `SELECT i.id,i.invoice_no AS key,i.state,i.client_id AS "clientId",i.due_date AS "dueAt",i.total_minor-coalesce(sum(e.amount_minor),0) AS value,
   CASE WHEN i.state='REVERSED' OR i.total_minor-coalesce(sum(e.amount_minor),0)<=0 THEN 'GREEN' WHEN current_date>i.due_date+45 THEN 'RED' WHEN current_date>i.due_date+30 THEN 'YELLOW' ELSE 'GREEN' END colour,i.created_at AS "updatedAt"
   FROM app.client_invoices i LEFT JOIN app.receipt_ledger_entries e ON e.tenant_id=i.tenant_id AND e.invoice_id=i.id WHERE i.tenant_id=$1::uuid AND ($2::uuid IS NULL OR i.client_id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'finance.read','READ','invoices',i.id) GROUP BY i.id`,
  trip: `SELECT t.id,t.trip_no AS key,t.state,i.client_id AS "clientId",t.planned_delivery_at AS "dueAt",CASE WHEN t.state='DELIVERED' THEN 'GREEN' WHEN now()>t.planned_delivery_at THEN 'RED' WHEN now()>t.planned_delivery_at-interval '2 hours' THEN 'YELLOW' ELSE 'GREEN' END colour,t.updated_at AS "updatedAt"
   FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE t.tenant_id=$1::uuid AND ($2::uuid IS NULL OR i.client_id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.read','READ','trips',t.id)`,
  "vendor-payable": `SELECT b.id,b.vendor_invoice_no AS key,b.state,null::uuid AS "clientId",null::date AS "dueAt",b.payable_minor-coalesce(sum(pa.amount_minor),0) AS value,
   CASE WHEN b.state='PAID' THEN 'GREEN' WHEN b.state IN ('VALIDATION_EXCEPTION','DISPUTED') THEN 'RED' WHEN b.state IN ('PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL') THEN 'YELLOW' ELSE 'GREEN' END colour,b.created_at AS "updatedAt"
   FROM app.vendor_bills b LEFT JOIN app.payment_allocations pa ON pa.tenant_id=b.tenant_id AND pa.vendor_bill_id=b.id WHERE b.tenant_id=$1::uuid AND $2::uuid IS NULL AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'finance.read','READ','vendor-bills',b.id) GROUP BY b.id`,
};

@Injectable()
export class ControlProvider {
  constructor(private readonly app: AppService) {}
  private lens(value: string) {
    if (!(value in lensQuery))
      throw new AppError(400, "LENS_INVALID", "Unknown control-tower lens");
    return value as Lens;
  }
  async dashboard(
    actor: TenantActor,
    value: Lens,
    filters: Record<string, unknown> = {},
  ) {
    const id = tenantId(actor),
      lens = this.lens(value);
    const clientId =
      typeof filters.clientId === "string" ? filters.clientId : null;
    return withTenant(this.app.db, id, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        lensQuery[lens],
        id,
        clientId,
        actor.membershipId,
        actor.userId,
      );
      const colours = { GREEN: 0, YELLOW: 0, RED: 0 };
      for (const row of rows)
        colours[String(row.colour) as keyof typeof colours]++;
      const valueTotal = rows.reduce(
        (sum, row) => sum + Number(row.value ?? 0),
        0,
      );
      const latest = rows.reduce<string | null>(
        (result, row) =>
          !result || String(row.updatedAt) > result
            ? String(row.updatedAt)
            : result,
        null,
      );
      return {
        lens,
        asOf: new Date().toISOString(),
        freshness: {
          lastCanonicalChange: latest,
          state:
            latest && Date.now() - new Date(latest).getTime() < 300000
              ? "LIVE"
              : "DELAYED",
        },
        filters,
        kpiCodes: controlKpis[lens],
        totals: { records: rows.length, valueMinor: valueTotal, ...colours },
        status: Object.entries(colours).map(([status, count]) => ({
          status,
          count,
        })),
        worstColour: colours.RED ? "RED" : colours.YELLOW ? "YELLOW" : "GREEN",
      };
    });
  }
  async drill(actor: TenantActor, value: Lens, status?: string) {
    const id = tenantId(actor),
      lens = this.lens(value);
    return withTenant(this.app.db, id, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        lensQuery[lens],
        id,
        null,
        actor.membershipId,
        actor.userId,
      );
      return rows
        .filter(
          (row) => !status || row.colour === status || row.state === status,
        )
        .slice(0, 250);
    });
  }
  async savedViews(actor: TenantActor, value: Lens) {
    const id = tenantId(actor),
      lens = this.lens(value).replace("-", "_").toUpperCase();
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,lens,name,filters,is_default AS "isDefault",version FROM app.control_saved_views WHERE tenant_id=$1::uuid AND owner_id=$2::uuid AND lens=$3 ORDER BY is_default DESC,name`,
        id,
        actor.userId,
        lens,
      ),
    );
  }
  async saveView(
    actor: TenantActor,
    value: Lens,
    input: {
      name: string;
      filters: Record<string, unknown>;
      isDefault: boolean;
      expectedVersion?: number;
    },
  ) {
    const id = tenantId(actor),
      lens = this.lens(value).replace("-", "_").toUpperCase();
    return withTenant(this.app.db, id, async (tx) => {
      if (input.isDefault)
        await tx.$executeRawUnsafe(
          `UPDATE app.control_saved_views SET is_default=false,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND owner_id=$2::uuid AND lens=$3`,
          id,
          actor.userId,
          lens,
        );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.control_saved_views(tenant_id,owner_id,lens,name,filters,is_default) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,owner_id,lens,name) DO UPDATE SET filters=excluded.filters,is_default=excluded.is_default,updated_at=now(),version=app.control_saved_views.version+1 WHERE $7::int IS NULL OR app.control_saved_views.version=$7 RETURNING id,lens,name,filters,is_default AS "isDefault",version`,
          id,
          actor.userId,
          lens,
          input.name,
          JSON.stringify(input.filters),
          input.isDefault,
          input.expectedVersion ?? null,
        )
      )[0]!;
    });
  }
}
