import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma, withTenant } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";
import { importProfiles } from "./manifest.js";

type Row = Record<string, unknown>;
type Dataset = keyof typeof importProfiles;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const targetByDataset: Record<Dataset, { module: string; resource: string }> = {
  CLIENT: { module: "masters", resource: "parties" },
  LOCATION: { module: "masters", resource: "locations" },
  VENDOR: { module: "masters", resource: "parties" },
  INDENT_PLACEMENT: { module: "operations", resource: "indents" },
  POD: { module: "pod", resource: "proofs" },
  INVOICE_COLLECTION: { module: "finance", resource: "invoices" },
  PAYMENT_RECEIPT: { module: "finance", resource: "receipts" },
};
const recordCode = (value: unknown, rowNumber: number) => {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized.length >= 2 ? normalized : `ROW-${rowNumber}`;
};

@Injectable()
export class DataProvider {
  constructor(private readonly app: AppService) {}

  async preview(
    actor: TenantActor,
    input: {
      dataset: Dataset;
      filename: string;
      mediaType: string;
      byteSize: number;
      checksum: string;
      sourceTimezone: string;
      importMode: "APPEND" | "UPSERT" | "FULL_FILE";
      headers: string[];
      rows: Array<Record<string, unknown>>;
      idempotencyKey: string;
    },
  ) {
    const id = tenantId(actor);
    const required = importProfiles[input.dataset];
    if (!required)
      throw new AppError(400, "DATASET_INVALID", "Unknown import dataset");
    if (!input.idempotencyKey || input.idempotencyKey.length < 8)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid idempotency key is required",
      );
    const duplicates = input.headers.filter(
      (header, index) => input.headers.indexOf(header) !== index,
    );
    const missing = required.filter(
      (header) => !input.headers.includes(header),
    );
    const unknown = input.headers.filter(
      (header) => !required.includes(header as never),
    );
    return withTenant(this.app.db, id, async (tx) => {
      const prior = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,summary,version FROM app.import_jobs WHERE tenant_id=$1::uuid AND dataset=$2 AND checksum=$3 AND import_mode=$4`,
          id,
          input.dataset,
          input.checksum,
          input.importMode,
        )
      )[0];
      if (prior) return { ...prior, replayed: true };
      const job = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.import_jobs(tenant_id,dataset,filename,media_type,byte_size,checksum,source_timezone,import_mode,state,uploader_id,idempotency_key_hash,header_map,summary)
         VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::jsonb,$13::jsonb) RETURNING id,state,version`,
          id,
          input.dataset,
          input.filename,
          input.mediaType,
          input.byteSize,
          input.checksum,
          input.sourceTimezone,
          input.importMode,
          missing.length || duplicates.length ? "FAILED" : "VALIDATED",
          actor.userId,
          sha(input.idempotencyKey),
          JSON.stringify(
            Object.fromEntries(input.headers.map((header) => [header, header])),
          ),
          JSON.stringify({
            rows: input.rows.length,
            missing,
            unknown,
            duplicates,
          }),
        )
      )[0]!;
      for (let index = 0; index < input.rows.length; index++)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.import_rows(tenant_id,job_id,row_number,natural_key,normalized_data,disposition) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6)`,
          id,
          job.id,
          index + 2,
          String(Object.values(input.rows[index]!)[0] ?? "") || null,
          JSON.stringify(input.rows[index]),
          missing.length || duplicates.length ? "REJECT" : "PENDING",
        );
      for (const header of missing)
        await this.addError(
          tx,
          id,
          String(job.id),
          null,
          header,
          "MISSING_HEADER",
          `Required header '${header}' is missing`,
        );
      for (const header of duplicates)
        await this.addError(
          tx,
          id,
          String(job.id),
          null,
          header,
          "DUPLICATE_HEADER",
          `Header '${header}' occurs more than once`,
        );
      return {
        ...job,
        summary: { rows: input.rows.length, missing, unknown, duplicates },
      };
    });
  }

  private addError(
    tx: Prisma.TransactionClient,
    tenant: string,
    job: string,
    row: number | null,
    column: string | null,
    code: string,
    message: string,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO app.import_errors(tenant_id,job_id,row_number,column_name,code,message,severity) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,'ERROR')`,
      tenant,
      job,
      row,
      column,
      code,
      message,
    );
  }

  async commit(actor: TenantActor, jobId: string, expectedVersion: number) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      const job = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,version,dataset FROM app.import_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          id,
          jobId,
        )
      )[0];
      if (!job)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(job.version) !== expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Import changed; reload and retry",
        );
      if (job.state !== "VALIDATED")
        throw new AppError(
          409,
          "IMPORT_NOT_VALIDATED",
          "Only a validated import can be committed",
        );
      const queued = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.import_jobs SET state='COMMIT_QUEUED',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,state,version`,
          id,
          jobId,
        )
      )[0]!;
      const target = targetByDataset[job.dataset as Dataset];
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,row_number AS "rowNumber",natural_key AS "naturalKey",normalized_data AS data
         FROM app.import_rows WHERE tenant_id=$1::uuid AND job_id=$2::uuid AND disposition='PENDING' ORDER BY row_number`,
        id,
        jobId,
      );
      const summary = { created: 0, updated: 0, unchanged: 0, rejected: 0 };
      for (const row of rows) {
        const code = recordCode(row.naturalKey, Number(row.rowNumber));
        const data = row.data as Record<string, unknown>;
        const candidateName = String(Object.values(data)[1] ?? code)
          .trim()
          .slice(0, 160);
        const name = candidateName.length >= 2 ? candidateName : code;
        const existing = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,version,data FROM app.module_records WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3 AND code=$4 FOR UPDATE`,
            id,
            target.module,
            target.resource,
            code,
          )
        )[0];
        let disposition: "CREATE" | "UPDATE" | "UNCHANGED";
        if (!existing) {
          await tx.$executeRawUnsafe(
            `INSERT INTO app.module_records(tenant_id,module_key,resource_type,code,name,status,data,created_by,updated_by)
             VALUES($1::uuid,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7::uuid,$7::uuid)`,
            id,
            target.module,
            target.resource,
            code,
            name,
            JSON.stringify(data),
            actor.userId,
          );
          disposition = "CREATE";
          summary.created++;
        } else if (JSON.stringify(existing.data) === JSON.stringify(data)) {
          disposition = "UNCHANGED";
          summary.unchanged++;
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO app.module_record_snapshots(tenant_id,record_id,snapshot_no,payload,captured_by)
             VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid)`,
            id,
            existing.id,
            Number(existing.version),
            JSON.stringify(existing.data),
            actor.userId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.module_records SET name=$1,data=$2::jsonb,updated_by=$3::uuid,updated_at=now(),version=version+1
             WHERE tenant_id=$4::uuid AND id=$5::uuid`,
            name,
            JSON.stringify(data),
            actor.userId,
            id,
            existing.id,
          );
          disposition = "UPDATE";
          summary.updated++;
        }
        await tx.$executeRawUnsafe(
          `UPDATE app.import_rows SET disposition=$1 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
          disposition,
          id,
          row.id,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','import_job',$2::uuid,'data.import.commit.requested.v1',$3::jsonb,$4)`,
        id,
        jobId,
        JSON.stringify({ jobId, dataset: job.dataset }),
        `import:${jobId}:commit`,
      );
      return (
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.import_jobs SET state='COMMITTED',summary=summary||$1::jsonb,committed_at=now(),updated_at=now(),version=version+1
           WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING id,state,summary,version`,
            JSON.stringify(summary),
            id,
            jobId,
          )
        )[0] ?? queued
      );
    });
  }

  async status(actor: TenantActor, jobId?: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,dataset,filename,state,summary,created_at AS "createdAt",committed_at AS "committedAt",version FROM app.import_jobs WHERE tenant_id=$1::uuid AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY created_at DESC LIMIT 100`,
        id,
        jobId ?? null,
      ),
    );
  }

  async errors(actor: TenantActor, jobId: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT row_number AS "rowNumber",column_name AS "columnName",code,message,severity FROM app.import_errors WHERE tenant_id=$1::uuid AND job_id=$2::uuid ORDER BY row_number NULLS FIRST,column_name`,
        id,
        jobId,
      ),
    );
  }
}
