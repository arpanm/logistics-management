import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appService = readFileSync(
  new URL("../src/app.service.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/202608250027_tenant_legal_entity_root/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("FND01-TENANT-ROOT — Implemented / Not Run", () => {
  it("provisions the canonical legal-entity organization and its scope in the tenant transaction", () => {
    const provision = appService.slice(
      appService.indexOf("async provision("),
      appService.indexOf("async listTenants("),
    );

    expect(provision).toContain(
      "INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id)",
    );
    expect(provision).toContain("'LEGAL_ENTITY'");
    expect(provision).toContain("INSERT INTO app.organization_nodes(");
    expect(provision).toContain(
      "INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)",
    );
    expect(provision).toContain("canonical_resource_id=$1::uuid");
    expect(provision).toContain("input.legalEntity.name");
    expect(provision).toContain("input.timezone");
    expect(provision).toContain("organizationAddress");
  });

  it("marks organization setup complete only after creating its underlying canonical record", () => {
    const organizationInsert = appService.indexOf(
      "INSERT INTO app.organization_nodes(",
    );
    const checklistInsert = appService.indexOf(
      "INSERT INTO app.setup_checklist_items(",
      organizationInsert,
    );

    expect(organizationInsert).toBeGreaterThan(-1);
    expect(checklistInsert).toBeGreaterThan(organizationInsert);
    expect(
      appService.slice(checklistInsert, checklistInsert + 1_200),
    ).toContain('keys[i]![0] === "organization"');
  });

  it("repairs a single candidate, adopts top-level nodes, and rebuilds closure", () => {
    expect(migration).toContain("candidate.id AS candidate_id");
    expect(migration).toContain("parent_id = NULL");
    expect(migration).toContain("id <> organization_id AND parent_id IS NULL");
    expect(migration).toContain(
      "DELETE FROM app.organization_closure WHERE tenant_id = tenant_row.id",
    );
    expect(migration).toContain("WITH RECURSIVE closure_rows");
    expect(migration).toContain(
      "PERFORM app.reconcile_organization_subtree_scopes",
    );
    expect(migration).toContain("IF item.node_type='LEGAL_ENTITY' THEN");
    expect(migration).toContain("scope_type='TENANT' AND status='ACTIVE'");
    expect(migration).toContain("canonical_resource_id = organization_id");
    expect(migration).toContain(
      "'organization', 'Organization', 1, 'COMPLETE'",
    );
  });

  it("selects one deterministic company root while preserving additional legal entities", () => {
    expect(migration).toContain("node.code = le.code");
    expect(migration).toContain("lower(node.name) = lower(le.name)");
    expect(migration).toContain(
      "WHEN node.state = 'ACTIVE' AND node.parent_id IS NULL THEN 1",
    );
    expect(migration).toContain("WHILE EXISTS (");
    expect(migration).toContain("collision_number := collision_number + 1");
    expect(migration).toContain("Canonical LEGAL_ENTITY root invariant failed");
    expect(migration).not.toContain("HAVING count(*) > 1");
    expect(migration).toContain(
      "node_scope.parent_id IS DISTINCT FROM parent_node.authorization_scope_node_id",
    );
    expect(migration).toContain(
      "node_scope.parent_id IS DISTINCT FROM tenant_scope_id",
    );
    expect(migration).toContain("node.node_type IN ('TEAM','HUB')");
    expect(migration).toContain(
      "node.authorization_scope_node_id IS DISTINCT FROM parent_node.authorization_scope_node_id",
    );
  });

  it("does not require a seeded platform administrator on an empty database", () => {
    expect(migration).toContain("FOR tenant_row IN");
    expect(migration).toContain(
      "tenant_row.candidate_id IS NULL AND actor_id IS NULL",
    );
    expect(migration).not.toMatch(/admin@|00000000-/i);
  });
});
