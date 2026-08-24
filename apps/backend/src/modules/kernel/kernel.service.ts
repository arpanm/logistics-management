import { Inject, Injectable } from "@nestjs/common";
import { withTenant, type Prisma } from "@logistics/db";
import type { SessionActor } from "@logistics/auth";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { AlertsProvider } from "../alerts/alerts.provider.js";
import { IntegrationsProvider } from "../integrations/integrations.provider.js";
import type {
  KernelRecordInput,
  KernelRecordUpdate,
  KernelTransitionInput,
} from "./contracts.js";
import { findKernelManifest, moduleNavDescriptors } from "./manifests.js";
import { canonicalJson } from "../control/idempotency.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
const boundedJson = z
  .unknown()
  .refine(
    (value) => Buffer.byteLength(canonicalJson(value), "utf8") <= 16_384,
    "Payload is too large",
  );
const alertDataSchema = z
  .object({
    type: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[A-Z0-9_.-]+$/),
    severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]),
    summary: z.string().trim().min(2).max(500),
    sourceModule: z.string().trim().min(2).max(60).optional(),
    sourceRecordId: z.string().uuid().optional(),
    evidence: boundedJson.optional(),
  })
  .strict();
const failedDeliveryDataSchema = z
  .object({
    endpointId: z.string().uuid(),
    direction: z.enum(["INBOUND", "OUTBOUND"]),
    eventType: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    mappingVersion: z.number().int().positive().default(1),
    payload: boundedJson.optional(),
    reasonCode: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[A-Z0-9_.-]+$/)
      .optional(),
    safeError: z.string().trim().min(2).max(500).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

@Injectable()
export class KernelService {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(AlertsProvider) private readonly alerts: AlertsProvider,
    @Inject(IntegrationsProvider)
    private readonly integrations: IntegrationsProvider,
  ) {}

  private manifest(moduleKey: string, resource: string) {
    const manifest = findKernelManifest(moduleKey, resource);
    if (!manifest)
      throw new AppError(
        404,
        "MODULE_RESOURCE_NOT_FOUND",
        "Resource not found",
      );
    return manifest;
  }

  private tenant(actor: SessionActor) {
    if (!actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    return this.app.requireTenant(actor);
  }

  private async assertInternal(tx: Tx, actor: SessionActor) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT status,portal_audience AS audience FROM app.tenant_memberships
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND user_id=$3::uuid`,
      actor.activeTenantId,
      actor.membershipId,
      actor.userId,
    );
    if (rows[0]?.status !== "ACTIVE" || rows[0]?.audience !== "INTERNAL")
      throw new AppError(403, "FORBIDDEN", "You do not have permission");
  }

  private async snapshot(
    tx: Tx,
    tenantId: string,
    id: string,
    actorId: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.module_record_snapshots(tenant_id,record_id,snapshot_no,payload,captured_by)
       SELECT tenant_id,id,version,to_jsonb(r),$3::uuid FROM app.module_records r
       WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      tenantId,
      id,
      actorId,
    );
  }

  private async audit(
    tx: Tx,
    actor: SessionActor,
    action: string,
    id: string,
    correlationId: string,
    reason?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,reason)
       VALUES($1::uuid,$2::uuid,$3,'module_record',$4::uuid,$5,$6)`,
      actor.activeTenantId,
      actor.userId,
      action,
      id,
      correlationId,
      reason ?? null,
    );
  }

  manifests() {
    return { resources: [...moduleNavDescriptors] };
  }

  metadata(moduleKey: string, resource: string) {
    return this.manifest(moduleKey, resource);
  }

  async list(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    search = "",
    status = "",
    page = 1,
  ) {
    this.manifest(moduleKey, resource);
    if (moduleKey === "alerts" && resource === "alert") {
      const result = await this.alerts.queue(actor, status);
      return { ...result, page: 1, pageSize: 250 };
    }
    if (moduleKey === "integrations" && resource === "delivery") {
      const items = await this.integrations.deliveries(actor, status);
      return { items, total: items.length, page: 1, pageSize: 250 };
    }
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const safePage = Math.max(1, page);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name,status,data,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",created_at AS "createdAt",updated_at AS "updatedAt",version
         FROM app.module_records
         WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3
           AND ($4='' OR name ILIKE $5 OR code ILIKE $5) AND ($6='' OR status=$6)
         ORDER BY name,id LIMIT 25 OFFSET $7`,
        tenantId,
        moduleKey,
        resource,
        search.trim(),
        `%${search.trim()}%`,
        status,
        (safePage - 1) * 25,
      );
      const total = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int total FROM app.module_records
         WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3
           AND ($4='' OR name ILIKE $5 OR code ILIKE $5) AND ($6='' OR status=$6)`,
        tenantId,
        moduleKey,
        resource,
        search.trim(),
        `%${search.trim()}%`,
        status,
      );
      return {
        items: rows,
        total: Number(total[0]?.total ?? 0),
        page: safePage,
        pageSize: 25,
      };
    });
  }

  async create(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    input: KernelRecordInput,
    correlationId: string,
    idempotencyKey?: string,
  ) {
    const manifest = this.manifest(moduleKey, resource);
    if (moduleKey === "alerts" && resource === "alert") {
      const parsed = alertDataSchema.safeParse(input.data ?? {});
      if (!parsed.success)
        throw new AppError(400, "VALIDATION_FAILED", "Alert input is invalid");
      const data = parsed.data;
      return this.alerts.createOccurrence(
        actor,
        {
          code: input.code,
          title: input.name,
          type: data.type,
          severity: data.severity,
          summary: data.summary,
          sourceModule: data.sourceModule ?? "alerts",
          sourceRecordId: data.sourceRecordId,
          evidence: data.evidence,
        },
        idempotencyKey ?? "",
        correlationId,
      );
    }
    if (moduleKey === "integrations" && resource === "delivery") {
      const parsed = failedDeliveryDataSchema.safeParse(input.data ?? {});
      if (!parsed.success)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Delivery input is invalid",
        );
      const data = parsed.data;
      return this.integrations.recordFailedDelivery(
        actor,
        {
          endpointId: data.endpointId,
          direction: data.direction,
          eventId: input.code,
          eventType: data.eventType,
          mappingVersion: data.mappingVersion,
          payload: data.payload ?? data,
          correlationId,
          reasonCode: data.reasonCode,
          safeError: data.safeError,
          expectedVersion: data.expectedVersion,
        },
        idempotencyKey ?? "",
        correlationId,
      );
    }
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      try {
        const row = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.module_records(tenant_id,module_key,resource_type,code,name,status,data,effective_from,effective_to,created_by,updated_by)
             VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz,$10::uuid,$10::uuid)
             RETURNING id,code,name,status,data,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",version`,
            tenantId,
            moduleKey,
            resource,
            input.code.toUpperCase(),
            input.name,
            manifest.initialStatus,
            JSON.stringify(input.data ?? {}),
            input.effectiveFrom ?? null,
            input.effectiveTo ?? null,
            actor.userId,
          )
        )[0]!;
        await this.snapshot(tx, tenantId, String(row.id), actor.userId);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.module_workflow_events(tenant_id,record_id,to_status,actor_id,correlation_id)
           VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5)`,
          tenantId,
          row.id,
          manifest.initialStatus,
          actor.userId,
          correlationId,
        );
        await this.audit(
          tx,
          actor,
          `${moduleKey}.${resource}.created`,
          String(row.id),
          correlationId,
        );
        return row;
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw new AppError(409, "CODE_EXISTS", "Code is already in use");
        throw error;
      }
    });
  }

  async detail(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    id: string,
  ) {
    this.manifest(moduleKey, resource);
    if (moduleKey === "alerts" && resource === "alert")
      return this.alerts.detail(actor, id);
    if (moduleKey === "integrations" && resource === "delivery")
      return this.integrations.deliveryDetail(actor, id);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name,status,data,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",created_at AS "createdAt",updated_at AS "updatedAt",version
         FROM app.module_records WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3 AND id=$4::uuid`,
        tenantId,
        moduleKey,
        resource,
        id,
      );
      if (!rows[0])
        throw new AppError(404, "RECORD_NOT_FOUND", "Resource not found");
      const [snapshots, events, documents, comments] = await Promise.all([
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,snapshot_no AS "snapshotNo",captured_at AS "capturedAt" FROM app.module_record_snapshots WHERE tenant_id=$1::uuid AND record_id=$2::uuid ORDER BY snapshot_no DESC`,
          tenantId,
          id,
        ),
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,from_status AS "fromStatus",to_status AS "toStatus",reason,occurred_at AS "occurredAt" FROM app.module_workflow_events WHERE tenant_id=$1::uuid AND record_id=$2::uuid ORDER BY occurred_at DESC`,
          tenantId,
          id,
        ),
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,file_name AS "fileName",content_type AS "contentType",byte_size::text AS "byteSize",status,created_at AS "createdAt",version FROM app.module_documents WHERE tenant_id=$1::uuid AND record_id=$2::uuid ORDER BY created_at DESC`,
          tenantId,
          id,
        ),
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,body,created_at AS "createdAt",edited_at AS "editedAt",version FROM app.module_comments WHERE tenant_id=$1::uuid AND record_id=$2::uuid ORDER BY created_at DESC`,
          tenantId,
          id,
        ),
      ]);
      return { ...rows[0], snapshots, events, documents, comments };
    });
  }

  async update(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    id: string,
    input: KernelRecordUpdate,
    correlationId: string,
  ) {
    this.manifest(moduleKey, resource);
    if (
      (moduleKey === "alerts" && resource === "alert") ||
      (moduleKey === "integrations" && resource === "delivery")
    )
      throw new AppError(
        405,
        "METHOD_NOT_ALLOWED",
        "Operation is not supported",
      );
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.module_records SET code=coalesce($1,code),name=coalesce($2,name),data=coalesce($3::jsonb,data),effective_from=coalesce($4::timestamptz,effective_from),effective_to=coalesce($5::timestamptz,effective_to),updated_by=$6::uuid,updated_at=now(),version=version+1
           WHERE tenant_id=$7::uuid AND module_key=$8 AND resource_type=$9 AND id=$10::uuid AND version=$11
           RETURNING id,code,name,status,data,effective_from AS "effectiveFrom",effective_to AS "effectiveTo",version`,
          input.code?.toUpperCase() ?? null,
          input.name ?? null,
          input.data === undefined ? null : JSON.stringify(input.data),
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          actor.userId,
          tenantId,
          moduleKey,
          resource,
          id,
          input.expectedVersion,
        )
      )[0];
      if (!row)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "The record changed; reload and retry",
        );
      await this.snapshot(tx, tenantId, id, actor.userId);
      await this.audit(
        tx,
        actor,
        `${moduleKey}.${resource}.updated`,
        id,
        correlationId,
      );
      return row;
    });
  }

  async transition(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    id: string,
    input: KernelTransitionInput,
    correlationId: string,
  ) {
    const manifest = this.manifest(moduleKey, resource);
    if (
      (moduleKey === "alerts" && resource === "alert") ||
      (moduleKey === "integrations" && resource === "delivery")
    )
      throw new AppError(
        405,
        "METHOD_NOT_ALLOWED",
        "Operation is not supported",
      );
    if (!(manifest.statuses as readonly string[]).includes(input.toStatus))
      throw new AppError(
        400,
        "TRANSITION_INVALID",
        "Transition is not allowed",
      );
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const before = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT status,version FROM app.module_records WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3 AND id=$4::uuid FOR UPDATE`,
          tenantId,
          moduleKey,
          resource,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RECORD_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "The record changed; reload and retry",
        );
      if (
        ["INACTIVE", "REJECTED"].includes(input.toStatus) &&
        (input.reason?.trim().length ?? 0) < 5
      )
        throw new AppError(400, "REASON_REQUIRED", "A reason is required");
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.module_records SET status=$1,updated_by=$2::uuid,updated_at=now(),version=version+1
           WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING id,code,name,status,data,version`,
          input.toStatus,
          actor.userId,
          tenantId,
          id,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.module_workflow_events(tenant_id,record_id,from_status,to_status,reason,actor_id,correlation_id)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7)`,
        tenantId,
        id,
        before.status,
        input.toStatus,
        input.reason ?? null,
        actor.userId,
        correlationId,
      );
      await this.snapshot(tx, tenantId, id, actor.userId);
      await this.audit(
        tx,
        actor,
        `${moduleKey}.${resource}.transitioned`,
        id,
        correlationId,
        input.reason,
      );
      return row;
    });
  }

  async report(actor: SessionActor, moduleKey: string, resource: string) {
    const manifest = this.manifest(moduleKey, resource);
    if (moduleKey === "alerts" && resource === "alert")
      return this.alerts.report(actor);
    if (moduleKey === "integrations" && resource === "delivery")
      return this.integrations.deliveryReport(actor);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT status,count(*)::int count FROM app.module_records
         WHERE tenant_id=$1::uuid AND module_key=$2 AND resource_type=$3 GROUP BY status ORDER BY status`,
        tenantId,
        moduleKey,
        resource,
      );
      return {
        feature: manifest.feature,
        module: moduleKey,
        resource,
        dimensions: ["status"],
        rows,
      };
    });
  }

  async addComment(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    id: string,
    body: string,
  ) {
    this.manifest(moduleKey, resource);
    if (
      (moduleKey === "alerts" && resource === "alert") ||
      (moduleKey === "integrations" && resource === "delivery")
    )
      throw new AppError(
        405,
        "METHOD_NOT_ALLOWED",
        "Operation is not supported",
      );
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.module_comments(tenant_id,record_id,body,author_id)
         SELECT tenant_id,id,$1,$2::uuid FROM app.module_records WHERE tenant_id=$3::uuid AND module_key=$4 AND resource_type=$5 AND id=$6::uuid
         RETURNING id,body,created_at AS "createdAt",version`,
        body,
        actor.userId,
        tenantId,
        moduleKey,
        resource,
        id,
      );
      if (!rows[0])
        throw new AppError(404, "RECORD_NOT_FOUND", "Resource not found");
      return rows[0];
    });
  }

  async addDocument(
    actor: SessionActor,
    moduleKey: string,
    resource: string,
    id: string,
    document: {
      fileName: string;
      contentType: string;
      objectKey: string;
      byteSize: number;
      checksumSha256: string;
    },
  ) {
    this.manifest(moduleKey, resource);
    if (
      (moduleKey === "alerts" && resource === "alert") ||
      (moduleKey === "integrations" && resource === "delivery")
    )
      throw new AppError(
        405,
        "METHOD_NOT_ALLOWED",
        "Operation is not supported",
      );
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertInternal(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.module_documents(tenant_id,record_id,file_name,content_type,object_key,byte_size,checksum_sha256,uploaded_by)
         SELECT tenant_id,id,$1,$2,$3,$4,$5,$6::uuid FROM app.module_records WHERE tenant_id=$7::uuid AND module_key=$8 AND resource_type=$9 AND id=$10::uuid
         RETURNING id,file_name AS "fileName",content_type AS "contentType",byte_size::text AS "byteSize",status,version`,
        document.fileName,
        document.contentType,
        document.objectKey,
        document.byteSize,
        document.checksumSha256,
        actor.userId,
        tenantId,
        moduleKey,
        resource,
        id,
      );
      if (!rows[0])
        throw new AppError(404, "RECORD_NOT_FOUND", "Resource not found");
      return rows[0];
    });
  }
}
