import { Injectable } from "@nestjs/common";
import { withTenant } from "@logistics/db";
import { AppService } from "../../app.service.js";
import { controlKpis } from "./manifest.js";
import { tenantId, type TenantActor } from "./module-contract.js";

type Row = Record<string, unknown>;
type Lens = keyof typeof controlKpis;

const recordTypeByLens: Record<Lens, string[]> = {
  placement: ["indent", "allocation", "placement"],
  pod: ["pod_task", "pod_submission"],
  collection: ["client_invoice", "receipt", "followup"],
  trip: ["trip", "trip_event"],
  "vendor-payable": ["vendor_bill", "payment_batch"],
};

@Injectable()
export class ControlProvider {
  constructor(private readonly app: AppService) {}

  async dashboard(
    actor: TenantActor,
    lens: Lens,
    filters: Record<string, unknown> = {},
  ) {
    const id = tenantId(actor);
    const types = recordTypeByLens[lens];
    if (!types) throw new Error("Unknown control-tower lens");
    return withTenant(this.app.db, id, async (tx) => {
      const records = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT status,count(*)::int count,max(updated_at) AS "freshAt"
         FROM app.module_records WHERE tenant_id=$1::uuid AND resource_type=ANY($2::text[])
         GROUP BY status ORDER BY status`,
        id,
        types,
      );
      const total = records.reduce((sum, row) => sum + Number(row.count), 0);
      return {
        lens,
        asOf: new Date().toISOString(),
        freshness: records.reduce<string | null>((latest, row) => {
          const value = row.freshAt ? String(row.freshAt) : null;
          return !latest || (value && value > latest) ? value : latest;
        }, null),
        filters,
        kpiCodes: controlKpis[lens],
        totals: { records: total },
        status: records,
      };
    });
  }

  async drill(actor: TenantActor, lens: Lens, status?: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,module_key AS "moduleKey",resource_type AS "recordType",code AS "naturalKey",name,status,data,updated_at AS "updatedAt"
         FROM app.module_records WHERE tenant_id=$1::uuid AND resource_type=ANY($2::text[]) AND ($3::text IS NULL OR status=$3)
         ORDER BY updated_at DESC,id LIMIT 250`,
        id,
        recordTypeByLens[lens],
        status ?? null,
      ),
    );
  }
}
