import { Inject, Injectable } from "@nestjs/common";
import argon2 from "argon2";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { Prisma, withPlatform, withTenant } from "@logistics/db";
import {
  evaluatePolicy,
  maskSensitive,
  portalHome,
  type PolicyAssignment,
  type ResourceDescriptor,
  type ScopeAction,
  type ScopeType,
  type SessionActor,
} from "@logistics/auth";
import type {
  accessInviteSchema,
  accessMutationSchema,
  accessPreviewSchema,
  probeAccessCreateSchema,
  roleMutationSchema,
} from "@logistics/domain";
import { csvCell } from "@logistics/domain";
import type { z } from "zod";
import { AppError, AppService } from "./app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type InviteInput = z.infer<typeof accessInviteSchema>;
type AccessInput = z.infer<typeof accessMutationSchema>;
type PreviewInput = z.infer<typeof accessPreviewSchema>;
type RoleInput = z.infer<typeof roleMutationSchema>;
type ProbeInput = z.infer<typeof probeAccessCreateSchema>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const opaqueToken = () => randomBytes(32).toString("base64url");
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
const uuidRows = (rows: Row[]) => rows.map((row) => String(row.id));
const actionForCapability = (capability: string): ScopeAction => {
  if (capability.endsWith(".create")) return "CREATE";
  if (capability.endsWith(".update")) return "UPDATE";
  if (capability.endsWith(".approve")) return "APPROVE";
  if (capability.endsWith(".export")) return "EXPORT";
  if (capability.endsWith(".admin")) return "ADMIN";
  return "READ";
};
const maskDestination = (email?: string, mobile?: string) =>
  email
    ? `${email.slice(0, 1)}***@${email.split("@")[1] ?? "hidden"}`
    : `+••••••${mobile?.slice(-2) ?? ""}`;

@Injectable()
export class AccessService {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private tenant(actor: SessionActor, allowRestricted = false) {
    const tenantId = this.app.requireTenant(actor);
    if (!actor.membershipId)
      throw new AppError(403, "FORBIDDEN", "You do not have permission");
    if (!allowRestricted && actor.assuranceLevel === "RESTRICTED_MFA")
      throw new AppError(
        401,
        "MFA_REQUIRED",
        "Complete multi-factor authentication",
      );
    return tenantId;
  }

  async ensureBaseline(actor: SessionActor) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name)
         VALUES($1::uuid,'TENANT','TENANT','Entire tenant') ON CONFLICT DO NOTHING`,
        tenantId,
      );
      const roles: Array<[string, string, string, string]> = [
        ["TENANT_OWNER", "Tenant Owner", "INTERNAL", "PROTECTED"],
        ["MIS_EXECUTIVE", "MIS Executive", "INTERNAL", "STANDARD"],
        ["REGIONAL_MANAGER", "Regional Manager", "INTERNAL", "STANDARD"],
        ["KEY_ACCOUNT_MANAGER", "Key Account Manager", "INTERNAL", "STANDARD"],
        [
          "TRAFFIC_PLACEMENT_EXECUTIVE",
          "Traffic / Placement Executive",
          "INTERNAL",
          "STANDARD",
        ],
        ["FINANCE_EXECUTIVE", "Finance Executive", "INTERNAL", "PRIVILEGED"],
        [
          "COLLECTION_EXECUTIVE",
          "Collection Executive",
          "INTERNAL",
          "PRIVILEGED",
        ],
        ["LOADING_EXECUTIVE", "Loading Executive", "INTERNAL", "STANDARD"],
        ["UNLOADING_EXECUTIVE", "Unloading Executive", "INTERNAL", "STANDARD"],
        ["VENDOR_OWNER", "Vendor Owner", "VENDOR", "STANDARD"],
        ["DRIVER", "Driver", "DRIVER", "STANDARD"],
        ["CLIENT_VIEWER", "Client Viewer", "CLIENT", "STANDARD"],
        ["AUDITOR", "Auditor", "INTERNAL", "PRIVILEGED"],
      ];
      for (const [code, name, audience, level] of roles)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.roles(tenant_id,code,name,description,portal_audiences,privilege_level,protected)
           VALUES($1::uuid,$2,$3,'Baseline role template',ARRAY[$4]::text[],$5,$6)
           ON CONFLICT(tenant_id,code) DO NOTHING`,
          tenantId,
          code,
          name,
          audience,
          level,
          code === "TENANT_OWNER",
        );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
         SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
         WHERE r.tenant_id=$1::uuid AND (
           r.code='TENANT_OWNER'
           OR (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('identity.user.read','identity.role.read','identity.report.read','identity.audit.read','probe.read','probe.export'))
           OR (r.code IN ('REGIONAL_MANAGER','KEY_ACCOUNT_MANAGER','TRAFFIC_PLACEMENT_EXECUTIVE') AND c.code IN ('probe.read','probe.create','probe.update','probe.export'))
           OR (r.code IN ('FINANCE_EXECUTIVE','COLLECTION_EXECUTIVE') AND c.code IN ('probe.read','probe.approve','probe.export','sensitive.payment.read','sensitive.bank_detail.read'))
           OR (r.code IN ('LOADING_EXECUTIVE','UNLOADING_EXECUTIVE') AND c.code IN ('probe.read','probe.update'))
           OR (r.code='VENDOR_OWNER' AND c.code IN ('probe.read','probe.update','sensitive.payment.read'))
           OR (r.code='DRIVER' AND c.code IN ('probe.read','probe.update'))
           OR (r.code='CLIENT_VIEWER' AND c.code='probe.read'))
         ON CONFLICT DO NOTHING`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id)
         SELECT m.tenant_id,m.id,r.id FROM app.tenant_memberships m JOIN app.roles r ON r.tenant_id=m.tenant_id AND r.code='TENANT_OWNER'
         WHERE m.tenant_id=$1::uuid AND m.role='TENANT_OWNER' ON CONFLICT DO NOTHING`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
         SELECT a.tenant_id,a.id,n.id,'ADMIN' FROM app.membership_role_assignments a
         JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.code='TENANT_OWNER'
         JOIN app.authorization_scope_nodes n ON n.tenant_id=a.tenant_id AND n.scope_type='TENANT'
         WHERE a.tenant_id=$1::uuid ON CONFLICT DO NOTHING`,
        tenantId,
      );
      return { ready: true };
    });
  }

  private async policyData(tx: Tx, actor: SessionActor) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT a.id,a.status,a.effective_from,a.effective_to,
        coalesce(array_agg(DISTINCT rc.capability_code) FILTER(WHERE cc.code IS NOT NULL),'{}') AS capabilities,
        coalesce(jsonb_agg(DISTINCT jsonb_build_object('nodeId',g.scope_node_id,'scopeType',gn.scope_type,'action',g.action,'active',g.status='ACTIVE','expiresAt',g.effective_to)) FILTER(WHERE g.id IS NOT NULL),'[]') AS grants
       FROM app.membership_role_assignments a
       JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.status='ACTIVE'
       LEFT JOIN app.role_capabilities rc ON rc.tenant_id=r.tenant_id AND rc.role_id=r.id
       LEFT JOIN app.capability_catalog cc ON cc.code=rc.capability_code AND cc.active
       LEFT JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
       LEFT JOIN app.authorization_scope_nodes gn ON gn.tenant_id=g.tenant_id AND gn.id=g.scope_node_id AND gn.status='ACTIVE'
       WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid
         AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
       GROUP BY a.id,a.status,a.effective_from,a.effective_to`,
      actor.activeTenantId,
      actor.membershipId,
    );
    return rows.map(
      (row): PolicyAssignment => ({
        id: String(row.id),
        active: row.status === "ACTIVE",
        capabilities: row.capabilities as string[],
        grants: (row.grants as Array<Record<string, unknown>>).map((grant) => ({
          nodeId: String(grant.nodeId),
          scopeType: grant.scopeType
            ? (String(grant.scopeType) as ScopeType)
            : undefined,
          action: String(grant.action) as ScopeAction,
          active: Boolean(grant.active),
          expiresAt: grant.expiresAt ? new Date(String(grant.expiresAt)) : null,
        })),
      }),
    );
  }

  private async assertCurrent(tx: Tx, actor: SessionActor) {
    const row = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT m.status AS "membershipStatus",m.authorization_version AS "membershipVersion",u.status AS "userStatus",u.auth_version AS "userVersion"
         FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
         WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid AND u.id=$3::uuid`,
        actor.activeTenantId,
        actor.membershipId,
        actor.userId,
      )
    )[0];
    if (
      !row ||
      row.membershipStatus !== "ACTIVE" ||
      row.userStatus !== "ACTIVE" ||
      Number(row.membershipVersion) !== Number(actor.membershipAuthVersion) ||
      Number(row.userVersion) !== Number(actor.userAuthVersion)
    )
      throw new AppError(
        401,
        "SESSION_STALE",
        "Your access changed; sign in again",
      );
  }

  private async ancestors(tx: Tx, nodeIds: readonly string[]) {
    if (!nodeIds.length) return {};
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `WITH RECURSIVE tree(origin,id,parent_id) AS (
        SELECT id,id,parent_id FROM app.authorization_scope_nodes WHERE id=ANY($1::uuid[])
        UNION ALL SELECT tree.origin,n.id,n.parent_id FROM tree JOIN app.authorization_scope_nodes n ON n.id=tree.parent_id
      ) SELECT origin,array_remove(array_agg(id),origin) AS ancestors FROM tree GROUP BY origin`,
      [...nodeIds],
    );
    return Object.fromEntries(
      rows.map((row) => [String(row.origin), row.ancestors as string[]]),
    );
  }

  private async decide(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: ScopeAction,
    resource: ResourceDescriptor,
  ) {
    const assignments = await this.policyData(tx, actor);
    const current = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT m.status AS "membershipStatus",m.authorization_version AS "membershipVersion",u.status AS "userStatus",u.auth_version AS "userVersion"
         FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
         WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid AND u.id=$3::uuid`,
        actor.activeTenantId,
        actor.membershipId,
        actor.userId,
      )
    )[0];
    const sessionCurrent = Boolean(
      current &&
        current.membershipStatus === "ACTIVE" &&
        current.userStatus === "ACTIVE" &&
        Number(current.membershipVersion) ===
          Number(actor.membershipAuthVersion) &&
        Number(current.userVersion) === Number(actor.userAuthVersion),
    );
    const audience = await this.portalAudience(tx, actor);
    const audienceBlocked =
      audience === "DRIVER" &&
      resource.requiresCurrentAssignment === true &&
      resource.assignedUserId !== actor.userId;
    const decision = evaluatePolicy({
      tenantId: this.tenant(actor),
      userId: actor.userId,
      capability,
      action,
      assignments,
      resource,
      ancestorsByNode: await this.ancestors(tx, resource.nodeIds),
      identityActive: true,
      membershipActive: true,
      sessionCurrent,
      mfaRequired: false,
      mfaSatisfied: actor.assuranceLevel === "MFA",
      policyBlocked: audienceBlocked,
    });
    return { decision, assignments };
  }

  private async denial(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: ScopeAction,
    target: string,
    correlationId: string,
  ): Promise<never> {
    const tenantId = this.tenant(actor);
    await withTenant(this.app.db, tenantId, (auditTx) =>
      auditTx.$executeRawUnsafe(
        `INSERT INTO app.security_events(tenant_id,user_id,membership_id,session_id,event_type,outcome,safe_target_hash,metadata,correlation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'AUTHORIZATION_DENIED','DENIED',$5,$6::jsonb,$7)`,
        tenantId,
        actor.userId,
        actor.membershipId,
        (actor as SessionActor & { sessionId?: string }).sessionId ?? null,
        sha(target).slice(0, 24),
        JSON.stringify({ capability, action }),
        correlationId,
      ),
    );
    throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private async recordSecurityFailure(
    tenantId: string,
    userId: string | null,
    membershipId: string | null,
    eventType: "INVITATION_ACCEPTANCE_FAILED" | "MFA_CHALLENGE_FAILED",
    correlationId: string,
    target: string,
  ) {
    return withTenant(this.app.db, tenantId, async (failureTx) => {
      await failureTx.$executeRawUnsafe(
        `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,'DENIED',$5,'{}'::jsonb,$6)`,
        tenantId,
        userId,
        membershipId,
        eventType,
        sha(target).slice(0, 24),
        correlationId,
      );
      const attempts = Number(
        (
          await failureTx.$queryRawUnsafe<Array<Row>>(
            `SELECT count(*)::int attempts FROM app.security_events
             WHERE tenant_id=$1::uuid AND event_type=$2 AND safe_target_hash=$3
               AND occurred_at>=now()-interval '15 minutes'
               AND occurred_at>coalesce((SELECT max(s.occurred_at) FROM app.security_events s
                 WHERE s.tenant_id=$1::uuid AND s.event_type=CASE WHEN $2='MFA_CHALLENGE_FAILED' THEN 'MFA_CHALLENGE_SUCCEEDED' ELSE 'INVITATION_ACCEPTANCE_SUCCEEDED' END
                   AND s.safe_target_hash=$3),'-infinity'::timestamptz)`,
            tenantId,
            eventType,
            sha(target).slice(0, 24),
          )
        )[0]?.attempts ?? 0,
      );
      if (attempts >= 5)
        await failureTx.$executeRawUnsafe(
          `INSERT INTO app.security_alerts(tenant_id,alert_type,severity,deduplication_key,user_id,membership_id)
           VALUES($1::uuid,$2,'HIGH',$3,$4::uuid,$5::uuid)
           ON CONFLICT(tenant_id,deduplication_key) DO UPDATE
           SET occurrence_count=app.security_alerts.occurrence_count+1,last_seen_at=now(),updated_at=now()`,
          tenantId,
          eventType,
          `${eventType}:${sha(target).slice(0, 24)}`,
          userId,
          membershipId,
        );
      return attempts;
    });
  }

  private async rejectMfa(
    actor: SessionActor,
    tenantId: string,
    correlationId: string,
  ): Promise<never> {
    const attempts = await this.recordSecurityFailure(
      tenantId,
      actor.userId,
      actor.membershipId ?? null,
      "MFA_CHALLENGE_FAILED",
      correlationId,
      actor.userId,
    );
    if (attempts >= 5)
      throw new AppError(
        429,
        "MFA_THROTTLED",
        "MFA challenge could not be verified",
      );
    throw new AppError(
      400,
      "MFA_CHALLENGE_INVALID",
      "MFA challenge could not be verified",
    );
  }

  private async authorizeRoot(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: ScopeAction,
    correlationId: string,
  ) {
    const root = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT' AND status='ACTIVE'`,
      actor.activeTenantId,
    );
    const rootId = String(root[0]?.id ?? "");
    const { decision } = await this.decide(tx, actor, capability, action, {
      tenantId: this.tenant(actor),
      nodeIds: [rootId],
    });
    if (!decision.allowed)
      await this.denial(tx, actor, capability, action, rootId, correlationId);
    return rootId;
  }

  async effective(actor: SessionActor, correlationId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const assignments = await this.policyData(tx, actor);
      const membership = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT portal_audience AS audience,authorization_version AS version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantId,
          actor.membershipId,
        )
      )[0];
      if (!membership)
        return this.denial(
          tx,
          actor,
          "identity.user.read",
          "READ",
          "membership",
          correlationId,
        );
      const capabilities = [
        ...new Set(assignments.flatMap((a) => [...a.capabilities])),
      ].sort();
      const root = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT' AND status='ACTIVE'`,
          tenantId,
        )
      )[0];
      const rootId = String(root?.id ?? "");
      const rootAllows = async (capability: string, action: ScopeAction) =>
        rootId
          ? (
              await this.decide(tx, actor, capability, action, {
                tenantId,
                nodeIds: [rootId],
              })
            ).decision.allowed
          : false;
      const actions = {
        canReadTenantRoles: await rootAllows("identity.role.read", "READ"),
        canAdminTenantUsers: await rootAllows("identity.user.admin", "ADMIN"),
        canResetTenantSessions: await rootAllows(
          "identity.session.admin",
          "ADMIN",
        ),
        canResetMfa: await rootAllows("identity.mfa.admin", "ADMIN"),
      };
      return {
        capabilities,
        actions,
        navigation: {
          users: capabilities.includes("identity.user.read"),
          roles: capabilities.includes("identity.role.read"),
          reports: capabilities.includes("identity.report.read"),
          probes: capabilities.includes("probe.read"),
        },
        portalAudience: membership.audience,
        home: portalHome(
          membership.audience as "INTERNAL" | "VENDOR" | "DRIVER" | "CLIENT",
        ),
        authorizationVersion: membership.version,
      };
    });
  }

  async capabilities(actor: SessionActor) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<Row>>(
        `SELECT code,capability_group AS "group",description,privileged,sensitive_class AS "sensitiveClass",delegable,introduced_version AS "introducedVersion" FROM app.capability_catalog WHERE active ORDER BY capability_group,code`,
      ),
    );
  }

  async scopes(actor: SessionActor, search = "") {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.role.read",
        "READ",
        "scopes",
      );
      return tx.$queryRawUnsafe<Array<Row>>(
        `WITH RECURSIVE paths AS (
          SELECT id,parent_id,name,name::text path,scope_type,code,status FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND parent_id IS NULL
          UNION ALL SELECT n.id,n.parent_id,n.name,(p.path||' / '||n.name),n.scope_type,n.code,n.status FROM app.authorization_scope_nodes n JOIN paths p ON p.id=n.parent_id WHERE n.tenant_id=$1::uuid
        ) SELECT * FROM paths WHERE status='ACTIVE' AND ($2='' OR name ILIKE $3 OR code ILIKE $3) ORDER BY path LIMIT 100`,
        tenantId,
        search,
        `%${search}%`,
      );
    });
  }

  async listRoles(actor: SessionActor, correlationId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.role.read",
        "READ",
        correlationId,
      );
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT r.id,r.code,r.name,r.description,r.protected,r.privilege_level AS "privilegeLevel",r.portal_audiences AS "portalAudiences",r.status,r.version,
          count(DISTINCT rc.capability_code)::int AS "capabilityCount",count(DISTINCT a.membership_id)::int AS "userCount",
          coalesce(array_agg(DISTINCT rc.capability_code) FILTER(WHERE rc.capability_code IS NOT NULL),'{}') AS capabilities
         FROM app.roles r LEFT JOIN app.role_capabilities rc ON rc.tenant_id=r.tenant_id AND rc.role_id=r.id
         LEFT JOIN app.membership_role_assignments a ON a.tenant_id=r.tenant_id AND a.role_id=r.id AND a.status='ACTIVE'
         WHERE r.tenant_id=$1::uuid GROUP BY r.id ORDER BY r.protected DESC,r.name`,
        tenantId,
      );
    });
  }

  async createRole(
    actor: SessionActor,
    input: RoleInput,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.role.admin",
        "ADMIN",
        correlationId,
      );
      await this.validateRoleCapabilities(tx, actor, input.capabilities);
      if (await this.hasPrivilegedCapabilities(tx, input.capabilities)) {
        if (!input.reason || input.reason.trim().length < 10)
          throw new AppError(
            400,
            "PRIVILEGED_REASON_REQUIRED",
            "A reason is required for privileged capabilities",
          );
      }
      const response = await this.idempotent(
        tx,
        actor,
        `access.role.create:${tenantId}`,
        key,
        input,
        async () => {
          const activeCaps = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT code FROM app.capability_catalog WHERE active AND code=ANY($1::text[])`,
            input.capabilities,
          );
          if (activeCaps.length !== new Set(input.capabilities).size)
            throw new AppError(400, "VALIDATION_FAILED", "Unknown capability");
          const rows = await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.roles(tenant_id,code,name,description,portal_audiences,privilege_level)
           VALUES($1::uuid,$2,$3,$4,$5::text[],CASE WHEN EXISTS(SELECT 1 FROM app.capability_catalog WHERE code=ANY($6::text[]) AND privileged) THEN 'PRIVILEGED' ELSE 'STANDARD' END)
           RETURNING id,code,name,version`,
            tenantId,
            input.code,
            input.name,
            input.description,
            input.portalAudiences,
            input.capabilities,
          );
          const role = rows[0]!;
          for (const capability of input.capabilities)
            await tx.$executeRawUnsafe(
              `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code) VALUES($1::uuid,$2::uuid,$3)`,
              tenantId,
              role.id,
              capability,
            );
          await this.audit(
            tx,
            actor,
            "identity.role.created",
            "role",
            String(role.id),
            correlationId,
            input.reason,
            null,
            { capabilities: input.capabilities },
          );
          return role;
        },
      );
      return response;
    });
  }

  private async validateRoleCapabilities(
    tx: Tx,
    actor: SessionActor,
    capabilities: readonly string[],
  ) {
    const tenantId = this.tenant(actor);
    const root = String(
      (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
          tenantId,
        )
      )[0]?.id ?? "",
    );
    const owner = Boolean(
      (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND r.code='TENANT_OWNER' AND a.status='ACTIVE') owner`,
          tenantId,
          actor.membershipId,
        )
      )[0]?.owner,
    );
    const catalogue = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT code,delegable FROM app.capability_catalog WHERE active AND code=ANY($1::text[])`,
      [...capabilities],
    );
    if (catalogue.length !== new Set(capabilities).size)
      throw new AppError(400, "VALIDATION_FAILED", "Unknown capability");
    for (const capability of catalogue) {
      if (!Boolean(capability.delegable) && !owner)
        throw new AppError(
          403,
          "DELEGATION_DENIED",
          "A protected capability cannot be delegated",
        );
      const { decision, assignments } = await this.decide(
        tx,
        actor,
        String(capability.code),
        actionForCapability(String(capability.code)),
        { tenantId, nodeIds: [root] },
      );
      const grant = assignments
        .find((assignment) => assignment.id === decision.assignmentId)
        ?.grants.find((item) => item.nodeId === decision.grantNodeId);
      if (!decision.allowed || grant?.action !== "ADMIN")
        throw new AppError(
          403,
          "DELEGATION_DENIED",
          "You cannot delegate this capability",
        );
    }
  }

  private async hasPrivilegedCapabilities(
    tx: Tx,
    capabilities: readonly string[],
  ) {
    return Boolean(
      (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT EXISTS(SELECT 1 FROM app.capability_catalog WHERE code=ANY($1::text[]) AND active AND privileged) privileged`,
          [...capabilities],
        )
      )[0]?.privileged,
    );
  }

  async updateRole(
    actor: SessionActor,
    roleId: string,
    input: RoleInput & { expectedVersion: number; reason: string },
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.role.admin",
        "ADMIN",
        correlationId,
      );
      await this.validateRoleCapabilities(tx, actor, input.capabilities);
      return this.idempotent(
        tx,
        actor,
        `access.role.update:${tenantId}:${roleId}`,
        key,
        input,
        async () => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            `${tenantId}:role:${roleId}`,
          );
          const before = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,code,name,description,portal_audiences AS "portalAudiences",protected,status,version FROM app.roles WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              roleId,
            )
          )[0];
          if (!before)
            return this.denial(
              tx,
              actor,
              "identity.role.admin",
              "ADMIN",
              roleId,
              correlationId,
            );
          if (before.protected)
            throw new AppError(
              409,
              "PROTECTED_ROLE",
              "The protected owner role cannot be changed",
            );
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Role changed; reload and retry",
            );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.role_capabilities WHERE tenant_id=$1::uuid AND role_id=$2::uuid`,
            tenantId,
            roleId,
          );
          for (const capability of input.capabilities)
            await tx.$executeRawUnsafe(
              `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code) VALUES($1::uuid,$2::uuid,$3)`,
              tenantId,
              roleId,
              capability,
            );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.roles SET code=$1,name=$2,description=$3,portal_audiences=$4::text[],privilege_level=CASE WHEN EXISTS(SELECT 1 FROM app.capability_catalog WHERE code=ANY($5::text[]) AND privileged) THEN 'PRIVILEGED' ELSE 'STANDARD' END,updated_at=now(),version=version+1 WHERE tenant_id=$6::uuid AND id=$7::uuid RETURNING id,code,name,version`,
              input.code,
              input.name,
              input.description,
              input.portalAudiences,
              input.capabilities,
              tenantId,
              roleId,
            )
          )[0]!;
          const affected = await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.tenant_memberships m SET authorization_version=authorization_version+1,updated_at=now() FROM app.membership_role_assignments a WHERE a.tenant_id=$1::uuid AND a.role_id=$2::uuid AND a.membership_id=m.id AND m.tenant_id=a.tenant_id RETURNING m.id`,
            tenantId,
            roleId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='ACCESS_CHANGED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=ANY($2::uuid[]) AND revoked_at IS NULL`,
            tenantId,
            uuidRows(affected),
          );
          await this.audit(
            tx,
            actor,
            "identity.role.updated",
            "role",
            roleId,
            correlationId,
            input.reason,
            before,
            {
              code: input.code,
              capabilities: input.capabilities,
              version: updated.version,
            },
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','role',$2::uuid,'identity.role.changed.v1',$3::jsonb,$4)`,
            tenantId,
            roleId,
            JSON.stringify({
              roleId,
              affectedMembershipIds: uuidRows(affected),
              version: updated.version,
            }),
            `role:${roleId}:v${updated.version}`,
          );
          return { ...updated, affectedSessions: affected.length };
        },
      );
    });
  }

  async deactivateRole(
    actor: SessionActor,
    roleId: string,
    expectedVersion: number,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.role.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.role.deactivate:${tenantId}:${roleId}`,
        key,
        { expectedVersion, reason },
        async () => {
          const role = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,protected,version,status FROM app.roles WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              roleId,
            )
          )[0];
          if (!role)
            return this.denial(
              tx,
              actor,
              "identity.role.admin",
              "ADMIN",
              roleId,
              correlationId,
            );
          if (role.protected)
            throw new AppError(
              409,
              "PROTECTED_ROLE",
              "The protected owner role cannot be deactivated",
            );
          if (Number(role.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Role changed; reload and retry",
            );
          const affected = await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.tenant_memberships m SET authorization_version=authorization_version+1,updated_at=now() FROM app.membership_role_assignments a WHERE a.tenant_id=$1::uuid AND a.role_id=$2::uuid AND a.membership_id=m.id AND m.tenant_id=a.tenant_id RETURNING m.id`,
            tenantId,
            roleId,
          );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.roles SET status='INACTIVE',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,status,version`,
              tenantId,
              roleId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='ACCESS_CHANGED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=ANY($2::uuid[]) AND revoked_at IS NULL`,
            tenantId,
            uuidRows(affected),
          );
          await this.audit(
            tx,
            actor,
            "identity.role.deactivated",
            "role",
            roleId,
            correlationId,
            reason,
            role,
            updated,
          );
          return { ...updated, affectedMemberships: affected.length };
        },
      );
    });
  }

  private async idempotent<T extends Row>(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    key: string,
    input: unknown,
    mutate: () => Promise<T>,
  ): Promise<T & { replayed?: boolean }> {
    if (!key || key.length < 8 || key.length > 200)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key is required",
      );
    const keyHash = sha(key),
      requestHash = sha(stable(input));
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${actor.userId}:${operation}:${keyHash}`,
    );
    const prior = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT request_hash,response_json FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
      actor.activeTenantId,
      actor.userId,
      operation,
      keyHash,
    );
    if (prior[0]) {
      if (prior[0].request_hash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key was used for different input",
        );
      return { ...(prior[0].response_json as T), replayed: true };
    }
    const result = await mutate();
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      actor.activeTenantId,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      result.id ?? null,
      JSON.stringify({ ...result, invitationUrl: undefined }),
    );
    return result;
  }

  private async audit(
    tx: Tx,
    actor: SessionActor,
    action: string,
    targetType: string,
    targetId: string | null,
    correlationId: string,
    reason?: string,
    before?: unknown,
    after?: unknown,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9)`,
      actor.activeTenantId,
      actor.userId,
      action,
      targetType,
      targetId,
      correlationId,
      JSON.stringify(before ?? null),
      JSON.stringify(after ?? null),
      reason ?? null,
    );
  }

  async invite(
    actor: SessionActor,
    input: InviteInput,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.invite:${tenantId}`,
        key,
        input,
        async () => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            `${tenantId}:${input.email ?? input.mobile}`,
          );
          const collision = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND (invited_email=$2 OR invited_mobile=$3)`,
            tenantId,
            input.email ?? null,
            input.mobile ?? null,
          );
          if (collision[0])
            throw new AppError(
              409,
              "IDENTITY_ALREADY_MEMBER",
              "This identity already has tenant access",
            );
          await this.validateAssignments(
            tx,
            tenantId,
            input.assignments,
            input.portalAudience,
          );
          await this.validateDelegation(tx, actor, input.assignments);
          const privileged = Boolean(
            (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT EXISTS(SELECT 1 FROM app.role_capabilities rc JOIN app.capability_catalog c ON c.code=rc.capability_code AND c.active AND c.privileged WHERE rc.tenant_id=$1::uuid AND rc.role_id=ANY($2::uuid[])) privileged`,
                tenantId,
                input.assignments.map((assignment) => assignment.roleId),
              )
            )[0]?.privileged,
          );
          if (privileged && (!input.reason || input.reason.trim().length < 10))
            throw new AppError(
              400,
              "PRIVILEGED_REASON_REQUIRED",
              "A reason is required for privileged access",
            );
          const identities = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.users WHERE ($1::text IS NOT NULL AND email=$1) OR ($2::text IS NOT NULL AND mobile_e164=$2) FOR UPDATE`,
            input.email ?? null,
            input.mobile ?? null,
          );
          if (new Set(uuidRows(identities)).size > 1)
            throw new AppError(
              409,
              "IDENTITY_COLLISION",
              "Email and mobile belong to different identities",
            );
          const membership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.tenant_memberships(tenant_id,invited_email,invited_mobile,invited_name,employee_code,role,portal_audience,status)
             VALUES($1::uuid,$2,$3,$4,$5,null,$6,'INVITED') RETURNING id,version,authorization_version AS "authorizationVersion"`,
              tenantId,
              input.email ?? null,
              input.mobile ?? null,
              input.displayName,
              input.employeeCode,
              input.portalAudience,
            )
          )[0]!;
          await this.replaceAssignments(
            tx,
            tenantId,
            String(membership.id),
            input.assignments,
          );
          const plainToken = opaqueToken();
          const destination = input.email ?? input.mobile!;
          const masked = maskDestination(input.email, input.mobile);
          const invite = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.access_invitations(tenant_id,membership_id,destination_hash,masked_destination,token_hash,expires_at,delivery_state)
             VALUES($1::uuid,$2::uuid,$3,$4,$5,now()+($6||' hours')::interval,'PENDING') RETURNING id,expires_at AS "expiresAt",version`,
              tenantId,
              membership.id,
              sha(destination),
              masked,
              sha(plainToken),
              String(input.expiresInHours),
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
           VALUES($1::uuid,'TENANT','access_invitation',$2::uuid,'identity.invitation.requested.v1',$3::jsonb,$4)`,
            tenantId,
            invite.id,
            JSON.stringify({
              invitationId: invite.id,
              maskedDestination: masked,
              expiresAt: invite.expiresAt,
            }),
            `access-invitation:${invite.id}:v1`,
          );
          await this.audit(
            tx,
            actor,
            "identity.invitation.created",
            "membership",
            String(membership.id),
            correlationId,
            input.reason,
            null,
            {
              roleIds: input.assignments.map((a) => a.roleId),
              maskedDestination: masked,
            },
          );
          if (this.app.config.ENABLE_TEST_HOOKS === "true")
            await tx.$executeRawUnsafe(
              `UPDATE app.tenant_configuration
               SET value=jsonb_set(value-'fixtureMfaPolicyAfterInvitation','{mfaPolicy}',to_jsonb(value->>'fixtureMfaPolicyAfterInvitation')),version=version+1,updated_at=now()
               WHERE tenant_id=$1::uuid AND namespace='security' AND value->>'fixtureMfaPolicyAfterInvitation'='ALL'`,
              tenantId,
            );
          return {
            id: String(membership.id),
            membershipId: String(membership.id),
            invitationId: String(invite.id),
            maskedDestination: masked,
            expiresAt: invite.expiresAt,
            state: "PENDING",
            ...(this.app.config.ENABLE_TEST_HOOKS === "true"
              ? {
                  invitationUrl: `${this.app.config.FRONTEND_URL}/accept-access?token=${plainToken}`,
                }
              : {}),
          };
        },
      );
    });
  }

  async invitationPreview(invitationToken: string) {
    return withPlatform(this.app.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.masked_destination AS "maskedDestination",i.expires_at AS "expiresAt",i.authentication_method AS "authenticationMethod",
          t.name AS "tenantName",t.short_name AS "shortName",t.timezone,
          EXISTS(SELECT 1 FROM app.users u
            WHERE (m.invited_email IS NOT NULL AND u.email=m.invited_email)
               OR (m.invited_mobile IS NOT NULL AND u.mobile_e164=m.invited_mobile)) AS "existingIdentity",
          m.portal_audience AS "portalAudience"
         FROM app.access_invitations i JOIN app.tenants t ON t.id=i.tenant_id
         JOIN app.tenant_memberships m ON m.tenant_id=i.tenant_id AND m.id=i.membership_id
         WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND t.status='ACTIVE'`,
        sha(invitationToken),
      );
      if (!rows[0])
        throw new AppError(
          404,
          "INVITATION_INVALID",
          "Invitation is invalid or expired",
        );
      return { ...rows[0], mfaRequired: false };
    });
  }

  async resendInvitation(
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenantId}:membership:${membershipId}:invitation-rotation`,
      );
      return this.idempotent(
        tx,
        actor,
        `access.invitation.resend:${tenantId}:${membershipId}`,
        key,
        { expectedVersion, reason },
        async () => {
          const membership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,version,invited_email AS email,invited_mobile AS mobile,status FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (!membership)
            return this.denial(
              tx,
              actor,
              "identity.user.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          if (Number(membership.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Invitation changed; reload and retry",
            );
          if (membership.status !== "INVITED")
            throw new AppError(
              409,
              "INVITATION_STATE_INVALID",
              "Only pending invitations can be resent",
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.access_invitations SET revoked_at=coalesce(revoked_at,now()),delivery_state='REVOKED',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND used_at IS NULL AND revoked_at IS NULL`,
            tenantId,
            membershipId,
          );
          const plain = opaqueToken();
          const masked = maskDestination(
            membership.email ? String(membership.email) : undefined,
            membership.mobile ? String(membership.mobile) : undefined,
          );
          const invite = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.access_invitations(tenant_id,membership_id,destination_hash,masked_destination,token_hash,expires_at,delivery_state)
             VALUES($1::uuid,$2::uuid,$3,$4,$5,now()+($6||' hours')::interval,'PENDING') RETURNING id,version,expires_at AS "expiresAt"`,
              tenantId,
              membershipId,
              sha(String(membership.email ?? membership.mobile)),
              masked,
              sha(plain),
              String(this.app.config.INVITATION_TTL_HOURS),
            )
          )[0]!;
          const updatedMembership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET version=version+1,updated_at=now()
               WHERE tenant_id=$1::uuid AND id=$2::uuid AND version=$3
               RETURNING version`,
              tenantId,
              membershipId,
              expectedVersion,
            )
          )[0];
          if (!updatedMembership)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Invitation changed; reload and retry",
            );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','access_invitation',$2::uuid,'identity.invitation.requested.v1',$3::jsonb,$4)`,
            tenantId,
            invite.id,
            JSON.stringify({
              invitationId: invite.id,
              maskedDestination: masked,
              expiresAt: invite.expiresAt,
            }),
            `access-invitation:${invite.id}:v${invite.version}`,
          );
          await this.audit(
            tx,
            actor,
            "identity.invitation.resent",
            "membership",
            membershipId,
            correlationId,
            reason,
            null,
            { invitationId: invite.id, maskedDestination: masked },
          );
          return {
            id: String(invite.id),
            membershipId,
            maskedDestination: masked,
            expiresAt: invite.expiresAt,
            version: Number(updatedMembership.version),
            invitationUrl: `${this.app.config.FRONTEND_URL}/accept-access?token=${plain}`,
          };
        },
      );
    });
  }

  async revokeInvitation(
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.invitation.revoke:${tenantId}:${membershipId}`,
        key,
        { expectedVersion, reason },
        async () => {
          const membership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,version,status FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (!membership)
            return this.denial(
              tx,
              actor,
              "identity.user.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          if (Number(membership.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Invitation changed; reload and retry",
            );
          const revoked = await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.access_invitations SET revoked_at=now(),delivery_state='REVOKED',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
            tenantId,
            membershipId,
          );
          if (!revoked[0])
            throw new AppError(
              409,
              "INVITATION_STATE_INVALID",
              "Invitation is no longer active",
            );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET version=version+1,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,version,status`,
              tenantId,
              membershipId,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "identity.invitation.revoked",
            "membership",
            membershipId,
            correlationId,
            reason,
          );
          return updated;
        },
      );
    });
  }

  async acceptInvitation(
    invitationToken: string,
    input: {
      displayName: string;
      password?: string;
      currentPassword?: string;
    },
    correlationId: string,
  ) {
    return withPlatform(this.app.db, async (tx) => {
      const invite = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT i.id,i.tenant_id AS "tenantId",i.membership_id AS "membershipId",m.invited_email AS email,m.invited_mobile AS mobile,m.portal_audience AS "portalAudience"
           FROM app.access_invitations i JOIN app.tenants t ON t.id=i.tenant_id
           JOIN app.tenant_memberships m ON m.tenant_id=i.tenant_id AND m.id=i.membership_id
           WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND t.status='ACTIVE' FOR UPDATE OF i`,
          sha(invitationToken),
        )
      )[0];
      if (!invite)
        throw new AppError(
          404,
          "INVITATION_INVALID",
          "Invitation is invalid or expired",
        );
      const existingRows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,password_hash AS "passwordHash",status FROM app.users WHERE ($1::text IS NOT NULL AND email=$1) OR ($2::text IS NOT NULL AND mobile_e164=$2) FOR UPDATE`,
        invite.email ?? null,
        invite.mobile ?? null,
      );
      if (new Set(uuidRows(existingRows)).size > 1)
        throw new AppError(
          409,
          "IDENTITY_COLLISION",
          "Invitation identity could not be linked safely",
        );
      const existing = existingRows[0];
      let userId: string;
      if (existing) {
        if (
          existing.status !== "ACTIVE" ||
          !input.currentPassword ||
          !(await argon2.verify(
            String(existing.passwordHash),
            input.currentPassword,
          ))
        ) {
          const attempts = await this.recordSecurityFailure(
            String(invite.tenantId),
            null,
            null,
            "INVITATION_ACCEPTANCE_FAILED",
            correlationId,
            String(invite.id),
          );
          if (attempts >= 5)
            throw new AppError(
              429,
              "INVITATION_THROTTLED",
              "Invitation or credentials could not be verified",
            );
          throw new AppError(
            401,
            "INVITATION_ACCEPTANCE_FAILED",
            "Invitation or credentials could not be verified",
          );
        }
        userId = String(existing.id);
      } else {
        if (!input.password || input.password.length < 12)
          throw new AppError(
            400,
            "VALIDATION_FAILED",
            "A strong password is required",
            { password: ["Use at least 12 characters"] },
          );
        const passwordHash = await argon2.hash(input.password, {
          type: argon2.argon2id,
        });
        userId = String(
          (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.users(email,mobile_e164,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id`,
              invite.email ?? null,
              invite.mobile ?? null,
              input.displayName,
              passwordHash,
            )
          )[0]!.id,
        );
      }
      const collision = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND id<>$3::uuid`,
        invite.tenantId,
        userId,
        invite.membershipId,
      );
      if (collision[0])
        throw new AppError(
          409,
          "IDENTITY_ALREADY_MEMBER",
          "This identity already has tenant access",
        );
      await tx.$executeRawUnsafe(
        `UPDATE app.tenant_memberships SET user_id=$1::uuid,invited_name=$2,status='ACTIVE',authorization_version=authorization_version+1,version=version+1,updated_at=now() WHERE tenant_id=$3::uuid AND id=$4::uuid`,
        userId,
        input.displayName,
        invite.tenantId,
        invite.membershipId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.access_invitations SET used_at=now(),delivery_state='ACCEPTED',updated_at=now(),version=version+1 WHERE id=$1::uuid`,
        invite.id,
      );
      const policy =
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT coalesce(value->>'mfaPolicy','OFF') policy FROM app.tenant_configuration WHERE tenant_id=$1::uuid AND namespace='security'`,
            invite.tenantId,
          )
        )[0]?.policy ?? "OFF";
      const privileged = Boolean(
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND r.privilege_level IN ('PRIVILEGED','PROTECTED')) required`,
            invite.tenantId,
            invite.membershipId,
          )
        )[0]?.required,
      );
      const mfaRequired =
        policy === "ALL" || (policy === "PRIVILEGED" && privileged);
      const created = await this.app.newSession(
        tx,
        userId,
        String(invite.tenantId),
        0,
        mfaRequired ? "RESTRICTED_MFA" : "PASSWORD",
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json)
         VALUES($1::uuid,$2::uuid,'identity.invitation.accepted','membership',$3::uuid,$4,$5::jsonb)`,
        invite.tenantId,
        userId,
        invite.membershipId,
        correlationId,
        JSON.stringify({ portalAudience: invite.portalAudience }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','membership',$2::uuid,'identity.invitation.accepted.v1',$3::jsonb,$4)`,
        invite.tenantId,
        invite.membershipId,
        JSON.stringify({ membershipId: invite.membershipId }),
        `invitation-accepted:${invite.id}:v1`,
      );
      return {
        ...created,
        activeTenantId: invite.tenantId,
        home: portalHome(
          invite.portalAudience as "INTERNAL" | "VENDOR" | "DRIVER" | "CLIENT",
        ),
        mfaRequired,
      };
    });
  }

  private async validateAssignments(
    tx: Tx,
    tenantId: string,
    assignments: InviteInput["assignments"] | AccessInput["assignments"],
    audience?: string,
  ) {
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const nodeIds = [
      ...new Set(
        assignments.flatMap((a) => a.grants.map((g) => g.scopeNodeId)),
      ),
    ];
    const roles = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND status='ACTIVE' AND ($3::text IS NULL OR portal_audiences @> ARRAY[$3]::text[])`,
      tenantId,
      roleIds,
      audience ?? null,
    );
    const nodes = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
      tenantId,
      nodeIds,
    );
    if (roles.length !== roleIds.length || nodes.length !== nodeIds.length)
      throw new AppError(400, "VALIDATION_FAILED", "Role or scope is invalid");
  }

  private async validateDelegation(
    tx: Tx,
    actor: SessionActor,
    assignments: InviteInput["assignments"] | AccessInput["assignments"],
  ) {
    const tenantId = this.tenant(actor);
    const actorOwner = Boolean(
      (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND r.code='TENANT_OWNER') owner`,
          tenantId,
          actor.membershipId,
        )
      )[0]?.owner,
    );
    for (const proposed of assignments) {
      const capabilities = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT c.code,c.delegable FROM app.role_capabilities rc JOIN app.capability_catalog c ON c.code=rc.capability_code AND c.active WHERE rc.tenant_id=$1::uuid AND rc.role_id=$2::uuid`,
        tenantId,
        proposed.roleId,
      );
      for (const row of capabilities) {
        if (!Boolean(row.delegable) && !actorOwner)
          throw new AppError(
            403,
            "DELEGATION_DENIED",
            "A protected capability cannot be delegated",
          );
        for (const grant of proposed.grants) {
          if (actorOwner) {
            const ownerDelegation = Boolean(
              (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `SELECT EXISTS(
                     SELECT 1
                     FROM app.membership_role_assignments a
                     JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.code='TENANT_OWNER' AND r.status='ACTIVE'
                     JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$3
                     JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE'
                       AND g.action='ADMIN' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
                     WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
                       AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
                       AND EXISTS(
                         WITH RECURSIVE ancestors AS (
                           SELECT id,parent_id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$4::uuid AND status='ACTIVE'
                           UNION ALL
                           SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors x ON x.parent_id=n.id
                           WHERE n.tenant_id=$1::uuid AND n.status='ACTIVE'
                         ) SELECT 1 FROM ancestors WHERE id=g.scope_node_id
                       )
                   ) allowed`,
                  tenantId,
                  actor.membershipId,
                  String(row.code),
                  grant.scopeNodeId,
                )
              )[0]?.allowed,
            );
            if (!ownerDelegation)
              throw new AppError(
                403,
                "DELEGATION_DENIED",
                "Delegation requires Tenant Owner ADMIN on the assigned scope",
              );
            continue;
          }
          const { decision } = await this.decide(
            tx,
            actor,
            String(row.code),
            actionForCapability(String(row.code)),
            { tenantId, nodeIds: [grant.scopeNodeId] },
          );
          if (!decision.allowed)
            throw new AppError(
              403,
              "DELEGATION_DENIED",
              "You cannot delegate this capability and scope",
            );
          const assignment = (await this.policyData(tx, actor)).find(
            (candidate) => candidate.id === decision.assignmentId,
          );
          const matched = assignment?.grants.find(
            (candidate) => candidate.nodeId === decision.grantNodeId,
          );
          if (matched?.action !== "ADMIN")
            throw new AppError(
              403,
              "DELEGATION_DENIED",
              "Delegation requires ADMIN on the assigned scope",
            );
        }
      }
    }
  }

  private async replaceAssignments(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    assignments: InviteInput["assignments"] | AccessInput["assignments"],
  ) {
    await tx.$executeRawUnsafe(
      `DELETE FROM app.scope_grants WHERE tenant_id=$1::uuid AND assignment_id IN (SELECT id FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid)`,
      tenantId,
      membershipId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid`,
      tenantId,
      membershipId,
    );
    for (const assignment of assignments) {
      const assignmentRow = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
          tenantId,
          membershipId,
          assignment.roleId,
        )
      )[0]!;
      for (const grant of assignment.grants)
        for (const action of [...new Set(grant.actions)])
          await tx.$executeRawUnsafe(
            `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,
            tenantId,
            assignmentRow.id,
            grant.scopeNodeId,
            action,
          );
    }
  }

  async listUsers(
    actor: SessionActor,
    search: string,
    status: string,
    page: number,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.read",
        "READ",
        correlationId,
      );
      const p = Math.max(1, page),
        validStatus = ["INVITED", "ACTIVE", "SUSPENDED"].includes(status)
          ? status
          : null;
      const params = [
        tenantId,
        search.trim(),
        `%${search.trim()}%`,
        validStatus,
        (p - 1) * 25,
      ];
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT m.id,m.employee_code AS "employeeCode",m.invited_name AS "displayName",m.status,m.portal_audience AS "portalAudience",m.authorization_version AS "authorizationVersion",m.version,
          CASE WHEN m.invited_email IS NOT NULL THEN left(m.invited_email,1)||'***@'||split_part(m.invited_email,'@',2) ELSE '+••••••'||right(m.invited_mobile,2) END AS identifier,
          count(DISTINCT a.role_id)::int AS "roleCount",coalesce(array_agg(DISTINCT r.name) FILTER(WHERE r.name IS NOT NULL),'{}') AS roles,
          count(DISTINCT s.id) FILTER(WHERE s.revoked_at IS NULL AND s.expires_at>now())::int AS "activeSessions"
         FROM app.tenant_memberships m
         LEFT JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
         LEFT JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
         LEFT JOIN app.sessions s ON s.active_tenant_id=m.tenant_id AND s.membership_id=m.id
         WHERE m.tenant_id=$1::uuid AND ($2='' OR m.invited_name ILIKE $3 OR m.employee_code ILIKE $3) AND ($4::text IS NULL OR m.status=$4)
         GROUP BY m.id ORDER BY m.invited_name,m.id LIMIT 25 OFFSET $5`,
        ...params,
      );
      const total = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(*)::int total FROM app.tenant_memberships m WHERE m.tenant_id=$1::uuid AND ($2='' OR m.invited_name ILIKE $3 OR m.employee_code ILIKE $3) AND ($4::text IS NULL OR m.status=$4)`,
        tenantId,
        search.trim(),
        `%${search.trim()}%`,
        validStatus,
      );
      return {
        items,
        total: Number(total[0]?.total ?? 0),
        page: p,
        pageSize: 25,
        asOf: new Date().toISOString(),
      };
    });
  }

  async userDetail(
    actor: SessionActor,
    membershipId: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.read",
        "READ",
        correlationId,
      );
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT m.id,m.employee_code AS "employeeCode",m.invited_name AS "displayName",m.status,m.portal_audience AS "portalAudience",m.authorization_version AS "authorizationVersion",m.version,
          CASE WHEN m.invited_email IS NULL THEN null ELSE left(m.invited_email,1)||'***@'||split_part(m.invited_email,'@',2) END AS email,
          CASE WHEN m.invited_mobile IS NULL THEN null ELSE '+••••••'||right(m.invited_mobile,2) END AS mobile,
          coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'assignmentId',a.id,
              'roleId',r.id,
              'roleName',r.name,
              'grants',coalesce((
                SELECT jsonb_agg(jsonb_build_object('scopeNodeId',grouped_grant.scope_node_id,'actions',grouped_grant.actions))
                FROM (
                  SELECT g.scope_node_id,array_agg(g.action ORDER BY g.action) actions
                  FROM app.scope_grants g
                  WHERE g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE'
                    AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
                  GROUP BY g.scope_node_id
                ) grouped_grant
              ),'[]'::jsonb)
            ) ORDER BY r.name,a.id)
            FROM app.membership_role_assignments a
            JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
            WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
              AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
          ),'[]'::jsonb) assignments
         FROM app.tenant_memberships m
         WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid`,
        tenantId,
        membershipId,
      );
      if (!rows[0])
        return this.denial(
          tx,
          actor,
          "identity.user.read",
          "READ",
          membershipId,
          correlationId,
        );
      return rows[0];
    });
  }

  async preview(
    actor: SessionActor,
    membershipId: string,
    input: PreviewInput,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      const membership = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT version,authorization_version AS "authorizationVersion",portal_audience AS "portalAudience" FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantId,
          membershipId,
        )
      )[0];
      if (!membership)
        return this.denial(
          tx,
          actor,
          "identity.user.admin",
          "ADMIN",
          membershipId,
          correlationId,
        );
      await this.validateAssignments(
        tx,
        tenantId,
        input.assignments,
        String(membership.portalAudience),
      );
      await this.validateDelegation(tx, actor, input.assignments);
      if (Number(membership.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Access changed; reload and retry",
        );
      const fingerprint = await this.previewFingerprint(
        tx,
        actor,
        membershipId,
        input.expectedVersion,
        input.assignments,
      );
      return {
        fingerprint,
        decisions: await this.previewDecisions(tx, tenantId, input.assignments),
        authorizationVersion: membership.authorizationVersion,
      };
    });
  }

  private async previewDecisions(
    tx: Tx,
    tenantId: string,
    proposed: PreviewInput["assignments"],
  ) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT r.id role_id,r.name,coalesce(array_agg(DISTINCT rc.capability_code),'{}') capabilities
       FROM app.roles r
       JOIN app.role_capabilities rc ON rc.tenant_id=r.tenant_id AND rc.role_id=r.id
       JOIN app.capability_catalog cc ON cc.code=rc.capability_code AND cc.active
       WHERE r.tenant_id=$1::uuid AND r.id=ANY($2::uuid[]) AND r.status='ACTIVE'
       GROUP BY r.id`,
      tenantId,
      proposed.map((p) => p.roleId),
    );
    const policyAssignments: PolicyAssignment[] = proposed.map((assignment) => {
      const role = rows.find((r) => String(r.role_id) === assignment.roleId);
      return {
        id: assignment.roleId,
        active: true,
        capabilities: (role?.capabilities as string[]) ?? [],
        grants: assignment.grants.flatMap((grant) =>
          grant.actions.map((action) => ({
            nodeId: grant.scopeNodeId,
            action,
            active: true,
          })),
        ),
      };
    });
    return proposed.flatMap((assignment) => {
      const role = rows.find((r) => String(r.role_id) === assignment.roleId);
      return assignment.grants.flatMap((grant) =>
        ((role?.capabilities as string[]) ?? []).map((capability) => {
          const action = actionForCapability(capability);
          const decision = evaluatePolicy({
            tenantId,
            userId: "preview-target",
            capability,
            action,
            assignments: policyAssignments,
            resource: { tenantId, nodeIds: [grant.scopeNodeId] },
            ancestorsByNode: { [grant.scopeNodeId]: [] },
            identityActive: true,
            membershipActive: true,
            sessionCurrent: true,
          });
          return {
            capability,
            action,
            scopeNodeId: grant.scopeNodeId,
            allowed: decision.allowed,
            reason: decision.reason,
            role: role?.name,
          };
        }),
      );
    });
  }

  private async previewFingerprint(
    tx: Tx,
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    assignments: PreviewInput["assignments"],
  ) {
    const roleVersions = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT id,version FROM app.roles WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id`,
      actor.activeTenantId,
      assignments.map((assignment) => assignment.roleId),
    );
    const catalogue = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT max(introduced_version)::int version,count(*)::int count FROM app.capability_catalog WHERE active`,
      )
    )[0];
    return sha(
      stable({
        tenantId: actor.activeTenantId,
        membershipId,
        expectedVersion,
        actorVersion: actor.membershipAuthVersion,
        assignments,
        roleVersions,
        catalogue,
      }),
    );
  }

  async updateAccess(
    actor: SessionActor,
    membershipId: string,
    input: AccessInput,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.user.update:${tenantId}:${membershipId}`,
        key,
        input,
        async () => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            `${tenantId}:membership:${membershipId}`,
          );
          const beforeRows = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT version,authorization_version AS "authorizationVersion",status,portal_audience AS "portalAudience" FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
            tenantId,
            membershipId,
          );
          const before = beforeRows[0];
          if (!before)
            return this.denial(
              tx,
              actor,
              "identity.user.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          await this.validateAssignments(
            tx,
            tenantId,
            input.assignments,
            String(before.portalAudience),
          );
          await this.validateDelegation(tx, actor, input.assignments);
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Access changed; reload and retry",
            );
          const expectedFingerprint = await this.previewFingerprint(
            tx,
            actor,
            membershipId,
            input.expectedVersion,
            input.assignments,
          );
          if (expectedFingerprint !== input.previewFingerprint)
            throw new AppError(
              409,
              "PREVIEW_STALE",
              "Preview changed; review access again",
            );
          await this.protectFinalOwner(
            tx,
            tenantId,
            membershipId,
            input.assignments,
          );
          await this.replaceAssignments(
            tx,
            tenantId,
            membershipId,
            input.assignments,
          );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,version,authorization_version AS "authorizationVersion",status`,
              tenantId,
              membershipId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='ACCESS_CHANGED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid AND revoked_at IS NULL`,
            tenantId,
            membershipId,
          );
          await this.audit(
            tx,
            actor,
            "identity.access.changed",
            "membership",
            membershipId,
            correlationId,
            input.reason,
            before,
            {
              roleIds: input.assignments.map((a) => a.roleId),
              authorizationVersion: updated.authorizationVersion,
            },
          );
          const privileged = Boolean(
            (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT EXISTS(SELECT 1 FROM app.role_capabilities rc JOIN app.capability_catalog c ON c.code=rc.capability_code AND c.active AND c.privileged WHERE rc.tenant_id=$1::uuid AND rc.role_id=ANY($2::uuid[])) privileged`,
                tenantId,
                input.assignments.map((assignment) => assignment.roleId),
              )
            )[0]?.privileged,
          );
          if (privileged)
            await this.alert(
              tx,
              tenantId,
              "PRIVILEGED_ACCESS_GRANTED",
              membershipId,
              `privileged:${membershipId}:${updated.authorizationVersion}`,
            );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key) VALUES($1::uuid,'TENANT','membership',$2::uuid,'identity.access.changed.v1',$3::jsonb,$4)`,
            tenantId,
            membershipId,
            JSON.stringify({
              membershipId,
              authorizationVersion: updated.authorizationVersion,
            }),
            `access:${membershipId}:v${updated.authorizationVersion}`,
          );
          return updated;
        },
      );
    });
  }

  private async protectFinalOwner(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    assignments: AccessInput["assignments"],
  ) {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:final-owner`,
    );
    const ownerRole = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id FROM app.roles WHERE tenant_id=$1::uuid AND code='TENANT_OWNER'`,
        tenantId,
      )
    )[0];
    const root = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT' AND status='ACTIVE'`,
        tenantId,
      )
    )[0];
    const keepsOwnerFloor = Boolean(
      ownerRole &&
        root &&
        assignments.some(
          (assignment) =>
            assignment.roleId === String(ownerRole.id) &&
            assignment.grants.some(
              (grant) =>
                grant.scopeNodeId === String(root.id) &&
                grant.actions.includes("ADMIN"),
            ),
        ),
    );
    if (ownerRole && !keepsOwnerFloor) {
      const owners = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT count(DISTINCT m.id)::int count FROM app.tenant_memberships m
         JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
         JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.code='TENANT_OWNER' AND r.status='ACTIVE' AND r.protected
         JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action='ADMIN'
         JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.scope_type='TENANT' AND n.status='ACTIVE'
         WHERE m.tenant_id=$1::uuid AND m.status='ACTIVE' AND m.id<>$2::uuid`,
        tenantId,
        membershipId,
      );
      if (Number(owners[0]?.count ?? 0) < 1)
        throw new AppError(
          409,
          "FINAL_OWNER_REQUIRED",
          "The tenant must retain an active owner",
        );
    }
  }

  async lifecycle(
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    status: "ACTIVE" | "SUSPENDED",
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.user.${status.toLowerCase()}:${tenantId}:${membershipId}`,
        key,
        { membershipId, expectedVersion, reason, status },
        async () => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            `${tenantId}:final-owner`,
          );
          const current = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,status,version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (!current)
            return this.denial(
              tx,
              actor,
              "identity.user.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          if (Number(current.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Access changed; reload and retry",
            );
          if (status === "SUSPENDED")
            await this.protectFinalOwner(tx, tenantId, membershipId, []);
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET status=$1,authorization_version=authorization_version+1,version=version+1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING id,status,version,authorization_version AS "authorizationVersion"`,
              status,
              tenantId,
              membershipId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason=$1,updated_at=now(),version=version+1 WHERE active_tenant_id=$2::uuid AND membership_id=$3::uuid AND revoked_at IS NULL`,
            status === "SUSPENDED"
              ? "MEMBERSHIP_SUSPENDED"
              : "MEMBERSHIP_REACTIVATED",
            tenantId,
            membershipId,
          );
          await this.audit(
            tx,
            actor,
            `identity.membership.${status.toLowerCase()}`,
            "membership",
            membershipId,
            correlationId,
            reason,
            current,
            updated,
          );
          return updated;
        },
      );
    });
  }

  async resetSessions(
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.session.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.sessions.reset:${tenantId}:${membershipId}`,
        key,
        { expectedVersion, reason },
        async () => {
          const membership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (!membership)
            return this.denial(
              tx,
              actor,
              "identity.session.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          if (Number(membership.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Access changed; reload and retry",
            );
          const rows = await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='ADMIN_RESET',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=$2::uuid AND revoked_at IS NULL RETURNING id`,
            tenantId,
            membershipId,
          );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING version,authorization_version AS "authorizationVersion"`,
              tenantId,
              membershipId,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "identity.sessions.reset",
            "membership",
            membershipId,
            correlationId,
            reason,
            null,
            { revokedCount: rows.length },
          );
          return {
            id: membershipId,
            revokedCount: rows.length,
            version: updated.version,
            authorizationVersion: updated.authorizationVersion,
          };
        },
      );
    });
  }

  async resetMfa(
    actor: SessionActor,
    membershipId: string,
    expectedVersion: number,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.mfa.admin",
        "ADMIN",
        correlationId,
      );
      return this.idempotent(
        tx,
        actor,
        `access.mfa.reset:${tenantId}:${membershipId}`,
        key,
        { expectedVersion, reason },
        async () => {
          const membership = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id,user_id AS "userId",version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              membershipId,
            )
          )[0];
          if (!membership)
            return this.denial(
              tx,
              actor,
              "identity.mfa.admin",
              "ADMIN",
              membershipId,
              correlationId,
            );
          if (Number(membership.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Access changed; reload and retry",
            );
          if (!membership.userId)
            throw new AppError(
              409,
              "MEMBERSHIP_NOT_ACTIVE",
              "The invited identity has not activated access",
            );
          const factors = await tx.$queryRawUnsafe<Array<Row>>(
            `UPDATE app.mfa_factors SET disabled_at=now(),updated_at=now(),version=version+1 WHERE user_id=$1::uuid AND disabled_at IS NULL RETURNING id`,
            membership.userId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.users SET auth_version=auth_version+1,updated_at=now() WHERE id=$1::uuid`,
            membership.userId,
          );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id,version,authorization_version AS "authorizationVersion"`,
              tenantId,
              membershipId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.sessions SET revoked_at=now(),revoked_reason='MFA_RESET',updated_at=now(),version=version+1 WHERE user_id=$1::uuid AND revoked_at IS NULL`,
            membership.userId,
          );
          await this.audit(
            tx,
            actor,
            "identity.mfa.reset",
            "membership",
            membershipId,
            correlationId,
            reason,
            null,
            {
              disabledFactors: factors.length,
              authorizationVersion: updated.authorizationVersion,
            },
          );
          await this.alert(
            tx,
            tenantId,
            "MFA_POLICY_GAP",
            membershipId,
            `mfa-gap:${membershipId}:v${updated.authorizationVersion}`,
          );
          return { ...updated, disabledFactors: factors.length };
        },
      );
    });
  }

  private async alert(
    tx: Tx,
    tenantId: string,
    type: string,
    membershipId: string | null,
    dedup: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.security_alerts(tenant_id,alert_type,severity,deduplication_key,membership_id)
       VALUES($1::uuid,$2,'HIGH',$3,$4::uuid) ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET occurrence_count=app.security_alerts.occurrence_count+1,last_seen_at=now(),updated_at=now()`,
      tenantId,
      type,
      dedup,
      membershipId,
    );
  }

  async createProbe(
    actor: SessionActor,
    input: ProbeInput,
    key: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const rootResource = {
        tenantId,
        nodeIds: input.scopeNodeIds,
        assignedUserId: input.assignedUserId,
        requiresCurrentAssignment: input.resourceType === "TRIP",
      };
      const { decision } = await this.decide(
        tx,
        actor,
        "probe.create",
        "CREATE",
        rootResource,
      );
      if (!decision.allowed)
        return this.denial(
          tx,
          actor,
          "probe.create",
          "CREATE",
          input.scopeNodeIds.join(","),
          correlationId,
        );
      return this.idempotent(
        tx,
        actor,
        `access.probe.create:${tenantId}`,
        key,
        input,
        async () => {
          const valid = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
            tenantId,
            input.scopeNodeIds,
          );
          if (valid.length !== new Set(input.scopeNodeIds).size)
            throw new AppError(400, "VALIDATION_FAILED", "Scope is invalid");
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.authorization_probe_records(tenant_id,label,resource_type,scope_node_ids,assigned_user_id,status,tax_identifier,mobile,bank_detail,commercial_rate_minor,payment_minor,internal_margin_minor) VALUES($1::uuid,$2,$3,$4::uuid[],$5::uuid,$6,$7,$8,$9,$10,$11,$12) RETURNING id,label,status,version`,
              tenantId,
              input.label,
              input.resourceType,
              input.scopeNodeIds,
              input.assignedUserId ?? null,
              input.status,
              input.taxIdentifier ?? null,
              input.mobile ?? null,
              input.bankDetail ?? null,
              input.commercialRateMinor ?? null,
              input.paymentMinor ?? null,
              input.internalMarginMinor ?? null,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "probe.created",
            "authorization_probe",
            String(row.id),
            correlationId,
            undefined,
            null,
            { label: input.label, scopeNodeIds: input.scopeNodeIds },
          );
          return row;
        },
      );
    });
  }

  private async sensitiveAllowed(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    nodes: string[],
  ) {
    return (
      await this.decide(tx, actor, capability, "READ", {
        tenantId: this.tenant(actor),
        nodeIds: nodes,
      })
    ).decision.allowed;
  }

  private async serializeProbe(tx: Tx, actor: SessionActor, row: Row) {
    const nodes = row.scopeNodeIds as string[];
    const minor = (value: unknown) =>
      value === null || value === undefined ? null : Number(value);
    return {
      id: row.id,
      label: row.label,
      status: row.status,
      version: row.version,
      scopeNodeIds: nodes,
      taxIdentifier: maskSensitive(
        "tax_identifier",
        row.taxIdentifier as string | null,
        await this.sensitiveAllowed(
          tx,
          actor,
          "sensitive.tax_identifier.read",
          nodes,
        ),
      ),
      mobile: maskSensitive(
        "mobile",
        row.mobile as string | null,
        await this.sensitiveAllowed(tx, actor, "sensitive.mobile.read", nodes),
      ),
      bankDetail: maskSensitive(
        "bank_detail",
        row.bankDetail as string | null,
        await this.sensitiveAllowed(
          tx,
          actor,
          "sensitive.bank_detail.read",
          nodes,
        ),
      ),
      commercialRate: maskSensitive(
        "commercial_rate",
        minor(row.commercialRateMinor),
        await this.sensitiveAllowed(
          tx,
          actor,
          "sensitive.commercial_rate.read",
          nodes,
        ),
      ),
      payment: maskSensitive(
        "payment",
        minor(row.paymentMinor),
        await this.sensitiveAllowed(tx, actor, "sensitive.payment.read", nodes),
      ),
      internalMargin:
        (await this.portalAudience(tx, actor)) === "INTERNAL"
          ? maskSensitive(
              "internal_margin",
              minor(row.internalMarginMinor),
              await this.sensitiveAllowed(
                tx,
                actor,
                "sensitive.internal_margin.read",
                nodes,
              ),
            )
          : { value: null, masked: true },
    };
  }

  private scopePredicate(userPlaceholder: string) {
    return `EXISTS (
      SELECT 1 FROM app.membership_role_assignments a
      JOIN app.roles role ON role.tenant_id=a.tenant_id AND role.id=a.role_id AND role.status='ACTIVE'
      JOIN app.role_capabilities rc ON rc.tenant_id=a.tenant_id AND rc.role_id=a.role_id AND rc.capability_code=$3
      JOIN app.capability_catalog cc ON cc.code=rc.capability_code AND cc.active
      JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ($4,'ADMIN')
      WHERE a.tenant_id=p.tenant_id AND a.membership_id=$2::uuid AND a.status='ACTIVE'
        AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
        AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
        AND EXISTS (
          WITH RECURSIVE anc(id,parent_id) AS (
            SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n WHERE n.tenant_id=p.tenant_id AND n.id=ANY(p.scope_node_ids)
            UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN anc ON n.id=anc.parent_id WHERE n.tenant_id=p.tenant_id
          ) SELECT 1 FROM anc WHERE anc.id=g.scope_node_id
        )
        AND (
          NOT EXISTS(SELECT 1 FROM app.authorization_scope_nodes gn WHERE gn.tenant_id=g.tenant_id AND gn.id=g.scope_node_id AND gn.scope_type='ASSIGNED_TRIP')
          OR p.assigned_user_id=${userPlaceholder}::uuid
        )
        AND (
          NOT EXISTS(SELECT 1 FROM app.tenant_memberships dm WHERE dm.tenant_id=p.tenant_id AND dm.id=$2::uuid AND dm.portal_audience='DRIVER')
          OR p.resource_type<>'TRIP' OR p.assigned_user_id=${userPlaceholder}::uuid
        )
    )`;
  }

  private async portalAudience(tx: Tx, actor: SessionActor) {
    const row = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT portal_audience AS audience FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        actor.activeTenantId,
        actor.membershipId,
      )
    )[0];
    return String(row?.audience ?? "INTERNAL");
  }

  async listProbes(
    actor: SessionActor,
    search: string,
    _correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertCurrent(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT p.id,p.label,p.status,p.version,p.resource_type AS "resourceType",p.assigned_user_id AS "assignedUserId",p.scope_node_ids AS "scopeNodeIds",p.tax_identifier AS "taxIdentifier",p.mobile,p.bank_detail AS "bankDetail",p.commercial_rate_minor AS "commercialRateMinor",p.payment_minor AS "paymentMinor",p.internal_margin_minor AS "internalMarginMinor"
         FROM app.authorization_probe_records p WHERE p.tenant_id=$1::uuid AND ${this.scopePredicate("$7")} AND ($5='' OR p.label ILIKE $6)
         ORDER BY p.label,p.id LIMIT 100`,
        tenantId,
        actor.membershipId,
        "probe.read",
        "READ",
        search.trim(),
        `%${search.trim()}%`,
        actor.userId,
      );
      const items = [];
      for (const row of rows)
        items.push(await this.serializeProbe(tx, actor, row));
      return { items, total: items.length, asOf: new Date().toISOString() };
    });
  }

  async probe(actor: SessionActor, id: string, correlationId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertCurrent(tx, actor);
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT p.id,p.label,p.status,p.version,p.resource_type AS "resourceType",p.assigned_user_id AS "assignedUserId",p.scope_node_ids AS "scopeNodeIds",p.tax_identifier AS "taxIdentifier",p.mobile,p.bank_detail AS "bankDetail",p.commercial_rate_minor AS "commercialRateMinor",p.payment_minor AS "paymentMinor",p.internal_margin_minor AS "internalMarginMinor"
         FROM app.authorization_probe_records p WHERE p.tenant_id=$1::uuid AND p.id=$5::uuid AND ${this.scopePredicate("$6")}`,
        tenantId,
        actor.membershipId,
        "probe.read",
        "READ",
        id,
        actor.userId,
      );
      if (!rows[0])
        return this.denial(tx, actor, "probe.read", "READ", id, correlationId);
      return this.serializeProbe(tx, actor, rows[0]);
    });
  }

  async updateProbe(
    actor: SessionActor,
    id: string,
    input: {
      expectedVersion: number;
      label?: string;
      status?: "OPEN" | "COMPLETED";
    },
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,scope_node_ids AS "scopeNodeIds",resource_type AS "resourceType",assigned_user_id AS "assignedUserId",version,label,status FROM app.authorization_probe_records WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          id,
        )
      )[0];
      if (!row)
        return this.denial(
          tx,
          actor,
          "probe.update",
          "UPDATE",
          id,
          correlationId,
        );
      const { decision } = await this.decide(
        tx,
        actor,
        "probe.update",
        "UPDATE",
        {
          tenantId,
          nodeIds: row.scopeNodeIds as string[],
          assignedUserId: row.assignedUserId
            ? String(row.assignedUserId)
            : undefined,
          requiresCurrentAssignment: row.resourceType === "TRIP",
        },
      );
      if (!decision.allowed)
        return this.denial(
          tx,
          actor,
          "probe.update",
          "UPDATE",
          id,
          correlationId,
        );
      if (Number(row.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Resource changed; reload and retry",
        );
      const updated = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.authorization_probe_records SET label=coalesce($1,label),status=coalesce($2,status),updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING id,label,status,version`,
          input.label ?? null,
          input.status ?? null,
          tenantId,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "probe.updated",
        "authorization_probe",
        id,
        correlationId,
        undefined,
        { label: row.label, status: row.status },
        updated,
      );
      return updated;
    });
  }

  async approveProbe(
    actor: SessionActor,
    id: string,
    expectedVersion: number,
    reason: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,scope_node_ids AS "scopeNodeIds",resource_type AS "resourceType",assigned_user_id AS "assignedUserId",version,label,status FROM app.authorization_probe_records WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          id,
        )
      )[0];
      if (!row)
        return this.denial(
          tx,
          actor,
          "probe.approve",
          "APPROVE",
          id,
          correlationId,
        );
      const { decision } = await this.decide(
        tx,
        actor,
        "probe.approve",
        "APPROVE",
        {
          tenantId,
          nodeIds: row.scopeNodeIds as string[],
          assignedUserId: row.assignedUserId
            ? String(row.assignedUserId)
            : undefined,
          requiresCurrentAssignment: row.resourceType === "TRIP",
        },
      );
      if (!decision.allowed)
        return this.denial(
          tx,
          actor,
          "probe.approve",
          "APPROVE",
          id,
          correlationId,
        );
      if (Number(row.version) !== expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Resource changed; reload and retry",
        );
      await this.audit(
        tx,
        actor,
        "probe.approved",
        "authorization_probe",
        id,
        correlationId,
        reason,
        { version: row.version },
        { approved: true },
      );
      return { id, approved: true, version: row.version };
    });
  }

  async exportProbes(
    actor: SessionActor,
    search: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.assertCurrent(tx, actor);
      const assignments = await this.policyData(tx, actor);
      if (
        !assignments.some((assignment) =>
          assignment.capabilities.includes("probe.export"),
        )
      )
        return this.denial(
          tx,
          actor,
          "probe.export",
          "EXPORT",
          "authorization-probe-export",
          correlationId,
        );
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT p.id,p.label,p.status,p.resource_type AS "resourceType" FROM app.authorization_probe_records p
         WHERE p.tenant_id=$1::uuid AND ${this.scopePredicate("$7")} AND ($5='' OR p.label ILIKE $6)
         ORDER BY p.label,p.id LIMIT 500`,
        tenantId,
        actor.membershipId,
        "probe.export",
        "EXPORT",
        search.trim(),
        `%${search.trim()}%`,
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "probe.exported",
        "authorization_probe_export",
        null,
        correlationId,
        undefined,
        null,
        { rowCount: rows.length, columns: ["label", "status", "resourceType"] },
      );
      return rows;
    });
  }

  async reassignProbe(
    actor: SessionActor,
    id: string,
    expectedVersion: number,
    assignedUserId: string,
    reason: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,assigned_user_id AS "assignedUserId",version,resource_type AS "resourceType" FROM app.authorization_probe_records WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          id,
        )
      )[0];
      if (!row)
        return this.denial(
          tx,
          actor,
          "identity.user.admin",
          "ADMIN",
          id,
          correlationId,
        );
      if (row.resourceType !== "TRIP")
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Only trip proof resources can be reassigned",
        );
      if (Number(row.version) !== expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Resource changed; reload and retry",
        );
      const member = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT DISTINCT m.id FROM app.tenant_memberships m
         JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE'
         JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.code='DRIVER' AND r.status='ACTIVE'
         WHERE m.tenant_id=$1::uuid AND m.user_id=$2::uuid AND m.status='ACTIVE' AND m.portal_audience='DRIVER'`,
          tenantId,
          assignedUserId,
        )
      )[0];
      if (!member)
        throw new AppError(
          400,
          "VALIDATION_FAILED",
          "Assigned user must have active Driver access",
        );
      const updated = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.authorization_probe_records SET assigned_user_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING id,assigned_user_id AS "assignedUserId",version`,
          assignedUserId,
          tenantId,
          id,
        )
      )[0]!;
      const affected = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,updated_at=now() WHERE tenant_id=$1::uuid AND user_id=ANY($2::uuid[]) RETURNING id`,
        tenantId,
        [row.assignedUserId, assignedUserId].filter(Boolean),
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.sessions SET revoked_at=now(),revoked_reason='TRIP_REASSIGNED',updated_at=now(),version=version+1 WHERE active_tenant_id=$1::uuid AND membership_id=ANY($2::uuid[]) AND revoked_at IS NULL`,
        tenantId,
        uuidRows(affected),
      );
      await this.audit(
        tx,
        actor,
        "probe.trip.reassigned",
        "authorization_probe",
        id,
        correlationId,
        reason,
        { assignedUserId: row.assignedUserId },
        { assignedUserId },
      );
      return updated;
    });
  }

  async previewOperation(
    actor: SessionActor,
    capability: string,
    action: ScopeAction,
    resourceId: string,
    _correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,resource_type AS "resourceType",assigned_user_id AS "assignedUserId",scope_node_ids AS "scopeNodeIds" FROM app.authorization_probe_records WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantId,
          resourceId,
        )
      )[0];
      if (!row) return { allowed: false, reason: "RESOURCE_NOT_FOUND" };
      const { decision } = await this.decide(tx, actor, capability, action, {
        tenantId,
        nodeIds: row.scopeNodeIds as string[],
        assignedUserId: row.assignedUserId
          ? String(row.assignedUserId)
          : undefined,
        requiresCurrentAssignment: row.resourceType === "TRIP",
      });
      return {
        ...decision,
        resourceId: decision.allowed ? resourceId : undefined,
        fingerprint: sha(
          stable({
            tenantId,
            actorVersion: actor.membershipAuthVersion,
            capability,
            action,
            resourceId,
            allowed: decision.allowed,
          }),
        ),
      };
    });
  }

  async reports(
    actor: SessionActor,
    type: string,
    correlationId: string,
    search = "",
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.report.read",
        "READ",
        correlationId,
      );
      const supported = [
        "users",
        "roles",
        "sessions",
        "audit-log",
        "security-events",
        "permission-changes",
        "privileged-actions",
        "failed-logins",
        "dormant",
      ];
      if (!supported.includes(type))
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Report not found");
      if (
        [
          "audit-log",
          "security-events",
          "permission-changes",
          "privileged-actions",
          "failed-logins",
        ].includes(type)
      )
        await this.authorizeRoot(
          tx,
          actor,
          "identity.audit.read",
          "READ",
          correlationId,
        );
      let items: Row[];
      if (type === "sessions")
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT m.id AS "membershipId",m.invited_name AS "displayName",count(s.id)::int count,max(s.last_seen_at) AS "lastSeenAt" FROM app.tenant_memberships m JOIN app.sessions s ON s.active_tenant_id=m.tenant_id AND s.membership_id=m.id WHERE m.tenant_id=$1::uuid AND ($2='' OR position(lower($2) in lower(concat_ws(' ',m.invited_name,m.employee_code)))>0) AND s.revoked_at IS NULL AND s.expires_at>now() AND s.user_auth_version=(SELECT auth_version FROM app.users WHERE id=s.user_id) AND s.membership_auth_version=m.authorization_version GROUP BY m.id ORDER BY m.invited_name`,
          tenantId,
          search.trim(),
        );
      else if (type === "security-events")
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT e.id,coalesce(m.invited_name,'System') AS actor,e.event_type AS "eventType",e.outcome,e.safe_target_hash AS "safeTargetHash",e.correlation_id AS "correlationId",e.occurred_at AS "occurredAt"
           FROM app.security_events e LEFT JOIN app.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.id=e.membership_id
           WHERE e.tenant_id=$1::uuid AND ($2='' OR position(lower($2) in lower(concat_ws(' ',m.invited_name,e.event_type,e.outcome,e.correlation_id,e.safe_target_hash)))>0)
           ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100`,
          tenantId,
          search.trim(),
        );
      else if (
        type === "audit-log" ||
        type === "permission-changes" ||
        type === "privileged-actions"
      )
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT e.id,coalesce(m.invited_name,'System') AS actor,e.action,e.target_type AS "targetType",e.reason,e.correlation_id AS "correlationId",e.occurred_at AS "occurredAt"
           FROM audit.audit_events e LEFT JOIN app.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.user_id=e.actor_id
           WHERE e.tenant_id=$1::uuid AND ($2='audit-log' OR $2='privileged-actions' OR e.action LIKE 'identity.%')
             AND ($3='' OR position(lower($3) in lower(concat_ws(' ',m.invited_name,e.action,e.target_type,e.reason,e.correlation_id)))>0)
           ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100`,
          tenantId,
          type,
          search.trim(),
        );
      else if (type === "roles")
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT r.id,r.name,count(DISTINCT a.membership_id)::int AS users,count(DISTINCT g.id)::int AS grants FROM app.roles r LEFT JOIN app.membership_role_assignments a ON a.tenant_id=r.tenant_id AND a.role_id=r.id AND a.status='ACTIVE' LEFT JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' WHERE r.tenant_id=$1::uuid AND ($2='' OR position(lower($2) in lower(concat_ws(' ',r.name,r.code,r.description)))>0) GROUP BY r.id ORDER BY r.name`,
          tenantId,
          search.trim(),
        );
      else if (type === "failed-logins")
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT date_trunc('minute',occurred_at) AS bucket,event_type AS "eventType",count(*)::int count
           FROM app.security_events WHERE tenant_id=$1::uuid AND event_type IN ('LOGIN_FAILED','LOGIN_THROTTLED') AND ($2='' OR position(lower($2) in lower(concat_ws(' ',event_type,outcome,correlation_id)))>0)
           GROUP BY bucket,event_type ORDER BY bucket DESC`,
          tenantId,
          search.trim(),
        );
      else if (type === "dormant")
        items = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT m.id,m.invited_name AS "displayName",m.last_activity_at AS "lastActivityAt",(u.last_login_at IS NULL) AS "neverLoggedIn"
           FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
           WHERE m.tenant_id=$1::uuid AND m.status='ACTIVE' AND ($2='' OR position(lower($2) in lower(concat_ws(' ',m.invited_name,m.employee_code)))>0) AND (m.last_activity_at IS NULL OR m.last_activity_at<now()-interval '30 days')
           ORDER BY m.invited_name`,
          tenantId,
          search.trim(),
        );
      else
        items = (
          await this.listUsers(
            actor,
            search,
            type === "dormant" ? "ACTIVE" : "",
            1,
            correlationId,
          )
        ).items;
      return {
        type,
        items,
        total: items.length,
        asOf: new Date().toISOString(),
        filters: { search: search.trim() },
      };
    });
  }

  async alerts(actor: SessionActor, correlationId: string, search = "") {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.report.read",
        "READ",
        correlationId,
      );
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT a.id,coalesce(m.invited_name,'System') AS actor,a.alert_type AS "type",a.severity,a.state,a.occurrence_count AS "occurrenceCount",a.first_seen_at AS "firstSeenAt",a.last_seen_at AS "lastSeenAt",a.resolution_reason AS "resolutionReason",a.version
         FROM app.security_alerts a LEFT JOIN app.tenant_memberships m ON m.tenant_id=a.tenant_id AND m.id=a.membership_id
         WHERE a.tenant_id=$1::uuid AND ($2='' OR position(lower($2) in lower(concat_ws(' ',m.invited_name,a.alert_type,a.severity,a.state,a.resolution_reason)))>0)
         ORDER BY a.last_seen_at DESC,a.id DESC`,
        tenantId,
        search.trim(),
      );
      return { items, total: items.length, asOf: new Date().toISOString() };
    });
  }

  async updateAlert(
    actor: SessionActor,
    id: string,
    expectedVersion: number,
    state: "ACKNOWLEDGED" | "RESOLVED",
    reason: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.authorizeRoot(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        correlationId,
      );
      const updated = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.security_alerts SET state=$1,resolution_reason=CASE WHEN $1='RESOLVED' THEN $2 ELSE resolution_reason END,
          resolved_at=CASE WHEN $1='RESOLVED' THEN now() ELSE resolved_at END,updated_at=now(),version=version+1
         WHERE tenant_id=$3::uuid AND id=$4::uuid AND version=$5 AND state<>'RESOLVED' RETURNING id,state,version,resolution_reason AS "resolutionReason"`,
          state,
          reason,
          tenantId,
          id,
          expectedVersion,
        )
      )[0];
      if (!updated)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Alert changed; reload and retry",
        );
      await this.audit(
        tx,
        actor,
        `identity.alert.${state.toLowerCase()}`,
        "security_alert",
        id,
        correlationId,
        reason,
        null,
        updated,
      );
      return updated;
    });
  }

  async reportExport(
    actor: SessionActor,
    type: string,
    correlationId: string,
    search = "",
  ) {
    const report = await this.reports(actor, type, correlationId, search);
    const columns = [
      ...new Set(report.items.flatMap((item) => Object.keys(item))),
    ];
    const csv = [
      columns,
      ...report.items.map((item) => columns.map((column) => item[column])),
    ]
      .map((row) =>
        row
          .map((value) =>
            csvCell(
              typeof value === "object" && value !== null
                ? JSON.stringify(value)
                : String(value ?? ""),
            ),
          )
          .join(","),
      )
      .join("\r\n");
    return {
      filename: `${type}.csv`,
      mediaType: "text/csv",
      rowCount: report.items.length,
      csv,
    };
  }

  private encryptionKey() {
    if (!this.app.config.MFA_ENCRYPTION_KEY)
      throw new AppError(
        503,
        "MFA_NOT_CONFIGURED",
        "MFA encryption is not configured",
      );
    return Buffer.from(this.app.config.MFA_ENCRYPTION_KEY, "base64");
  }
  encryptSecret(secret: Buffer) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), nonce);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    return [nonce, cipher.getAuthTag(), encrypted]
      .map((v) => v.toString("base64url"))
      .join(".");
  }
  decryptSecret(envelope: string) {
    const [nonce, tag, encrypted] = envelope
      .split(".")
      .map((v) => Buffer.from(v!, "base64url"));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey(),
      nonce!,
    );
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(encrypted!), decipher.final()]);
  }
  private base32(buffer: Buffer) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
    let output = "";
    for (let i = 0; i < bits.length; i += 5)
      output +=
        alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
    return output;
  }
  totp(secret: Buffer, timestep = Math.floor(Date.now() / 30000)) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(timestep));
    const digest = createHmac("sha1", secret).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;
    const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return code.toString().padStart(6, "0");
  }
  async setupMfa(actor: SessionActor, correlationId: string) {
    const tenantId = this.tenant(actor, true);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const secret = randomBytes(20),
        envelope = this.encryptSecret(secret);
      const active = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,verified_at AS "verifiedAt" FROM app.mfa_factors WHERE user_id=$1::uuid AND disabled_at IS NULL FOR UPDATE`,
          actor.userId,
        )
      )[0];
      if (active?.verifiedAt)
        throw new AppError(
          409,
          "MFA_ALREADY_ENROLLED",
          "Use the authenticator challenge or recovery code",
        );
      await tx.$executeRawUnsafe(
        `UPDATE app.mfa_factors SET disabled_at=now(),updated_at=now(),version=version+1 WHERE user_id=$1::uuid AND disabled_at IS NULL`,
        actor.userId,
      );
      const setupStep = Math.floor(Date.now() / 30000);
      const factor = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.mfa_factors(user_id,encrypted_secret,key_version,setup_timestep) VALUES($1::uuid,$2,$3,$4) RETURNING id`,
          actor.userId,
          envelope,
          this.app.config.MFA_KEY_VERSION,
          setupStep,
        )
      )[0]!;
      const encoded = this.base32(secret);
      await this.audit(
        tx,
        actor,
        "identity.mfa.setup.started",
        "mfa_factor",
        String(factor.id),
        correlationId,
      );
      return {
        factorId: factor.id,
        provisioningUri: `otpauth://totp/Logistics:${encodeURIComponent(actor.email)}?secret=${encoded}&issuer=Logistics&digits=6&period=30`,
        ...(this.app.config.ENABLE_TEST_HOOKS === "true"
          ? {
              testCodes: [
                this.totp(secret, setupStep),
                this.totp(secret, setupStep + 1),
              ],
            }
          : {}),
      };
    });
  }
  async confirmMfa(
    actor: SessionActor & { sessionId?: string },
    factorId: string,
    codes: [string, string],
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor, true);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const factor = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,encrypted_secret AS "encryptedSecret",last_timestep AS "lastTimestep",setup_timestep AS "setupTimestep" FROM app.mfa_factors WHERE id=$1::uuid AND user_id=$2::uuid AND disabled_at IS NULL FOR UPDATE`,
          factorId,
          actor.userId,
        )
      )[0];
      if (!factor) return this.rejectMfa(actor, tenantId, correlationId);
      const secret = this.decryptSecret(String(factor.encryptedSecret));
      const step = Number(factor.setupTimestep);
      if (
        !Number.isSafeInteger(step) ||
        Math.abs(Math.floor(Date.now() / 30000) - step) > 4
      )
        return this.rejectMfa(actor, tenantId, correlationId);
      if (
        codes[0] !== this.totp(secret, step) ||
        codes[1] !== this.totp(secret, step + 1)
      )
        return this.rejectMfa(actor, tenantId, correlationId);
      if (
        factor.lastTimestep !== null &&
        Number(factor.lastTimestep) >= step + 1
      )
        return this.rejectMfa(actor, tenantId, correlationId);
      const recoveryCodes = Array.from(
        { length: 10 },
        () =>
          `${randomBytes(4).toString("hex").slice(0, 4)}-${randomBytes(4).toString("hex").slice(0, 4)}`,
      );
      for (const recovery of recoveryCodes)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.mfa_recovery_codes(factor_id,code_hash) VALUES($1::uuid,$2)`,
          factorId,
          await argon2.hash(recovery, { type: argon2.argon2id }),
        );
      await tx.$executeRawUnsafe(
        `UPDATE app.mfa_factors SET verified_at=now(),last_timestep=$1,updated_at=now(),version=version+1 WHERE id=$2::uuid`,
        step + 1,
        factorId,
      );
      await this.audit(
        tx,
        actor,
        "identity.mfa.verified",
        "mfa_factor",
        factorId,
        correlationId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,'MFA_CHALLENGE_SUCCEEDED','ALLOWED',$4,'{}'::jsonb,$5)`,
        tenantId,
        actor.userId,
        actor.membershipId ?? null,
        sha(actor.userId).slice(0, 24),
        correlationId,
      );
      return {
        verified: true,
        factorId,
        recoveryCodes,
        acknowledgementRequired: true,
      };
    });
  }

  async acknowledgeRecoveryCodes(
    actor: SessionActor & { sessionId?: string },
    factorId: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor, true);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const updated = await tx.$queryRawUnsafe<Array<Row>>(
        `UPDATE app.mfa_factors SET recovery_acknowledged_at=now(),updated_at=now(),version=version+1
         WHERE id=$1::uuid AND user_id=$2::uuid AND verified_at IS NOT NULL AND disabled_at IS NULL AND recovery_acknowledged_at IS NULL RETURNING id`,
        factorId,
        actor.userId,
      );
      if (!updated[0])
        throw new AppError(
          400,
          "MFA_ACKNOWLEDGEMENT_INVALID",
          "Recovery-code acknowledgement could not be verified",
        );
      return this.completeRestrictedSession(
        tx,
        actor,
        tenantId,
        correlationId,
        "identity.mfa.recovery_codes.acknowledged",
      );
    });
  }

  async challengeMfa(
    actor: SessionActor & { sessionId?: string },
    code: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor, true);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const factor = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,encrypted_secret AS "encryptedSecret",last_timestep AS "lastTimestep" FROM app.mfa_factors WHERE user_id=$1::uuid AND verified_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE`,
          actor.userId,
        )
      )[0];
      if (!factor) return this.rejectMfa(actor, tenantId, correlationId);
      const secret = this.decryptSecret(String(factor.encryptedSecret));
      const current = Math.floor(Date.now() / 30000);
      const timestep = [current - 1, current, current + 1].find(
        (step) => this.totp(secret, step) === code,
      );
      if (
        timestep === undefined ||
        timestep <= Number(factor.lastTimestep ?? -1)
      )
        return this.rejectMfa(actor, tenantId, correlationId);
      await tx.$executeRawUnsafe(
        `UPDATE app.mfa_factors SET last_timestep=$1,updated_at=now(),version=version+1 WHERE id=$2::uuid`,
        timestep,
        factor.id,
      );
      return this.completeRestrictedSession(
        tx,
        actor,
        tenantId,
        correlationId,
        "identity.mfa.challenge.succeeded",
      );
    });
  }

  async recoverMfa(
    actor: SessionActor & { sessionId?: string },
    recoveryCode: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor, true);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT c.id,c.code_hash AS "codeHash" FROM app.mfa_recovery_codes c JOIN app.mfa_factors f ON f.id=c.factor_id WHERE f.user_id=$1::uuid AND f.verified_at IS NOT NULL AND f.disabled_at IS NULL AND c.used_at IS NULL FOR UPDATE OF c`,
        actor.userId,
      );
      let matched: Row | undefined;
      for (const row of rows)
        if (await argon2.verify(String(row.codeHash), recoveryCode)) {
          matched = row;
          break;
        }
      if (!matched) return this.rejectMfa(actor, tenantId, correlationId);
      await tx.$executeRawUnsafe(
        `UPDATE app.mfa_recovery_codes SET used_at=now() WHERE id=$1::uuid AND used_at IS NULL`,
        matched.id,
      );
      return this.completeRestrictedSession(
        tx,
        actor,
        tenantId,
        correlationId,
        "identity.mfa.recovery.succeeded",
      );
    });
  }

  private async completeRestrictedSession(
    tx: Tx,
    actor: SessionActor & { sessionId?: string },
    tenantId: string,
    correlationId: string,
    action: string,
  ) {
    if (actor.sessionId)
      await tx.$executeRawUnsafe(
        `UPDATE app.sessions SET revoked_at=now(),revoked_reason='MFA_COMPLETED',updated_at=now(),version=version+1 WHERE id=$1::uuid AND revoked_at IS NULL`,
        actor.sessionId,
      );
    const fullSession = await this.app.newSession(
      tx,
      actor.userId,
      tenantId,
      actor.contextVersion,
      "MFA",
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO app.security_events(tenant_id,user_id,membership_id,event_type,outcome,safe_target_hash,metadata,correlation_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,'MFA_CHALLENGE_SUCCEEDED','ALLOWED',$4,'{}'::jsonb,$5)`,
      tenantId,
      actor.userId,
      actor.membershipId ?? null,
      sha(actor.userId).slice(0, 24),
      correlationId,
    );
    await this.audit(tx, actor, action, "session", null, correlationId);
    return { verified: true, ...fullSession };
  }
}
