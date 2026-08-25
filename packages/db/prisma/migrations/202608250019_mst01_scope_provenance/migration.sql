BEGIN;
SELECT set_config('app.platform_context','on',true);

-- Give pre-MST organization subtrees canonical scopes without invalidating
-- broader tenant grants. Parents are processed before children.
DO $$
DECLARE kind text; item record; parent_scope uuid;
BEGIN
  FOREACH kind IN ARRAY ARRAY['LEGAL_ENTITY','REGION','BRANCH'] LOOP
    FOR item IN
      SELECT n.* FROM app.organization_nodes n
      LEFT JOIN app.authorization_scope_nodes s ON s.tenant_id=n.tenant_id AND s.id=n.authorization_scope_node_id
      WHERE n.node_type=kind AND s.canonical_resource_id IS DISTINCT FROM n.id
      ORDER BY n.tenant_id,n.id
    LOOP
      IF kind='LEGAL_ENTITY' THEN
        SELECT id INTO parent_scope FROM app.authorization_scope_nodes
        WHERE tenant_id=item.tenant_id AND scope_type='TENANT' AND status='ACTIVE';
      ELSE
        SELECT authorization_scope_node_id INTO parent_scope FROM app.organization_nodes
        WHERE tenant_id=item.tenant_id AND id=item.parent_id;
      END IF;
      INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id,canonical_resource_id,status)
      VALUES(item.tenant_id,kind,'ORG-'||item.id::text,item.name,parent_scope,item.id,item.state)
      RETURNING id INTO parent_scope;
      UPDATE app.organization_nodes SET authorization_scope_node_id=parent_scope WHERE tenant_id=item.tenant_id AND id=item.id;
    END LOOP;
  END LOOP;
END $$;

-- TEAM/HUB resources inherit the nearest canonical ancestor scope because the
-- FND-02 taxonomy intentionally stops at branch granularity.  Resolve the
-- entire legacy tail in parent-before-child order (for example BRANCH > HUB >
-- TEAM), rather than relying on one UPDATE snapshot that leaves TEAM pointing
-- at HUB's former tenant scope.
DO $$
DECLARE level_no integer; item record; inherited_scope uuid;
BEGIN
  FOR level_no IN 1..100 LOOP
    FOR item IN
      WITH RECURSIVE tail AS (
        SELECT n.tenant_id,n.id,n.parent_id,1 depth
        FROM app.organization_nodes n
        JOIN app.organization_nodes p ON p.tenant_id=n.tenant_id AND p.id=n.parent_id
        WHERE n.node_type IN ('TEAM','HUB') AND p.node_type NOT IN ('TEAM','HUB')
        UNION ALL
        SELECT n.tenant_id,n.id,n.parent_id,t.depth+1
        FROM app.organization_nodes n JOIN tail t ON t.tenant_id=n.tenant_id AND t.id=n.parent_id
        WHERE n.node_type IN ('TEAM','HUB') AND t.depth<100
      ) SELECT * FROM tail WHERE depth=level_no ORDER BY tenant_id,id
    LOOP
      SELECT authorization_scope_node_id INTO inherited_scope
      FROM app.organization_nodes WHERE tenant_id=item.tenant_id AND id=item.parent_id;
      UPDATE app.organization_nodes SET authorization_scope_node_id=inherited_scope
      WHERE tenant_id=item.tenant_id AND id=item.id
        AND authorization_scope_node_id IS DISTINCT FROM inherited_scope;
    END LOOP;
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;

CREATE TABLE app.employee_scope_grant_links (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  coverage_kind text NOT NULL CHECK(coverage_kind IN ('HOME','REGION')),
  organization_node_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,grant_id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,grant_id) REFERENCES app.scope_grants(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX employee_scope_grant_links_employee ON app.employee_scope_grant_links(tenant_id,employee_id,state,coverage_kind);
ALTER TABLE app.employee_scope_grant_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employee_scope_grant_links FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_scope_grant_links_tenant_isolation ON app.employee_scope_grant_links
USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');

-- Replace only typed JSON string values.  This avoids corrupting unrelated
-- text that merely contains a membership UUID as a substring.
CREATE OR REPLACE FUNCTION app.jsonb_replace_string(document jsonb, old_value text, new_value text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE jsonb_typeof(document)
    WHEN 'string' THEN CASE WHEN document = to_jsonb(old_value) THEN to_jsonb(new_value) ELSE document END
    WHEN 'array' THEN (SELECT coalesce(jsonb_agg(app.jsonb_replace_string(value,old_value,new_value) ORDER BY ordinality),'[]'::jsonb) FROM jsonb_array_elements(document) WITH ORDINALITY)
    WHEN 'object' THEN (SELECT coalesce(jsonb_object_agg(key,app.jsonb_replace_string(value,old_value,new_value)),'{}'::jsonb) FROM jsonb_each(document))
    ELSE document END
$$;
REVOKE ALL ON FUNCTION app.jsonb_replace_string(jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_replace_string(jsonb,text,text) TO logistics_app;

COMMIT;
