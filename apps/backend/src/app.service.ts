import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import argon2 from "argon2";
import {
  randomBytes,
  createCipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import {
  createDatabase,
  Prisma,
  PrismaClient,
  withPlatform,
  withTenant,
} from "@logistics/db";
import { isRequestOriginAllowed, loadConfig } from "@logistics/config";
import { portalHome, type SessionActor } from "@logistics/auth";
import type { TenantCreateInput } from "@logistics/domain";
import { sealOwnerInvitationToken } from "./invitation-token-envelope.js";

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
  private readonly logger = new Logger(AppService.name);
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
        "202608240003_fnd02_identity_access",
        "202608250004_module_kernel",
        "202608250006_intelligence_modules",
        "202608250007_all_feature_canonical",
        "202608250008_all_feature_gap_repairs",
        "202608250009_alert_tenant_root_fallback",
        "202608250010_fnd01_postal_localities",
        "202608250011_fnd01_postal_directory_hardening",
        "202608250012_fnd01_postal_importer_identity",
        "202608250013_fnd01_postal_importer_fk_privilege",
        "202608250014_fnd01_postal_importer_table_privileges",
        "202608250015_fnd01_postal_runtime_lock_privilege",
        "202608250016_fnd01_postal_owner_handoff_contract",
        "202608250017_mst01_operable_masters",
        "202608250018_mst01_ownership_export",
        "202608250019_mst01_scope_provenance",
        "202608250020_mst01_scope_backfill_correction",
        "202608250021_mst01_exception_scope_reconciliation",
        "202608250022_access_master_ux",
        "202608250023_operations_workbench",
        "202608250024_finance_workbenches",
        "202608250025_password_recovery",
        "202608250026_owner_invitation_email_delivery",
      ];
      if (
        !required.every((name) =>
          migrations.some((m) => m.migration_name === name),
        )
      )
        throw new Error("Required migration is missing");
      const postalVersions = await this.db.$queryRawUnsafe<Array<Row>>(
        `SELECT v.version,v.source_name AS "sourceName",v.row_count AS "declaredRows",count(l.id)::int AS "actualRows"
         FROM postal_reference.postal_directory_versions v
         LEFT JOIN postal_reference.postal_localities l ON l.directory_version_id=v.id AND l.active
         WHERE v.country='IN' AND v.status='ACTIVE' AND v.active
         GROUP BY v.id`,
      );
      const postal = postalVersions[0];
      if (
        !postal ||
        Number(postal.declaredRows) !== Number(postal.actualRows) ||
        Number(postal.actualRows) < 1
      )
        throw new Error("Active postal directory is incomplete");
      if (
        this.config.APP_ENV === "production" &&
        (Number(postal.actualRows) < 100000 ||
          /fixture|sample|demo|bootstrap/i.test(
            `${String(postal.version)} ${String(postal.sourceName)}`,
          ))
      )
        throw new Error("Production postal directory is not ready");
      const ownership = await this.db.$queryRawUnsafe<Array<Row>>(
        `SELECT
          (SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='postal_reference') AS "schemaOwner",
          (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='postal_reference' AND c.relname IN ('postal_directory_versions','postal_localities') AND r.rolname='logistics_postal_owner') AS "ownedTables",
          (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='postal_reference' AND p.proname='guard_postal_directory_mutation' AND r.rolname='logistics_postal_owner') AS "ownedGuard",
          (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='postal_reference' AND NOT t.tgisinternal AND t.tgname IN ('postal_directory_versions_import_only','postal_localities_import_only') AND t.tgenabled='O') AS "enabledGuards"`,
      );
      if (
        ownership[0]?.schemaOwner !== "logistics_postal_owner" ||
        Number(ownership[0]?.ownedTables) !== 2 ||
        Number(ownership[0]?.ownedGuard) !== 1 ||
        Number(ownership[0]?.enabledGuards) !== 2
      )
        throw new Error("Postal ownership handoff is incomplete");
      return {
        status: "ready",
        database: "connected",
        migration: "ready",
        migrationCount: migrations.length,
        latestMigration: migrations.at(-1)?.migration_name,
      };
    } catch (error) {
      this.logger.error(
        "Readiness dependency check failed",
        error instanceof Error ? error.stack : undefined,
      );
      throw new AppError(
        503,
        "NOT_READY",
        "Database dependency is unavailable",
      );
    }
  }

  async session(
    sessionToken?: string,
    allowRestricted = false,
  ): Promise<SessionActor & { sessionId: string }> {
    if (!sessionToken)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    const rows = await withPlatform(this.db, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `
      SELECT s.id AS "sessionId",u.id AS "userId",coalesce(u.email,u.mobile_e164) AS email,u.is_platform_admin AS "platformAdmin",s.active_tenant_id AS "activeTenantId",s.context_version AS "contextVersion",s.csrf_hash AS "csrfHash",
        s.user_auth_version AS "sessionUserVersion",u.auth_version AS "userAuthVersion",s.membership_id AS "membershipId",s.membership_auth_version AS "sessionMembershipVersion",m.authorization_version AS "membershipAuthVersion",
        u.status AS "userStatus",m.status AS "membershipStatus",t.status AS "tenantStatus",s.assurance_level AS "assuranceLevel",s.revoked_at AS "revokedAt",s.revoked_reason AS "revokedReason",s.expires_at AS "expiresAt"
      FROM app.sessions s JOIN app.users u ON u.id=s.user_id
      LEFT JOIN app.tenants t ON t.id=s.active_tenant_id
      LEFT JOIN app.tenant_memberships m ON m.id=s.membership_id AND m.tenant_id=s.active_tenant_id
      WHERE s.token_hash=$1`,
        hash(sessionToken),
      ),
    );
    const row = rows[0];
    if (!row)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    if (row.revokedAt || new Date(String(row.expiresAt)) <= new Date()) {
      const changedReasons = new Set([
        "ACCESS_CHANGED",
        "MEMBERSHIP_SUSPENDED",
        "MEMBERSHIP_REACTIVATED",
        "ADMIN_RESET",
        "TRIP_REASSIGNED",
        "TENANT_DEACTIVATED",
        "MFA_COMPLETED",
        "MFA_RESET",
        "PASSWORD_RESET",
      ]);
      throw new AppError(
        401,
        changedReasons.has(String(row.revokedReason))
          ? "SESSION_STALE"
          : "UNAUTHENTICATED",
        changedReasons.has(String(row.revokedReason))
          ? "Your access changed; sign in again"
          : "Authentication required",
      );
    }
    const stale =
      row.userStatus !== "ACTIVE" ||
      Number(row.sessionUserVersion) !== Number(row.userAuthVersion) ||
      (row.activeTenantId !== null &&
        (row.tenantStatus !== "ACTIVE" ||
          row.membershipStatus !== "ACTIVE" ||
          Number(row.sessionMembershipVersion) !==
            Number(row.membershipAuthVersion)));
    if (stale)
      throw new AppError(
        401,
        "SESSION_STALE",
        "Your access changed; sign in again",
      );
    if (row.assuranceLevel === "RESTRICTED_MFA" && !allowRestricted)
      throw new AppError(
        401,
        "MFA_REQUIRED",
        "Complete multi-factor authentication",
      );
    return {
      sessionId: String(row.sessionId),
      userId: String(row.userId),
      email: String(row.email),
      platformAdmin: Boolean(row.platformAdmin),
      activeTenantId: row.activeTenantId ? String(row.activeTenantId) : null,
      contextVersion: Number(row.contextVersion),
      csrfToken: String(row.csrfHash),
      membershipId: row.membershipId ? String(row.membershipId) : null,
      userAuthVersion: Number(row.userAuthVersion),
      membershipAuthVersion:
        row.membershipAuthVersion === null
          ? null
          : Number(row.membershipAuthVersion),
      assuranceLevel:
        row.assuranceLevel === "MFA"
          ? "MFA"
          : row.assuranceLevel === "RESTRICTED_MFA"
            ? "RESTRICTED_MFA"
            : "PASSWORD",
    };
  }

  requireCsrf(actor: SessionActor, csrf?: string, origin?: string) {
    if (!csrf || hash(csrf) !== actor.csrfToken)
      throw new AppError(403, "CSRF_INVALID", "Request could not be verified");
    if (origin && !isRequestOriginAllowed(origin, this.config))
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

  async newSession(
    tx: Tx,
    userId: string,
    activeTenantId: string | null,
    previousContext = 0,
    assuranceLevel: "PASSWORD" | "MFA" | "RESTRICTED_MFA" = "PASSWORD",
  ) {
    const sessionToken = token(),
      csrf = token();
    const snapshots = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT u.auth_version AS "userVersion",m.id AS "membershipId",m.authorization_version AS "membershipVersion"
       FROM app.users u LEFT JOIN app.tenant_memberships m ON m.user_id=u.id AND m.tenant_id=$2::uuid AND m.status='ACTIVE'
       WHERE u.id=$1::uuid`,
      userId,
      activeTenantId,
    );
    const snapshot = one(snapshots);
    if (activeTenantId && !snapshot.membershipId)
      throw new AppError(
        401,
        "SESSION_STALE",
        "Tenant membership is not active",
      );
    await tx.$executeRawUnsafe(
      `INSERT INTO app.sessions(token_hash,csrf_hash,user_id,active_tenant_id,context_version,expires_at,user_auth_version,membership_id,membership_auth_version,assurance_level,mfa_satisfied_at) VALUES($1,$2,$3::uuid,$4::uuid,$5,now()+($6||' hours')::interval,$7,$8::uuid,$9,$10,CASE WHEN $10='MFA' THEN now() END)`,
      hash(sessionToken),
      hash(csrf),
      userId,
      activeTenantId,
      previousContext + 1,
      String(this.config.SESSION_TTL_HOURS),
      Number(snapshot.userVersion),
      snapshot.membershipId ?? null,
      snapshot.membershipVersion ?? null,
      assuranceLevel,
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

  private requireIdempotencyKey(value: string) {
    if (!value || value.length < 8 || value.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
  }

  private async platformMutationReplay(
    tx: Tx,
    actorId: string,
    operation: string,
    keyHash: string,
    requestHash: string,
  ) {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${actorId}:${operation}:${keyHash}`,
    );
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT request_hash AS "requestHash",response_json AS response FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
      actorId,
      operation,
      keyHash,
    );
    if (!rows[0]) return undefined;
    if (rows[0].requestHash !== requestHash)
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was used for different input",
      );
    return rows[0].response as Row;
  }

  private async storePlatformMutation(
    tx: Tx,
    actorId: string,
    operation: string,
    keyHash: string,
    requestHash: string,
    resourceId: string,
    response: Row,
    persistedResponse: Row = response,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('PLATFORM',$1::uuid,$2,$3,$4,$5::uuid,$6::jsonb)`,
      actorId,
      operation,
      keyHash,
      requestHash,
      resourceId,
      JSON.stringify(persistedResponse),
    );
  }

  private async verifyPlatformPassword(
    tx: Tx,
    actor: SessionActor,
    currentPassword: string,
  ) {
    const credentials = one(
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT password_hash AS "passwordHash" FROM app.users WHERE id=$1::uuid AND status='ACTIVE' AND is_platform_admin`,
        actor.userId,
      ),
    );
    if (
      !(await argon2.verify(String(credentials.passwordHash), currentPassword))
    )
      throw new AppError(
        403,
        "STEP_UP_FAILED",
        "Current Platform Admin password is incorrect",
      );
  }

  private async requireProtectedActionCapacity(
    tx: Tx,
    actor: SessionActor,
    tenantId: string,
    eventType: string,
  ) {
    const recent = one(
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int count FROM app.security_events WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND event_type=$3 AND occurred_at>now()-interval '15 minutes'`,
        tenantId,
        actor.userId,
        eventType,
      ),
    );
    if (Number(recent.count) >= 10)
      throw new AppError(
        429,
        "PROTECTED_ACTION_THROTTLED",
        "Too many protected-action attempts; retry later",
      );
  }

  private async recordPlatformProtectedOutcome(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
    eventType: string,
    outcome: "SUCCEEDED" | "DENIED",
    correlationId: string,
    reason: string,
    errorCode?: string,
  ) {
    try {
      await withPlatform(this.db, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id) VALUES($1::uuid,$2::uuid,(SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$3::uuid),$4,$5,$6,$7::jsonb,$8)`,
          tenantId,
          actor.userId,
          membershipId,
          eventType,
          outcome,
          hash(membershipId).slice(0, 24),
          JSON.stringify({ errorCode: errorCode ?? null }),
          correlationId,
        );
        await this.audit(tx, {
          tenantId,
          actorId: actor.userId,
          action:
            outcome === "SUCCEEDED"
              ? `${eventType.toLowerCase()}.succeeded`
              : `${eventType.toLowerCase()}.denied`,
          targetType: "tenant_membership",
          targetId: membershipId,
          correlationId,
          reason,
          after: { outcome, errorCode: errorCode ?? null },
        });
      });
    } catch (recordingError) {
      this.logger.warn(
        `Protected-action outcome recording failed: ${recordingError instanceof Error ? recordingError.message : "unknown"}`,
      );
    }
  }

  async login(
    identifier: string,
    password: string,
    tenantCode: string | undefined,
    correlationId: string,
  ) {
    const normalized = identifier.trim().toLowerCase();
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
        `SELECT id,email,mobile_e164 AS mobile,display_name AS "displayName",password_hash AS "passwordHash",is_platform_admin AS "platformAdmin" FROM app.users WHERE (email=$1 OR mobile_e164=$1) AND status='ACTIVE'`,
        normalized,
      );
      const user = users[0];
      if (
        !user ||
        !(await argon2.verify(String(user.passwordHash), password))
      ) {
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.login_attempts(identity_hash,window_start) VALUES($1,date_trunc('minute',now())) ON CONFLICT(identity_hash,window_start) DO UPDATE SET attempts=app.login_attempts.attempts+1,updated_at=now() RETURNING attempts,window_start AS "windowStart"`,
          identityHash,
        );
        const updatedAttempts = Number(
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT COALESCE(sum(attempts),0)::int count FROM app.login_attempts WHERE identity_hash=$1 AND window_start>now()-interval '15 minutes'`,
              identityHash,
            )
          )[0]?.count ?? 0,
        );
        if (user) {
          const memberships = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT tenant_id AS "tenantId",id FROM app.tenant_memberships WHERE user_id=$1::uuid AND status='ACTIVE'`,
            String(user.id),
          );
          for (const membership of memberships) {
            await tx.$executeRawUnsafe(
              `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id)
               VALUES($1::uuid,$2::uuid,$3::uuid,'LOGIN_FAILED','DENIED',$4,$5::jsonb,$6)`,
              membership.tenantId,
              user.id,
              membership.id,
              identityHash.slice(0, 24),
              JSON.stringify({
                attempt: updatedAttempts,
              }),
              correlationId,
            );
            if (updatedAttempts >= 5)
              await tx.$executeRawUnsafe(
                `INSERT INTO app.security_alerts(tenant_id,alert_type,severity,deduplication_key,user_id,membership_id)
                 VALUES($1::uuid,'REPEATED_LOGIN_FAILURES','HIGH',$2,$3::uuid,$4::uuid)
                 ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET occurrence_count=app.security_alerts.occurrence_count+1,last_seen_at=now(),updated_at=now()`,
                membership.tenantId,
                `login:${identityHash}`,
                user.id,
                membership.id,
              );
          }
        }
        return { invalidCredentials: true } as const;
      }
      let activeTenantId: string | null = null;
      let home = "/platform/tenants";
      let mfaRequired = false;
      let mfaEnrolled = false;
      if (!Boolean(user.platformAdmin)) {
        const memberships = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT t.id,t.code,t.name,m.portal_audience AS "portalAudience" FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.user_id=$1::uuid AND m.status='ACTIVE' AND t.status='ACTIVE' ORDER BY t.name`,
          String(user.id),
        );
        const chosen = tenantCode
          ? memberships.find((m) => m.code === tenantCode)
          : memberships.length === 1
            ? memberships[0]
            : undefined;
        if (memberships.length === 0)
          return { invalidCredentials: true } as const;
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
        const audience = String(chosen?.portalAudience ?? "INTERNAL") as
          | "INTERNAL"
          | "VENDOR"
          | "DRIVER"
          | "CLIENT";
        home = audience === "INTERNAL" ? "/app" : portalHome(audience);
        if (activeTenantId) {
          const mfa = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT coalesce((SELECT value->>'mfaPolicy' FROM app.tenant_configuration WHERE tenant_id=$1::uuid AND namespace='security'),'OFF') policy,
              EXISTS(SELECT 1 FROM app.tenant_memberships m JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE m.tenant_id=$1::uuid AND m.user_id=$2::uuid AND r.privilege_level IN ('PRIVILEGED','PROTECTED')) privileged,
              EXISTS(SELECT 1 FROM app.mfa_factors f WHERE f.user_id=$2::uuid AND f.verified_at IS NOT NULL AND f.disabled_at IS NULL) enrolled`,
            activeTenantId,
            String(user.id),
          );
          const policy = String(mfa[0]?.policy ?? "OFF");
          const privileged = Boolean(mfa[0]?.privileged);
          mfaRequired =
            policy === "ALL" || (policy === "PRIVILEGED" && privileged);
          mfaEnrolled = Boolean(mfa[0]?.enrolled);
        }
      }
      const created = await this.newSession(
        tx,
        String(user.id),
        activeTenantId,
        0,
        mfaRequired ? "RESTRICTED_MFA" : "PASSWORD",
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.users SET last_login_at=now(),updated_at=now() WHERE id=$1::uuid`,
        String(user.id),
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
        home,
        mfaRequired,
        mfaEnrolled,
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

  private sealRecoveryToken(value: string) {
    const key = createHash("sha256")
      .update(this.config.MFA_ENCRYPTION_KEY || this.config.AUTH_SECRET)
      .digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [nonce, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  async requestPasswordReset(
    identifier: string,
    tenantCode: string | undefined,
    connectionSource: string,
    correlationId: string,
  ) {
    const startedAt = Date.now();
    const normalized = identifier.trim().toLowerCase();
    const hmacKey = (scope: string, value: string) =>
      createHmac("sha256", this.config.AUTH_SECRET)
        .update(`password-reset\0${scope}\0${value}`)
        .digest("hex");
    const source =
      connectionSource.trim().toLowerCase().slice(0, 256) || "unknown";
    const globalKey = hmacKey("global", "all");
    const sourceKey = hmacKey("source", source);
    const identifierKey = hmacKey(
      "identifier",
      `${normalized}\0${tenantCode ?? ""}`,
    );
    try {
      await withPlatform(this.db, async (tx) => {
        const consumeBucket = async (
          bucketKind: "GLOBAL" | "SOURCE" | "IDENTIFIER",
          keyHash: string,
        ) => {
          const current = one(
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.password_reset_request_limits(
                 bucket_kind,key_hash,window_start
               ) VALUES($1,$2,date_trunc('minute',now()))
               ON CONFLICT(bucket_kind,key_hash,window_start) DO UPDATE
               SET attempts=app.password_reset_request_limits.attempts+1,
                   updated_at=now()
               RETURNING attempts`,
              bucketKind,
              keyHash,
            ),
          );
          const recent = one(
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT coalesce(sum(attempts),0)::int attempts
               FROM app.password_reset_request_limits
               WHERE bucket_kind=$1 AND key_hash=$2
                 AND window_start>now()-interval '15 minutes'`,
              bucketKind,
              keyHash,
            ),
          );
          return {
            current: Number(current.attempts),
            recent: Number(recent.attempts),
          };
        };

        const global = await consumeBucket("GLOBAL", globalKey);
        // Once per global minute bucket, remove only a bounded stale batch. The
        // cleanup index supports a separate maintenance job for larger backlogs.
        if (global.current === 1)
          await tx.$executeRawUnsafe(
            `WITH stale AS (
               SELECT ctid FROM app.password_reset_request_limits
               WHERE window_start<now()-interval '1 day'
               ORDER BY window_start LIMIT 500
             )
             DELETE FROM app.password_reset_request_limits target
             USING stale WHERE target.ctid=stale.ctid`,
          );
        if (global.recent > 300) return;

        const sourceBucket = await consumeBucket("SOURCE", sourceKey);
        if (sourceBucket.recent > 20) return;

        const identifierBucket = await consumeBucket(
          "IDENTIFIER",
          identifierKey,
        );
        if (identifierBucket.recent > 3) return;

        const candidates = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT u.id AS "userId",u.membership_version AS "membershipVersion",
                m.id AS "membershipId",m.tenant_id AS "tenantId",
                coalesce(u.email,u.mobile_e164) AS destination
         FROM app.users u
         JOIN app.tenant_memberships m ON m.user_id=u.id AND m.status='ACTIVE'
         JOIN app.tenants t ON t.id=m.tenant_id AND t.status='ACTIVE'
         WHERE u.status='ACTIVE' AND (u.email=$1 OR u.mobile_e164=$1)
           AND ($2::text IS NULL OR t.code=$2)
         ORDER BY t.code,m.id LIMIT 1`,
          normalized,
          tenantCode ?? null,
        );
        const candidate = candidates[0];
        if (!candidate) return;
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `password-reset:${candidate.userId}`,
        );
        const recent = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT count(*)::int count FROM app.password_reset_tokens
         WHERE user_id=$1::uuid AND request_source='SELF_SERVICE'
           AND created_at>now()-interval '15 minutes'`,
          candidate.userId,
        );
        if (Number(recent[0]?.count ?? 0) >= 3) return;
        const plainToken = token();
        const created = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.password_reset_tokens(
             tenant_id,membership_id,user_id,user_membership_version,request_source,
             token_hash,token_envelope,expires_at
           ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'SELF_SERVICE',$5,$6,now()+interval '1 hour')
           RETURNING id,expires_at AS "expiresAt"`,
            candidate.tenantId,
            candidate.membershipId,
            candidate.userId,
            candidate.membershipVersion,
            hash(plainToken),
            this.sealRecoveryToken(plainToken),
          ),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(
           tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key,state
         ) VALUES($1::uuid,'TENANT','password_reset',$2::uuid,'identity.password_reset.recorded.v1',$3::jsonb,$4,'RECORDED')`,
          candidate.tenantId,
          created.id,
          JSON.stringify({
            passwordResetId: created.id,
            membershipId: candidate.membershipId,
            expiresAt: created.expiresAt,
            deliveryConfigured: false,
          }),
          `password-reset:${created.id}:recorded:v1`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(
           tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id
         ) VALUES($1::uuid,$2::uuid,$3::uuid,'PASSWORD_RESET_REQUESTED','ACCEPTED',$4,'{}'::jsonb,$5)`,
          candidate.tenantId,
          candidate.userId,
          candidate.membershipId,
          hash(normalized).slice(0, 24),
          correlationId,
        );
        await this.audit(tx, {
          tenantId: String(candidate.tenantId),
          action: "auth.password_reset.requested",
          targetType: "password_reset",
          targetId: String(created.id),
          correlationId,
          after: {
            requestRecorded: true,
            deliveryConfigured: false,
            expiresAt: created.expiresAt,
          },
        });
      });
    } finally {
      const remaining = Math.max(0, 75 - (Date.now() - startedAt));
      if (remaining)
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    return {
      accepted: true,
      message:
        "If eligible, a recovery request was recorded; contact your workspace administrator if delivery is unavailable.",
    };
  }

  async passwordResetPreview(resetToken: string) {
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT r.expires_at AS "expiresAt",t.name AS "tenantName",t.timezone,
                CASE WHEN u.email IS NOT NULL
                  THEN left(u.email,1)||'***@'||split_part(u.email,'@',2)
                  ELSE '+••••••'||right(u.mobile_e164,2) END AS "maskedDestination"
         FROM app.password_reset_tokens r
         JOIN app.users u ON u.id=r.user_id AND u.status='ACTIVE'
         JOIN app.tenant_memberships m ON m.tenant_id=r.tenant_id AND m.id=r.membership_id
           AND m.user_id=r.user_id AND m.status='ACTIVE'
         JOIN app.tenants t ON t.id=r.tenant_id AND t.status='ACTIVE'
         WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.revoked_at IS NULL
           AND r.expires_at>now()
           AND (r.request_source='SELF_SERVICE' OR (
             r.user_membership_version=u.membership_version AND (
               SELECT count(*) FROM app.tenant_memberships active_membership
               JOIN app.tenants active_tenant ON active_tenant.id=active_membership.tenant_id
                 AND active_tenant.status='ACTIVE'
               WHERE active_membership.user_id=r.user_id
                 AND active_membership.status='ACTIVE'
             )=1
           ))`,
        hash(resetToken),
      );
      if (!rows[0])
        throw new AppError(
          404,
          "PASSWORD_RESET_INVALID",
          "Password reset link is invalid or expired",
        );
      return rows[0];
    });
  }

  async completePasswordReset(
    resetToken: string,
    password: string,
    correlationId: string,
  ) {
    return withPlatform(this.db, async (tx) => {
      const candidate = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT user_id AS "userId" FROM app.password_reset_tokens WHERE token_hash=$1`,
          hash(resetToken),
        )
      )[0];
      if (!candidate)
        throw new AppError(
          404,
          "PASSWORD_RESET_INVALID",
          "Password reset link is invalid or expired",
        );
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `password-reset:${candidate.userId}`,
      );
      const resets = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT r.id,r.tenant_id AS "tenantId",r.membership_id AS "membershipId",r.user_id AS "userId"
         FROM app.password_reset_tokens r
         JOIN app.users u ON u.id=r.user_id AND u.status='ACTIVE'
         JOIN app.tenant_memberships m ON m.tenant_id=r.tenant_id AND m.id=r.membership_id
           AND m.user_id=r.user_id AND m.status='ACTIVE'
         JOIN app.tenants t ON t.id=r.tenant_id AND t.status='ACTIVE'
         WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.revoked_at IS NULL
           AND r.expires_at>now()
           AND (r.request_source='SELF_SERVICE' OR (
             r.user_membership_version=u.membership_version AND (
               SELECT count(*) FROM app.tenant_memberships active_membership
               JOIN app.tenants active_tenant ON active_tenant.id=active_membership.tenant_id
                 AND active_tenant.status='ACTIVE'
               WHERE active_membership.user_id=r.user_id
                 AND active_membership.status='ACTIVE'
             )=1
           ))
         FOR UPDATE OF r,u`,
        hash(resetToken),
      );
      const reset = resets[0];
      if (!reset)
        throw new AppError(
          404,
          "PASSWORD_RESET_INVALID",
          "Password reset link is invalid or expired",
        );
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
      });
      await tx.$executeRawUnsafe(
        `UPDATE app.users SET password_hash=$1,auth_version=auth_version+1,
           credentials_changed_at=now(),updated_at=now(),version=version+1
         WHERE id=$2::uuid`,
        passwordHash,
        reset.userId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.password_reset_tokens
         SET used_at=CASE WHEN id=$1::uuid THEN now() ELSE used_at END,
             revoked_at=CASE WHEN id<>$1::uuid THEN coalesce(revoked_at,now()) ELSE revoked_at END,
             token_envelope=NULL,updated_at=now(),version=version+1
         WHERE user_id=$2::uuid AND used_at IS NULL`,
        reset.id,
        reset.userId,
      );
      const sessions = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.sessions SET revoked_at=now(),revoked_reason='PASSWORD_RESET',
           updated_at=now(),version=version+1
         WHERE user_id=$1::uuid AND revoked_at IS NULL RETURNING id`,
        reset.userId,
      );
      const affectedMemberships = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT m.id AS "membershipId",m.tenant_id AS "tenantId"
         FROM app.tenant_memberships m
         JOIN app.tenants t ON t.id=m.tenant_id AND t.status='ACTIVE'
         WHERE m.user_id=$1::uuid AND m.status='ACTIVE'
         ORDER BY m.tenant_id,m.id`,
        reset.userId,
      );
      for (const membership of affectedMemberships) {
        const safeMetadata = {
          revokedSessions: sessions.length,
          affectedMemberships: affectedMemberships.length,
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(
             tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id
           ) VALUES($1::uuid,$2::uuid,$3::uuid,'PASSWORD_RESET_COMPLETED','SUCCEEDED',$4,$5::jsonb,$6)`,
          membership.tenantId,
          reset.userId,
          membership.membershipId,
          hash(String(reset.id)).slice(0, 24),
          JSON.stringify(safeMetadata),
          correlationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(
             tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key
           ) VALUES($1::uuid,'TENANT','user',$2::uuid,'identity.password.changed.v1',$3::jsonb,$4)`,
          membership.tenantId,
          reset.userId,
          JSON.stringify({
            userId: reset.userId,
            membershipId: membership.membershipId,
            ...safeMetadata,
          }),
          `password-reset:${reset.id}:${membership.membershipId}:completed:v1`,
        );
        await this.audit(tx, {
          tenantId: String(membership.tenantId),
          actorId: String(reset.userId),
          action: "auth.password_reset.completed",
          targetType: "user",
          targetId: String(reset.userId),
          correlationId,
          after: safeMetadata,
        });
      }
      return {
        ok: true,
        revokedSessions: sessions.length,
        affectedMemberships: affectedMemberships.length,
      };
    });
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
        `SELECT t.id,t.code,t.name,t.short_name AS "shortName",t.primary_color AS "primaryColor",t.accent_color AS "accentColor",m.id AS "membershipId",m.portal_audience AS "portalAudience" FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.user_id=$1::uuid AND m.status='ACTIVE' AND t.status='ACTIVE' ORDER BY t.name`,
        actor.userId,
      );
      const activeMembership = rows.find(
        (row) => String(row.membershipId) === String(actor.membershipId),
      );
      return {
        user: {
          id: actor.userId,
          email: actor.email,
          platformAdmin: actor.platformAdmin,
        },
        activeTenantId: actor.activeTenantId,
        home: actor.platformAdmin
          ? "/platform/tenants"
          : String(activeMembership?.portalAudience ?? "INTERNAL") ===
              "INTERNAL"
            ? "/app"
            : portalHome(
                String(activeMembership?.portalAudience) as
                  | "VENDOR"
                  | "DRIVER"
                  | "CLIENT",
              ),
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
          `SELECT set_config('app.actor_user_id',$1,true),set_config('app.correlation_id',$2,true)`,
          actor.userId,
          correlationId,
        );
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
        const postalRows = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT l.id,l.country,l.postal_code AS "postalCode",l.locality_name AS locality,l.district_name AS district,l.city_name AS city,l.region_name AS region,v.id AS "directoryVersionId",v.version AS "directoryVersion"
           FROM postal_reference.postal_localities l
           JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id AND v.active AND v.status='ACTIVE'
           WHERE l.id=$1::uuid AND l.active AND l.country=$2 AND l.postal_code=$3`,
          input.address.postalLocalityId,
          input.address.country,
          input.address.postalCode,
        );
        if (!postalRows[0])
          throw new AppError(
            409,
            "POSTAL_REFERENCE_CHANGED",
            "The selected locality is no longer valid for this PIN code. Look it up again.",
            {
              "address.postalLocalityId": [
                "Select a current locality for this PIN code",
              ],
            },
          );
        const postal = postalRows[0];
        const canonicalAddress = {
          line1: input.address.line1,
          line2: input.address.line2,
          country: String(postal.country).trim(),
          postalCode: postal.postalCode,
          postalLocalityId: postal.id,
          locality: postal.locality,
          city: postal.city,
          region: postal.region,
          district: postal.district,
          directoryVersionId: postal.directoryVersionId,
          directoryVersion: postal.directoryVersion,
          postalReferenceStatus: "DIRECTORY",
        };
        let tenantRows: Array<Row>;
        try {
          tenantRows = await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.tenants(code,name,legal_name,tax_identifier,address,timezone,locale,currency,fiscal_month,fiscal_day,support_name,support_email,support_mobile,short_name,primary_color,accent_color,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id,code,name,status,version`,
            input.code,
            input.name,
            input.legalName,
            input.taxIdentifier,
            JSON.stringify(canonicalAddress),
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
        const tenantScope = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name)
             VALUES($1::uuid,'TENANT','TENANT','Entire tenant') RETURNING id`,
            tenantId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.legal_entities(tenant_id,code,name,tax_identifier,is_default) VALUES($1::uuid,$2,$3,$4,true)`,
          tenantId,
          input.legalEntity.code,
          input.legalEntity.name,
          input.legalEntity.taxIdentifier ?? input.taxIdentifier,
        );
        const legalEntityScope = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id)
             VALUES($1::uuid,'LEGAL_ENTITY',$2,$3,$4::uuid) RETURNING id`,
            tenantId,
            input.legalEntity.code,
            input.legalEntity.name,
            tenantScope.id,
          )
        )[0]!;
        const organizationAddress = [
          canonicalAddress.line1,
          canonicalAddress.line2,
          canonicalAddress.locality,
          canonicalAddress.city,
          canonicalAddress.district,
          canonicalAddress.region,
          canonicalAddress.postalCode,
          canonicalAddress.country,
        ]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join(", ");
        const legalEntityNode = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.organization_nodes(
               tenant_id,code,name,node_type,authorization_scope_node_id,timezone,address,
               postal_codes,active_from,state,created_by
             ) VALUES(
               $1::uuid,$2,$3,'LEGAL_ENTITY',$4::uuid,$5,$6,ARRAY[$7]::text[],
               (now() AT TIME ZONE $5)::date,'ACTIVE',$8::uuid
             ) RETURNING id`,
            tenantId,
            input.legalEntity.code,
            input.legalEntity.name,
            legalEntityScope.id,
            input.timezone,
            organizationAddress,
            String(canonicalAddress.postalCode),
            actor.userId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
           VALUES($1::uuid,$2::uuid,$2::uuid,0)`,
          tenantId,
          legalEntityNode.id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE app.authorization_scope_nodes
           SET canonical_resource_id=$1::uuid,updated_at=now(),version=version+1
           WHERE tenant_id=$2::uuid AND id=$3::uuid`,
          legalEntityNode.id,
          tenantId,
          legalEntityScope.id,
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
            `INSERT INTO app.setup_checklist_items(
               tenant_id,key,label,display_order,state,completed_by,completed_at
             ) VALUES(
               $1::uuid,$2,$3,$4,$5,
               CASE WHEN $5='COMPLETE' THEN $6::uuid ELSE NULL END,
               CASE WHEN $5='COMPLETE' THEN now() ELSE NULL END
             )`,
            tenantId,
            keys[i]![0],
            keys[i]![1],
            i + 1,
            keys[i]![0] === "organization" || keys[i]![0] === "branding"
              ? "COMPLETE"
              : "NOT_STARTED",
            actor.userId,
          );
        const membershipRows = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.tenant_memberships(tenant_id,invited_email,invited_name,employee_code,role,status) VALUES($1::uuid,$2,$3,$4,'TENANT_OWNER','INVITED') RETURNING id`,
          tenantId,
          input.owner.email,
          input.owner.name,
          `OWNER-${input.code}`.slice(0, 30),
        );
        const ownerMembershipId = String(membershipRows[0]!.id);
        const ownerRole = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.roles(tenant_id,code,name,description,portal_audiences,privilege_level,protected) VALUES($1::uuid,'TENANT_OWNER','Tenant Owner','Protected tenant administrator',ARRAY['INTERNAL']::text[],'PROTECTED',true) RETURNING id`,
            tenantId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code) SELECT $1::uuid,$2::uuid,code FROM app.capability_catalog WHERE active`,
          tenantId,
          ownerRole.id,
        );
        const ownerAssignment = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            tenantId,
            ownerMembershipId,
            ownerRole.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action) VALUES($1::uuid,$2::uuid,$3::uuid,'ADMIN')`,
          tenantId,
          ownerAssignment.id,
          tenantScope.id,
        );
        await tx.$executeRawUnsafe(
          `WITH templates(code,name,audience,level) AS (VALUES
            ('MIS_EXECUTIVE','MIS Executive','INTERNAL','STANDARD'),
            ('REGIONAL_MANAGER','Regional Manager','INTERNAL','STANDARD'),
            ('KEY_ACCOUNT_MANAGER','Key Account Manager','INTERNAL','STANDARD'),
            ('TRAFFIC_PLACEMENT_EXECUTIVE','Traffic / Placement Executive','INTERNAL','STANDARD'),
            ('FINANCE_EXECUTIVE','Finance Executive','INTERNAL','PRIVILEGED'),
            ('COLLECTION_EXECUTIVE','Collection Executive','INTERNAL','PRIVILEGED'),
            ('LOADING_EXECUTIVE','Loading Executive','INTERNAL','STANDARD'),
            ('UNLOADING_EXECUTIVE','Unloading Executive','INTERNAL','STANDARD'),
            ('VENDOR_OWNER','Vendor Owner','VENDOR','STANDARD'),
            ('DRIVER','Driver','DRIVER','STANDARD'),
            ('CLIENT_VIEWER','Client Viewer','CLIENT','STANDARD'),
            ('AUDITOR','Auditor','INTERNAL','PRIVILEGED'))
           INSERT INTO app.roles(tenant_id,code,name,description,portal_audiences,privilege_level)
           SELECT $1::uuid,code,name,'Baseline role template',ARRAY[audience]::text[],level FROM templates`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
           SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
           WHERE r.tenant_id=$1::uuid AND r.code<>'TENANT_OWNER' AND (
             (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('identity.user.read','identity.role.read','identity.report.read','identity.audit.read','probe.read','probe.export'))
             OR (r.code IN ('REGIONAL_MANAGER','KEY_ACCOUNT_MANAGER','TRAFFIC_PLACEMENT_EXECUTIVE') AND c.code IN ('probe.read','probe.create','probe.update','probe.export','masters.read','operations.read','operations.admin','pod.read'))
             OR (r.code IN ('FINANCE_EXECUTIVE','COLLECTION_EXECUTIVE') AND c.code IN ('probe.read','probe.approve','probe.export','sensitive.payment.read','sensitive.bank_detail.read','finance.read','finance.admin','pod.read','governance.read'))
             OR (r.code IN ('LOADING_EXECUTIVE','UNLOADING_EXECUTIVE') AND c.code IN ('probe.read','probe.update','operations.read','operations.admin','pod.read','pod.admin'))
             OR (r.code='VENDOR_OWNER' AND c.code IN ('probe.read','probe.update','sensitive.payment.read','masters.read','operations.read','finance.read','governance.read'))
             OR (r.code='DRIVER' AND c.code IN ('probe.read','probe.update','operations.read','operations.admin','governance.read'))
             OR (r.code='CLIENT_VIEWER' AND c.code IN ('probe.read','operations.read','pod.read','finance.read','governance.read'))
             OR (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('masters.read','operations.read','pod.read','finance.read','governance.read','configuration.read')))
           ON CONFLICT DO NOTHING`,
          tenantId,
        );
        const inviteToken = token(),
          expiresAt = new Date(
            Date.now() + this.config.INVITATION_TTL_HOURS * 3600000,
          );
        const inviteRows = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.owner_invitations(tenant_id,membership_id,email,token_hash,expires_at,delivery_state) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) RETURNING id`,
          tenantId,
          ownerMembershipId,
          input.owner.email,
          hash(inviteToken),
          expiresAt,
          "PENDING_DELIVERY",
        );
        if (injectFailure && this.config.ENABLE_TEST_HOOKS === "true")
          throw new Error("Injected provisioning failure");
        const inviteId = String(inviteRows[0]!.id);
        const secretEnvelope = sealOwnerInvitationToken(
          {
            tenantId,
            invitationId: inviteId,
            token: inviteToken,
            expiresAt: expiresAt.toISOString(),
          },
          this.config.EMAIL_TOKEN_ENCRYPTION_KEY,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key,state,processed_at) VALUES($1::uuid,'TENANT','owner_invitation',$2::uuid,'owner_invitation.requested.v1',$3::jsonb,$4,'PENDING',null)`,
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
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.invitation_delivery_attempts(tenant_id,invitation_id,channel,destination_hash,secret_envelope) VALUES($1::uuid,$2::uuid,'EMAIL',$3,$4)`,
          tenantId,
          inviteId,
          hash(input.owner.email.toLowerCase()),
          secretEnvelope,
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
          after: {
            code: input.code,
            status: tenant.status,
            address: canonicalAddress,
          },
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
            state: "PENDING_DELIVERY",
          },
          invitationUrl:
            this.config.ENABLE_TEST_HOOKS === "true"
              ? `${this.config.FRONTEND_URL}/accept-invitation?token=${inviteToken}`
              : undefined,
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

  async postalLocalities(
    actor: SessionActor,
    country: string,
    postalCode: string,
  ) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT l.id,l.country,l.postal_code AS "postalCode",l.locality_name AS locality,l.district_name AS district,l.city_name AS city,l.region_name AS region
         FROM postal_reference.postal_localities l
         JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id AND v.active AND v.status='ACTIVE'
         WHERE l.active AND l.country=$1 AND l.postal_code=$2
         ORDER BY l.locality_name,l.district_name,l.id`,
        country,
        postalCode,
      );
      if (!rows.length)
        throw new AppError(
          404,
          "POSTAL_CODE_NOT_FOUND",
          "This PIN code is not in the postal directory. Check it and try again.",
          { "address.postalCode": ["No locality found for this PIN code"] },
        );
      return { country, postalCode, items: rows };
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
        `SELECT id,email,expires_at AS "expiresAt",delivery_state AS "deliveryState",accepted_at AS "acceptedAt",revoked_at AS "revokedAt",version FROM app.owner_invitations WHERE tenant_id=$1::uuid`,
        id,
      );
      const checklist = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT key,label,state,version,completed_at AS "completedAt" FROM app.setup_checklist_items WHERE tenant_id=$1::uuid ORDER BY display_order,key`,
        id,
      );
      const availableRoles = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name,portal_audiences AS "portalAudiences",privilege_level AS "privilegeLevel" FROM app.roles WHERE tenant_id=$1::uuid AND status='ACTIVE' ORDER BY name,id`,
        id,
      );
      const evidence = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$1::uuid AND state='ACTIVE') organizations,
          (SELECT count(*)::int FROM app.tenant_memberships WHERE tenant_id=$1::uuid) users,
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$1::uuid AND node_type='BRANCH' AND state='ACTIVE') branches,
          (SELECT count(*)::int FROM app.clients WHERE tenant_id=$1::uuid AND state='ACTIVE') clients,
          (SELECT count(*)::int FROM app.vendors WHERE tenant_id=$1::uuid AND state='ACTIVE') vendors,
          (SELECT count(*)::int FROM app.contracts WHERE tenant_id=$1::uuid AND state IN ('APPROVED','PUBLISHED')) commercial,
          (SELECT count(*)::int FROM app.import_jobs WHERE tenant_id=$1::uuid) imports,
          (SELECT count(*)::int FROM app.roles WHERE tenant_id=$1::uuid AND status='ACTIVE') roles`,
          id,
        ),
      );
      const representatives = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,name,node_type AS type,state,version FROM app.organization_nodes WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) organizations,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,employee_code AS code,invited_name AS name,status AS state,version FROM app.tenant_memberships WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) users,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,name,node_type AS type,state,version FROM app.organization_nodes WHERE tenant_id=$1::uuid AND node_type='BRANCH' ORDER BY updated_at DESC,id LIMIT 5) x) branches,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,legal_name AS name,state,version FROM app.clients WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) clients,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,legal_name AS name,state,version FROM app.vendors WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) vendors,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,name,state,version FROM app.contracts WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) commercial,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,dataset AS code,filename AS name,state,version FROM app.import_jobs WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) imports,
          (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT id,code,name,status AS state,version FROM app.roles WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id LIMIT 5) x) roles`,
          id,
        ),
      );
      const setupEvidence = [
        {
          key: "organization",
          label: "Organization nodes",
          count: Number(evidence.organizations),
          records: representatives.organizations,
        },
        {
          key: "users",
          label: "Tenant users",
          count: Number(evidence.users),
          records: representatives.users,
        },
        {
          key: "branches",
          label: "Active branches",
          count: Number(evidence.branches),
          records: representatives.branches,
        },
        {
          key: "clients",
          label: "Active clients",
          count: Number(evidence.clients),
          records: representatives.clients,
        },
        {
          key: "vendors",
          label: "Active vendors",
          count: Number(evidence.vendors),
          records: representatives.vendors,
        },
        {
          key: "commercial",
          label: "Approved/published contracts",
          count: Number(evidence.commercial),
          records: representatives.commercial,
        },
        {
          key: "imports",
          label: "Import jobs",
          count: Number(evidence.imports),
          records: representatives.imports,
        },
        {
          key: "roles",
          label: "Active roles",
          count: Number(evidence.roles),
          records: representatives.roles,
        },
      ];
      return {
        tenant,
        invitations: invites,
        checklist,
        availableRoles,
        setupEvidence,
      };
    });
  }

  private platformUserView(row: Row, actorUserId?: string) {
    const roles = Array.isArray(row.roles) ? row.roles : [];
    const activationStatus = String(row.activationStatus ?? "PENDING");
    const personaApplicable = row.portalAudience !== "INTERNAL";
    const mfaApplicable =
      row.mfaPolicy === "ALL" ||
      (row.mfaPolicy === "PRIVILEGED" && Boolean(row.privilegedRole));
    const checks = {
      profile: Boolean(
        row.displayName &&
          row.employeeCode &&
          row.portalAudience &&
          row.destination,
      ),
      activation: activationStatus === "ACCEPTED",
      access: Boolean(row.accessComplete),
      personaLinkage: personaApplicable ? Boolean(row.personaLinked) : null,
      mfa: mfaApplicable ? Boolean(row.mfaEnabled) : null,
    };
    const applicable = [
      checks.profile,
      checks.activation,
      checks.access,
      ...(checks.personaLinkage === null ? [] : [checks.personaLinkage]),
      ...(checks.mfa === null ? [] : [checks.mfa]),
    ];
    const percent = Math.floor(
      (applicable.filter(Boolean).length * 100) / applicable.length,
    );
    const blocked =
      ["EXPIRED", "REVOKED"].includes(activationStatus) ||
      Boolean(row.audienceConflict) ||
      checks.personaLinkage === false ||
      checks.mfa === false;
    const revealEligible = Boolean(row.destination);
    const passwordResetEligible =
      row.membershipStatus === "ACTIVE" &&
      Boolean(row.userId) &&
      row.userStatus === "ACTIVE" &&
      Number(row.activeIdentityMemberships) === 1 &&
      row.userId !== actorUserId;
    const baseActions =
      row.membershipStatus === "SUSPENDED"
        ? ["EDIT_PROFILE", "REACTIVATE"]
        : row.membershipStatus === "ACTIVE"
          ? ["EDIT_PROFILE", "SUSPEND"]
          : ["EDIT_PROFILE"];
    return {
      id: row.id,
      displayName: row.displayName,
      employeeCode: row.employeeCode,
      portalAudience: row.portalAudience,
      membershipStatus: row.membershipStatus,
      activationStatus,
      destination: row.destination,
      roles,
      onboarding: {
        percent,
        status:
          percent === 100
            ? "COMPLETE"
            : blocked
              ? "BLOCKED"
              : percent === 0
                ? "NOT_STARTED"
                : "IN_PROGRESS",
        checks,
        explanations: {
          profile: "Name, employee code, audience and invitation destination",
          activation: "Invitation accepted with active credentials",
          access: "Effective role and active scope grant",
          personaLinkage: personaApplicable
            ? "Active external persona linkage required"
            : "Not required for this internal audience",
          mfa: mfaApplicable
            ? "Tenant MFA policy requires a verified factor"
            : "Not required by tenant MFA policy",
        },
      },
      lastLoginAt: row.lastLoginAt,
      lastActivityAt: row.lastActivityAt,
      mfaEnabled: Boolean(row.mfaEnabled),
      activeSessions: Number(row.activeSessions ?? 0),
      version: Number(row.version),
      invitationEditable: !row.userId,
      sharedIdentity: Number(row.activeIdentityMemberships) > 1,
      permittedActions: [
        ...baseActions,
        ...(revealEligible ? ["REVEAL_DESTINATION"] : []),
        ...(passwordResetEligible ? ["GENERATE_PASSWORD_RESET"] : []),
      ],
    };
  }

  private platformUserRows(tx: Tx, tenantId: string, membershipId?: string) {
    return tx.$queryRawUnsafe<Array<Row>>(
      `SELECT m.id,m.user_id AS "userId",u.status AS "userStatus",m.invited_name AS "displayName",m.employee_code AS "employeeCode",m.portal_audience AS "portalAudience",m.status AS "membershipStatus",m.version,m.last_activity_at AS "lastActivityAt",concat_ws(' ',m.invited_email,m.invited_mobile) AS "searchDestination",
       CASE WHEN m.invited_email IS NOT NULL THEN regexp_replace(m.invited_email,'^(.).+(@.*)$','\\1***\\2') WHEN m.invited_mobile IS NOT NULL THEN left(m.invited_mobile,3)||'*****'||right(m.invited_mobile,2) END AS destination,
       u.last_login_at AS "lastLoginAt",CASE WHEN m.user_id IS NOT NULL AND u.status='ACTIVE' THEN 'ACCEPTED' WHEN coalesce(oi.revoked_at,ai.revoked_at) IS NOT NULL THEN 'REVOKED' WHEN coalesce(oi.expires_at,ai.expires_at)<=now() THEN 'EXPIRED' ELSE 'PENDING' END AS "activationStatus",
       coalesce((SELECT jsonb_agg(jsonb_build_object('code',r.code,'name',r.name) ORDER BY r.name) FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())),'[]'::jsonb) AS roles,
       EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND g.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())) AS "accessComplete",
       EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND NOT (m.portal_audience=ANY(r.portal_audiences))) AS "audienceConflict",
       EXISTS(SELECT 1 FROM app.mfa_factors f WHERE f.user_id=m.user_id AND f.verified_at IS NOT NULL AND f.disabled_at IS NULL) AS "mfaEnabled",
       coalesce((SELECT value->>'mfaPolicy' FROM app.tenant_configuration c WHERE c.tenant_id=m.tenant_id AND c.namespace='security'),'OFF') AS "mfaPolicy",
       EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND r.privilege_level IN ('PRIVILEGED','PROTECTED') AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())) AS "privilegedRole",
       CASE WHEN m.portal_audience='DRIVER' THEN EXISTS(SELECT 1 FROM app.drivers d WHERE d.tenant_id=m.tenant_id AND d.portal_membership_id=m.id AND d.state='ACTIVE') WHEN m.portal_audience IN ('CLIENT','VENDOR') THEN false ELSE true END AS "personaLinked",
       (SELECT count(*)::int FROM app.sessions s WHERE s.active_tenant_id=m.tenant_id AND s.membership_id=m.id AND s.revoked_at IS NULL AND s.expires_at>now()) AS "activeSessions"
       ,(SELECT count(*)::int FROM app.tenant_memberships am JOIN app.tenants at ON at.id=am.tenant_id AND at.status='ACTIVE' WHERE am.user_id=m.user_id AND am.status='ACTIVE') AS "activeIdentityMemberships"
       FROM app.tenant_memberships m LEFT JOIN app.users u ON u.id=m.user_id LEFT JOIN app.owner_invitations oi ON oi.tenant_id=m.tenant_id AND oi.membership_id=m.id
       LEFT JOIN LATERAL (SELECT expires_at,revoked_at FROM app.access_invitations x WHERE x.tenant_id=m.tenant_id AND x.membership_id=m.id ORDER BY x.created_at DESC LIMIT 1) ai ON true
       WHERE m.tenant_id=$1::uuid AND ($2::uuid IS NULL OR m.id=$2::uuid) ORDER BY m.invited_name,m.id`,
      tenantId,
      membershipId ?? null,
    );
  }

  async platformTenantUsers(
    actor: SessionActor,
    tenantId: string,
    query: {
      search: string;
      membershipStatus?: string;
      activationStatus?: string;
      audience?: string;
      role?: string;
      page: number;
    },
  ) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => {
      const search = query.search.toLowerCase();
      if (
        !(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.tenants WHERE id=$1::uuid`,
            tenantId,
          )
        )[0]
      )
        throw new AppError(404, "NOT_FOUND", "Resource not found");
      const items = (await this.platformUserRows(tx, tenantId))
        .filter(
          (row) =>
            !search ||
            `${row.displayName} ${row.employeeCode} ${row.searchDestination ?? ""}`
              .toLowerCase()
              .includes(search),
        )
        .map((row) => this.platformUserView(row, actor.userId))
        .filter(
          (item) =>
            (!query.membershipStatus ||
              item.membershipStatus === query.membershipStatus) &&
            (!query.activationStatus ||
              item.activationStatus === query.activationStatus) &&
            (!query.audience || item.portalAudience === query.audience) &&
            (!query.role ||
              item.roles.some(
                (role) => String((role as Row).code) === query.role,
              )),
        );
      const pageSize = 25,
        offset = (query.page - 1) * pageSize;
      return {
        items: items.slice(offset, offset + pageSize),
        total: items.length,
        page: query.page,
        pageSize,
      };
    });
  }

  async platformTenantUser(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
  ) {
    this.requirePlatform(actor);
    return withPlatform(this.db, async (tx) => ({
      ...this.platformUserView(
        one(await this.platformUserRows(tx, tenantId, membershipId)),
        actor.userId,
      ),
      activity: await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT event_type AS "eventType",outcome,occurred_at AS "occurredAt" FROM app.security_events WHERE tenant_id=$1::uuid AND membership_id=$2::uuid ORDER BY occurred_at DESC LIMIT 25`,
        tenantId,
        membershipId,
      ),
    }));
  }

  async updatePlatformTenantConfiguration(
    actor: SessionActor,
    tenantId: string,
    input: {
      expectedVersion: number;
      legalName: string;
      timezone: string;
      locale: string;
      currency: string;
      shortName: string;
      primaryColor: string;
      accentColor: string;
      reason: string;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    if (!this.config.SUPPORTED_CURRENCIES.split(",").includes(input.currency))
      throw new AppError(
        400,
        "CURRENCY_UNSUPPORTED",
        "Currency is not supported by this deployment",
      );
    const operation = "platform.tenant.configuration.update",
      keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify({ tenantId, input }));
    return withPlatform(this.db, async (tx) => {
      const replay = await this.platformMutationReplay(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
      );
      if (replay) return replay;
      const before = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,legal_name AS "legalName",timezone,locale,currency,short_name AS "shortName",primary_color AS "primaryColor",accent_color AS "accentColor",version FROM app.tenants WHERE id=$1::uuid FOR UPDATE`,
          tenantId,
        ),
      );
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Tenant configuration changed; reload and retry",
        );
      const updated = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.tenants SET legal_name=$1,timezone=$2,locale=$3,currency=$4,short_name=$5,primary_color=$6,accent_color=$7,updated_at=now(),version=version+1 WHERE id=$8::uuid AND version=$9 RETURNING id,legal_name AS "legalName",timezone,locale,currency,short_name AS "shortName",primary_color AS "primaryColor",accent_color AS "accentColor",version`,
          input.legalName,
          input.timezone,
          input.locale,
          input.currency,
          input.shortName,
          input.primaryColor,
          input.accentColor,
          tenantId,
          input.expectedVersion,
        ),
      );
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action: "tenant.configuration.updated",
        targetType: "tenant",
        targetId: tenantId,
        correlationId,
        reason: input.reason,
        before,
        after: updated,
      });
      await this.storePlatformMutation(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        tenantId,
        updated,
      );
      return updated;
    });
  }

  async updatePlatformMasterRecord(
    actor: SessionActor,
    tenantId: string,
    resourceType: "organization" | "client" | "vendor",
    resourceId: string,
    input: { expectedVersion: number; name: string; reason: string },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    const operation = `platform.master.${resourceType}.update`,
      keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify({ tenantId, resourceId, input }));
    return withPlatform(this.db, async (tx) => {
      const replay = await this.platformMutationReplay(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
      );
      if (replay) return replay;
      let before: Row, updated: Row;
      if (resourceType === "organization") {
        before = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,code,name,state,version FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
            tenantId,
            resourceId,
          ),
        );
        if (Number(before.version) !== input.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Organization record changed; reload and retry",
          );
        updated = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.organization_nodes SET name=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4 RETURNING id,code,name,state,version`,
            input.name,
            tenantId,
            resourceId,
            input.expectedVersion,
          ),
        );
      } else if (resourceType === "client") {
        before = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,code,legal_name AS name,state,version FROM app.clients WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
            tenantId,
            resourceId,
          ),
        );
        if (Number(before.version) !== input.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Client record changed; reload and retry",
          );
        updated = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.clients SET legal_name=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4 RETURNING id,code,legal_name AS name,state,version`,
            input.name,
            tenantId,
            resourceId,
            input.expectedVersion,
          ),
        );
      } else {
        before = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id,code,legal_name AS name,state,version FROM app.vendors WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
            tenantId,
            resourceId,
          ),
        );
        if (Number(before.version) !== input.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Vendor record changed; reload and retry",
          );
        updated = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.vendors SET legal_name=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4 RETURNING id,code,legal_name AS name,state,version`,
            input.name,
            tenantId,
            resourceId,
            input.expectedVersion,
          ),
        );
      }
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action: `master.${resourceType}.updated`,
        targetType: resourceType,
        targetId: resourceId,
        correlationId,
        reason: input.reason,
        before,
        after: updated,
      });
      await this.storePlatformMutation(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        resourceId,
        updated,
      );
      return updated;
    });
  }

  async revealPlatformTenantUserDestination(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
    input: { expectedVersion: number; reason: string; currentPassword: string },
    correlationId: string,
  ) {
    this.requirePlatform(actor);
    const eventType = "PLATFORM_DESTINATION_REVEAL";
    try {
      return await withPlatform(this.db, async (tx) => {
        await this.requireProtectedActionCapacity(
          tx,
          actor,
          tenantId,
          eventType,
        );
        await this.verifyPlatformPassword(tx, actor, input.currentPassword);
        const member = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT m.id,m.version,m.invited_email AS email,CASE WHEN m.invited_email IS NULL THEN m.invited_mobile END AS mobile FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid FOR UPDATE`,
            tenantId,
            membershipId,
          ),
        );
        if (Number(member.version) !== input.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "User changed; reload and retry",
          );
        const type = member.email ? "EMAIL" : member.mobile ? "MOBILE" : null;
        const destination = member.email ?? member.mobile;
        if (!type || !destination)
          throw new AppError(
            409,
            "DESTINATION_NOT_AVAILABLE",
            "This membership has no invitation destination to reveal",
          );
        const revealedUntil = new Date(Date.now() + 60_000).toISOString();
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'SUCCEEDED',$5,$6::jsonb,$7)`,
          tenantId,
          actor.userId,
          membershipId,
          eventType,
          hash(membershipId).slice(0, 24),
          JSON.stringify({ type, revealedUntil }),
          correlationId,
        );
        await this.audit(tx, {
          tenantId,
          actorId: actor.userId,
          action: "tenant_user.destination.revealed",
          targetType: "tenant_membership",
          targetId: membershipId,
          correlationId,
          reason: input.reason,
          after: { type, revealedUntil },
        });
        return { membershipId, type, destination, revealedUntil };
      });
    } catch (error) {
      await this.recordPlatformProtectedOutcome(
        actor,
        tenantId,
        membershipId,
        eventType,
        "DENIED",
        correlationId,
        input.reason,
        error instanceof AppError ? error.code : "INTERNAL_ERROR",
      );
      throw error;
    }
  }

  async invitePlatformTenantUser(
    actor: SessionActor,
    tenantId: string,
    input: {
      displayName: string;
      employeeCode: string;
      email?: string;
      mobile?: string;
      portalAudience: string;
      roleIds: string[];
      expiresInHours: number;
      reason: string;
      tenantWideAccessConfirmed: true;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    const normalizedEmail = input.email?.trim().toLowerCase();
    const operation = "platform.tenant-user.invite",
      keyHash = hash(idempotencyKey),
      requestHash = hash(
        JSON.stringify({
          tenantId,
          input: { ...input, email: normalizedEmail },
        }),
      );
    return withPlatform(this.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.actor_user_id',$1,true),set_config('app.correlation_id',$2,true)`,
        actor.userId,
        correlationId,
      );
      const replay = await this.platformMutationReplay(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
      );
      if (replay) return replay;
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenantId}:invite:${normalizedEmail ?? input.mobile}`,
      );
      const tenant = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,status FROM app.tenants WHERE id=$1::uuid FOR UPDATE`,
          tenantId,
        ),
      );
      if (tenant.status !== "ACTIVE")
        throw new AppError(
          409,
          "TENANT_INACTIVE",
          "Reactivate the tenant before inviting users",
        );
      if (
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND (employee_code=$2 OR ($3::text IS NOT NULL AND lower(invited_email)=$3) OR ($4::text IS NOT NULL AND invited_mobile=$4)) LIMIT 1`,
            tenantId,
            input.employeeCode.toUpperCase(),
            normalizedEmail ?? null,
            input.mobile ?? null,
          )
        )[0]
      )
        throw new AppError(
          409,
          "IDENTITY_ALREADY_MEMBER",
          "Employee code or invitation destination already belongs to this tenant",
        );
      if (
        input.portalAudience === "INTERNAL" &&
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.employees employee WHERE employee.tenant_id=$1::uuid AND (((($3::text IS NOT NULL AND employee.email IS NOT NULL AND lower(trim(employee.email))=lower(trim($3))) OR ($4::text IS NOT NULL AND employee.mobile IS NOT NULL AND regexp_replace(employee.mobile,'[^0-9+]','','g')=regexp_replace($4,'[^0-9+]','','g'))) AND employee.employee_code<>$2) OR (employee.employee_code=$2 AND (employee.state<>'ACTIVE' OR employee.linked_membership_id IS NOT NULL OR ($3::text IS NOT NULL AND (employee.email IS NULL OR lower(trim(employee.email))<>lower(trim($3)))) OR ($4::text IS NOT NULL AND (employee.mobile IS NULL OR regexp_replace(employee.mobile,'[^0-9+]','','g')<>regexp_replace($4,'[^0-9+]','','g')))))) ORDER BY employee.id LIMIT 1 FOR UPDATE`,
            tenantId,
            input.employeeCode.toUpperCase(),
            normalizedEmail ?? null,
            input.mobile ?? null,
          )
        )[0]
      )
        throw new AppError(
          409,
          "EMPLOYEE_LINK_CONFIRMATION_REQUIRED",
          "Employee code or invitation destination conflicts with an existing Employee; reconcile the Employee identity before inviting access",
        );
      const roles = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code,name FROM app.roles WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND status='ACTIVE' AND $3=ANY(portal_audiences)`,
        tenantId,
        input.roleIds,
        input.portalAudience,
      );
      if (roles.length !== new Set(input.roleIds).size)
        throw new AppError(
          400,
          "ROLE_INVALID",
          "Select active roles compatible with the portal audience",
        );
      const root = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT' AND status='ACTIVE'`,
          tenantId,
        ),
      );
      const membership = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.tenant_memberships(tenant_id,invited_email,invited_mobile,invited_name,employee_code,role,portal_audience,status) VALUES($1::uuid,$2,$3,$4,$5,null,$6,'INVITED') RETURNING id,version`,
          tenantId,
          normalizedEmail ?? null,
          input.mobile ?? null,
          input.displayName,
          input.employeeCode.toUpperCase(),
          input.portalAudience,
        ),
      );
      for (const roleId of input.roleIds) {
        const assignment = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            tenantId,
            membership.id,
            roleId,
          ),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action) VALUES($1::uuid,$2::uuid,$3::uuid,'ADMIN')`,
          tenantId,
          assignment.id,
          root.id,
        );
      }
      const plainToken = token(),
        destination = normalizedEmail ?? input.mobile!,
        masked = normalizedEmail
          ? normalizedEmail.replace(/^(.).+(@.*)$/, "$1***$2")
          : `${String(input.mobile).slice(0, 3)}*****${String(input.mobile).slice(-2)}`;
      const invitation = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.access_invitations(tenant_id,membership_id,destination_hash,masked_destination,token_hash,expires_at,delivery_state) VALUES($1::uuid,$2::uuid,$3,$4,$5,now()+($6||' hours')::interval,'PENDING') RETURNING id,expires_at AS "expiresAt",version`,
          tenantId,
          membership.id,
          hash(destination),
          masked,
          hash(plainToken),
          String(input.expiresInHours),
        ),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','access_invitation',$2::uuid,'identity.invitation.requested.v1',$3::jsonb,$4)`,
        tenantId,
        invitation.id,
        JSON.stringify({
          invitationId: invitation.id,
          maskedDestination: masked,
          expiresAt: invitation.expiresAt,
          delivery: "ADMIN_COPY_ONCE",
        }),
        `access-invitation:${invitation.id}:v1`,
      );
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action: "tenant_user.invited",
        targetType: "tenant_membership",
        targetId: String(membership.id),
        correlationId,
        reason: input.reason,
        after: {
          roleIds: input.roleIds,
          maskedDestination: masked,
          portalAudience: input.portalAudience,
        },
      });
      const response = {
        id: String(membership.id),
        membershipId: String(membership.id),
        invitationId: String(invitation.id),
        maskedDestination: masked,
        expiresAt: invitation.expiresAt,
        invitationUrl: `${this.config.FRONTEND_URL}/accept-access?token=${plainToken}`,
        shownOnce: true,
      };
      await this.storePlatformMutation(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        String(membership.id),
        response,
        { ...response, invitationUrl: null },
      );
      return response;
    });
  }

  async issuePlatformTenantUserPasswordReset(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
    input: {
      expectedVersion: number;
      reason: string;
      currentPassword: string;
      expiresInHours: number;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    const operation = "platform.tenant-user.password-reset",
      keyHash = hash(idempotencyKey),
      eventType = "PLATFORM_PASSWORD_RESET_ISSUE";
    try {
      return await withPlatform(this.db, async (tx) => {
        await this.requireProtectedActionCapacity(
          tx,
          actor,
          tenantId,
          eventType,
        );
        await this.verifyPlatformPassword(tx, actor, input.currentPassword);
        const requestHash = hash(
          JSON.stringify({
            tenantId,
            membershipId,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
            expiresInHours: input.expiresInHours,
          }),
        );
        const replay = await this.platformMutationReplay(
          tx,
          actor.userId,
          operation,
          keyHash,
          requestHash,
        );
        if (replay) return replay;
        const discovered = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT user_id AS "userId" FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenantId,
            membershipId,
          ),
        );
        if (!discovered.userId)
          throw new AppError(
            409,
            "PASSWORD_RESET_STATE_INVALID",
            "Password reset is available only after activation",
          );
        if (discovered.userId === actor.userId)
          throw new AppError(
            409,
            "SELF_RESET_NOT_ALLOWED",
            "Use self-service password recovery for your own account",
          );
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `password-reset:${discovered.userId}`,
        );
        const membership = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT m.id,m.user_id AS "userId",m.version,m.status,u.membership_version AS "membershipVersion",CASE WHEN u.email IS NOT NULL THEN left(u.email,1)||'***@'||split_part(u.email,'@',2) ELSE '+••••••'||right(u.mobile_e164,2) END AS "maskedDestination" FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id AND u.status='ACTIVE' WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid FOR UPDATE OF m,u`,
            tenantId,
            membershipId,
          ),
        );
        if (membership.status !== "ACTIVE")
          throw new AppError(
            409,
            "PASSWORD_RESET_STATE_INVALID",
            "Password reset is available only for active users",
          );
        if (Number(membership.version) !== input.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "User changed; reload and retry",
          );
        const active = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT count(*)::int count FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id AND t.status='ACTIVE' WHERE m.user_id=$1::uuid AND m.status='ACTIVE'`,
            membership.userId,
          ),
        );
        if (Number(active.count) !== 1)
          throw new AppError(
            409,
            "SHARED_IDENTITY_SELF_SERVICE_REQUIRED",
            "This identity belongs to multiple workspaces; the user must use self-service password recovery",
          );
        await tx.$executeRawUnsafe(
          `UPDATE app.password_reset_tokens SET revoked_at=now(),token_envelope=NULL,updated_at=now(),version=version+1 WHERE user_id=$1::uuid AND used_at IS NULL AND revoked_at IS NULL`,
          membership.userId,
        );
        const plainToken = token();
        const reset = one(
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.password_reset_tokens(tenant_id,membership_id,user_id,user_membership_version,requested_by,request_source,token_hash,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,'TENANT_ADMIN',$6,now()+($7||' hours')::interval) RETURNING id,expires_at AS "expiresAt"`,
            tenantId,
            membershipId,
            membership.userId,
            membership.membershipVersion,
            actor.userId,
            hash(plainToken),
            String(input.expiresInHours),
          ),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id) VALUES($1::uuid,$2::uuid,$3::uuid,'PASSWORD_RESET_ADMIN_ISSUED','SUCCEEDED',$4,$5::jsonb,$6)`,
          tenantId,
          membership.userId,
          membershipId,
          hash(String(reset.id)).slice(0, 24),
          JSON.stringify({
            requestedBy: actor.userId,
            source: "PLATFORM_ADMIN",
          }),
          correlationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'SUCCEEDED',$5,$6::jsonb,$7)`,
          tenantId,
          actor.userId,
          membershipId,
          eventType,
          hash(membershipId).slice(0, 24),
          JSON.stringify({ resetId: reset.id }),
          correlationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','password_reset',$2::uuid,'identity.password_reset.admin_issued.v1',$3::jsonb,$4)`,
          tenantId,
          reset.id,
          JSON.stringify({
            passwordResetId: reset.id,
            membershipId,
            expiresAt: reset.expiresAt,
            delivery: "ADMIN_COPY_ONCE",
          }),
          `password-reset:${reset.id}:platform-issued:v1`,
        );
        await this.audit(tx, {
          tenantId,
          actorId: actor.userId,
          action: "tenant_user.password_reset.issued",
          targetType: "tenant_membership",
          targetId: membershipId,
          correlationId,
          reason: input.reason,
          after: {
            resetId: reset.id,
            expiresAt: reset.expiresAt,
            maskedDestination: membership.maskedDestination,
          },
        });
        const response = {
          id: String(reset.id),
          membershipId,
          expiresAt: reset.expiresAt,
          maskedDestination: membership.maskedDestination,
          resetUrl: `${this.config.FRONTEND_URL}/reset-password#token=${plainToken}`,
          shownOnce: true,
        };
        await this.storePlatformMutation(
          tx,
          actor.userId,
          operation,
          keyHash,
          requestHash,
          String(reset.id),
          response,
          { ...response, resetUrl: null },
        );
        return response;
      });
    } catch (error) {
      await this.recordPlatformProtectedOutcome(
        actor,
        tenantId,
        membershipId,
        eventType,
        "DENIED",
        correlationId,
        input.reason,
        error instanceof AppError ? error.code : "INTERNAL_ERROR",
      );
      throw error;
    }
  }

  async updatePlatformTenantUser(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
    input: {
      expectedVersion: number;
      displayName: string;
      employeeCode: string;
      portalAudience: string;
      reason: string;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    const operation = "platform.tenant-user.profile.update",
      keyHash = hash(idempotencyKey),
      requestHash = hash(JSON.stringify({ tenantId, membershipId, input }));
    return withPlatform(this.db, async (tx) => {
      const replay = await this.platformMutationReplay(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
      );
      if (replay) return replay;
      const current = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,user_id AS "userId",invited_name AS "displayName",employee_code AS "employeeCode",portal_audience AS "portalAudience",version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          membershipId,
        ),
      );
      if (Number(current.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "User changed; reload and retry",
        );
      if (
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND r.status='ACTIVE' AND NOT ($3=ANY(r.portal_audiences)) LIMIT 1`,
            tenantId,
            membershipId,
            input.portalAudience,
          )
        )[0]
      )
        throw new AppError(
          409,
          "AUDIENCE_ROLE_INCOMPATIBLE",
          "Selected audience is incompatible with an assigned role",
        );
      const changed = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.tenant_memberships SET invited_name=$1,employee_code=$2,portal_audience=$3,authorization_version=authorization_version+CASE WHEN portal_audience<>$3 THEN 1 ELSE 0 END,updated_at=now(),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid AND version=$6 RETURNING id,version`,
          input.displayName,
          input.employeeCode.toUpperCase(),
          input.portalAudience,
          tenantId,
          membershipId,
          input.expectedVersion,
        ),
      );
      if (current.portalAudience !== input.portalAudience)
        await tx.$executeRawUnsafe(
          `UPDATE app.sessions SET revoked_at=now(),revoked_reason='MEMBERSHIP_PROFILE_CHANGED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid AND revoked_at IS NULL`,
          tenantId,
          membershipId,
        );
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action: "tenant_user.profile.updated",
        targetType: "tenant_membership",
        targetId: membershipId,
        correlationId,
        reason: input.reason,
        before: {
          displayName: current.displayName,
          employeeCode: current.employeeCode,
          portalAudience: current.portalAudience,
          version: current.version,
        },
        after: changed,
      });
      const response = this.platformUserView(
        one(await this.platformUserRows(tx, tenantId, membershipId)),
        actor.userId,
      );
      await this.storePlatformMutation(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        membershipId,
        response,
      );
      return response;
    });
  }

  async setPlatformTenantUserStatus(
    actor: SessionActor,
    tenantId: string,
    membershipId: string,
    status: "ACTIVE" | "SUSPENDED",
    input: { expectedVersion: number; reason: string },
    correlationId: string,
    idempotencyKey: string,
  ) {
    this.requirePlatform(actor);
    this.requireIdempotencyKey(idempotencyKey);
    const operation = `platform.tenant-user.${status.toLowerCase()}`,
      keyHash = hash(idempotencyKey),
      requestHash = hash(
        JSON.stringify({ tenantId, membershipId, status, input }),
      );
    return withPlatform(this.db, async (tx) => {
      const replay = await this.platformMutationReplay(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
      );
      if (replay) return replay;
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `platform-tenant-user-status:${tenantId}`,
      );
      const current = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT m.id,m.status,m.user_id AS "userId",m.version,t.status AS "tenantStatus",EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND r.code='TENANT_OWNER' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())) AS "tenantOwner" FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid FOR UPDATE`,
          tenantId,
          membershipId,
        ),
      );
      if (Number(current.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "User changed; reload and retry",
        );
      if (current.status === status)
        throw new AppError(
          409,
          "STATE_CONFLICT",
          "User is already in that state",
        );
      if (
        status === "ACTIVE" &&
        (current.status !== "SUSPENDED" ||
          current.tenantStatus !== "ACTIVE" ||
          !current.userId)
      )
        throw new AppError(
          409,
          "REACTIVATION_NOT_ALLOWED",
          "Only an activated suspended user can be re-enabled for an active tenant",
        );
      if (status === "SUSPENDED" && current.status !== "ACTIVE")
        throw new AppError(
          409,
          "SUSPENSION_NOT_ALLOWED",
          "Only an active user can be disabled",
        );
      if (status === "SUSPENDED" && current.tenantOwner) {
        const others = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT count(*)::int total FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND m.id<>$2::uuid AND m.status='ACTIVE' AND m.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND r.status='ACTIVE' AND r.code='TENANT_OWNER' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()))`,
          tenantId,
          membershipId,
        );
        if (Number(others[0]?.total ?? 0) === 0)
          throw new AppError(
            409,
            "FINAL_OWNER_PROTECTED",
            "Assign another active Tenant Owner before disabling this user",
          );
      }
      const changed = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.tenant_memberships SET status=$1,authorization_version=authorization_version+1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4 RETURNING id,status,version`,
          status,
          tenantId,
          membershipId,
          input.expectedVersion,
        ),
      );
      const revokedSessions =
        status === "SUSPENDED"
          ? await tx.$executeRawUnsafe(
              `UPDATE app.sessions SET revoked_at=now(),revoked_reason='MEMBERSHIP_SUSPENDED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid AND revoked_at IS NULL`,
              tenantId,
              membershipId,
            )
          : 0;
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action:
          status === "ACTIVE"
            ? "tenant_user.reactivated"
            : "tenant_user.suspended",
        targetType: "tenant_membership",
        targetId: membershipId,
        correlationId,
        reason: input.reason,
        before: { status: current.status, version: current.version },
        after: { ...changed, revokedSessions },
      });
      const response = this.platformUserView(
        one(await this.platformUserRows(tx, tenantId, membershipId)),
        actor.userId,
      );
      await this.storePlatformMutation(
        tx,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        membershipId,
        response,
      );
      return response;
    });
  }

  async reissueOwnerInvitation(
    actor: SessionActor,
    tenantId: string,
    expectedVersion: number,
    reason: string,
    correlationId: string,
    idempotencyKey: string,
    frontendOrigin: string,
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
    if (!isRequestOriginAllowed(frontendOrigin, this.config))
      throw new AppError(
        403,
        "ORIGIN_INVALID",
        "Request origin is not allowed",
      );
    const operation = "tenant.owner-invitation.reissue";
    const keyHash = hash(idempotencyKey);
    const requestHash = hash(
      JSON.stringify({ tenantId, expectedVersion, reason }),
    );
    const plainToken = token();
    const expiresAt = new Date(
      Date.now() + this.config.INVITATION_TTL_HOURS * 3600000,
    );
    return withPlatform(this.db, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${actor.userId}:${operation}:${keyHash}`,
      );
      const replay = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash AS "requestHash",response_json AS response FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
        actor.userId,
        operation,
        keyHash,
      );
      if (replay[0]) {
        if (replay[0].requestHash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for different input",
          );
        return replay[0].response as Row;
      }
      const invitations = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.id,i.membership_id AS "membershipId",i.email,i.accepted_at AS "acceptedAt",i.version,t.status AS "tenantStatus" FROM app.owner_invitations i JOIN app.tenants t ON t.id=i.tenant_id WHERE i.tenant_id=$1::uuid FOR UPDATE`,
        tenantId,
      );
      const invitation = one(invitations);
      if (invitation.tenantStatus !== "ACTIVE")
        throw new AppError(
          409,
          "TENANT_INACTIVE",
          "Reactivate the tenant before issuing an invitation",
        );
      if (invitation.acceptedAt)
        throw new AppError(
          409,
          "OWNER_ALREADY_ACTIVE",
          "The tenant owner has already activated this workspace",
        );
      if (Number(invitation.version) !== expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Invitation changed; reload and retry",
        );
      const updated = one(
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.owner_invitations SET token_hash=$1,expires_at=$2,revoked_at=null,delivery_state='PENDING_DELIVERY',updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid AND version=$5 RETURNING id,email,expires_at AS "expiresAt",delivery_state AS "deliveryState",accepted_at AS "acceptedAt",revoked_at AS "revokedAt",version`,
          hash(plainToken),
          expiresAt,
          tenantId,
          invitation.id,
          expectedVersion,
        ),
      );
      const secretEnvelope = sealOwnerInvitationToken(
        {
          tenantId,
          invitationId: String(invitation.id),
          token: plainToken,
          expiresAt: expiresAt.toISOString(),
        },
        this.config.EMAIL_TOKEN_ENCRYPTION_KEY,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.invitation_delivery_attempts(tenant_id,invitation_id,channel,destination_hash,secret_envelope) VALUES($1::uuid,$2::uuid,'EMAIL',$3,$4) ON CONFLICT(tenant_id,invitation_id,channel) DO UPDATE SET state='PENDING',attempts=0,available_at=now(),leased_at=null,delivered_at=null,failure_code=null,provider_message_id=null,secret_envelope=EXCLUDED.secret_envelope,updated_at=now()`,
        tenantId,
        invitation.id,
        hash(String(invitation.email).toLowerCase()),
        secretEnvelope,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key,state,processed_at) VALUES($1::uuid,'TENANT','owner_invitation',$2::uuid,'owner_invitation.requested.v1',$3::jsonb,$4,'PENDING',null)`,
        tenantId,
        invitation.id,
        JSON.stringify({
          invitationId: invitation.id,
          maskedDestination: String(invitation.email).replace(
            /^(.).+(@.*)$/,
            "$1***$2",
          ),
        }),
        `owner-invitation:${invitation.id}:v${updated.version}`,
      );
      await this.audit(tx, {
        tenantId,
        actorId: actor.userId,
        action: "owner.invitation.reissued",
        targetType: "owner_invitation",
        targetId: String(invitation.id),
        correlationId,
        reason,
        after: { expiresAt: updated.expiresAt, version: updated.version },
      });
      const response = {
        invitation: updated,
        activationUrl: `${new URL(frontendOrigin).origin}/accept-invitation?token=${plainToken}`,
        shownOnce: true,
      };
      await tx.$executeRawUnsafe(
        `INSERT INTO app.idempotency_records(scope,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('PLATFORM',$1::uuid,$2,$3,$4,$5::uuid,$6::jsonb)`,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        tenantId,
        JSON.stringify({
          invitation: updated,
          activationUrl: null,
          shownOnce: true,
        }),
      );
      return response;
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
        `SELECT key,label,CASE key
           WHEN 'organization' THEN CASE WHEN EXISTS(SELECT 1 FROM app.organization_nodes WHERE tenant_id=$1::uuid AND node_type='LEGAL_ENTITY' AND state='ACTIVE') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'users' THEN CASE WHEN EXISTS(SELECT 1 FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND status='ACTIVE') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'branches' THEN CASE WHEN EXISTS(SELECT 1 FROM app.organization_nodes WHERE tenant_id=$1::uuid AND node_type='BRANCH' AND state='ACTIVE') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'clients' THEN CASE WHEN EXISTS(SELECT 1 FROM app.clients WHERE tenant_id=$1::uuid AND state='ACTIVE') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'vendors' THEN CASE WHEN EXISTS(SELECT 1 FROM app.vendors WHERE tenant_id=$1::uuid AND state='ACTIVE') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'commercial' THEN CASE WHEN EXISTS(SELECT 1 FROM app.contracts WHERE tenant_id=$1::uuid AND state='PUBLISHED') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           WHEN 'imports' THEN CASE WHEN EXISTS(SELECT 1 FROM app.import_jobs WHERE tenant_id=$1::uuid AND state='COMMITTED') THEN 'COMPLETE' ELSE 'NOT_STARTED' END
           ELSE state END AS state,version FROM app.setup_checklist_items WHERE tenant_id=$1::uuid ORDER BY display_order`,
        tenantId,
      );
      const configs = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT namespace,schema_version AS "schemaVersion",value,version FROM app.tenant_configuration ORDER BY namespace`,
      );
      const integrations = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int endpoints,count(*) FILTER(WHERE state='ACTIVE')::int active,
          (SELECT count(*)::int FROM app.integration_deliveries WHERE tenant_id=$1::uuid AND state IN ('FAILED','DEAD_LETTER')) failures
         FROM app.integration_endpoints WHERE tenant_id=$1::uuid`,
        tenantId,
      );
      return {
        tenant,
        checklist,
        configurations: configs,
        contextVersion: actor.contextVersion,
        integrationHealth: integrations[0],
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
    return withTenant(this.db, tenantId, (tx) =>
      this.createProbeInTransaction(
        tx,
        actor,
        label,
        note,
        correlationId,
        idempotencyKey,
      ),
    );
  }

  async createProbeInTransaction(
    tx: Prisma.TransactionClient,
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
    return (async () => {
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
    })();
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
    return withTenant(this.db, tenantId, (tx) =>
      this.updateProbeInTransaction(tx, actor, id, input, correlationId),
    );
  }

  async updateProbeInTransaction(
    tx: Prisma.TransactionClient,
    actor: SessionActor,
    id: string,
    input: { label?: string; note?: string; expectedVersion: number },
    correlationId: string,
  ) {
    const tenantId = this.requireTenant(actor);
    return (async () => {
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
    })();
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
      const snapshot = (
        await tx.$queryRawUnsafe<
          Array<{
            total: number;
            active: number;
            inactive: number;
            tenants: Array<Row>;
          }>
        >(
          `WITH tenant_health AS MATERIALIZED (
             SELECT * FROM reporting.platform_tenant_health
           )
           SELECT count(*)::int AS total,
             count(*) FILTER(WHERE status='ACTIVE')::int AS active,
             count(*) FILTER(WHERE status='INACTIVE')::int AS inactive,
             coalesce(jsonb_agg(to_jsonb(tenant_health) ORDER BY name),'[]'::jsonb) AS tenants
           FROM tenant_health`,
        )
      )[0] ?? { total: 0, active: 0, inactive: 0, tenants: [] };
      const size = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT pg_database_size(current_database())::text AS bytes`,
      );
      const integrations = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int endpoints,count(*) FILTER(WHERE state='ACTIVE')::int active,
          (SELECT count(*)::int FROM app.integration_deliveries WHERE state IN ('FAILED','DEAD_LETTER')) failures
         FROM app.integration_endpoints`,
      );
      return {
        generatedAt: new Date().toISOString(),
        totals: {
          total: Number(snapshot.total ?? 0),
          active: Number(snapshot.active ?? 0),
          inactive: Number(snapshot.inactive ?? 0),
        },
        projectDatabaseBytes: size[0]?.bytes,
        storageLabel: "Shared-container project database usage",
        integrationHealth: integrations[0] ?? {
          endpoints: 0,
          active: 0,
          failures: 0,
        },
        tenants: snapshot.tenants ?? [],
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

  async createFnd02Fixture(
    actor: SessionActor,
    input: {
      namespace: string;
      scenario: "SCOPES_ONLY" | "ACCESS_MATRIX" | "PORTALS" | "REPORTS";
    },
    idempotencyKey: string,
    correlationId: string,
  ) {
    this.requirePlatform(actor);
    if (this.config.ENABLE_TEST_HOOKS !== "true")
      throw new AppError(404, "NOT_FOUND", "Resource not found");
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
    const operation = `test.fnd02.fixture:${input.scenario}`;
    const keyHash = hash(idempotencyKey);
    const requestHash = hash(JSON.stringify(input));
    const fixturePassword = "FixturePassword!234";
    const replay = await withPlatform(
      this.db,
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT request_hash AS "requestHash",response_json AS response FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
            actor.userId,
            operation,
            keyHash,
          )
        )[0],
    );
    const withPasswords = (response: Record<string, unknown>) => ({
      ...response,
      actors: Object.fromEntries(
        Object.entries(
          (response.actors ?? {}) as Record<string, Record<string, unknown>>,
        ).map(([name, value]) => [
          name,
          { ...value, password: fixturePassword },
        ]),
      ),
    });
    if (replay) {
      if (replay.requestHash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with different input",
        );
      return {
        ...withPasswords(replay.response as Record<string, unknown>),
        replayed: true,
      };
    }

    const suffix =
      input.scenario === "SCOPES_ONLY"
        ? "SCP"
        : input.scenario === "ACCESS_MATRIX"
          ? "ACC"
          : input.scenario === "PORTALS"
            ? "POR"
            : "REP";
    const tenantCode = `${input.namespace}-${suffix}`;
    const ownerEmail = `${tenantCode.toLowerCase()}-owner@test.local`;
    const provisioned = await this.provision(
      actor,
      {
        name: `${tenantCode} Logistics`,
        code: tenantCode,
        legalName: `${tenantCode} Logistics Limited`,
        taxIdentifier: `TAX-${tenantCode}`,
        address: {
          line1: "1 Fixture Road",
          line2: "",
          postalCode: "700001",
          postalLocalityId: "70000100-0000-4000-8000-000000000001",
          country: "IN",
        },
        timezone: "Asia/Kolkata",
        locale: "en-IN",
        currency: "INR",
        fiscalYearStart: { month: 4, day: 1 },
        legalEntity: { name: `${tenantCode} Entity`, code: tenantCode },
        support: { name: "Fixture Support", email: `support-${ownerEmail}` },
        owner: { name: "Fixture Owner", email: ownerEmail },
        branding: {
          shortName: tenantCode,
          primaryColor: "#16324F",
          accentColor: "#D97706",
        },
        active: true,
      },
      `${idempotencyKey}:tenant`,
      correlationId,
    );
    if (!("invitationUrl" in provisioned) || !provisioned.invitationUrl)
      throw new AppError(
        409,
        "FIXTURE_STATE_INVALID",
        "Fixture tenant already exists without a replay record",
      );
    await this.acceptInvitation(
      String(provisioned.invitationUrl).split("token=")[1]!,
      "Fixture Owner",
      fixturePassword,
      correlationId,
    );
    const tenantId = String(provisioned.tenant.id);
    const passwordHash = await argon2.hash(fixturePassword, {
      type: argon2.argon2id,
    });

    const response = await withPlatform(this.db, async (tx) => {
      if (input.scenario === "SCOPES_ONLY")
        await tx.$executeRawUnsafe(
          `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value)
           VALUES($1::uuid,'security',1,'{"mfaPolicy":"OFF","fixtureMfaPolicyAfterInvitation":"ALL"}'::jsonb)
           ON CONFLICT(tenant_id,namespace) DO UPDATE SET value=EXCLUDED.value,version=app.tenant_configuration.version+1,updated_at=now()`,
          tenantId,
        );
      const root = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
          tenantId,
        )
      )[0]!;
      const node = async (
        scopeType: string,
        code: string,
        name: string,
        parentId: string,
      ) =>
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id) VALUES($1::uuid,$2,$3,$4,$5::uuid)
           ON CONFLICT(tenant_id,scope_type,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            tenantId,
            scopeType,
            code,
            name,
            parentId,
          )
        )[0]!;
      const north = await node("REGION", "NORTH", "North", String(root.id));
      const south = await node("REGION", "SOUTH", "South", String(root.id));
      const alpha = await node(
        "CLIENT",
        "ALPHA",
        "Alpha Client",
        String(north.id),
      );
      const vendor = await node(
        "VENDOR",
        "RED",
        "Red Vendor",
        String(north.id),
      );
      const trip = await node(
        "ASSIGNED_TRIP",
        "TRIP-1",
        "Assigned Trip 1",
        String(north.id),
      );
      const roleRows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,code FROM app.roles WHERE tenant_id=$1::uuid`,
        tenantId,
      );
      const roles = Object.fromEntries(
        roleRows.map((row) => [String(row.code), String(row.id)]),
      );
      const actors: Record<string, Record<string, unknown>> = {};
      const addActor = async (
        name: string,
        audience: string,
        roleGrants: Array<{ role: string; scope: string; actions: string[] }>,
      ) => {
        const email = `${tenantCode.toLowerCase()}-${name.toLowerCase()}@test.local`;
        const user = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.users(email,display_name,password_hash) VALUES($1,$2,$3) RETURNING id`,
            email,
            `Fixture ${name}`,
            passwordHash,
          )
        )[0]!;
        const membership = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,portal_audience,status)
           VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,'ACTIVE') RETURNING id`,
            tenantId,
            user.id,
            email,
            `Fixture ${name}`,
            `FX-${name.toUpperCase()}`,
            audience,
          )
        )[0]!;
        for (const grant of roleGrants) {
          const assignment = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
              tenantId,
              membership.id,
              roles[grant.role],
            )
          )[0]!;
          for (const action of grant.actions)
            await tx.$executeRawUnsafe(
              `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,
              tenantId,
              assignment.id,
              grant.scope,
              action,
            );
        }
        actors[name] = {
          userId: user.id,
          membershipId: membership.id,
          email,
          tenantCode,
          home:
            audience === "VENDOR"
              ? "/portal/vendor"
              : audience === "DRIVER"
                ? "/portal/driver"
                : audience === "CLIENT"
                  ? "/portal/client"
                  : "/app/control",
        };
        return user;
      };
      const ownerMembership = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT m.id,m.user_id AS "userId" FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND m.invited_email=$2`,
          tenantId,
          ownerEmail,
        )
      )[0]!;
      actors.owner = {
        userId: ownerMembership.userId,
        membershipId: ownerMembership.id,
        email: ownerEmail,
        tenantCode,
        home: "/app/control",
      };
      const regional = await addActor("regional", "INTERNAL", [
        {
          role: "REGIONAL_MANAGER",
          scope: String(north.id),
          actions: ["READ", "CREATE", "UPDATE", "EXPORT"],
        },
      ]);
      await addActor("kam", "INTERNAL", [
        {
          role: "KEY_ACCOUNT_MANAGER",
          scope: String(alpha.id),
          actions: ["READ", "CREATE", "UPDATE", "EXPORT"],
        },
      ]);
      await addActor("multiRole", "INTERNAL", [
        {
          role: "REGIONAL_MANAGER",
          scope: String(north.id),
          actions: ["READ"],
        },
        {
          role: "FINANCE_EXECUTIVE",
          scope: String(south.id),
          actions: ["APPROVE"],
        },
      ]);
      await addActor("vendor", "VENDOR", [
        { role: "VENDOR_OWNER", scope: String(vendor.id), actions: ["READ"] },
      ]);
      const driverA = await addActor("driverA", "DRIVER", [
        { role: "DRIVER", scope: String(trip.id), actions: ["READ", "UPDATE"] },
      ]);
      await addActor("driverB", "DRIVER", [
        { role: "DRIVER", scope: String(trip.id), actions: ["READ", "UPDATE"] },
      ]);
      await addActor("client", "CLIENT", [
        { role: "CLIENT_VIEWER", scope: String(alpha.id), actions: ["READ"] },
      ]);
      await addActor("auditor", "INTERNAL", [
        {
          role: "AUDITOR",
          scope: String(root.id),
          actions: ["READ", "EXPORT"],
        },
      ]);
      const addResource = async (
        label: string,
        resourceType: string,
        scope: string,
        assignedUserId?: string,
      ) =>
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.authorization_probe_records(tenant_id,label,resource_type,scope_node_ids,assigned_user_id,status,tax_identifier,bank_detail,commercial_rate_minor,payment_minor,internal_margin_minor)
           VALUES($1::uuid,$2,$3,ARRAY[$4::uuid],$5::uuid,'OPEN','FIXTURE-TAX-1234','FIXTURE-BANK-1234',120000,125000,5000) RETURNING id,label,version`,
            tenantId,
            label,
            resourceType,
            scope,
            assignedUserId ?? null,
          )
        )[0]!;
      const resources = {
        north: await addResource("North Work", "WORK_ITEM", String(north.id)),
        south: await addResource("South Work", "WORK_ITEM", String(south.id)),
        client: await addResource(
          "Alpha Status",
          "CLIENT_STATUS",
          String(alpha.id),
        ),
        vendor: await addResource("Red Payment", "PAYMENT", String(vendor.id)),
        trip: await addResource(
          "Driver Trip",
          "TRIP",
          String(trip.id),
          String(driverA.id),
        ),
      };
      if (input.scenario === "REPORTS") {
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id) VALUES($1::uuid,$2::uuid,$3::uuid,'LOGIN_FAILED','DENIED','fixture-report','{}',$4)`,
          tenantId,
          regional.id,
          actors.regional!.membershipId,
          correlationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.security_alerts(tenant_id,alert_type,severity,deduplication_key,user_id,membership_id) VALUES($1::uuid,'REPEATED_LOGIN_FAILURES','HIGH',$2,$3::uuid,$4::uuid)`,
          tenantId,
          `fixture:${input.namespace}`,
          regional.id,
          actors.regional!.membershipId,
        );
      }
      return {
        scenario: input.scenario,
        tenantA: { id: tenantId, code: tenantCode },
        actors,
        roles,
        scopes: {
          root: root.id,
          north: north.id,
          south: south.id,
          alpha: alpha.id,
          vendor: vendor.id,
          trip: trip.id,
        },
        resources,
        expected: {
          resources: 5,
          alerts: input.scenario === "REPORTS" ? 1 : 0,
        },
      };
    });
    const stored = {
      ...response,
      actors: Object.fromEntries(
        Object.entries(response.actors).map(([name, value]) => [name, value]),
      ),
    };
    await withPlatform(this.db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app.idempotency_records(scope,actor_id,operation,key_hash,request_hash,resource_id,response_json) VALUES('PLATFORM',$1::uuid,$2,$3,$4,$5::uuid,$6::jsonb)`,
        actor.userId,
        operation,
        keyHash,
        requestHash,
        tenantId,
        JSON.stringify(stored),
      ),
    );
    return withPasswords(stored);
  }
}
