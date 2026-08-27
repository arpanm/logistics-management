import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { withTenant, type Prisma } from "@logistics/db";
import { toJsonSafe } from "@logistics/domain";
import { AppError, AppService } from "../../app.service.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type Action = "READ" | "CREATE" | "UPDATE" | "APPROVE" | "ADMIN";
const bool = (value: unknown) => value === true || value === "t";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

@Injectable()
export class AdvancedDomainService {
  constructor(@Inject(AppService) private readonly app: AppService) {}

  private tenant(actor: SessionActor) {
    if (!actor.activeTenantId || !actor.membershipId)
      throw new AppError(403, "TENANT_REQUIRED", "Select a tenant");
    return actor.activeTenantId;
  }

  private async safeTenant<T>(
    tenant: string,
    execute: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return toJsonSafe(await withTenant(this.app.db, tenant, execute)) as T;
  }

  private async idempotent<T extends Row>(
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
    const tenant = this.tenant(actor);
    const keyHash = sha(`${tenant}:${key.trim()}`);
    const requestHash = sha(JSON.stringify(toJsonSafe(input)));
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

  private async access(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
  ) {
    const row = (
      await tx.$queryRawUnsafe<Row[]>(
        `SELECT EXISTS(SELECT 1 FROM app.membership_role_assignments a JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id
         JOIN app.role_capabilities rc ON rc.tenant_id=a.tenant_id AND rc.role_id=a.role_id
         WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
         AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND rc.capability_code=$3 AND g.action IN ($4,'ADMIN')) allowed`,
        this.tenant(actor),
        actor.membershipId,
        capability,
        action,
      )
    )[0];
    if (!bool(row?.allowed))
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  /**
   * Authorize the concrete aggregate, not merely the capability.  Returning a
   * 404 for an out-of-scope identifier avoids exposing that the record exists.
   */
  private async resourceAccess(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
    resource: string,
    resourceId: string,
  ) {
    await this.access(tx, actor, capability, action);
    const allowed = (
      await tx.$queryRawUnsafe<Row[]>(
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
    if (!bool(allowed?.allowed))
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private exactMinor(value: string) {
    return BigInt(value);
  }

  private async paymentBatchAccess(
    tx: Tx,
    actor: SessionActor,
    batchId: string,
    action: Action,
  ) {
    const linked = await tx.$queryRawUnsafe<Row[]>(
      `SELECT DISTINCT vendor_bill_id AS "vendorBillId" FROM app.payment_allocations WHERE tenant_id=$1::uuid AND payment_batch_id=$2::uuid ORDER BY "vendorBillId"`,
      this.tenant(actor),
      batchId,
    );
    if (!linked.length)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
    for (const allocation of linked)
      await this.resourceAccess(
        tx,
        actor,
        action === "READ" ? "finance.read" : "finance.admin",
        action,
        "vendor-bills",
        String(allocation.vendorBillId),
      );
  }

  private async accountingEntryAccess(
    tx: Tx,
    actor: SessionActor,
    entry: Row,
    action: Action,
  ) {
    const documentType = String(entry.document_type).toLowerCase();
    const direct: Record<string, string> = {
      invoice: "invoices",
      invoices: "invoices",
      client_invoice: "invoices",
      receipt: "receipts",
      receipts: "receipts",
      vendor_bill: "vendor-bills",
      "vendor-bills": "vendor-bills",
    };
    if (direct[documentType]) {
      await this.resourceAccess(
        tx,
        actor,
        action === "READ" ? "finance.read" : "finance.admin",
        action,
        direct[documentType],
        String(entry.document_id),
      );
      return;
    }
    if (
      documentType === "payment_batch" ||
      documentType === "payment-batches"
    ) {
      await this.paymentBatchAccess(
        tx,
        actor,
        String(entry.document_id),
        action,
      );
      return;
    }
    throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  private audit(
    tx: Tx,
    actor: SessionActor,
    action: string,
    type: string,
    id: string,
    correlationId: string,
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
      correlationId,
      before === undefined ? null : JSON.stringify(toJsonSafe(before)),
      after === undefined ? null : JSON.stringify(toJsonSafe(after)),
      reason ?? null,
    );
  }

  async organizationImpact(actor: SessionActor, nodeId: string) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:mst01:organization`,
      );
      await this.resourceAccess(
        tx,
        actor,
        "masters.read",
        "READ",
        "organization-nodes",
        nodeId,
      );
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT
          (SELECT count(*) FROM app.organization_closure c WHERE c.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND c.depth>0) descendants,
          (SELECT count(*) FROM app.employees e JOIN app.organization_closure c ON c.tenant_id=e.tenant_id AND c.descendant_id=e.home_node_id WHERE e.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND e.state='ACTIVE') employees,
          (SELECT count(*) FROM app.operational_assignments a JOIN app.organization_closure c ON c.tenant_id=a.tenant_id AND c.descendant_id=a.organization_node_id WHERE a.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND (a.effective_to IS NULL OR a.effective_to>now())) assignments,
          (SELECT count(*) FROM app.client_locations l JOIN app.organization_closure c ON c.tenant_id=l.tenant_id AND c.descendant_id=l.organization_node_id WHERE l.tenant_id=$1::uuid AND c.ancestor_id=$2::uuid AND l.state='ACTIVE') locations`,
        tenant,
        nodeId,
      );
      if (
        !(
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenant,
            nodeId,
          )
        )[0]
      )
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      return rows[0];
    });
  }

  async moveOrganization(
    actor: SessionActor,
    nodeId: string,
    parentId: string | null,
    expectedVersion: number,
    reason: string,
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:mst01:organization`,
      );
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "organization-nodes",
        nodeId,
      );
      return this.idempotent(
        tx,
        actor,
        `mst01.organization.move.${nodeId}`,
        idempotencyKey,
        { parentId, expectedVersion, reason },
        async () => {
          const before = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              nodeId,
            )
          )[0];
          if (!before)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(before.version) !== expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Hierarchy changed; reload and retry",
            );
          if (String(before.node_type) === "LEGAL_ENTITY" && parentId)
            throw new AppError(
              400,
              "PARENT_INVALID",
              "A legal entity must remain a root node",
            );
          if (String(before.node_type) !== "LEGAL_ENTITY" && !parentId)
            throw new AppError(
              400,
              "PARENT_INVALID",
              "Select a valid parent node",
            );
          if (
            parentId === nodeId ||
            (parentId &&
              bool(
                (
                  await tx.$queryRawUnsafe<Row[]>(
                    `SELECT EXISTS(SELECT 1 FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid AND descendant_id=$3::uuid) cycle`,
                    tenant,
                    nodeId,
                    parentId,
                  )
                )[0]?.cycle,
              ))
          )
            throw new AppError(
              409,
              "HIERARCHY_CYCLE",
              "A node cannot move beneath its descendant",
            );
          if (
            parentId &&
            !(
              await tx.$queryRawUnsafe<Row[]>(
                `SELECT id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
                tenant,
                parentId,
              )
            )[0]
          )
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Parent not found");
          if (parentId) {
            const parentType = String(
              (
                await tx.$queryRawUnsafe<Row[]>(
                  `SELECT node_type FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
                  tenant,
                  parentId,
                )
              )[0]?.node_type ?? "",
            );
            const allowed: Record<string, string[]> = {
              REGION: ["LEGAL_ENTITY"],
              BRANCH: ["REGION"],
              TEAM: ["BRANCH", "HUB"],
              HUB: ["REGION", "BRANCH"],
            };
            if (!allowed[String(before.node_type)]?.includes(parentType))
              throw new AppError(
                400,
                "PARENT_TYPE_INVALID",
                "Selected parent type is not allowed",
              );
          }
          if (parentId)
            await this.resourceAccess(
              tx,
              actor,
              "masters.admin",
              "UPDATE",
              "organization-nodes",
              parentId,
            );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.organization_closure WHERE tenant_id=$1::uuid AND descendant_id IN (SELECT descendant_id FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid) AND ancestor_id NOT IN (SELECT descendant_id FROM app.organization_closure WHERE tenant_id=$1::uuid AND ancestor_id=$2::uuid)`,
            tenant,
            nodeId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) SELECT $1::uuid,p.ancestor_id,c.descendant_id,p.depth+c.depth+1 FROM app.organization_closure p CROSS JOIN app.organization_closure c WHERE p.tenant_id=$1::uuid AND c.tenant_id=$1::uuid AND p.descendant_id=$2::uuid AND c.ancestor_id=$3::uuid ON CONFLICT DO NOTHING`,
            tenant,
            parentId,
            nodeId,
          );
          const after = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.organization_nodes SET parent_id=$1::uuid,version=version+1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING *`,
              parentId,
              tenant,
              nodeId,
            )
          )[0]!;
          await tx.$executeRawUnsafe(
            `SELECT app.reconcile_organization_subtree_scopes($1::uuid,$2::uuid)`,
            tenant,
            nodeId,
          );
          await this.audit(
            tx,
            actor,
            "organization.moved",
            "organization_node",
            nodeId,
            correlationId,
            before,
            after,
            reason,
          );
          return after;
        },
      );
    });
  }

  async bulkAssignments(
    actor: SessionActor,
    entries: Array<{
      employeeId: string;
      assignmentType: string;
      organizationNodeId?: string;
      clientId?: string;
      effectiveFrom: string;
      effectiveTo?: string;
      exceptionReason?: string;
    }>,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:mst01:employees`,
      );
      await this.access(tx, actor, "masters.admin", "UPDATE");
      if (!idempotencyKey.trim())
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Idempotency-Key is required",
        );
      const keyHash = sha(`${tenant}:${idempotencyKey.trim()}`);
      const requestHash = sha(JSON.stringify(entries));
      const claimed = await tx.$queryRawUnsafe<Row[]>(
        `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,response_json,state)
         VALUES('TENANT',$1::uuid,$2::uuid,'mst01.assignments.bulk',$3,$4,'{}','PENDING')
         ON CONFLICT(actor_id,operation,key_hash) DO NOTHING RETURNING id`,
        tenant,
        actor.userId,
        keyHash,
        requestHash,
      );
      if (!claimed.length) {
        const existing = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT request_hash,response_json,state FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation='mst01.assignments.bulk' AND key_hash=$3 FOR UPDATE`,
            tenant,
            actor.userId,
            keyHash,
          )
        )[0]!;
        if (existing.request_hash !== requestHash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used with different input",
          );
        if (existing.state === "COMPLETE") return existing.response_json;
      }
      const created: Row[] = [];
      for (const entry of entries) {
        if (!entry.organizationNodeId && !entry.clientId)
          throw new AppError(
            400,
            "ASSIGNMENT_TARGET_REQUIRED",
            "An organization node or client is required",
          );
        await this.resourceAccess(
          tx,
          actor,
          "masters.admin",
          "UPDATE",
          "employees",
          entry.employeeId,
        );
        const activeEmployee = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE' AND active_from<=current_date AND (active_to IS NULL OR active_to>=current_date)`,
            tenant,
            entry.employeeId,
          )
        )[0];
        if (!activeEmployee)
          throw new AppError(
            409,
            "EMPLOYEE_INACTIVE",
            "Assignments require an active employee",
          );
        if (entry.organizationNodeId)
          await this.resourceAccess(
            tx,
            actor,
            "masters.admin",
            "UPDATE",
            "organization-nodes",
            entry.organizationNodeId,
          );
        if (entry.clientId)
          await this.resourceAccess(
            tx,
            actor,
            "masters.admin",
            "UPDATE",
            "clients",
            entry.clientId,
          );
        const row = (
          await tx.$queryRawUnsafe<Row[]>(
            `INSERT INTO app.operational_assignments(tenant_id,employee_id,assignment_type,organization_node_id,client_id,effective_from,effective_to,exception_reason,created_by) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::timestamptz,$7::timestamptz,$8,$9::uuid) RETURNING *`,
            tenant,
            entry.employeeId,
            entry.assignmentType,
            entry.organizationNodeId ?? null,
            entry.clientId ?? null,
            entry.effectiveFrom,
            entry.effectiveTo ?? null,
            entry.exceptionReason ?? null,
            actor.userId,
          )
        )[0]!;
        created.push(row);
        await this.audit(
          tx,
          actor,
          "assignment.created",
          "operational_assignment",
          String(row.id),
          correlationId,
          undefined,
          row,
          entry.exceptionReason,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
           VALUES($1::uuid,'TENANT','operational_assignment',$2::uuid,'assignment.created.v1',$3::jsonb,$4) ON CONFLICT(deduplication_key) DO NOTHING`,
          tenant,
          row.id,
          JSON.stringify(row),
          `mst01:assignment:${String(row.id)}:created`,
        );
      }
      const response = { items: created, count: created.length };
      await tx.$executeRawUnsafe(
        `UPDATE app.idempotency_records SET response_json=$1::jsonb,state='COMPLETE',updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND actor_id=$3::uuid AND operation='mst01.assignments.bulk' AND key_hash=$4`,
        JSON.stringify(response),
        tenant,
        actor.userId,
        keyHash,
      );
      return response;
    });
  }

  async reassignEmployee(
    actor: SessionActor,
    employeeId: string,
    input: {
      replacementEmployeeId: string;
      expectedVersion: number;
      impactSnapshotId: string;
      reason: string;
    },
    correlationId: string,
    idempotencyKey: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${tenant}:mst01:employees`,
      );
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "employees",
        employeeId,
      );
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "employees",
        input.replacementEmployeeId,
      );
      return this.idempotent(
        tx,
        actor,
        `mst01.employee.reassign.${employeeId}`,
        idempotencyKey,
        input,
        async () => {
          const employee = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT * FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
              tenant,
              employeeId,
            )
          )[0];
          const replacement = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT id,linked_membership_id FROM app.employees WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='ACTIVE'`,
              tenant,
              input.replacementEmployeeId,
            )
          )[0];
          if (!employee || !replacement)
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          if (Number(employee.version) !== input.expectedVersion)
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Employee changed; reload and retry",
            );
          if (employeeId === input.replacementEmployeeId)
            throw new AppError(
              400,
              "REPLACEMENT_INVALID",
              "Replacement must be another employee",
            );
          const replacementInReportSubtree = bool(
            (
              await tx.$queryRawUnsafe<Row[]>(
                `WITH RECURSIVE reports AS (
               SELECT id FROM app.employees WHERE tenant_id=$1::uuid AND manager_id=$2::uuid AND state='ACTIVE'
               UNION ALL SELECT e.id FROM app.employees e JOIN reports r ON e.manager_id=r.id WHERE e.tenant_id=$1::uuid AND e.state='ACTIVE'
             ) SELECT EXISTS(SELECT 1 FROM reports WHERE id=$3::uuid) found`,
                tenant,
                employeeId,
                input.replacementEmployeeId,
              )
            )[0]?.found,
          );
          if (replacementInReportSubtree)
            throw new AppError(
              409,
              "REPLACEMENT_CYCLE",
              "Replacement must be outside the employee reporting subtree",
            );
          const affected = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT
            coalesce((SELECT jsonb_agg(e.id ORDER BY e.id) FROM app.employees e WHERE tenant_id=$1::uuid AND manager_id=$2::uuid AND state='ACTIVE'),'[]') reports,
            coalesce((SELECT jsonb_agg(c.id ORDER BY c.id) FROM app.clients c WHERE tenant_id=$1::uuid AND account_manager_employee_id=$2::uuid AND state='ACTIVE'),'[]') clients,
            coalesce((SELECT jsonb_agg(l.id ORDER BY l.id) FROM app.client_locations l WHERE tenant_id=$1::uuid AND manager_employee_id=$2::uuid AND state='ACTIVE'),'[]') locations,
            coalesce((SELECT jsonb_agg(v.id ORDER BY v.id) FROM app.vendors v WHERE tenant_id=$1::uuid AND onboarding_employee_id=$2::uuid AND state<>'INACTIVE'),'[]') vendors,
            coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM app.operational_assignments a WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND (effective_to IS NULL OR effective_to>now())),'[]') assignments,
            coalesce((SELECT jsonb_agg(i.id ORDER BY i.id) FROM app.indents i WHERE tenant_id=$1::uuid AND owner_membership_id=$3::uuid AND state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED')),'[]') indents,
            coalesce((SELECT jsonb_agg(a.id ORDER BY a.id) FROM app.allocations a WHERE tenant_id=$1::uuid AND owner_membership_id=$3::uuid AND state NOT IN ('REJECTED','EXPIRED','CANCELLED')),'[]') allocations,
            coalesce((SELECT jsonb_agg(id ORDER BY id) FROM app.operational_alerts WHERE tenant_id=$1::uuid AND owner_membership_id=$3::uuid AND state<>'RESOLVED'),'[]') alerts,
            coalesce((SELECT jsonb_agg(r.id ORDER BY r.id) FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.active AND (app.jsonb_replace_string(r.recipient_policy,$3::text,'')<>r.recipient_policy OR app.jsonb_replace_string(r.escalation_levels,$3::text,'')<>r.escalation_levels)),'[]') "alertRules"`,
              tenant,
              employeeId,
              employee.linked_membership_id ?? null,
            )
          )[0]!;
          for (const [resource, ids] of [
            ["employees", affected.reports],
            ["clients", affected.clients],
            ["client-locations", affected.locations],
            ["vendors", affected.vendors],
            ["indents", affected.indents],
            ["allocations", affected.allocations],
          ] as Array<[string, unknown]>)
            for (const resourceId of Array.isArray(ids) ? ids : [])
              await this.resourceAccess(
                tx,
                actor,
                "masters.admin",
                "UPDATE",
                resource,
                String(resourceId),
              );
          const assignmentDenied = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.operational_assignments a WHERE a.tenant_id=$1::uuid AND a.id=ANY($4::uuid[]) AND
                ((a.organization_node_id IS NOT NULL AND NOT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','organization-nodes',a.organization_node_id)) OR
                 (a.client_id IS NOT NULL AND NOT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE','clients',a.client_id)))) denied`,
              tenant,
              actor.membershipId,
              actor.userId,
              affected.assignments,
            )
          )[0];
          if (bool(assignmentDenied?.denied))
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const alertDenied = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.operational_alerts a WHERE a.tenant_id=$1::uuid AND a.id=ANY($4::uuid[]) AND NOT (
                 (a.rule_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=a.tenant_id AND r.id=a.rule_id AND app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE',r.scope_node_ids)))
                 OR (a.rule_id IS NULL AND a.source_record_id IS NOT NULL AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE',a.source_module,a.source_record_id))
               )) denied`,
              tenant,
              actor.membershipId,
              actor.userId,
              affected.alerts,
            )
          )[0];
          if (bool(alertDenied?.denied))
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const ruleDenied = (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.alert_rules r WHERE r.tenant_id=$1::uuid AND r.id=ANY($4::uuid[]) AND NOT app.alert_rule_scope_authorized($1::uuid,$2::uuid,$3::uuid,'masters.admin','UPDATE',r.scope_node_ids)) denied`,
              tenant,
              actor.membershipId,
              actor.userId,
              affected.alertRules,
            )
          )[0];
          if (bool(ruleDenied?.denied))
            throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
          const impactCategories = Object.fromEntries(
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
                count: Array.isArray(affected[name])
                  ? affected[name].length
                  : 0,
                ids: affected[name] ?? [],
              },
            ]),
          );
          if (
            sha(
              JSON.stringify(
                toJsonSafe({
                  version: Number(employee.version),
                  categories: impactCategories,
                }),
              ),
            ) !== input.impactSnapshotId
          )
            throw new AppError(
              409,
              "IMPACT_CHANGED",
              "Impact changed; review the latest preview and retry",
            );
          const membershipImpact =
            JSON.stringify(affected.indents) !== "[]" ||
            JSON.stringify(affected.allocations) !== "[]" ||
            JSON.stringify(affected.alerts) !== "[]";
          const alertRuleImpact = JSON.stringify(affected.alertRules) !== "[]";
          if (
            (membershipImpact || alertRuleImpact) &&
            employee.linked_membership_id &&
            !replacement.linked_membership_id
          )
            throw new AppError(
              409,
              "REPLACEMENT_MEMBERSHIP_REQUIRED",
              "Replacement must have an active linked user for owned open work",
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.employees SET manager_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND manager_id=$3::uuid AND id=ANY($4::uuid[])`,
            input.replacementEmployeeId,
            tenant,
            employeeId,
            affected.reports,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.clients SET account_manager_employee_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND account_manager_employee_id=$3::uuid AND state='ACTIVE' AND id=ANY($4::uuid[])`,
            input.replacementEmployeeId,
            tenant,
            employeeId,
            affected.clients,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.client_locations SET manager_employee_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND manager_employee_id=$3::uuid AND state='ACTIVE' AND id=ANY($4::uuid[])`,
            input.replacementEmployeeId,
            tenant,
            employeeId,
            affected.locations,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.vendors SET onboarding_employee_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND onboarding_employee_id=$3::uuid AND state<>'INACTIVE' AND id=ANY($4::uuid[])`,
            input.replacementEmployeeId,
            tenant,
            employeeId,
            affected.vendors,
          );
          if (
            employee.linked_membership_id &&
            replacement.linked_membership_id
          ) {
            await tx.$executeRawUnsafe(
              `UPDATE app.indents SET owner_membership_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND owner_membership_id=$3::uuid AND state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED') AND id=ANY($4::uuid[])`,
              replacement.linked_membership_id,
              tenant,
              employee.linked_membership_id,
              affected.indents,
            );
            await tx.$executeRawUnsafe(
              `UPDATE app.allocations SET owner_membership_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND owner_membership_id=$3::uuid AND state NOT IN ('REJECTED','EXPIRED','CANCELLED') AND id=ANY($4::uuid[])`,
              replacement.linked_membership_id,
              tenant,
              employee.linked_membership_id,
              affected.allocations,
            );
            await tx.$executeRawUnsafe(
              `UPDATE app.operational_alerts SET owner_membership_id=$1::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$2::uuid AND owner_membership_id=$3::uuid AND state<>'RESOLVED' AND id=ANY($4::uuid[])`,
              replacement.linked_membership_id,
              tenant,
              employee.linked_membership_id,
              affected.alerts,
            );
            await tx.$executeRawUnsafe(
              `UPDATE app.alert_rules SET recipient_policy=app.jsonb_replace_string(recipient_policy,$1,$2),escalation_levels=app.jsonb_replace_string(escalation_levels,$1,$2),updated_at=now(),version=version+1
               WHERE tenant_id=$3::uuid AND active AND id=ANY($4::uuid[]) AND (app.jsonb_replace_string(recipient_policy,$1,$2)<>recipient_policy OR app.jsonb_replace_string(escalation_levels,$1,$2)<>escalation_levels)`,
              String(employee.linked_membership_id),
              String(replacement.linked_membership_id),
              tenant,
              affected.alertRules,
            );
          }
          await tx.$executeRawUnsafe(
            `WITH current_rows AS MATERIALIZED (
           SELECT id,assignment_type,organization_node_id,client_id,effective_to FROM app.operational_assignments
           WHERE tenant_id=$2::uuid AND employee_id=$3::uuid AND id=ANY($6::uuid[]) AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) FOR UPDATE
         ), closed AS (
           UPDATE app.operational_assignments a SET effective_to=now(),exception_reason=$1 FROM current_rows c
           WHERE a.tenant_id=$2::uuid AND a.id=c.id RETURNING a.id
         )
         INSERT INTO app.operational_assignments(tenant_id,employee_id,assignment_type,organization_node_id,client_id,effective_from,effective_to,exception_reason,created_by)
         SELECT $2::uuid,$4::uuid,c.assignment_type,c.organization_node_id,c.client_id,now(),c.effective_to,$1,$5::uuid FROM current_rows c CROSS JOIN (SELECT count(*) FROM closed) ensure_closed`,
            input.reason,
            tenant,
            employeeId,
            input.replacementEmployeeId,
            actor.userId,
            affected.assignments,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.operational_assignments SET employee_id=$1::uuid,exception_reason=$2
         WHERE tenant_id=$3::uuid AND employee_id=$4::uuid AND id=ANY($5::uuid[]) AND effective_from>now() AND (effective_to IS NULL OR effective_to>now())`,
            input.replacementEmployeeId,
            input.reason,
            tenant,
            employeeId,
            affected.assignments,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.scope_grants g SET status='INACTIVE',effective_to=coalesce(effective_to,now()),updated_at=now(),version=version+1
         FROM app.employee_scope_grant_links l WHERE l.tenant_id=$1::uuid AND l.employee_id=$2::uuid AND l.state='ACTIVE' AND g.tenant_id=l.tenant_id AND g.id=l.grant_id AND g.status='ACTIVE'`,
            tenant,
            employeeId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE app.employee_scope_grant_links SET state='INACTIVE',ended_at=now() WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND state='ACTIVE'`,
            tenant,
            employeeId,
          );
          if (replacement.linked_membership_id)
            await tx.$executeRawUnsafe(
              `WITH desired AS (
             SELECT DISTINCT ON (n.authorization_scope_node_id) n.id organization_id,n.authorization_scope_node_id scope_id,
               CASE WHEN n.id=e.home_node_id THEN 'HOME' ELSE 'REGION' END coverage_kind
             FROM app.employees e JOIN app.organization_nodes n ON n.tenant_id=e.tenant_id AND (n.id=e.home_node_id OR EXISTS(SELECT 1 FROM app.employee_region_coverage c WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id AND c.organization_node_id=n.id))
             WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid ORDER BY n.authorization_scope_node_id,(n.id=e.home_node_id) DESC
           ), source_actions AS (
             SELECT DISTINCT a.id assignment_id,g.action FROM app.membership_role_assignments a JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id
             WHERE a.tenant_id=$1::uuid AND a.membership_id=$3::uuid AND a.status='ACTIVE' AND g.status='ACTIVE'
           ), inserted AS (
             INSERT INTO app.scope_grants(id,tenant_id,assignment_id,scope_node_id,action,status,effective_from)
             SELECT gen_random_uuid(),$1::uuid,s.assignment_id,d.scope_id,s.action,'ACTIVE',now() FROM source_actions s CROSS JOIN desired d
             ON CONFLICT(tenant_id,assignment_id,scope_node_id,action) DO NOTHING RETURNING id,scope_node_id
           ) INSERT INTO app.employee_scope_grant_links(tenant_id,employee_id,grant_id,coverage_kind,organization_node_id)
             SELECT $1::uuid,$2::uuid,i.id,d.coverage_kind,d.organization_id FROM inserted i JOIN desired d ON d.scope_id=i.scope_node_id`,
              tenant,
              input.replacementEmployeeId,
              replacement.linked_membership_id,
            );
          await tx.$executeRawUnsafe(
            `UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,updated_at=now()
             WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
            tenant,
            [
              employee.linked_membership_id,
              replacement.linked_membership_id,
            ].filter(Boolean),
          );
          const after = (
            await tx.$queryRawUnsafe<Row[]>(
              `UPDATE app.employees SET state='INACTIVE',active_to=current_date,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
              tenant,
              employeeId,
            )
          )[0]!;
          await this.audit(
            tx,
            actor,
            "employee.reassigned_and_deactivated",
            "employee",
            employeeId,
            correlationId,
            { employee, affected },
            {
              employee: after,
              replacementEmployeeId: replacement.id,
              affected,
            },
            input.reason,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','employee',$2::uuid,'employee.reassigned_deactivated.v1',$3::jsonb,$4) ON CONFLICT(deduplication_key) DO NOTHING`,
            tenant,
            employeeId,
            JSON.stringify({ replacementEmployeeId: replacement.id, affected }),
            `mst01:employee:reassign:${employeeId}:${input.expectedVersion}`,
          );
          return after;
        },
      );
    });
  }

  async duplicateCandidates(
    actor: SessionActor,
    kind: "CLIENT" | "VENDOR",
    name: string,
    taxId?: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "masters.read", "READ");
      const table = kind === "CLIENT" ? "clients" : "vendors";
      const nameColumn = kind === "CLIENT" ? "legal_name" : "legal_name";
      const taxColumns =
        kind === "CLIENT" ? "tax_identifier" : "coalesce(pan,gstin)";
      const resource = kind === "CLIENT" ? "clients" : "vendors";
      return tx.$queryRawUnsafe<Row[]>(
        `SELECT id,code,${nameColumn} name,(CASE WHEN lower(${nameColumn})=lower($2) THEN 1 WHEN lower(${nameColumn}) LIKE '%'||lower($2)||'%' OR lower($2) LIKE '%'||lower(${nameColumn})||'%' THEN 0.7 ELSE 0.4 END)::float8 score FROM app.${table} WHERE tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'masters.read','READ',$6,id) AND (lower(${nameColumn}) LIKE '%'||lower($2)||'%' OR lower($2) LIKE '%'||lower(${nameColumn})||'%' OR ($3<>'' AND ${taxColumns}=$3)) ORDER BY score DESC LIMIT 20`,
        tenant,
        name,
        taxId ?? "",
        actor.membershipId,
        actor.userId,
        resource,
      );
    });
  }

  async createContractVersion(
    actor: SessionActor,
    contractId: string,
    input: {
      expectedVersion: number;
      creditDays: number;
      podMode: string;
      documentRequirements: unknown[];
      terms: Record<string, unknown>;
      reason: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "contracts",
        contractId,
      );
      const contract = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.contracts WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          contractId,
        )
      )[0];
      if (!contract)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(contract.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Contract changed; reload and retry",
        );
      const next = Number(contract.current_version) + 1;
      const version = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.contract_versions(tenant_id,contract_id,version,credit_days,pod_mode,document_requirements,terms,snapshot_hash,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::uuid) RETURNING *`,
          tenant,
          contractId,
          next,
          input.creditDays,
          input.podMode,
          JSON.stringify(input.documentRequirements),
          JSON.stringify(input.terms),
          sha(JSON.stringify(input)),
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `UPDATE app.contracts SET current_version=$1,state='DRAFT',version=version+1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        next,
        tenant,
        contractId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.contract_change_notes(tenant_id,contract_id,from_version,to_version,reason,actor_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid)`,
        tenant,
        contractId,
        contract.current_version,
        next,
        input.reason,
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "contract.version_created",
        "contract",
        contractId,
        correlationId,
        contract,
        version,
        input.reason,
      );
      return version;
    });
  }

  async contractVersions(actor: SessionActor, search = "") {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "masters.read", "READ");
      const items = await tx.$queryRawUnsafe<Row[]>(
        `SELECT v.id,c.code||' · version '||v.version::text AS name,c.code,v.version,c.state
         FROM app.contract_versions v JOIN app.contracts c ON c.tenant_id=v.tenant_id AND c.id=v.contract_id
         WHERE v.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'masters.read','READ','contracts',c.id)
         AND ($2='' OR c.code ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%')
         ORDER BY c.code,v.version DESC LIMIT 100`,
        tenant,
        search,
        actor.membershipId,
        actor.userId,
      );
      return { items };
    });
  }

  async paymentBatches(actor: SessionActor, search = "") {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "finance.read", "READ");
      const candidates = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id,batch_no AS code,batch_no AS name,state,version FROM app.payment_batches
         WHERE tenant_id=$1::uuid AND ($2='' OR batch_no ILIKE '%'||$2||'%') ORDER BY created_at DESC LIMIT 100`,
        tenant,
        search,
      );
      const items: Row[] = [];
      for (const candidate of candidates) {
        try {
          await this.paymentBatchAccess(
            tx,
            actor,
            String(candidate.id),
            "READ",
          );
          items.push(candidate);
        } catch (error) {
          if (!(error instanceof AppError && error.status === 404)) throw error;
        }
      }
      return { items };
    });
  }

  private encryptAccount(account: string) {
    const encoded = this.app.config.MFA_ENCRYPTION_KEY;
    const key = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (key.length !== 32)
      throw new AppError(
        503,
        "ENCRYPTION_NOT_CONFIGURED",
        "Bank encryption is not configured",
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(account, "utf8"),
      cipher.final(),
    ]);
    return Buffer.from(
      JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      }),
      "utf8",
    );
  }

  async addVendorBank(
    actor: SessionActor,
    vendorId: string,
    input: { accountHolder: string; accountNumber: string; ifsc: string },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        "vendors",
        vendorId,
      );
      if (
        !(
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.vendors WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenant,
            vendorId,
          )
        )[0]
      )
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const next = Number(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT coalesce(max(version),0)+1 next FROM app.vendor_bank_versions WHERE tenant_id=$1::uuid AND vendor_id=$2::uuid`,
            tenant,
            vendorId,
          )
        )[0]?.next ?? 1,
      );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.vendor_bank_versions(tenant_id,vendor_id,version,account_holder,account_ciphertext,account_last4,ifsc,maker_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::uuid) RETURNING id,vendor_id,version,account_holder,account_last4,ifsc,state,maker_id,created_at`,
          tenant,
          vendorId,
          next,
          input.accountHolder,
          this.encryptAccount(input.accountNumber),
          input.accountNumber.slice(-4),
          input.ifsc.toUpperCase(),
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "vendor.bank_added",
        "vendor_bank_version",
        String(row.id),
        correlationId,
        undefined,
        row,
      );
      return row;
    });
  }

  async vendorBanks(actor: SessionActor, vendorId: string) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "masters.read",
        "READ",
        "vendors",
        vendorId,
      );
      return tx.$queryRawUnsafe<Row[]>(
        `SELECT id,vendor_id AS "vendorId",version,account_holder AS "accountHolder",account_last4 AS "accountLast4",ifsc,state,maker_id AS "makerId",checker_id AS "checkerId",verified_at AS "verifiedAt",created_at AS "createdAt" FROM app.vendor_bank_versions WHERE tenant_id=$1::uuid AND vendor_id=$2::uuid ORDER BY version DESC`,
        tenant,
        vendorId,
      );
    });
  }

  async verifyVendorBank(
    actor: SessionActor,
    bankId: string,
    expectedState: "PENDING_VERIFICATION",
    decision: "VERIFIED" | "REJECTED",
    reason: string,
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "masters.admin", "APPROVE");
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id,vendor_id,state,maker_id FROM app.vendor_bank_versions WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          bankId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "APPROVE",
        "vendors",
        String(before.vendor_id),
      );
      if (before.state !== expectedState)
        throw new AppError(409, "STATE_CONFLICT", "Bank version changed");
      if (before.maker_id === actor.userId)
        throw new AppError(
          409,
          "SEGREGATION_REQUIRED",
          "Maker cannot verify bank details",
        );
      if (decision === "VERIFIED")
        await tx.$executeRawUnsafe(
          `UPDATE app.vendor_bank_versions SET state='SUPERSEDED' WHERE tenant_id=$1::uuid AND vendor_id=$2::uuid AND state='VERIFIED'`,
          tenant,
          before.vendor_id,
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.vendor_bank_versions SET state=$1,checker_id=$2::uuid,verified_at=now() WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING id,vendor_id,version,account_holder,account_last4,ifsc,state,checker_id,verified_at`,
          decision,
          actor.userId,
          tenant,
          bankId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        `vendor.bank_${decision.toLowerCase()}`,
        "vendor_bank_version",
        bankId,
        correlationId,
        before,
        after,
        reason,
      );
      return after;
    });
  }

  async upsertCompliance(
    actor: SessionActor,
    input: {
      subjectType: string;
      subjectId: string;
      requirementCode: string;
      documentId?: string;
      validFrom?: string;
      validTo?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      const resource = {
        VENDOR: "vendors",
        VEHICLE: "vehicles",
        DRIVER: "drivers",
      }[input.subjectType];
      if (!resource)
        throw new AppError(400, "SUBJECT_INVALID", "Subject type is invalid");
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "UPDATE",
        resource,
        input.subjectId,
      );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.compliance_records(tenant_id,subject_type,subject_id,requirement_code,document_id,valid_from,valid_to) VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6::date,$7::date) ON CONFLICT(tenant_id,subject_type,subject_id,requirement_code) DO UPDATE SET document_id=excluded.document_id,valid_from=excluded.valid_from,valid_to=excluded.valid_to,verification_state='PENDING',verified_by=null,verified_at=null RETURNING *`,
          tenant,
          input.subjectType,
          input.subjectId,
          input.requirementCode,
          input.documentId ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "compliance.submitted",
        "compliance_record",
        String(row.id),
        correlationId,
        undefined,
        row,
      );
      return row;
    });
  }

  async decideCompliance(
    actor: SessionActor,
    id: string,
    decision: "VERIFIED" | "REJECTED",
    reason: string,
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "masters.admin", "APPROVE");
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.compliance_records WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const subjectResource = {
        VENDOR: "vendors",
        VEHICLE: "vehicles",
        DRIVER: "drivers",
      }[String(before.subject_type)];
      if (!subjectResource)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "APPROVE",
        subjectResource,
        String(before.subject_id),
      );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.compliance_records SET verification_state=$1,verified_by=$2::uuid,verified_at=now() WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING *`,
          decision,
          actor.userId,
          tenant,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "compliance.decided",
        "compliance_record",
        id,
        correlationId,
        before,
        row,
        reason,
      );
      return row;
    });
  }

  async complianceRecords(
    actor: SessionActor,
    subjectType: string,
    subjectId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "masters.read",
        "READ",
        { VENDOR: "vendors", VEHICLE: "vehicles", DRIVER: "drivers" }[
          subjectType
        ] ?? "invalid",
        subjectId,
      );
      return tx.$queryRawUnsafe<Row[]>(
        `SELECT id,subject_type AS "subjectType",subject_id AS "subjectId",requirement_code AS "requirementCode",document_id AS "documentId",valid_from AS "validFrom",valid_to AS "validTo",verification_state AS state,verified_at AS "verifiedAt" FROM app.compliance_records WHERE tenant_id=$1::uuid AND subject_type=$2 AND subject_id=$3::uuid ORDER BY requirement_code`,
        tenant,
        subjectType,
        subjectId,
      );
    });
  }

  async eligibility(
    actor: SessionActor,
    subjectType: "VENDOR" | "VEHICLE" | "DRIVER",
    subjectId: string,
    contextId?: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "masters.read",
        "READ",
        { VENDOR: "vendors", VEHICLE: "vehicles", DRIVER: "drivers" }[
          subjectType
        ],
        subjectId,
      );
      const records = await tx.$queryRawUnsafe<Row[]>(
        `SELECT requirement_code AS "requirementCode",verification_state AS state,valid_to AS "validTo",(verification_state='VERIFIED' AND (valid_to IS NULL OR valid_to>=current_date)) eligible FROM app.compliance_records WHERE tenant_id=$1::uuid AND subject_type=$2 AND subject_id=$3::uuid ORDER BY requirement_code`,
        tenant,
        subjectType,
        subjectId,
      );
      const override = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id,reason,expires_at FROM app.eligibility_overrides WHERE tenant_id=$1::uuid AND subject_type=$2 AND subject_id=$3::uuid AND ($4::uuid IS NULL OR context_id=$4::uuid) AND expires_at>now() ORDER BY expires_at DESC LIMIT 1`,
          tenant,
          subjectType,
          subjectId,
          contextId ?? null,
        )
      )[0];
      return {
        subjectType,
        subjectId,
        eligible:
          Boolean(override) ||
          (records.length > 0 && records.every((r) => bool(r.eligible))),
        override: override ?? null,
        requirements: records,
      };
    });
  }

  async overrideEligibility(
    actor: SessionActor,
    input: {
      subjectType: string;
      subjectId: string;
      contextType: string;
      contextId: string;
      reason: string;
      expiresAt: string;
      approvedBy: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      const resource = {
        VENDOR: "vendors",
        VEHICLE: "vehicles",
        DRIVER: "drivers",
      }[input.subjectType];
      if (!resource)
        throw new AppError(400, "SUBJECT_INVALID", "Subject type is invalid");
      await this.resourceAccess(
        tx,
        actor,
        "masters.admin",
        "APPROVE",
        resource,
        input.subjectId,
      );
      // `approvedBy` is retained as the transport field for compatibility,
      // but is interpreted as an immutable approval-decision identifier.  The
      // approver identity and authorization are always derived server-side.
      const approval = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT d.id AS "decisionId",d.actor_id AS "approverId"
           FROM app.approval_decisions d
           JOIN app.approval_instances i ON i.tenant_id=d.tenant_id AND i.id=d.instance_id
           JOIN app.tenant_memberships m ON m.tenant_id=d.tenant_id AND m.user_id=d.actor_id AND m.status='ACTIVE' AND m.portal_audience='INTERNAL'
           JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.role_id=d.actor_role_id
             AND a.status='ACTIVE' AND a.effective_from<=d.decided_at AND (a.effective_to IS NULL OR a.effective_to>d.decided_at)
           WHERE d.tenant_id=$1::uuid AND d.id=$2::uuid AND d.decision='APPROVE'
             AND d.actor_id<>$3::uuid AND i.state='APPROVED' AND i.target_type='ELIGIBILITY_OVERRIDE' AND i.target_id=$4::uuid
             AND i.snapshot->>'subjectType'=$5 AND i.snapshot->>'subjectId'=($6::uuid)::text
             AND i.snapshot->>'contextType'=$7 AND i.snapshot->>'contextId'=($4::uuid)::text
             AND app.domain_resource_authorized($1::uuid,m.id,d.actor_id,'masters.admin','APPROVE',$8,$6::uuid)
           LIMIT 1`,
          tenant,
          input.approvedBy,
          actor.userId,
          input.contextId,
          input.subjectType,
          input.subjectId,
          input.contextType,
          resource,
        )
      )[0];
      if (!approval)
        throw new AppError(
          409,
          "APPROVAL_REQUIRED",
          "A matching approval by a distinct authorized approver is required",
        );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.eligibility_overrides(tenant_id,subject_type,subject_id,context_type,context_id,reason,expires_at,approved_by,created_by,approval_decision_id) VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7::timestamptz,$8::uuid,$9::uuid,$10::uuid) RETURNING *`,
          tenant,
          input.subjectType,
          input.subjectId,
          input.contextType,
          input.contextId,
          input.reason,
          input.expiresAt,
          approval.approverId,
          actor.userId,
          approval.decisionId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "eligibility.overridden",
        "eligibility_override",
        String(row.id),
        correlationId,
        undefined,
        row,
        input.reason,
      );
      return row;
    });
  }

  async cancelIndent(
    actor: SessionActor,
    indentId: string,
    input: {
      cancelledVehicles: number;
      vendorCostMinor: string;
      expectedVersion: number;
      reason: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "operations.admin", "UPDATE");
      const indent = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.indents WHERE tenant_id=$1::uuid AND id=$2::uuid AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.admin','UPDATE','indents',id) FOR UPDATE`,
          tenant,
          indentId,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (!indent)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(indent.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Indent changed; reload and retry",
        );
      const allocated = Number(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT coalesce(sum(allotted_vehicles),0) total FROM app.allocations WHERE tenant_id=$1::uuid AND indent_id=$2::uuid AND state NOT IN ('REJECTED','EXPIRED','CANCELLED')`,
            tenant,
            indentId,
          )
        )[0]?.total ?? 0,
      );
      const cancelled = Number(
        (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT coalesce(sum(cancelled_vehicles),0) total FROM app.indent_cancellations WHERE tenant_id=$1::uuid AND indent_id=$2::uuid`,
            tenant,
            indentId,
          )
        )[0]?.total ?? 0,
      );
      const remaining =
        Number(indent.requested_vehicles) - allocated - cancelled;
      if (input.cancelledVehicles > remaining)
        throw new AppError(
          409,
          "CANCELLATION_EXCEEDS_REMAINING",
          "Cancellation exceeds remaining demand",
        );
      const cancellation = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.indent_cancellations(tenant_id,indent_id,cancelled_vehicles,reason,vendor_cost_minor,cancelled_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::uuid) RETURNING *`,
          tenant,
          indentId,
          input.cancelledVehicles,
          input.reason,
          input.vendorCostMinor,
          actor.userId,
        )
      )[0]!;
      const state =
        input.cancelledVehicles === remaining
          ? "CANCELLED"
          : String(indent.state);
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.indents SET state=$1,version=version+1,updated_at=now() WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING *`,
          state,
          tenant,
          indentId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "indent.cancelled",
        "indent",
        indentId,
        correlationId,
        indent,
        { indent: after, cancellation },
        input.reason,
      );
      return {
        indent: after,
        cancellation,
        remainingVehicles: remaining - input.cancelledVehicles,
      };
    });
  }

  async respondOffer(
    actor: SessionActor,
    allocationId: string,
    input: {
      decision: "ACCEPTED" | "REJECTED";
      expectedVersion: number;
      reason?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "operations.admin", "UPDATE");
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.allocations WHERE tenant_id=$1::uuid AND id=$2::uuid AND app.domain_resource_authorized($1::uuid,$3::uuid,$4::uuid,'operations.admin','UPDATE','allocations',id) FOR UPDATE`,
          tenant,
          allocationId,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Offer changed; reload and retry",
        );
      if (
        before.state !== "OFFERED" ||
        new Date(String(before.expires_at)) <= new Date()
      )
        throw new AppError(
          409,
          "OFFER_EXPIRED",
          "Offer is no longer available",
        );
      if (input.decision === "REJECTED" && !input.reason)
        throw new AppError(
          400,
          "REASON_REQUIRED",
          "A rejection reason is required",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.allocations SET state=$1,response_at=now(),rejection_reason=$2,version=version+1,updated_at=now() WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING *`,
          input.decision,
          input.reason ?? null,
          tenant,
          allocationId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "allocation.offer_responded",
        "allocation",
        allocationId,
        correlationId,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }

  async reviewPod(
    actor: SessionActor,
    podId: string,
    input: {
      action:
        | "RECEIVE"
        | "START_REVIEW"
        | "ACCEPT"
        | "REJECT"
        | "REQUEST_CORRECTION"
        | "SUBMIT";
      expectedVersion: number;
      reason?: string;
      invoiceReference?: string;
      invoiceDate?: string;
      invoiceValueMinor?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    const next: Record<string, [string, string[]]> = {
      RECEIVE: ["RECEIVED", ["AWAITING_POD"]],
      START_REVIEW: ["UNDER_REVIEW", ["RECEIVED", "CORRECTION_REQUIRED"]],
      ACCEPT: ["ACCEPTED", ["UNDER_REVIEW", "CORRECTION_REQUIRED"]],
      REJECT: ["REJECTED", ["UNDER_REVIEW"]],
      REQUEST_CORRECTION: ["CORRECTION_REQUIRED", ["UNDER_REVIEW", "REJECTED"]],
      SUBMIT: ["SUBMITTED_TO_CLIENT", ["ACCEPTED"]],
    };
    return this.safeTenant(tenant, async (tx) => {
      const accessAction =
        input.action === "ACCEPT" || input.action === "SUBMIT"
          ? "APPROVE"
          : "UPDATE";
      await this.resourceAccess(
        tx,
        actor,
        "pod.admin",
        accessAction,
        "pod-tasks",
        podId,
      );
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.pod_tasks WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          podId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "POD changed; reload and retry",
        );
      const [state, from] = next[input.action]!;
      if (!from.includes(String(before.state)))
        throw new AppError(
          409,
          "TRANSITION_INVALID",
          "POD action is not allowed",
        );
      if (
        ["REJECT", "REQUEST_CORRECTION"].includes(input.action) &&
        !input.reason
      )
        throw new AppError(400, "REASON_REQUIRED", "A reason is required");
      if (input.action === "ACCEPT") {
        const clean = bool(
          (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.governed_documents d JOIN app.governed_document_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.version=d.current_version WHERE d.tenant_id=$1::uuid AND d.target_type='POD' AND d.target_id=$2::uuid AND d.state='VERIFIED' AND v.malware_state='CLEAN') ok`,
              tenant,
              podId,
            )
          )[0]?.ok,
        );
        if (!clean)
          throw new AppError(
            409,
            "POD_EVIDENCE_REQUIRED",
            "A clean verified POD document is required",
          );
      }
      if (input.invoiceReference)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.pod_invoice_links(tenant_id,pod_task_id,invoice_reference,invoice_date,value_minor) VALUES($1::uuid,$2::uuid,$3,$4::date,$5) ON CONFLICT(tenant_id,pod_task_id,invoice_reference) DO UPDATE SET invoice_date=excluded.invoice_date,value_minor=excluded.value_minor`,
          tenant,
          podId,
          input.invoiceReference,
          input.invoiceDate ?? null,
          input.invoiceValueMinor ?? "0",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.pod_tasks SET state=$1,received_at=CASE WHEN $1='RECEIVED' THEN now() ELSE received_at END,submitted_at=CASE WHEN $1='SUBMITTED_TO_CLIENT' THEN now() ELSE submitted_at END,invoice_value_minor=coalesce($2,invoice_value_minor),version=version+1,updated_at=now() WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING *`,
          state,
          input.invoiceValueMinor ?? null,
          tenant,
          podId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        `pod.${input.action.toLowerCase()}`,
        "pod_task",
        podId,
        correlationId,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }

  async acknowledgeInvoice(
    actor: SessionActor,
    invoiceId: string,
    input: {
      expectedVersion: number;
      acknowledgedAt: string;
      evidence: Record<string, unknown>;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "UPDATE",
        "invoices",
        invoiceId,
      );
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          invoiceId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Invoice changed; reload and retry",
        );
      if (!["POSTED", "SUBMITTED"].includes(String(before.state)))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          "Only posted invoices can be acknowledged",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.client_invoices SET acknowledged_at=$1::timestamptz,due_date=($1::timestamptz AT TIME ZONE 'UTC')::date+credit_days,version=version+1 WHERE tenant_id=$2::uuid AND id=$3::uuid RETURNING *`,
          input.acknowledgedAt,
          tenant,
          invoiceId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.invoice_notes(tenant_id,invoice_id,note_type,reason,evidence,actor_id) VALUES($1::uuid,$2::uuid,'ACKNOWLEDGEMENT','Client acknowledgement',$3::jsonb,$4::uuid)`,
        tenant,
        invoiceId,
        JSON.stringify(input.evidence),
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "invoice.acknowledged",
        "invoice",
        invoiceId,
        correlationId,
        before,
        after,
      );
      return after;
    });
  }

  async reverseInvoice(
    actor: SessionActor,
    invoiceId: string,
    input: {
      expectedVersion: number;
      reversalInvoiceNo: string;
      reason: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "APPROVE",
        "invoices",
        invoiceId,
      );
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          invoiceId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Invoice changed; reload and retry",
        );
      if (!["POSTED", "SUBMITTED"].includes(String(before.state)))
        throw new AppError(
          409,
          "STATE_CONFLICT",
          "Only posted invoices can be reversed",
        );
      const reversal = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.client_invoices(tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,state,reversal_of,created_by,posted_at) VALUES($1::uuid,$2,$3::uuid,$4::uuid,current_date,$5,$6,$7,$8,$9,'POSTED',$10::uuid,$11::uuid,now()) RETURNING *`,
          tenant,
          input.reversalInvoiceNo,
          before.client_id,
          before.client_location_id,
          before.currency,
          before.credit_days,
          (-BigInt(String(before.taxable_minor))).toString(),
          (-BigInt(String(before.tax_minor))).toString(),
          (-BigInt(String(before.total_minor))).toString(),
          invoiceId,
          actor.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.client_invoice_lines(tenant_id,invoice_id,line_no,charge_code,quantity_milli,rate_minor,taxable_minor,tax_basis_points,tax_minor,total_minor,rate_snapshot) SELECT tenant_id,$1::uuid,line_no,'REVERSAL:'||charge_code,-quantity_milli,rate_minor,-taxable_minor,tax_basis_points,-tax_minor,-total_minor,rate_snapshot||jsonb_build_object('reversalOfLineId',id) FROM app.client_invoice_lines WHERE tenant_id=$2::uuid AND invoice_id=$3::uuid`,
        reversal.id,
        tenant,
        invoiceId,
      );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.client_invoices SET state='REVERSED',version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
          tenant,
          invoiceId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.invoice_notes(tenant_id,invoice_id,note_type,amount_minor,reason,actor_id) VALUES($1::uuid,$2::uuid,'REVERSAL',$3,$4,$5::uuid)`,
        tenant,
        invoiceId,
        (-BigInt(String(before.total_minor))).toString(),
        input.reason,
        actor.userId,
      );
      await this.audit(
        tx,
        actor,
        "invoice.reversed",
        "invoice",
        invoiceId,
        correlationId,
        before,
        { source: after, reversal },
        input.reason,
      );
      return { source: after, reversal };
    });
  }

  async addInvoiceNote(
    actor: SessionActor,
    invoiceId: string,
    input: {
      noteType: "CREDIT_NOTE" | "DEBIT_NOTE";
      amountMinor: string;
      reason: string;
      evidence: Record<string, unknown>;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "APPROVE",
        "invoices",
        invoiceId,
      );
      if (
        !(
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid AND state IN ('POSTED','SUBMITTED')`,
            tenant,
            invoiceId,
          )
        )[0]
      )
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.invoice_notes(tenant_id,invoice_id,note_type,amount_minor,reason,evidence,actor_id) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::uuid) RETURNING *`,
          tenant,
          invoiceId,
          input.noteType,
          input.amountMinor,
          input.reason,
          JSON.stringify(input.evidence),
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "invoice.note_created",
        "invoice",
        invoiceId,
        correlationId,
        undefined,
        row,
        input.reason,
      );
      return row;
    });
  }

  async reverseReceiptEntry(
    actor: SessionActor,
    receiptId: string,
    entryId: string,
    reason: string,
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "APPROVE",
        "receipts",
        receiptId,
      );
      const source = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.receipt_ledger_entries WHERE tenant_id=$1::uuid AND receipt_id=$2::uuid AND id=$3::uuid`,
          tenant,
          receiptId,
          entryId,
        )
      )[0];
      if (!source)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (
        bool(
          (
            await tx.$queryRawUnsafe<Row[]>(
              `SELECT EXISTS(SELECT 1 FROM app.receipt_ledger_entries WHERE tenant_id=$1::uuid AND reverses_entry_id=$2::uuid) reversed`,
              tenant,
              entryId,
            )
          )[0]?.reversed,
        )
      )
        throw new AppError(
          409,
          "ALREADY_REVERSED",
          "Entry is already reversed",
        );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.receipt_ledger_entries(tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reverses_entry_id,reason,actor_id) VALUES($1::uuid,$2::uuid,$3::uuid,'REVERSAL',$4,$5::uuid,$6,$7::uuid) RETURNING *`,
          tenant,
          receiptId,
          source.invoice_id ?? null,
          (-BigInt(String(source.amount_minor))).toString(),
          entryId,
          reason,
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "receipt.entry_reversed",
        "receipt",
        receiptId,
        correlationId,
        source,
        row,
        reason,
      );
      return row;
    });
  }

  async addCollectionFollowup(
    actor: SessionActor,
    invoiceId: string,
    input: {
      outcome: string;
      note: string;
      promisedAt?: string;
      promisedMinor?: string;
      nextFollowupAt?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "UPDATE",
        "invoices",
        invoiceId,
      );
      if (
        !(
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT id FROM app.client_invoices WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            tenant,
            invoiceId,
          )
        )[0]
      )
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.collection_followups(tenant_id,invoice_id,outcome,note,promised_at,promised_minor,next_followup_at,actor_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6,$7::timestamptz,$8::uuid) RETURNING *`,
          tenant,
          invoiceId,
          input.outcome,
          input.note,
          input.promisedAt ?? null,
          input.promisedMinor ?? null,
          input.nextFollowupAt ?? null,
          actor.userId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "collection.followup_added",
        "invoice",
        invoiceId,
        correlationId,
        undefined,
        row,
      );
      return row;
    });
  }

  async createVendorBill(
    actor: SessionActor,
    input: {
      vendorId: string;
      vendorInvoiceNo: string;
      invoiceDate: string;
      gstMinor: string;
      tdsMinor: string;
      deductionMinor: string;
      advanceMinor: string;
      lines: Array<{ tripId: string; claimedMinor: string }>;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "vendors",
        input.vendorId,
      );
      let taxable = 0n;
      const lines: Array<
        Row & { expectedMinor: string; claimedMinor: string }
      > = [];
      for (const line of input.lines) {
        await this.resourceAccess(
          tx,
          actor,
          "finance.admin",
          "CREATE",
          "trips",
          line.tripId,
        );
        const expected = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT a.offered_rate_minor AS expected FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND a.vendor_id=$3::uuid AND t.state='DELIVERED'`,
            tenant,
            line.tripId,
            input.vendorId,
          )
        )[0];
        if (!expected)
          throw new AppError(
            409,
            "TRIP_NOT_BILLABLE",
            "Trip is not delivered or belongs to another vendor",
          );
        taxable += this.exactMinor(line.claimedMinor);
        lines.push({
          tripId: line.tripId,
          expectedMinor: String(expected.expected),
          claimedMinor: line.claimedMinor,
        });
      }
      const payable =
        taxable +
        this.exactMinor(input.gstMinor) -
        this.exactMinor(input.tdsMinor) -
        this.exactMinor(input.deductionMinor) -
        this.exactMinor(input.advanceMinor);
      if (payable < 0n)
        throw new AppError(
          400,
          "PAYABLE_INVALID",
          "Payable amount cannot be negative",
        );
      const state = lines.some(
        (line) => line.expectedMinor !== line.claimedMinor,
      )
        ? "VALIDATION_EXCEPTION"
        : "PENDING_OPERATIONAL_VERIFICATION";
      const bill = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.vendor_bills(tenant_id,vendor_id,vendor_invoice_no,invoice_date,taxable_minor,gst_minor,tds_minor,deduction_minor,advance_minor,payable_minor,state,created_by) VALUES($1::uuid,$2::uuid,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12::uuid) RETURNING *`,
          tenant,
          input.vendorId,
          input.vendorInvoiceNo,
          input.invoiceDate,
          taxable.toString(),
          input.gstMinor,
          input.tdsMinor,
          input.deductionMinor,
          input.advanceMinor,
          payable.toString(),
          state,
          actor.userId,
        )
      )[0]!;
      for (const line of lines)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.vendor_bill_lines(tenant_id,vendor_bill_id,trip_id,rate_snapshot,expected_minor,claimed_minor,variance_minor,validation_state) VALUES($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,$7,$8)`,
          tenant,
          bill.id,
          line.tripId,
          JSON.stringify({
            source: "allocation.offered_rate_minor",
            amountMinor: line.expectedMinor,
          }),
          line.expectedMinor,
          line.claimedMinor,
          (
            this.exactMinor(line.claimedMinor) -
            this.exactMinor(line.expectedMinor)
          ).toString(),
          line.claimedMinor === line.expectedMinor ? "MATCHED" : "VARIANCE",
        );
      await this.audit(
        tx,
        actor,
        "vendor_bill.created",
        "vendor_bill",
        String(bill.id),
        correlationId,
        undefined,
        bill,
      );
      return { ...bill, lines };
    });
  }

  async decideVendorBill(
    actor: SessionActor,
    billId: string,
    input: {
      action: "VERIFY" | "APPROVE" | "DISPUTE";
      expectedVersion: number;
      reason?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "APPROVE",
        "vendor-bills",
        billId,
      );
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.vendor_bills WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          billId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Bill changed; reload and retry",
        );
      if (before.created_by === actor.userId)
        throw new AppError(
          409,
          "SEGREGATION_REQUIRED",
          "Maker cannot verify or approve this bill",
        );
      let state: string;
      let extra = "";
      if (
        input.action === "VERIFY" &&
        ["PENDING_OPERATIONAL_VERIFICATION", "VALIDATION_EXCEPTION"].includes(
          String(before.state),
        )
      ) {
        state = "PENDING_FINANCE_APPROVAL";
        extra = ",verified_by=$1::uuid";
      } else if (
        input.action === "APPROVE" &&
        before.state === "PENDING_FINANCE_APPROVAL" &&
        before.verified_by !== actor.userId
      ) {
        state = "APPROVED";
        extra = ",approved_by=$1::uuid";
      } else if (input.action === "DISPUTE") state = "DISPUTED";
      else
        throw new AppError(
          409,
          "TRANSITION_INVALID",
          "Bill action is not allowed or violates segregation",
        );
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.vendor_bills SET state=$2${extra},version=version+1 WHERE tenant_id=$3::uuid AND id=$4::uuid RETURNING *`,
          actor.userId,
          state,
          tenant,
          billId,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        `vendor_bill.${input.action.toLowerCase()}`,
        "vendor_bill",
        billId,
        correlationId,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }

  async createPaymentBatch(
    actor: SessionActor,
    input: {
      batchNo: string;
      bankVersionId: string;
      allocations: Array<{ vendorBillId: string; amountMinor: string }>;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "finance.admin", "CREATE");
      const bank = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT id,vendor_id,version,account_last4,ifsc FROM app.vendor_bank_versions WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='VERIFIED'`,
          tenant,
          input.bankVersionId,
        )
      )[0];
      if (!bank)
        throw new AppError(
          409,
          "VERIFIED_BANK_REQUIRED",
          "A verified bank version is required",
        );
      await this.resourceAccess(
        tx,
        actor,
        "finance.admin",
        "CREATE",
        "vendors",
        String(bank.vendor_id),
      );
      let total = 0n;
      for (const item of input.allocations) {
        await this.resourceAccess(
          tx,
          actor,
          "finance.admin",
          "CREATE",
          "vendor-bills",
          item.vendorBillId,
        );
        const bill = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT payable_minor-coalesce((SELECT sum(amount_minor) FROM app.payment_allocations p WHERE p.tenant_id=b.tenant_id AND p.vendor_bill_id=b.id),0) balance FROM app.vendor_bills b WHERE b.tenant_id=$1::uuid AND b.id=$2::uuid AND b.vendor_id=$3::uuid AND b.state IN ('APPROVED','PART_PAID')`,
            tenant,
            item.vendorBillId,
            bank.vendor_id,
          )
        )[0];
        if (
          !bill ||
          this.exactMinor(item.amountMinor) > BigInt(String(bill.balance))
        )
          throw new AppError(
            409,
            "PAYMENT_EXCEEDS_BALANCE",
            "Payment allocation exceeds an approved bill balance",
          );
        total += this.exactMinor(item.amountMinor);
      }
      const batch = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.payment_batches(tenant_id,batch_no,bank_version_id,total_minor,maker_id) VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid) RETURNING *`,
          tenant,
          input.batchNo,
          input.bankVersionId,
          total.toString(),
          actor.userId,
        )
      )[0]!;
      for (const item of input.allocations)
        await tx.$executeRawUnsafe(
          `INSERT INTO app.payment_allocations(tenant_id,payment_batch_id,vendor_bill_id,amount_minor) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,
          tenant,
          batch.id,
          item.vendorBillId,
          item.amountMinor,
        );
      await this.audit(
        tx,
        actor,
        "payment_batch.created",
        "payment_batch",
        String(batch.id),
        correlationId,
        undefined,
        { ...batch, bankSnapshot: bank },
      );
      return { ...batch, bankSnapshot: bank };
    });
  }

  async transitionPaymentBatch(
    actor: SessionActor,
    batchId: string,
    input: {
      action: "APPROVE" | "SUBMIT" | "MARK_PAID" | "FAIL" | "REVERSE";
      expectedVersion: number;
      reason?: string;
      utr?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    const states: Record<string, [string, string]> = {
      APPROVE: ["DRAFT", "APPROVED"],
      SUBMIT: ["APPROVED", "SUBMITTED"],
      MARK_PAID: ["SUBMITTED", "PAID"],
      FAIL: ["SUBMITTED", "FAILED"],
      REVERSE: ["PAID", "REVERSED"],
    };
    return this.safeTenant(tenant, async (tx) => {
      await this.paymentBatchAccess(tx, actor, batchId, "APPROVE");
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.payment_batches WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          batchId,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(409, "VERSION_CONFLICT", "Payment batch changed");
      const [from, to] = states[input.action]!;
      if (
        before.state !== from ||
        (input.action === "APPROVE" && before.maker_id === actor.userId)
      )
        throw new AppError(
          409,
          "TRANSITION_INVALID",
          "Payment action is not allowed or violates segregation",
        );
      if (["FAIL", "REVERSE"].includes(input.action) && !input.reason)
        throw new AppError(400, "REASON_REQUIRED", "A reason is required");
      if (input.action === "MARK_PAID" && !input.utr)
        throw new AppError(400, "UTR_REQUIRED", "UTR is required");
      const after = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.payment_batches SET state=$1,checker_id=CASE WHEN $1='APPROVED' THEN $2::uuid ELSE checker_id END,utr=coalesce($3,utr),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid RETURNING *`,
          to,
          actor.userId,
          input.utr ?? null,
          tenant,
          batchId,
        )
      )[0]!;
      if (to === "PAID")
        await tx.$executeRawUnsafe(
          `UPDATE app.vendor_bills b SET state=CASE WHEN paid.total>=b.payable_minor THEN 'PAID' ELSE 'PART_PAID' END,version=b.version+1 FROM (SELECT vendor_bill_id,sum(amount_minor) total FROM app.payment_allocations WHERE tenant_id=$1::uuid AND payment_batch_id=$2::uuid GROUP BY vendor_bill_id) paid WHERE b.tenant_id=$1::uuid AND b.id=paid.vendor_bill_id`,
          tenant,
          batchId,
        );
      if (to === "REVERSED")
        await tx.$executeRawUnsafe(
          `INSERT INTO app.payment_allocations(tenant_id,payment_batch_id,vendor_bill_id,amount_minor,reversal_of) SELECT tenant_id,payment_batch_id,vendor_bill_id,-amount_minor,id FROM app.payment_allocations WHERE tenant_id=$1::uuid AND payment_batch_id=$2::uuid AND reversal_of IS NULL`,
          tenant,
          batchId,
        );
      await this.audit(
        tx,
        actor,
        `payment_batch.${input.action.toLowerCase()}`,
        "payment_batch",
        batchId,
        correlationId,
        before,
        after,
        input.reason,
      );
      return after;
    });
  }

  async ingestGps(
    actor: SessionActor,
    input: {
      deviceId: string;
      tripId: string;
      eventKey: string;
      observedAt: string;
      latitude: number;
      longitude: number;
      speedKph?: number;
      odometerKm?: number;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "operations.admin", "CREATE");
      if (!input.tripId)
        throw new AppError(
          400,
          "TRIP_REQUIRED",
          "A trip is required for scoped GPS ingestion",
        );
      const age = Date.now() - new Date(input.observedAt).getTime();
      const freshness =
        age < -300_000 ? "FUTURE" : age > 900_000 ? "STALE" : "CURRENT";
      if (input.tripId) {
        await this.resourceAccess(
          tx,
          actor,
          "operations.admin",
          "CREATE",
          "trips",
          input.tripId,
        );
        const trip = (
          await tx.$queryRawUnsafe<Row[]>(
            `SELECT t.id,t.tracking_consent_from,t.tracking_consent_to FROM app.trips t JOIN app.vehicles v ON v.tenant_id=t.tenant_id AND v.id=t.assigned_vehicle_id WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND v.gps_device_id=$3`,
            tenant,
            input.tripId,
            input.deviceId,
          )
        )[0];
        if (!trip)
          throw new AppError(
            404,
            "RESOURCE_NOT_FOUND",
            "Trip/device assignment not found",
          );
        const at = new Date(input.observedAt);
        if (
          !trip.tracking_consent_from ||
          !trip.tracking_consent_to ||
          at < new Date(String(trip.tracking_consent_from)) ||
          at >= new Date(String(trip.tracking_consent_to))
        )
          throw new AppError(
            403,
            "TRACKING_NOT_CONSENTED",
            "Tracking is outside the consent window",
          );
      }
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `INSERT INTO app.gps_device_observations(tenant_id,device_id,trip_id,event_key,observed_at,latitude,longitude,speed_kph,odometer_km,payload_hash,freshness_state) VALUES($1::uuid,$2,$3::uuid,$4,$5::timestamptz,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,device_id,event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id,device_id,trip_id,event_key,observed_at,received_at,latitude,longitude,speed_kph,odometer_km,freshness_state`,
          tenant,
          input.deviceId,
          input.tripId ?? null,
          input.eventKey,
          input.observedAt,
          input.latitude,
          input.longitude,
          input.speedKph ?? null,
          input.odometerKm ?? null,
          sha(JSON.stringify(input)),
          freshness,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "gps.observation_ingested",
        "gps_observation",
        String(row.id),
        correlationId,
        undefined,
        { ...row, coordinates: "REDACTED" },
      );
      return row;
    });
  }

  async gpsHealth(actor: SessionActor) {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      return tx.$queryRawUnsafe<Row[]>(
        `SELECT device_id AS "deviceId",max(observed_at) AS "lastObservedAt",CASE WHEN max(observed_at)>now()+interval '5 minutes' THEN 'FUTURE' WHEN max(observed_at)<now()-interval '15 minutes' THEN 'STALE' ELSE 'CURRENT' END freshness,count(*)::int observations
         FROM app.gps_device_observations WHERE tenant_id=$1::uuid AND trip_id IS NOT NULL
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',trip_id)
         GROUP BY device_id ORDER BY max(observed_at)`,
        tenant,
        actor.membershipId,
        actor.userId,
      );
    });
  }

  async accountingReconciliation(actor: SessionActor, state = "") {
    const tenant = this.tenant(actor);
    return this.safeTenant(tenant, async (tx) => {
      await this.access(tx, actor, "finance.read", "READ");
      const rows = await tx.$queryRawUnsafe<Row[]>(
        `SELECT id,document_type,document_id,document_type AS "documentType",document_id AS "documentId",event_key AS "eventKey",external_reference AS "externalReference",state,amount_minor AS "amountMinor",safe_error_code AS "safeErrorCode",created_at AS "createdAt",updated_at AS "updatedAt",version FROM app.accounting_reconciliation_entries WHERE tenant_id=$1::uuid AND ($2='' OR state=$2) ORDER BY created_at DESC`,
        tenant,
        state,
      );
      const visible: Row[] = [];
      for (const row of rows) {
        try {
          await this.accountingEntryAccess(tx, actor, row, "READ");
          const safe = { ...row };
          delete safe.document_type;
          delete safe.document_id;
          visible.push(safe);
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 404) throw error;
        }
      }
      return visible;
    });
  }

  async updateAccounting(
    actor: SessionActor,
    id: string,
    input: {
      action: "MARK_EXPORTED" | "ACKNOWLEDGE" | "FAIL" | "RETRY" | "REVERSE";
      expectedVersion: number;
      externalReference?: string;
      safeErrorCode?: string;
      reason?: string;
    },
    correlationId: string,
  ) {
    const tenant = this.tenant(actor),
      mapping: Record<string, string> = {
        MARK_EXPORTED: "EXPORTED",
        ACKNOWLEDGE: "ACKNOWLEDGED",
        FAIL: "FAILED",
        RETRY: "PENDING",
        REVERSE: "REVERSED",
      };
    return this.safeTenant(tenant, async (tx) => {
      const candidate = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.accounting_reconciliation_entries WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          tenant,
          id,
        )
      )[0];
      if (!candidate)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      await this.accountingEntryAccess(tx, actor, candidate, "UPDATE");
      const before = (
        await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM app.accounting_reconciliation_entries WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          tenant,
          id,
        )
      )[0];
      if (!before)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
      if (Number(before.version) !== input.expectedVersion)
        throw new AppError(409, "VERSION_CONFLICT", "Reconciliation changed");
      const legal: Record<string, string[]> = {
        PENDING: ["EXPORTED", "FAILED"],
        EXPORTED: ["ACKNOWLEDGED", "FAILED"],
        FAILED: ["PENDING"],
        ACKNOWLEDGED: ["REVERSED"],
        REVERSED: [],
      };
      const state = mapping[input.action]!;
      if (!legal[String(before.state)]?.includes(state))
        throw new AppError(
          409,
          "TRANSITION_INVALID",
          "Accounting action is not allowed",
        );
      const row = (
        await tx.$queryRawUnsafe<Row[]>(
          `UPDATE app.accounting_reconciliation_entries SET state=$1,external_reference=coalesce($2,external_reference),safe_error_code=$3,updated_at=now(),version=version+1 WHERE tenant_id=$4::uuid AND id=$5::uuid RETURNING *`,
          state,
          input.externalReference ?? null,
          input.safeErrorCode ?? null,
          tenant,
          id,
        )
      )[0]!;
      await this.audit(
        tx,
        actor,
        "accounting.reconciliation_updated",
        "accounting_reconciliation",
        id,
        correlationId,
        before,
        row,
        input.reason,
      );
      return row;
    });
  }
}
