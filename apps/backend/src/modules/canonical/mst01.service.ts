import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import {
  employeeMasterCreateSchema,
  employeeMasterPatchSchema,
  organizationMasterCreateSchema,
  organizationMasterPatchSchema,
  organizationParentAllowed,
  toJsonSafe,
} from "@logistics/domain";
import { createDatabase, withTenant, type Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
const bool = (value: unknown) => value === true || value === "t";
const dateOnly = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(toJsonSafe(value)))
    .digest("hex");
const activeAlertRecipientSql = `(SELECT EXISTS(
  SELECT 1 FROM app.tenant_memberships m
  WHERE m.tenant_id=r.tenant_id AND m.status='ACTIVE' AND (
    m.id::text=r.recipient_policy->>'membershipId'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(r.recipient_policy->'membershipIds')='array'
          THEN r.recipient_policy->'membershipIds' ELSE '[]'::jsonb END
      ) recipient_id WHERE recipient_id=m.id::text
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.escalation_levels)='array'
          THEN r.escalation_levels ELSE '[]'::jsonb END
      ) level
      WHERE level->>'membershipId'=m.id::text
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(level->'membershipIds')='array'
              THEN level->'membershipIds' ELSE '[]'::jsonb END
          ) escalation_id WHERE escalation_id=m.id::text
        )
    )
    OR (
      r.recipient_policy->>'owners'='true'
      AND EXISTS (
        SELECT 1 FROM app.membership_role_assignments a
        JOIN app.roles role ON role.tenant_id=a.tenant_id AND role.id=a.role_id
        WHERE a.tenant_id=m.tenant_id AND a.membership_id=m.id
          AND a.status='ACTIVE' AND a.effective_from<=now()
          AND (a.effective_to IS NULL OR a.effective_to>now())
          AND role.code='TENANT_OWNER'
      )
    )
  )
))`;

@Injectable()
export class Mst01Service {
  private readonly nextPostalFailures = new Set<string>();
  private readonly nextPostalStaleSelections = new Set<string>();
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private testHookDatabase() {
    if (
      this.app.config.ENABLE_TEST_HOOKS !== "true" ||
      this.app.config.APP_ENV === "production"
    )
      throw new AppError(404, "NOT_FOUND", "Resource not found");
    const runtime = new URL(this.app.config.DATABASE_URL);
    const importerValue = process.env.TEST_POSTAL_IMPORT_DATABASE_URL?.trim();
    if (
      runtime.pathname !== "/logistics_test" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(runtime.hostname) ||
      !importerValue
    )
      throw new AppError(404, "NOT_FOUND", "Resource not found");
    const importer = new URL(importerValue);
    if (
      importer.pathname !== runtime.pathname ||
      importer.hostname !== runtime.hostname ||
      importer.username !== "logistics_postal_importer"
    )
      throw new AppError(404, "NOT_FOUND", "Resource not found");
    return importerValue;
  }

  private async testHookAccess(tx: Tx, actor: SessionActor) {
    this.testHookDatabase();
    await this.capability(tx, actor, "masters.admin", "ADMIN");
  }

  private tenant(actor: SessionActor) {
    if (!actor.activeTenantId || !actor.membershipId)
      throw new AppError(403, "TENANT_REQUIRED", "Select a tenant");
    return actor.activeTenantId;
  }
  private async capability(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: string,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a
       JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id
       JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id
       WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
       AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
       AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
       AND c.capability_code=$3 AND g.action IN ($4,'ADMIN')) allowed`,
        this.tenant(actor),
        actor.membershipId,
        capability,
        action,
      )
    )[0];
    if (!bool(row?.allowed))
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }
  private async hasCapability(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: string,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id
         WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND c.capability_code=$3 AND g.action IN ($4,'ADMIN') AND g.status='ACTIVE'
           AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())) allowed`,
        this.tenant(actor),
        actor.membershipId,
        capability,
        action,
      )
    )[0];
    return bool(row?.allowed);
  }
  private async scopeCapability(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: string,
    scopeNodeId: string,
    required = true,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `WITH RECURSIVE ancestors AS (
           SELECT id,parent_id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$6::uuid AND status='ACTIVE'
           UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors a ON a.parent_id=n.id WHERE n.tenant_id=$1::uuid AND n.status='ACTIVE'
         ) SELECT EXISTS(
           SELECT 1 FROM app.membership_role_assignments a
           JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$4
           JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ($5,'ADMIN')
           WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
             AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
             AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
             AND g.scope_node_id IN (SELECT id FROM ancestors)
         ) allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        capability,
        action,
        scopeNodeId,
      )
    )[0];
    const allowed = bool(row?.allowed);
    if (required && !allowed)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    return allowed;
  }

  private async graphLock(tx: Tx, tenant: string, graph: string) {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenant}:mst01:${graph}`,
    );
  }

  private scopeType(nodeType: string) {
    return nodeType === "LEGAL_ENTITY" || nodeType === "REGION"
      ? nodeType
      : "BRANCH";
  }

  private async tenantScope(tx: Tx, actor: SessionActor, action: string) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT n.id FROM app.authorization_scope_nodes n
         WHERE n.tenant_id=$1::uuid AND n.scope_type='TENANT' AND n.status='ACTIVE'
           AND EXISTS(SELECT 1 FROM app.membership_role_assignments a
             JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='masters.admin'
             JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.scope_node_id=n.id AND g.action IN ($3,'ADMIN')
             WHERE a.tenant_id=n.tenant_id AND a.membership_id=$2::uuid AND a.status='ACTIVE'
               AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
               AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()))`,
        this.tenant(actor),
        actor.membershipId,
        action,
      )
    )[0];
    if (!row)
      throw new AppError(
        403,
        "SCOPE_REQUIRED",
        "A permitted tenant scope is required",
      );
    return String(row.id);
  }

  private async organizationSnapshot(tx: Tx, tenant: string, id: string) {
    return (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT to_jsonb(n) || jsonb_build_object('address',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)-'tenant_id' END) snapshot
         FROM app.organization_nodes n LEFT JOIN app.organization_addresses a ON a.tenant_id=n.tenant_id AND a.organization_node_id=n.id
         WHERE n.tenant_id=$1::uuid AND n.id=$2::uuid`,
        tenant,
        id,
      )
    )[0]?.snapshot as Row | undefined;
  }

  private async employeeSnapshot(tx: Tx, tenant: string, id: string) {
    return (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT (to_jsonb(e)-'email'-'mobile') || jsonb_build_object(
           'hasEmail',e.email IS NOT NULL,'hasMobile',e.mobile IS NOT NULL,
           'regionIds',coalesce((SELECT jsonb_agg(c.organization_node_id ORDER BY c.organization_node_id) FROM app.employee_region_coverage c WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id),'[]'::jsonb)) snapshot
         FROM app.employees e WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid`,
        tenant,
        id,
      )
    )[0]?.snapshot as Row | undefined;
  }
  private async resource(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: string,
    kind: string,
    id: string,
  ) {
    await this.capability(tx, actor, capability, action);
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid) allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        capability,
        action,
        kind,
        id,
      )
    )[0];
    if (!bool(row?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }
  private audit(
    tx: Tx,
    actor: SessionActor,
    action: string,
    type: string,
    id: string,
    correlation: string,
    before?: unknown,
    after?: unknown,
    reason?: string,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9)`,
      this.tenant(actor),
      actor.userId,
      action,
      type,
      id,
      correlation,
      before === undefined ? null : JSON.stringify(toJsonSafe(before)),
      after === undefined ? null : JSON.stringify(toJsonSafe(after)),
      reason ?? null,
    );
  }
  private event(
    tx: Tx,
    tenant: string,
    type: string,
    id: string,
    action: string,
    row: Row,
  ) {
    return tx.$executeRawUnsafe(
      `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
       VALUES($1::uuid,'TENANT',$2,$3::uuid,$4,$5,$6::jsonb,$7) ON CONFLICT(deduplication_key) DO NOTHING`,
      tenant,
      type,
      id,
      `${action}.v1`,
      Number(row.version),
      JSON.stringify(toJsonSafe(row)),
      `${tenant}:${type}:${id}:${action}:v${Number(row.version)}`,
    );
  }
  private async idempotent<T extends Row>(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    key: string,
    input: unknown,
    execute: () => Promise<T>,
  ) {
    if (!key.trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required",
      );
    const tenant = this.tenant(actor),
      requestHash = digest(input),
      keyHash = digest(`${tenant}:${key}`);
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenant}:${operation}:${keyHash}`,
    );
    const prior = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT request_hash,response_json FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
        actor.userId,
        operation,
        keyHash,
      )
    )[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used for different input",
        );
      return { ...(prior.response_json as T), replayed: true };
    }
    const result = await execute();
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      tenant,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      result.id ?? null,
      JSON.stringify(toJsonSafe(result)),
    );
    return result;
  }

  async postal(actor: SessionActor, postalCode: string) {
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.capability(tx, actor, "masters.read", "READ");
      const failureKey = `${this.tenant(actor)}:${postalCode}`;
      if (this.nextPostalFailures.delete(failureKey))
        throw new AppError(
          503,
          "POSTAL_LOOKUP_UNAVAILABLE",
          "Postal lookup is temporarily unavailable. Retry the lookup.",
        );
      const items = await tx.$queryRawUnsafe<Row[]>(
        `SELECT l.id,l.country,l.postal_code AS "postalCode",l.locality_name locality,l.district_name district,
                l.city_name city,l.region_name region,v.id AS "directoryVersionId",v.version AS "directoryVersion"
         FROM postal_reference.postal_localities l JOIN postal_reference.postal_directory_versions v
         ON v.id=l.directory_version_id AND v.active AND v.status='ACTIVE'
         WHERE l.active AND l.country='IN' AND l.postal_code=$1 ORDER BY l.locality_name,l.district_name,l.id`,
        postalCode,
      );
      if (!items.length)
        throw new AppError(
          404,
          "POSTAL_CODE_NOT_FOUND",
          "This PIN code is not in the postal directory. Check it and try again.",
          { "address.postalCode": ["No locality found for this PIN code"] },
        );
      return { country: "IN", postalCode, items };
    });
  }

  private async postalSnapshot(
    tx: Tx,
    tenant: string,
    address: { postalLocalityId: string; postalCode: string },
  ) {
    const lookup = async () =>
      (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT l.id,l.country,l.postal_code,l.locality_name,l.district_name,l.city_name,l.region_name,
              v.id directory_version_id,v.version directory_version
       FROM postal_reference.postal_localities l JOIN postal_reference.postal_directory_versions v
       ON v.id=l.directory_version_id AND v.active AND v.status='ACTIVE'
       WHERE l.id=$1::uuid AND l.active AND l.country='IN' AND l.postal_code=$2`,
          address.postalLocalityId,
          address.postalCode,
        )
      )[0];
    const staleKey = `${tenant}:${address.postalLocalityId}`;
    const row = this.nextPostalStaleSelections.delete(staleKey)
      ? await this.withRetiredPostalVersion(address.postalLocalityId, lookup)
      : await lookup();
    if (!row)
      throw new AppError(
        409,
        "POSTAL_REFERENCE_CHANGED",
        "Postal directory changed; search the PIN and select the locality again",
      );
    return row;
  }

  private async withRetiredPostalVersion<T>(
    localityId: string,
    execute: () => Promise<T>,
  ) {
    const importer = createDatabase(this.testHookDatabase());
    let version:
      | {
          id: string;
          active: boolean;
          status: string;
          activated_at: Date | null;
          activated_by: string | null;
        }
      | undefined;
    try {
      version = await importer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.postal_import_context','on',true)`,
        );
        const selected = (
          await tx.$queryRawUnsafe<Array<NonNullable<typeof version>>>(
            `SELECT v.id,v.active,v.status,v.activated_at,v.activated_by
             FROM postal_reference.postal_localities l JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id
             WHERE l.id=$1::uuid FOR UPDATE OF v`,
            localityId,
          )
        )[0];
        if (!selected)
          throw new AppError(404, "NOT_FOUND", "Resource not found");
        await tx.$executeRawUnsafe(
          `UPDATE postal_reference.postal_directory_versions SET active=false,status='RETIRED' WHERE id=$1::uuid`,
          selected.id,
        );
        return selected;
      });
      return await execute();
    } finally {
      if (version)
        await importer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.postal_import_context','on',true)`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE postal_reference.postal_directory_versions SET active=$1,status=$2,activated_at=$3::timestamptz,activated_by=$4 WHERE id=$5::uuid`,
            version!.active,
            version!.status,
            version!.activated_at,
            version!.activated_by,
            version!.id,
          );
        });
      await importer.$disconnect();
    }
  }

  async armPostalFailure(actor: SessionActor, postalCode: string) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.testHookAccess(tx, actor);
      this.nextPostalFailures.add(`${tenant}:${postalCode}`);
      return { armed: true, postalCode };
    });
  }

  async armPostalStaleSelection(actor: SessionActor, postalLocalityId: string) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.testHookAccess(tx, actor);
      const locality = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id FROM postal_reference.postal_localities WHERE id=$1::uuid AND active`,
          postalLocalityId,
        )
      )[0];
      if (!locality) throw new AppError(404, "NOT_FOUND", "Resource not found");
      this.nextPostalStaleSelections.add(`${tenant}:${postalLocalityId}`);
      return { armed: true, postalLocalityId };
    });
  }

  async testCounts(actor: SessionActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.testHookAccess(tx, actor);
      return (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT
            (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$1::uuid) "organizationNodes",
            (SELECT count(*)::int FROM app.organization_closure WHERE tenant_id=$1::uuid) "closureRows",
            (SELECT count(*)::int FROM app.employees WHERE tenant_id=$1::uuid) employees,
            (SELECT count(*)::int FROM app.operational_assignments WHERE tenant_id=$1::uuid) assignments,
            (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_type IN ('organization_node','employee','operational_assignment')) audits,
            (SELECT count(*)::int FROM app.outbox_events WHERE tenant_id=$1::uuid AND aggregate_type IN ('organization_node','employee','operational_assignment')) outbox`,
          tenant,
        )
      )[0]!;
    });
  }
  private async assertParent(
    tx: Tx,
    tenant: string,
    nodeType: string,
    parentId?: string | null,
  ) {
    if (!parentId) return;
    const parent = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT node_type,state FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        tenant,
        parentId,
      )
    )[0];
    if (!parent || parent.state !== "ACTIVE")
      throw new AppError(400, "PARENT_INVALID", "Parent node is not active");
    if (!organizationParentAllowed(nodeType, String(parent.node_type)))
      throw new AppError(
        400,
        "PARENT_TYPE_INVALID",
        `${nodeType.replaceAll("_", " ")} cannot belong to ${String(parent.node_type).replaceAll("_", " ")}`,
      );
  }
  private async saveAddress(
    tx: Tx,
    tenant: string,
    nodeId: string,
    address: {
      line1: string;
      line2?: string | null;
      postalCode: string;
      postalLocalityId: string;
    },
  ) {
    const postal = await this.postalSnapshot(tx, tenant, address);
    await tx.$executeRawUnsafe(
      `INSERT INTO app.organization_addresses(tenant_id,organization_node_id,line1,line2,country,postal_code,postal_locality_id,postal_directory_version_id,postal_directory_version,locality,district,city,region)
       VALUES($1::uuid,$2::uuid,$3,$4,'IN',$5,$6::uuid,$7::uuid,$8,$9,$10,$11,$12)
       ON CONFLICT(tenant_id,organization_node_id) DO UPDATE SET line1=excluded.line1,line2=excluded.line2,postal_code=excluded.postal_code,
       postal_locality_id=excluded.postal_locality_id,postal_directory_version_id=excluded.postal_directory_version_id,
       postal_directory_version=excluded.postal_directory_version,locality=excluded.locality,district=excluded.district,city=excluded.city,region=excluded.region,updated_at=now()`,
      tenant,
      nodeId,
      address.line1,
      address.line2 ?? null,
      address.postalCode,
      address.postalLocalityId,
      postal.directory_version_id,
      postal.directory_version,
      postal.locality_name,
      postal.district_name,
      postal.city_name,
      postal.region_name,
    );
  }

  async createOrganization(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlation: string,
  ) {
    const input = organizationMasterCreateSchema.parse(raw),
      tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "organization");
      await this.capability(tx, actor, "masters.admin", "CREATE");
      if (input.authorizationScopeNodeId)
        throw new AppError(
          400,
          "SCOPE_SERVER_DERIVED",
          "Authorization scope is derived from the permitted organization hierarchy",
        );
      if (input.parentId)
        await this.resource(
          tx,
          actor,
          "masters.admin",
          "CREATE",
          "organization-nodes",
          input.parentId,
        );
      await this.assertParent(tx, tenant, input.nodeType, input.parentId);
      return this.idempotent(
        tx,
        actor,
        "mst01.organization.create",
        key,
        input,
        async () => {
          const parentScope = input.parentId
            ? String(
                (
                  await tx.$queryRawUnsafe<Row[]>(
                    `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
                    tenant,
                    input.parentId,
                  )
                )[0]?.authorization_scope_node_id,
              )
            : await this.tenantScope(tx, actor, "CREATE");
          await this.scopeCapability(
            tx,
            actor,
            "masters.admin",
            "CREATE",
            parentScope,
          );
          const nodeId = crypto.randomUUID();
          const createsScope = ["LEGAL_ENTITY", "REGION", "BRANCH"].includes(
            input.nodeType,
          );
          const scope = createsScope
            ? String(
                (
                  await tx.$queryRawUnsafe<Row[]>(
                    `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id,canonical_resource_id)
                     VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid) RETURNING id`,
                    tenant,
                    this.scopeType(input.nodeType),
                    input.code,
                    input.name,
                    parentScope,
                    nodeId,
                  )
                )[0]!.id,
              )
            : parentScope;
          const row = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.organization_nodes(id,tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,address,postal_codes,geofence,active_from,active_to,created_by)
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8,null,$9::text[],$10::jsonb,$11::date,$12::date,$13::uuid) RETURNING *`,
              nodeId,
              tenant,
              input.code,
              input.name,
              input.nodeType,
              input.parentId ?? null,
              scope,
              input.timezone,
              input.address ? [input.address.postalCode] : [],
              JSON.stringify(input.geofence ?? {}),
              input.activeFrom,
              input.activeTo ?? null,
              actor.userId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) SELECT $1::uuid,ancestor_id,$2::uuid,depth+1 FROM app.organization_closure WHERE tenant_id=$1::uuid AND descendant_id=$3::uuid UNION ALL SELECT $1::uuid,$2::uuid,$2::uuid,0`,
            tenant,
            row.id,
            input.parentId ?? null,
          );
          if (input.address)
            await this.saveAddress(tx, tenant, String(row.id), input.address);
          const snapshot = await this.organizationSnapshot(
            tx,
            tenant,
            String(row.id),
          );
          await this.audit(
            tx,
            actor,
            "organization.created",
            "organization_node",
            String(row.id),
            correlation,
            undefined,
            snapshot,
          );
          await this.event(
            tx,
            tenant,
            "organization_node",
            String(row.id),
            "organization.created",
            snapshot ?? row,
          );
          return row;
        },
      );
    });
  }

  async organizationView(
    actor: SessionActor,
    id?: string,
    query: {
      query?: string;
      state?: "ACTIVE" | "INACTIVE";
      nodeType?: "LEGAL_ENTITY" | "REGION" | "BRANCH" | "TEAM" | "HUB";
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.read", "READ");
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT n.id,n.code,n.name,n.node_type AS "nodeType",n.parent_id AS "parentId",n.authorization_scope_node_id AS "authorizationScopeNodeId",n.timezone,n.active_from AS "activeFrom",n.active_to AS "activeTo",n.state,n.version,n.geofence,
        CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('line1',a.line1,'line2',a.line2,'country',a.country,'postalCode',a.postal_code,'postalLocalityId',a.postal_locality_id,'locality',a.locality,'district',a.district,'city',a.city,'region',a.region,'directoryVersion',a.postal_directory_version,'provenance',a.provenance) END address,
        coalesce((SELECT max(c.depth)::int FROM app.organization_closure c WHERE c.tenant_id=n.tenant_id AND c.descendant_id=n.id),0) AS "treeDepth",
        jsonb_build_object('update',app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE','organization-nodes',n.id),'deactivate',app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE','organization-nodes',n.id)) permissions,
        (SELECT count(*)::int FROM app.organization_closure c WHERE c.tenant_id=n.tenant_id AND c.ancestor_id=n.id AND c.depth>0) AS "descendantCount",
        (SELECT count(*)::int FROM app.organization_closure c JOIN app.employees e ON e.tenant_id=c.tenant_id AND e.home_node_id=c.descendant_id WHERE c.tenant_id=n.tenant_id AND c.ancestor_id=n.id AND e.state='ACTIVE') AS "activeEmployeeCount"
        FROM app.organization_nodes n LEFT JOIN app.organization_addresses a ON a.tenant_id=n.tenant_id AND a.organization_node_id=n.id
        WHERE n.tenant_id=$1::uuid AND ($2::uuid IS NULL OR n.id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','organization-nodes',n.id)
          AND ($2::uuid IS NOT NULL OR $5='' OR strpos(lower(n.code||' '||n.name),lower($5))>0)
          AND ($2::uuid IS NOT NULL OR $6::text IS NULL OR n.state=$6)
          AND ($2::uuid IS NOT NULL OR $7::text IS NULL OR n.node_type=$7)
        ORDER BY lower(n.name),n.code,n.id LIMIT $8 OFFSET $9`,
        tenant,
        id ?? null,
        actor.membershipId,
        actor.userId,
        query.query ?? "",
        query.state ?? null,
        query.nodeType ?? null,
        id ? 1 : (query.limit ?? 50),
        id ? 0 : (query.offset ?? 0),
      );
      if (id && !rows.length)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (id) return rows[0];
      const permission = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT
             EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='masters.admin' JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ('CREATE','ADMIN') WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())) AS "canCreate",
             EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='masters.admin' JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ('UPDATE','ADMIN') WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())) AS "canUpdate"`,
          tenant,
          actor.membershipId,
        )
      )[0]!;
      permission.canException = await this.hasCapability(
        tx,
        actor,
        "masters.exception",
        "ADMIN",
      );
      const total = Number(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT count(*)::int total FROM app.organization_nodes n
             WHERE n.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ','organization-nodes',n.id)
               AND ($4='' OR strpos(lower(n.code||' '||n.name),lower($4))>0)
               AND ($5::text IS NULL OR n.state=$5)
               AND ($6::text IS NULL OR n.node_type=$6)`,
            tenant,
            actor.membershipId,
            actor.userId,
            query.query ?? "",
            query.state ?? null,
            query.nodeType ?? null,
          )
        )[0]!.total,
      );
      return {
        items: rows,
        total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        permissions: permission,
      };
    });
  }

  async updateOrganization(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlation: string,
  ) {
    const input = organizationMasterPatchSchema.parse(raw),
      tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "organization");
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "organization-nodes",
        id,
      );
      return this.idempotent(
        tx,
        actor,
        `mst01.organization.update.${id}`,
        key,
        input,
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              id,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Record changed; reload and retry",
            );
          if (input.authorizationScopeNodeId)
            throw new AppError(
              400,
              "SCOPE_SERVER_DERIVED",
              "Authorization scope is derived from the permitted organization hierarchy",
            );
          const beforeSnapshot = await this.organizationSnapshot(
            tx,
            tenant,
            id,
          );
          const nodeType = input.nodeType ?? String(before.node_type),
            parentId =
              input.parentId === undefined
                ? before.parent_id
                  ? String(before.parent_id)
                  : null
                : input.parentId;
          if (nodeType === "LEGAL_ENTITY" && parentId)
            throw new AppError(
              400,
              "PARENT_INVALID",
              "A legal entity must remain a root node",
            );
          if (nodeType !== "LEGAL_ENTITY" && !parentId)
            throw new AppError(
              400,
              "PARENT_INVALID",
              "Select a valid parent node",
            );
          const activeFrom = input.activeFrom ?? dateOnly(before.active_from),
            activeTo =
              input.activeTo === undefined ? before.active_to : input.activeTo;
          if (activeTo && dateOnly(activeTo) < activeFrom)
            throw new AppError(
              400,
              "ACTIVE_DATES_INVALID",
              "Active end must not precede start",
            );
          if (parentId === id)
            throw new AppError(
              409,
              "HIERARCHY_CYCLE",
              "A node cannot be its own parent",
            );
          if (
            parentId &&
            bool(
              (
                await tx.$queryRawUnsafe<Row[]>(
                  `SELECT EXISTS(SELECT 1 FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid AND descendant_id=$3::uuid) cycle`,
                  tenant,
                  id,
                  parentId,
                )
              )[0]?.cycle,
            )
          )
            throw new AppError(
              409,
              "HIERARCHY_CYCLE",
              "A node cannot move beneath its descendant",
            );
          if (parentId)
            await this.resource(
              tx,
              actor,
              "masters.admin",
              "UPDATE",
              "organization-nodes",
              parentId,
            );
          await this.assertParent(tx, tenant, nodeType, parentId);
          if (input.nodeType && input.nodeType !== before.node_type) {
            const children = await tx.$queryRawUnsafe<Row[]>(
              `SELECT id,node_type FROM app.organization_nodes WHERE tenant_id=$1::uuid AND parent_id=$2::uuid`,
              tenant,
              id,
            );
            if (
              children.some(
                (child) =>
                  !organizationParentAllowed(String(child.node_type), nodeType),
              )
            )
              throw new AppError(
                409,
                "CHILD_TYPE_INVALID",
                "Move incompatible child nodes before changing this node type",
              );
          }
          if (["BRANCH", "HUB"].includes(nodeType) && !input.address) {
            const address = (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT id FROM app.organization_addresses WHERE tenant_id=$1::uuid AND organization_node_id=$2::uuid`,
                tenant,
                id,
              )
            )[0];
            if (!address)
              throw new AppError(
                400,
                "ADDRESS_REQUIRED",
                "A PIN-derived physical address is required",
              );
          }
          if (input.geofence?.mode === "DYNAMIC_RADIUS" && !input.address) {
            const address = (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT id FROM app.organization_addresses WHERE tenant_id=$1::uuid AND organization_node_id=$2::uuid`,
                tenant,
                id,
              )
            )[0];
            if (!address)
              throw new AppError(
                400,
                "ADDRESS_REQUIRED",
                "Dynamic radius requires a PIN-derived organization address",
              );
          }
          const parentChanged =
            (before.parent_id ? String(before.parent_id) : null) !== parentId;
          if (parentChanged) {
            await tx.$executeRawUnsafe(
              `DELETE FROM app.organization_closure
           WHERE tenant_id=$1::uuid
             AND descendant_id IN (SELECT descendant_id FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid)
             AND ancestor_id NOT IN (SELECT descendant_id FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid)`,
              tenant,
              id,
            );
            if (parentId)
              await tx.$executeRawUnsafe(
                `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
             SELECT $1::uuid,p.ancestor_id,c.descendant_id,p.depth+c.depth+1
             FROM app.organization_closure p CROSS JOIN app.organization_closure c
             WHERE p.tenant_id=$1::uuid AND c.tenant_id=$1::uuid AND p.descendant_id=$2::uuid AND c.ancestor_id=$3::uuid
             ON CONFLICT DO NOTHING`,
                tenant,
                parentId,
                id,
              );
          }
          const desiredScopeParent = parentId
            ? String(
                (
                  await tx.$queryRawUnsafe<Row[]>(
                    `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
                    tenant,
                    parentId,
                  )
                )[0]!.authorization_scope_node_id,
              )
            : await this.tenantScope(tx, actor, "UPDATE");
          await this.scopeCapability(
            tx,
            actor,
            "masters.admin",
            "UPDATE",
            desiredScopeParent,
          );
          const currentScope = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT id,canonical_resource_id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              before.authorization_scope_node_id,
            )
          )[0];
          let scopeId = String(before.authorization_scope_node_id);
          const createsScope = ["LEGAL_ENTITY", "REGION", "BRANCH"].includes(
            nodeType,
          );
          if (!createsScope) {
            scopeId = desiredScopeParent;
          } else if (String(currentScope?.canonical_resource_id ?? "") !== id) {
            scopeId = String(
              (
                await tx.$queryRawUnsafe<Row[]>(
                  `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id,canonical_resource_id)
               VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid) RETURNING id`,
                  tenant,
                  this.scopeType(nodeType),
                  input.code ?? before.code,
                  input.name ?? before.name,
                  desiredScopeParent,
                  id,
                )
              )[0]!.id,
            );
          } else {
            await tx.$executeRawUnsafe(
              `UPDATE app.authorization_scope_nodes SET scope_type=$1,code=coalesce($2,code),name=coalesce($3,name),parent_id=$4::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$5::uuid AND id=$6::uuid`,
              this.scopeType(nodeType),
              input.code ?? null,
              input.name ?? null,
              desiredScopeParent,
              tenant,
              scopeId,
            );
          }
          const row = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.organization_nodes SET code=coalesce($1,code),name=coalesce($2,name),node_type=$3,parent_id=$4::uuid,authorization_scope_node_id=$5::uuid,timezone=coalesce($6,timezone),geofence=coalesce($7::jsonb,geofence),active_from=coalesce($8::date,active_from),active_to=CASE WHEN $9 THEN $10::date ELSE active_to END,updated_at=now(),version=version+1 WHERE tenant_id=$11::uuid AND id=$12::uuid AND version=$13 RETURNING *`,
              input.code ?? null,
              input.name ?? null,
              nodeType,
              parentId,
              scopeId,
              input.timezone ?? null,
              input.geofence ? JSON.stringify(input.geofence) : null,
              input.activeFrom ?? null,
              Object.hasOwn(input, "activeTo"),
              input.activeTo ?? null,
              tenant,
              id,
              input.expectedVersion,
            )
          )[0]!;
          if (parentChanged || input.nodeType)
            await tx.$executeRawUnsafe(
              `SELECT app.reconcile_organization_subtree_scopes($1::uuid,$2::uuid)`,
              tenant,
              id,
            );
          if (input.address)
            await this.saveAddress(tx, tenant, id, input.address);
          const afterSnapshot = await this.organizationSnapshot(tx, tenant, id);
          await this.audit(
            tx,
            actor,
            "organization.updated",
            "organization_node",
            id,
            correlation,
            beforeSnapshot,
            afterSnapshot,
            input.reason,
          );
          await this.event(
            tx,
            tenant,
            "organization_node",
            id,
            "organization.updated",
            afterSnapshot ?? row,
          );
          return row;
        },
      );
    });
  }

  private async employeeReferences(
    tx: Tx,
    actor: SessionActor,
    input: {
      managerId?: string | null;
      homeNodeId: string;
      regionIds: string[];
      linkedMembershipId?: string | null;
    },
    selfId?: string,
  ) {
    await this.resource(
      tx,
      actor,
      "masters.admin",
      "CREATE",
      "organization-nodes",
      input.homeNodeId,
    );
    const home = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
        this.tenant(actor),
        input.homeNodeId,
      )
    )[0];
    if (!home)
      throw new AppError(
        400,
        "HOME_NODE_INVALID",
        "Home organization node must be active",
      );
    if (input.managerId) {
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "CREATE",
        "employees",
        input.managerId,
      );
      if (input.managerId === selfId)
        throw new AppError(
          409,
          "MANAGER_CYCLE",
          "An employee cannot manage themselves",
        );
      const manager = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
          this.tenant(actor),
          input.managerId,
        )
      )[0];
      if (!manager)
        throw new AppError(400, "MANAGER_INVALID", "Manager must be active");
    }
    for (const regionId of input.regionIds) {
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "CREATE",
        "organization-nodes",
        regionId,
      );
      const r = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT node_type FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
          this.tenant(actor),
          regionId,
        )
      )[0];
      if (r?.node_type !== "REGION")
        throw new AppError(
          400,
          "REGION_INVALID",
          "Region coverage must reference active region nodes",
        );
    }
    if (input.linkedMembershipId) {
      await this.scopeCapability(
        tx,
        actor,
        "identity.user.admin",
        "ADMIN",
        String(home.authorization_scope_node_id),
      );
      if (
        !(
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='ACTIVE'`,
            this.tenant(actor),
            input.linkedMembershipId,
          )
        )[0]
      )
        throw new AppError(
          404,
          "RESOURCE_NOT_FOUND",
          "Linked membership not found",
        );
    }
  }
  private async saveRegions(
    tx: Tx,
    tenant: string,
    employeeId: string,
    ids: string[],
  ) {
    await tx.$executeRawUnsafe(
      `DELETE FROM app.employee_region_coverage WHERE tenant_id=$1::uuid AND employee_id=$2::uuid`,
      tenant,
      employeeId,
    );
    for (const id of ids)
      await tx.$executeRawUnsafe(
        `INSERT INTO app.employee_region_coverage(tenant_id,employee_id,organization_node_id) VALUES($1::uuid,$2::uuid,$3::uuid)`,
        tenant,
        employeeId,
        id,
      );
  }

  private async endManagedEmployeeGrants(
    tx: Tx,
    tenant: string,
    employeeId: string,
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE app.scope_grants g SET status='INACTIVE',effective_to=coalesce(effective_to,now()),updated_at=now(),version=version+1
       FROM app.employee_scope_grant_links l
       WHERE l.tenant_id=$1::uuid AND l.employee_id=$2::uuid AND l.state='ACTIVE'
         AND g.tenant_id=l.tenant_id AND g.id=l.grant_id AND g.status='ACTIVE'`,
      tenant,
      employeeId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE app.employee_scope_grant_links SET state='INACTIVE',ended_at=now()
       WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND state='ACTIVE'`,
      tenant,
      employeeId,
    );
  }

  private async provisionManagedEmployeeGrants(
    tx: Tx,
    tenant: string,
    employeeId: string,
    membershipId: string | null,
  ) {
    if (!membershipId) return;
    const desired = await tx.$queryRawUnsafe<Row[]>(
      `SELECT n.id AS organization_id,n.authorization_scope_node_id AS scope_id,'HOME' coverage_kind
       FROM app.employees e JOIN app.organization_nodes n ON n.tenant_id=e.tenant_id AND n.id=e.home_node_id
       WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid
       UNION
       SELECT n.id,n.authorization_scope_node_id,'REGION'
       FROM app.employee_region_coverage c JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=c.organization_node_id
       WHERE c.tenant_id=$1::uuid AND c.employee_id=$2::uuid`,
      tenant,
      employeeId,
    );
    for (const target of desired) {
      const grants = await tx.$queryRawUnsafe<Row[]>(
        `WITH source_actions AS (
           SELECT DISTINCT a.id assignment_id,g.action
           FROM app.membership_role_assignments a JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id
           WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE'
             AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
             AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
         )
         INSERT INTO app.scope_grants(id,tenant_id,assignment_id,scope_node_id,action,status,effective_from)
         SELECT gen_random_uuid(),$1::uuid,assignment_id,$3::uuid,action,'ACTIVE',now() FROM source_actions
         ON CONFLICT(tenant_id,assignment_id,scope_node_id,action) DO NOTHING RETURNING id`,
        tenant,
        membershipId,
        target.scope_id,
      );
      for (const grant of grants)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.employee_scope_grant_links(tenant_id,employee_id,grant_id,coverage_kind,organization_node_id)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid)`,
          tenant,
          employeeId,
          grant.id,
          target.coverage_kind,
          target.organization_id,
        );
    }
  }

  private async bumpMembershipAuthorization(
    tx: Tx,
    tenant: string,
    membershipIds: Array<string | null | undefined>,
  ) {
    const ids = [...new Set(membershipIds.filter(Boolean).map(String))];
    if (!ids.length) return;
    await tx.$executeRawUnsafe(
      `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,updated_at=now()
       WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      tenant,
      ids,
    );
  }

  async createEmployee(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlation: string,
  ) {
    const input = employeeMasterCreateSchema.parse(raw),
      tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "employees");
      await this.capability(tx, actor, "masters.admin", "CREATE");
      await this.employeeReferences(tx, actor, input);
      if (input.email || input.mobile) {
        const home = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenant,
            input.homeNodeId,
          )
        )[0]!;
        await this.scopeCapability(
          tx,
          actor,
          "sensitive.mobile.read",
          "UPDATE",
          String(home.authorization_scope_node_id),
        );
      }
      return this.idempotent(
        tx,
        actor,
        "mst01.employee.create",
        key,
        input,
        async () => {
          const row = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.employees(tenant_id,employee_code,display_name,designation,email,mobile,manager_id,home_node_id,linked_membership_id,active_from,active_to,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::uuid,$10::date,$11::date,$12::uuid) RETURNING *`,
              tenant,
              input.employeeCode,
              input.displayName,
              input.designation,
              input.email ?? null,
              input.mobile ?? null,
              input.managerId ?? null,
              input.homeNodeId,
              input.linkedMembershipId ?? null,
              input.activeFrom,
              input.activeTo ?? null,
              actor.userId,
            )
          )[0]!;
          await this.saveRegions(tx, tenant, String(row.id), input.regionIds);
          await this.provisionManagedEmployeeGrants(
            tx,
            tenant,
            String(row.id),
            input.linkedMembershipId ?? null,
          );
          await this.bumpMembershipAuthorization(tx, tenant, [
            input.linkedMembershipId,
          ]);
          const snapshot = await this.employeeSnapshot(
            tx,
            tenant,
            String(row.id),
          );
          await this.audit(
            tx,
            actor,
            "employee.created",
            "employee",
            String(row.id),
            correlation,
            undefined,
            snapshot,
          );
          await this.event(
            tx,
            tenant,
            "employee",
            String(row.id),
            "employee.created",
            snapshot ?? row,
          );
          return row;
        },
      );
    });
  }

  async employeeView(
    actor: SessionActor,
    id?: string,
    query: {
      query?: string;
      state?: "ACTIVE" | "INACTIVE";
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.read", "READ");
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT e.id,e.employee_code AS "employeeCode",e.display_name AS "displayName",e.designation,e.email,e.mobile,e.manager_id AS "managerId",m.display_name AS "managerName",e.home_node_id AS "homeNodeId",n.name AS "homeNodeName",n.authorization_scope_node_id AS "homeScopeNodeId",e.linked_membership_id AS "linkedMembershipId",u.email AS "linkedUserEmail",e.active_from AS "activeFrom",e.active_to AS "activeTo",e.state,e.version,
        jsonb_build_object('update',app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE','employees',e.id),'deactivate',app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE','employees',e.id),'assign',app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE','employees',e.id)) permissions,
        app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'sensitive.mobile.read','READ','employees',e.id) AS "canSeeContact",
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name) FROM app.employee_region_coverage c JOIN app.organization_nodes r ON r.tenant_id=c.tenant_id AND r.id=c.organization_node_id WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id),'[]'::jsonb) regions,
        coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('role',ro.name,'scope',s.name)) FROM app.membership_role_assignments a JOIN app.roles ro ON ro.tenant_id=a.tenant_id AND ro.id=a.role_id JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id JOIN app.authorization_scope_nodes s ON s.tenant_id=g.tenant_id AND s.id=g.scope_node_id WHERE a.tenant_id=e.tenant_id AND a.membership_id=e.linked_membership_id AND a.status='ACTIVE'),'[]'::jsonb) AS "accessSummary"
        FROM app.employees e JOIN app.organization_nodes n ON n.tenant_id=e.tenant_id AND n.id=e.home_node_id LEFT JOIN app.employees m ON m.tenant_id=e.tenant_id AND m.id=e.manager_id LEFT JOIN app.tenant_memberships tm ON tm.tenant_id=e.tenant_id AND tm.id=e.linked_membership_id LEFT JOIN app.users u ON u.id=tm.user_id
        WHERE e.tenant_id=$1::uuid AND ($2::uuid IS NULL OR e.id=$2::uuid) AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','employees',e.id)
          AND ($2::uuid IS NOT NULL OR $5='' OR strpos(lower(e.employee_code||' '||e.display_name),lower($5))>0)
          AND ($2::uuid IS NOT NULL OR $6::text IS NULL OR e.state=$6)
        ORDER BY lower(e.display_name),e.employee_code,e.id LIMIT $7 OFFSET $8`,
        tenant,
        id ?? null,
        actor.membershipId,
        actor.userId,
        query.query ?? "",
        query.state ?? null,
        id ? 1 : (query.limit ?? 50),
        id ? 0 : (query.offset ?? 0),
      );
      if (id && !rows.length)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const projected = await Promise.all(
        rows.map(async (row) => {
          const result = { ...row };
          if (!bool(result.canSeeContact)) {
            result.email = result.email ? "••••" : null;
            result.mobile = result.mobile ? "••••" : null;
          }
          result.linkedUser = Boolean(result.linkedMembershipId);
          const canReadUser = await this.scopeCapability(
            tx,
            actor,
            "identity.user.read",
            "READ",
            String(result.homeScopeNodeId),
            false,
          );
          const canReadRoles =
            canReadUser &&
            (await this.scopeCapability(
              tx,
              actor,
              "identity.role.read",
              "READ",
              String(result.homeScopeNodeId),
              false,
            ));
          if (!canReadUser) {
            delete result.linkedMembershipId;
            delete result.linkedUserEmail;
          }
          if (!canReadRoles) result.accessSummary = [];
          delete result.homeScopeNodeId;
          delete result.canSeeContact;
          return result;
        }),
      );
      if (id) return projected[0];
      const canCreate = bool(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code='masters.admin' JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.action IN ('CREATE','ADMIN') WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND g.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())) allowed`,
            tenant,
            actor.membershipId,
          )
        )[0]?.allowed,
      );
      const canException = await this.hasCapability(
        tx,
        actor,
        "masters.exception",
        "ADMIN",
      );
      const total = Number(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT count(*)::int total FROM app.employees e
             WHERE e.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ','employees',e.id)
               AND ($4='' OR strpos(lower(e.employee_code||' '||e.display_name),lower($4))>0)
               AND ($5::text IS NULL OR e.state=$5)`,
            tenant,
            actor.membershipId,
            actor.userId,
            query.query ?? "",
            query.state ?? null,
          )
        )[0]!.total,
      );
      return {
        items: projected,
        total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        permissions: { canCreate, canException },
      };
    });
  }

  async updateEmployee(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlation: string,
  ) {
    const input = employeeMasterPatchSchema.parse(raw),
      tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "employees");
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "employees",
        id,
      );
      return this.idempotent(
        tx,
        actor,
        `mst01.employee.update.${id}`,
        key,
        input,
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              id,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Employee changed; reload and retry",
            );
          const beforeSnapshot = await this.employeeSnapshot(tx, tenant, id);
          const merged = {
            managerId:
              input.managerId === undefined
                ? before.manager_id
                  ? String(before.manager_id)
                  : null
                : input.managerId,
            homeNodeId: input.homeNodeId ?? String(before.home_node_id),
            regionIds:
              input.regionIds ??
              (
                await tx.$queryRawUnsafe<Row[]>(
                  `SELECT organization_node_id id FROM app.employee_region_coverage WHERE tenant_id=$1::uuid AND employee_id=$2::uuid`,
                  tenant,
                  id,
                )
              ).map((r) => String(r.id)),
            linkedMembershipId:
              input.linkedMembershipId === undefined
                ? before.linked_membership_id
                  ? String(before.linked_membership_id)
                  : null
                : input.linkedMembershipId,
          };
          const activeFrom = input.activeFrom ?? dateOnly(before.active_from),
            activeTo =
              input.activeTo === undefined ? before.active_to : input.activeTo;
          if (activeTo && dateOnly(activeTo) < activeFrom)
            throw new AppError(
              400,
              "ACTIVE_DATES_INVALID",
              "Active end must not precede start",
            );
          await this.employeeReferences(tx, actor, merged, id);
          if (
            Object.hasOwn(input, "linkedMembershipId") &&
            input.linkedMembershipId !== before.linked_membership_id
          ) {
            const home = (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
                tenant,
                merged.homeNodeId,
              )
            )[0]!;
            await this.scopeCapability(
              tx,
              actor,
              "identity.user.admin",
              "ADMIN",
              String(home.authorization_scope_node_id),
            );
          }
          if (Object.hasOwn(input, "email") || Object.hasOwn(input, "mobile")) {
            if (input.email === "••••" || input.mobile === "••••")
              throw new AppError(
                400,
                "MASKED_VALUE_INVALID",
                "Masked contact values cannot be submitted",
              );
            const home = (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
                tenant,
                merged.homeNodeId,
              )
            )[0]!;
            await this.scopeCapability(
              tx,
              actor,
              "sensitive.mobile.read",
              "UPDATE",
              String(home.authorization_scope_node_id),
            );
          }
          if (
            merged.managerId &&
            bool(
              (
                await tx.$queryRawUnsafe<Row[]>(
                  `WITH RECURSIVE reports AS (SELECT id,manager_id FROM app.employees WHERE tenant_id=$1::uuid AND manager_id=$2::uuid UNION ALL SELECT e.id,e.manager_id FROM app.employees e JOIN reports r ON e.manager_id=r.id WHERE e.tenant_id=$1::uuid) SELECT EXISTS(SELECT 1 FROM reports WHERE id=$3::uuid) cycle`,
                  tenant,
                  id,
                  merged.managerId,
                )
              )[0]?.cycle,
            )
          )
            throw new AppError(
              409,
              "MANAGER_CYCLE",
              "Manager selection creates a reporting cycle",
            );
          const row = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.employees SET employee_code=coalesce($1,employee_code),display_name=coalesce($2,display_name),designation=coalesce($3,designation),email=CASE WHEN $4 THEN $5 ELSE email END,mobile=CASE WHEN $6 THEN $7 ELSE mobile END,manager_id=$8::uuid,home_node_id=$9::uuid,linked_membership_id=$10::uuid,active_from=coalesce($11::date,active_from),active_to=CASE WHEN $12 THEN $13::date ELSE active_to END,updated_at=now(),version=version+1 WHERE tenant_id=$14::uuid AND id=$15::uuid AND version=$16 RETURNING *`,
              input.employeeCode ?? null,
              input.displayName ?? null,
              input.designation ?? null,
              Object.hasOwn(input, "email"),
              input.email ?? null,
              Object.hasOwn(input, "mobile"),
              input.mobile ?? null,
              merged.managerId,
              merged.homeNodeId,
              merged.linkedMembershipId,
              input.activeFrom ?? null,
              Object.hasOwn(input, "activeTo"),
              input.activeTo ?? null,
              tenant,
              id,
              input.expectedVersion,
            )
          )[0]!;
          if (
            input.homeNodeId ||
            input.regionIds ||
            Object.hasOwn(input, "linkedMembershipId")
          )
            await this.endManagedEmployeeGrants(tx, tenant, id);
          if (input.regionIds)
            await this.saveRegions(tx, tenant, id, input.regionIds);
          if (
            input.homeNodeId ||
            input.regionIds ||
            Object.hasOwn(input, "linkedMembershipId")
          )
            await this.provisionManagedEmployeeGrants(
              tx,
              tenant,
              id,
              merged.linkedMembershipId,
            );
          if (
            input.homeNodeId ||
            input.regionIds ||
            Object.hasOwn(input, "linkedMembershipId")
          )
            await this.bumpMembershipAuthorization(tx, tenant, [
              before.linked_membership_id
                ? String(before.linked_membership_id)
                : null,
              merged.linkedMembershipId,
            ]);
          const afterSnapshot = await this.employeeSnapshot(tx, tenant, id);
          await this.audit(
            tx,
            actor,
            "employee.updated",
            "employee",
            id,
            correlation,
            beforeSnapshot,
            afterSnapshot,
            input.reason,
          );
          await this.event(
            tx,
            tenant,
            "employee",
            id,
            "employee.updated",
            afterSnapshot ?? row,
          );
          return row;
        },
      );
    });
  }

  async employeeImpact(actor: SessionActor, id: string) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.resource(tx, actor, "masters.read", "READ", "employees", id);
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT
             (SELECT version FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid) version,
             coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.employees e WHERE tenant_id=$1::uuid AND manager_id=$2::uuid AND state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','employees',e.id)),'[]') reports,
             coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.operational_assignments a WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND (effective_to IS NULL OR effective_to>now()) AND (organization_node_id IS NULL OR app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','organization-nodes',a.organization_node_id)) AND (client_id IS NULL OR app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','clients',a.client_id))),'[]') assignments,
             coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.clients c WHERE tenant_id=$1::uuid AND account_manager_employee_id=$2::uuid AND state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','clients',c.id)),'[]') clients,
             coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.client_locations l WHERE tenant_id=$1::uuid AND manager_employee_id=$2::uuid AND state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','client-locations',l.id)),'[]') locations,
             coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.vendors v WHERE tenant_id=$1::uuid AND onboarding_employee_id=$2::uuid AND state<>'INACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','vendors',v.id)),'[]') vendors,
             coalesce((SELECT jsonb_agg(i.id ORDER BY i.id) FROM app.indents i JOIN app.employees e ON e.tenant_id=i.tenant_id AND e.id=$2::uuid WHERE i.tenant_id=$1::uuid AND i.owner_membership_id=e.linked_membership_id AND i.state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','indents',i.id)),'[]') indents,
             coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM app.allocations a JOIN app.employees e ON e.tenant_id=a.tenant_id AND e.id=$2::uuid WHERE a.tenant_id=$1::uuid AND a.owner_membership_id=e.linked_membership_id AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','allocations',a.id)),'[]') allocations,
             coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM app.operational_alerts a JOIN app.employees e ON e.tenant_id=a.tenant_id AND e.id=$2::uuid WHERE a.tenant_id=$1::uuid AND a.owner_membership_id=e.linked_membership_id AND a.state<>'RESOLVED' AND ((a.rule_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=a.tenant_id AND r.id=a.rule_id AND app.alert_rule_scope_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ',r.scope_node_ids))) OR (a.rule_id IS NULL AND a.source_record_id IS NOT NULL AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ',a.source_module,a.source_record_id)))),'[]') alerts,
             coalesce((SELECT jsonb_agg(r.id ORDER BY r.id) FROM app.alert_rules r JOIN app.employees e ON e.tenant_id=r.tenant_id AND e.id=$2::uuid WHERE r.tenant_id=$1::uuid AND r.active AND (app.jsonb_replace_string(r.recipient_policy,e.linked_membership_id::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,e.linked_membership_id::text,'')<>r.escalation_levels) AND app.alert_rule_scope_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ',r.scope_node_ids)),'[]') "alertRules"`,
          tenant,
          id,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (!row || row.version === null || row.version === undefined)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const categories = Object.fromEntries(
        [
          "reports",
          "assignments",
          "clients",
          "locations",
          "vendors",
          "indents",
          "allocations",
          "alerts",
          "alertRules",
        ].map((name) => [
          name,
          {
            count: Array.isArray(row[name]) ? row[name].length : 0,
            ids: row[name] ?? [],
          },
        ]),
      );
      return {
        snapshotId: digest({ version: Number(row.version), categories }),
        calculatedAt: new Date().toISOString(),
        versions: { employee: Number(row.version) },
        categories,
      };
    });
  }

  async organizationImpact(actor: SessionActor, id: string) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.resource(
        tx,
        actor,
        "masters.read",
        "READ",
        "organization-nodes",
        id,
      );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT
             (SELECT version FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid) version,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',n.id,'version',n.version) ORDER BY n.id) FROM app.organization_closure c JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=c.descendant_id WHERE c.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND c.depth>0 AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','organization-nodes',n.id)),'[]') descendants,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'version',e.version) ORDER BY e.id) FROM app.employees e WHERE e.tenant_id=$1::uuid AND e.home_node_id=$2::uuid AND e.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','employees',e.id)),'[]') employees,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'version',c.version) ORDER BY c.id) FROM app.clients c WHERE c.tenant_id=$1::uuid AND c.billing_entity_id=$2::uuid AND c.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','clients',c.id)),'[]') clients,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'version',l.version) ORDER BY l.id) FROM app.client_locations l WHERE l.tenant_id=$1::uuid AND l.organization_node_id=$2::uuid AND l.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','client-locations',l.id)),'[]') locations,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'version',md5(concat_ws('|',s.vendor_id::text,coalesce(s.organization_node_id::text,''),coalesce(s.lane_id::text,''),extract(epoch FROM s.effective_from)::text,coalesce(extract(epoch FROM s.effective_to)::text,'')))) ORDER BY s.id) FROM app.vendor_service_scopes s WHERE s.tenant_id=$1::uuid AND s.organization_node_id=$2::uuid AND s.effective_from<=now() AND (s.effective_to IS NULL OR s.effective_to>now())),'[]') "vendorScopes",
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',md5(concat_ws('|',a.employee_id::text,a.assignment_type,coalesce(a.organization_node_id::text,''),coalesce(a.client_id::text,''),extract(epoch FROM a.effective_from)::text,coalesce(extract(epoch FROM a.effective_to)::text,''),coalesce(a.exception_reason,'')))) ORDER BY a.id) FROM app.operational_assignments a WHERE a.tenant_id=$1::uuid AND a.organization_node_id=$2::uuid AND (a.effective_to IS NULL OR a.effective_to>now())),'[]') assignments,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'version',i.version) ORDER BY i.id) FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE i.tenant_id=$1::uuid AND (c.billing_entity_id=$2::uuid OR l.organization_node_id=$2::uuid) AND i.state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','indents',i.id)),'[]') indents,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',a.version) ORDER BY a.id) FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE a.tenant_id=$1::uuid AND (c.billing_entity_id=$2::uuid OR l.organization_node_id=$2::uuid) AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','allocations',a.id)),'[]') allocations,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'version',r.version) ORDER BY r.id) FROM app.alert_rules r JOIN app.organization_nodes n ON n.tenant_id=r.tenant_id AND n.id=$2::uuid WHERE r.tenant_id=$1::uuid AND r.active AND (n.authorization_scope_node_id=ANY(r.scope_node_ids) OR app.jsonb_replace_string(r.recipient_policy,n.authorization_scope_node_id::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,n.authorization_scope_node_id::text,'')<>r.escalation_levels OR app.jsonb_replace_string(r.recipient_policy,n.id::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,n.id::text,'')<>r.escalation_levels) AND app.alert_rule_scope_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ',r.scope_node_ids)),'[]') "alertRules",
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'version',g.version) ORDER BY g.id) FROM app.scope_grants g JOIN app.organization_nodes n ON n.tenant_id=g.tenant_id AND n.id=$2::uuid WHERE g.tenant_id=$1::uuid AND g.scope_node_id=n.authorization_scope_node_id AND g.status='ACTIVE'),'[]') grants`,
          tenant,
          id,
          actor.membershipId,
          actor.userId,
        )
      )[0]!;
      if (row.version === null || row.version === undefined)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const categories = Object.fromEntries(
        [
          "descendants",
          "employees",
          "clients",
          "locations",
          "vendorScopes",
          "assignments",
          "indents",
          "allocations",
          "alertRules",
          "grants",
        ].map((name) => [
          name,
          {
            count: Array.isArray(row[name]) ? row[name].length : 0,
            ids: Array.isArray(row[name])
              ? (row[name] as Row[]).map((record) => record.id)
              : [],
            records: row[name] ?? [],
          },
        ]),
      );
      return {
        snapshotId: digest({ version: Number(row.version), categories }),
        calculatedAt: new Date().toISOString(),
        versions: { organization: Number(row.version) },
        categories,
      };
    });
  }

  async exceptionDeactivate(
    actor: SessionActor,
    targetType: "ORGANIZATION" | "EMPLOYEE",
    id: string,
    input: {
      expectedVersion: number;
      impactSnapshotId: string;
      reason: string;
      reviewOwnerMembershipId?: string;
      reviewBy: string;
    },
    correlation: string,
    key: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, targetType.toLowerCase());
      await this.capability(tx, actor, "masters.exception", "ADMIN");
      const kind =
        targetType === "ORGANIZATION" ? "organization-nodes" : "employees";
      await this.resource(tx, actor, "masters.admin", "UPDATE", kind, id);
      const preview =
        targetType === "ORGANIZATION"
          ? await this.organizationImpact(actor, id)
          : await this.employeeImpact(actor, id);
      if (preview.snapshotId !== input.impactSnapshotId)
        throw new AppError(
          409,
          "IMPACT_CHANGED",
          "Impact changed; review the latest preview and retry",
        );
      return this.idempotent(
        tx,
        actor,
        `mst01.exception.deactivate.${targetType}.${id}`,
        key,
        input,
        async () => {
          const table =
            targetType === "ORGANIZATION"
              ? "app.organization_nodes"
              : "app.employees";
          const target = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM ${table} WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              id,
            )
          )[0];
          if (!target)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(target.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Record changed; reload and retry",
            );
          const reviewBy = new Date(`${input.reviewBy}T00:00:00.000Z`),
            now = new Date(),
            maximum = new Date(now.getTime() + 30 * 86_400_000);
          if (
            Number.isNaN(reviewBy.getTime()) ||
            reviewBy < new Date(now.toISOString().slice(0, 10)) ||
            reviewBy > maximum
          )
            throw new AppError(
              400,
              "REVIEW_DATE_INVALID",
              "Review date must be today through 30 days from today",
            );
          const reviewOwner =
            input.reviewOwnerMembershipId ?? actor.membershipId;
          const owner = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT id FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='ACTIVE'`,
              tenant,
              reviewOwner,
            )
          )[0];
          if (!owner)
            throw new AppError(
              404,
              "RESOURCE_NOT_FOUND",
              "Review owner not found",
            );
          const exception = (
            await tx.$queryRawUnsafe<Row[]>(
              `INSERT INTO app.master_deactivation_exceptions(tenant_id,target_type,target_id,impact_snapshot_id,impact_snapshot,reason,review_owner_membership_id,review_by,created_by)
               VALUES($1::uuid,$2,$3::uuid,$4,$5::jsonb,$6,$7::uuid,$8::date,$9::uuid) RETURNING *`,
              tenant,
              targetType,
              id,
              input.impactSnapshotId,
              JSON.stringify(preview),
              input.reason,
              reviewOwner,
              input.reviewBy,
              actor.userId,
            )
          )[0]!;
          if (targetType === "EMPLOYEE") {
            await this.endManagedEmployeeGrants(tx, tenant, id);
            await this.bumpMembershipAuthorization(tx, tenant, [
              target.linked_membership_id
                ? String(target.linked_membership_id)
                : null,
            ]);
          }
          const after = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE ${table} SET state='INACTIVE',active_to=current_date,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
              tenant,
              id,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO app.operational_alerts(tenant_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,evidence,owner_membership_id)
             VALUES($1::uuid,$2,$3,$4::uuid,'master.deactivation_exception_due','WARNING','Master deactivation exception requires review',$5,$6::jsonb,$7::uuid)
             ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET state='OPEN',last_seen_at=now(),updated_at=now(),version=app.operational_alerts.version+1,evidence=EXCLUDED.evidence`,
            tenant,
            `mst01:exception:${String(exception.id)}`,
            kind,
            id,
            input.reason,
            JSON.stringify({
              exceptionId: exception.id,
              resourceKind: kind,
              resourceId: id,
              targetType,
              targetId: id,
              reviewBy: input.reviewBy,
            }),
            reviewOwner,
          );
          await this.audit(
            tx,
            actor,
            "master.deactivation_exception.opened",
            "master_deactivation_exception",
            String(exception.id),
            correlation,
            target,
            { exception, target: after },
            input.reason,
          );
          await this.event(
            tx,
            tenant,
            "master_deactivation_exception",
            String(exception.id),
            "ownership.exception.opened.v1",
            {
              targetType,
              targetId: id,
              reviewBy: input.reviewBy,
              version: exception.version,
            },
          );
          return { exception, target: after };
        },
      );
    });
  }

  async exceptionReport(actor: SessionActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.exception", "ADMIN");
      await tx.$executeRawUnsafe(
        `UPDATE app.master_deactivation_exceptions SET state='EXPIRED',updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND state='OPEN' AND review_by<current_date`,
        tenant,
      );
      const items = await tx.$queryRawUnsafe<Row[]>(
        `SELECT x.id,x.target_type AS "targetType",x.target_id AS "targetId",x.impact_snapshot_id AS "impactSnapshotId",x.reason,
                x.review_owner_membership_id AS "reviewOwnerMembershipId",m.invited_name AS "reviewOwnerName",x.review_by AS "reviewBy",x.state,x.resolution_reason AS "resolutionReason",x.resolved_at AS "resolvedAt",x.version,
                CASE WHEN x.target_type='ORGANIZATION' THEN n.name ELSE e.display_name END "targetName"
         FROM app.master_deactivation_exceptions x
         LEFT JOIN app.organization_nodes n ON x.target_type='ORGANIZATION' AND n.tenant_id=x.tenant_id AND n.id=x.target_id
         LEFT JOIN app.employees e ON x.target_type='EMPLOYEE' AND e.tenant_id=x.tenant_id AND e.id=x.target_id
         JOIN app.tenant_memberships m ON m.tenant_id=x.tenant_id AND m.id=x.review_owner_membership_id
         WHERE x.tenant_id=$1::uuid AND CASE WHEN x.target_type='ORGANIZATION'
           THEN app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ','organization-nodes',x.target_id)
           ELSE app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ','employees',x.target_id) END
         ORDER BY x.review_by,x.id`,
        tenant,
        actor.membershipId,
        actor.userId,
      );
      return { items, total: items.length };
    });
  }

  async reactivateException(
    actor: SessionActor,
    exceptionId: string,
    reason: string,
    correlation: string,
    key: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "exception");
      await this.capability(tx, actor, "masters.exception", "ADMIN");
      return this.idempotent(
        tx,
        actor,
        `mst01.exception.reactivate.${exceptionId}`,
        key,
        { reason },
        async () => {
          const exception = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.master_deactivation_exceptions WHERE tenant_id=$1::uuid AND id=$2::uuid AND state IN ('OPEN','EXPIRED') FOR UPDATE`,
              tenant,
              exceptionId,
            )
          )[0];
          if (!exception)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const kind =
            exception.target_type === "ORGANIZATION"
              ? "organization-nodes"
              : "employees";
          await this.resource(
            tx,
            actor,
            "masters.admin",
            "UPDATE",
            kind,
            String(exception.target_id),
          );
          const table =
            exception.target_type === "ORGANIZATION"
              ? "app.organization_nodes"
              : "app.employees";
          const target = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE ${table} SET state='ACTIVE',active_to=NULL,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
              tenant,
              exception.target_id,
            )
          )[0]!;
          if (exception.target_type === "EMPLOYEE") {
            await this.provisionManagedEmployeeGrants(
              tx,
              tenant,
              String(exception.target_id),
              target.linked_membership_id
                ? String(target.linked_membership_id)
                : null,
            );
            await this.bumpMembershipAuthorization(tx, tenant, [
              target.linked_membership_id
                ? String(target.linked_membership_id)
                : null,
            ]);
          }
          const resolved = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.master_deactivation_exceptions SET state='RESOLVED',resolution_reason=$1,resolved_by=$2::uuid,resolved_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING *`,
              reason,
              actor.userId,
              tenant,
              exceptionId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.operational_alerts SET state='RESOLVED',resolved_at=now(),updated_at=now(),version=version+1
             WHERE tenant_id=$1::uuid AND deduplication_key=$2 AND state<>'RESOLVED'`,
            tenant,
            `mst01:exception:${exceptionId}`,
          );
          await this.audit(
            tx,
            actor,
            "master.deactivation_exception.resolved",
            "master_deactivation_exception",
            exceptionId,
            correlation,
            exception,
            resolved,
            reason,
          );
          await this.event(
            tx,
            tenant,
            "master_deactivation_exception",
            exceptionId,
            "ownership.exception.resolved.v1",
            {
              targetType: exception.target_type,
              targetId: exception.target_id,
              version: resolved.version,
            },
          );
          return { exception: resolved, target };
        },
      );
    });
  }

  async reassignDeactivateOrganization(
    actor: SessionActor,
    id: string,
    input: {
      replacementNodeId: string;
      expectedVersion: number;
      impactSnapshotId: string;
      reason: string;
    },
    correlation: string,
    key: string,
  ) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.graphLock(tx, tenant, "organization");
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "organization-nodes",
        id,
      );
      await this.resource(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "organization-nodes",
        input.replacementNodeId,
      );
      return this.idempotent(
        tx,
        actor,
        `mst01.organization.reassign.${id}`,
        key,
        input,
        async () => {
          const before = await this.organizationSnapshot(tx, tenant, id);
          const node = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              id,
            )
          )[0];
          const replacement = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE' FOR UPDATE`,
              tenant,
              input.replacementNodeId,
            )
          )[0];
          if (!node || !replacement)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(node.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Organization changed; reload and retry",
            );
          const impactRow = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',n.id,'version',n.version) ORDER BY n.id) FROM app.organization_closure c JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=c.descendant_id WHERE c.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND c.depth>0 AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','organization-nodes',n.id)),'[]') descendants,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'version',e.version) ORDER BY e.id) FROM app.employees e WHERE e.tenant_id=$1::uuid AND e.home_node_id=$2::uuid AND e.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','employees',e.id)),'[]') employees,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'version',c.version) ORDER BY c.id) FROM app.clients c WHERE c.tenant_id=$1::uuid AND c.billing_entity_id=$2::uuid AND c.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','clients',c.id)),'[]') clients,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'version',l.version) ORDER BY l.id) FROM app.client_locations l WHERE l.tenant_id=$1::uuid AND l.organization_node_id=$2::uuid AND l.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','client-locations',l.id)),'[]') locations,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'version',md5(concat_ws('|',s.vendor_id::text,coalesce(s.organization_node_id::text,''),coalesce(s.lane_id::text,''),extract(epoch FROM s.effective_from)::text,coalesce(extract(epoch FROM s.effective_to)::text,'')))) ORDER BY s.id) FROM app.vendor_service_scopes s WHERE s.tenant_id=$1::uuid AND s.organization_node_id=$2::uuid AND s.effective_from<=now() AND (s.effective_to IS NULL OR s.effective_to>now())),'[]') "vendorScopes",
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',md5(concat_ws('|',a.employee_id::text,a.assignment_type,coalesce(a.organization_node_id::text,''),coalesce(a.client_id::text,''),extract(epoch FROM a.effective_from)::text,coalesce(extract(epoch FROM a.effective_to)::text,''),coalesce(a.exception_reason,'')))) ORDER BY a.id) FROM app.operational_assignments a WHERE a.tenant_id=$1::uuid AND a.organization_node_id=$2::uuid AND (a.effective_to IS NULL OR a.effective_to>now())),'[]') assignments,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'version',i.version) ORDER BY i.id) FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE i.tenant_id=$1::uuid AND (c.billing_entity_id=$2::uuid OR l.organization_node_id=$2::uuid) AND i.state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','indents',i.id)),'[]') indents,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',a.version) ORDER BY a.id) FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE a.tenant_id=$1::uuid AND (c.billing_entity_id=$2::uuid OR l.organization_node_id=$2::uuid) AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','allocations',a.id)),'[]') allocations,
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'version',r.version) ORDER BY r.id) FROM app.alert_rules r JOIN app.organization_nodes n ON n.tenant_id=r.tenant_id AND n.id=$2::uuid WHERE r.tenant_id=$1::uuid AND r.active AND (n.authorization_scope_node_id=ANY(r.scope_node_ids) OR app.jsonb_replace_string(r.recipient_policy,n.authorization_scope_node_id::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,n.authorization_scope_node_id::text,'')<>r.escalation_levels OR app.jsonb_replace_string(r.recipient_policy,n.id::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,n.id::text,'')<>r.escalation_levels) AND app.alert_rule_scope_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ',r.scope_node_ids)),'[]') "alertRules",
             coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'version',g.version) ORDER BY g.id) FROM app.scope_grants g WHERE g.tenant_id=$1::uuid AND g.scope_node_id=$5::uuid AND g.status='ACTIVE'),'[]') grants`,
              tenant,
              id,
              actor.membershipId,
              actor.userId,
              node.authorization_scope_node_id,
            )
          )[0]!;
          const impactCategories = Object.fromEntries(
            [
              "descendants",
              "employees",
              "clients",
              "locations",
              "vendorScopes",
              "assignments",
              "indents",
              "allocations",
              "alertRules",
              "grants",
            ].map((name) => [
              name,
              {
                count: Array.isArray(impactRow[name])
                  ? impactRow[name].length
                  : 0,
                ids: Array.isArray(impactRow[name])
                  ? (impactRow[name] as Row[]).map((record) => record.id)
                  : [],
                records: impactRow[name] ?? [],
              },
            ]),
          );
          if (
            digest({
              version: Number(node.version),
              categories: impactCategories,
            }) !== input.impactSnapshotId
          )
            throw new AppError(
              409,
              "IMPACT_CHANGED",
              "Impact changed; review the latest preview and retry",
            );
          if (
            id === input.replacementNodeId ||
            String(node.node_type) !== String(replacement.node_type)
          )
            throw new AppError(
              400,
              "REPLACEMENT_INVALID",
              "Replacement must be another active node of the same type",
            );
          const affected = Object.fromEntries(
            Object.entries(impactCategories).map(([name, detail]) => [
              name,
              detail.ids,
            ]),
          ) as Row;
          for (const [resource, ids] of [
            ["employees", affected.employees],
            ["clients", affected.clients],
            ["client-locations", affected.locations],
            ["indents", affected.indents],
            ["allocations", affected.allocations],
          ] as Array<[string, unknown]>)
            for (const resourceId of Array.isArray(ids) ? ids : [])
              await this.resource(
                tx,
                actor,
                "masters.admin",
                "UPDATE",
                resource,
                String(resourceId),
              );
          const affectedVendors = await tx.$queryRawUnsafe<Row[]>(
            `SELECT DISTINCT vendor_id id FROM app.vendor_service_scopes WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
            tenant,
            affected.vendorScopes,
          );
          for (const vendor of affectedVendors)
            await this.resource(
              tx,
              actor,
              "masters.admin",
              "UPDATE",
              "vendors",
              String(vendor.id),
            );
          const rulesDenied = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.id=ANY($4::uuid[]) AND NOT app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE',r.scope_node_ids)) denied`,
              tenant,
              actor.membershipId,
              actor.userId,
              affected.alertRules,
            )
          )[0];
          if (bool(rulesDenied?.denied))
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const descendants = Number(
            (
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT count(*)::int count FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid AND depth>0`,
                tenant,
                id,
              )
            )[0]?.count ?? 0,
          );
          if (descendants)
            throw new AppError(
              409,
              "DESCENDANTS_REQUIRE_MOVE",
              "Move child organization nodes before deactivation",
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.employees SET home_node_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND home_node_id=$3::uuid AND state='ACTIVE' AND id=ANY($4::uuid[])`,
            input.replacementNodeId,
            tenant,
            id,
            affected.employees,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.clients SET billing_entity_id=$1::uuid,authorization_scope_node_id=$2::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND billing_entity_id=$4::uuid AND state='ACTIVE' AND id=ANY($5::uuid[])`,
            input.replacementNodeId,
            replacement.authorization_scope_node_id,
            tenant,
            id,
            affected.clients,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.client_locations SET organization_node_id=$1::uuid,authorization_scope_node_id=$2::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$3::uuid AND organization_node_id=$4::uuid AND state='ACTIVE' AND id=ANY($5::uuid[])`,
            input.replacementNodeId,
            replacement.authorization_scope_node_id,
            tenant,
            id,
            affected.locations,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.vendor_service_scopes SET organization_node_id=$1::uuid WHERE tenant_id=$2::uuid AND organization_node_id=$3::uuid AND id=ANY($4::uuid[])`,
            input.replacementNodeId,
            tenant,
            id,
            affected.vendorScopes,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.operational_assignments SET organization_node_id=$1::uuid WHERE tenant_id=$2::uuid AND organization_node_id=$3::uuid AND id=ANY($4::uuid[])`,
            input.replacementNodeId,
            tenant,
            id,
            affected.assignments,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.alert_rules SET
               scope_node_ids=array_replace(scope_node_ids,$1::uuid,$2::uuid),
               recipient_policy=app.jsonb_replace_string(app.jsonb_replace_string(recipient_policy,$1::text,$2::text),$3,$4),
               escalation_levels=app.jsonb_replace_string(app.jsonb_replace_string(escalation_levels,$1::text,$2::text),$3,$4),
               updated_at=now(),version=version+1
             WHERE tenant_id=$5::uuid AND id=ANY($6::uuid[])`,
            String(node.authorization_scope_node_id),
            String(replacement.authorization_scope_node_id),
            id,
            input.replacementNodeId,
            tenant,
            affected.alertRules,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.scope_grants old SET status='INACTIVE',effective_to=coalesce(old.effective_to,now()),updated_at=now(),version=old.version+1
         WHERE old.tenant_id=$1::uuid AND old.scope_node_id=$2::uuid AND old.status='ACTIVE'
           AND EXISTS(SELECT 1 FROM app.scope_grants keep WHERE keep.tenant_id=old.tenant_id AND keep.assignment_id=old.assignment_id AND keep.scope_node_id=$3::uuid AND keep.action=old.action AND keep.status='ACTIVE')`,
            tenant,
            node.authorization_scope_node_id,
            replacement.authorization_scope_node_id,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.employee_scope_grant_links l SET state='INACTIVE',ended_at=now()
         WHERE l.tenant_id=$1::uuid AND l.state='ACTIVE' AND EXISTS(SELECT 1 FROM app.scope_grants g WHERE g.tenant_id=l.tenant_id AND g.id=l.grant_id AND g.scope_node_id=$2::uuid AND g.status='INACTIVE')`,
            tenant,
            node.authorization_scope_node_id,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.scope_grants SET scope_node_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND scope_node_id=$3::uuid AND status='ACTIVE'`,
            replacement.authorization_scope_node_id,
            tenant,
            node.authorization_scope_node_id,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.employee_scope_grant_links SET organization_node_id=$1::uuid WHERE tenant_id=$2::uuid AND organization_node_id=$3::uuid AND state='ACTIVE'`,
            input.replacementNodeId,
            tenant,
            id,
          );
          const row = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.organization_nodes SET state='INACTIVE',active_to=current_date,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
              tenant,
              id,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.authorization_scope_nodes SET status='INACTIVE',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid AND canonical_resource_id=$3::uuid`,
            tenant,
            node.authorization_scope_node_id,
            id,
          );
          const after = await this.organizationSnapshot(tx, tenant, id);
          await this.audit(
            tx,
            actor,
            "organization.reassigned_and_deactivated",
            "organization_node",
            id,
            correlation,
            { organization: before, affected },
            {
              organization: after,
              replacementNodeId: input.replacementNodeId,
              affected,
            },
            input.reason,
          );
          await this.event(
            tx,
            tenant,
            "organization_node",
            id,
            "organization.reassigned_and_deactivated",
            {
              version: row.version,
              organization: after ?? row,
              replacementNodeId: input.replacementNodeId,
              affected,
            },
          );
          return row;
        },
      );
    });
  }

  private ownershipItems(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: string,
  ) {
    const tenant = this.tenant(actor);
    return tx.$queryRawUnsafe<Row[]>(
      `SELECT * FROM (
       SELECT 'clients' "resourceKind",c.id,c.code,c.legal_name name,e.employee_code "ownerCode",e.display_name "ownerName",
         CASE WHEN c.account_manager_employee_id IS NULL THEN 'UNOWNED' WHEN e.state<>'ACTIVE' OR e.id IS NULL THEN 'INACTIVE_OWNER' ELSE 'OWNED' END "ownershipState"
       FROM app.clients c LEFT JOIN app.employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id
       WHERE c.tenant_id=$1::uuid AND c.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,'clients',c.id)
       UNION ALL SELECT 'client-locations',l.id,l.code,l.name,e.employee_code,e.display_name,
         CASE WHEN l.manager_employee_id IS NULL THEN 'UNOWNED' WHEN e.state<>'ACTIVE' OR e.id IS NULL THEN 'INACTIVE_OWNER' ELSE 'OWNED' END
       FROM app.client_locations l LEFT JOIN app.employees e ON e.tenant_id=l.tenant_id AND e.id=l.manager_employee_id
       WHERE l.tenant_id=$1::uuid AND l.state='ACTIVE' AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,'client-locations',l.id)
       UNION ALL SELECT 'vendors',v.id,v.code,v.legal_name,e.employee_code,e.display_name,
         CASE WHEN v.onboarding_employee_id IS NULL THEN 'UNOWNED' WHEN e.state<>'ACTIVE' OR e.id IS NULL THEN 'INACTIVE_OWNER' ELSE 'OWNED' END
       FROM app.vendors v LEFT JOIN app.employees e ON e.tenant_id=v.tenant_id AND e.id=v.onboarding_employee_id
       WHERE v.tenant_id=$1::uuid AND v.state IN ('ONBOARDING','ACTIVE') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,'vendors',v.id)
       UNION ALL SELECT 'indents',i.id,i.indent_no,i.indent_no,e.employee_code,e.display_name,
         CASE WHEN i.owner_membership_id IS NULL THEN 'UNOWNED' WHEN m.status<>'ACTIVE' OR m.id IS NULL THEN 'INACTIVE_OWNER' ELSE 'OWNED' END
       FROM app.indents i LEFT JOIN app.tenant_memberships m ON m.tenant_id=i.tenant_id AND m.id=i.owner_membership_id LEFT JOIN app.employees e ON e.tenant_id=i.tenant_id AND e.linked_membership_id=m.id
       WHERE i.tenant_id=$1::uuid AND i.state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,'indents',i.id)
       UNION ALL SELECT 'allocations',a.id,a.id::text,a.id::text,e.employee_code,e.display_name,
         CASE WHEN a.owner_membership_id IS NULL THEN 'UNOWNED' WHEN m.status<>'ACTIVE' OR m.id IS NULL THEN 'INACTIVE_OWNER' ELSE 'OWNED' END
       FROM app.allocations a LEFT JOIN app.tenant_memberships m ON m.tenant_id=a.tenant_id AND m.id=a.owner_membership_id LEFT JOIN app.employees e ON e.tenant_id=a.tenant_id AND e.linked_membership_id=m.id
       WHERE a.tenant_id=$1::uuid AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,'allocations',a.id)
       UNION ALL SELECT 'alert-rules',r.id,r.code,r.name,null,null,
         CASE WHEN NOT ${activeAlertRecipientSql} THEN 'NO_ESCALATION' ELSE 'OWNED' END
       FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.active AND app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,r.scope_node_ids)
      ) resources ORDER BY "resourceKind",code,id`,
      tenant,
      actor.membershipId,
      actor.userId,
      capability,
      action,
    );
  }

  async ownershipReport(actor: SessionActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.read", "READ");
      const items = await this.ownershipItems(
        tx,
        actor,
        "masters.read",
        "READ",
      );
      const alerts = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id,alert_type AS "alertType",state,severity,source_record_id AS "sourceRecordId",evidence,last_seen_at AS "lastSeenAt"
         FROM app.operational_alerts WHERE tenant_id=$1::uuid AND source_module='MST-01' AND state<>'RESOLVED'
           AND source_record_id IS NOT NULL
           AND CASE WHEN evidence->>'resourceKind'='alert-rules' THEN EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.id=source_record_id AND app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ',r.scope_node_ids))
             ELSE app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.read','READ',evidence->>'resourceKind',source_record_id) END
         ORDER BY severity,last_seen_at DESC`,
        tenant,
        actor.membershipId,
        actor.userId,
      );
      return {
        total: items.length,
        owned: items.filter((item) => item.ownershipState === "OWNED").length,
        unowned: items.filter((item) => item.ownershipState === "UNOWNED")
          .length,
        inactiveOwner: items.filter(
          (item) => item.ownershipState === "INACTIVE_OWNER",
        ).length,
        noEscalation: items.filter(
          (item) => item.ownershipState === "NO_ESCALATION",
        ).length,
        items,
        alerts,
        generatedAt: new Date().toISOString(),
        permissions: {
          canExport: await this.hasCapability(
            tx,
            actor,
            "masters.export",
            "EXPORT",
          ),
          canRefreshAlerts: await this.hasCapability(
            tx,
            actor,
            "masters.admin",
            "ADMIN",
          ),
        },
      };
    });
  }

  async ownershipExport(actor: SessionActor, correlation: string) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.export", "EXPORT");
      const items = await this.ownershipItems(
        tx,
        actor,
        "masters.export",
        "EXPORT",
      );
      const generatedAt = new Date().toISOString();
      await this.audit(
        tx,
        actor,
        "ownership.exported",
        "ownership_report",
        tenant,
        correlation,
        undefined,
        { rowCount: items.length, generatedAt },
      );
      return { items, generatedAt };
    });
  }

  async evaluateOwnershipAlerts(actor: SessionActor) {
    const tenant = this.tenant(actor);
    return withTenant(this.app.db, tenant, async (tx) => {
      await this.capability(tx, actor, "masters.admin", "ADMIN");
      await this.graphLock(tx, tenant, "ownership-alerts");
      const exceptions = await tx.$queryRawUnsafe<Row[]>(
        `SELECT c.id,c.code,'clients' resource_kind,'Client has no active account manager' title,CASE WHEN c.account_manager_employee_id IS NULL THEN 'unowned' ELSE 'inactive_owner' END condition FROM app.clients c LEFT JOIN app.employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id AND e.state='ACTIVE'
         WHERE c.tenant_id=$1::uuid AND c.state='ACTIVE' AND e.id IS NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','clients',c.id)
         UNION ALL SELECT l.id,l.code,'client-locations','Client location has no active manager',CASE WHEN l.manager_employee_id IS NULL THEN 'unowned' ELSE 'inactive_owner' END FROM app.client_locations l LEFT JOIN app.employees e ON e.tenant_id=l.tenant_id AND e.id=l.manager_employee_id AND e.state='ACTIVE'
         WHERE l.tenant_id=$1::uuid AND l.state='ACTIVE' AND e.id IS NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','client-locations',l.id)
         UNION ALL SELECT v.id,v.code,'vendors','Vendor has no active onboarding owner',CASE WHEN v.onboarding_employee_id IS NULL THEN 'unowned' ELSE 'inactive_owner' END FROM app.vendors v LEFT JOIN app.employees e ON e.tenant_id=v.tenant_id AND e.id=v.onboarding_employee_id AND e.state='ACTIVE'
         WHERE v.tenant_id=$1::uuid AND v.state IN ('ONBOARDING','ACTIVE') AND e.id IS NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','vendors',v.id)
         UNION ALL SELECT i.id,i.indent_no,'indents','Open indent has no active owner',CASE WHEN i.owner_membership_id IS NULL THEN 'unowned' ELSE 'inactive_owner' END FROM app.indents i LEFT JOIN app.tenant_memberships m ON m.tenant_id=i.tenant_id AND m.id=i.owner_membership_id AND m.status='ACTIVE'
         WHERE i.tenant_id=$1::uuid AND i.state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND m.id IS NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','indents',i.id)
         UNION ALL SELECT a.id,a.id::text,'allocations','Open allocation has no active owner',CASE WHEN a.owner_membership_id IS NULL THEN 'unowned' ELSE 'inactive_owner' END FROM app.allocations a LEFT JOIN app.tenant_memberships m ON m.tenant_id=a.tenant_id AND m.id=a.owner_membership_id AND m.status='ACTIVE'
         WHERE a.tenant_id=$1::uuid AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND m.id IS NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','allocations',a.id)
         UNION ALL SELECT r.id,r.code,'alert-rules','Active escalation rule has no recipients','no_escalation' FROM app.alert_rules r
         WHERE r.tenant_id=$1::uuid AND r.active AND NOT ${activeAlertRecipientSql}
           AND app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','ADMIN',r.scope_node_ids)`,
        tenant,
        actor.membershipId,
        actor.userId,
      );
      const keys: string[] = [];
      for (const item of exceptions) {
        const alertType = `ownership.${String(item.condition)}`;
        const key = `mst01:${alertType}:${String(item.resource_kind)}:${String(item.id)}`;
        keys.push(key);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.operational_alerts(tenant_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,evidence)
           VALUES($1::uuid,$2,'MST-01',$3::uuid,$7,'WARNING',$4,$5,$6::jsonb)
           ON CONFLICT(tenant_id,deduplication_key) DO UPDATE SET last_seen_at=now(),state=CASE WHEN app.operational_alerts.state='RESOLVED' THEN 'OPEN' ELSE app.operational_alerts.state END,resolved_at=null,evidence=EXCLUDED.evidence,updated_at=now(),version=app.operational_alerts.version+1`,
          tenant,
          key,
          item.id,
          item.title,
          `Review ${String(item.code)} in Masters ownership`,
          JSON.stringify({
            resourceId: item.id,
            resourceCode: item.code,
            resourceKind: item.resource_kind,
            condition: item.condition,
          }),
          alertType,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE app.operational_alerts SET state='RESOLVED',resolved_at=now(),updated_at=now(),version=version+1
         WHERE tenant_id=$1::uuid AND source_module='MST-01' AND alert_type IN ('ownership.unowned','ownership.inactive_owner','ownership.no_escalation') AND state<>'RESOLVED'
           AND source_record_id IS NOT NULL
           AND CASE WHEN evidence->>'resourceKind'='alert-rules' THEN EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.id=source_record_id AND app.alert_rule_scope_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','ADMIN',r.scope_node_ids))
             ELSE app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.admin','UPDATE',evidence->>'resourceKind',source_record_id) END
           AND NOT (deduplication_key=ANY($2::text[]))`,
        tenant,
        keys,
        actor.membershipId,
        actor.userId,
      );
      return { evaluated: exceptions.length, open: keys.length };
    });
  }
}
