import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionActor } from "@logistics/auth";
import { toJsonSafe } from "@logistics/domain";
import { withTenant, type Prisma } from "@logistics/db";
import { z } from "zod";
import { AppError, AppService } from "../../app.service.js";
import { CanonicalService } from "../canonical/canonical.service.js";
import { canonicalJson, tenantKeyHash } from "../control/idempotency.js";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
type Action = "READ" | "CREATE" | "UPDATE" | "ADMIN";

const uuid = z.string().uuid();
const filterSchema = z.object({
  search: z.string().trim().max(120).default(""),
  state: z.string().trim().max(40).default(""),
  clientId: uuid.optional(),
  owner: z.enum(["ALL", "MINE", "UNASSIGNED"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const ruleSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    priority: z.number().int().min(1).max(10000).default(100),
    clientId: uuid.nullish(),
    laneId: uuid.nullish(),
    vendorId: uuid.nullish(),
    maxVehicles: z.number().int().positive().max(1000).default(1),
    offerRateMinor: z.string().regex(/^\d+$/).default("0"),
    offerValidMinutes: z.number().int().min(5).max(10080).default(120),
    active: z.boolean().default(true),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

@Injectable()
export class OperationsWorkbenchService {
  constructor(
    @Inject(AppService) private readonly app: AppService,
    @Inject(CanonicalService) private readonly canonical: CanonicalService,
  ) {}

  private tenant(actor: SessionActor) {
    if (!actor.membershipId)
      throw new AppError(
        403,
        "TENANT_CONTEXT_REQUIRED",
        "An active tenant is required",
      );
    return this.app.requireTenant(actor);
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

  private async permit(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
  ) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 1 FROM app.tenant_memberships m
       JOIN app.membership_role_assignments a ON a.tenant_id=m.tenant_id AND a.membership_id=m.id AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
       JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$4
       JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN ($5,'ADMIN')
       WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid AND m.user_id=$3::uuid AND m.status='ACTIVE' LIMIT 1`,
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
      capability,
      action,
    );
    if (!rows.length)
      throw new AppError(403, "FORBIDDEN", "Action is not permitted");
  }

  private async tenantPermit(
    tx: Tx,
    actor: SessionActor,
    capability: string,
    action: Action,
  ) {
    const rows = await tx.$queryRawUnsafe<Array<Row>>(
      `SELECT 1 FROM app.membership_role_assignments a
       JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=$3
       JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN ($4,'ADMIN')
       JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.scope_type='TENANT' AND n.status='ACTIVE'
       WHERE a.tenant_id=$1::uuid AND a.membership_id=$2::uuid AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) LIMIT 1`,
      this.tenant(actor),
      actor.membershipId,
      capability,
      action,
    );
    if (!rows.length)
      throw new AppError(
        403,
        "FORBIDDEN",
        "A tenant-wide operations grant is required",
      );
  }

  private async ruleAccess(
    tx: Tx,
    actor: SessionActor,
    rule: Row,
    action: Action,
  ) {
    const references = [
      ["clients", rule.client_id],
      ["lanes", rule.lane_id],
      ["vendors", rule.vendor_id],
    ] as const;
    const populated = references.filter(([, id]) => Boolean(id));
    if (!populated.length)
      return this.tenantPermit(
        tx,
        actor,
        action === "READ" ? "operations.read" : "operations.admin",
        action,
      );
    for (const [resource, id] of populated)
      await this.resource(tx, actor, resource, String(id), action);
  }

  private async resource(
    tx: Tx,
    actor: SessionActor,
    resource: string,
    id: string,
    action: Action,
  ) {
    const allowed = await tx.$queryRawUnsafe<Array<{ allowed: boolean }>>(
      `SELECT app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid) allowed`,
      this.tenant(actor),
      actor.membershipId,
      actor.userId,
      action === "READ" ? "operations.read" : "operations.admin",
      action,
      resource,
      id,
    );
    if (!allowed[0]?.allowed)
      throw new AppError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  async dashboard(actor: SessionActor) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      const [summary, urgent] = await Promise.all([
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT
           count(*) FILTER (WHERE i.state IN ('OPEN','PARTIALLY_ALLOCATED'))::int AS "openIndents",
           count(*) FILTER (WHERE i.state IN ('OPEN','PARTIALLY_ALLOCATED') AND i.committed_placement_at<now())::int AS "placementBreaches",
           (SELECT count(*)::int FROM app.allocations a WHERE a.tenant_id=$1::uuid AND a.state IN ('OFFERED','ACCEPTED','VEHICLE_ASSIGNED','NTP_RELEASED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id)) AS "activeAllocations",
           (SELECT count(*)::int FROM app.trips t WHERE t.tenant_id=$1::uuid AND t.state NOT IN ('DELIVERED','CANCELLED') AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',t.id)) AS "liveTrips"
           FROM app.indents i WHERE i.tenant_id=$1::uuid AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)`,
          tenantId,
          actor.membershipId,
          actor.userId,
        ),
        tx.$queryRawUnsafe<Array<Row>>(
          `SELECT i.id,i.indent_no AS "indentNo",c.legal_name AS client,cl.name AS location,i.state,i.requested_vehicles AS "requestedVehicles",
           greatest(i.requested_vehicles-coalesce(sum(a.allotted_vehicles) FILTER (WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0),0)::int AS remaining,
           i.committed_placement_at AS "committedPlacementAt",
           floor(extract(epoch FROM (now()-i.committed_placement_at))/3600)::int AS "varianceHours",i.version
           FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
           JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
           LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id
           WHERE i.tenant_id=$1::uuid AND i.state IN ('OPEN','PARTIALLY_ALLOCATED')
           AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)
           GROUP BY i.id,c.legal_name,cl.name ORDER BY i.committed_placement_at LIMIT 12`,
          tenantId,
          actor.membershipId,
          actor.userId,
        ),
      ]);
      return toJsonSafe({ summary: summary[0] ?? {}, urgent });
    });
  }

  async indents(actor: SessionActor, raw: unknown) {
    const input = filterSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT i.id,i.indent_no AS "indentNo",c.legal_name AS client,cl.name AS location,l.code AS lane,i.state,
         i.requested_vehicles AS "requestedVehicles",greatest(i.requested_vehicles-coalesce(sum(a.allotted_vehicles) FILTER (WHERE a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0),0)::int remaining,
         i.pickup_window_start AS "pickupWindowStart",i.committed_placement_at AS "committedPlacementAt",i.owner_membership_id AS "ownerMembershipId",i.version
         FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
         JOIN app.contract_lanes l ON l.tenant_id=i.tenant_id AND l.id=i.lane_id LEFT JOIN app.allocations a ON a.tenant_id=i.tenant_id AND a.indent_id=i.id
         WHERE i.tenant_id=$1::uuid AND ($4='' OR i.state=$4) AND ($5::uuid IS NULL OR i.client_id=$5::uuid)
         AND ($6='ALL' OR ($6='MINE' AND i.owner_membership_id=$2::uuid) OR ($6='UNASSIGNED' AND i.owner_membership_id IS NULL))
         AND ($7='' OR i.indent_no ILIKE $8 OR c.legal_name ILIKE $8 OR cl.name ILIKE $8 OR l.code ILIKE $8)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)
         GROUP BY i.id,c.legal_name,cl.name,l.code ORDER BY i.committed_placement_at LIMIT $9`,
        tenantId,
        actor.membershipId,
        actor.userId,
        input.state,
        input.clientId ?? null,
        input.owner,
        input.search,
        `%${input.search}%`,
        input.limit,
      );
      return toJsonSafe({ items, total: items.length });
    });
  }

  async allocations(actor: SessionActor, raw: unknown) {
    const input = filterSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT a.id,a.indent_id AS "indentId",i.indent_no AS "indentNo",v.legal_name AS vendor,a.state,a.allotted_vehicles AS "allottedVehicles",a.expires_at AS "expiresAt",a.version,
         aa.vehicle_id AS "vehicleId",vh.registration_number AS vehicle,aa.driver_id AS "driverId",d.display_name AS driver,
         EXISTS(SELECT 1 FROM app.trips t WHERE t.tenant_id=a.tenant_id AND t.allocation_id=a.id) AS "hasTrip"
         FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id
         LEFT JOIN app.allocation_assignments aa ON aa.tenant_id=a.tenant_id AND aa.allocation_id=a.id AND aa.assigned_to IS NULL
         LEFT JOIN app.vehicles vh ON vh.tenant_id=aa.tenant_id AND vh.id=aa.vehicle_id LEFT JOIN app.drivers d ON d.tenant_id=aa.tenant_id AND d.id=aa.driver_id
         WHERE a.tenant_id=$1::uuid AND ($4='' OR a.state=$4) AND ($5='' OR i.indent_no ILIKE $6 OR v.legal_name ILIKE $6)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','allocations',a.id)
         ORDER BY CASE a.state WHEN 'OFFERED' THEN 1 WHEN 'ACCEPTED' THEN 2 WHEN 'VEHICLE_ASSIGNED' THEN 3 WHEN 'NTP_RELEASED' THEN 4 ELSE 5 END,a.expires_at LIMIT $7`,
        tenantId,
        actor.membershipId,
        actor.userId,
        input.state,
        input.search,
        `%${input.search}%`,
        input.limit,
      );
      return toJsonSafe({ items, total: items.length });
    });
  }

  async trips(actor: SessionActor, raw: unknown) {
    const input = filterSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT t.id,t.trip_no AS "tripNo",t.lr_no AS "lrNo",i.indent_no AS "indentNo",v.legal_name AS vendor,vh.registration_number AS vehicle,d.display_name AS driver,t.state,t.planned_pickup_at AS "plannedPickupAt",t.planned_delivery_at AS "plannedDeliveryAt",t.version
         FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id
         JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id JOIN app.vehicles vh ON vh.tenant_id=t.tenant_id AND vh.id=t.assigned_vehicle_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id
         WHERE t.tenant_id=$1::uuid AND ($4='' OR t.state=$4) AND ($5='' OR t.trip_no ILIKE $6 OR t.lr_no ILIKE $6 OR i.indent_no ILIKE $6 OR vh.registration_number ILIKE $6)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','trips',t.id)
         ORDER BY CASE WHEN t.state IN ('DELIVERED','CANCELLED') THEN 1 ELSE 0 END,t.planned_delivery_at LIMIT $7`,
        tenantId,
        actor.membershipId,
        actor.userId,
        input.state,
        input.search,
        `%${input.search}%`,
        input.limit,
      );
      return toJsonSafe({ items, total: items.length });
    });
  }

  async eligibleVendors(actor: SessionActor, indentId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      await this.resource(tx, actor, "indents", indentId, "READ");
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT v.id,v.code,v.legal_name AS name,c.authorization_scope_node_id AS "clientScopeId",cl.authorization_scope_node_id AS "locationScopeId",lane_client.authorization_scope_node_id AS "laneScopeId",v.authorization_scope_node_id AS "vendorScopeId",i.lane_id AS "laneId",
         (v.state='ACTIVE' AND scope.vendor_id IS NOT NULL AND coalesce(comp.blocked,false)=false AND coalesce(cap.available_vehicles,0)>0 AND coalesce(cap.available_drivers,0)>0) AS eligible,
         array_remove(ARRAY[CASE WHEN v.state<>'ACTIVE' THEN 'Vendor is not active' END,CASE WHEN scope.vendor_id IS NULL THEN 'No effective service scope' END,CASE WHEN coalesce(comp.blocked,false) THEN 'Compliance requirement is expired or unverified' END,CASE WHEN coalesce(cap.available_vehicles,0)=0 THEN 'No available compliant vehicle' END,CASE WHEN coalesce(cap.available_drivers,0)=0 THEN 'No available licensed driver' END],NULL) AS reasons,
         coalesce(cap.available_vehicles,0)::int AS "availableVehicles",coalesce(cap.available_drivers,0)::int AS "availableDrivers"
         FROM app.vendors v JOIN app.indents i ON i.tenant_id=v.tenant_id AND i.id=$4::uuid
         JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id
         JOIN app.client_locations cl ON cl.tenant_id=i.tenant_id AND cl.id=i.client_location_id
         JOIN app.contract_lanes lane ON lane.tenant_id=i.tenant_id AND lane.id=i.lane_id
         JOIN app.contract_versions cv ON cv.tenant_id=lane.tenant_id AND cv.id=lane.contract_version_id
         JOIN app.contracts ct ON ct.tenant_id=cv.tenant_id AND ct.id=cv.contract_id
         JOIN app.clients lane_client ON lane_client.tenant_id=ct.tenant_id AND lane_client.id=ct.client_id AND lane_client.id=c.id
         LEFT JOIN LATERAL (SELECT s.vendor_id FROM app.vendor_service_scopes s WHERE s.tenant_id=v.tenant_id AND s.vendor_id=v.id AND (s.lane_id IS NULL OR s.lane_id=lane.id) AND (s.organization_node_id IS NULL OR s.organization_node_id=cl.organization_node_id) AND s.effective_from<=now() AND (s.effective_to IS NULL OR s.effective_to>now()) LIMIT 1) scope ON true
         LEFT JOIN LATERAL (SELECT bool_or(c.verification_state<>'VERIFIED' OR (c.valid_to IS NOT NULL AND c.valid_to<current_date)) blocked FROM app.compliance_records c WHERE c.tenant_id=v.tenant_id AND c.subject_type='VENDOR' AND c.subject_id=v.id) comp ON true
         LEFT JOIN LATERAL (SELECT
           (SELECT count(*) FROM app.vehicles vh WHERE vh.tenant_id=v.tenant_id AND vh.vendor_id=v.id AND vh.state='ACTIVE'
             AND NOT EXISTS(SELECT 1 FROM app.compliance_records c WHERE c.tenant_id=vh.tenant_id AND c.subject_type='VEHICLE' AND c.subject_id=vh.id AND (c.verification_state<>'VERIFIED' OR (c.valid_to IS NOT NULL AND c.valid_to<current_date)))
             AND NOT EXISTS(SELECT 1 FROM app.allocation_assignments aa JOIN app.allocations a ON a.tenant_id=aa.tenant_id AND a.id=aa.allocation_id WHERE aa.tenant_id=vh.tenant_id AND aa.vehicle_id=vh.id AND aa.assigned_to IS NULL AND a.state NOT IN ('CANCELLED','REJECTED','EXPIRED'))) available_vehicles,
           (SELECT count(*) FROM app.drivers d WHERE d.tenant_id=v.tenant_id AND d.vendor_id=v.id AND d.state='ACTIVE' AND d.licence_valid_to>=current_date
             AND NOT EXISTS(SELECT 1 FROM app.compliance_records c WHERE c.tenant_id=d.tenant_id AND c.subject_type='DRIVER' AND c.subject_id=d.id AND (c.verification_state<>'VERIFIED' OR (c.valid_to IS NOT NULL AND c.valid_to<current_date)))
             AND NOT EXISTS(SELECT 1 FROM app.allocation_assignments aa JOIN app.allocations a ON a.tenant_id=aa.tenant_id AND a.id=aa.allocation_id WHERE aa.tenant_id=d.tenant_id AND aa.driver_id=d.id AND aa.assigned_to IS NULL AND a.state NOT IN ('CANCELLED','REJECTED','EXPIRED'))) available_drivers) cap ON true
         WHERE v.tenant_id=$1::uuid
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','indents',i.id)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','clients',c.id)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','client-locations',cl.id)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','lanes',lane.id)
         AND app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','vendors',v.id)
         ORDER BY eligible DESC,v.legal_name`,
        tenantId,
        actor.membershipId,
        actor.userId,
        indentId,
      );
      return toJsonSafe({
        items: items.map((item) => {
          const visible = { ...item };
          for (const key of [
            "clientScopeId",
            "locationScopeId",
            "laneScopeId",
            "vendorScopeId",
            "laneId",
          ])
            delete visible[key];
          return visible;
        }),
      });
    });
  }

  createIndent(
    actor: SessionActor,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.create(actor, "indents", input, key, correlationId);
  }
  updateIndent(
    actor: SessionActor,
    id: string,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.transition(
      actor,
      "indents",
      id,
      input,
      key,
      correlationId,
    );
  }
  manualAllocation(
    actor: SessionActor,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.create(
      actor,
      "allocations",
      input,
      key,
      correlationId,
    );
  }
  updateAllocation(
    actor: SessionActor,
    id: string,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.transition(
      actor,
      "allocations",
      id,
      input,
      key,
      correlationId,
    );
  }
  assign(
    actor: SessionActor,
    id: string,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.assignAllocation(
      actor,
      id,
      input,
      key,
      correlationId,
    );
  }
  createTrip(
    actor: SessionActor,
    input: unknown,
    key: string,
    correlationId: string,
  ) {
    return this.canonical.createTrip(actor, input, key, correlationId);
  }

  async tripAction(
    actor: SessionActor,
    id: string,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = z
      .object({
        action: z.enum(["ACCEPT", "START", "LOAD", "TRANSIT", "UNLOAD", "END"]),
        occurredAt: z.string().datetime({ offset: true }),
        receiverName: z.string().trim().min(2).max(120).optional(),
      })
      .strict()
      .parse(raw);
    const allowedState: Record<typeof input.action, string> = {
      ACCEPT: "PLANNED",
      START: "PLANNED",
      LOAD: "AT_ORIGIN",
      TRANSIT: "LOADED",
      UNLOAD: "IN_TRANSIT",
      END: "AT_DESTINATION",
    };
    await withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await this.permit(tx, actor, "operations.admin", "UPDATE");
      await this.resource(tx, actor, "trips", id, "UPDATE");
      const trip = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT state FROM app.trips WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          this.tenant(actor),
          id,
        )
      )[0];
      if (!trip || trip.state !== allowedState[input.action])
        throw new AppError(
          409,
          "TRIP_ACTION_CONFLICT",
          `Action ${input.action} requires ${allowedState[input.action]} state`,
        );
    });
    const map = {
      ACCEPT: "CHECKPOINT",
      START: "AT_ORIGIN",
      LOAD: "LOADED",
      TRANSIT: "DEPARTED",
      UNLOAD: "AT_DESTINATION",
      END: "DELIVERED",
    } as const;
    const event = (await this.canonical.appendTripEvent(
      actor,
      id,
      {
        eventKey: `${input.action.toLowerCase()}:${key}`,
        eventType: map[input.action],
        source: "WEB",
        deviceAt: input.occurredAt,
        evidence: {
          action: input.action,
          ...(input.receiverName ? { receiverName: input.receiverName } : {}),
        },
      },
      key,
      correlationId,
    )) as Row;
    await withTenant(this.app.db, this.tenant(actor), async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','trip',$2::uuid,$3,1,$4::jsonb,$5) ON CONFLICT(deduplication_key) DO NOTHING`,
        this.tenant(actor),
        id,
        `trip.${input.action.toLowerCase()}.v1`,
        JSON.stringify(toJsonSafe(event)),
        `${this.tenant(actor)}:trip:${id}:action:${String(event.id)}`,
      );
    });
    return event;
  }

  async rules(actor: SessionActor) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      const items = await tx.$queryRawUnsafe<Array<Row>>(
        `SELECT r.id,r.name,r.priority,r.client_id AS "clientId",c.legal_name AS client,r.lane_id AS "laneId",l.code AS lane,r.vendor_id AS "vendorId",v.legal_name AS vendor,r.max_vehicles AS "maxVehicles",
         CASE WHEN (r.client_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.commercial_rate.read','READ','clients',r.client_id))
           AND (r.lane_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.commercial_rate.read','READ','lanes',r.lane_id))
           AND (r.vendor_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'sensitive.commercial_rate.read','READ','vendors',r.vendor_id))
           AND (r.client_id IS NOT NULL OR r.lane_id IS NOT NULL OR r.vendor_id IS NOT NULL)) OR
           (r.client_id IS NULL AND r.lane_id IS NULL AND r.vendor_id IS NULL AND EXISTS(
             SELECT 1 FROM app.membership_role_assignments sma JOIN app.role_capabilities src ON src.tenant_id=sma.tenant_id AND src.role_id=sma.role_id AND src.capability_code='sensitive.commercial_rate.read'
             JOIN app.scope_grants ssg ON ssg.tenant_id=sma.tenant_id AND ssg.assignment_id=sma.id AND ssg.status='ACTIVE' AND ssg.action IN ('READ','ADMIN')
             JOIN app.authorization_scope_nodes ssn ON ssn.tenant_id=ssg.tenant_id AND ssn.id=ssg.scope_node_id AND ssn.scope_type='TENANT' AND ssn.status='ACTIVE'
             WHERE sma.tenant_id=$1::uuid AND sma.membership_id=$2::uuid AND sma.status='ACTIVE' AND sma.effective_from<=now() AND (sma.effective_to IS NULL OR sma.effective_to>now()) AND ssg.effective_from<=now() AND (ssg.effective_to IS NULL OR ssg.effective_to>now())))
           THEN r.offer_rate_minor::text ELSE NULL END AS "offerRateMinor",
         r.offer_valid_minutes AS "offerValidMinutes",r.active,r.version
         FROM app.auto_allocation_rules r LEFT JOIN app.clients c ON c.tenant_id=r.tenant_id AND c.id=r.client_id LEFT JOIN app.contract_lanes l ON l.tenant_id=r.tenant_id AND l.id=r.lane_id LEFT JOIN app.vendors v ON v.tenant_id=r.tenant_id AND v.id=r.vendor_id
         WHERE r.tenant_id=$1::uuid AND (
           ((r.client_id IS NOT NULL OR r.lane_id IS NOT NULL OR r.vendor_id IS NOT NULL)
             AND (r.client_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','clients',r.client_id))
             AND (r.lane_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','lanes',r.lane_id))
             AND (r.vendor_id IS NULL OR app.domain_resource_authorized($1::uuid,$2::uuid,$3::uuid,'operations.read','READ','vendors',r.vendor_id)))
           OR (r.client_id IS NULL AND r.lane_id IS NULL AND r.vendor_id IS NULL AND EXISTS(
             SELECT 1 FROM app.membership_role_assignments ma JOIN app.role_capabilities rc ON rc.tenant_id=ma.tenant_id AND rc.role_id=ma.role_id AND rc.capability_code='operations.read'
             JOIN app.scope_grants sg ON sg.tenant_id=ma.tenant_id AND sg.assignment_id=ma.id AND sg.status='ACTIVE' AND sg.action IN ('READ','ADMIN')
             JOIN app.authorization_scope_nodes sn ON sn.tenant_id=sg.tenant_id AND sn.id=sg.scope_node_id AND sn.scope_type='TENANT' AND sn.status='ACTIVE'
             WHERE ma.tenant_id=$1::uuid AND ma.membership_id=$2::uuid AND ma.status='ACTIVE' AND ma.effective_from<=now() AND (ma.effective_to IS NULL OR ma.effective_to>now()) AND sg.effective_from<=now() AND (sg.effective_to IS NULL OR sg.effective_to>now())))
         ) ORDER BY r.priority,r.name`,
        tenantId,
        actor.membershipId,
        actor.userId,
      );
      return toJsonSafe({ items });
    });
  }

  async saveRule(
    actor: SessionActor,
    id: string | null,
    raw: unknown,
    key: string,
    correlationId: string,
  ) {
    const input = ruleSchema.parse(raw);
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(
        tx,
        actor,
        "operations.admin",
        id ? "UPDATE" : "CREATE",
      );
      return this.idempotent(
        tx,
        actor,
        `operations.auto-allocation-rules.${id ?? "create"}`,
        key,
        { route: id ?? "create", body: input },
        async () => {
          for (const [resource, resourceId] of [
            ["clients", input.clientId],
            ["lanes", input.laneId],
            ["vendors", input.vendorId],
          ] as const)
            if (resourceId)
              await this.resource(
                tx,
                actor,
                resource,
                resourceId,
                id ? "UPDATE" : "CREATE",
              );
          const before = id
            ? (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `SELECT * FROM app.auto_allocation_rules WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
                  tenantId,
                  id,
                )
              )[0]
            : undefined;
          if (
            id &&
            (!before || Number(before.version) !== input.expectedVersion)
          )
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Rule changed; reload and retry",
            );
          if (before) await this.ruleAccess(tx, actor, before, "UPDATE");
          if (!input.clientId && !input.laneId && !input.vendorId)
            await this.tenantPermit(
              tx,
              actor,
              "operations.admin",
              id ? "UPDATE" : "CREATE",
            );
          const row = id
            ? (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `UPDATE app.auto_allocation_rules SET name=$3,priority=$4,client_id=$5::uuid,lane_id=$6::uuid,vendor_id=$7::uuid,max_vehicles=$8,offer_rate_minor=$9::bigint,offer_valid_minutes=$10,active=$11,updated_by=$12::uuid,updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING *`,
                  tenantId,
                  id,
                  input.name,
                  input.priority,
                  input.clientId ?? null,
                  input.laneId ?? null,
                  input.vendorId ?? null,
                  input.maxVehicles,
                  input.offerRateMinor,
                  input.offerValidMinutes,
                  input.active,
                  actor.userId,
                )
              )[0]!
            : (
                await tx.$queryRawUnsafe<Array<Row>>(
                  `INSERT INTO app.auto_allocation_rules(tenant_id,name,priority,client_id,lane_id,vendor_id,max_vehicles,offer_rate_minor,offer_valid_minutes,active,created_by,updated_by) VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint,$9,$10,$11::uuid,$11::uuid) RETURNING *`,
                  tenantId,
                  input.name,
                  input.priority,
                  input.clientId ?? null,
                  input.laneId ?? null,
                  input.vendorId ?? null,
                  input.maxVehicles,
                  input.offerRateMinor,
                  input.offerValidMinutes,
                  input.active,
                  actor.userId,
                )
              )[0]!;
          await tx.$executeRawUnsafe(
            `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json) VALUES($1::uuid,$2::uuid,$3,'auto-allocation-rule',$4::uuid,$5,$6::jsonb,$7::jsonb)`,
            tenantId,
            actor.userId,
            id
              ? "auto-allocation-rule.updated"
              : "auto-allocation-rule.created",
            row.id,
            correlationId,
            before ? JSON.stringify(toJsonSafe(before)) : null,
            JSON.stringify(toJsonSafe(row)),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','auto-allocation-rule',$2::uuid,'auto-allocation-rule.changed.v1',$3,$4::jsonb,$5) ON CONFLICT(deduplication_key) DO NOTHING`,
            tenantId,
            row.id,
            Number(row.version),
            JSON.stringify(toJsonSafe(row)),
            `${tenantId}:auto-allocation-rule:${String(row.id)}:v${Number(row.version)}`,
          );
          return toJsonSafe(row);
        },
      );
    });
  }

  async previewRule(actor: SessionActor, ruleId: string, indentId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.read", "READ");
      await this.resource(tx, actor, "indents", indentId, "READ");
      const match = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT r.*,i.client_id AS "indentClientId",i.lane_id AS "indentLaneId",greatest(i.requested_vehicles-coalesce((SELECT sum(a.allotted_vehicles) FROM app.allocations a WHERE a.tenant_id=i.tenant_id AND a.indent_id=i.id AND a.state NOT IN ('REJECTED','EXPIRED','CANCELLED')),0),0)::int remaining
         FROM app.auto_allocation_rules r JOIN app.indents i ON i.tenant_id=r.tenant_id AND i.id=$3::uuid
         WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
           AND (r.client_id IS NULL OR app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'operations.read','READ','clients',r.client_id))
           AND (r.lane_id IS NULL OR app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'operations.read','READ','lanes',r.lane_id))
           AND (r.vendor_id IS NULL OR app.domain_resource_authorized($1::uuid,$4::uuid,$5::uuid,'operations.read','READ','vendors',r.vendor_id))`,
          tenantId,
          ruleId,
          indentId,
          actor.membershipId,
          actor.userId,
        )
      )[0];
      if (!match)
        throw new AppError(
          404,
          "RESOURCE_NOT_FOUND",
          "Rule or indent not found",
        );
      await this.ruleAccess(tx, actor, match, "READ");
      const reasons = [
        !match.active && "Rule is inactive",
        match.client_id &&
          match.client_id !== match.indentClientId &&
          "Client does not match",
        match.lane_id &&
          match.lane_id !== match.indentLaneId &&
          "Lane does not match",
        Number(match.remaining) < 1 && "No remaining demand",
      ].filter(Boolean);
      const eligible = (await this.eligibleVendors(actor, indentId)) as {
        items: Array<Row>;
      };
      const vendors = eligible.items.filter(
        (vendor) =>
          vendor.eligible &&
          (!match.vendor_id || vendor.id === match.vendor_id),
      );
      return toJsonSafe({
        matches: reasons.length === 0 && vendors.length > 0,
        reasons: vendors.length
          ? reasons
          : [...reasons, "No eligible vendor matches"],
        remaining: Number(match.remaining),
        proposedVendor: vendors[0] ?? null,
        rule: {
          id: match.id,
          name: match.name,
          priority: match.priority,
          maxVehicles: match.max_vehicles,
          offerValidMinutes: match.offer_valid_minutes,
          active: match.active,
        },
      });
    });
  }

  private async executionRule(actor: SessionActor, ruleId: string) {
    const tenantId = this.tenant(actor);
    return withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.admin", "UPDATE");
      const rule = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `SELECT id,client_id,lane_id,vendor_id,max_vehicles,offer_rate_minor::text,offer_valid_minutes
           FROM app.auto_allocation_rules WHERE tenant_id=$1::uuid AND id=$2::uuid AND active`,
          tenantId,
          ruleId,
        )
      )[0];
      if (!rule)
        throw new AppError(404, "RESOURCE_NOT_FOUND", "Active rule not found");
      await this.ruleAccess(tx, actor, rule, "UPDATE");
      return rule;
    });
  }

  async executeRule(
    actor: SessionActor,
    ruleId: string,
    indentId: string,
    key: string,
    correlationId: string,
  ) {
    if (!key.trim())
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required",
      );
    const tenantId = this.tenant(actor);
    const operation = `operations.auto-allocation-rules.execute:${ruleId}:${indentId}`;
    const request = {
      route: `/auto-allocation-rules/${ruleId}/execute/${indentId}`,
      body: {},
    };
    const requestHash = createHash("sha256")
        .update(canonicalJson(request))
        .digest("hex"),
      keyHash = tenantKeyHash(tenantId, key);
    await withTenant(this.app.db, tenantId, async (tx) => {
      await this.permit(tx, actor, "operations.admin", "UPDATE");
      await this.resource(tx, actor, "indents", indentId, "UPDATE");
    });
    const envelope: { offeredAt: string; result?: Row } = await withTenant(
      this.app.db,
      tenantId,
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          `${tenantId}:${actor.userId}:${operation}:${keyHash}`,
        );
        const existing = (
          await tx.$queryRawUnsafe<Array<Row>>(
            `SELECT request_hash AS "requestHash",response_json AS response,state FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation=$3 AND key_hash=$4`,
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
          return existing.response as { offeredAt: string; result?: Row };
        }
        const offeredAt = new Date().toISOString(),
          response = { offeredAt };
        await tx.$executeRawUnsafe(
          `INSERT INTO app.idempotency_records(scope,tenant_id,actor_id,operation,key_hash,request_hash,response_json,state) VALUES('TENANT',$1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,'PENDING')`,
          tenantId,
          actor.userId,
          operation,
          keyHash,
          requestHash,
          JSON.stringify(response),
        );
        return response;
      },
    );
    if (envelope.result) return { ...envelope.result, replayed: true };
    const executionRule = await this.executionRule(actor, ruleId);
    const preview = (await this.previewRule(actor, ruleId, indentId)) as {
      matches: boolean;
      remaining: number;
      proposedVendor: Row | null;
    };
    if (!preview.matches || !preview.proposedVendor)
      throw new AppError(
        409,
        "AUTO_ALLOCATION_NO_MATCH",
        "Rule has no eligible allocation; preview the reasons",
      );
    const allottedVehicles = Math.min(
      preview.remaining,
      Number(executionRule.max_vehicles),
    );
    const offeredAt = new Date(envelope.offeredAt);
    const allocation = (await this.canonical.create(
      actor,
      "allocations",
      {
        indentId,
        vendorId: String(preview.proposedVendor.id),
        allottedVehicles,
        offeredRateMinor: String(executionRule.offer_rate_minor),
        offerChannel: "PORTAL",
        offeredAt: offeredAt.toISOString(),
        expiresAt: new Date(
          offeredAt.getTime() +
            Number(executionRule.offer_valid_minutes) * 60000,
        ).toISOString(),
      },
      `${key}:auto-rule:${ruleId}:indent:${indentId}`,
      correlationId,
    )) as Row;
    await withTenant(this.app.db, tenantId, async (tx) => {
      const execution = (
        await tx.$queryRawUnsafe<Array<Row>>(
          `INSERT INTO app.auto_allocation_executions(tenant_id,rule_id,indent_id,allocation_id,decision,evidence,executed_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ALLOCATED',$5::jsonb,$6::uuid) ON CONFLICT(tenant_id,rule_id,indent_id,allocation_id) WHERE allocation_id IS NOT NULL DO NOTHING RETURNING *`,
          tenantId,
          ruleId,
          indentId,
          allocation.id,
          JSON.stringify(
            toJsonSafe({
              vendorId: preview.proposedVendor?.id,
              allottedVehicles,
            }),
          ),
          actor.userId,
        )
      )[0];
      if (!execution) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO audit.audit_events(tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json) VALUES($1::uuid,$2::uuid,'auto-allocation.executed','auto-allocation-execution',$3::uuid,$4,$5::jsonb)`,
        tenantId,
        actor.userId,
        execution.id,
        correlationId,
        JSON.stringify(toJsonSafe(execution)),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.outbox_events(tenant_id,scope,aggregate_type,aggregate_id,event_type,event_version,payload,deduplication_key)
         VALUES($1::uuid,'TENANT','auto-allocation-execution',$2::uuid,'auto-allocation.executed.v1',1,$3::jsonb,$4) ON CONFLICT(deduplication_key) DO NOTHING`,
        tenantId,
        execution.id,
        JSON.stringify(toJsonSafe(execution)),
        `${tenantId}:auto-allocation-execution:${String(execution.id)}:v1`,
      );
    });
    const result = { allocation, preview: toJsonSafe(preview) };
    await withTenant(this.app.db, tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.idempotency_records SET response_json=$1::jsonb,state='COMPLETE',resource_id=$2::uuid,updated_at=now() WHERE tenant_id=$3::uuid AND actor_id=$4::uuid AND operation=$5 AND key_hash=$6`,
        JSON.stringify({
          offeredAt: envelope.offeredAt,
          result: toJsonSafe(result),
        }),
        allocation.id,
        tenantId,
        actor.userId,
        operation,
        keyHash,
      ),
    );
    return result;
  }
}
