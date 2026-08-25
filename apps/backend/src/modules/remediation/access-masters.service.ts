import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { withTenant, type Prisma } from "@logistics/db";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type Action = "READ" | "CREATE" | "UPDATE" | "ADMIN";

const uuid = z.string().uuid();
const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(160),
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  mobile: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
  portalAudience: z.enum(["INTERNAL", "VENDOR", "DRIVER", "CLIENT"]),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(1000),
});
const addressSchema = z.object({
  line1: z.string().trim().min(2).max(160),
  line2: z.string().trim().max(160).nullish(),
  postalCode: z.string().regex(/^[1-9][0-9]{5}$/),
  postalLocalityId: uuid,
});
const catalogSchema = z.object({
  kind: z.enum(["TRUCK_TYPE", "BODY_TYPE", "CARGO_TYPE"]),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullish(),
  capacityMilli: z
    .string()
    .regex(/^[1-9]\d*$/)
    .nullish(),
});
const enhancedSchemas = {
  "client-locations": z.object({
    clientId: uuid,
    code: z.string().trim().toUpperCase().min(2).max(30),
    name: z.string().trim().min(2).max(160),
    locationType: z.string().trim().min(2).max(60),
    organizationNodeId: uuid,
    managerEmployeeId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    mobile: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullish(),
    address: addressSchema,
    geofence: z.record(z.unknown()).default({}),
  }),
  vendors: z.object({
    code: z.string().trim().toUpperCase().min(2).max(30),
    legalName: z.string().trim().min(2).max(200),
    pan: z.string().trim().toUpperCase().max(32).nullish(),
    gstin: z.string().trim().toUpperCase().max(32).nullish(),
    paymentTermsDays: z.number().int().min(0).max(365).default(0),
    onboardingEmployeeId: uuid.nullish(),
    authorizationScopeNodeId: uuid.nullish(),
    address: addressSchema,
  }),
  drivers: z.object({
    vendorId: uuid,
    code: z.string().trim().toUpperCase().min(2).max(30),
    displayName: z.string().trim().min(2).max(160),
    mobile: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/),
    licenceNumber: z.string().trim().min(3).max(80),
    licenceClass: z.string().trim().min(1).max(40),
    licenceValidTo: z.string().date(),
    emergencyContact: z.string().trim().max(160).nullish(),
    portalMembershipId: uuid.nullish(),
    address: addressSchema,
  }),
  vehicles: z.object({
    vendorId: uuid,
    registrationNumber: z.string().trim().toUpperCase().min(4).max(40),
    truckTypeId: uuid,
    bodyTypeId: uuid,
    make: z.string().trim().max(80).nullish(),
    model: z.string().trim().max(80).nullish(),
    modelYear: z.number().int().min(1900).max(2200).nullish(),
    capacityMilli: z.string().regex(/^[1-9]\d*$/),
    gpsDeviceId: z.string().trim().max(100).nullish(),
  }),
};
export type EnhancedResource = keyof typeof enhancedSchemas;

const bool = (value: unknown) =>
  value === true || value === "true" || value === 1 || value === "1";
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    return item;
  });
const jsonSafe = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Row;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");

@Injectable()
export class AccessMastersService {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private tenant(actor: SessionActor) {
    if (!actor.membershipId)
      throw new AppError(403, "TENANT_CONTEXT_REQUIRED", "Select a tenant");
    return this.app.requireTenant(actor);
  }

  private async capability(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
    rootOnly = false,
  ) {
    const allowed = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a
         JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$3
         JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ($4,'ADMIN')
         JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE'
         WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
           AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
           AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
           AND (NOT $5::boolean OR n.scope_type='TENANT')) allowed`,
        this.tenant(actor),
        actor.membershipId,
        capability,
        action,
        rootOnly,
      )
    )[0];
    if (!bool(allowed?.allowed))
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  private async replay(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    key: string,
    input: unknown,
  ) {
    if (!key || key.length < 8 || key.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = hash(key),
      requestHash = hash(input);
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${actor.userId}:${operation}:${keyHash}`,
    );
    const prior = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT request_hash,response_json FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
        this.tenant(actor),
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (prior && prior.request_hash !== requestHash)
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was used for different input",
      );
    return {
      prior: prior?.response_json as Row | undefined,
      keyHash,
      requestHash,
    };
  }

  private async remember(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    keyHash: string,
    requestHash: string,
    result: Row,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      this.tenant(actor),
      actor.userId,
      operation,
      keyHash,
      requestHash,
      result.id ?? null,
      JSON.stringify(result),
    );
  }

  private async resource(
    tx: Tx,
    actor: SessionActor,
    action: Action,
    resource: string,
    resourceId: unknown,
  ) {
    const id = uuid.parse(resourceId);
    const allowed = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin',$4,$5,$6::uuid) allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        action,
        resource,
        id,
      )
    )[0];
    if (!bool(allowed?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private async scope(
    tx: Tx,
    actor: SessionActor,
    action: Action,
    scopeNodeId?: unknown,
  ) {
    const nodeId = scopeNodeId
      ? uuid.parse(scopeNodeId)
      : String(
          (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT' AND status='ACTIVE'`,
              this.tenant(actor),
            )
          )[0]?.id ?? "",
        );
    const allowed = (
      await tx.$queryRawUnsafe<Row[]>(
        `WITH RECURSIVE ancestors AS (
           SELECT id,parent_id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$5::uuid AND status='ACTIVE'
           UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors a ON a.parent_id=n.id WHERE n.tenant_id=$1::uuid AND n.status='ACTIVE'
         ) SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a
           JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='masters.admin'
           JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ($4,'ADMIN')
           WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND g.status='ACTIVE'
             AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
             AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
             AND g.scope_node_id IN (SELECT id FROM ancestors)) allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        action,
        nodeId,
      )
    )[0];
    if (!bool(allowed?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    return nodeId;
  }

  async directory(
    actor: SessionActor,
    input: {
      search?: string;
      status?: string;
      audience?: string;
      roleId?: string;
      sessionState?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "identity.user.read", "READ", true);
      const page = Math.max(1, Math.trunc(input.page ?? 1));
      const pageSize = Math.min(
        100,
        Math.max(10, Math.trunc(input.pageSize ?? 25)),
      );
      const search = (input.search ?? "").trim();
      const status = ["INVITED", "ACTIVE", "SUSPENDED"].includes(
        input.status ?? "",
      )
        ? input.status
        : null;
      const audience = ["INTERNAL", "VENDOR", "DRIVER", "CLIENT"].includes(
        input.audience ?? "",
      )
        ? input.audience
        : null;
      const roleId =
        input.roleId && uuid.safeParse(input.roleId).success
          ? input.roleId
          : null;
      const activeOnly = input.sessionState === "ACTIVE";
      const params = [
        tenantId,
        search,
        `%${search}%`,
        status,
        audience,
        roleId,
        activeOnly,
        pageSize,
        (page - 1) * pageSize,
      ];
      const where = `m.tenant_id=$1::uuid AND ($2='' OR m.invited_name ILIKE $3 OR m.employee_code ILIKE $3 OR m.invited_email ILIKE $3 OR m.invited_mobile ILIKE $3)
        AND ($4::text IS NULL OR m.status=$4) AND ($5::text IS NULL OR m.portal_audience=$5)
        AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM app.membership_role_assignments x WHERE x.tenant_id=m.tenant_id AND x.membership_id=m.id AND x.role_id=$6::uuid AND x.status='ACTIVE'))
        AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM app.sessions sx WHERE sx.active_tenant_id=m.tenant_id AND sx.membership_id=m.id AND sx.revoked_at IS NULL AND sx.expires_at>now()))`;
      const items = await tx.$queryRawUnsafe<Row[]>(
        `SELECT m.id,m.employee_code AS "employeeCode",m.invited_name AS "displayName",m.status,m.portal_audience AS "portalAudience",m.version,
          CASE WHEN m.invited_email IS NOT NULL THEN left(m.invited_email,1)||'***@'||split_part(m.invited_email,'@',2) ELSE '+••••••'||right(m.invited_mobile,2) END identifier,
          coalesce(array_agg(DISTINCT r.name) FILTER(WHERE r.name IS NOT NULL),'{}') roles,
          count(DISTINCT s.id) FILTER(WHERE s.revoked_at IS NULL AND s.expires_at>now())::int AS "activeSessions"
         FROM app.tenant_memberships m
         LEFT JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
         LEFT JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
         LEFT JOIN app.sessions s ON s.active_tenant_id=m.tenant_id AND s.membership_id=m.id
         WHERE ${where} GROUP BY m.id ORDER BY m.invited_name,m.id LIMIT $8 OFFSET $9`,
        ...params,
      );
      const total = await tx.$queryRawUnsafe<Row[]>(
        `SELECT count(*)::int total FROM app.tenant_memberships m WHERE ${where}`,
        ...params.slice(0, 7),
      );
      return { items, total: Number(total[0]?.total ?? 0), page, pageSize };
    });
  }

  async userDossier(actor: SessionActor, membershipId: string) {
    const tenantId = this.tenant(actor);
    uuid.parse(membershipId);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "identity.user.read", "READ", true);
      const profile = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT m.id,m.employee_code AS "employeeCode",m.invited_name AS "displayName",m.status,m.portal_audience AS "portalAudience",m.version,
             CASE WHEN m.invited_email IS NULL THEN null ELSE left(m.invited_email,1)||'***@'||split_part(m.invited_email,'@',2) END email,
             CASE WHEN m.invited_mobile IS NULL THEN null ELSE '+••••••'||right(m.invited_mobile,2) END mobile
           FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid`,
          tenantId,
          membershipId,
        )
      )[0];
      if (!profile)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const invitation =
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT masked_destination AS destination,expires_at AS "expiresAt",delivery_state AS "deliveryState",used_at AS "usedAt",revoked_at AS "revokedAt"
           FROM app.access_invitations WHERE tenant_id=$1::uuid AND membership_id=$2::uuid ORDER BY created_at DESC LIMIT 1`,
            tenantId,
            membershipId,
          )
        )[0] ?? null;
      const sessions = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",assurance_level AS "assuranceLevel",revoked_at AS "revokedAt",revoked_reason AS "revokedReason"
         FROM app.sessions WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid ORDER BY created_at DESC LIMIT 25`,
        tenantId,
        membershipId,
      );
      const mfa = await tx.$queryRawUnsafe<Row[]>(
        `SELECT f.factor_type AS "factorType",f.created_at AS "createdAt",f.verified_at AS "verifiedAt",f.disabled_at AS "disabledAt"
         FROM app.mfa_factors f JOIN app.tenant_memberships m ON m.user_id=f.user_id
         WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid ORDER BY f.created_at DESC`,
        tenantId,
        membershipId,
      );
      const history = await tx.$queryRawUnsafe<Row[]>(
        `SELECT action,occurred_at AS "occurredAt",reason,correlation_id AS "correlationId"
         FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_type='membership' AND target_id=$2::uuid ORDER BY occurred_at DESC LIMIT 50`,
        tenantId,
        membershipId,
      );
      return { profile, invitation, sessions, mfa, history };
    });
  }

  async updateProfile(
    actor: SessionActor,
    membershipId: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = profileSchema.parse(raw);
    const tenantId = this.tenant(actor);
    uuid.parse(membershipId);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "identity.user.admin", "ADMIN", true);
      const replay = await this.replay(
        tx,
        actor,
        `remediation.profile:${membershipId}`,
        key,
        input,
      );
      if (replay.prior) return { ...replay.prior, replayed: true };
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          membershipId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Profile changed; reload and retry",
        );
      const nextEmail = input.email ?? (before.invited_email as string | null),
        nextMobile = input.mobile ?? (before.invited_mobile as string | null);
      if (!nextEmail && !nextMobile)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Provide an email or mobile destination",
        );
      const collision = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id<>$2::uuid AND (invited_email=$3 OR invited_mobile=$4)`,
        tenantId,
        membershipId,
        nextEmail,
        nextMobile,
      );
      if (collision[0])
        throw new AppError(
          409,
          "IDENTITY_ALREADY_MEMBER",
          "This destination is already used",
        );
      const incompatibleRoles = await tx.$queryRawUnsafe<Row[]>(
        `SELECT DISTINCT r.name FROM app.membership_role_assignments a
         JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
         WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
           AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
           AND r.status='ACTIVE' AND NOT (r.portal_audiences @> ARRAY[$3]::text[])
         ORDER BY r.name`,
        tenantId,
        membershipId,
        input.portalAudience,
      );
      if (incompatibleRoles.length)
        throw new AppError(
          400,
          "ROLE_AUDIENCE_INCOMPATIBLE",
          "The selected portal audience is not allowed by every effective role",
          {
            portalAudience: [
              `Incompatible roles: ${incompatibleRoles.map((row) => String(row.name)).join(", ")}`,
            ],
          },
        );
      const audienceChanged = before.portal_audience !== input.portalAudience;
      const updated = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.tenant_memberships SET invited_name=$1,employee_code=$2,invited_email=$3,invited_mobile=$4,portal_audience=$5,
             authorization_version=authorization_version+CASE WHEN portal_audience<>$5 THEN 1 ELSE 0 END,
             updated_at=now(),version=version+1
           WHERE tenant_id=$6::uuid AND id=$7::uuid RETURNING id,version,authorization_version AS "authorizationVersion"`,
          input.displayName,
          input.employeeCode,
          nextEmail,
          nextMobile,
          input.portalAudience,
          tenantId,
          membershipId,
        )
      )[0]!;
      const revokedSessions = audienceChanged
        ? await tx.$queryRawUnsafe<Row[]>(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='PORTAL_AUDIENCE_CHANGED',context_version=context_version+1,updated_at=now(),version=version+1
             WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid AND revoked_at IS NULL
             RETURNING id`,
            tenantId,
            membershipId,
          )
        : [];
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason)
         VALUES($1::uuid,$2::uuid,'identity.profile.updated','membership',$3::uuid,$4,$5::jsonb,$6::jsonb,$7)`,
        tenantId,
        actor.userId,
        membershipId,
        correlationId,
        JSON.stringify({
          displayName: before.invited_name,
          employeeCode: before.employee_code,
          portalAudience: before.portal_audience,
          authorizationVersion: before.authorization_version,
        }),
        JSON.stringify({
          displayName: input.displayName,
          employeeCode: input.employeeCode,
          portalAudience: input.portalAudience,
          authorizationVersion: updated.authorizationVersion,
          revokedSessionCount: revokedSessions.length,
        }),
        input.reason,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','membership',$2::uuid,'identity.profile.changed.v1',$3,$4::jsonb,$5)`,
        tenantId,
        membershipId,
        Number(updated.version),
        JSON.stringify({
          membershipId,
          portalAudience: input.portalAudience,
          authorizationVersion: updated.authorizationVersion,
          revokedSessionCount: revokedSessions.length,
        }),
        `identity-profile:${membershipId}:v${String(updated.version)}`,
      );
      await this.remember(
        tx,
        actor,
        `remediation.profile:${membershipId}`,
        replay.keyHash,
        replay.requestHash,
        updated,
      );
      return updated;
    });
  }

  private async postalSnapshot(tx: Tx, input: z.infer<typeof addressSchema>) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT l.id,l.postal_code AS "postalCode",l.locality_name AS locality,l.district_name AS district,l.city_name AS city,l.region_name AS region,
          v.id AS "directoryVersionId",v.version AS "directoryVersion"
         FROM postal_reference.postal_localities l JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id
         WHERE l.id=$1::uuid AND l.postal_code=$2 AND l.country='IN' AND l.active AND v.active AND v.status='ACTIVE'`,
        input.postalLocalityId,
        input.postalCode,
      )
    )[0];
    if (!row)
      throw new AppError(
        400,
        "POSTAL_LOCALITY_INVALID",
        "Select a locality from the active PIN directory",
        { "address.postalCode": ["Unknown PIN codes are not accepted"] },
      );
    return {
      ...input,
      country: "IN",
      locality: row.locality,
      district: row.district,
      city: row.city,
      region: row.region,
      directoryVersion: row.directoryVersion,
      provenance: "DIRECTORY",
      directoryVersionId: row.directoryVersionId,
    };
  }

  async catalogs(actor: SessionActor, kind: string, search = "") {
    const tenantId = this.tenant(actor);
    const parsedKind = catalogSchema.shape.kind.parse(kind);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "masters.read", "READ");
      const items = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id,kind,code,name,description,capacity_milli::text AS "capacityMilli",state,version FROM app.transport_reference_masters
         WHERE tenant_id=$1::uuid AND kind=$2 AND ($3='' OR code ILIKE $4 OR name ILIKE $4) ORDER BY state,name,id LIMIT 100`,
        tenantId,
        parsedKind,
        search.trim(),
        `%${search.trim()}%`,
      );
      return { items };
    });
  }

  async createCatalog(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = catalogSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "masters.admin", "CREATE", true);
      const replay = await this.replay(
        tx,
        actor,
        `remediation.catalog:${input.kind}`,
        key,
        input,
      );
      if (replay.prior) return { ...replay.prior, replayed: true };
      const duplicate = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id FROM app.transport_reference_masters WHERE tenant_id=$1::uuid AND kind=$2 AND code=$3`,
          tenantId,
          input.kind,
          input.code,
        )
      )[0];
      if (duplicate)
        throw new AppError(
          409,
          "REFERENCE_EXISTS",
          "A reference with this code already exists",
        );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.transport_reference_masters(tenant_id,kind,code,name,description,capacity_milli,created_by)
           VALUES($1::uuid,$2,$3,$4,$5,$6::bigint,$7::uuid) RETURNING id,kind,code,name,state,version`,
          tenantId,
          input.kind,
          input.code,
          input.name,
          input.description ?? null,
          input.capacityMilli ?? null,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json) VALUES($1::uuid,$2::uuid,'master.reference.created','transport_reference',$3::uuid,$4,$5::jsonb)`,
        tenantId,
        actor.userId,
        row.id,
        correlationId,
        JSON.stringify(row),
      );
      await this.remember(
        tx,
        actor,
        `remediation.catalog:${input.kind}`,
        replay.keyHash,
        replay.requestHash,
        row,
      );
      return row;
    });
  }

  async createEnhanced(
    actor: SessionActor,
    resource: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    if (!(resource in enhancedSchemas))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    const parsed = enhancedSchemas[resource as EnhancedResource].parse(
      raw,
    ) as Record<string, unknown>;
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.capability(tx, actor, "masters.admin", "CREATE");
      const replay = await this.replay(
        tx,
        actor,
        `remediation.master:${resource}`,
        key,
        parsed,
      );
      if (replay.prior) return { ...replay.prior, replayed: true };
      if (resource === "vehicles" || resource === "drivers")
        await this.resource(tx, actor, "CREATE", "vendors", parsed.vendorId);
      if (resource === "client-locations") {
        await this.resource(tx, actor, "CREATE", "clients", parsed.clientId);
        await this.resource(
          tx,
          actor,
          "CREATE",
          "organization-nodes",
          parsed.organizationNodeId,
        );
        if (parsed.managerEmployeeId)
          await this.resource(
            tx,
            actor,
            "CREATE",
            "employees",
            parsed.managerEmployeeId,
          );
        if (parsed.authorizationScopeNodeId)
          await this.scope(
            tx,
            actor,
            "CREATE",
            parsed.authorizationScopeNodeId,
          );
      }
      if (resource === "vendors") {
        await this.scope(tx, actor, "CREATE", parsed.authorizationScopeNodeId);
        if (parsed.onboardingEmployeeId)
          await this.resource(
            tx,
            actor,
            "CREATE",
            "employees",
            parsed.onboardingEmployeeId,
          );
      }
      if (resource === "drivers" && parsed.portalMembershipId) {
        await this.capability(tx, actor, "identity.user.admin", "ADMIN", true);
        const membership = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='ACTIVE'`,
            tenantId,
            parsed.portalMembershipId,
          )
        )[0];
        if (!membership)
          throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      }
      let row: Row;
      if (resource === "vehicles") {
        const refs = await tx.$queryRawUnsafe<Row[]>(
          `SELECT id,kind,code FROM app.transport_reference_masters WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND state='ACTIVE'`,
          tenantId,
          [parsed.truckTypeId, parsed.bodyTypeId],
        );
        const truck = refs.find(
          (item) =>
            item.id === parsed.truckTypeId && item.kind === "TRUCK_TYPE",
        );
        const body = refs.find(
          (item) => item.id === parsed.bodyTypeId && item.kind === "BODY_TYPE",
        );
        if (!truck || !body)
          throw new AppError(
            400,
            "REFERENCE_INVALID",
            "Select active truck and body types",
          );
        row = (
          await tx.$queryRawUnsafe<Row[]>(
            `INSERT INTO app.vehicles(tenant_id,vendor_id,registration_number,vehicle_type,truck_type_id,body_type_id,make,model,model_year,capacity_milli,gps_device_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10::bigint,$11) RETURNING *`,
            tenantId,
            parsed.vendorId,
            parsed.registrationNumber,
            truck.code,
            truck.id,
            body.id,
            parsed.make ?? null,
            parsed.model ?? null,
            parsed.modelYear ?? null,
            parsed.capacityMilli,
            parsed.gpsDeviceId ?? null,
          )
        )[0]!;
      } else {
        const address = await this.postalSnapshot(
          tx,
          parsed.address as z.infer<typeof addressSchema>,
        );
        const snapshot = JSON.stringify({
          line1: address.line1,
          line2: address.line2 ?? null,
          country: "IN",
          postalCode: address.postalCode,
          locality: address.locality,
          district: address.district,
          city: address.city,
          region: address.region,
          directoryVersion: address.directoryVersion,
          provenance: "DIRECTORY",
        });
        if (resource === "client-locations")
          row = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.client_locations(tenant_id,client_id,code,name,location_type,organization_node_id,manager_employee_id,authorization_scope_node_id,mobile,geofence,address_snapshot,postal_locality_id,postal_directory_version_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10::jsonb,$11::jsonb,$12::uuid,$13::uuid) RETURNING *`,
              tenantId,
              parsed.clientId,
              parsed.code,
              parsed.name,
              parsed.locationType,
              parsed.organizationNodeId,
              parsed.managerEmployeeId ?? null,
              parsed.authorizationScopeNodeId ?? null,
              parsed.mobile ?? null,
              JSON.stringify(parsed.geofence ?? {}),
              snapshot,
              address.postalLocalityId,
              address.directoryVersionId,
            )
          )[0]!;
        else if (resource === "vendors")
          row = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.vendors(tenant_id,code,legal_name,pan,gstin,payment_terms_days,onboarding_employee_id,authorization_scope_node_id,address_snapshot,postal_locality_id,postal_directory_version_id) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::jsonb,$10::uuid,$11::uuid) RETURNING *`,
              tenantId,
              parsed.code,
              parsed.legalName,
              parsed.pan ?? null,
              parsed.gstin ?? null,
              parsed.paymentTermsDays,
              parsed.onboardingEmployeeId ?? null,
              parsed.authorizationScopeNodeId ?? null,
              snapshot,
              address.postalLocalityId,
              address.directoryVersionId,
            )
          )[0]!;
        else
          row = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.drivers(tenant_id,vendor_id,code,display_name,mobile,licence_number,licence_class,licence_valid_to,emergency_contact,portal_membership_id,address_snapshot,postal_locality_id,postal_directory_version_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::date,$9,$10::uuid,$11::jsonb,$12::uuid,$13::uuid) RETURNING *`,
              tenantId,
              parsed.vendorId,
              parsed.code,
              parsed.displayName,
              parsed.mobile,
              parsed.licenceNumber,
              parsed.licenceClass,
              parsed.licenceValidTo,
              parsed.emergencyContact ?? null,
              parsed.portalMembershipId ?? null,
              snapshot,
              address.postalLocalityId,
              address.directoryVersionId,
            )
          )[0]!;
      }
      const safeRow = jsonSafe(row);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json) VALUES($1::uuid,$2::uuid,'master.created',$3,$4::uuid,$5,$6::jsonb)`,
        tenantId,
        actor.userId,
        resource,
        row.id,
        correlationId,
        JSON.stringify(safeRow),
      );
      await this.remember(
        tx,
        actor,
        `remediation.master:${resource}`,
        replay.keyHash,
        replay.requestHash,
        safeRow,
      );
      return safeRow;
    });
  }
}
