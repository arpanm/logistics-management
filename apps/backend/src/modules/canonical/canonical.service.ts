import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import {
  allocationCommandSchema,
  calculateMoneyLine,
  clientCommandSchema,
  clientLocationCommandSchema,
  configurationCommandSchema,
  contractCommandSchema,
  driverCommandSchema,
  documentUploadSchema,
  employeeCommandSchema,
  indentCommandSchema,
  invoiceCommandSchema,
  laneCommandSchema,
  organizationNodeCommandSchema,
  receiptAllocationSchema,
  receiptCommandSchema,
  toJsonSafe,
  transitionCommandSchema,
  tripEventCommandSchema,
  vehicleCommandSchema,
  vendorCommandSchema,
} from "@logistics/domain";
import { z } from "zod";
import { withTenant, type Prisma } from "@logistics/db";
import { AppError, AppService } from "../../app.service.js";
import { canonicalJson, tenantKeyHash } from "../control/idempotency.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type Action = "READ" | "CREATE" | "UPDATE" | "APPROVE" | "EXPORT" | "ADMIN";

const resources = {
  "organization-nodes": {
    table: "organization_nodes",
    capability: "masters",
    scope: "authorization_scope_node_id",
  },
  employees: { table: "employees", capability: "masters", scope: null },
  clients: {
    table: "clients",
    capability: "masters",
    scope: "authorization_scope_node_id",
  },
  "client-locations": {
    table: "client_locations",
    capability: "masters",
    scope: "authorization_scope_node_id",
  },
  contracts: { table: "contracts", capability: "masters", scope: null },
  lanes: { table: "contract_lanes", capability: "masters", scope: null },
  vendors: {
    table: "vendors",
    capability: "masters",
    scope: "authorization_scope_node_id",
  },
  vehicles: { table: "vehicles", capability: "masters", scope: null },
  drivers: { table: "drivers", capability: "masters", scope: null },
  indents: { table: "indents", capability: "operations", scope: null },
  allocations: { table: "allocations", capability: "operations", scope: null },
  trips: { table: "trips", capability: "operations", scope: null },
  "pod-tasks": { table: "pod_tasks", capability: "pod", scope: null },
  invoices: { table: "client_invoices", capability: "finance", scope: null },
  receipts: { table: "receipts", capability: "finance", scope: null },
  "vendor-bills": { table: "vendor_bills", capability: "finance", scope: null },
  configurations: {
    table: "configuration_versions",
    capability: "configuration",
    scope: null,
  },
} as const;
export type CanonicalResource = keyof typeof resources;

const transitions: Record<
  CanonicalResource,
  Record<string, readonly string[]>
> = {
  "organization-nodes": { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  employees: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  clients: { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  "client-locations": { ACTIVE: ["INACTIVE"], INACTIVE: ["ACTIVE"] },
  contracts: {
    DRAFT: ["PENDING_APPROVAL"],
    PENDING_APPROVAL: ["APPROVED", "DRAFT"],
    APPROVED: ["PUBLISHED"],
    PUBLISHED: ["SUPERSEDED", "INACTIVE"],
    SUPERSEDED: [],
    INACTIVE: [],
  },
  lanes: {},
  vendors: {
    ONBOARDING: ["ACTIVE", "BLOCKED"],
    ACTIVE: ["BLOCKED", "INACTIVE"],
    BLOCKED: ["ACTIVE", "INACTIVE"],
    INACTIVE: ["ACTIVE"],
  },
  vehicles: {
    ACTIVE: ["BLOCKED", "INACTIVE"],
    BLOCKED: ["ACTIVE", "INACTIVE"],
    INACTIVE: ["ACTIVE"],
  },
  drivers: {
    ACTIVE: ["BLOCKED", "INACTIVE"],
    BLOCKED: ["ACTIVE", "INACTIVE"],
    INACTIVE: ["ACTIVE"],
  },
  indents: {
    DRAFT: ["OPEN", "CANCELLED"],
    OPEN: ["PARTIALLY_ALLOCATED", "FULFILLED", "CANCELLED"],
    PARTIALLY_ALLOCATED: ["FULFILLED", "CANCELLED"],
    FULFILLED: ["CLOSED"],
    CANCELLED: [],
    CLOSED: [],
  },
  allocations: {
    OFFERED: ["ACCEPTED", "REJECTED", "EXPIRED"],
    ACCEPTED: ["VEHICLE_ASSIGNED", "CANCELLED"],
    VEHICLE_ASSIGNED: ["NTP_RELEASED", "CANCELLED"],
    NTP_RELEASED: ["PLACED", "CANCELLED"],
    PLACED: [],
    REJECTED: [],
    EXPIRED: [],
    CANCELLED: [],
  },
  trips: {
    PLANNED: ["AT_ORIGIN", "CANCELLED"],
    AT_ORIGIN: ["LOADED", "CANCELLED"],
    LOADED: ["IN_TRANSIT"],
    IN_TRANSIT: ["AT_DESTINATION"],
    AT_DESTINATION: ["DELIVERED"],
    DELIVERED: [],
    CANCELLED: [],
  },
  "pod-tasks": {
    AWAITING_POD: ["RECEIVED"],
    RECEIVED: ["UNDER_REVIEW"],
    UNDER_REVIEW: ["ACCEPTED", "REJECTED", "CORRECTION_REQUIRED"],
    REJECTED: ["CORRECTION_REQUIRED"],
    CORRECTION_REQUIRED: ["UNDER_REVIEW", "ACCEPTED"],
    ACCEPTED: ["SUBMITTED_TO_CLIENT"],
    SUBMITTED_TO_CLIENT: ["CLOSED"],
    CLOSED: [],
  },
  invoices: {
    DRAFT: ["PENDING_APPROVAL"],
    PENDING_APPROVAL: ["APPROVED", "REJECTED"],
    REJECTED: ["PENDING_APPROVAL"],
    APPROVED: ["POSTED"],
    POSTED: ["SUBMITTED", "REVERSED"],
    SUBMITTED: ["REVERSED"],
    REVERSED: [],
  },
  receipts: {
    UNRECONCILED: ["PENDING_APPROVAL"],
    PENDING_APPROVAL: ["RECONCILED", "UNRECONCILED"],
    RECONCILED: ["REVERSED"],
    REVERSED: [],
  },
  "vendor-bills": {
    DRAFT: ["VALIDATION_EXCEPTION", "PENDING_OPERATIONAL_VERIFICATION"],
    VALIDATION_EXCEPTION: ["DRAFT"],
    PENDING_OPERATIONAL_VERIFICATION: ["PENDING_FINANCE_APPROVAL"],
    PENDING_FINANCE_APPROVAL: ["APPROVED", "DISPUTED"],
    APPROVED: ["PART_PAID", "PAID", "REVERSED"],
    PART_PAID: ["PAID", "REVERSED"],
    PAID: ["REVERSED"],
    DISPUTED: ["DRAFT"],
    REVERSED: [],
  },
  configurations: {
    DRAFT: ["PUBLISHED"],
    PUBLISHED: ["SUPERSEDED"],
    SUPERSEDED: [],
  },
};

const hash = (value: unknown) =>
  createHash("sha256")
    .update(canonicalJson(toJsonSafe(value)))
    .digest("hex");
const hashBuffer = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const governedTargets: Record<string, { resource: CanonicalResource }> = {
  ORGANIZATION_NODE: { resource: "organization-nodes" },
  EMPLOYEE: { resource: "employees" },
  CLIENT: { resource: "clients" },
  VENDOR: { resource: "vendors" },
  VEHICLE: { resource: "vehicles" },
  DRIVER: { resource: "drivers" },
  INDENT: { resource: "indents" },
  ALLOCATION: { resource: "allocations" },
  TRIP: { resource: "trips" },
  POD: { resource: "pod-tasks" },
  INVOICE: { resource: "invoices" },
  RECEIPT: { resource: "receipts" },
  VENDOR_BILL: { resource: "vendor-bills" },
};

const sensitiveFields = {
  "sensitive.tax_identifier.read": [
    "pan",
    "gstin",
    "taxIdentifier",
    "tax_identifier",
  ],
  "sensitive.mobile.read": [
    "mobile",
    "escalationMobile",
    "escalation_mobile",
    "emergencyContact",
    "emergency_contact",
  ],
  "sensitive.bank_detail.read": [
    "accountCiphertext",
    "account_ciphertext",
    "bankReference",
    "bank_reference",
    "instrumentNo",
    "instrument_no",
  ],
  "sensitive.commercial_rate.read": [
    "commercialSnapshot",
    "commercial_snapshot",
    "rateSnapshot",
    "rate_snapshot",
    "offeredRateMinor",
    "offered_rate_minor",
    "rateMinor",
    "rate_minor",
  ],
  "sensitive.payment.read": [
    "taxableMinor",
    "taxable_minor",
    "taxMinor",
    "tax_minor",
    "totalMinor",
    "total_minor",
    "payableMinor",
    "payable_minor",
    "amountMinor",
    "amount_minor",
  ],
  "sensitive.internal_margin.read": [
    "internalMarginMinor",
    "internal_margin_minor",
  ],
} as const;

@Injectable()
export class CanonicalService {
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

  private definition(resource: string) {
    const definition = resources[resource as CanonicalResource];
    if (!definition)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    return definition;
  }

  private async referenceCode(
    tx: Tx,
    tenantId: string,
    id: string | undefined,
    kind: "TRUCK_TYPE" | "BODY_TYPE" | "CARGO_TYPE",
    legacy?: string,
  ) {
    if (!id) return legacy ?? null;
    const row = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT code FROM app.transport_reference_masters WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3 AND state='ACTIVE'`,
        tenantId,
        id,
        kind,
      )
    )[0];
    if (!row)
      throw new AppError(
        400,
        "REFERENCE_INVALID",
        `Select an active ${kind.toLowerCase().replaceAll("_", " ")}`,
      );
    return String(row.code);
  }

  private async access(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
  ) {
    const tenantId = this.tenant(actor);
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT m.portal_audience AS audience,g.scope_node_id AS "scopeNodeId",n.scope_type AS "scopeType",g.action
       FROM app.tenant_memberships m
       JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
       JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$4
       JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN ($5,'ADMIN')
       JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE'
       WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid AND m.user_id=$3::uuid AND m.status='ACTIVE'`,
      tenantId,
      actor.membershipId,
      actor.userId,
      capability,
      action,
    );
    if (!rows.length)
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
    return rows;
  }

  private async assertScope(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
    scopeNodeId?: string | null,
  ) {
    const grants = await this.access(tx, actor, capability, action);
    if (grants.some((grant) => grant.scopeType === "TENANT")) return grants;
    if (!scopeNodeId)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    const allowed = await tx.$queryRawUnsafe<Array<Row>>(
      `WITH RECURSIVE ancestors AS (
         SELECT id,parent_id FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid
         UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors a ON a.parent_id=n.id WHERE n.tenant_id=$1::uuid
       ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=ANY($3::uuid[])) allowed`,
      this.tenant(actor),
      scopeNodeId,
      grants.map((row) => String(row.scopeNodeId)),
    );
    if (!rowsBoolean(allowed[0]?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    return grants;
  }

  private async assertResourceScope(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
    resource: CanonicalResource,
    resourceId: string,
  ) {
    const allowed = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid) allowed`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        capability,
        action,
        resource,
        resourceId,
      )
    )[0];
    if (!rowsBoolean(allowed?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private governedTarget(targetType: string) {
    const target = governedTargets[targetType.toUpperCase()];
    if (!target)
      throw new AppError(
        400,
        "GOVERNED_TARGET_INVALID",
        "Unsupported governed target type",
      );
    return target;
  }

  private async createScopeNode(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    requested?: string | null,
  ) {
    if (requested) {
      await this.assertScope(tx, actor, capability, "CREATE", requested);
      return requested;
    }
    const grants = await this.access(tx, actor, capability, "CREATE");
    const scopeNodeId = grants[0]?.scopeNodeId;
    if (!scopeNodeId)
      throw new AppError(
        403,
        "SCOPE_REQUIRED",
        "A permitted scope is required",
      );
    return String(scopeNodeId);
  }

  private async audit(
    tx: Tx,
    actor: SessionActor,
    action: string,
    targetType: string,
    targetId: string,
    correlationId: string,
    before?: unknown,
    after?: unknown,
    reason?: string,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,reason,before_json,after_json)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9::jsonb)`,
      this.tenant(actor),
      actor.userId,
      action,
      targetType,
      targetId,
      correlationId,
      reason ?? null,
      before === undefined ? null : JSON.stringify(toJsonSafe(before)),
      after === undefined ? null : JSON.stringify(toJsonSafe(after)),
    );
  }

  private async event(
    tx: Tx,
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: unknown,
    version: number,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
       VALUES($1::uuid,'TENANT',$2,$3::uuid,$4,$5,$6::jsonb,$7) ON CONFLICT(deduplication_key) DO NOTHING`,
      tenantId,
      aggregateType,
      aggregateId,
      eventType,
      version,
      JSON.stringify(toJsonSafe(payload)),
      `${tenantId}:${aggregateType}:${aggregateId}:${eventType}:v${version}`,
    );
  }

  private async idempotent<T>(
    tx: Tx,
    actor: SessionActor,
    operation: string,
    key: string,
    input: unknown,
    execute: () => Promise<T>,
  ): Promise<T & { replayed?: boolean }> {
    if (!key.trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required",
      );
    const tenantId = this.tenant(actor);
    const keyHash = tenantKeyHash(tenantId, key);
    const requestHash = hash(input);
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:${operation}:${keyHash}`,
    );
    const existing = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT request_hash AS "requestHash",response_json AS response FROM app.idempotency_records WHERE actor_id=$1::uuid AND operation=$2 AND key_hash=$3`,
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
          "Idempotency key was used for different input",
        );
      return { ...(existing.response as T), replayed: true };
    }
    const response = toJsonSafe(await execute()) as T;
    await tx.$executeRawUnsafe(
      `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,resource_id,response_json)
       VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      tenantId,
      actor.userId,
      operation,
      keyHash,
      requestHash,
      (response as { id?: string }).id ?? null,
      JSON.stringify(response),
    );
    return response as T & { replayed?: boolean };
  }

  private async project(
    tx: Tx,
    actor: SessionActor,
    resource: CanonicalResource,
    row: Row,
    audience = "INTERNAL",
  ) {
    const result = { ...row };
    const resourceId = String(row.id ?? "");
    const capabilities = Object.keys(sensitiveFields);
    const decisions = resourceId
      ? await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT capability,app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,capability,'READ',$4,$5::uuid) allowed FROM unnest($6::text[]) AS requested(capability)`,
          this.tenant(actor),
          actor.membershipId,
          actor.userId,
          resource,
          resourceId,
          capabilities,
        )
      : [];
    const allowed = new Set(
      decisions
        .filter((decision) => rowsBoolean(decision.allowed))
        .map((decision) => String(decision.capability)),
    );
    for (const [capability, fields] of Object.entries(sensitiveFields)) {
      if (!allowed.has(capability)) {
        for (const key of fields) {
          if (key in result) result[key] = result[key] === null ? null : "••••";
        }
      }
    }
    if (audience !== "INTERNAL") {
      for (const key of [
        ...sensitiveFields["sensitive.commercial_rate.read"],
        ...sensitiveFields["sensitive.internal_margin.read"],
      ])
        delete result[key];
    }
    return toJsonSafe(result) as Row;
  }

  async list(
    actor: SessionActor,
    resource: string,
    search = "",
    state = "",
    page = 1,
    pageSize = 50,
  ) {
    const definition = this.definition(resource);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(
        tx,
        actor,
        `${definition.capability}.read`,
        "READ",
      );
      const rows = await tx.$queryRawUnsafe<Array<Row & { total: number }>>(
        `SELECT to_jsonb(r) AS record,count(*) OVER()::int total FROM app.${definition.table} r
         WHERE r.tenant_id=$1::uuid
           AND ($2='' OR coalesce(to_jsonb(r)->>'code',to_jsonb(r)->>'name',to_jsonb(r)->>'display_name','') ILIKE $3)
           AND ($4='' OR coalesce(to_jsonb(r)->>'state','')=$4)
           AND app.domain_resource_authorized($1::uuid,$5::uuid,$6::uuid,$7,'READ',$8,r.id)
         ORDER BY coalesce(to_jsonb(r)->>'updated_at',to_jsonb(r)->>'created_at') DESC NULLS LAST
         LIMIT $9 OFFSET $10`,
        tenantId,
        search.trim(),
        `%${search.trim()}%`,
        state,
        actor.membershipId,
        actor.userId,
        `${definition.capability}.read`,
        resource,
        pageSize,
        (page - 1) * pageSize,
      );
      return {
        items: await Promise.all(
          rows.map((row) =>
            this.project(
              tx,
              actor,
              resource as CanonicalResource,
              row.record as Row,
              String(grants[0]?.audience ?? "INTERNAL"),
            ),
          ),
        ),
        total: Number(rows[0]?.total ?? 0),
        page,
        pageSize,
      };
    });
  }

  async detail(actor: SessionActor, resource: string, id: string) {
    const definition = this.definition(resource);
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT to_jsonb(r) AS record FROM app.${definition.table} r WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
           AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,$5,'READ',$6,r.id)`,
          this.tenant(actor),
          id,
          actor.membershipId,
          actor.userId,
          `${definition.capability}.read`,
          resource,
        )
      )[0]?.record as Row | undefined;
      if (!row)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const grants = await this.access(
        tx,
        actor,
        `${definition.capability}.read`,
        "READ",
      );
      return this.project(
        tx,
        actor,
        resource as CanonicalResource,
        row,
        String(grants[0]?.audience ?? "INTERNAL"),
      );
    });
  }

  async create(
    actor: SessionActor,
    resource: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const definition = this.definition(resource);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(
        tx,
        actor,
        `${definition.capability}.admin`,
        "CREATE",
      );
      if (grants.some((grant) => grant.audience !== "INTERNAL"))
        throw new AppError(
          403,
          "FORBIDDEN",
          "Portal users cannot create this resource",
        );
      return this.idempotent(
        tx,
        actor,
        `canonical.${resource}.create`,
        key,
        raw,
        async () => {
          const row = await this.createRow(
            tx,
            actor,
            resource as CanonicalResource,
            raw,
          );
          await this.audit(
            tx,
            actor,
            `${resource}.created`,
            resource,
            String(row.id),
            correlationId,
            undefined,
            row,
          );
          await this.event(
            tx,
            tenantId,
            resource,
            String(row.id),
            `${resource}.created.v1`,
            row,
            Number(row.version ?? 1),
          );
          return this.project(
            tx,
            actor,
            resource as CanonicalResource,
            row,
            String(grants[0]?.audience ?? "INTERNAL"),
          );
        },
      );
    });
  }

  private async createRow(
    tx: Tx,
    actor: SessionActor,
    resource: CanonicalResource,
    raw: unknown,
  ): Promise<Row> {
    const tenantId = this.tenant(actor);
    const capability = `${resources[resource].capability}.admin`;
    if (resource === "organization-nodes") {
      const v = organizationNodeCommandSchema.parse(raw);
      let inheritedScope: string | null = null;
      if (v.parentId) {
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "organization-nodes",
          v.parentId,
        );
        const parent = await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,authorization_scope_node_id AS "scopeNodeId" FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
          tenantId,
          v.parentId,
        );
        if (!parent[0])
          throw new AppError(
            400,
            "PARENT_INVALID",
            "Parent node is not active",
          );
        inheritedScope = String(parent[0].scopeNodeId ?? "") || null;
      }
      const scopeNodeId = await this.createScopeNode(
        tx,
        actor,
        capability,
        v.authorizationScopeNodeId ?? inheritedScope,
      );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.organization_nodes(tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,address,latitude,longitude,postal_codes,geofence,active_from,active_to,created_by)
         VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::text[],$12::jsonb,$13::date,$14::date,$15::uuid) RETURNING *`,
          tenantId,
          v.code,
          v.name,
          v.nodeType,
          v.parentId ?? null,
          scopeNodeId,
          v.timezone,
          v.address ?? null,
          v.latitude ?? null,
          v.longitude ?? null,
          v.postalCodes,
          JSON.stringify(v.geofence),
          v.activeFrom,
          v.activeTo ?? null,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
         SELECT $1::uuid,ancestor_id,$2::uuid,depth+1 FROM app.organization_closure WHERE tenant_id=$1::uuid AND descendant_id=$3::uuid
         UNION ALL SELECT $1::uuid,$2::uuid,$2::uuid,0`,
        tenantId,
        row.id,
        v.parentId ?? null,
      );
      return row;
    }
    if (resource === "employees") {
      const v = employeeCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "organization-nodes",
        v.homeNodeId,
      );
      if (v.managerId)
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "employees",
          v.managerId,
        );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.employees(tenant_id,employee_code,display_name,email,mobile,manager_id,home_node_id,linked_membership_id,active_from,active_to,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::date,$10::date,$11::uuid) RETURNING *`,
          tenantId,
          v.employeeCode,
          v.displayName,
          v.email ?? null,
          v.mobile ?? null,
          v.managerId ?? null,
          v.homeNodeId,
          v.linkedMembershipId ?? null,
          v.activeFrom,
          v.activeTo ?? null,
          actor.userId,
        )
      )[0]!;
    }
    if (resource === "clients") {
      const v = clientCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "organization-nodes",
        v.billingEntityId,
      );
      if (v.accountManagerEmployeeId)
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "employees",
          v.accountManagerEmployeeId,
        );
      const billingEntity = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT authorization_scope_node_id AS "scopeNodeId" FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantId,
          v.billingEntityId,
        )
      )[0];
      const scopeNodeId = await this.createScopeNode(
        tx,
        actor,
        capability,
        v.authorizationScopeNodeId ??
          (billingEntity?.scopeNodeId
            ? String(billingEntity.scopeNodeId)
            : undefined),
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.clients(tenant_id,code,legal_name,industry,billing_entity_id,account_manager_employee_id,authorization_scope_node_id,tax_identifier,escalation_email,escalation_mobile,credit_days,pod_mode) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12) RETURNING *`,
          tenantId,
          v.code,
          v.legalName,
          v.industry ?? null,
          v.billingEntityId,
          v.accountManagerEmployeeId ?? null,
          scopeNodeId,
          v.taxIdentifier ?? null,
          v.escalationEmail ?? null,
          v.escalationMobile ?? null,
          v.creditDays,
          v.podMode,
        )
      )[0]!;
    }
    if (resource === "client-locations") {
      const v = clientLocationCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "clients",
        v.clientId,
      );
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "organization-nodes",
        v.organizationNodeId,
      );
      if (v.managerEmployeeId)
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "employees",
          v.managerEmployeeId,
        );
      const parentScopes = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT coalesce(c.authorization_scope_node_id,n.authorization_scope_node_id) AS "scopeNodeId" FROM app.clients c JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=$3::uuid WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid`,
          tenantId,
          v.clientId,
          v.organizationNodeId,
        )
      )[0];
      const scopeNodeId = await this.createScopeNode(
        tx,
        actor,
        capability,
        v.authorizationScopeNodeId ??
          (parentScopes?.scopeNodeId
            ? String(parentScopes.scopeNodeId)
            : undefined),
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.client_locations(tenant_id,client_id,code,name,location_type,organization_node_id,manager_employee_id,authorization_scope_node_id,mobile,geofence) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10::jsonb) RETURNING *`,
          tenantId,
          v.clientId,
          v.code,
          v.name,
          v.locationType,
          v.organizationNodeId,
          v.managerEmployeeId ?? null,
          scopeNodeId,
          v.mobile ?? null,
          JSON.stringify(v.geofence),
        )
      )[0]!;
    }
    if (resource === "contracts") {
      const v = contractCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "clients",
        v.clientId,
      );
      const contract = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.contracts(tenant_id,client_id,code,name,effective_from,effective_to,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6::date,$7::uuid) RETURNING *`,
          tenantId,
          v.clientId,
          v.code,
          v.name,
          v.effectiveFrom,
          v.effectiveTo ?? null,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.contract_versions(tenant_id,contract_id,version,credit_days,pod_mode,document_requirements,terms,snapshot_hash,created_by) VALUES($1::uuid,$2::uuid,1,$3,$4,$5::jsonb,$6::jsonb,$7,$8::uuid)`,
        tenantId,
        contract.id,
        v.creditDays,
        v.podMode,
        JSON.stringify(v.documentRequirements),
        JSON.stringify(v.terms),
        hash(v),
        actor.userId,
      );
      return contract;
    }
    if (resource === "lanes") {
      const v = laneCommandSchema.parse(raw);
      const truckType = await this.referenceCode(
        tx,
        tenantId,
        v.truckTypeId,
        "TRUCK_TYPE",
        v.truckType,
      );
      const cargoType = await this.referenceCode(
        tx,
        tenantId,
        v.cargoTypeId,
        "CARGO_TYPE",
        v.cargoType,
      );
      const contract = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT contract_id AS "contractId" FROM app.contract_versions WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenantId,
          v.contractVersionId,
        )
      )[0];
      if (!contract)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "contracts",
        String(contract.contractId),
      );
      for (const locationId of [v.originLocationId, v.destinationLocationId])
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "client-locations",
          locationId,
        );
      const overlap = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT EXISTS(SELECT 1 FROM app.client_rate_lines r JOIN app.contract_lanes l ON l.tenant_id=r.tenant_id AND l.id=r.lane_id WHERE r.tenant_id=$1::uuid AND l.contract_version_id=$2::uuid AND l.origin_location_id=$3::uuid AND l.destination_location_id=$4::uuid AND l.truck_type=$5 AND r.charge_code='BASE' AND tstzrange(r.effective_from,r.effective_to,'[)') && tstzrange($6::timestamptz,$7::timestamptz,'[)') AND r.priority=$8) overlap`,
          tenantId,
          v.contractVersionId,
          v.originLocationId,
          v.destinationLocationId,
          truckType,
          v.effectiveFrom,
          v.effectiveTo ?? null,
          v.priority,
        )
      )[0];
      if (rowsBoolean(overlap?.overlap))
        throw new AppError(
          409,
          "EFFECTIVE_OVERLAP",
          "An equally-prioritized rate overlaps this period",
        );
      const lane = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.contract_lanes(tenant_id,contract_version_id,code,origin_location_id,destination_location_id,truck_type,cargo_type,truck_type_id,cargo_type_id,quantity_min_milli,quantity_max_milli,priority) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10::bigint,$11::bigint,$12) RETURNING *`,
          tenantId,
          v.contractVersionId,
          v.code,
          v.originLocationId,
          v.destinationLocationId,
          truckType,
          cargoType,
          v.truckTypeId ?? null,
          v.cargoTypeId ?? null,
          v.quantityMinMilli,
          v.quantityMaxMilli ?? null,
          v.priority,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.sla_rules(tenant_id,lane_id,placement_minutes,transit_minutes,pod_minutes,effective_from,effective_to,priority) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8)`,
        tenantId,
        lane.id,
        v.placementMinutes,
        v.transitMinutes,
        v.podMinutes,
        v.effectiveFrom,
        v.effectiveTo ?? null,
        v.priority,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.client_rate_lines(tenant_id,lane_id,charge_code,basis,amount_minor,tax_basis_points,effective_from,effective_to,priority) VALUES($1::uuid,$2::uuid,'BASE','PER_VEHICLE',$3::bigint,$4,$5::timestamptz,$6::timestamptz,$7)`,
        tenantId,
        lane.id,
        v.rateMinor,
        v.taxBasisPoints,
        v.effectiveFrom,
        v.effectiveTo ?? null,
        v.priority,
      );
      return lane;
    }
    if (resource === "vendors") {
      const v = vendorCommandSchema.parse(raw);
      if (v.onboardingEmployeeId)
        await this.assertResourceScope(
          tx,
          actor,
          capability,
          "CREATE",
          "employees",
          v.onboardingEmployeeId,
        );
      const scopeNodeId = await this.createScopeNode(
        tx,
        actor,
        capability,
        v.authorizationScopeNodeId,
      );
      const vendor = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.vendors(tenant_id,code,legal_name,pan,gstin,tds_basis_points,msme_number,payment_terms_days,onboarding_employee_id,authorization_scope_node_id) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::uuid) RETURNING *`,
          tenantId,
          v.code,
          v.legalName,
          v.pan ?? null,
          v.gstin ?? null,
          v.tdsBasisPoints,
          v.msmeNumber ?? null,
          v.paymentTermsDays,
          v.onboardingEmployeeId ?? null,
          scopeNodeId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.vendor_service_scopes(tenant_id,vendor_id,effective_from)
         VALUES($1::uuid,$2::uuid,now())`,
        tenantId,
        vendor.id,
      );
      return vendor;
    }
    if (resource === "vehicles") {
      const v = vehicleCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "vendors",
        v.vendorId,
      );
      const truckType = await this.referenceCode(
        tx,
        tenantId,
        v.truckTypeId,
        "TRUCK_TYPE",
        v.vehicleType,
      );
      await this.referenceCode(tx, tenantId, v.bodyTypeId, "BODY_TYPE");
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.vehicles(tenant_id,vendor_id,registration_number,vehicle_type,truck_type_id,body_type_id,make,model,model_year,capacity_milli,gps_device_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10::bigint,$11) RETURNING *`,
          tenantId,
          v.vendorId,
          v.registrationNumber,
          truckType,
          v.truckTypeId ?? null,
          v.bodyTypeId ?? null,
          v.make ?? null,
          v.model ?? null,
          v.modelYear ?? null,
          v.capacityMilli,
          v.gpsDeviceId ?? null,
        )
      )[0]!;
    }
    if (resource === "drivers") {
      const v = driverCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "vendors",
        v.vendorId,
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.drivers(tenant_id,vendor_id,code,display_name,mobile,licence_number,licence_class,licence_valid_to,emergency_contact,portal_membership_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::date,$9,$10::uuid) RETURNING *`,
          tenantId,
          v.vendorId,
          v.code,
          v.displayName,
          v.mobile,
          v.licenceNumber,
          v.licenceClass,
          v.licenceValidTo,
          v.emergencyContact ?? null,
          v.portalMembershipId ?? null,
        )
      )[0]!;
    }
    if (resource === "indents") return this.createIndent(tx, actor, raw);
    if (resource === "allocations")
      return this.createAllocation(tx, actor, raw);
    if (resource === "invoices") return this.createInvoice(tx, actor, raw);
    if (resource === "receipts") {
      const v = receiptCommandSchema.parse(raw);
      await this.assertResourceScope(
        tx,
        actor,
        capability,
        "CREATE",
        "clients",
        v.clientId,
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.receipts(tenant_id,receipt_ref,client_id,payment_date,amount_minor,mode,instrument_no,bank_reference,created_by) VALUES($1::uuid,$2,$3::uuid,$4::date,$5::bigint,$6,$7,$8,$9::uuid) RETURNING *`,
          tenantId,
          v.receiptRef,
          v.clientId,
          v.paymentDate,
          v.amountMinor,
          v.mode,
          v.instrumentNo,
          v.bankReference ?? null,
          actor.userId,
        )
      )[0]!;
    }
    if (resource === "configurations") {
      const v = configurationCommandSchema.parse(raw);
      const version = Number(
        (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT coalesce(max(version),0)+1 next FROM app.configuration_versions WHERE tenant_id=$1::uuid AND namespace=$2`,
            tenantId,
            v.namespace,
          )
        )[0]?.next ?? 1,
      );
      return (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.configuration_versions(tenant_id,namespace,version,state,value,value_hash,effective_from,effective_to,created_by) VALUES($1::uuid,$2,$3,'DRAFT',$4::jsonb,$5,$6::timestamptz,$7::timestamptz,$8::uuid) RETURNING *`,
          tenantId,
          v.namespace,
          version,
          JSON.stringify(v.value),
          hash(v.value),
          v.effectiveFrom,
          v.effectiveTo ?? null,
          actor.userId,
        )
      )[0]!;
    }
    throw new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Use the specialized command for this resource",
    );
  }

  private async createIndent(tx: Tx, actor: SessionActor, raw: unknown) {
    const v = indentCommandSchema.parse(raw);
    const tenantId = this.tenant(actor);
    const cargoType = await this.referenceCode(
      tx,
      tenantId,
      v.cargoTypeId,
      "CARGO_TYPE",
      v.cargoType,
    );
    const bodyType = await this.referenceCode(
      tx,
      tenantId,
      v.bodyTypeId,
      "BODY_TYPE",
      v.bodyType,
    );
    const resolved = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT cv.id AS "contractVersionId",cv.credit_days AS "creditDays",cv.pod_mode AS "podMode",cv.document_requirements AS "documentRequirements",s.placement_minutes AS "placementMinutes",r.amount_minor AS "rateMinor",r.tax_basis_points AS "taxBasisPoints",c.authorization_scope_node_id AS "scopeNodeId"
      FROM app.contract_lanes l JOIN app.contract_versions cv ON cv.tenant_id=l.tenant_id AND cv.id=l.contract_version_id JOIN app.contracts ct ON ct.tenant_id=cv.tenant_id AND ct.id=cv.contract_id AND ct.client_id=$2::uuid AND ct.state='PUBLISHED'
      JOIN app.clients c ON c.tenant_id=ct.tenant_id AND c.id=ct.client_id JOIN app.client_locations cl ON cl.tenant_id=c.tenant_id AND cl.id=$3::uuid AND cl.client_id=c.id
      JOIN app.sla_rules s ON s.tenant_id=l.tenant_id AND s.lane_id=l.id AND s.effective_from<=$4::timestamptz AND (s.effective_to IS NULL OR s.effective_to>$4::timestamptz)
      JOIN app.client_rate_lines r ON r.tenant_id=l.tenant_id AND r.lane_id=l.id AND r.state='PUBLISHED' AND r.effective_from<=$4::timestamptz AND (r.effective_to IS NULL OR r.effective_to>$4::timestamptz)
      WHERE l.tenant_id=$1::uuid AND l.id=$5::uuid ORDER BY s.priority DESC,r.priority DESC LIMIT 1`,
        tenantId,
        v.clientId,
        v.clientLocationId,
        v.pickupWindowStart,
        v.laneId,
      )
    )[0];
    if (!resolved)
      throw new AppError(
        409,
        "COMMERCIAL_NOT_EFFECTIVE",
        "No published contract, SLA and rate apply",
      );
    for (const [resource, id] of [
      ["clients", v.clientId],
      ["client-locations", v.clientLocationId],
      ["lanes", v.laneId],
    ] as const)
      await this.assertResourceScope(
        tx,
        actor,
        "operations.admin",
        "CREATE",
        resource,
        id,
      );
    await this.assertScope(
      tx,
      actor,
      "operations.admin",
      "CREATE",
      String(resolved.scopeNodeId),
    );
    const calculated = new Date(
      new Date(v.pickupWindowStart).getTime() +
        Number(resolved.placementMinutes) * 60_000,
    ).toISOString();
    const committed = v.committedPlacementAt ?? calculated;
    return (
      await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.indents(tenant_id,indent_no,client_id,client_location_id,contract_version_id,lane_id,requested_vehicles,quantity_milli,pickup_window_start,pickup_window_end,committed_placement_at,commitment_override_reason,owner_membership_id,source,source_reference,cargo_type,body_type,cargo_type_id,body_type_id,commercial_snapshot,created_by)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint,$9::timestamptz,$10::timestamptz,$11::timestamptz,$12,$13::uuid,$14,$15,$16,$17,$18::uuid,$19::uuid,$20::jsonb,$21::uuid) RETURNING *`,
        tenantId,
        v.indentNo,
        v.clientId,
        v.clientLocationId,
        resolved.contractVersionId,
        v.laneId,
        v.requestedVehicles,
        v.quantityMilli,
        v.pickupWindowStart,
        v.pickupWindowEnd,
        committed,
        v.commitmentOverrideReason ?? null,
        v.ownerMembershipId ?? null,
        v.source,
        v.sourceReference ?? null,
        cargoType,
        bodyType,
        v.cargoTypeId ?? null,
        v.bodyTypeId ?? null,
        JSON.stringify(toJsonSafe(resolved)),
        actor.userId,
      )
    )[0]!;
  }

  private async createAllocation(tx: Tx, actor: SessionActor, raw: unknown) {
    const v = allocationCommandSchema.parse(raw);
    const tenantId = this.tenant(actor);
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      `${tenantId}:indent:${v.indentId}`,
    );
    await this.assertResourceScope(
      tx,
      actor,
      "operations.admin",
      "CREATE",
      "indents",
      v.indentId,
    );
    await this.assertResourceScope(
      tx,
      actor,
      "operations.admin",
      "CREATE",
      "vendors",
      v.vendorId,
    );
    const eligibility = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.requested_vehicles-coalesce((SELECT sum(a.allotted_vehicles) FROM app.allocations a WHERE a.tenant_id=i.tenant_id AND a.indent_id=i.id AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0) remaining,
      v.state='ACTIVE' AND EXISTS(SELECT 1 FROM app.vendor_service_scopes s WHERE s.tenant_id=v.tenant_id AND s.vendor_id=v.id AND s.effective_from<=now() AND (s.effective_to IS NULL OR s.effective_to>now())) eligible
      FROM app.indents i JOIN app.vendors v ON v.tenant_id=i.tenant_id AND v.id=$3::uuid WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid AND i.state IN ('OPEN','PARTIALLY_ALLOCATED') FOR UPDATE OF i`,
        tenantId,
        v.indentId,
        v.vendorId,
      )
    )[0];
    if (!eligibility)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    if (!rowsBoolean(eligibility.eligible))
      throw new AppError(
        409,
        "VENDOR_INELIGIBLE",
        "Vendor is inactive, unscoped, or non-compliant",
      );
    if (Number(eligibility.remaining) < v.allottedVehicles)
      throw new AppError(
        409,
        "ALLOCATION_EXCEEDS_DEMAND",
        "Allocation exceeds remaining demand",
      );
    return (
      await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.allocations(tenant_id,indent_id,vendor_id,allotted_vehicles,offered_rate_minor,offer_channel,offered_at,expires_at,owner_membership_id,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::bigint,$6,$7::timestamptz,$8::timestamptz,$9::uuid,$10::uuid) RETURNING *`,
        tenantId,
        v.indentId,
        v.vendorId,
        v.allottedVehicles,
        v.offeredRateMinor,
        v.offerChannel,
        v.offeredAt,
        v.expiresAt,
        v.ownerMembershipId ?? null,
        actor.userId,
      )
    )[0]!;
  }

  private async createInvoice(tx: Tx, actor: SessionActor, raw: unknown) {
    const v = invoiceCommandSchema.parse(raw);
    const tenantId = this.tenant(actor);
    await this.assertResourceScope(
      tx,
      actor,
      "finance.admin",
      "CREATE",
      "clients",
      v.clientId,
    );
    await this.assertResourceScope(
      tx,
      actor,
      "finance.admin",
      "CREATE",
      "client-locations",
      v.clientLocationId,
    );
    for (const line of v.lines) {
      await this.assertResourceScope(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "trips",
        line.tripId,
      );
      if (line.podTaskId)
        await this.assertResourceScope(
          tx,
          actor,
          "finance.admin",
          "CREATE",
          "pod-tasks",
          line.podTaskId,
        );
    }
    const calculated = v.lines.map((line) => ({
      ...line,
      ...calculateMoneyLine(
        line.quantityMilli,
        line.rateMinor,
        line.taxBasisPoints,
      ),
    }));
    const taxable = calculated.reduce(
      (sum, line) => sum + BigInt(line.taxableMinor),
      0n,
    );
    const tax = calculated.reduce(
      (sum, line) => sum + BigInt(line.taxMinor),
      0n,
    );
    const invoice = (
      await tx.$queryRawUnsafe<Array<Row>>(
        `INSERT INTO app.client_invoices(tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,created_by) VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::date,$6,$7,$8::bigint,$9::bigint,$10::bigint,$11::uuid) RETURNING *`,
        tenantId,
        v.invoiceNo,
        v.clientId,
        v.clientLocationId,
        v.invoiceDate,
        v.currency,
        v.creditDays,
        taxable.toString(),
        tax.toString(),
        (taxable + tax).toString(),
        actor.userId,
      )
    )[0]!;
    for (const [index, line] of calculated.entries()) {
      const inserted = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.client_invoice_lines(tenant_id,invoice_id,line_no,charge_code,quantity_milli,rate_minor,taxable_minor,tax_basis_points,tax_minor,total_minor,rate_snapshot) VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::bigint,$7::bigint,$8,$9::bigint,$10::bigint,$11::jsonb) RETURNING id`,
          tenantId,
          invoice.id,
          index + 1,
          line.chargeCode,
          line.quantityMilli,
          line.rateMinor,
          line.taxableMinor,
          line.taxBasisPoints,
          line.taxMinor,
          line.totalMinor,
          JSON.stringify({
            rateMinor: line.rateMinor,
            taxBasisPoints: line.taxBasisPoints,
          }),
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.invoice_service_links(tenant_id,invoice_line_id,trip_id,pod_task_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        tenantId,
        inserted.id,
        line.tripId,
        line.podTaskId ?? null,
      );
    }
    return invoice;
  }

  async transition(
    actor: SessionActor,
    resource: string,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const definition = this.definition(resource);
    const input = transitionCommandSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(
        tx,
        actor,
        `${definition.capability}.admin`,
        input.toState.includes("APPROV") || input.toState === "POSTED"
          ? "APPROVE"
          : "UPDATE",
      );
      return this.idempotent(
        tx,
        actor,
        `canonical.${resource}.transition:${id}`,
        key,
        input,
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT to_jsonb(r) record FROM app.${definition.table} r WHERE tenant_id=$1::uuid AND id=$2::uuid
             AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,$5,$6,$7,r.id) FOR UPDATE`,
              tenantId,
              id,
              actor.membershipId,
              actor.userId,
              `${definition.capability}.admin`,
              input.toState.includes("APPROV") || input.toState === "POSTED"
                ? "APPROVE"
                : "UPDATE",
              resource,
            )
          )[0]?.record as Row | undefined;
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (resource === "vendor-bills")
            throw new AppError(
              405,
              "SPECIALIZED_COMMAND_REQUIRED",
              "Use the maker-checker vendor bill decision command",
            );
          if (
            ["invoices", "receipts"].includes(resource) &&
            input.toState.includes("APPROV") &&
            before.created_by === actor.userId
          )
            throw new AppError(
              409,
              "SEGREGATION_REQUIRED",
              "Maker cannot approve their own financial record",
            );
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Record changed; reload and retry",
            );
          const state = String(before.state);
          if (
            !transitions[resource as CanonicalResource]?.[state]?.includes(
              input.toState,
            )
          )
            throw new AppError(
              409,
              "TRANSITION_INVALID",
              "Transition is not allowed",
            );
          if (
            [
              "INACTIVE",
              "REJECTED",
              "REVERSED",
              "CANCELLED",
              "BLOCKED",
            ].includes(input.toState) &&
            (input.reason?.length ?? 0) < 5
          )
            throw new AppError(400, "REASON_REQUIRED", "A reason is required");
          if (resource === "employees" && input.toState === "INACTIVE") {
            const dependent = (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT EXISTS(SELECT 1 FROM app.employees WHERE tenant_id=$1::uuid AND manager_id=$2::uuid AND state='ACTIVE' UNION ALL SELECT 1 FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND (effective_to IS NULL OR effective_to>now())) found`,
                tenantId,
                id,
              )
            )[0];
            if (rowsBoolean(dependent?.found))
              throw new AppError(
                409,
                "REASSIGNMENT_REQUIRED",
                "Active responsibilities must be reassigned first",
              );
          }
          if (
            resource === "organization-nodes" &&
            input.toState === "INACTIVE"
          ) {
            const dependent = (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT EXISTS(SELECT 1 FROM app.organization_closure c JOIN app.employees e ON e.tenant_id=c.tenant_id AND e.home_node_id=c.descendant_id WHERE c.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND e.state='ACTIVE' UNION ALL SELECT 1 FROM app.organization_closure c JOIN app.client_locations l ON l.tenant_id=c.tenant_id AND l.organization_node_id=c.descendant_id WHERE c.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND l.state='ACTIVE') found`,
                tenantId,
                id,
              )
            )[0];
            if (rowsBoolean(dependent?.found))
              throw new AppError(
                409,
                "REASSIGNMENT_REQUIRED",
                "Active employees and locations must be reassigned first",
              );
          }
          if (
            resource === "invoices" &&
            ["POSTED", "SUBMITTED"].includes(state) &&
            input.toState !== "REVERSED"
          )
            throw new AppError(
              409,
              "POSTED_IMMUTABLE",
              "Posted invoices require a compensating entry",
            );
          const updated = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.${definition.table} SET state=$1,updated_at=now(),version=version+1${resource === "invoices" && input.toState === "POSTED" ? ",posted_at=now()" : ""} WHERE tenant_id=$2::uuid AND id=$3::uuid AND version=$4 RETURNING *`,
              input.toState,
              tenantId,
              id,
              input.expectedVersion,
            )
          )[0]!;
          if (resource === "contracts" && input.toState === "PUBLISHED") {
            await tx.$executeRawUnsafe(
              `UPDATE app.contract_versions SET published_at=now() WHERE tenant_id=$1::uuid AND contract_id=$2::uuid AND version=$3`,
              tenantId,
              id,
              updated.current_version,
            );
            await tx.$executeRawUnsafe(
              `UPDATE app.client_rate_lines r SET state=CASE WHEN v.version=$3 THEN 'PUBLISHED' ELSE 'SUPERSEDED' END,version=r.version+1 FROM app.contract_lanes l JOIN app.contract_versions v ON v.tenant_id=l.tenant_id AND v.id=l.contract_version_id WHERE r.tenant_id=$1::uuid AND l.tenant_id=r.tenant_id AND r.lane_id=l.id AND v.contract_id=$2::uuid AND r.state IN ('DRAFT','APPROVED','PUBLISHED')`,
              tenantId,
              id,
              updated.current_version,
            );
          }
          await this.audit(
            tx,
            actor,
            `${resource}.transitioned`,
            resource,
            id,
            correlationId,
            before,
            updated,
            input.reason,
          );
          await this.event(
            tx,
            tenantId,
            resource,
            id,
            `${resource}.${input.toState.toLowerCase()}.v1`,
            updated,
            Number(updated.version),
          );
          return this.project(
            tx,
            actor,
            resource as CanonicalResource,
            updated,
            String(grants[0]?.audience ?? "INTERNAL"),
          );
        },
      );
    });
  }

  async appendTripEvent(
    actor: SessionActor,
    tripId: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = tripEventCommandSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(tx, actor, "operations.admin", "UPDATE");
      return this.idempotent(
        tx,
        actor,
        `trip.event:${tripId}`,
        key,
        input,
        async () => {
          const trip = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT t.*,d.portal_membership_id AS "driverMembershipId" FROM app.trips t JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.admin','UPDATE','trips',t.id) FOR UPDATE`,
              tenantId,
              tripId,
              actor.membershipId,
              actor.userId,
            )
          )[0];
          if (!trip)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (
            grants[0]?.audience === "DRIVER" &&
            trip.driverMembershipId !== actor.membershipId
          )
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (
            input.eventType === "GPS" &&
            (!trip.tracking_consent_from ||
              !trip.tracking_consent_to ||
              new Date(input.deviceAt) <
                new Date(String(trip.tracking_consent_from)) ||
              new Date(input.deviceAt) >=
                new Date(String(trip.tracking_consent_to)))
          )
            throw new AppError(
              403,
              "TRACKING_NOT_CONSENTED",
              "Location is permitted only during the active assignment window",
            );
          const latest = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT max(device_at) latest FROM app.trip_events WHERE tenant_id=$1::uuid AND trip_id=$2::uuid`,
              tenantId,
              tripId,
            )
          )[0]?.latest;
          const event = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.trip_events(tenant_id,trip_id,event_key,event_type,source,device_at,actor_id,latitude,longitude,speed_kph,odometer_km,evidence,ordering_conflict) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7::uuid,$8,$9,$10,$11,$12::jsonb,$13) ON CONFLICT(tenant_id,trip_id,event_key) DO UPDATE SET event_key=EXCLUDED.event_key RETURNING *`,
              tenantId,
              tripId,
              input.eventKey,
              input.eventType,
              input.source,
              input.deviceAt,
              actor.userId,
              input.latitude ?? null,
              input.longitude ?? null,
              input.speedKph ?? null,
              input.odometerKm ?? null,
              JSON.stringify(input.evidence),
              latest
                ? new Date(input.deviceAt) < new Date(String(latest))
                : false,
            )
          )[0]!;
          const stateMap: Record<string, string> = {
            AT_ORIGIN: "AT_ORIGIN",
            LOADED: "LOADED",
            DEPARTED: "IN_TRANSIT",
            AT_DESTINATION: "AT_DESTINATION",
            DELIVERED: "DELIVERED",
          };
          if (stateMap[input.eventType])
            await tx.$executeRawUnsafe(
              `UPDATE app.trips SET state=$1,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid`,
              stateMap[input.eventType],
              tenantId,
              tripId,
            );
          if (input.eventType === "DELIVERED") {
            const pod = (
              await tx.$queryRawUnsafe<Array<Row>>(
                `INSERT INTO app.pod_tasks(tenant_id,trip_id,delivered_at,receiver_name,receiver_evidence,contract_snapshot) SELECT t.tenant_id,t.id,$1::timestamptz,$2,$3::jsonb,i.commercial_snapshot FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE t.tenant_id=$4::uuid AND t.id=$5::uuid ON CONFLICT(tenant_id,trip_id) DO UPDATE SET trip_id=EXCLUDED.trip_id RETURNING id`,
                input.deviceAt,
                String(input.evidence.receiverName ?? "Receiver"),
                JSON.stringify(input.evidence),
                tenantId,
                tripId,
              )
            )[0]!;
            await this.event(
              tx,
              tenantId,
              "trip",
              tripId,
              "trip.delivered.v1",
              { tripId, podTaskId: pod.id, deliveredAt: input.deviceAt },
              Number(trip.version) + 1,
            );
          }
          await this.audit(
            tx,
            actor,
            "trip.event.appended",
            "trip",
            tripId,
            correlationId,
            undefined,
            event,
          );
          return event;
        },
      );
    });
  }

  async allocateReceipt(
    actor: SessionActor,
    receiptId: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = receiptAllocationSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "finance.admin", "APPROVE");
      await this.assertResourceScope(
        tx,
        actor,
        "finance.admin",
        "APPROVE",
        "receipts",
        receiptId,
      );
      if (input.invoiceId)
        await this.assertResourceScope(
          tx,
          actor,
          "finance.admin",
          "APPROVE",
          "invoices",
          input.invoiceId,
        );
      return this.idempotent(
        tx,
        actor,
        `receipt.allocate:${receiptId}`,
        key,
        input,
        async () => {
          const receipt = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT * FROM app.receipts WHERE tenant_id=$1::uuid AND id=$2::uuid AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'finance.admin','APPROVE','receipts',id) FOR UPDATE`,
              tenantId,
              receiptId,
              actor.membershipId,
              actor.userId,
            )
          )[0];
          if (!receipt)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          let invoiceBalance: bigint | null = null;
          if (input.invoiceId) {
            await this.assertResourceScope(
              tx,
              actor,
              "finance.admin",
              "APPROVE",
              "invoices",
              input.invoiceId,
            );
            const invoice = (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT i.client_id,i.state,
                    i.total_minor-coalesce((SELECT sum(e.amount_minor) FROM app.receipt_ledger_entries e WHERE e.tenant_id=i.tenant_id AND e.invoice_id=i.id),0) balance
                 FROM app.client_invoices i
                 WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid
                   AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'finance.admin','APPROVE','invoices',i.id)
                 FOR UPDATE`,
                tenantId,
                input.invoiceId,
                actor.membershipId,
                actor.userId,
              )
            )[0];
            if (!invoice)
              throw new AppError(
                404,
                "RESOURCE_NOT_FOUND",
                "Resource not found",
              );
            if (String(invoice.client_id) !== String(receipt.client_id))
              throw new AppError(
                409,
                "RECEIPT_CLIENT_MISMATCH",
                "Receipt and invoice must belong to the same client",
              );
            if (!["POSTED", "SUBMITTED"].includes(String(invoice.state)))
              throw new AppError(
                409,
                "INVOICE_NOT_ALLOCATABLE",
                "Only posted client invoices can receive allocations",
              );
            invoiceBalance = BigInt(String(invoice.balance));
            if (invoiceBalance <= 0n)
              throw new AppError(
                409,
                "INVOICE_NOT_ALLOCATABLE",
                "Invoice has no open balance",
              );
          }
          const used = BigInt(
            String(
              (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `SELECT coalesce(sum(amount_minor),0) total FROM app.receipt_ledger_entries WHERE tenant_id=$1::uuid AND receipt_id=$2::uuid`,
                  tenantId,
                  receiptId,
                )
              )[0]?.total ?? 0,
            ),
          );
          const allocationAmount = BigInt(input.amountMinor);
          if (used + allocationAmount > BigInt(String(receipt.amountMinor)))
            throw new AppError(
              409,
              "OVER_ALLOCATION",
              "Allocation exceeds unallocated receipt balance",
            );
          if (invoiceBalance !== null) {
            if (allocationAmount > invoiceBalance)
              throw new AppError(
                409,
                "OVER_ALLOCATION",
                "Allocation exceeds invoice balance",
              );
          }
          const entry = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.receipt_ledger_entries(tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reason,actor_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::bigint,$6,$7::uuid) RETURNING *`,
              tenantId,
              receiptId,
              input.invoiceId ?? null,
              input.entryType,
              input.amountMinor,
              input.reason ?? null,
              actor.userId,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "receipt.allocated",
            "receipt",
            receiptId,
            correlationId,
            undefined,
            entry,
          );
          return entry;
        },
      );
    });
  }

  async assignAllocation(
    actor: SessionActor,
    allocationId: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        vehicleId: z.string().uuid(),
        driverId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(5).max(500).optional(),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "operations.admin", "UPDATE");
      await this.assertResourceScope(
        tx,
        actor,
        "operations.admin",
        "UPDATE",
        "allocations",
        allocationId,
      );
      await this.assertResourceScope(
        tx,
        actor,
        "operations.admin",
        "UPDATE",
        "vehicles",
        input.vehicleId,
      );
      await this.assertResourceScope(
        tx,
        actor,
        "operations.admin",
        "UPDATE",
        "drivers",
        input.driverId,
      );
      return this.idempotent(
        tx,
        actor,
        `allocation.assign:${allocationId}`,
        key,
        input,
        async () => {
          const allocation = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT a.*,i.pickup_window_start AS "pickupAt" FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE a.tenant_id=$1::uuid AND a.id=$2::uuid AND a.state IN ('ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED') AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.admin','UPDATE','allocations',a.id) FOR UPDATE`,
              tenantId,
              allocationId,
              actor.membershipId,
              actor.userId,
            )
          )[0];
          if (!allocation)
            throw new AppError(
              409,
              "ALLOCATION_STATE_CONFLICT",
              "Accepted allocation is required",
            );
          if (Number(allocation.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Allocation changed; reload and retry",
            );
          const currentAssignment = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT id FROM app.allocation_assignments
               WHERE tenant_id=$1::uuid AND allocation_id=$2::uuid AND assigned_to IS NULL FOR UPDATE`,
              tenantId,
              allocationId,
            )
          )[0];
          if (currentAssignment && !input.reason)
            throw new AppError(
              400,
              "REPLACEMENT_REASON_REQUIRED",
              "Explain why the current vehicle or driver is being replaced",
            );
          await this.assertResourceScope(
            tx,
            actor,
            "operations.admin",
            "UPDATE",
            "vehicles",
            input.vehicleId,
          );
          await this.assertResourceScope(
            tx,
            actor,
            "operations.admin",
            "UPDATE",
            "drivers",
            input.driverId,
          );
          const eligible = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT v.vendor_id=d.vendor_id AND v.vendor_id=$4::uuid AND v.state='ACTIVE' AND d.state='ACTIVE' AND d.licence_valid_to>=current_date
       AND NOT EXISTS(SELECT 1 FROM app.compliance_records c WHERE c.tenant_id=$1::uuid AND ((c.subject_type='VEHICLE' AND c.subject_id=v.id) OR (c.subject_type='DRIVER' AND c.subject_id=d.id) OR (c.subject_type='VENDOR' AND c.subject_id=v.vendor_id)) AND (c.verification_state<>'VERIFIED' OR (c.valid_to IS NOT NULL AND c.valid_to<current_date)))
       AND NOT EXISTS(SELECT 1 FROM app.allocation_assignments aa JOIN app.allocations a ON a.tenant_id=aa.tenant_id AND a.id=aa.allocation_id WHERE aa.tenant_id=$1::uuid AND aa.assigned_to IS NULL AND aa.allocation_id<>$5::uuid AND (aa.vehicle_id=$2::uuid OR aa.driver_id=$3::uuid) AND a.state NOT IN ('CANCELLED','REJECTED','EXPIRED'))
       AND app.domain_resource_authorized($1::uuid,$6::uuid,$7::uuid,'operations.admin','UPDATE','vehicles',v.id)
       AND app.domain_resource_authorized($1::uuid,$6::uuid,$7::uuid,'operations.admin','UPDATE','drivers',d.id) eligible
       FROM app.vehicles v JOIN app.drivers d ON d.tenant_id=v.tenant_id WHERE v.tenant_id=$1::uuid AND v.id=$2::uuid AND d.id=$3::uuid FOR UPDATE OF v,d`,
              tenantId,
              input.vehicleId,
              input.driverId,
              allocation.vendor_id,
              allocationId,
              actor.membershipId,
              actor.userId,
            )
          )[0];
          if (!rowsBoolean(eligible?.eligible))
            throw new AppError(
              409,
              "ASSIGNMENT_INELIGIBLE",
              "Vehicle or driver is unavailable, non-compliant, or belongs to another vendor",
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.allocation_assignments SET assigned_to=now() WHERE tenant_id=$1::uuid AND allocation_id=$2::uuid AND assigned_to IS NULL`,
            tenantId,
            allocationId,
          );
          const assigned = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.allocation_assignments(tenant_id,allocation_id,vehicle_id,driver_id,replacement_reason,assigned_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid) RETURNING *`,
              tenantId,
              allocationId,
              input.vehicleId,
              input.driverId,
              input.reason ?? null,
              actor.userId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.allocations SET state=CASE WHEN state='ACCEPTED' THEN 'VEHICLE_ASSIGNED' ELSE state END,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenantId,
            allocationId,
          );
          await this.audit(
            tx,
            actor,
            "allocation.assigned",
            "allocation",
            allocationId,
            correlationId,
            undefined,
            assigned,
            input.reason,
          );
          return assigned;
        },
      );
    });
  }

  async createTrip(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        allocationId: z.string().uuid(),
        tripNo: z.string().trim().min(2).max(40),
        lrNo: z.string().trim().min(2).max(40),
        plannedPickupAt: z.string().datetime({ offset: true }),
        plannedDeliveryAt: z.string().datetime({ offset: true }),
        trackingConsentFrom: z.string().datetime({ offset: true }).nullish(),
        trackingConsentTo: z.string().datetime({ offset: true }).nullish(),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "operations.admin", "CREATE");
      return this.idempotent(tx, actor, "trip.create", key, input, async () => {
        await this.assertResourceScope(
          tx,
          actor,
          "operations.admin",
          "CREATE",
          "allocations",
          input.allocationId,
        );
        const assignment = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT aa.vehicle_id AS "vehicleId",aa.driver_id AS "driverId" FROM app.allocation_assignments aa JOIN app.allocations a ON a.tenant_id=aa.tenant_id AND a.id=aa.allocation_id WHERE aa.tenant_id=$1::uuid AND aa.allocation_id=$2::uuid AND aa.assigned_to IS NULL AND a.state IN ('VEHICLE_ASSIGNED','NTP_RELEASED','PLACED')`,
            tenantId,
            input.allocationId,
          )
        )[0];
        if (!assignment)
          throw new AppError(
            409,
            "ASSIGNMENT_REQUIRED",
            "A current eligible assignment is required",
          );
        const trip = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `INSERT INTO app.trips(tenant_id,allocation_id,trip_no,lr_no,assigned_driver_id,assigned_vehicle_id,planned_pickup_at,planned_delivery_at,tracking_consent_from,tracking_consent_to) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz) RETURNING *`,
            tenantId,
            input.allocationId,
            input.tripNo,
            input.lrNo,
            assignment.driverId,
            assignment.vehicleId,
            input.plannedPickupAt,
            input.plannedDeliveryAt,
            input.trackingConsentFrom ?? null,
            input.trackingConsentTo ?? null,
          )
        )[0]!;
        await this.audit(
          tx,
          actor,
          "trip.created",
          "trip",
          String(trip.id),
          correlationId,
          undefined,
          trip,
        );
        await this.event(
          tx,
          tenantId,
          "trip",
          String(trip.id),
          "trip.created.v1",
          trip,
          1,
        );
        return trip;
      });
    });
  }

  async uploadDocument(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = documentUploadSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.admin", "CREATE");
      const target = this.governedTarget(input.targetType);
      await this.assertResourceScope(
        tx,
        actor,
        "governance.admin",
        "CREATE",
        target.resource,
        input.targetId,
      );
      return this.idempotent(
        tx,
        actor,
        `document.upload:${input.targetType}:${input.targetId}`,
        key,
        { ...input, contentBase64: input.checksumSha256 },
        async () => {
          const content = Buffer.from(input.contentBase64, "base64");
          if (content.length < 1 || content.length > 10 * 1024 * 1024)
            throw new AppError(
              400,
              "DOCUMENT_SIZE_INVALID",
              "Document size is invalid",
            );
          if (hashBuffer(content) !== input.checksumSha256)
            throw new AppError(
              400,
              "CHECKSUM_MISMATCH",
              "Document checksum does not match",
            );
          const signatures: Record<string, (b: Buffer) => boolean> = {
            "application/pdf": (b) => b.subarray(0, 5).toString() === "%PDF-",
            "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
            "image/png": (b) => b.subarray(1, 4).toString() === "PNG",
          };
          if (!signatures[input.mediaType]?.(content))
            throw new AppError(
              400,
              "MEDIA_TYPE_MISMATCH",
              "Document bytes do not match the media type",
            );
          const document = input.documentId
            ? (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `SELECT * FROM app.governed_documents WHERE tenant_id=$1::uuid AND id=$2::uuid AND target_type=$3 AND target_id=$4::uuid FOR UPDATE`,
                  tenantId,
                  input.documentId,
                  input.targetType,
                  input.targetId,
                )
              )[0]
            : (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `INSERT INTO app.governed_documents(tenant_id,target_type,target_id,category,confidentiality,issue_date,expiry_date,created_by) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::date,$7::date,$8::uuid) RETURNING *`,
                  tenantId,
                  input.targetType,
                  input.targetId,
                  input.category,
                  input.confidentiality,
                  input.issueDate ?? null,
                  input.expiryDate ?? null,
                  actor.userId,
                )
              )[0];
          if (!document)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const nextVersion = input.documentId
            ? Number(document.current_version ?? 0) + 1
            : 1;
          const version = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.governed_document_versions(tenant_id,document_id,version,file_name,media_type,byte_size,checksum_sha256,content,malware_state,source,uploaded_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,'PENDING','UPLOAD',$9::uuid) RETURNING id,document_id AS "documentId",version,file_name AS "fileName",media_type AS "mediaType",byte_size AS "byteSize",checksum_sha256 AS checksum`,
              tenantId,
              document.id,
              nextVersion,
              input.fileName,
              input.mediaType,
              content.length,
              input.checksumSha256,
              content,
              actor.userId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `UPDATE app.governed_documents SET current_version=$1,verification_state='PENDING',updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid`,
            nextVersion,
            tenantId,
            document.id,
          );
          await this.audit(
            tx,
            actor,
            "document.uploaded",
            "document",
            String(document.id),
            correlationId,
            undefined,
            version,
          );
          return version;
        },
      );
    });
  }

  async documents(actor: SessionActor, search = "") {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.read", "READ");
      const candidates = await tx.$queryRawUnsafe<Row[]>(
        `SELECT d.id,d.category||' · '||v.file_name AS name,d.category,d.target_type AS "targetType",d.target_id AS "targetId",d.verification_state AS state
         FROM app.governed_documents d JOIN app.governed_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.version=d.current_version
         WHERE d.tenant_id=$1::uuid AND ($2='' OR d.category ILIKE '%'||$2||'%' OR v.file_name ILIKE '%'||$2||'%') ORDER BY d.updated_at DESC LIMIT 100`,
        tenantId,
        search,
      );
      const items: Row[] = [];
      for (const row of candidates) {
        const target = this.governedTarget(String(row.targetType));
        try {
          await this.assertResourceScope(
            tx,
            actor,
            "governance.read",
            "READ",
            target.resource,
            String(row.targetId),
          );
          items.push(row);
        } catch (error) {
          if (!(error instanceof AppError && error.status === 404)) throw error;
        }
      }
      return { items: toJsonSafe(items) };
    });
  }

  async issueDocumentAccess(
    actor: SessionActor,
    versionId: string,
    correlationId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(tx, actor, "governance.read", "READ");
      const version = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT v.id,d.id AS "documentId",d.target_type AS "targetType",d.target_id AS "targetId",d.confidentiality FROM app.governed_document_versions v
           JOIN app.governed_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
           JOIN app.document_scan_results s ON s.tenant_id=v.tenant_id AND s.document_version_id=v.id AND s.outcome='CLEAN'
           WHERE v.tenant_id=$1::uuid AND v.id=$2::uuid AND d.verification_state='VERIFIED'`,
          tenantId,
          versionId,
        )
      )[0];
      if (!version)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const target = this.governedTarget(String(version.targetType));
      await this.assertResourceScope(
        tx,
        actor,
        "governance.read",
        "READ",
        target.resource,
        String(version.targetId),
      );
      const audience = String(grants[0]?.audience ?? "INTERNAL");
      if (audience !== "INTERNAL" && version.confidentiality !== audience)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const token = crypto.randomUUID() + crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await tx.$executeRawUnsafe(
        `INSERT INTO app.document_access_tokens(tenant_id,document_version_id,token_hash,audience,expires_at,issued_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid)`,
        tenantId,
        versionId,
        hash(token),
        audience,
        expiresAt,
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "document.access_issued",
        "document",
        String(version.documentId),
        correlationId,
      );
      return { token, expiresAt: expiresAt.toISOString() };
    });
  }

  async downloadDocument(actor: SessionActor, token: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.read", "READ");
      const candidate = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT v.id,d.target_type AS "targetType",d.target_id AS "targetId" FROM app.document_access_tokens t JOIN app.governed_document_versions v ON v.tenant_id=t.tenant_id AND v.id=t.document_version_id JOIN app.governed_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id WHERE t.tenant_id=$1::uuid AND t.token_hash=$2 AND t.used_at IS NULL AND t.expires_at>now()`,
          tenantId,
          hash(token),
        )
      )[0];
      if (!candidate)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const target = this.governedTarget(String(candidate.targetType));
      await this.assertResourceScope(
        tx,
        actor,
        "governance.read",
        "READ",
        target.resource,
        String(candidate.targetId),
      );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.document_access_tokens t SET used_at=now() FROM app.governed_document_versions v,app.governed_documents d WHERE t.tenant_id=$1::uuid AND t.token_hash=$2 AND t.used_at IS NULL AND t.expires_at>now() AND v.tenant_id=t.tenant_id AND v.id=t.document_version_id AND d.tenant_id=v.tenant_id AND d.id=v.document_id RETURNING v.file_name AS "fileName",v.media_type AS "mediaType",v.content`,
          tenantId,
          hash(token),
        )
      )[0];
      if (!row)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      return {
        fileName: row.fileName,
        mediaType: row.mediaType,
        contentBase64: (row.content as Buffer).toString("base64"),
      };
    });
  }

  async addGovernedComment(
    actor: SessionActor,
    raw: unknown,
    correlationId: string,
  ) {
    const input = z
      .object({
        targetType: z.string().trim().min(2).max(80),
        targetId: z.string().uuid(),
        body: z.string().trim().min(1).max(4000),
        visibility: z.enum(["INTERNAL", "CLIENT", "VENDOR", "DRIVER"]),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(tx, actor, "governance.admin", "CREATE");
      const target = this.governedTarget(input.targetType);
      await this.assertResourceScope(
        tx,
        actor,
        "governance.admin",
        "CREATE",
        target.resource,
        input.targetId,
      );
      const audience = String(grants[0]?.audience ?? "INTERNAL");
      if (audience !== "INTERNAL" && input.visibility !== audience)
        throw new AppError(
          403,
          "VISIBILITY_DENIED",
          "External comments may only use their own audience",
        );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.governed_comments(tenant_id,target_type,target_id,body,visibility,author_id) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::uuid) RETURNING *`,
          tenantId,
          input.targetType,
          input.targetId,
          input.body,
          input.visibility,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.governed_comment_history(tenant_id,comment_id,version,body,edited_by) VALUES($1::uuid,$2::uuid,1,$3,$4::uuid)`,
        tenantId,
        row.id,
        input.body,
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "comment.created",
        "comment",
        String(row.id),
        correlationId,
        undefined,
        row,
      );
      return row;
    });
  }

  async updateGovernedComment(
    actor: SessionActor,
    id: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = z
      .object({
        expectedVersion: z.number().int().positive(),
        body: z.string().trim().min(1).max(4000).optional(),
        resolved: z.boolean().optional(),
      })
      .strict()
      .refine((v) => v.body !== undefined || v.resolved !== undefined)
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.admin", "UPDATE");
      const before = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT * FROM app.governed_comments WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenantId,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const target = this.governedTarget(String(before.target_type));
      await this.assertResourceScope(
        tx,
        actor,
        "governance.admin",
        "UPDATE",
        target.resource,
        String(before.target_id),
      );
      if (before.author_id !== actor.userId && input.body !== undefined)
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only the author may edit a comment",
        );
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Comment changed; reload and retry",
        );
      const row = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `UPDATE app.governed_comments SET body=coalesce($1,body),resolved_at=CASE WHEN $2::boolean IS TRUE THEN now() WHEN $2::boolean IS FALSE THEN null ELSE resolved_at END,resolved_by=CASE WHEN $2::boolean IS TRUE THEN $3::uuid WHEN $2::boolean IS FALSE THEN null ELSE resolved_by END,updated_at=now(),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid RETURNING *`,
          input.body ?? null,
          input.resolved ?? null,
          actor.userId,
          tenantId,
          id,
        )
      )[0]!;
      if (input.body)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.governed_comment_history(tenant_id,comment_id,version,body,edited_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
          tenantId,
          id,
          row.version,
          input.body,
          actor.userId,
        );
      await this.audit(
        tx,
        actor,
        "comment.updated",
        "comment",
        id,
        correlationId,
        before,
        row,
      );
      return row;
    });
  }

  async createApprovalDefinition(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{2,40}$/),
        targetType: z.string().trim().min(2).max(80),
        minimumMinor: z.number().int().safe().nullish(),
        maximumMinor: z.number().int().safe().nullish(),
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
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.admin", "ADMIN");
      return this.idempotent(
        tx,
        actor,
        "approval.definition.create",
        key,
        input,
        async () => {
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.approval_definitions(tenant_id,code,target_type,minimum_minor,maximum_minor,steps) VALUES($1::uuid,$2,$3,$4::bigint,$5::bigint,$6::jsonb) RETURNING *`,
              tenantId,
              input.code,
              input.targetType,
              input.minimumMinor ?? null,
              input.maximumMinor ?? null,
              JSON.stringify(input.steps),
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "approval.definition_created",
            "approval_definition",
            String(row.id),
            correlationId,
            undefined,
            row,
          );
          return row;
        },
      );
    });
  }

  async approvalDefinitions(actor: SessionActor) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.read", "READ");
      return toJsonSafe(
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,code,target_type AS "targetType",minimum_minor AS "minimumMinor",maximum_minor AS "maximumMinor",steps,active,version FROM app.approval_definitions WHERE tenant_id=$1::uuid ORDER BY code`,
          tenantId,
        ),
      );
    });
  }

  async listGovernedComments(
    actor: SessionActor,
    targetType: string,
    targetId: string,
  ) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      const grants = await this.access(tx, actor, "governance.read", "READ");
      const target = this.governedTarget(targetType);
      await this.assertResourceScope(
        tx,
        actor,
        "governance.read",
        "READ",
        target.resource,
        targetId,
      );
      const audience = String(grants[0]?.audience ?? "INTERNAL");
      return tx.$queryRawUnsafe<Array<Row>>(
        `SELECT id,body,visibility,author_id AS "authorId",resolved_at AS "resolvedAt",created_at AS "createdAt",version FROM app.governed_comments WHERE tenant_id=$1::uuid AND target_type=$2 AND target_id=$3::uuid AND ($4='INTERNAL' OR visibility=$4) ORDER BY created_at`,
        tenantId,
        targetType,
        targetId,
        audience,
      );
    });
  }

  async requestApproval(
    actor: SessionActor,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        definitionId: z.string().uuid(),
        targetType: z.string().trim().min(2).max(80),
        targetId: z.string().uuid(),
        snapshot: z.record(z.unknown()),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.admin", "CREATE");
      const target = this.governedTarget(input.targetType);
      await this.assertResourceScope(
        tx,
        actor,
        "governance.admin",
        "CREATE",
        target.resource,
        input.targetId,
      );
      return this.idempotent(
        tx,
        actor,
        `approval.request:${input.targetType}:${input.targetId}`,
        key,
        input,
        async () => {
          await tx.$executeRawUnsafe(
            `UPDATE app.approval_instances SET state='INVALIDATED',completed_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND target_type=$2 AND target_id=$3::uuid AND state='PENDING' AND snapshot_hash<>$4`,
            tenantId,
            input.targetType,
            input.targetId,
            hash(input.snapshot),
          );
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.approval_instances(tenant_id,definition_id,target_type,target_id,snapshot,snapshot_hash,requester_id) SELECT $1::uuid,id,$3,$4::uuid,$5::jsonb,$6,$7::uuid FROM app.approval_definitions WHERE tenant_id=$1::uuid AND id=$2::uuid AND active RETURNING *`,
              tenantId,
              input.definitionId,
              input.targetType,
              input.targetId,
              JSON.stringify(input.snapshot),
              hash(input.snapshot),
              actor.userId,
            )
          )[0];
          if (!row)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          await this.audit(
            tx,
            actor,
            "approval.requested",
            "approval",
            String(row.id),
            correlationId,
            undefined,
            row,
          );
          return row;
        },
      );
    });
  }

  async decideApproval(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["APPROVE", "REJECT"]),
        roleId: z.string().uuid(),
        comment: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "governance.admin", "APPROVE");
      return this.idempotent(
        tx,
        actor,
        `approval.decide:${id}`,
        key,
        input,
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT * FROM app.approval_instances WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              id,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const target = this.governedTarget(String(before.target_type));
          await this.assertResourceScope(
            tx,
            actor,
            "governance.admin",
            "APPROVE",
            target.resource,
            String(before.target_id),
          );
          if (before.requester_id === actor.userId)
            throw new AppError(
              403,
              "SEGREGATION_REQUIRED",
              "Requester cannot approve their own submission",
            );
          if (Number(before.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Approval changed; reload and retry",
            );
          if (before.state !== "PENDING")
            throw new AppError(
              409,
              "APPROVAL_STATE_CONFLICT",
              "Approval is no longer pending",
            );
          const definition = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT steps FROM app.approval_definitions WHERE tenant_id=$1::uuid AND id=$2::uuid`,
              tenantId,
              before.definition_id,
            )
          )[0];
          const steps =
            (definition?.steps as Array<{
              roleId: string;
              expiresHours?: number;
            }>) ?? [];
          const required = steps[Number(before.current_step) - 1];
          if (!required || required.roleId !== input.roleId)
            throw new AppError(
              403,
              "APPROVER_ROLE_REQUIRED",
              "The current approval step requires another role",
            );
          const holdsRole = await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT 1 FROM app.membership_role_assignments WHERE tenant_id=$1::uuid AND membership_id=$2::uuid AND role_id=$3::uuid AND status='ACTIVE'`,
            tenantId,
            actor.membershipId,
            input.roleId,
          );
          if (!holdsRole[0])
            throw new AppError(
              403,
              "APPROVER_ROLE_REQUIRED",
              "The current approval step requires another role",
            );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.approval_decisions(tenant_id,instance_id,step,decision,actor_id,actor_role_id,comment) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7)`,
            tenantId,
            id,
            before.current_step,
            input.decision,
            actor.userId,
            input.roleId,
            input.comment,
          );
          const complete =
            input.decision === "REJECT" ||
            Number(before.current_step) >= steps.length;
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.approval_instances SET state=$1,current_step=CASE WHEN $1='PENDING' THEN current_step+1 ELSE current_step END,completed_at=CASE WHEN $1='PENDING' THEN null ELSE now() END,version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING *`,
              complete
                ? input.decision === "APPROVE"
                  ? "APPROVED"
                  : "REJECTED"
                : "PENDING",
              tenantId,
              id,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "approval.decided",
            "approval",
            id,
            correlationId,
            before,
            row,
            input.comment,
          );
          return row;
        },
      );
    });
  }

  async publishConfiguration(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(5).max(500),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "configuration.admin", "APPROVE");
      return this.idempotent(
        tx,
        actor,
        `configuration.publish:${id}`,
        key,
        input,
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT * FROM app.configuration_versions WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenantId,
              id,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (
            before.state !== "DRAFT" ||
            Number(before.version) !== input.expectedVersion
          )
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Configuration changed or is not a draft",
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.configuration_versions SET state='SUPERSEDED' WHERE tenant_id=$1::uuid AND namespace=$2 AND state='PUBLISHED'`,
            tenantId,
            before.namespace,
          );
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `UPDATE app.configuration_versions SET state='PUBLISHED',published_by=$1::uuid,published_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING *`,
              actor.userId,
              tenantId,
              id,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO app.configuration_projection_versions(tenant_id,version) VALUES($1::uuid,1) ON CONFLICT(tenant_id) DO UPDATE SET version=app.configuration_projection_versions.version+1,updated_at=now()`,
            tenantId,
          );
          await this.audit(
            tx,
            actor,
            "configuration.published",
            "configuration",
            id,
            correlationId,
            before,
            row,
            input.reason,
          );
          await this.event(
            tx,
            tenantId,
            "configuration",
            id,
            "configuration.published.v1",
            { namespace: row.namespace, version: row.version },
            Number(row.version),
          );
          return row;
        },
      );
    });
  }

  async rollbackConfiguration(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        reason: z.string().trim().min(5).max(500),
        effectiveFrom: z.string().datetime({ offset: true }),
      })
      .strict()
      .parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.access(tx, actor, "configuration.admin", "ADMIN");
      return this.idempotent(
        tx,
        actor,
        `configuration.rollback:${id}`,
        key,
        input,
        async () => {
          const source = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `SELECT * FROM app.configuration_versions WHERE tenant_id=$1::uuid AND id=$2::uuid AND state IN ('PUBLISHED','SUPERSEDED')`,
              tenantId,
              id,
            )
          )[0];
          if (!source)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const version = Number(
            (
              await tx.$queryRawUnsafe<Array<Row>>(
                `SELECT max(version)+1 next FROM app.configuration_versions WHERE tenant_id=$1::uuid AND namespace=$2`,
                tenantId,
                source.namespace,
              )
            )[0]?.next,
          );
          const row = (
            await tx.$queryRawUnsafe<Array<Row>>(
              `INSERT INTO app.configuration_versions(tenant_id,namespace,version,state,value,value_hash,effective_from,rollback_of,created_by) VALUES($1::uuid,$2,$3,'DRAFT',$4::jsonb,$5,$6::timestamptz,$7::uuid,$8::uuid) RETURNING *`,
              tenantId,
              source.namespace,
              version,
              JSON.stringify(source.value),
              source.value_hash,
              input.effectiveFrom,
              id,
              actor.userId,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "configuration.rollback_drafted",
            "configuration",
            String(row.id),
            correlationId,
            source,
            row,
            input.reason,
          );
          return row;
        },
      );
    });
  }

  async report(actor: SessionActor, resource: string) {
    const definition = this.definition(resource);
    return withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.access(tx, actor, `${definition.capability}.read`, "READ");
      const rows = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT coalesce(to_jsonb(r)->>'state','ACTIVE') state,count(*)::int count FROM app.${definition.table} r WHERE tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,'READ',$5,r.id) GROUP BY 1 ORDER BY 1`,
        this.tenant(actor),
        actor.membershipId,
        actor.userId,
        `${definition.capability}.read`,
        resource,
      );
      return {
        resource,
        rows,
        total: rows.reduce((sum, row) => sum + Number(row.count), 0),
        asOf: new Date().toISOString(),
      };
    });
  }
}

function rowsBoolean(value: unknown) {
  return value === true || value === "true" || value === 1;
}
