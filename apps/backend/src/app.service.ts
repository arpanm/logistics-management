import { Injectable, OnModuleDestroy } from "@nestjs/common";
import argon2 from "argon2";
import { randomBytes, createHash } from "node:crypto";
import {
  createDatabase,
  Prisma,
  PrismaClient,
  withPlatform,
  withTenant,
} from "@logistics/db";
import { loadConfig } from "@logistics/config";
import type { SessionActor } from "@logistics/auth";
import type { TenantCreateInput } from "@logistics/domain";

type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    meta?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "P2002" || candidate.code === "23505") return true;
  if (candidate.meta && typeof candidate.meta === "object") {
    const meta = candidate.meta as Record<string, unknown>;
    if (
      meta.code === "23505" ||
      meta.sqlState === "23505" ||
      meta.originalCode === "23505"
    )
      return true;
  }
  return candidate.cause ? isUniqueViolation(candidate.cause) : false;
};
const one = <T extends Row>(rows: T[]): T => {
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Resource not found");
  return rows[0];
};

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

@Injectable()
export class AppService implements OnModuleDestroy {
  readonly config = loadConfig();
  readonly db: PrismaClient = createDatabase();
  async onModuleDestroy() {
    await this.db.$disconnect();
  }

  async live() {
    return { status: "ok", service: "backend" };
  }
  async ready() {
    try {
      const migrations = await this.db.$queryRawUnsafe<
        Array<{ migration_name: string }>
      >(
        `SELECT migration_name FROM app._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at`,
      );
      const required = [
        "202608240001_fnd01_foundation",
        "202608240002_fnd01_security_hardening",
      ];
      if (
        !required.every((name) =>
          migrations.some((m) => m.migration_name === name),
        )
      )
        throw new Error("Required migration is missing");
      return {
        status: "ready",
        database: "connected",
        migration: "ready",
        migrationCount: migrations.length,
        latestMigration: migrations.at(-1)?.migration_name,
      };
    } catch {
      throw new AppError(
        503,
        "NOT_READY",
        "Database dependency is unavailable",
      );
    }
  }

  async session(
    sessionToken?: string,
  ): Promise<SessionActor & { sessionId: string }> {
    if (!sessionToken)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    const rows = await withPlatform(this.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `
      SELECT s.id AS "sessionId",u.id AS "userId",u.email,u.is_platform_admin AS "platformAdmin",s.active_tenant_id AS "activeTenantId",s.context_version AS "contextVersion",s.csrf_hash AS "csrfHash"
      FROM app.sessions s JOIN app.users u ON u.id=s.user_id
      LEFT JOIN app.tenants t ON t.id=s.active_tenant_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'
        AND (s.active_tenant_id IS NULL OR (
          t.status='ACTIVE' AND EXISTS (
            SELECT 1 FROM app.tenant_memberships m
            WHERE m.tenant_id=s.active_tenant_id AND m.user_id=s.user_id AND m.status='ACTIVE'
          )
        ))`,
        hash(sessionToken),
      ),
    );
    const row = rows[0];
    if (!row)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    return {
      sessionId: String(row.sessionId),
      userId: String(row.userId),
      email: String(row.email),
      platformAdmin: Boolean(row.platformAdmin),
      activeTenantId: row.activeTenantId ? String(row.activeTenantId) : null,
      contextVersion: Number(row.contextVersion),
      csrfToken: String(row.csrfHash),
    };
  }

  requireCsrf(actor: SessionActor, csrf?: string, origin?: string) {
    if (!csrf || hash(csrf) !== actor.csrfToken)
      throw new AppError(403, "CSRF_INVALID", "Request could not be verified");
    if (origin && origin !== this.config.FRONTEND_URL)
      throw new AppError(
        403,
        "ORIGIN_INVALID",
        "Request origin is not allowed",
      );
  }
  requirePlatform(actor: SessionActor) {
    if (!actor.platformAdmin)
      throw new AppError(403, "FORBIDDEN", "You do not have permission");
  }
  requireTenant(actor: SessionActor): string {
    if (!actor.activeTenantId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    return actor.activeTenantId;
  }

  private async newSession(
    tx: Tx,
    userId: string,
    activeTenantId: string | null,
    previousContext = 0,
  ) {
    const sessionToken = token(),
      csrf = token();
    await tx.$executeRawUnsafe(
      `INSERT INTO app.sessions(token_hash,csrf_hash,user_id,active_tenant_id,context_version,expires_at) VALUES($1,$2,$3::uuid,$4::uuid,$5,now()+($6||' hours')::interval)`,
      hash(sessionToken),
      hash(csrf),
      userId,
      activeTenantId,
      previousContext + 1,
      String(this.config.SESSION_TTL_HOURS),
    );
    return {
      sessionToken,
      csrfToken: csrf,
      contextVersion: previousContext + 1,
    };
  }

  private async audit(
    tx: Tx,
    input: {
      tenantId?: string | null;
      actorId?: string | null;
      action: string;
      targetType: string;
      targetId?: string | null;
      correlationId: string;
      before?: unknown;
      after?: unknown;
      reason?: string;
    },
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9)`,
      input.tenantId ?? null,
      input.actorId ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.correlationId,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.reason ?? null,
    );
  }

  async login(
    email: string,
    password: string,
    tenantCode: string | undefined,
    correlationId: string,
  ) {
    const normalized = email.trim().toLowerCase();
    const identityHash = hash(normalized);
    const outcome = await withPlatform(this.db, async (tx) => {
      const attempts = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT COALESCE(sum(attempts),0)::int count FROM app.login_attempts WHERE identity_hash=$1 AND window_start>now()-interval '15 minutes'`,
        identityHash,
      );
      if (Number(attempts[0]?.count ?? 0) >= 10)
        throw new AppError(
          429,
          "LOGIN_THROTTLED",
          "Sign in is temporarily unavailable",
        );
      const users = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,email,display_name AS "displayName",password_hash AS "passwordHash",is_platform_admin AS "platformAdmin" FROM app.users WHERE email=$1 AND status='ACTIVE'`,
        normalized,
      );
      const user = users[0];
      if (
        !user ||
        !(await argon2.verify(String(user.passwordHash), password))
      ) {
        await tx.$executeRawUnsafe(
          `INSERT INTO app.login_attempts(identity_hash,window_start) VALUES($1,date_trunc('minute',now())) ON CONFLICT(identity_hash,window_start) DO UPDATE SET attempts=app.login_attempts.attempts+1,updated_at=now()`,
          identityHash,
        );
        return { invalidCredentials: true } as const;
      }
      let activeTenantId: string | null = null;
      if (!Boolean(user.platformAdmin)) {
        const memberships = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT t.id,t.code,t.name FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.user_id=$1::uuid AND m.status='ACTIVE' AND t.status='ACTIVE' ORDER BY t.name`,
          String(user.id),
        );
        const chosen = tenantCode
          ? memberships.find((m) => m.code === tenantCode)
          : memberships.length === 1
            ? memberships[0]
            : undefined;
        if (!chosen && memberships.length > 1)
          return {
            requiresTenantSelection: true as const,
            tenants: memberships.map((membership) => ({
              code: membership.code,
              name: membership.name,
            })),
            user: {
              email: user.email,
              displayName: user.displayName,
              platformAdmin: false,
            },
          };
        activeTenantId = chosen ? String(chosen.id) : null;
      }
      const created = await this.newSession(
        tx,
        String(user.id),
        activeTenantId,
      );
      await this.audit(tx, {
        actorId: String(user.id),
        tenantId: activeTenantId,
        action: "auth.login.succeeded",
        targetType: "session",
        correlationId,
      });
      return {
        ...created,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          platformAdmin: Boolean(user.platformAdmin),
        },
        activeTenantId,
      };
    });
    if ("invalidCredentials" in outcome)
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect",
      );
    return outcome;
  }

  async logout(
    actor: SessionActor & { sessionId: string },
    correlationId: string,
  ) {
    return withPlatform(this.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE app.sessions SET revoked_at=now(),revoked_reason='LOGOUT',updated_at=now(),version=version+1 WHERE id=$1::uuid`,
        actor.sessionId,
      );
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId: actor.activeTenantId,
        action: "auth.logout",
        targetType: "session",
        targetId: actor.sessionId,
        correlationId,
      });
      return { ok: true };
    });
  }

  async me(actor: SessionActor) {
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT t.id,t.code,t.name,t.short_name AS "shortName",t.primary_color AS "primaryColor",t.accent_color AS "accentColor" FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.user_id=$1::uuid AND m.status='ACTIVE' AND t.status='ACTIVE' ORDER BY t.name`,
        actor.userId,
      );
      return {
        user: {
          id: actor.userId,
          email: actor.email,
          platformAdmin: actor.platformAdmin,
        },
        activeTenantId: actor.activeTenantId,
        contextVersion: actor.contextVersion,
        csrfToken: undefined,
        memberships: rows,
      };
    });
  }

  async provision(
    actor: SessionActor,
    input: TenantCreateInput,
    idempotencyKey: string,
    correlationId: string,
    injectFailure = false,
  ) {
    this.requirePlatform(actor);
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 200
    )
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify(input));
    try {
      return await withPlatform(this.db, async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `${actor.userId}:tenant.provision:${keyHash}`,
        );
        const replay = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT request_hash,response_json FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation='tenant.provision' AND key_hash=$2`,
          actor.userId,
          keyHash,
        );
        if (replay[0]) {
          if (replay[0].request_hash !== requestHash)
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This key was used for different input",
            );
          return { ...(replay[0].response_json as object), replayed: true };
        }
        const duplicate = await tx.$queryRawUnsafe<Array<{ exists: boolean }>>(
          `SELECT true AS exists FROM app.tenants WHERE code=$1 LIMIT 1`,
          input.code,
        );
        if (duplicate[0])
          throw new AppError(
            409,
            "TENANT_CODE_EXISTS",
            "Tenant code is already in use",
          );
        let tenantRows: Array<Row>;
        try {
          tenantRows = await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.tenants(code,name,legal_name,tax_identifier,address,timezone,locale,currency,fiscal_month,fiscal_day,support_name,support_email,support_mobile,short_name,primary_color,accent_color,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id,code,name,status,version`,
            input.code,
            input.name,
            input.legalName,
            input.taxIdentifier,
            JSON.stringify(input.address),
            input.timezone,
            input.locale,
            input.currency,
            input.fiscalYearStart.month,
            input.fiscalYearStart.day,
            input.support.name,
            input.support.email,
            input.support.mobile ?? null,
            input.branding.shortName,
            input.branding.primaryColor,
            input.branding.accentColor,
            input.active ? "ACTIVE" : "INACTIVE",
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new AppError(
              409,
              "TENANT_CODE_EXISTS",
              "Tenant code is already in use",
            );
          throw error;
        }
        const tenant = one(tenantRows),
          tenantId = String(tenant.id);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.legal_entities(tenant_id,code,name,tax_identifier,is_default) VALUES($1::uuid,$2,$3,$4,true)`,
          tenantId,
          input.legalEntity.code,
          input.legalEntity.name,
          input.legalEntity.taxIdentifier ?? input.taxIdentifier,
        );
        const configs: { namespace: string; value: unknown }[] = [
          { namespace: "roles", value: { roles: ["TENANT_OWNER"] } },
          {
            namespace: "reasons",
            value: {
              tenantLifecycle: ["Operational decision"],
              setup: ["Configured"],
            },
          },
          { namespace: "thresholds", value: { repeatedJobFailure: 3 } },
          { namespace: "branding", value: input.branding },
          { namespace: "modules", value: { enabled: ["foundation"] } },
        ];
        for (const c of configs)
          await tx.$executeRawUnsafe(
            `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value) VALUES($1::uuid,$2,1,$3::jsonb)`,
            tenantId,
            c.namespace,
            JSON.stringify(c.value),
          );
        const keys = [
          ["organization", "Organization"],
          ["users", "Users"],
          ["branches", "Branches"],
          ["clients", "Clients"],
          ["vendors", "Vendors"],
          ["commercial", "Commercial settings"],
          ["imports", "Imports"],
          ["branding", "Branding"],
        ];
        for (let i = 0; i < keys.length; i++)
          await tx.$executeRawUnsafe(
            `INSERT INTO app.setup_checklist_items(tenant_id,key,label,display_order,state) VALUES($1::uuid,$2,$3,$4,$5)`,
            tenantId,
            keys[i]![0],
            keys[i]![1],
            i + 1,
            keys[i]![0] === "branding" ? "COMPLETE" : "NOT_AVAILABLE",
          );
        const membershipRows = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.tenant_memberships(tenant_id,invited_email,invited_name,role,status) VALUES($1::uuid,$2,$3,'TENANT_OWNER','INVITED') RETURNING id`,
          tenantId,
          input.owner.email,
          input.owner.name,
        );
        const inviteToken = token(),
          expiresAt = new Date(
            Date.now() + this.config.INVITATION_TTL_HOURS * 3600000,
          );
        const inviteRows = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.owner_invitations(tenant_id,membership_id,email,token_hash,expires_at,delivery_state) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) RETURNING id`,
          tenantId,
          String(membershipRows[0]!.id),
          input.owner.email,
          hash(inviteToken),
          expiresAt,
          input.active ? "DELIVERED" : "PENDING_DELIVERY",
        );
        if (injectFailure && this.config.ENABLE_TEST_HOOKS === "true")
          throw new Error("Injected provisioning failure");
        const inviteId = String(inviteRows[0]!.id);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key,state,processed_at) VALUES($1::uuid,'TENANT','owner_invitation',$2::uuid,'owner_invitation.requested.v1',$3::jsonb,$4,$5,$6)`,
          tenantId,
          inviteId,
          JSON.stringify({
            invitationId: inviteId,
            maskedDestination: input.owner.email.replace(
              /^(.).+(@.*)$/,
              "$1***$2",
            ),
          }),
          `owner-invitation:${inviteId}:v1`,
          input.active ? "PROCESSED" : "PENDING",
          input.active ? new Date() : null,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO reporting.tenant_activity_projection(tenant_id,config_count,last_activity_at) VALUES($1::uuid,5,now())`,
          tenantId,
        );
        await this.audit(tx, {
          actorId: actor.userId,
          action: "tenant.provisioned",
          targetType: "tenant",
          targetId: tenantId,
          correlationId,
          after: { code: input.code, status: tenant.status },
        });
        const response = {
          tenant: {
            id: tenantId,
            code: tenant.code,
            name: tenant.name,
            status: tenant.status,
            version: tenant.version,
          },
          invitation: {
            id: inviteId,
            email: input.owner.email,
            expiresAt: expiresAt.toISOString(),
            state: input.active ? "DELIVERED" : "PENDING_DELIVERY",
          },
          invitationUrl: `${this.config.FRONTEND_URL}/accept-invitation?token=${inviteToken}`,
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO app.idempotency_records(scope,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('PLATFORM',$1::uuid,'tenant.provision',$2,$3,$4::uuid,$5::jsonb)`,
          actor.userId,
          keyHash,
          requestHash,
          tenantId,
          JSON.stringify({ ...response, invitationUrl: undefined }),
        );
        return response;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      await withPlatform(this.db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO app.platform_alerts(type,severity,deduplication_key,summary,correlation_id) VALUES('TENANT_PROVISIONING_FAILED','ERROR',$1,'Tenant provisioning failed safely',$2) ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=app.platform_alerts.occurrence_count+1,last_seen_at=now()`,
          keyHash,
          correlationId,
        ),
      );
      throw new AppError(
        500,
        "PROVISIONING_FAILED",
        "Tenant provisioning failed; retry with the same request",
      );
    }
  }

  async listTenants(actor: SessionActor, search = "", status = "", page = 1) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => {
      const p = Math.max(1, page),
        q = `%${search.trim()}%`,
        validStatus = ["ACTIVE", "INACTIVE"].includes(status) ? status : null;
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT h.*,t.version,(SELECT CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED' WHEN now()>=i.expires_at THEN 'EXPIRED' ELSE i.delivery_state END FROM app.owner_invitations i WHERE i.tenant_id=t.id ORDER BY i.created_at DESC LIMIT 1) AS "invitationState" FROM reporting.platform_tenant_health h JOIN app.tenants t ON t.id=h.id WHERE ($1='' OR t.name ILIKE $2 OR t.code ILIKE $2) AND ($3::text IS NULL OR t.status=$3) ORDER BY t.name LIMIT 25 OFFSET $4`,
        search,
        q,
        validStatus,
        (p - 1) * 25,
      );
      const counts = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int total FROM app.tenants t WHERE ($1='' OR t.name ILIKE $2 OR t.code ILIKE $2) AND ($3::text IS NULL OR t.status=$3)`,
        search,
        q,
        validStatus,
      );
      return {
        items: rows,
        total: Number(counts[0]?.total ?? 0),
        page: p,
        pageSize: 25,
      };
    });
  }

  async tenantDetail(actor: SessionActor, id: string) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT t.*,h.active_user_count,h.setup_complete,h.setup_total,h.last_activity_at FROM app.tenants t LEFT JOIN reporting.platform_tenant_health h ON h.id=t.id WHERE t.id=$1::uuid`,
        id,
      );
      const tenant = one(rows);
      const invites = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,email,expires_at AS "expiresAt",delivery_state AS "deliveryState",accepted_at AS "acceptedAt" FROM app.owner_invitations WHERE tenant_id=$1::uuid`,
        id,
      );
      return { tenant, invitations: invites };
    });
  }

  async lifecycle(
    actor: SessionActor,
    id: string,
    expectedVersion: number,
    reason: string,
    status: "ACTIVE" | "INACTIVE",
    correlationId: string,
    idempotencyKey: string,
    confirmationCode?: string,
  ) {
    this.requirePlatform(actor);
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 200
    )
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const operation = `tenant.lifecycle.${status.toLowerCase()}`;
    const keyHash = hash(idempotencyKey);
    const requestHash = hash(
      JSON.stringify({ id, expectedVersion, reason, status, confirmationCode }),
    );
    return withPlatform(this.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${actor.userId}:${operation}:${keyHash}`,
      );
      const replay = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash,response_json FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
        actor.userId,
        operation,
        keyHash,
      );
      if (replay[0]) {
        if (replay[0].request_hash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for different input",
          );
        return replay[0].response_json as Row;
      }
      if (status === "INACTIVE") {
        const tenantCode = await tx.$queryRawUnsafe<Array<{ code: string }>>(
          `SELECT code FROM app.tenants WHERE id=$1::uuid`,
          id,
        );
        if (!tenantCode[0])
          throw new AppError(404, "NOT_FOUND", "Resource not found");
        if (confirmationCode !== tenantCode[0].code)
          throw new AppError(
            400,
            "CONFIRMATION_MISMATCH",
            "Type the tenant code to confirm deactivation",
          );
      }
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.tenants SET status=$1,lifecycle_reason=$2,lifecycle_actor_id=$3::uuid,lifecycle_at=now(),updated_at=now(),version=version+1 WHERE id=$4::uuid AND version=$5 AND status<>$1 RETURNING id,code,name,status,version`,
        status,
        reason,
        actor.userId,
        id,
        expectedVersion,
      );
      if (!rows[0])
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Tenant changed; reload and retry",
        );
      if (status === "INACTIVE")
        await tx.$executeRawUnsafe(
          `UPDATE app.sessions SET revoked_at=now(),revoked_reason='TENANT_DEACTIVATED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND revoked_at IS NULL`,
          id,
        );
      else {
        await tx.$executeRawUnsafe(
          `UPDATE app.owner_invitations SET delivery_state='DELIVERED',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND delivery_state='PENDING_DELIVERY'`,
          id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.outbox_events SET state='PROCESSED',processed_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND event_type='owner_invitation.requested.v1' AND state='PENDING'`,
          id,
        );
      }
      await this.audit(tx, {
        actorId: actor.userId,
        action:
          status === "ACTIVE" ? "tenant.reactivated" : "tenant.deactivated",
        targetType: "tenant",
        targetId: id,
        correlationId,
        reason,
        after: { status },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO app.idempotency_records(scope,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('PLATFORM',$1::uuid,$2,$3,$4,$5::uuid,$6::jsonb)`,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        id,
        JSON.stringify(rows[0]),
      );
      return rows[0];
    });
  }

  async invitationPreview(inviteToken: string) {
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT t.name,t.short_name AS "shortName",t.primary_color AS "primaryColor",i.email,i.expires_at AS "expiresAt",EXISTS(SELECT 1 FROM app.users u WHERE u.email=i.email) AS "existingAccount" FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND t.status='ACTIVE'`,
        hash(inviteToken),
      );
      const row = one(rows);
      return {
        ...row,
        email: String(row.email).replace(/^(.).+(@.*)$/, "$1***$2"),
      };
    });
  }
  async acceptInvitation(
    inviteToken: string,
    displayName: string,
    password: string,
    correlationId: string,
  ) {
    return withPlatform(this.db, async (tx) => {
      const invites = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.id,i.tenant_id AS "tenantId",i.membership_id AS "membershipId",i.email FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND t.status='ACTIVE' FOR UPDATE`,
        hash(inviteToken),
      );
      const invite = one(invites);
      const existingUsers = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,email,display_name AS "displayName",password_hash AS "passwordHash" FROM app.users WHERE email=$1 FOR UPDATE`,
        String(invite.email),
      );
      let user: Row;
      if (existingUsers[0]) {
        if (
          !(await argon2.verify(
            String(existingUsers[0].passwordHash),
            password,
          ))
        )
          throw new AppError(
            401,
            "INVITATION_ACCEPTANCE_FAILED",
            "Invitation or credentials could not be verified",
          );
        user = {
          id: existingUsers[0].id,
          email: existingUsers[0].email,
          displayName: existingUsers[0].displayName,
        };
      } else {
        const passwordHash = await argon2.hash(password, {
          type: argon2.argon2id,
        });
        const users = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.users(email,display_name,password_hash) VALUES($1,$2,$3) RETURNING id,email,display_name AS "displayName"`,
          String(invite.email),
          displayName,
          passwordHash,
        );
        user = users[0]!;
      }
      await tx.$executeRawUnsafe(
        `UPDATE app.tenant_memberships SET user_id=$1::uuid,status='ACTIVE',updated_at=now(),version=version+1 WHERE id=$2::uuid AND tenant_id=$3::uuid`,
        String(user.id),
        String(invite.membershipId),
        String(invite.tenantId),
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.owner_invitations SET accepted_at=now(),updated_at=now(),version=version+1 WHERE id=$1::uuid`,
        String(invite.id),
      );
      const created = await this.newSession(
        tx,
        String(user.id),
        String(invite.tenantId),
      );
      await this.audit(tx, {
        actorId: String(user.id),
        tenantId: String(invite.tenantId),
        action: "owner_invitation.accepted",
        targetType: "owner_invitation",
        targetId: String(invite.id),
        correlationId,
      });
      return { ...created, user, activeTenantId: invite.tenantId };
    });
  }

  async switchTenant(
    actor: SessionActor & { sessionId: string },
    tenantId: string,
    expectedVersion: number,
    correlationId: string,
  ) {
    if (actor.contextVersion !== expectedVersion)
      throw new AppError(
        409,
        "CONTEXT_VERSION_CONFLICT",
        "Tenant context changed; reload",
      );
    return withPlatform(this.db, async (tx) => {
      const allowed = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT t.id FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.user_id=$1::uuid AND m.tenant_id=$2::uuid AND m.status='ACTIVE' AND t.status='ACTIVE'`,
        actor.userId,
        tenantId,
      );
      if (!allowed[0])
        throw new AppError(404, "NOT_FOUND", "Resource not found");
      await tx.$executeRawUnsafe(
        `UPDATE app.sessions SET revoked_at=now(),revoked_reason='TENANT_SWITCH',updated_at=now(),version=version+1 WHERE id=$1::uuid`,
        actor.sessionId,
      );
      const created = await this.newSession(
        tx,
        actor.userId,
        tenantId,
        actor.contextVersion,
      );
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId,
        action: "tenant.switched",
        targetType: "tenant",
        targetId: tenantId,
        correlationId,
      });
      return { ...created, activeTenantId: tenantId };
    });
  }

  async tenantContext(actor: SessionActor) {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) => {
      const tenants = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name,legal_name AS "legalName",timezone,locale,currency,short_name AS "shortName",primary_color AS "primaryColor",accent_color AS "accentColor",version FROM app.tenants WHERE id=$1::uuid AND status='ACTIVE'`,
        tenantId,
      );
      const tenant = one(tenants);
      const checklist = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT key,label,state,version FROM app.setup_checklist_items ORDER BY display_order`,
      );
      const configs = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT namespace,schema_version AS "schemaVersion",value,version FROM app.tenant_configuration ORDER BY namespace`,
      );
      return {
        tenant,
        checklist,
        configurations: configs,
        contextVersion: actor.contextVersion,
      };
    });
  }
  async updateChecklist(
    actor: SessionActor,
    key: string,
    expectedVersion: number,
    state: string,
    correlationId: string,
  ) {
    const tenantId = this.requireTenant(actor);
    if (key !== "branding")
      throw new AppError(
        409,
        "FEATURE_NOT_AVAILABLE",
        "This setup area is not available yet",
      );
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.setup_checklist_items SET state=$1,completed_by=CASE WHEN $1='COMPLETE' THEN $2::uuid ELSE NULL END,completed_at=CASE WHEN $1='COMPLETE' THEN now() ELSE NULL END,updated_at=now(),version=version+1 WHERE key=$3 AND version=$4 RETURNING key,label,state,version`,
        state,
        actor.userId,
        key,
        expectedVersion,
      );
      if (!rows[0])
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Checklist changed; reload",
        );
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId,
        action: "setup.updated",
        targetType: "setup_checklist",
        correlationId,
        after: { key, state },
      });
      return rows[0];
    });
  }

  async listProbes(actor: SessionActor, search = "") {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,label,note,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM app.tenant_probe_records WHERE label ILIKE $1 ORDER BY created_at DESC LIMIT 100`,
        `%${search}%`,
      );
      return { items: rows, total: rows.length };
    });
  }
  async createProbe(
    actor: SessionActor,
    label: string,
    note: string,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenantId = this.requireTenant(actor);
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 200
    )
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = hash(idempotencyKey);
    const requestHash = hash(JSON.stringify({ label, note }));
    return withTenant(this.db, tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${actor.userId}:probe.create:${keyHash}`,
      );
      const replay = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash,response_json FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation='probe.create' AND key_hash=$2`,
        actor.userId,
        keyHash,
      );
      if (replay[0]) {
        if (replay[0].request_hash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for different input",
          );
        return replay[0].response_json as Row;
      }
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.tenant_probe_records(tenant_id,label,note) VALUES($1::uuid,$2,$3) RETURNING id,label,note,version`,
        tenantId,
        label,
        note,
      );
      const probe = rows[0]!;
      const content = Buffer.from(note, "utf8");
      await tx.$executeRawUnsafe(
        `INSERT INTO app.stored_documents(tenant_id,probe_id,media_type,byte_length,sha256,content) VALUES($1::uuid,$2::uuid,'text/plain; charset=utf-8',$3,$4,$5)`,
        tenantId,
        String(probe.id),
        content.length,
        hash(note),
        content,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','tenant_probe',$2::uuid,'tenant.probe.changed.v1',$3::jsonb,$4)`,
        tenantId,
        String(probe.id),
        JSON.stringify({ probeId: probe.id, action: "CREATED" }),
        `probe:${probe.id}:created`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE reporting.tenant_activity_projection SET probe_count=probe_count+1,event_count=event_count+1,last_activity_at=now(),refreshed_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid`,
        tenantId,
      );
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId,
        action: "probe.created",
        targetType: "tenant_probe",
        targetId: String(probe.id),
        correlationId,
        after: { label },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('TENANT',$1::uuid,$2::uuid,'probe.create',$3,$4,$5::uuid,$6::jsonb)`,
        tenantId,
        actor.userId,
        keyHash,
        requestHash,
        String(probe.id),
        JSON.stringify(probe),
      );
      return probe;
    });
  }
  async getProbe(actor: SessionActor, id: string) {
    const tenantId = this.requireTenant(actor);
    const result = await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,label,note,version FROM app.tenant_probe_records WHERE id=$1::uuid`,
        id,
      );
      return rows[0] ?? null;
    });
    if (!result) {
      await withTenant(this.db, tenantId, async (tx) => {
        await this.audit(tx, {
          actorId: actor.userId,
          tenantId,
          action: "authorization.denied",
          targetType: "tenant_probe",
          targetId: id,
          correlationId: "tenant-boundary-denial",
          reason: "Resource unavailable in active tenant context",
        });
      });
      throw new AppError(404, "NOT_FOUND", "Resource not found");
    }
    return result;
  }
  async updateProbe(
    actor: SessionActor,
    id: string,
    input: { label?: string; note?: string; expectedVersion: number },
    correlationId: string,
  ) {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.tenant_probe_records SET label=COALESCE($1,label),note=COALESCE($2,note),updated_at=now(),version=version+1 WHERE id=$3::uuid AND version=$4 RETURNING id,label,note,version`,
        input.label ?? null,
        input.note ?? null,
        id,
        input.expectedVersion,
      );
      if (!rows[0]) {
        const exists = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT version FROM app.tenant_probe_records WHERE id=$1::uuid`,
          id,
        );
        if (exists[0])
          throw new AppError(409, "VERSION_CONFLICT", "Record changed; reload");
        throw new AppError(404, "NOT_FOUND", "Resource not found");
      }
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId,
        action: "probe.updated",
        targetType: "tenant_probe",
        targetId: id,
        correlationId,
        after: { label: rows[0].label },
      });
      return rows[0];
    });
  }
  async probeDocument(actor: SessionActor, id: string) {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) =>
      one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT d.content,d.media_type AS "mediaType",d.byte_length AS "byteLength",d.sha256 FROM app.stored_documents d JOIN app.tenant_probe_records p ON p.id=d.probe_id AND p.tenant_id=d.tenant_id WHERE p.id=$1::uuid`,
          id,
        ),
      ),
    );
  }
  async exportProbes(actor: SessionActor, search = "") {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT label,note,created_at AS "createdAt" FROM app.tenant_probe_records WHERE label ILIKE $1 ORDER BY created_at`,
        `%${search}%`,
      ),
    );
  }
  async probeReport(actor: SessionActor) {
    const tenantId = this.requireTenant(actor);
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int AS "probeCount",max(updated_at) AS "lastActivityAt" FROM app.tenant_probe_records`,
      );
      return rows[0];
    });
  }

  async platformReport(actor: SessionActor) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => {
      const totals = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int total,count(*) FILTER(WHERE status='ACTIVE')::int active,count(*) FILTER(WHERE status='INACTIVE')::int inactive FROM app.tenants`,
      );
      const tenants = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT * FROM reporting.platform_tenant_health ORDER BY name`,
      );
      const size = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT pg_database_size(current_database())::text AS bytes`,
      );
      return {
        generatedAt: new Date().toISOString(),
        totals: totals[0],
        projectDatabaseBytes: size[0]?.bytes,
        storageLabel: "Shared-container project database usage",
        integrationHealth: "Not configured",
        tenants,
      };
    });
  }
  async alerts(actor: SessionActor) {
    this.requirePlatform(actor);
    return withPlatform(this.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,type,severity,summary,state,occurrence_count AS "occurrenceCount",correlation_id AS "correlationId",last_seen_at AS "lastSeenAt",version FROM app.platform_alerts ORDER BY last_seen_at DESC LIMIT 100`,
      ),
    );
  }

  async claimTenantJob(tenantId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `WITH candidate AS (
           SELECT j.id FROM app.job_runs j JOIN app.tenants t ON t.id=j.tenant_id
           WHERE j.tenant_id=$1::uuid AND j.scope='TENANT' AND j.state='PENDING' AND j.next_at<=now() AND t.status='ACTIVE'
           ORDER BY j.next_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
         )
         UPDATE app.job_runs j SET state='LEASED',leased_at=now(),attempts=attempts+1,updated_at=now(),version=version+1
         FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.tenant_id AS "tenantId",j.job_type AS "jobType",j.job_key AS "jobKey"`,
        tenantId,
      );
      return rows[0] ?? null;
    });
  }

  async claimTenantEvent(tenantId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `WITH candidate AS (
           SELECT o.id FROM app.outbox_events o JOIN app.tenants t ON t.id=o.tenant_id
           WHERE o.tenant_id=$1::uuid AND o.scope='TENANT' AND o.state='PENDING' AND o.available_at<=now() AND t.status='ACTIVE'
           ORDER BY o.available_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
         )
         UPDATE app.outbox_events o SET state='LEASED',leased_at=now(),attempts=attempts+1,updated_at=now(),version=version+1
         FROM candidate WHERE o.id=candidate.id RETURNING o.id,o.tenant_id AS "tenantId",o.event_type AS "eventType",o.deduplication_key AS "deduplicationKey"`,
        tenantId,
      );
      return rows[0] ?? null;
    });
  }

  async reconcileRepeatedJobFailures() {
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT j.tenant_id AS "tenantId",j.job_type AS "jobType",count(*)::int occurrences
         FROM app.job_runs j JOIN app.tenants t ON t.id=j.tenant_id
         WHERE j.scope='TENANT' AND j.state='FAILED' AND j.attempts>=3 AND t.status='ACTIVE'
         GROUP BY j.tenant_id,j.job_type`,
      );
      for (const row of rows) {
        const dedupe = `repeated-job-failure:${row.tenantId}:${row.jobType}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.platform_alerts(tenant_id,type,severity,deduplication_key,summary,occurrence_count)
           VALUES($1::uuid,'REPEATED_JOB_FAILURE','ERROR',$2,'A tenant job has repeatedly failed',$3)
           ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=EXCLUDED.occurrence_count,last_seen_at=now(),updated_at=now(),version=app.platform_alerts.version+1`,
          String(row.tenantId),
          dedupe,
          Number(row.occurrences),
        );
      }
      return { reconciled: rows.length };
    });
  }

  async setMembershipFixture(
    actor: SessionActor,
    input: { tenantId: string; userId: string; status: "ACTIVE" | "SUSPENDED" },
    correlationId: string,
  ) {
    this.requirePlatform(actor);
    if (this.config.ENABLE_TEST_HOOKS !== "true")
      throw new AppError(404, "NOT_FOUND", "Resource not found");
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.tenant_memberships SET status=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND user_id=$3::uuid RETURNING id,tenant_id AS "tenantId",user_id AS "userId",status,version`,
        input.status,
        input.tenantId,
        input.userId,
      );
      if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Resource not found");
      if (input.status === "SUSPENDED")
        await tx.$executeRawUnsafe(
          `UPDATE app.sessions SET revoked_at=now(),revoked_reason='MEMBERSHIP_SUSPENDED',updated_at=now(),version=version+1 WHERE user_id=$1::uuid AND active_tenant_id=$2::uuid AND revoked_at IS NULL`,
          input.userId,
          input.tenantId,
        );
      await this.audit(tx, {
        actorId: actor.userId,
        tenantId: input.tenantId,
        action: `test.membership.${input.status.toLowerCase()}`,
        targetType: "tenant_membership",
        targetId: String(rows[0].id),
        correlationId,
        after: { status: input.status },
      });
      return rows[0];
    });
  }
}
