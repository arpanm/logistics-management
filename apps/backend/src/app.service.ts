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
import { isRequestOriginAllowed, loadConfig } from "@logistics/config";
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
      let mfaRequired = false;
      let mfaEnrolled = false;
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
            keys[i]![0] === "branding" ? "COMPLETE" : "NOT_STARTED",
          );
        const membershipRows = await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.tenant_memberships(tenant_id,invited_email,invited_name,employee_code,role,status) VALUES($1::uuid,$2,$3,$4,'TENANT_OWNER','INVITED') RETURNING id`,
          tenantId,
          input.owner.email,
          input.owner.name,
          `OWNER-${input.code}`.slice(0, 30),
        );
        const ownerMembershipId = String(membershipRows[0]!.id);
        const root = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name) VALUES($1::uuid,'TENANT','TENANT','Entire tenant') RETURNING id`,
            tenantId,
          )
        )[0]!;
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
          root.id,
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
          `INSERT INTO app.invitation_delivery_attempts(tenant_id,invitation_id,channel,destination_hash) VALUES($1::uuid,$2::uuid,'EMAIL',$3)`,
          tenantId,
          inviteId,
          hash(input.owner.email.toLowerCase()),
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
      return { tenant, invitations: invites };
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
      await tx.$executeRawUnsafe(
        `INSERT INTO app.invitation_delivery_attempts(tenant_id,invitation_id,channel,destination_hash) VALUES($1::uuid,$2::uuid,'EMAIL',$3) ON CONFLICT(tenant_id,invitation_id,channel) DO UPDATE SET state='PENDING',attempts=0,available_at=now(),leased_at=null,delivered_at=null,failure_code=null,updated_at=now()`,
        tenantId,
        invitation.id,
        hash(String(invitation.email).toLowerCase()),
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
                  : "/app",
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
        home: "/app",
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
