import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, withPlatform } from "@logistics/db";

const execFileAsync = promisify(execFile);
const migrationPath = fileURLToPath(
  new URL(
    "../../../packages/db/prisma/migrations/202608250027_tenant_legal_entity_root/migration.sql",
    import.meta.url,
  ),
);
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.sequential(
  "FND01-TENANT-ROOT migration integration — Implemented / Not Run",
  () => {
    const db = createDatabase(databaseUrl);
    const tenantIds: string[] = [];
    let actorId = "";

    const runMigration = () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      return execFileAsync("psql", [
        databaseUrl,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        migrationPath,
      ]);
    };

    const createTenant = async (label: string, legalCode: string) =>
      withPlatform(db, async (tx) => {
        const code = `${label}-${randomUUID().slice(0, 6)}`.toUpperCase();
        const tenant = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.tenants(
               code,name,legal_name,tax_identifier,address,timezone,locale,currency,
               fiscal_month,fiscal_day,support_name,support_email,short_name,
               primary_color,accent_color,status
             ) VALUES(
               $1,$2,$3,$4,$5::jsonb,'Asia/Kolkata','en-IN','INR',4,1,
               'Support',$6,$7,'#16324F','#D97706','ACTIVE'
             ) RETURNING id`,
            code,
            `${label} Logistics`,
            `${label} Logistics Limited`,
            `TAX-${code}`,
            JSON.stringify({
              line1: "1 Test Road",
              city: "Bengaluru",
              region: "Karnataka",
              postalCode: "560001",
              country: "IN",
            }),
            `support-${code.toLowerCase()}@test.local`,
            label.slice(0, 20),
          )
        )[0]!;
        tenantIds.push(tenant.id);
        await tx.$executeRawUnsafe(
          `INSERT INTO app.legal_entities(tenant_id,code,name,is_default)
           VALUES($1::uuid,$2,$3,true)`,
          tenant.id,
          legalCode,
          `${label} Legal Entity`,
        );
        const tenantScope = (
          await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name)
             VALUES($1::uuid,'TENANT','TENANT','Entire tenant') RETURNING id`,
            tenant.id,
          )
        )[0]!;
        await tx.$executeRawUnsafe(
          `INSERT INTO app.setup_checklist_items(tenant_id,key,label,display_order,state)
           VALUES($1::uuid,'organization','Organization',1,'NOT_STARTED')`,
          tenant.id,
        );
        return { tenantId: tenant.id, tenantScopeId: tenantScope.id };
      });

    const createNode = async (
      tenantId: string,
      code: string,
      type: "LEGAL_ENTITY" | "REGION" | "BRANCH" | "TEAM" | "HUB",
      state: "ACTIVE" | "INACTIVE" = "ACTIVE",
      parentId?: string,
    ) =>
      withPlatform(
        db,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.organization_nodes(
               tenant_id,code,name,node_type,parent_id,timezone,active_from,state,created_by
             ) VALUES($1::uuid,$2,$2,$3,$4::uuid,'Asia/Kolkata',current_date,$5,$6::uuid)
             RETURNING id`,
              tenantId,
              code,
              type,
              parentId ?? null,
              state,
              actorId,
            )
          )[0]!,
      );

    const createScope = async (
      tenantId: string,
      type: "LEGAL_ENTITY" | "REGION" | "BRANCH",
      code: string,
      parentId: string,
      canonicalResourceId?: string,
    ) =>
      withPlatform(
        db,
        async (tx) =>
          (
            await tx.$queryRawUnsafe<Array<{ id: string }>>(
              `INSERT INTO app.authorization_scope_nodes(
               tenant_id,scope_type,code,name,parent_id,canonical_resource_id
             ) VALUES($1::uuid,$2,$3,$3,$4::uuid,$5::uuid) RETURNING id`,
              tenantId,
              type,
              code,
              parentId,
              canonicalResourceId ?? null,
            )
          )[0]!,
      );

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      actorId = String(
        (
          await db.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM app.users ORDER BY is_platform_admin DESC,created_at,id LIMIT 1`,
          )
        )[0]!.id,
      );
    });

    afterAll(async () => {
      if (tenantIds.length)
        await withPlatform(db, async (tx) => {
          await tx.$executeRawUnsafe(
            `DELETE FROM app.organization_closure WHERE tenant_id=ANY($1::uuid[])`,
            tenantIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.organization_nodes WHERE tenant_id=ANY($1::uuid[])`,
            tenantIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.authorization_scope_nodes WHERE tenant_id=ANY($1::uuid[])`,
            tenantIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.setup_checklist_items WHERE tenant_id=ANY($1::uuid[])`,
            tenantIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.legal_entities WHERE tenant_id=ANY($1::uuid[])`,
            tenantIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM app.tenants WHERE id=ANY($1::uuid[])`,
            tenantIds,
          );
        });
      await db.$disconnect();
    });

    it("repairs missing and partial roots, adopts top-level nodes, rebuilds closure, and replays without duplicates", async () => {
      const missing = await createTenant("ROOTMISS", "ROOT");
      await createNode(missing.tenantId, "ROOT", "BRANCH");
      await createNode(missing.tenantId, "ROOT-LEGAL-1", "BRANCH");
      await createNode(missing.tenantId, "ROOT-LEGAL-2", "REGION");

      const partial = await createTenant("ROOTPART", "PARTIAL");
      const formerTop = await createNode(partial.tenantId, "NORTH", "REGION");
      const inactiveRoot = await createNode(
        partial.tenantId,
        "PARTIAL",
        "LEGAL_ENTITY",
        "INACTIVE",
        formerTop.id,
      );
      const oldLegalScope = await createScope(
        partial.tenantId,
        "LEGAL_ENTITY",
        "PARTIAL-OLD",
        partial.tenantScopeId,
        inactiveRoot.id,
      );
      await createScope(
        partial.tenantId,
        "LEGAL_ENTITY",
        "PARTIAL-NEWER",
        partial.tenantScopeId,
        inactiveRoot.id,
      );
      const regionScope = await createScope(
        partial.tenantId,
        "REGION",
        "NORTH-SCOPE",
        partial.tenantScopeId,
        formerTop.id,
      );
      const branch = await createNode(
        partial.tenantId,
        "NORTH-BRANCH",
        "BRANCH",
        "ACTIVE",
        formerTop.id,
      );
      const branchScope = await createScope(
        partial.tenantId,
        "BRANCH",
        "NORTH-BRANCH-SCOPE",
        oldLegalScope.id,
        branch.id,
      );
      await createNode(
        partial.tenantId,
        "NORTH-TEAM",
        "TEAM",
        "ACTIVE",
        formerTop.id,
      );
      await createNode(
        partial.tenantId,
        "NORTH-HUB",
        "HUB",
        "ACTIVE",
        formerTop.id,
      );
      await withPlatform(db, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE app.organization_nodes
           SET authorization_scope_node_id=CASE
             WHEN id=$2::uuid THEN $3::uuid WHEN id=$4::uuid THEN $5::uuid
             ELSE authorization_scope_node_id END
           WHERE tenant_id=$1::uuid AND id IN ($2::uuid,$4::uuid)`,
          partial.tenantId,
          formerTop.id,
          regionScope.id,
          branch.id,
          branchScope.id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
           VALUES($1::uuid,$2::uuid,$2::uuid,0)`,
          partial.tenantId,
          formerTop.id,
        );
      });

      await runMigration();
      const first = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            tenantId: string;
            rootId: string;
            code: string;
            state: string;
            parentId: string | null;
            scopeId: string;
            descendants: number;
            checklist: string;
          }>
        >(
          `SELECT n.tenant_id AS "tenantId",n.id AS "rootId",n.code,n.state,n.parent_id AS "parentId",
             n.authorization_scope_node_id AS "scopeId",
             (SELECT count(*)::int FROM app.organization_closure c WHERE c.tenant_id=n.tenant_id AND c.ancestor_id=n.id) descendants,
             (SELECT state FROM app.setup_checklist_items i WHERE i.tenant_id=n.tenant_id AND i.key='organization') checklist
           FROM app.organization_nodes n
           WHERE n.tenant_id=ANY($1::uuid[]) AND n.node_type='LEGAL_ENTITY'
           ORDER BY n.tenant_id`,
          [missing.tenantId, partial.tenantId],
        ),
      );
      expect(first).toHaveLength(2);
      expect(first).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId: missing.tenantId,
            code: "ROOT-LEGAL-3",
            state: "ACTIVE",
            parentId: null,
            descendants: 4,
            checklist: "COMPLETE",
          }),
          expect.objectContaining({
            tenantId: partial.tenantId,
            rootId: inactiveRoot.id,
            state: "ACTIVE",
            parentId: null,
            descendants: 5,
            checklist: "COMPLETE",
          }),
        ]),
      );

      await runMigration();
      const replay = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ tenantId: string; rootId: string; total: number }>
        >(
          `SELECT n.tenant_id AS "tenantId",min(n.id::text) AS "rootId",count(*)::int total
           FROM app.organization_nodes n
           WHERE n.tenant_id=ANY($1::uuid[]) AND n.node_type='LEGAL_ENTITY'
           GROUP BY n.tenant_id ORDER BY n.tenant_id`,
          [missing.tenantId, partial.tenantId],
        ),
      );
      expect(
        replay.map(({ tenantId, rootId, total }) => ({
          tenantId,
          rootId,
          total,
        })),
      ).toEqual(
        first.map(({ tenantId, rootId }) => ({ tenantId, rootId, total: 1 })),
      );
      expect(new Set(first.map((row) => row.scopeId)).size).toBe(2);
      const isolatedBindings = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            tenantId: string;
            scopeTenantId: string;
            parentTenantId: string;
          }>
        >(
          `SELECT node.tenant_id AS "tenantId",scope.tenant_id AS "scopeTenantId",
                  parent.tenant_id AS "parentTenantId"
           FROM app.organization_nodes node
           JOIN app.authorization_scope_nodes scope
             ON scope.tenant_id=node.tenant_id AND scope.id=node.authorization_scope_node_id
           JOIN app.authorization_scope_nodes parent
             ON parent.tenant_id=scope.tenant_id AND parent.id=scope.parent_id
           WHERE node.tenant_id=ANY($1::uuid[]) AND node.node_type='LEGAL_ENTITY'
           ORDER BY node.tenant_id`,
          [missing.tenantId, partial.tenantId],
        ),
      );
      expect(isolatedBindings).toHaveLength(2);
      for (const binding of isolatedBindings) {
        expect(binding.scopeTenantId).toBe(binding.tenantId);
        expect(binding.parentTenantId).toBe(binding.tenantId);
      }
      const descendantScopes = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            type: string;
            scopeParentId: string;
            expectedParentId: string;
          }>
        >(
          `SELECT node.node_type AS type,scope.parent_id AS "scopeParentId",
                  parent.authorization_scope_node_id AS "expectedParentId"
           FROM app.organization_nodes node
           JOIN app.organization_nodes parent
             ON parent.tenant_id=node.tenant_id AND parent.id=node.parent_id
           JOIN app.authorization_scope_nodes scope
             ON scope.tenant_id=node.tenant_id AND scope.id=node.authorization_scope_node_id
           WHERE node.tenant_id=$1::uuid AND node.node_type IN ('REGION','BRANCH')
           ORDER BY node.node_type`,
          partial.tenantId,
        ),
      );
      expect(descendantScopes.map((row) => row.type)).toEqual([
        "BRANCH",
        "REGION",
      ]);
      for (const scope of descendantScopes)
        expect(scope.scopeParentId).toBe(scope.expectedParentId);
      const inheritedScopes = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ type: string; scopeId: string; expectedScopeId: string }>
        >(
          `SELECT node.node_type AS type,
                  node.authorization_scope_node_id AS "scopeId",
                  parent.authorization_scope_node_id AS "expectedScopeId"
           FROM app.organization_nodes node
           JOIN app.organization_nodes parent
             ON parent.tenant_id=node.tenant_id AND parent.id=node.parent_id
           WHERE node.tenant_id=$1::uuid AND node.node_type IN ('TEAM','HUB')
           ORDER BY node.node_type`,
          partial.tenantId,
        ),
      );
      expect(inheritedScopes.map((row) => row.type)).toEqual(["HUB", "TEAM"]);
      for (const scope of inheritedScopes)
        expect(scope.scopeId).toBe(scope.expectedScopeId);
      const rootCanonicalScopes = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<Array<{ total: number }>>(
          `SELECT count(*)::int total FROM app.authorization_scope_nodes
           WHERE tenant_id=$1::uuid AND scope_type='LEGAL_ENTITY'
             AND canonical_resource_id=$2::uuid`,
          partial.tenantId,
          inactiveRoot.id,
        ),
      );
      expect(rootCanonicalScopes[0]?.total).toBe(1);
    });

    it("repairs a legacy legal scope shared with a branch without losing either organization", async () => {
      const shared = await createTenant("ROOTSHARE", "SHARED");
      const root = await createNode(shared.tenantId, "SHARED", "LEGAL_ENTITY");
      const branch = await createNode(
        shared.tenantId,
        "SHARED-BRANCH",
        "BRANCH",
        "ACTIVE",
        root.id,
      );
      const sharedScope = await createScope(
        shared.tenantId,
        "LEGAL_ENTITY",
        "SHARED-SCOPE",
        shared.tenantScopeId,
        root.id,
      );
      await withPlatform(db, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE app.organization_nodes SET authorization_scope_node_id=$1::uuid
           WHERE tenant_id=$2::uuid AND id IN ($3::uuid,$4::uuid)`,
          sharedScope.id,
          shared.tenantId,
          root.id,
          branch.id,
        ),
      );

      await runMigration();
      const repaired = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{
            rootScopeId: string;
            branchScopeId: string;
            branchScopeType: string;
            branchScopeParentId: string;
            checklist: string;
          }>
        >(
          `SELECT root.authorization_scope_node_id AS "rootScopeId",
                  branch.authorization_scope_node_id AS "branchScopeId",
                  branch_scope.scope_type AS "branchScopeType",
                  branch_scope.parent_id AS "branchScopeParentId",
                  checklist.state AS checklist
           FROM app.organization_nodes root
           JOIN app.organization_nodes branch
             ON branch.tenant_id=root.tenant_id AND branch.id=$3::uuid
           JOIN app.authorization_scope_nodes branch_scope
             ON branch_scope.tenant_id=branch.tenant_id
            AND branch_scope.id=branch.authorization_scope_node_id
           JOIN app.setup_checklist_items checklist
             ON checklist.tenant_id=root.tenant_id AND checklist.key='organization'
           WHERE root.tenant_id=$1::uuid AND root.id=$2::uuid`,
          shared.tenantId,
          root.id,
          branch.id,
        ),
      );
      expect(repaired[0]).toMatchObject({
        branchScopeType: "BRANCH",
        checklist: "COMPLETE",
      });
      expect(repaired[0]?.branchScopeId).not.toBe(repaired[0]?.rootScopeId);
      expect(repaired[0]?.branchScopeParentId).toBe(repaired[0]?.rootScopeId);
    });

    it("preserves 61 legal entities and selects the default-matching active company root", async () => {
      const duplicate = await createTenant("ROOTDUP", "DUPROOT");
      const first = await createNode(
        duplicate.tenantId,
        "DUPROOT",
        "LEGAL_ENTITY",
      );
      await createNode(duplicate.tenantId, "DUPROOT-B", "LEGAL_ENTITY");
      for (let index = 3; index <= 61; index += 1)
        await createNode(
          duplicate.tenantId,
          `DUPROOT-${String(index).padStart(2, "0")}`,
          "LEGAL_ENTITY",
        );

      await runMigration();
      const organizations = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ id: string; parentId: string | null; state: string }>
        >(
          `SELECT id,parent_id AS "parentId",state FROM app.organization_nodes
           WHERE tenant_id=$1::uuid AND node_type='LEGAL_ENTITY' ORDER BY id`,
          duplicate.tenantId,
        ),
      );
      expect(organizations).toHaveLength(61);
      expect(organizations.find((node) => node.id === first.id)).toMatchObject({
        parentId: null,
        state: "ACTIVE",
      });
      expect(
        organizations
          .filter((node) => node.id !== first.id)
          .every((node) => node.parentId === first.id),
      ).toBe(true);
      const invalidLegalScopeParents = await withPlatform(db, (tx) =>
        tx.$queryRawUnsafe<Array<{ total: number }>>(
          `SELECT count(*)::int total
           FROM app.organization_nodes node
           JOIN app.authorization_scope_nodes scope
             ON scope.tenant_id=node.tenant_id AND scope.id=node.authorization_scope_node_id
           WHERE node.tenant_id=$1::uuid AND node.node_type='LEGAL_ENTITY'
             AND scope.parent_id IS DISTINCT FROM $2::uuid`,
          duplicate.tenantId,
          duplicate.tenantScopeId,
        ),
      );
      expect(invalidLegalScopeParents[0]?.total).toBe(0);
    });
  },
);
