import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { Prisma, withTenant } from "@logistics/db";
import { toJsonSafe } from "@logistics/domain";
import { AppError, AppService } from "../../app.service.js";
import { tenantId, type TenantActor } from "../control/module-contract.js";
import { importProfiles } from "./manifest.js";

type Row = Record<string, unknown>;
type Dataset = keyof typeof importProfiles;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordCode = (value: unknown, rowNumber: number) => {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized.length >= 2 ? normalized : `ROW-${rowNumber}`;
};

const validateHeaders = (headers: string[]) => {
  if (headers.some((header) => !header.trim()))
    throw new AppError(400, "EMPTY_HEADER", "Import headers must not be blank");
  const normalized = headers.map((header) => header.trim().toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length)
    throw new AppError(
      400,
      "DUPLICATE_HEADER",
      "Import headers must be unique",
    );
};

@Injectable()
export class DataProvider {
  constructor(private readonly app: AppService) {}

  private async importAccess(
    tx: Prisma.TransactionClient,
    actor: TenantActor,
    action: "READ" | "CREATE" | "UPDATE",
  ) {
    if (!actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT g.scope_node_id AS "scopeNodeId",n.scope_type AS "scopeType" FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='data.import.admin' JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ($4,'ADMIN') AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE' WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND EXISTS(SELECT 1 FROM app.tenant_memberships m WHERE m.tenant_id=a.tenant_id AND m.id=a.membership_id AND m.user_id=$3::uuid AND m.status='ACTIVE')`,
      tenantId(actor),
      actor.membershipId,
      actor.userId,
      action,
    );
    if (!rows.length)
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    return rows;
  }

  private async assertImportResource(
    tx: Prisma.TransactionClient,
    actor: TenantActor,
    action: "READ" | "CREATE" | "UPDATE",
    resource: string,
    resourceId: unknown,
  ) {
    const allowed = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'data.import.admin',$4,$5,$6::uuid) allowed`,
        tenantId(actor),
        actor.membershipId,
        actor.userId,
        action,
        resource,
        resourceId,
      )
    )[0];
    if (!(allowed?.allowed === true || allowed?.allowed === "true"))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private async importScopeNode(
    tx: Prisma.TransactionClient,
    actor: TenantActor,
  ) {
    const grants = await this.importAccess(tx, actor, "CREATE");
    const scopeNodeId = grants[0]?.scopeNodeId;
    if (!scopeNodeId)
      throw new AppError(
        403,
        "SCOPE_REQUIRED",
        "A permitted scope is required",
      );
    return String(scopeNodeId);
  }

  private async assertImportJobBinding(
    tx: Prisma.TransactionClient,
    actor: TenantActor,
    action: "READ" | "UPDATE",
    job: Row,
  ) {
    const binding = (job.headerMap ?? job.header_map ?? {}) as {
      __authorization?: { membershipId?: string; scopeNodeIds?: string[] };
    };
    const authorization = binding.__authorization;
    if (job.uploaderId !== actor.userId && job.uploader_id !== actor.userId)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    if (!authorization || authorization.membershipId !== actor.membershipId)
      throw new AppError(
        403,
        "IMPORT_SCOPE_CHANGED",
        "Import authorization changed",
      );
    const current = await this.importAccess(tx, actor, action);
    const currentScopeIds = new Set(
      current.map((grant) => String(grant.scopeNodeId)),
    );
    if (
      !authorization.scopeNodeIds?.length ||
      authorization.scopeNodeIds.some((scope) => !currentScopeIds.has(scope))
    )
      throw new AppError(
        403,
        "IMPORT_SCOPE_CHANGED",
        "Import authorization changed",
      );
  }

  async parseFile(filename: string, mediaType: string, contentBase64: string) {
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.length > 25_000_000)
      throw new AppError(
        413,
        "IMPORT_TOO_LARGE",
        "Import exceeds the size limit",
      );
    if (
      filename.toLowerCase().endsWith(".xlsx") ||
      mediaType.includes("spreadsheetml")
    ) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
      if (workbook.worksheets.length !== 1)
        throw new AppError(
          400,
          "XLSX_SHEET_COUNT_INVALID",
          "Upload one worksheet per import",
        );
      const sheet = workbook.worksheets[0]!;
      const matrix: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = Array.isArray(row.values)
          ? row.values.slice(1)
          : Object.values(row.values);
        matrix.push(
          values.map((value: unknown) =>
            typeof value === "object" && value !== null && "text" in value
              ? String((value as { text: unknown }).text)
              : String(value ?? "").trim(),
          ),
        );
      });
      const headers = matrix.shift() ?? [];
      if (!headers.length)
        throw new AppError(400, "XLSX_EMPTY", "Workbook has no header row");
      validateHeaders(headers);
      if (matrix.length > 10000)
        throw new AppError(
          413,
          "IMPORT_TOO_MANY_ROWS",
          "Import exceeds 10,000 rows",
        );
      return {
        headers,
        rows: matrix.map((values) =>
          Object.fromEntries(
            headers.map((header, index) => [header, values[index] ?? ""]),
          ),
        ),
        byteSize: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    if (!filename.toLowerCase().endsWith(".csv") && !mediaType.includes("csv"))
      throw new AppError(
        415,
        "IMPORT_MEDIA_UNSUPPORTED",
        "Only CSV and XLSX files are supported",
      );
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    if (Buffer.byteLength(text) > 25_000_000)
      throw new AppError(
        413,
        "IMPORT_TOO_LARGE",
        "Import exceeds the size limit",
      );
    const records: string[][] = [];
    let record: string[] = [],
      field = "",
      quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') {
          field += '"';
          index++;
        } else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        record.push(field.trim());
        field = "";
      } else if (char === "\n") {
        record.push(field.trim());
        if (record.some(Boolean)) records.push(record);
        record = [];
        field = "";
      } else if (char !== "\r") field += char;
    }
    if (quoted)
      throw new AppError(
        400,
        "CSV_QUOTE_INVALID",
        "CSV contains an unterminated quoted field",
      );
    record.push(field.trim());
    if (record.some(Boolean)) records.push(record);
    const headers = records.shift() ?? [];
    if (!headers.length)
      throw new AppError(400, "CSV_EMPTY", "CSV has no header row");
    validateHeaders(headers);
    if (records.length > 10000)
      throw new AppError(
        413,
        "IMPORT_TOO_MANY_ROWS",
        "Import exceeds 10,000 rows",
      );
    return {
      headers,
      rows: records.map((values) =>
        Object.fromEntries(
          headers.map((header, index) => [header, values[index] ?? ""]),
        ),
      ),
      byteSize: Buffer.byteLength(text),
      checksum: sha(text),
    };
  }

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
      const grants = await this.importAccess(tx, actor, "CREATE");
      const prior = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,summary,version,uploader_id AS "uploaderId",header_map AS "headerMap" FROM app.import_jobs WHERE tenant_id=$1::uuid AND dataset=$2 AND checksum=$3 AND import_mode=$4`,
          id,
          input.dataset,
          input.checksum,
          input.importMode,
        )
      )[0];
      if (prior) {
        await this.assertImportJobBinding(tx, actor, "READ", prior);
        return { ...prior, replayed: true };
      }
      const authorization = {
        membershipId: actor.membershipId,
        scopeNodeIds: [
          ...new Set(grants.map((grant) => String(grant.scopeNodeId))),
        ].sort(),
      };
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
          JSON.stringify({
            ...Object.fromEntries(
              input.headers.map((header) => [header, header]),
            ),
            __authorization: authorization,
          }),
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
          JSON.stringify(toJsonSafe(input.rows[index])),
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
      await this.importAccess(tx, actor, "UPDATE");
      const job = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,state,version,dataset,uploader_id AS "uploaderId",header_map AS "headerMap" FROM app.import_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          id,
          jobId,
        )
      )[0];
      if (!job)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await this.assertImportJobBinding(tx, actor, "UPDATE", job);
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
        let disposition: "CREATE" | "UPDATE" | "UNCHANGED" | "REJECT";
        try {
          disposition = await this.commitCanonicalRow(
            tx,
            actor,
            job.dataset as Dataset,
            code,
            data,
          );
          summary[
            disposition === "CREATE"
              ? "created"
              : disposition === "UPDATE"
                ? "updated"
                : "unchanged"
          ]++;
        } catch (error) {
          disposition = "REJECT";
          summary.rejected++;
          await this.addError(
            tx,
            id,
            jobId,
            Number(row.rowNumber),
            null,
            "CANONICAL_VALIDATION",
            error instanceof Error
              ? error.message
              : "Row could not be committed",
          );
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
        JSON.stringify(toJsonSafe({ jobId, dataset: job.dataset })),
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

  private async commitCanonicalRow(
    tx: Prisma.TransactionClient,
    actor: TenantActor,
    dataset: Dataset,
    code: string,
    data: Record<string, unknown>,
  ): Promise<"CREATE" | "UPDATE" | "UNCHANGED"> {
    const tenant = tenantId(actor);
    const userId = actor.userId;
    const text = (key: string) => String(data[key] ?? "").trim();
    const integer = (key: string) => {
      const value = Number(data[key]);
      if (!Number.isSafeInteger(value))
        throw new Error(`${key} must be an integer`);
      return value;
    };
    if (dataset === "CLIENT") {
      const entity = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,authorization_scope_node_id AS "scopeNodeId" FROM app.organization_nodes n WHERE tenant_id=$1::uuid AND node_type='LEGAL_ENTITY' AND state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'data.import.admin','CREATE','organization-nodes',n.id) ORDER BY active_from LIMIT 1`,
          tenant,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (!entity) throw new Error("Active billing legal entity is required");
      const existing = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,legal_name,credit_days FROM app.clients WHERE tenant_id=$1::uuid AND code=$2 FOR UPDATE`,
          tenant,
          code,
        )
      )[0];
      const name = text("Client Name"),
        credit = integer("Credit Days");
      if (!existing) {
        const scopeNodeId = entity.scopeNodeId
          ? String(entity.scopeNodeId)
          : await this.importScopeNode(tx, actor);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,authorization_scope_node_id,credit_days) VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6)`,
          tenant,
          code,
          name,
          entity.id,
          scopeNodeId,
          credit,
        );
        return "CREATE";
      }
      await this.assertImportResource(
        tx,
        actor,
        "UPDATE",
        "clients",
        existing.id,
      );
      if (
        existing.legal_name === name &&
        Number(existing.credit_days) === credit
      )
        return "UNCHANGED";
      await tx.$executeRawUnsafe(
        `UPDATE app.clients SET legal_name=$1,credit_days=$2,updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid`,
        name,
        credit,
        tenant,
        existing.id,
      );
      return "UPDATE";
    }
    if (dataset === "VENDOR") {
      const existing = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,legal_name FROM app.vendors WHERE tenant_id=$1::uuid AND code=$2 FOR UPDATE`,
            tenant,
            code,
          )
        )[0],
        name = text("Vendor Name");
      if (!existing) {
        const scopeNodeId = await this.importScopeNode(tx, actor);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.vendors(tenant_id,code,legal_name,authorization_scope_node_id) VALUES($1::uuid,$2,$3,$4::uuid)`,
          tenant,
          code,
          name,
          scopeNodeId,
        );
        return "CREATE";
      }
      await this.assertImportResource(
        tx,
        actor,
        "UPDATE",
        "vendors",
        existing.id,
      );
      if (existing.legal_name === name) return "UNCHANGED";
      await tx.$executeRawUnsafe(
        `UPDATE app.vendors SET legal_name=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        name,
        tenant,
        existing.id,
      );
      return "UPDATE";
    }
    if (dataset === "LOCATION") {
      const client = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,authorization_scope_node_id AS "scopeNodeId" FROM app.clients WHERE tenant_id=$1::uuid AND code=$2`,
            tenant,
            text("Client Code"),
          )
        )[0],
        node = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,authorization_scope_node_id AS "scopeNodeId" FROM app.organization_nodes n WHERE tenant_id=$1::uuid AND state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'data.import.admin','CREATE','organization-nodes',n.id) ORDER BY node_type='BRANCH' DESC LIMIT 1`,
            tenant,
            actor.membershipId,
            actor.userId,
          )
        )[0];
      if (!client || !node)
        throw new Error("Canonical client and organization node are required");
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "clients",
        client.id,
      );
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "organization-nodes",
        node.id,
      );
      const locationCode = text("Location Code"),
        name = text("Location Name");
      const existing = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,name FROM app.client_locations WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND code=$3 FOR UPDATE`,
          tenant,
          client.id,
          locationCode,
        )
      )[0];
      if (!existing) {
        const inheritedScope = client.scopeNodeId ?? node.scopeNodeId;
        const scopeNodeId = inheritedScope
          ? String(inheritedScope)
          : await this.importScopeNode(tx, actor);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.client_locations(tenant_id,client_id,code,name,location_type,organization_node_id,authorization_scope_node_id) VALUES($1::uuid,$2::uuid,$3,$4,'SERVICE',$5::uuid,$6::uuid)`,
          tenant,
          client.id,
          locationCode,
          name,
          node.id,
          scopeNodeId,
        );
        return "CREATE";
      }
      await this.assertImportResource(
        tx,
        actor,
        "UPDATE",
        "client-locations",
        existing.id,
      );
      if (existing.name === name) return "UNCHANGED";
      await tx.$executeRawUnsafe(
        `UPDATE app.client_locations SET name=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        name,
        tenant,
        existing.id,
      );
      return "UPDATE";
    }
    if (dataset === "POD") {
      const pod = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT p.id,p.state FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id WHERE p.tenant_id=$1::uuid AND t.lr_no=$2 FOR UPDATE`,
          tenant,
          text("LR No"),
        )
      )[0];
      if (!pod) throw new Error("Delivered trip/POD task was not found");
      await this.assertImportResource(tx, actor, "UPDATE", "pod-tasks", pod.id);
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO app.pod_invoice_links(tenant_id,pod_task_id,invoice_reference,invoice_date,value_minor) VALUES($1::uuid,$2::uuid,$3,$4::date,0) ON CONFLICT DO NOTHING`,
        tenant,
        pod.id,
        text("Invoice No"),
        text("Delivery Date") || null,
      );
      return inserted ? "CREATE" : "UNCHANGED";
    }
    if (dataset === "PAYMENT_RECEIPT") {
      const client = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.clients WHERE tenant_id=$1::uuid AND code=$2`,
          tenant,
          text("Client Code"),
        )
      )[0];
      if (!client) throw new Error("Canonical client was not found");
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "clients",
        client.id,
      );
      const existing = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.receipts WHERE tenant_id=$1::uuid AND receipt_ref=$2`,
          tenant,
          code,
        )
      )[0];
      if (existing) {
        await this.assertImportResource(
          tx,
          actor,
          "READ",
          "receipts",
          existing.id,
        );
        return "UNCHANGED";
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO app.receipts(tenant_id,receipt_ref,client_id,payment_date,amount_minor,mode,instrument_no,created_by) VALUES($1::uuid,$2,$3::uuid,$4::date,$5,$6,$2,$7::uuid)`,
        tenant,
        code,
        client.id,
        text("Payment Date"),
        integer("Amount Received"),
        text("Payment Mode"),
        userId,
      );
      return "CREATE";
    }
    if (dataset === "INVOICE_COLLECTION") {
      const client = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.clients WHERE tenant_id=$1::uuid AND code=$2`,
          tenant,
          text("Client Code"),
        )
      )[0];
      const location = client
        ? (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id FROM app.client_locations WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND code=$3`,
              tenant,
              client.id,
              text("Location Code"),
            )
          )[0]
        : undefined;
      if (!client || !location)
        throw new Error("Canonical client/location was not found");
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "clients",
        client.id,
      );
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "client-locations",
        location.id,
      );
      const existingInvoice = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.client_invoices WHERE tenant_id=$1::uuid AND invoice_no=$2`,
          tenant,
          code,
        )
      )[0];
      if (existingInvoice) {
        await this.assertImportResource(
          tx,
          actor,
          "READ",
          "invoices",
          existingInvoice.id,
        );
        return "UNCHANGED";
      }
      const total = integer("Total Invoice Amount");
      await tx.$executeRawUnsafe(
        `INSERT INTO app.client_invoices(tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,state,created_by,posted_at) SELECT $1::uuid,$2,$3::uuid,$4::uuid,$5::date,'INR',credit_days,$6,0,$6,'POSTED',$7::uuid,now() FROM app.clients WHERE tenant_id=$1::uuid AND id=$3::uuid`,
        tenant,
        code,
        client.id,
        location.id,
        text("Invoice Date"),
        total,
        userId,
      );
      return "CREATE";
    }
    if (dataset === "INDENT_PLACEMENT") {
      const resolved = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT c.id client_id,l.id location_id,cv.id contract_version_id,cl.id lane_id,r.amount_minor,s.placement_minutes FROM app.clients c JOIN app.client_locations l ON l.tenant_id=c.tenant_id AND l.client_id=c.id JOIN app.contracts ct ON ct.tenant_id=c.tenant_id AND ct.client_id=c.id AND ct.state='PUBLISHED' JOIN app.contract_versions cv ON cv.tenant_id=ct.tenant_id AND cv.contract_id=ct.id AND cv.version=ct.current_version JOIN app.contract_lanes cl ON cl.tenant_id=cv.tenant_id AND cl.contract_version_id=cv.id JOIN app.client_rate_lines r ON r.tenant_id=cl.tenant_id AND r.lane_id=cl.id AND r.state='PUBLISHED' JOIN app.sla_rules s ON s.tenant_id=cl.tenant_id AND s.lane_id=cl.id WHERE c.tenant_id=$1::uuid AND c.code=$2 AND l.code=$3 AND cl.truck_type=$4 ORDER BY cl.priority DESC LIMIT 1`,
          tenant,
          text("Client Code"),
          text("Location Code"),
          text("Truck Type"),
        )
      )[0];
      if (!resolved)
        throw new Error("Published contract/lane/rate/SLA was not found");
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "clients",
        resolved.client_id,
      );
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "client-locations",
        resolved.location_id,
      );
      await this.assertImportResource(
        tx,
        actor,
        "CREATE",
        "lanes",
        resolved.lane_id,
      );
      const existingIndent = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.indents WHERE tenant_id=$1::uuid AND indent_no=$2`,
          tenant,
          code,
        )
      )[0];
      if (existingIndent) {
        await this.assertImportResource(
          tx,
          actor,
          "READ",
          "indents",
          existingIndent.id,
        );
        return "UNCHANGED";
      }
      const pickup = text("Indent Date & Time"),
        committed = text("Committed Placement Date & Time");
      await tx.$executeRawUnsafe(
        `INSERT INTO app.indents(tenant_id,indent_no,client_id,client_location_id,contract_version_id,lane_id,requested_vehicles,quantity_milli,pickup_window_start,pickup_window_end,committed_placement_at,source,source_reference,cargo_type,body_type,commercial_snapshot,state,created_by) VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,1,1000,$7::timestamptz,$7::timestamptz+interval '1 hour',$8::timestamptz,'IMPORT',$9,null,$10,$11::jsonb,$12,$13::uuid)`,
        tenant,
        code,
        resolved.client_id,
        resolved.location_id,
        resolved.contract_version_id,
        resolved.lane_id,
        pickup,
        committed,
        `${code}:import`,
        text("Truck Type"),
        JSON.stringify({
          rateMinor: resolved.amount_minor,
          placementMinutes: resolved.placement_minutes,
        }),
        text("Placement Status") === "OPEN" ? "OPEN" : "DRAFT",
        userId,
      );
      return "CREATE";
    }
    throw new Error(`Unknown canonical import dataset: ${dataset}`);
  }

  async status(actor: TenantActor, jobId?: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.importAccess(tx, actor, "READ");
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,dataset,filename,state,summary,created_at AS "createdAt",committed_at AS "committedAt",version FROM app.import_jobs WHERE tenant_id=$1::uuid AND uploader_id=$2::uuid AND header_map->'__authorization'->>'membershipId'=$3 AND ($4::uuid IS NULL OR id=$4::uuid) ORDER BY created_at DESC LIMIT 100`,
        id,
        actor.userId,
        actor.membershipId,
        jobId ?? null,
      );
    });
  }

  async errors(actor: TenantActor, jobId: string) {
    const id = tenantId(actor);
    return withTenant(this.app.db, id, async (tx) => {
      await this.importAccess(tx, actor, "READ");
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT e.row_number AS "rowNumber",e.column_name AS "columnName",e.code,e.message,e.severity FROM app.import_errors e JOIN app.import_jobs j ON j.tenant_id=e.tenant_id AND j.id=e.job_id WHERE e.tenant_id=$1::uuid AND e.job_id=$2::uuid AND j.uploader_id=$3::uuid AND j.header_map->'__authorization'->>'membershipId'=$4 ORDER BY e.row_number NULLS FIRST,e.column_name`,
        id,
        jobId,
        actor.userId,
        actor.membershipId,
      );
    });
  }
}
