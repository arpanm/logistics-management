import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { tenantCreateSchema } from "@logistics/domain";
import { withTenant } from "@logistics/db";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppService } from "../src/app.service.js";
import { AppModule } from "../src/app.module.js";
import { AdvancedDomainService } from "../src/modules/canonical/advanced.service.js";
import { Mst01Service } from "../src/modules/canonical/mst01.service.js";

const tenantInput = (code: string, email: string) =>
  tenantCreateSchema.parse({
    name: `${code} Logistics`,
    code,
    legalName: `${code} Logistics Limited`,
    taxIdentifier: `TAX-${code}`,
    address: {
      line1: "1 Main Road",
      line2: "",
      postalCode: "700001",
      postalLocalityId: "70000100-0000-4000-8000-000000000001",
      country: "IN",
    },
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    currency: "INR",
    fiscalYearStart: { month: 4, day: 1 },
    legalEntity: { name: `${code} Entity`, code },
    support: { name: "Support", email: `support-${email}` },
    owner: { name: "Owner", email },
    branding: {
      shortName: code,
      primaryColor: "#16324F",
      accentColor: "#D97706",
    },
    active: true,
  });

describe.sequential("MST-01 operable organization and employee masters", () => {
  const app = new AppService(),
    service = new Mst01Service(app),
    advanced = new AdvancedDomainService(app);
  let owner: Awaited<ReturnType<AppService["session"]>>,
    otherOwner: Awaited<ReturnType<AppService["session"]>>;
  let ownerToken = "",
    ownerCsrf = "",
    http: INestApplication;
  let legalEntity = "",
    region = "",
    branch = "",
    employee = "";
  beforeAll(async () => {
    const login = await app.login(
      process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test",
      process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234",
      undefined,
      "mst01-login",
    );
    const platform = await app.session(login.sessionToken);
    const a = await app.provision(
      platform,
      tenantInput("MST01-A", "mst01-a@test.local"),
      "mst01-provision-a",
      "mst01-provision-a",
    );
    const acceptedA = await app.acceptInvitation(
      String(a.invitationUrl).split("token=")[1]!,
      "Owner A",
      "OwnerPassword!234",
      "mst01-accept-a",
    );
    ownerToken = acceptedA.sessionToken;
    ownerCsrf = acceptedA.csrfToken;
    owner = await app.session(acceptedA.sessionToken);
    const b = await app.provision(
      platform,
      tenantInput("MST01-B", "mst01-b@test.local"),
      "mst01-provision-b",
      "mst01-provision-b",
    );
    const acceptedB = await app.acceptInvitation(
      String(b.invitationUrl).split("token=")[1]!,
      "Owner B",
      "OwnerPassword!234",
      "mst01-accept-b",
    );
    otherOwner = await app.session(acceptedB.sessionToken);
    http = await NestFactory.create(AppModule, { logger: false });
    http.setGlobalPrefix("api/v1");
    http.use(cookieParser());
    http.use(
      (
        req: {
          headers: Record<string, string | undefined>;
          correlationId?: string;
        },
        res: { setHeader: (key: string, value: string) => void },
        next: () => void,
      ) => {
        const correlationId =
          req.headers["x-correlation-id"] ?? crypto.randomUUID();
        req.correlationId = correlationId;
        res.setHeader("X-Correlation-Id", correlationId);
        next();
      },
    );
    await http.init();
    legalEntity = String(
      (
        await service.createOrganization(
          owner,
          {
            code: "LE-A",
            name: "Legal Entity A",
            nodeType: "LEGAL_ENTITY",
            parentId: null,
            timezone: "Asia/Kolkata",
            activeFrom: "2026-08-25",
          },
          "mst01-legal",
          "mst01-legal",
        )
      ).id,
    );
  });
  afterAll(async () => {
    await http.close();
    await app.onModuleDestroy();
  });

  it("MST01-I-001/007 creates a valid hierarchy and immutable PIN snapshot", async () => {
    const createdRegion = await service.createOrganization(
      owner,
      {
        code: "NORTH",
        name: "North",
        nodeType: "REGION",
        parentId: legalEntity,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-region",
      "mst01-region",
    );
    region = String(createdRegion.id);
    const createdBranch = await service.createOrganization(
      owner,
      {
        code: "BLR",
        name: "Bengaluru",
        nodeType: "BRANCH",
        parentId: region,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
        address: {
          line1: "1 Office Road",
          line2: null,
          country: "IN",
          postalCode: "560043",
          postalLocalityId: "56004300-0000-4000-8000-000000000001",
        },
        geofence: {
          mode: "POINT_RADIUS",
          point: { lat: 13.019, lng: 77.65 },
          radiusKm: 5,
        },
      },
      "mst01-branch",
      "mst01-branch",
    );
    branch = String(createdBranch.id);
    const detail = (await service.organizationView(owner, branch)) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({
      nodeType: "BRANCH",
      address: {
        postalCode: "560043",
        locality: "Banaswadi",
        city: "Bengaluru",
        region: "Karnataka",
        provenance: "DIRECTORY",
      },
    });
    const organizationAudit = await withTenant(
      app.db,
      owner.activeTenantId!,
      (tx) =>
        tx.$queryRawUnsafe<Array<{ after_json: Record<string, unknown> }>>(
          `SELECT after_json FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_id=$2::uuid AND action='organization.created'`,
          owner.activeTenantId,
          branch,
        ),
    );
    expect(organizationAudit[0]!.after_json).toMatchObject({
      geofence: { mode: "POINT_RADIUS", radiusKm: 5 },
      address: { postal_code: "560043", city: "Bengaluru" },
    });
    const scopes = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT n.id,n.authorization_scope_node_id AS "scopeId",s.canonical_resource_id AS "canonicalId"
         FROM app.organization_nodes n JOIN app.authorization_scope_nodes s ON s.tenant_id=n.tenant_id AND s.id=n.authorization_scope_node_id
         WHERE n.tenant_id=$1::uuid AND n.id=ANY($2::uuid[])`,
        owner.activeTenantId,
        [legalEntity, region, branch],
      ),
    );
    expect(new Set(scopes.map((row) => String(row.scopeId))).size).toBe(3);
    expect(
      scopes.every((row) => String(row.id) === String(row.canonicalId)),
    ).toBe(true);
    await expect(
      service.createOrganization(
        owner,
        {
          code: "SCOPE-BAD",
          name: "Scope injection",
          nodeType: "REGION",
          parentId: legalEntity,
          authorizationScopeNodeId: String(scopes[0]!.scopeId),
          timezone: "Asia/Kolkata",
          activeFrom: "2026-08-25",
        },
        "mst01-scope-injection",
        "mst01-scope-injection",
      ),
    ).rejects.toMatchObject({ code: "SCOPE_SERVER_DERIVED" });
    await expect(
      service.createOrganization(
        owner,
        {
          code: "BAD",
          name: "Bad branch",
          nodeType: "BRANCH",
          parentId: legalEntity,
          timezone: "Asia/Kolkata",
          activeFrom: "2026-08-25",
          address: {
            line1: "Office",
            country: "IN",
            postalCode: "560043",
            postalLocalityId: "56004300-0000-4000-8000-000000000001",
          },
        },
        "mst01-bad-parent",
        "mst01-bad-parent",
      ),
    ).rejects.toMatchObject({ code: "PARENT_TYPE_INVALID" });
  });

  it("MST01-I-002/C-002 creates employee references idempotently", async () => {
    const input = {
      employeeCode: "EMP-01",
      displayName: "Employee One",
      designation: "Traffic Manager",
      email: "employee@example.test",
      mobile: "+91 99999-99999",
      homeNodeId: branch,
      regionIds: [region],
      activeFrom: "2026-08-25",
    };
    const first = await service.createEmployee(
      owner,
      input,
      "mst01-employee",
      "mst01-employee",
    );
    const replay = await service.createEmployee(
      owner,
      input,
      "mst01-employee",
      "mst01-employee-retry",
    );
    employee = String(first.id);
    expect(replay).toMatchObject({ id: employee, replayed: true });
    const detail = (await service.employeeView(owner, employee)) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({
      designation: "Traffic Manager",
      homeNodeName: "Bengaluru",
      regions: [{ id: region, name: "North" }],
    });
    const patch = {
      expectedVersion: Number(detail.version),
      designation: "Senior Traffic Manager",
      reason: "Promote employee",
    };
    const updated = await service.updateEmployee(
      owner,
      employee,
      patch,
      "mst01-employee-patch",
      "mst01-employee-patch",
    );
    const updateReplay = await service.updateEmployee(
      owner,
      employee,
      patch,
      "mst01-employee-patch",
      "mst01-employee-patch-retry",
    );
    expect(updateReplay).toMatchObject({
      id: updated.id,
      version: updated.version,
      replayed: true,
    });
    await expect(
      service.updateEmployee(
        owner,
        employee,
        { ...patch, designation: "Different" },
        "mst01-employee-patch",
        "mst01-employee-patch-conflict",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const audit = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ after_json: Record<string, unknown> }>>(
        `SELECT after_json FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_id=$2::uuid AND action='employee.created'`,
        owner.activeTenantId,
        employee,
      ),
    );
    expect(audit[0]!.after_json).toMatchObject({ regionIds: [region] });
    const updateAudits = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int count FROM audit.audit_events WHERE tenant_id=$1::uuid AND target_id=$2::uuid AND action='employee.updated'`,
        owner.activeTenantId,
        employee,
      ),
    );
    expect(updateAudits[0]!.count).toBe(1);
  });

  it("MST01-C-002 makes hierarchy moves exact-once", async () => {
    const hub = await service.createOrganization(
      owner,
      {
        code: "MOVE-HUB",
        name: "Move Hub",
        nodeType: "HUB",
        parentId: branch,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
        address: {
          line1: "Move hub",
          country: "IN",
          postalCode: "560043",
          postalLocalityId: "56004300-0000-4000-8000-000000000001",
        },
      },
      "mst01-move-hub",
      "mst01-move-hub",
    );
    const team = await service.createOrganization(
      owner,
      {
        code: "MOVE-TEAM",
        name: "Move Team",
        nodeType: "TEAM",
        parentId: branch,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-move-team",
      "mst01-move-team",
    );
    const input = {
      parentId: String(hub.id),
      expectedVersion: Number(team.version),
      reason: "Place team under operating hub",
    };
    const moved = await advanced.moveOrganization(
      owner,
      String(team.id),
      input.parentId,
      input.expectedVersion,
      input.reason,
      "mst01-move",
      "mst01-move-key",
    );
    const replay = await advanced.moveOrganization(
      owner,
      String(team.id),
      input.parentId,
      input.expectedVersion,
      input.reason,
      "mst01-move-retry",
      "mst01-move-key",
    );
    expect(replay).toMatchObject({
      id: moved.id,
      version: moved.version,
      replayed: true,
    });
    await expect(
      advanced.moveOrganization(
        owner,
        String(team.id),
        branch,
        input.expectedVersion,
        input.reason,
        "mst01-move-conflict",
        "mst01-move-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM app.organization_addresses WHERE tenant_id=$1::uuid AND organization_node_id IN ($2::uuid,$3::uuid)`,
        owner.activeTenantId,
        hub.id,
        team.id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM app.organization_closure WHERE tenant_id=$1::uuid AND (ancestor_id IN ($2::uuid,$3::uuid) OR descendant_id IN ($2::uuid,$3::uuid))`,
        owner.activeTenantId,
        hub.id,
        team.id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id IN ($2::uuid,$3::uuid)`,
        owner.activeTenantId,
        hub.id,
        team.id,
      );
    });
  });

  it("MST01-I-003/A-001 enforces version, cycles and tenant boundaries", async () => {
    const detail = (await service.organizationView(owner, branch)) as {
      version: number;
    };
    await expect(
      service.updateOrganization(
        owner,
        branch,
        {
          expectedVersion: detail.version + 1,
          name: "Stale",
          reason: "stale update",
        },
        "mst01-stale-key",
        "mst01-stale",
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      service.updateOrganization(
        owner,
        legalEntity,
        { expectedVersion: 1, parentId: branch, reason: "cycle attempt" },
        "mst01-cycle-key",
        "mst01-cycle",
      ),
    ).rejects.toMatchObject({ code: "PARENT_INVALID" });
    const regionDetail = (await service.organizationView(owner, region)) as {
      version: number;
    };
    await expect(
      service.updateOrganization(
        owner,
        region,
        {
          expectedVersion: regionDetail.version,
          parentId: null,
          reason: "invalid root",
        },
        "mst01-root-invariant-key",
        "mst01-root-invariant",
      ),
    ).rejects.toMatchObject({ code: "PARENT_INVALID" });
    await expect(
      service.organizationView(otherOwner, branch),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      service.employeeView(otherOwner, employee),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    const patch = {
      expectedVersion: regionDetail.version,
      name: "North Operations",
      reason: "Clarify region name",
    };
    const updated = await service.updateOrganization(
      owner,
      region,
      patch,
      "mst01-region-patch",
      "mst01-region-patch",
    );
    const replay = await service.updateOrganization(
      owner,
      region,
      patch,
      "mst01-region-patch",
      "mst01-region-patch-retry",
    );
    expect(replay).toMatchObject({
      id: updated.id,
      version: updated.version,
      replayed: true,
    });
    await expect(
      service.updateOrganization(
        owner,
        region,
        { ...patch, name: "Different region" },
        "mst01-region-patch",
        "mst01-region-patch-conflict",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("MST01-I-004/C-002 makes bulk assignments active-only and exact-once", async () => {
    const assignee = await service.createEmployee(
      owner,
      {
        employeeCode: "ASSIGN-01",
        displayName: "Assignment Employee",
        designation: "Traffic Executive",
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-assignee",
      "mst01-assignee",
    );
    const entries = [
      {
        employeeId: String(assignee.id),
        assignmentType: "TRAFFIC",
        organizationNodeId: branch,
        effectiveFrom: "2026-08-25T00:00:00.000Z",
      },
    ];
    const first = await advanced.bulkAssignments(
      owner,
      entries,
      "mst01-assignment-key",
      "mst01-assignment",
    );
    const replay = await advanced.bulkAssignments(
      owner,
      entries,
      "mst01-assignment-key",
      "mst01-assignment-replay",
    );
    expect(replay).toEqual(first);
    const exactOnce = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{ rows: number; audits: number; events: number }>
      >(
        `SELECT
          (SELECT count(*)::int FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid) rows,
          (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid AND action='assignment.created' AND target_id=(SELECT id FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid LIMIT 1)) audits,
          (SELECT count(*)::int FROM app.outbox_events WHERE tenant_id=$1::uuid AND aggregate_type='operational_assignment' AND aggregate_id=(SELECT id FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid LIMIT 1)) events`,
        owner.activeTenantId,
        assignee.id,
      ),
    );
    expect(exactOnce[0]).toEqual({ rows: 1, audits: 1, events: 1 });
    const maximumBatch = Array.from({ length: 250 }, (_, index) => ({
      employeeId: String(assignee.id),
      assignmentType: "TRAFFIC",
      organizationNodeId: branch,
      effectiveFrom: "2026-08-25T00:00:00.000Z",
      exceptionReason: `Boundary assignment ${index + 1}`,
    }));
    const maximum = await advanced.bulkAssignments(
      owner,
      maximumBatch,
      "mst01-assignment-250-key",
      "mst01-assignment-250",
    );
    expect(maximum.count).toBe(250);
    const overLimit = await request(http.getHttpServer())
      .post("/api/v1/domain/commands/assignments/bulk")
      .set("Cookie", `logistics_session=${ownerToken}`)
      .set("Origin", "http://127.0.0.1:3000")
      .set("X-CSRF-Token", ownerCsrf)
      .set("Idempotency-Key", "mst01-assignment-251-key")
      .send({ items: [...maximumBatch, maximumBatch[0]] });
    expect(overLimit.status).toBe(400);
    expect(overLimit.body).toMatchObject({ code: "VALIDATION_FAILED" });
    const beforeMixed = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        Number(
          (
            await tx.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT count(*)::int count FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid`,
              owner.activeTenantId,
              assignee.id,
            )
          )[0]!.count,
        ),
    );
    await expect(
      advanced.bulkAssignments(
        owner,
        [entries[0]!, { ...entries[0]!, employeeId: crypto.randomUUID() }],
        "mst01-assignment-mixed-key",
        "mst01-assignment-mixed",
      ),
    ).rejects.toMatchObject({ status: 409, code: "EMPLOYEE_INACTIVE" });
    const afterMixed = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        Number(
          (
            await tx.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT count(*)::int count FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$2::uuid`,
              owner.activeTenantId,
              assignee.id,
            )
          )[0]!.count,
        ),
    );
    expect(afterMixed).toBe(beforeMixed);
    await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.employees SET state='INACTIVE',active_to=current_date WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        assignee.id,
      ),
    );
    await expect(
      advanced.bulkAssignments(
        owner,
        entries,
        "mst01-inactive-assignment",
        "mst01-inactive-assignment",
      ),
    ).rejects.toMatchObject({ code: "EMPLOYEE_INACTIVE" });
  });

  it("MST01-I-003 serializes reciprocal manager cycles", async () => {
    const second = await service.createEmployee(
      owner,
      {
        employeeCode: "EMP-02",
        displayName: "Employee Two",
        designation: "Manager",
        homeNodeId: branch,
        regionIds: [region],
        activeFrom: "2026-08-25",
      },
      "mst01-employee-2",
      "mst01-employee-2",
    );
    const firstDetail = (await service.employeeView(owner, employee)) as {
      version: number;
    };
    const secondDetail = (await service.employeeView(
      owner,
      String(second.id),
    )) as { version: number };
    const results = await Promise.allSettled([
      service.updateEmployee(
        owner,
        employee,
        {
          expectedVersion: firstDetail.version,
          managerId: String(second.id),
          reason: "assign manager",
        },
        "mst01-manager-a-key",
        "mst01-manager-a",
      ),
      service.updateEmployee(
        owner,
        String(second.id),
        {
          expectedVersion: secondDetail.version,
          managerId: employee,
          reason: "assign manager",
        },
        "mst01-manager-b-key",
        "mst01-manager-b",
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ code: "MANAGER_CYCLE" });
  });

  it("MST01-C-004 exposes tenant-authorized postal lookup only", async () => {
    await expect(service.postal(owner, "110001")).resolves.toMatchObject({
      items: [
        { locality: "Connaught Place" },
        { locality: "Parliament Street" },
      ],
    });
    await expect(
      service.postal({ ...owner, membershipId: undefined }, "110001"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("MST01-I-007 test controls are authenticated, one-shot and restore postal state", async () => {
    const noCsrf = await request(http.getHttpServer())
      .post("/api/v1/domain/masters/test-controls/counts")
      .set("Cookie", `logistics_session=${ownerToken}`)
      .set("Origin", "http://127.0.0.1:3000")
      .send({});
    expect(noCsrf.status).toBe(403);
    const counts = await request(http.getHttpServer())
      .post("/api/v1/domain/masters/test-controls/counts")
      .set("Cookie", `logistics_session=${ownerToken}`)
      .set("Origin", "http://127.0.0.1:3000")
      .set("X-CSRF-Token", ownerCsrf)
      .send({});
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual(
      expect.objectContaining({
        organizationNodes: expect.any(Number),
        closureRows: expect.any(Number),
        employees: expect.any(Number),
        assignments: expect.any(Number),
        audits: expect.any(Number),
        outbox: expect.any(Number),
      }),
    );
    await service.armPostalFailure(owner, "560043");
    await expect(service.postal(owner, "560043")).rejects.toMatchObject({
      status: 503,
      code: "POSTAL_LOOKUP_UNAVAILABLE",
    });
    await expect(service.postal(owner, "560043")).resolves.toMatchObject({
      postalCode: "560043",
    });
    const localityId = "56004300-0000-4000-8000-000000000001";
    await service.armPostalStaleSelection(owner, localityId);
    const staleInput = {
      code: "STALE-REGION",
      name: "Stale Postal Region",
      nodeType: "REGION" as const,
      parentId: legalEntity,
      timezone: "Asia/Kolkata",
      activeFrom: "2026-08-25",
      address: {
        line1: "1 Stale Selection Road",
        country: "IN" as const,
        postalCode: "560043",
        postalLocalityId: localityId,
      },
    };
    await expect(
      service.createOrganization(
        owner,
        staleInput,
        "mst01-stale-postal",
        "mst01-stale-postal",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "POSTAL_REFERENCE_CHANGED",
    });
    const restored = await app.db.$queryRawUnsafe<
      Array<{ active: boolean; status: string; nodes: number }>
    >(
      `SELECT v.active,v.status,
       (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$2::uuid AND code='STALE-REGION') nodes
       FROM postal_reference.postal_localities l JOIN postal_reference.postal_directory_versions v ON v.id=l.directory_version_id
       WHERE l.id=$1::uuid`,
      localityId,
      owner.activeTenantId,
    );
    expect(restored[0]).toEqual({ active: true, status: "ACTIVE", nodes: 0 });
    await expect(
      service.createOrganization(
        owner,
        staleInput,
        "mst01-stale-postal",
        "mst01-stale-postal-retry",
      ),
    ).resolves.toMatchObject({ code: "STALE-REGION" });
    app.config.ENABLE_TEST_HOOKS = "false";
    try {
      await expect(
        service.armPostalFailure(owner, "560043"),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    } finally {
      app.config.ENABLE_TEST_HOOKS = "true";
    }
  });

  it("MST01-I-005 rejects a direct-report replacement self-cycle", async () => {
    const retiring = await service.createEmployee(
      owner,
      {
        employeeCode: "RETIRE-01",
        displayName: "Retiring Manager",
        designation: "Manager",
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-retiring",
      "mst01-retiring",
    );
    const report = await service.createEmployee(
      owner,
      {
        employeeCode: "REPORT-01",
        displayName: "Direct Report",
        designation: "Executive",
        managerId: String(retiring.id),
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-direct-report",
      "mst01-direct-report",
    );
    const descendantImpact = await service.employeeImpact(
      owner,
      String(retiring.id),
    );
    await expect(
      advanced.reassignEmployee(
        owner,
        String(retiring.id),
        {
          replacementEmployeeId: String(report.id),
          expectedVersion: Number(retiring.version),
          impactSnapshotId: String(descendantImpact.snapshotId),
          reason: "Invalid descendant replacement",
        },
        "mst01-descendant-cycle",
        "mst01-descendant-cycle-key",
      ),
    ).rejects.toMatchObject({ code: "REPLACEMENT_CYCLE" });
    await expect(
      service.employeeView(owner, String(report.id)),
    ).resolves.toMatchObject({
      managerId: String(retiring.id),
      state: "ACTIVE",
    });
  });

  it("MST01-C-003 revalidates impact snapshots before reassignment", async () => {
    const retiring = await service.createEmployee(
      owner,
      {
        employeeCode: "SNAPSHOT-OLD",
        displayName: "Snapshot old",
        designation: "Manager",
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-snapshot-old",
      "mst01-snapshot-old",
    );
    const replacement = await service.createEmployee(
      owner,
      {
        employeeCode: "SNAPSHOT-NEW",
        displayName: "Snapshot new",
        designation: "Manager",
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-snapshot-new",
      "mst01-snapshot-new",
    );
    const preview = await service.employeeImpact(owner, String(retiring.id));
    expect(preview).toMatchObject({ versions: { employee: retiring.version } });
    expect(preview.snapshotId).toHaveLength(64);
    await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,account_manager_employee_id,authorization_scope_node_id)
       SELECT $1::uuid,'SNAPSHOT-CLIENT','Snapshot Client',$2::uuid,$3::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        legalEntity,
        retiring.id,
      ),
    );
    await expect(
      advanced.reassignEmployee(
        owner,
        String(retiring.id),
        {
          replacementEmployeeId: String(replacement.id),
          expectedVersion: Number(retiring.version),
          impactSnapshotId: String(preview.snapshotId),
          reason: "Snapshot changed after preview",
        },
        "mst01-impact-changed",
        "mst01-impact-changed-key",
      ),
    ).rejects.toMatchObject({ code: "IMPACT_CHANGED" });
    await expect(
      service.employeeView(owner, String(retiring.id)),
    ).resolves.toMatchObject({ state: "ACTIVE" });
  });

  it("MST01-I-005 transfers employee-owned master and escalation references", async () => {
    const memberships = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO app.users(email,display_name,password_hash) VALUES
           ('retiring-owner@test.local','Retiring owner','unused'),
           ('replacement-owner@test.local','Replacement owner','unused')`,
        );
        return tx.$queryRawUnsafe<Array<{ id: string; invited_email: string }>>(
          `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
           SELECT $1::uuid,u.id,u.email,u.display_name,CASE WHEN u.email LIKE 'retiring%' THEN 'RETIRING-OWNER' ELSE 'REPLACEMENT-OWNER' END,'ACTIVE'
           FROM app.users u WHERE u.email IN ('retiring-owner@test.local','replacement-owner@test.local') RETURNING id,invited_email`,
          owner.activeTenantId,
        );
      },
    );
    const retiringMembership = memberships.find((membership) =>
        membership.invited_email.startsWith("retiring"),
      )!.id,
      replacementMembership = memberships.find((membership) =>
        membership.invited_email.startsWith("replacement"),
      )!.id;
    const retiring = await service.createEmployee(
      owner,
      {
        employeeCode: "OWNER-RETIRE",
        displayName: "Owner Retiring",
        designation: "Manager",
        homeNodeId: branch,
        linkedMembershipId: retiringMembership,
        activeFrom: "2026-08-25",
      },
      "mst01-owner-retiring",
      "mst01-owner-retiring",
    );
    const replacement = await service.createEmployee(
      owner,
      {
        employeeCode: "OWNER-REPLACE",
        displayName: "Owner Replacement",
        designation: "Manager",
        homeNodeId: branch,
        linkedMembershipId: replacementMembership,
        activeFrom: "2026-08-25",
      },
      "mst01-owner-replacement",
      "mst01-owner-replacement",
    );
    const affectedIds = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        const client = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,account_manager_employee_id,authorization_scope_node_id)
             SELECT $1::uuid,'REASSIGN-CLIENT','Reassign Client',$2::uuid,$3::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id`,
            owner.activeTenantId,
            legalEntity,
            retiring.id,
          )
        )[0]!;
        const location = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.client_locations(tenant_id,client_id,code,name,location_type,organization_node_id,manager_employee_id,authorization_scope_node_id)
             SELECT $1::uuid,$2::uuid,'REASSIGN-LOC','Reassign Location','OFFICE',$3::uuid,$4::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$3::uuid RETURNING id`,
            owner.activeTenantId,
            client.id,
            branch,
            retiring.id,
          )
        )[0]!;
        const vendor = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.vendors(tenant_id,code,legal_name,onboarding_employee_id,authorization_scope_node_id)
             SELECT $1::uuid,'REASSIGN-VENDOR','Reassign Vendor',$2::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$3::uuid RETURNING id`,
            owner.activeTenantId,
            retiring.id,
            branch,
          )
        )[0]!;
        const rule = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,recipient_policy,escalation_levels)
             VALUES($1::uuid,'REASSIGN-RULE','Reassign rule','MST-01','WARNING',$2::jsonb,$3::jsonb) RETURNING id`,
            owner.activeTenantId,
            JSON.stringify({
              membershipId: retiringMembership,
              note: `keep-${retiringMembership}-text`,
            }),
            JSON.stringify([{ membershipId: retiringMembership }]),
          )
        )[0]!;
        const alert = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.operational_alerts(tenant_id,rule_id,deduplication_key,source_module,alert_type,severity,title,summary,owner_membership_id)
             VALUES($1::uuid,$3::uuid,'mst01-reassign-alert','MST-01','ownership.unowned','WARNING','Reassign','Reassign',$2::uuid) RETURNING id`,
            owner.activeTenantId,
            retiringMembership,
            rule.id,
          )
        )[0]!;
        const assignments = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.operational_assignments(tenant_id,employee_id,assignment_type,organization_node_id,effective_from,effective_to,created_by) VALUES
           ($1::uuid,$2::uuid,'MANAGER',$3::uuid,now()-interval '1 day',now()+interval '1 day',$4::uuid),
           ($1::uuid,$2::uuid,'TRAFFIC',$3::uuid,now()+interval '2 days',now()+interval '3 days',$4::uuid) RETURNING id`,
          owner.activeTenantId,
          retiring.id,
          branch,
          owner.userId,
        );
        return {
          client: client.id,
          location: location.id,
          vendor: vendor.id,
          rule: rule.id,
          alert: alert.id,
          currentAssignment: assignments[0]!.id,
          futureAssignment: assignments[1]!.id,
        };
      },
    );
    const transferImpact = await service.employeeImpact(
      owner,
      String(retiring.id),
    );
    const transferInput = {
      replacementEmployeeId: String(replacement.id),
      expectedVersion: Number(retiring.version),
      impactSnapshotId: String(transferImpact.snapshotId),
      reason: "Complete owner responsibility transfer",
    };
    const transfer = await advanced.reassignEmployee(
      owner,
      String(retiring.id),
      transferInput,
      "mst01-owner-transfer",
      "mst01-owner-transfer-key",
    );
    const transferReplay = await advanced.reassignEmployee(
      owner,
      String(retiring.id),
      transferInput,
      "mst01-owner-transfer-retry",
      "mst01-owner-transfer-key",
    );
    expect(transferReplay).toMatchObject({ id: transfer.id, replayed: true });
    const transferred = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          clientOwner: string;
          locationOwner: string;
          vendorOwner: string;
          alertOwner: string;
          ruleUpdated: boolean;
          routeNotePreserved: boolean;
          oldCurrentEnded: boolean;
          replacementCurrent: number;
          futureTransferred: boolean;
        }>
      >(
        `SELECT
            (SELECT account_manager_employee_id FROM app.clients WHERE tenant_id=$1::uuid AND id=$2::uuid) "clientOwner",
            (SELECT manager_employee_id FROM app.client_locations WHERE tenant_id=$1::uuid AND id=$3::uuid) "locationOwner",
            (SELECT onboarding_employee_id FROM app.vendors WHERE tenant_id=$1::uuid AND id=$4::uuid) "vendorOwner",
            (SELECT owner_membership_id FROM app.operational_alerts WHERE tenant_id=$1::uuid AND id=$5::uuid) "alertOwner",
            (SELECT recipient_policy->>'membershipId'=$6 AND escalation_levels->0->>'membershipId'=$6 FROM app.alert_rules WHERE tenant_id=$1::uuid AND id=$7::uuid) "ruleUpdated",
            (SELECT recipient_policy->>'note'=$8 FROM app.alert_rules WHERE tenant_id=$1::uuid AND id=$7::uuid) "routeNotePreserved",
            (SELECT effective_to<=now() FROM app.operational_assignments WHERE tenant_id=$1::uuid AND id=$9::uuid) "oldCurrentEnded",
            (SELECT count(*)::int FROM app.operational_assignments WHERE tenant_id=$1::uuid AND employee_id=$10::uuid AND assignment_type='MANAGER' AND effective_from<=now() AND effective_to>now()) "replacementCurrent",
            (SELECT employee_id=$10::uuid AND effective_from>now() FROM app.operational_assignments WHERE tenant_id=$1::uuid AND id=$11::uuid) "futureTransferred"`,
        owner.activeTenantId,
        affectedIds.client,
        affectedIds.location,
        affectedIds.vendor,
        affectedIds.alert,
        replacementMembership,
        affectedIds.rule,
        `keep-${retiringMembership}-text`,
        affectedIds.currentAssignment,
        replacement.id,
        affectedIds.futureAssignment,
      ),
    );
    expect(transferred[0]).toEqual({
      clientOwner: replacement.id,
      locationOwner: replacement.id,
      vendorOwner: replacement.id,
      alertOwner: replacementMembership,
      ruleUpdated: true,
      routeNotePreserved: true,
      oldCurrentEnded: true,
      replacementCurrent: 1,
      futureTransferred: true,
    });
  });

  it("MST01-A-004 gates linked identity and contact data independently", async () => {
    const south = await service.createOrganization(
      owner,
      {
        code: "SOUTH",
        name: "South",
        nodeType: "REGION",
        parentId: legalEntity,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-south",
      "mst01-south",
    );
    const linked = await service.createEmployee(
      owner,
      {
        employeeCode: "LINK-01",
        displayName: "Linked Employee",
        designation: "Administrator",
        email: "linked.employee@example.test",
        mobile: "+919876543210",
        homeNodeId: branch,
        linkedMembershipId: owner.membershipId,
        activeFrom: "2026-08-25",
      },
      "mst01-linked",
      "mst01-linked",
    );
    const limited = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        const user = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.users(email,display_name,password_hash) VALUES('limited-mst01@test.local','Limited master admin','not-used') RETURNING id`,
          )
        )[0]!;
        const membership = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
             VALUES($1::uuid,$2::uuid,'limited-mst01@test.local','Limited master admin','LIMITED-MST01','ACTIVE') RETURNING id`,
            owner.activeTenantId,
            user.id,
          )
        )[0]!;
        const role = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.roles(tenant_id,code,name,description) VALUES($1::uuid,'LIMITED_MST01','Limited masters','No identity or sensitive access') RETURNING id`,
            owner.activeTenantId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code) VALUES($1::uuid,$2::uuid,'masters.read'),($1::uuid,$2::uuid,'masters.admin')`,
          owner.activeTenantId,
          role.id,
        );
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            owner.activeTenantId,
            membership.id,
            role.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
           SELECT $1::uuid,$2::uuid,authorization_scope_node_id,'ADMIN' FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$3::uuid`,
          owner.activeTenantId,
          assignment.id,
          branch,
        );
        return { userId: user.id, membershipId: membership.id };
      },
    );
    const limitedActor = {
      ...owner,
      userId: limited.userId,
      membershipId: limited.membershipId,
      email: "limited-mst01@test.local",
    };
    const scopedReplacement = await service.createEmployee(
      owner,
      {
        employeeCode: "NORTH-REPLACE",
        displayName: "North Replacement",
        designation: "Manager",
        homeNodeId: branch,
        activeFrom: "2026-08-25",
      },
      "mst01-north-replacement",
      "mst01-north-replacement",
    );
    const southClient = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,account_manager_employee_id,authorization_scope_node_id)
       SELECT $1::uuid,'SOUTH-OWNED','South Owned',$2::uuid,$3::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id`,
            owner.activeTenantId,
            south.id,
            linked.id,
          )
        )[0]!,
    );
    const hiddenAlert = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.operational_alerts(tenant_id,deduplication_key,source_module,source_record_id,alert_type,severity,title,summary,owner_membership_id)
             VALUES($1::uuid,'mst01-hidden-south-alert','clients',$2::uuid,'ownership.review','WARNING','South ownership review','Scoped South record',$3::uuid) RETURNING id`,
            owner.activeTenantId,
            southClient.id,
            owner.membershipId,
          )
        )[0]!,
    );
    const limitedImpact = await service.employeeImpact(
      limitedActor,
      String(linked.id),
    );
    expect(limitedImpact.categories.alerts).toMatchObject({
      count: 0,
      ids: [],
    });
    expect(JSON.stringify(limitedImpact)).not.toContain(hiddenAlert.id);
    await expect(
      advanced.reassignEmployee(
        limitedActor,
        String(linked.id),
        {
          replacementEmployeeId: String(scopedReplacement.id),
          expectedVersion: Number(linked.version),
          impactSnapshotId: String(limitedImpact.snapshotId),
          reason: "Attempt cross-scope retirement",
        },
        "mst01-cross-scope-reassign",
        "mst01-cross-scope-reassign-key",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    const preservedSouth = await withTenant(
      app.db,
      owner.activeTenantId!,
      (tx) =>
        tx.$queryRawUnsafe<Array<{ owner: string }>>(
          `SELECT account_manager_employee_id owner FROM app.clients WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          owner.activeTenantId,
          southClient.id,
        ),
    );
    expect(preservedSouth[0]!.owner).toBe(linked.id);
    await expect(
      service.employeeView(owner, String(linked.id)),
    ).resolves.toMatchObject({ state: "ACTIVE" });
    const detail = (await service.employeeView(
      limitedActor,
      String(linked.id),
    )) as Record<string, unknown>;
    expect(detail).toMatchObject({
      linkedUser: true,
      email: "••••",
      mobile: "••••",
      accessSummary: [],
    });
    expect(detail).not.toHaveProperty("linkedMembershipId");
    expect(detail).not.toHaveProperty("linkedUserEmail");
    const visibleOrganizations = (await service.organizationView(
      limitedActor,
    )) as { items: Array<{ id: string }> };
    expect(visibleOrganizations.items.map((item) => item.id)).toContain(branch);
    expect(visibleOrganizations.items.map((item) => item.id)).not.toContain(
      String(south.id),
    );
    await expect(
      service.createOrganization(
        limitedActor,
        {
          code: "SOUTH-GUESSED",
          name: "Guessed South branch",
          nodeType: "BRANCH",
          parentId: String(south.id),
          timezone: "Asia/Kolkata",
          activeFrom: "2026-08-25",
          address: {
            line1: "1 Guessed Road",
            country: "IN",
            postalCode: "560043",
            postalLocalityId: "56004300-0000-4000-8000-000000000001",
          },
        },
        "mst01-guessed-south",
        "mst01-guessed-south",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      service.ownershipExport(limitedActor, "mst01-limited-export"),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      service.updateEmployee(
        limitedActor,
        String(linked.id),
        {
          expectedVersion: Number(linked.version),
          email: "replacement@example.test",
          reason: "Unauthorized contact change",
        },
        "mst01-contact-denied-key",
        "mst01-contact-denied",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      service.updateEmployee(
        limitedActor,
        String(linked.id),
        {
          expectedVersion: Number(linked.version),
          linkedMembershipId: null,
          reason: "Unauthorized unlink attempt",
        },
        "mst01-unlink-denied-key",
        "mst01-unlink-denied",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    const beforeGrantCounts = await withTenant(
      app.db,
      owner.activeTenantId!,
      (tx) =>
        tx.$queryRawUnsafe<Array<{ managed: number; tenantRoot: number }>>(
          `SELECT
             (SELECT count(*)::int FROM app.employee_scope_grant_links WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND state='ACTIVE') managed,
             (SELECT count(*)::int FROM app.scope_grants g JOIN app.membership_role_assignments a ON a.tenant_id=g.tenant_id AND a.id=g.assignment_id JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id WHERE g.tenant_id=$1::uuid AND a.membership_id=$3::uuid AND n.scope_type='TENANT' AND g.status='ACTIVE') "tenantRoot"`,
          owner.activeTenantId,
          linked.id,
          owner.membershipId,
        ),
    );
    expect(beforeGrantCounts[0]!.managed).toBeGreaterThan(0);
    const moved = await service.updateEmployee(
      owner,
      String(linked.id),
      {
        expectedVersion: Number(linked.version),
        homeNodeId: String(south.id),
        reason: "Move linked employee scope",
      },
      "mst01-linked-scope-move-key",
      "mst01-linked-scope-move",
    );
    const afterGrantCounts = await withTenant(
      app.db,
      owner.activeTenantId!,
      (tx) =>
        tx.$queryRawUnsafe<
          Array<{ managed: number; oldManaged: number; tenantRoot: number }>
        >(
          `SELECT
             (SELECT count(*)::int FROM app.employee_scope_grant_links WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND organization_node_id=$3::uuid AND state='ACTIVE') managed,
             (SELECT count(*)::int FROM app.employee_scope_grant_links WHERE tenant_id=$1::uuid AND employee_id=$2::uuid AND organization_node_id=$4::uuid AND state='ACTIVE') "oldManaged",
             (SELECT count(*)::int FROM app.scope_grants g JOIN app.membership_role_assignments a ON a.tenant_id=g.tenant_id AND a.id=g.assignment_id JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id WHERE g.tenant_id=$1::uuid AND a.membership_id=$5::uuid AND n.scope_type='TENANT' AND g.status='ACTIVE') "tenantRoot"`,
          owner.activeTenantId,
          linked.id,
          south.id,
          branch,
          owner.membershipId,
        ),
    );
    expect(afterGrantCounts[0]).toMatchObject({
      oldManaged: 0,
      tenantRoot: beforeGrantCounts[0]!.tenantRoot,
    });
    expect(afterGrantCounts[0]!.managed).toBeGreaterThan(0);
    expect(moved).toMatchObject({ home_node_id: south.id });
    await expect(app.session(ownerToken)).rejects.toMatchObject({
      code: "SESSION_STALE",
    });
    const refreshedLogin = await app.login(
      "mst01-a@test.local",
      "OwnerPassword!234",
      "MST01-A",
      "mst01-owner-scope-refresh",
    );
    if (!("sessionToken" in refreshedLogin))
      throw new Error("Expected owner login after authorization change");
    ownerToken = refreshedLogin.sessionToken;
    ownerCsrf = refreshedLogin.csrfToken;
    owner = await app.session(ownerToken);
    const refreshedOrganizations = (await service.organizationView(owner)) as {
      items: Array<{ id: string }>;
    };
    expect(refreshedOrganizations.items.map((item) => item.id)).toContain(
      String(south.id),
    );
  });

  it("MST01-M-001/002 verifies tenant graph constraints, RLS and immutable audit", async () => {
    const catalog = await app.db.$queryRawUnsafe<
      Array<{
        rlsTables: number;
        immutableTriggers: number;
        tenantForeignKeys: number;
      }>
    >(
      `SELECT
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN ('organization_nodes','organization_closure','organization_addresses','employees','employee_region_coverage','operational_assignments') AND c.relrowsecurity AND c.relforcerowsecurity) "rlsTables",
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='audit' AND c.relname='audit_events' AND NOT t.tgisinternal AND t.tgenabled<>'D') "immutableTriggers",
        (SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='app' AND r.relname IN ('organization_closure','organization_addresses','employee_region_coverage','operational_assignments') AND c.contype='f' AND array_length(c.conkey,1)>=2) "tenantForeignKeys"`,
    );
    expect(catalog[0]).toMatchObject({
      rlsTables: 6,
      immutableTriggers: 1,
    });
    expect(catalog[0]!.tenantForeignKeys).toBeGreaterThanOrEqual(6);
    await expect(
      withTenant(app.db, owner.activeTenantId!, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) VALUES($1::uuid,$2::uuid,$3::uuid,1)`,
          owner.activeTenantId,
          legalEntity,
          crypto.randomUUID(),
        ),
      ),
    ).rejects.toBeTruthy();
  });

  it("MST01-C-005 binds bulk idempotency to the active tenant for the same user", async () => {
    const tenantBMembership = await withTenant(
      app.db,
      otherOwner.activeTenantId!,
      async (tx) => {
        const membership = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
             VALUES($1::uuid,$2::uuid,'mst01-a@test.local','Owner A in B','OWNER-A-B','ACTIVE') RETURNING id`,
            otherOwner.activeTenantId,
            owner.userId,
          )
        )[0]!;
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id)
             SELECT $1::uuid,$2::uuid,id FROM app.roles WHERE tenant_id=$1::uuid AND code='TENANT_OWNER' RETURNING id`,
            otherOwner.activeTenantId,
            membership.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
           SELECT $1::uuid,$2::uuid,id,'ADMIN' FROM app.authorization_scope_nodes WHERE tenant_id=$1::uuid AND scope_type='TENANT'`,
          otherOwner.activeTenantId,
          assignment.id,
        );
        return membership.id;
      },
    );
    const sameUserB = {
      ...otherOwner,
      userId: owner.userId,
      email: owner.email,
      membershipId: tenantBMembership,
    };
    const entityB = await service.createOrganization(
      sameUserB,
      {
        code: "B-IDEMP-LE",
        name: "Tenant B idempotency entity",
        nodeType: "LEGAL_ENTITY",
        parentId: null,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-b-idemp-entity",
      "mst01-b-idemp-entity",
    );
    const employeeB = await service.createEmployee(
      sameUserB,
      {
        employeeCode: "B-IDEMP-EMP",
        displayName: "Tenant B assignee",
        designation: "Coordinator",
        homeNodeId: String(entityB.id),
        activeFrom: "2026-08-25",
      },
      "mst01-b-idemp-employee",
      "mst01-b-idemp-employee",
    );
    const key = "mst01-same-user-cross-tenant-key";
    const resultA = await advanced.bulkAssignments(
      owner,
      [
        {
          employeeId: employee,
          assignmentType: "TRAFFIC",
          organizationNodeId: legalEntity,
          effectiveFrom: "2026-08-25T00:00:00.000Z",
        },
      ],
      key,
      "mst01-same-user-a",
    );
    const resultB = await advanced.bulkAssignments(
      sameUserB,
      [
        {
          employeeId: String(employeeB.id),
          assignmentType: "TRAFFIC",
          organizationNodeId: String(entityB.id),
          effectiveFrom: "2026-08-25T00:00:00.000Z",
        },
      ],
      key,
      "mst01-same-user-b",
    );
    expect(resultA.items.map((item) => item.id)).not.toEqual(
      resultB.items.map((item) => item.id),
    );
    const counts = await Promise.all([
      withTenant(app.db, owner.activeTenantId!, async (tx) =>
        Number(
          (
            await tx.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT count(*)::int count FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation='mst01.assignments.bulk'`,
              owner.activeTenantId,
              owner.userId,
            )
          )[0]!.count,
        ),
      ),
      withTenant(app.db, otherOwner.activeTenantId!, async (tx) =>
        Number(
          (
            await tx.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT count(*)::int count FROM app.idempotency_records WHERE tenant_id=$1::uuid AND actor_id=$2::uuid AND operation='mst01.assignments.bulk'`,
              otherOwner.activeTenantId,
              owner.userId,
            )
          )[0]!.count,
        ),
      ),
    ]);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(1);
  });

  it("MST01-I-009 records, expires and resolves temporary deactivation exceptions", async () => {
    const target = await service.createOrganization(
      owner,
      {
        code: "EXCEPTION-REGION",
        name: "Exception review region",
        nodeType: "REGION",
        parentId: legalEntity,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-exception-target",
      "mst01-exception-target",
    );
    const impact = await service.organizationImpact(owner, String(target.id));
    const securityActors = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        const createMembership = async (email: string, code: string) => {
          const user = (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.users(email,display_name,password_hash) VALUES($1,$2,'unused') RETURNING id`,
              email,
              code,
            )
          )[0]!;
          const membership = (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
               VALUES($1::uuid,$2::uuid,$3,$4,$5,'ACTIVE') RETURNING id`,
              owner.activeTenantId,
              user.id,
              email,
              code,
              code,
            )
          )[0]!;
          return { userId: user.id, membershipId: membership.id };
        };
        const noCapability = await createMembership(
          "mst01-no-exception@test.local",
          "NO-EXCEPTION",
        );
        const scoped = await createMembership(
          "mst01-scoped-exception@test.local",
          "SCOPED-EXCEPTION",
        );
        const role = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.roles(tenant_id,code,name,description) VALUES($1::uuid,'SCOPED_EXCEPTION','Scoped exception reviewer','Branch-only exception reviewer') RETURNING id`,
            owner.activeTenantId,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
           VALUES($1::uuid,$2::uuid,'masters.read'),($1::uuid,$2::uuid,'masters.admin'),($1::uuid,$2::uuid,'masters.exception'),($1::uuid,$2::uuid,'alerts.read')`,
          owner.activeTenantId,
          role.id,
        );
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,
            owner.activeTenantId,
            scoped.membershipId,
            role.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
           SELECT $1::uuid,$2::uuid,authorization_scope_node_id,'ADMIN' FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$3::uuid`,
          owner.activeTenantId,
          assignment.id,
          branch,
        );
        return { noCapability, scoped };
      },
    );
    const noCapabilityActor = {
      ...owner,
      ...securityActors.noCapability,
      email: "mst01-no-exception@test.local",
    };
    const scopedActor = {
      ...owner,
      ...securityActors.scoped,
      email: "mst01-scoped-exception@test.local",
    };
    const exceptionInput = {
      expectedVersion: Number(target.version),
      impactSnapshotId: String(impact.snapshotId),
      reason: "Temporary operational exception pending review",
      reviewBy: "2026-08-25",
    };
    await expect(
      service.exceptionDeactivate(
        noCapabilityActor,
        "ORGANIZATION",
        String(target.id),
        exceptionInput,
        "mst01-exception-no-capability",
        "mst01-exception-no-capability",
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      service.exceptionReport(noCapabilityActor),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      service.exceptionDeactivate(
        scopedActor,
        "ORGANIZATION",
        String(target.id),
        exceptionInput,
        "mst01-exception-scoped",
        "mst01-exception-scoped",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      service.exceptionDeactivate(
        otherOwner,
        "ORGANIZATION",
        String(target.id),
        exceptionInput,
        "mst01-exception-cross-tenant",
        "mst01-exception-cross-tenant",
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    const opened = await service.exceptionDeactivate(
      owner,
      "ORGANIZATION",
      String(target.id),
      {
        expectedVersion: Number(target.version),
        impactSnapshotId: String(impact.snapshotId),
        reason: exceptionInput.reason,
        reviewBy: exceptionInput.reviewBy,
      },
      "mst01-exception-open",
      "mst01-exception-open",
    );
    expect(opened.target).toMatchObject({ state: "INACTIVE" });
    const alertVisibility = await withTenant(
      app.db,
      owner.activeTenantId!,
      (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            ownerVisible: boolean;
            scopedVisible: boolean;
            noCapabilityVisible: boolean;
          }>
        >(
          `SELECT
             app.operational_alert_authorized($1::uuid,$2::uuid,$3::uuid,'alerts.read',a.id) "ownerVisible",
             app.operational_alert_authorized($1::uuid,$4::uuid,$5::uuid,'alerts.read',a.id) "scopedVisible",
             app.operational_alert_authorized($1::uuid,$6::uuid,$7::uuid,'alerts.read',a.id) "noCapabilityVisible"
           FROM app.operational_alerts a WHERE a.tenant_id=$1::uuid AND a.deduplication_key=$8`,
          owner.activeTenantId,
          owner.membershipId,
          owner.userId,
          scopedActor.membershipId,
          scopedActor.userId,
          noCapabilityActor.membershipId,
          noCapabilityActor.userId,
          `mst01:exception:${String(opened.exception.id)}`,
        ),
    );
    expect(alertVisibility[0]).toEqual({
      ownerVisible: true,
      scopedVisible: false,
      noCapabilityVisible: false,
    });
    expect((await service.exceptionReport(scopedActor)).items).toEqual([]);
    expect((await service.exceptionReport(otherOwner)).items).toEqual([]);
    for (const [actor, expected] of [
      [noCapabilityActor, { status: 403, code: "FORBIDDEN" }],
      [scopedActor, { status: 404, code: "RESOURCE_NOT_FOUND" }],
      [otherOwner, { status: 404, code: "RESOURCE_NOT_FOUND" }],
    ] as const) {
      await expect(
        service.reactivateException(
          actor,
          String(opened.exception.id),
          "Unauthorized exception reactivation attempt",
          `mst01-exception-reactivate-${actor.userId}`,
          `mst01-exception-reactivate-${actor.userId}`,
        ),
      ).rejects.toMatchObject(expected);
    }
    const onBoundary = await service.exceptionReport(owner);
    expect(onBoundary.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: opened.exception.id, state: "OPEN" }),
      ]),
    );
    await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.master_deactivation_exceptions SET review_by=current_date-1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        opened.exception.id,
      ),
    );
    const expired = await service.exceptionReport(owner);
    expect(expired.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: opened.exception.id, state: "EXPIRED" }),
      ]),
    );
    const reactivated = await service.reactivateException(
      owner,
      String(opened.exception.id),
      "Reviewed and safe to reactivate",
      "mst01-exception-reactivate",
      "mst01-exception-reactivate",
    );
    expect(reactivated.target).toMatchObject({ state: "ACTIVE" });
    const evidence = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ exceptionState: string; alertState: string }>>(
        `SELECT x.state "exceptionState",a.state "alertState" FROM app.master_deactivation_exceptions x JOIN app.operational_alerts a ON a.tenant_id=x.tenant_id AND a.deduplication_key='mst01:exception:'||x.id::text WHERE x.tenant_id=$1::uuid AND x.id=$2::uuid`,
        owner.activeTenantId,
        opened.exception.id,
      ),
    );
    expect(evidence[0]).toEqual({
      exceptionState: "RESOLVED",
      alertState: "RESOLVED",
    });
  });

  it("MST01-I-008 reconciles descendant scopes and only affected authorization versions", async () => {
    const makeNode = (code: string, nodeType: string, parentId: string) =>
      service.createOrganization(
        owner,
        {
          code,
          name: code,
          nodeType,
          parentId,
          timezone: "Asia/Kolkata",
          activeFrom: "2026-08-25",
          ...((nodeType === "BRANCH" || nodeType === "HUB") && {
            address: {
              line1: `${code} office`,
              country: "IN",
              postalCode: "560043",
              postalLocalityId: "56004300-0000-4000-8000-000000000001",
            },
          }),
        },
        `mst01-i008-${code}`,
        `mst01-i008-${code}`,
      );
    const regionA = await makeNode("I008-REG-A", "REGION", legalEntity);
    const regionB = await makeNode("I008-REG-B", "REGION", legalEntity);
    const branchA = await makeNode("I008-BR-A", "BRANCH", String(regionA.id));
    const branchB = await makeNode("I008-BR-B", "BRANCH", String(regionB.id));
    const hub = await makeNode("I008-HUB", "HUB", String(branchA.id));
    const team = await makeNode("I008-TEAM", "TEAM", String(hub.id));
    const linked = await service.createEmployee(
      owner,
      {
        employeeCode: "I008-LINKED",
        displayName: "I008 linked employee",
        designation: "Coordinator",
        homeNodeId: String(team.id),
        linkedMembershipId: owner.membershipId,
        activeFrom: "2026-08-25",
      },
      "mst01-i008-linked",
      "mst01-i008-linked",
    );
    const unrelated = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `WITH u AS (INSERT INTO app.users(email,display_name,password_hash) VALUES('i008-unrelated@test.local','I008 unrelated','unused') RETURNING id)
           INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
           SELECT $1::uuid,id,'i008-unrelated@test.local','I008 unrelated','I008-UNRELATED','ACTIVE' FROM u RETURNING id`,
            owner.activeTenantId,
          )
        )[0]!,
    );
    const before = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ affected: number; unrelated: number }>>(
        `SELECT
          (SELECT authorization_version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$2::uuid) affected,
          (SELECT authorization_version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$3::uuid) unrelated`,
        owner.activeTenantId,
        owner.membershipId,
        unrelated.id,
      ),
    );
    const moved = await advanced.moveOrganization(
      owner,
      String(hub.id),
      String(branchB.id),
      Number(hub.version),
      "Move inherited subtree across canonical branches",
      "mst01-i008-move",
      "mst01-i008-move",
    );
    expect(moved).toMatchObject({ parent_id: branchB.id });
    const reconciled = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          hubScope: string;
          teamScope: string;
          branchScope: string;
          grantScope: string;
          affected: number;
          unrelated: number;
        }>
      >(
        `SELECT
          (SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid) "hubScope",
          (SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$3::uuid) "teamScope",
          (SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$4::uuid) "branchScope",
          (SELECT g.scope_node_id FROM app.employee_scope_grant_links l JOIN app.scope_grants g ON g.tenant_id=l.tenant_id AND g.id=l.grant_id WHERE l.tenant_id=$1::uuid AND l.employee_id=$5::uuid AND l.coverage_kind='HOME' AND l.state='ACTIVE') "grantScope",
          (SELECT authorization_version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$6::uuid) affected,
          (SELECT authorization_version FROM app.tenant_memberships WHERE tenant_id=$1::uuid AND id=$7::uuid) unrelated`,
        owner.activeTenantId,
        hub.id,
        team.id,
        branchB.id,
        linked.id,
        owner.membershipId,
        unrelated.id,
      ),
    );
    expect(reconciled[0]).toMatchObject({
      hubScope: reconciled[0]!.branchScope,
      teamScope: reconciled[0]!.branchScope,
      grantScope: reconciled[0]!.branchScope,
      affected: before[0]!.affected + 1,
      unrelated: before[0]!.unrelated,
    });
    const standalone = await makeNode(
      "I008-TYPE",
      "BRANCH",
      String(regionA.id),
    );
    const changed = await service.updateOrganization(
      owner,
      String(standalone.id),
      {
        expectedVersion: Number(standalone.version),
        nodeType: "HUB",
        reason: "Change branch to inherited hub scope",
      },
      "mst01-i008-type",
      "mst01-i008-type",
    );
    const typeScopes = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          nodeScope: string;
          parentScope: string;
          canonicalState: string;
        }>
      >(
        `SELECT n.authorization_scope_node_id "nodeScope",p.authorization_scope_node_id "parentScope",s.status "canonicalState"
         FROM app.organization_nodes n JOIN app.organization_nodes p ON p.tenant_id=n.tenant_id AND p.id=n.parent_id
         JOIN app.authorization_scope_nodes s ON s.tenant_id=n.tenant_id AND s.canonical_resource_id=n.id
         WHERE n.tenant_id=$1::uuid AND n.id=$2::uuid`,
        owner.activeTenantId,
        standalone.id,
      ),
    );
    expect(changed).toMatchObject({ node_type: "HUB" });
    expect(typeScopes[0]).toMatchObject({
      nodeScope: typeScopes[0]!.parentScope,
      canonicalState: "INACTIVE",
    });
    const freshLogin = await app.login(
      "mst01-a@test.local",
      "OwnerPassword!234",
      "MST01-A",
      "mst01-i008-session-refresh",
    );
    if (!("sessionToken" in freshLogin))
      throw new Error("Expected refreshed owner session");
    ownerToken = freshLogin.sessionToken;
    ownerCsrf = freshLogin.csrfToken;
    owner = await app.session(ownerToken);
  });

  it("MST01-C-006 searches and paginates organization and employee records beyond fifty", async () => {
    const blankOptionalFilters = await request(http.getHttpServer())
      .get(
        "/api/v1/domain/masters/organization?query=&state=&nodeType=&limit=50&offset=0",
      )
      .set("Cookie", `logistics_session=${ownerToken}`);
    expect(blankOptionalFilters.status).toBe(200);
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app.organization_nodes(tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,active_from,created_by)
         SELECT $1::uuid,'PAGE-ORG-'||lpad(g::text,3,'0'),'Pagination organization '||lpad(g::text,3,'0'),'TEAM',$2::uuid,
                (SELECT authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid),'Asia/Kolkata',current_date,$3::uuid
         FROM generate_series(1,61) g`,
        owner.activeTenantId,
        branch,
        owner.userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
         SELECT n.tenant_id,n.id,n.id,0 FROM app.organization_nodes n WHERE n.tenant_id=$1::uuid AND n.code LIKE 'PAGE-ORG-%'
         UNION ALL
         SELECT n.tenant_id,c.ancestor_id,n.id,c.depth+1 FROM app.organization_nodes n
         JOIN app.organization_closure c ON c.tenant_id=n.tenant_id AND c.descendant_id=$2::uuid
         WHERE n.tenant_id=$1::uuid AND n.code LIKE 'PAGE-ORG-%'`,
        owner.activeTenantId,
        branch,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.employees(tenant_id,employee_code,display_name,designation,home_node_id,active_from,created_by)
         SELECT $1::uuid,'PAGE-EMP-'||lpad(g::text,3,'0'),'Pagination employee '||lpad(g::text,3,'0'),'Coordinator',$2::uuid,current_date,$3::uuid
         FROM generate_series(1,61) g`,
        owner.activeTenantId,
        branch,
        owner.userId,
      );
    });
    const organizationsPage1 = (await service.organizationView(
      owner,
      undefined,
      {
        query: "Pagination organization",
        limit: 50,
        offset: 0,
      },
    )) as { items: Array<{ code: string }>; total: number };
    const organizationsPage2 = (await service.organizationView(
      owner,
      undefined,
      {
        query: "Pagination organization",
        limit: 50,
        offset: 50,
      },
    )) as { items: Array<{ code: string }>; total: number };
    expect(organizationsPage1).toMatchObject({ total: 61 });
    expect(organizationsPage1.items).toHaveLength(50);
    expect(organizationsPage2.items).toHaveLength(11);
    expect(organizationsPage2.items.map((item) => item.code)).toContain(
      "PAGE-ORG-061",
    );
    const organizationSearch = (await service.organizationView(
      owner,
      undefined,
      {
        query: "PAGE-ORG-061",
      },
    )) as { items: Array<{ code: string }>; total: number };
    expect(organizationSearch).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ code: "PAGE-ORG-061" })],
    });
    const employeesPage1 = (await service.employeeView(owner, undefined, {
      query: "Pagination employee",
      limit: 50,
      offset: 0,
    })) as { items: Array<{ employeeCode: string }>; total: number };
    const employeesPage2 = (await service.employeeView(owner, undefined, {
      query: "Pagination employee",
      limit: 50,
      offset: 50,
    })) as { items: Array<{ employeeCode: string }>; total: number };
    expect(employeesPage1.total).toBe(61);
    expect(employeesPage1.items).toHaveLength(50);
    expect(employeesPage2.items).toHaveLength(11);
    expect(employeesPage2.items.map((item) => item.employeeCode)).toContain(
      "PAGE-EMP-061",
    );
    const employeeSearch = (await service.employeeView(owner, undefined, {
      query: "PAGE-EMP-061",
    })) as { items: Array<{ employeeCode: string }>; total: number };
    expect(employeeSearch).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ employeeCode: "PAGE-EMP-061" })],
    });
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM app.employees WHERE tenant_id=$1::uuid AND employee_code LIKE 'PAGE-EMP-%'`,
        owner.activeTenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM app.organization_closure WHERE tenant_id=$1::uuid AND (ancestor_id IN (SELECT id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND code LIKE 'PAGE-ORG-%') OR descendant_id IN (SELECT id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND code LIKE 'PAGE-ORG-%'))`,
        owner.activeTenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM app.organization_nodes WHERE tenant_id=$1::uuid AND code LIKE 'PAGE-ORG-%'`,
        owner.activeTenantId,
      );
    });
  });

  it("MST01-C-001/C-004 returns stable ordered lists and rejects inactive Unicode references", async () => {
    const unicode = await service.createOrganization(
      owner,
      {
        code: "UNICODE",
        name: "Éastern Region",
        nodeType: "REGION",
        parentId: legalEntity,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-unicode-region",
      "mst01-unicode-region",
    );
    await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.organization_nodes SET state='INACTIVE',active_to=current_date WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        unicode.id,
      ),
    );
    const first = (await service.organizationView(owner)) as {
      items: Array<{ id: string; name: string; state: string }>;
      total: number;
    };
    const second = (await service.organizationView(owner)) as typeof first;
    expect(first.total).toBe(first.items.length);
    expect(second.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
    expect(first.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unicode.id,
          name: "Éastern Region",
          state: "INACTIVE",
        }),
      ]),
    );
    const detail = await service.organizationView(owner, String(unicode.id));
    expect(detail).toMatchObject({ id: unicode.id, name: "Éastern Region" });
    const filtered = (await service.organizationView(owner, undefined, {
      query: "éastern",
      state: "INACTIVE",
      nodeType: "REGION",
      limit: 1,
      offset: 0,
    })) as typeof first & { limit: number; offset: number };
    expect(filtered).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(filtered.items.map((item) => item.id)).toEqual([unicode.id]);
    const nextPage = (await service.organizationView(owner, undefined, {
      query: "éastern",
      state: "INACTIVE",
      nodeType: "REGION",
      limit: 1,
      offset: 1,
    })) as typeof filtered;
    expect(nextPage).toMatchObject({ total: 1, items: [], offset: 1 });
    const employeeFilter = (await service.employeeView(owner, undefined, {
      query: "EMP-01",
      state: "ACTIVE",
      limit: 1,
      offset: 0,
    })) as { total: number; items: Array<{ id: string }> };
    expect(employeeFilter).toMatchObject({ total: 1 });
    expect(employeeFilter.items.map((item) => item.id)).toEqual([employee]);
    await expect(
      service.createEmployee(
        owner,
        {
          employeeCode: "INACTIVE-REF",
          displayName: "Inactive Reference",
          designation: "Manager",
          homeNodeId: String(unicode.id),
          activeFrom: "2026-08-25",
        },
        "mst01-inactive-home",
        "mst01-inactive-home",
      ),
    ).rejects.toMatchObject({ code: "HOME_NODE_INVALID" });
  });

  it("MST01-C-003 rejects unsupported node and employee state transitions without mutation", async () => {
    const nodeBefore = (await service.organizationView(owner, region)) as {
      version: number;
    };
    const employeeBefore = (await service.employeeView(owner, employee)) as {
      version: number;
    };
    await expect(
      service.updateOrganization(
        owner,
        region,
        {
          expectedVersion: nodeBefore.version,
          reason: "Unsupported direct state transition",
          state: "INACTIVE",
        },
        "mst01-invalid-node-transition",
        "mst01-invalid-node-transition",
      ),
    ).rejects.toBeTruthy();
    await expect(
      service.updateEmployee(
        owner,
        employee,
        {
          expectedVersion: employeeBefore.version,
          reason: "Unsupported direct state transition",
          state: "INACTIVE",
        },
        "mst01-invalid-employee-transition",
        "mst01-invalid-employee-transition",
      ),
    ).rejects.toBeTruthy();
    await expect(
      service.updateOrganization(
        owner,
        region,
        {
          expectedVersion: nodeBefore.version,
          reason: "Reject reversed active dates",
          activeFrom: "2026-08-25",
          activeTo: "2026-08-24",
        },
        "mst01-invalid-node-dates",
        "mst01-invalid-node-dates",
      ),
    ).rejects.toBeTruthy();
    expect(await service.organizationView(owner, region)).toMatchObject({
      version: nodeBefore.version,
      state: "ACTIVE",
    });
    expect(await service.employeeView(owner, employee)).toMatchObject({
      version: employeeBefore.version,
      state: "ACTIVE",
    });
  });

  it("MST01-A-001 denies every known cross-tenant organization and employee command bidirectionally", async () => {
    const tenantBLegal = await service.createOrganization(
      otherOwner,
      {
        code: "LE-B",
        name: "Tenant B Legal Entity",
        nodeType: "LEGAL_ENTITY",
        parentId: null,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
      },
      "mst01-b-legal",
      "mst01-b-legal",
    );
    const tenantBEmployee = await service.createEmployee(
      otherOwner,
      {
        employeeCode: "EMP-B",
        displayName: "Tenant B Employee",
        designation: "Manager",
        homeNodeId: String(tenantBLegal.id),
        activeFrom: "2026-08-25",
      },
      "mst01-b-employee",
      "mst01-b-employee",
    );
    const directions = [
      {
        actor: owner,
        foreignOrganization: String(tenantBLegal.id),
        foreignEmployee: String(tenantBEmployee.id),
        localOrganization: region,
        localEmployee: employee,
        prefix: "a-to-b",
      },
      {
        actor: otherOwner,
        foreignOrganization: region,
        foreignEmployee: employee,
        localOrganization: String(tenantBLegal.id),
        localEmployee: String(tenantBEmployee.id),
        prefix: "b-to-a",
      },
    ];
    for (const direction of directions) {
      const attempts = [
        () =>
          service.organizationView(
            direction.actor,
            direction.foreignOrganization,
          ),
        () =>
          service.organizationImpact(
            direction.actor,
            direction.foreignOrganization,
          ),
        () => service.employeeView(direction.actor, direction.foreignEmployee),
        () =>
          service.employeeImpact(direction.actor, direction.foreignEmployee),
        () =>
          service.updateOrganization(
            direction.actor,
            direction.foreignOrganization,
            {
              expectedVersion: 1,
              reason: "Reject foreign update",
              name: "Denied",
            },
            `mst01-${direction.prefix}-org`,
            `mst01-${direction.prefix}-org`,
          ),
        () =>
          service.updateEmployee(
            direction.actor,
            direction.foreignEmployee,
            {
              expectedVersion: 1,
              reason: "Reject foreign update",
              designation: "Denied",
            },
            `mst01-${direction.prefix}-employee`,
            `mst01-${direction.prefix}-employee`,
          ),
        () =>
          service.createOrganization(
            direction.actor,
            {
              code: `FOREIGN-${direction.prefix}`,
              name: "Foreign parent attempt",
              nodeType: "REGION",
              parentId: direction.foreignOrganization,
              timezone: "Asia/Kolkata",
              activeFrom: "2026-08-25",
            },
            `mst01-${direction.prefix}-org-create`,
            `mst01-${direction.prefix}-org-create`,
          ),
        () =>
          service.createEmployee(
            direction.actor,
            {
              employeeCode: `FOREIGN-${direction.prefix}`,
              displayName: "Foreign home attempt",
              designation: "Manager",
              homeNodeId: direction.foreignOrganization,
              activeFrom: "2026-08-25",
            },
            `mst01-${direction.prefix}-employee-create`,
            `mst01-${direction.prefix}-employee-create`,
          ),
        () =>
          advanced.moveOrganization(
            direction.actor,
            direction.foreignOrganization,
            direction.localOrganization,
            1,
            "Reject foreign hierarchy move",
            `mst01-${direction.prefix}-move`,
            `mst01-${direction.prefix}-move`,
          ),
        () =>
          service.reassignDeactivateOrganization(
            direction.actor,
            direction.foreignOrganization,
            {
              replacementNodeId: direction.localOrganization,
              expectedVersion: 1,
              impactSnapshotId: "foreign-impact-snapshot",
              reason: "Reject foreign organization reassignment",
            },
            `mst01-${direction.prefix}-org-reassign`,
            `mst01-${direction.prefix}-org-reassign`,
          ),
        () =>
          advanced.reassignEmployee(
            direction.actor,
            direction.foreignEmployee,
            {
              replacementEmployeeId: direction.localEmployee,
              expectedVersion: 1,
              impactSnapshotId: "foreign-impact-snapshot",
              reason: "Reject foreign employee reassignment",
            },
            `mst01-${direction.prefix}-employee-reassign`,
            `mst01-${direction.prefix}-employee-reassign`,
          ),
      ];
      for (const attempt of attempts) {
        try {
          await attempt();
          throw new Error("Expected cross-tenant command to be rejected");
        } catch (error) {
          expect([400, 404]).toContain((error as { status?: number }).status);
        }
      }
      await expect(
        advanced.bulkAssignments(
          direction.actor,
          [
            {
              employeeId: direction.foreignEmployee,
              assignmentType: "MANAGER",
              organizationNodeId: direction.localOrganization,
              effectiveFrom: "2026-08-25T00:00:00.000Z",
            },
          ],
          `mst01-${direction.prefix}-assignment`,
          `mst01-${direction.prefix}-assignment`,
        ),
      ).rejects.toMatchObject({ status: 409, code: "EMPLOYEE_INACTIVE" });
    }
    const reports = await Promise.all([
      service.ownershipReport(owner),
      service.ownershipReport(otherOwner),
    ]);
    expect(JSON.stringify(reports[0])).not.toContain(tenantBEmployee.id);
    expect(JSON.stringify(reports[1])).not.toContain(employee);
    const exports = await Promise.all([
      service.ownershipExport(owner, "mst01-a-export-isolation"),
      service.ownershipExport(otherOwner, "mst01-b-export-isolation"),
    ]);
    expect(JSON.stringify(exports[0])).not.toContain(tenantBEmployee.id);
    expect(JSON.stringify(exports[1])).not.toContain(employee);
  });

  it("MST01-A-003/R-003 denies Client Viewer and anonymous access with correlation and rollback", async () => {
    const viewer = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        const user = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.users(email,display_name,password_hash) VALUES('mst01-viewer@test.local','MST Client Viewer','not-used') RETURNING id`,
          )
        )[0]!;
        const membership = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenant_memberships(tenant_id,user_id,invited_email,invited_name,employee_code,status)
             VALUES($1::uuid,$2::uuid,'mst01-viewer@test.local','MST Client Viewer','MST-VIEWER','ACTIVE') RETURNING id`,
            owner.activeTenantId,
            user.id,
          )
        )[0]!;
        return { userId: user.id, membershipId: membership.id };
      },
    );
    const viewerActor = {
      ...owner,
      userId: viewer.userId,
      membershipId: viewer.membershipId,
      email: "mst01-viewer@test.local",
    };
    await expect(service.organizationView(viewerActor)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    await expect(
      service.organizationView({
        ...owner,
        activeTenantId: null,
        membershipId: null,
      }),
    ).rejects.toMatchObject({ status: 403, code: "TENANT_REQUIRED" });
    const before = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{ nodes: number; audits: number; events: number }>
      >(
        `SELECT
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$1::uuid) nodes,
          (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid) audits,
          (SELECT count(*)::int FROM app.outbox_events WHERE tenant_id=$1::uuid) events`,
        owner.activeTenantId,
      ),
    );
    const correlation = "mst01-denied-correlation";
    const denied = await request(http.getHttpServer())
      .post("/api/v1/domain/masters/organization")
      .set("Cookie", `logistics_session=${ownerToken}`)
      .set("Origin", "http://127.0.0.1:3000")
      .set("X-CSRF-Token", "invalid-csrf")
      .set("X-Correlation-Id", correlation)
      .set("Idempotency-Key", "mst01-denied-create")
      .send({});
    expect(denied.status).toBe(403);
    expect(denied.headers["x-correlation-id"]).toBe(correlation);
    expect(denied.body).toMatchObject({ code: "CSRF_INVALID" });
    const after = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{ nodes: number; audits: number; events: number }>
      >(
        `SELECT
          (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=$1::uuid) nodes,
          (SELECT count(*)::int FROM audit.audit_events WHERE tenant_id=$1::uuid) audits,
          (SELECT count(*)::int FROM app.outbox_events WHERE tenant_id=$1::uuid) events`,
        owner.activeTenantId,
      ),
    );
    expect(after).toEqual(before);
    const auditRow = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; action: string }>>(
        `SELECT id,action FROM audit.audit_events WHERE tenant_id=$1::uuid ORDER BY occurred_at LIMIT 1`,
        owner.activeTenantId,
      ),
    );
    await expect(
      withTenant(app.db, owner.activeTenantId!, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE audit.audit_events SET action='tampered' WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          owner.activeTenantId,
          auditRow[0]!.id,
        ),
      ),
    ).rejects.toBeTruthy();
    const unchanged = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ action: string }>>(
        `SELECT action FROM audit.audit_events WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        auditRow[0]!.id,
      ),
    );
    expect(unchanged[0]!.action).toBe(auditRow[0]!.action);
  });

  it("MST01-R-001/002 reconciles export and idempotent ownership alerts", async () => {
    const clientId = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) =>
        String(
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,authorization_scope_node_id)
               SELECT $1::uuid,'UNOWNED-CLIENT','Unowned Client',id,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING id`,
              owner.activeTenantId,
              legalEntity,
            )
          )[0]!.id,
        ),
    );
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      const inactiveOwner = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO app.employees(tenant_id,employee_code,display_name,home_node_id,active_from,state,created_by)
         VALUES($1::uuid,'INACTIVE-OWNER','Inactive Owner',$2::uuid,current_date,'INACTIVE',$3::uuid) RETURNING id`,
          owner.activeTenantId,
          branch,
          owner.userId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,account_manager_employee_id,authorization_scope_node_id)
         SELECT $1::uuid,'INACTIVE-CLIENT','Inactive Client',id,$3::uuid,authorization_scope_node_id FROM app.organization_nodes WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        legalEntity,
        inactiveOwner.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity) VALUES($1::uuid,'NO-ESCALATION','No escalation','MST-01','WARNING')`,
        owner.activeTenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,recipient_policy,escalation_levels) VALUES($1::uuid,'MISSING-ESCALATION','Missing escalation','MST-01','WARNING',$2::jsonb,$3::jsonb)`,
        owner.activeTenantId,
        JSON.stringify({
          membershipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        JSON.stringify([
          { membershipId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ]),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,recipient_policy) VALUES($1::uuid,'METADATA-UUID','Metadata is not a recipient','MST-01','WARNING',$2::jsonb)`,
        owner.activeTenantId,
        JSON.stringify({ metadata: { traceId: owner.membershipId } }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,recipient_policy) VALUES($1::uuid,'ACTIVE-OWNERS','Dynamic tenant owners','MST-01','WARNING',$2::jsonb)`,
        owner.activeTenantId,
        JSON.stringify({ owners: true }),
      );
      const inactiveMembership = (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `UPDATE app.tenant_memberships SET status='SUSPENDED',updated_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND employee_code='LIMITED-MST01' RETURNING id`,
          owner.activeTenantId,
        )
      )[0]!;
      await tx.$executeRawUnsafe(
        `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,recipient_policy) VALUES($1::uuid,'INACTIVE-ESCALATION','Inactive escalation','MST-01','WARNING',$2::jsonb)`,
        owner.activeTenantId,
        JSON.stringify({ membershipId: inactiveMembership.id }),
      );
    });
    const first = await service.evaluateOwnershipAlerts(owner);
    const second = await service.evaluateOwnershipAlerts(owner);
    expect(first.open).toBeGreaterThan(0);
    expect(second).toEqual(first);
    const report = await service.ownershipReport(owner);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: clientId,
          resourceKind: "clients",
          ownershipState: "UNOWNED",
        }),
      ]),
    );
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING-ESCALATION",
          ownershipState: "NO_ESCALATION",
        }),
        expect.objectContaining({
          code: "INACTIVE-ESCALATION",
          ownershipState: "NO_ESCALATION",
        }),
        expect.objectContaining({
          code: "METADATA-UUID",
          ownershipState: "NO_ESCALATION",
        }),
        expect.objectContaining({
          code: "ACTIVE-OWNERS",
          ownershipState: "OWNED",
        }),
      ]),
    );
    expect(report.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertType: "ownership.unowned",
          sourceRecordId: clientId,
        }),
      ]),
    );
    expect(report.alerts.map((alert) => alert.alertType)).toEqual(
      expect.arrayContaining([
        "ownership.unowned",
        "ownership.inactive_owner",
        "ownership.no_escalation",
      ]),
    );
    expect(report).toMatchObject({
      unowned: expect.any(Number),
      inactiveOwner: expect.any(Number),
      noEscalation: expect.any(Number),
    });
    const exported = await service.ownershipExport(owner, "mst01-export");
    expect(exported.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNOWNED-CLIENT",
          resourceKind: "clients",
          ownershipState: "UNOWNED",
        }),
      ]),
    );
    expect(JSON.stringify(exported)).not.toContain("employee@example.test");
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE app.clients SET account_manager_employee_id=$1::uuid WHERE tenant_id=$2::uuid AND id=$3::uuid`,
        employee,
        owner.activeTenantId,
        clientId,
      );
    });
    await service.evaluateOwnershipAlerts(owner);
    const state = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ state: string; occurrence_count: number }>>(
        `SELECT state,occurrence_count FROM app.operational_alerts WHERE tenant_id=$1::uuid AND source_record_id=$2::uuid AND alert_type='ownership.unowned'`,
        owner.activeTenantId,
        clientId,
      ),
    );
    expect(state).toEqual([{ state: "RESOLVED", occurrence_count: 1 }]);
  });

  it("MST01-I-006 migrates grants off a deactivated organization scope", async () => {
    const replacement = await service.createOrganization(
      owner,
      {
        code: "BLR-REPLACEMENT",
        name: "Bengaluru Replacement",
        nodeType: "BRANCH",
        parentId: region,
        timezone: "Asia/Kolkata",
        activeFrom: "2026-08-25",
        address: {
          line1: "2 Replacement Road",
          country: "IN",
          postalCode: "560043",
          postalLocalityId: "56004300-0000-4000-8000-000000000001",
        },
      },
      "mst01-branch-replacement",
      "mst01-branch-replacement",
    );
    const detail = (await service.organizationView(owner, branch)) as {
      version: number;
      authorizationScopeNodeId: string;
    };
    const organizationRefs = await withTenant(
      app.db,
      owner.activeTenantId!,
      async (tx) => {
        const client = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.clients(tenant_id,code,legal_name,billing_entity_id,authorization_scope_node_id) VALUES($1::uuid,'ORG-MOVE-CLIENT','Org Move Client',$2::uuid,$3::uuid) RETURNING id`,
            owner.activeTenantId,
            branch,
            detail.authorizationScopeNodeId,
          )
        )[0]!;
        const rule = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.alert_rules(tenant_id,code,name,source_module,severity,scope_node_ids,recipient_policy) VALUES($1::uuid,'ORG-MOVE-RULE','Org move rule','MST-01','WARNING',ARRAY[$2::uuid],$3::jsonb) RETURNING id`,
            owner.activeTenantId,
            detail.authorizationScopeNodeId,
            JSON.stringify({
              scopeId: detail.authorizationScopeNodeId,
              nodeId: branch,
            }),
          )
        )[0]!;
        const vendorScope = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.vendor_service_scopes(tenant_id,vendor_id,organization_node_id,effective_from) SELECT $1::uuid,id,$2::uuid,now() FROM app.vendors WHERE tenant_id=$1::uuid AND code='REASSIGN-VENDOR' RETURNING id`,
            owner.activeTenantId,
            branch,
          )
        )[0]!;
        const assignment = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.operational_assignments(tenant_id,employee_id,assignment_type,organization_node_id,effective_from,exception_reason,created_by)
             SELECT $1::uuid,id,'MANAGER',$2::uuid,now()-interval '1 day','Initial branch coverage',$3::uuid
             FROM app.employees WHERE tenant_id=$1::uuid AND state='ACTIVE' ORDER BY employee_code LIMIT 1 RETURNING id`,
            owner.activeTenantId,
            branch,
            owner.userId,
          )
        )[0]!;
        return {
          client: client.id,
          rule: rule.id,
          vendorScope: vendorScope.id,
          assignment: assignment.id,
        };
      },
    );
    const organizationImpact = await service.organizationImpact(owner, branch);
    expect(organizationImpact.categories.clients.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: organizationRefs.client, version: 1 }),
      ]),
    );
    expect(organizationImpact.categories.alertRules.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: organizationRefs.rule, version: 1 }),
      ]),
    );
    await withTenant(app.db, owner.activeTenantId!, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE app.vendor_service_scopes SET effective_from=effective_from-interval '1 minute' WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        organizationRefs.vendorScope,
      );
      await tx.$executeRawUnsafe(
        `UPDATE app.operational_assignments SET exception_reason='Updated branch coverage' WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        owner.activeTenantId,
        organizationRefs.assignment,
      );
    });
    await expect(
      service.reassignDeactivateOrganization(
        owner,
        branch,
        {
          replacementNodeId: String(replacement.id),
          expectedVersion: detail.version,
          impactSnapshotId: String(organizationImpact.snapshotId),
          reason: "Reject stale material impact",
        },
        "mst01-org-impact-stale",
        "mst01-org-impact-stale-key",
      ),
    ).rejects.toMatchObject({ code: "IMPACT_CHANGED" });
    const refreshedOrganizationImpact = await service.organizationImpact(
      owner,
      branch,
    );
    const organizationReassignInput = {
      replacementNodeId: String(replacement.id),
      expectedVersion: detail.version,
      impactSnapshotId: String(refreshedOrganizationImpact.snapshotId),
      reason: "Consolidate branch responsibility and access",
    };
    const deactivated = await service.reassignDeactivateOrganization(
      owner,
      branch,
      organizationReassignInput,
      "mst01-org-scope-transfer",
      "mst01-org-scope-transfer-key",
    );
    const deactivationReplay = await service.reassignDeactivateOrganization(
      owner,
      branch,
      organizationReassignInput,
      "mst01-org-scope-transfer-retry",
      "mst01-org-scope-transfer-key",
    );
    expect(deactivationReplay).toMatchObject({
      id: deactivated.id,
      replayed: true,
    });
    const migratedRefs = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          clientNode: string;
          clientScope: string;
          vendorNode: string;
          ruleScope: string;
          ruleNode: string;
        }>
      >(
        `SELECT
      (SELECT billing_entity_id FROM app.clients WHERE tenant_id=$1::uuid AND id=$2::uuid) "clientNode",
      (SELECT authorization_scope_node_id FROM app.clients WHERE tenant_id=$1::uuid AND id=$2::uuid) "clientScope",
      (SELECT organization_node_id FROM app.vendor_service_scopes WHERE tenant_id=$1::uuid AND id=$3::uuid) "vendorNode",
      (SELECT scope_node_ids[1] FROM app.alert_rules WHERE tenant_id=$1::uuid AND id=$4::uuid) "ruleScope",
      (SELECT recipient_policy->>'nodeId' FROM app.alert_rules WHERE tenant_id=$1::uuid AND id=$4::uuid) "ruleNode"`,
        owner.activeTenantId,
        organizationRefs.client,
        organizationRefs.vendorScope,
        organizationRefs.rule,
      ),
    );
    expect(migratedRefs[0]).toMatchObject({
      clientNode: replacement.id,
      clientScope: replacement.authorization_scope_node_id,
      vendorNode: replacement.id,
      ruleScope: replacement.authorization_scope_node_id,
      ruleNode: replacement.id,
    });
    const reconciled = await withTenant(app.db, owner.activeTenantId!, (tx) =>
      tx.$queryRawUnsafe<Array<{ oldActive: number; employeesMoved: number }>>(
        `SELECT
             (SELECT count(*)::int FROM app.scope_grants WHERE tenant_id=$1::uuid AND scope_node_id=$2::uuid AND status='ACTIVE') "oldActive",
             (SELECT count(*)::int FROM app.employees WHERE tenant_id=$1::uuid AND home_node_id=$3::uuid) "employeesMoved"`,
        owner.activeTenantId,
        detail.authorizationScopeNodeId,
        replacement.id,
      ),
    );
    expect(reconciled[0]!.oldActive).toBe(0);
    expect(reconciled[0]!.employeesMoved).toBeGreaterThan(0);
  });
});
