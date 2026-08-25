BEGIN;
SELECT set_config('app.platform_context','on',true);

-- Forward repair for databases that applied the original one-level 019
-- backfill before HUB > TEAM legacy chains were discovered.
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
      SELECT authorization_scope_node_id INTO inherited_scope FROM app.organization_nodes
      WHERE tenant_id=item.tenant_id AND id=item.parent_id;
      UPDATE app.organization_nodes SET authorization_scope_node_id=inherited_scope
      WHERE tenant_id=item.tenant_id AND id=item.id
        AND authorization_scope_node_id IS DISTINCT FROM inherited_scope;
    END LOOP;
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;

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
