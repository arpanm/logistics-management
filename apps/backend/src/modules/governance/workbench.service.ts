import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { toJsonSafe } from "@logistics/domain";
import { withTenant, type Prisma } from "@logistics/db";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { canonicalJson, tenantKeyHash } from "../control/idempotency.js";
type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
const minor = z
  .string()
  .regex(/^\d+$/, "Use non-negative integer minor units")
  .nullish();
const policySchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,40}$/),
    targetType: z.string().trim().min(2).max(80),
    minimumMinor: minor,
    maximumMinor: minor,
    steps: z
      .array(
        z
          .object({
            roleId: z.string().uuid(),
            label: z.string().trim().min(2).max(100),
            expiresHours: z.number().int().positive().max(8760).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    active: z.boolean().default(true),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.maximumMinor == null ||
      v.minimumMinor == null ||
      BigInt(v.maximumMinor) > BigInt(v.minimumMinor),
    { path: ["maximumMinor"], message: "Maximum must be greater than minimum" },
  );

@Injectable()
export class GovernanceWorkbenchService {
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
  private async permit(
    tx: Tx,
    actor: SessionActor,
    action: "READ" | "ADMIN",
    tenantRoot = false,
  ) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$3 JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ($4,'ADMIN') JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE' WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND ($5::boolean=false OR n.scope_type='TENANT') LIMIT 1`,
      this.tenant(actor),
      actor.membershipId,
      action === "READ" ? "governance.read" : "governance.admin",
      action,
      tenantRoot,
    );
    if (!rows.length)
      throw new AppError(
        403,
        "FORBIDDEN",
        tenantRoot
          ? "A tenant-root governance grant is required"
          : "Governance policy action is not permitted",
      );
  }
  private async validateRoles(
    tx: Tx,
    tenantId: string,
    steps: Array<{ roleId: string }>,
  ) {
    const ids = [...new Set(steps.map((step) => step.roleId))];
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND status='ACTIVE' AND id=ANY($2::uuid[])`,
      tenantId,
      ids,
    );
    if (rows.length !== ids.length)
      throw new AppError(
        400,
        "ROLE_INVALID",
        "Every approval step must reference an active role in this tenant",
      );
  }
  private async idempotent<T>(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    key: string,
    input: unknown,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (!key.trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required",
      );
    const tenantId = this.tenant(actor),
      keyHash = tenantKeyHash(tenantId, key),
      requestHash = createHash("sha256")
        .update(canonicalJson(toJsonSafe(input)))
        .digest("hex");
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:${actor.userId}:${operation}:${keyHash}`,
    );
    const existing = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash AS "requestHash",response_json AS response FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
        tenantId,
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used for different route or input",
        );
      return existing.response as T;
    }
    const response = toJsonSafe(await execute()) as T;
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      tenantId,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      (response as { id?: string }).id ?? null,
      JSON.stringify(response),
    );
    return response;
  }
  async list(actor: SessionActor) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.permit(tx, actor, "READ", true);
      return toJsonSafe(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,code,target_type AS "targetType",minimum_minor::text AS "minimumMinor",maximum_minor::text AS "maximumMinor",steps,active,version FROM app.approval_definitions WHERE tenant_id=$1::uuid ORDER BY code`,
          this.tenant(actor),
        ),
      );
    });
  }
  async roles(actor: SessionActor) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.permit(tx, actor, "READ", true);
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name FROM app.roles WHERE tenant_id=$1::uuid AND status='ACTIVE' ORDER BY name`,
        this.tenant(actor),
      );
    });
  }
  async create(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = policySchema.parse(raw),
      tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "ADMIN", true);
      return this.idempotent(
        tx,
        actor,
        "governance-workbench.policies.create",
        key,
        { route: "/policies", body: input },
        async () => {
          await this.validateRoles(tx, tenantId, input.steps);
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.approval_definitions(tenant_id,code,target_type,minimum_minor,maximum_minor,steps,active) VALUES($1::uuid,$2,$3,$4::bigint,$5::bigint,$6::jsonb,$7) RETURNING *`,
              tenantId,
              input.code,
              input.targetType,
              input.minimumMinor ?? null,
              input.maximumMinor ?? null,
              JSON.stringify(input.steps),
              input.active,
            )
          )[0]!;
          await this.evidence(tx, actor, row, correlationId, "created");
          return row;
        },
      );
    });
  }
  async update(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = policySchema.parse(raw),
      tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "ADMIN", true);
      return this.idempotent(
        tx,
        actor,
        `governance-workbench.policies.update:${id}`,
        key,
        { route: `/policies/${id}`, body: input },
        async () => {
          await this.validateRoles(tx, tenantId, input.steps);
          const before = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT * FROM app.approval_definitions WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              id,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Policy not found");
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Policy changed; reload and retry",
            );
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.approval_definitions SET code=$3,target_type=$4,minimum_minor=$5::bigint,maximum_minor=$6::bigint,steps=$7::jsonb,active=$8,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
              tenantId,
              id,
              input.code,
              input.targetType,
              input.minimumMinor ?? null,
              input.maximumMinor ?? null,
              JSON.stringify(input.steps),
              input.active,
            )
          )[0]!;
          await this.evidence(tx, actor, row, correlationId, "updated", before);
          return row;
        },
      );
    });
  }
  private async evidence(
    tx: Tx,
    actor: SessionActor,
    row: Row,
    correlationId: string,
    verb: string,
    before?: Row,
  ) {
    const tenantId = this.tenant(actor);
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json) VALUES($1::uuid,$2::uuid,$3,'approval-policy',$4::uuid,$5,$6::jsonb,$7::jsonb)`,
      tenantId,
      actor.userId,
      `approval.policy.${verb}`,
      row.id,
      correlationId,
      before ? JSON.stringify(toJsonSafe(before)) : null,
      JSON.stringify(toJsonSafe(row)),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key) VALUES($1::uuid,'TENANT','approval-policy',$2::uuid,'approval-policy.changed.v1',$3,$4::jsonb,$5) ON CONFLICT(deduplication_key) DO NOTHING`,
      tenantId,
      row.id,
      Number(row.version),
      JSON.stringify(toJsonSafe(row)),
      `${tenantId}:approval-policy:${String(row.id)}:v${Number(row.version)}`,
    );
  }
}
