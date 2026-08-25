BEGIN;
SELECT set_config('app.platform_context','on',true);

DROP TRIGGER IF EXISTS capability_catalog_read_only ON app.capability_catalog;
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,delegable)
VALUES ('masters.exception','Business','Approve temporary master deactivation exceptions',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,'masters.exception' FROM app.roles r WHERE r.code='TENANT_OWNER'
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_read_only
BEFORE INSERT OR UPDATE OR DELETE ON app.capability_catalog
FOR EACH ROW EXECUTE FUNCTION app.reject_catalog_mutation();

CREATE TABLE app.master_deactivation_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK(target_type IN ('ORGANIZATION','EMPLOYEE')),
  target_id uuid NOT NULL,
  impact_snapshot_id text NOT NULL CHECK(length(impact_snapshot_id)>=16),
  impact_snapshot jsonb NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  review_owner_membership_id uuid NOT NULL,
  review_by date NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED','EXPIRED')),
  resolution_reason text,
  resolved_by uuid REFERENCES app.users(id),
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,review_owner_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  CHECK((state='OPEN' AND resolved_at IS NULL AND resolved_by IS NULL) OR state<>'OPEN')
);
CREATE UNIQUE INDEX master_deactivation_exception_open_target
  ON app.master_deactivation_exceptions(tenant_id,target_type,target_id) WHERE state='OPEN';
CREATE INDEX master_deactivation_exception_review
  ON app.master_deactivation_exceptions(tenant_id,state,review_by,id);
ALTER TABLE app.master_deactivation_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.master_deactivation_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY master_deactivation_exceptions_tenant_isolation ON app.master_deactivation_exceptions
  USING(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
  WITH CHECK(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');

CREATE OR REPLACE FUNCTION app.reconcile_organization_subtree_scopes(p_tenant uuid,p_root uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; canonical_scope uuid; parent_scope uuid; link record; replacement_grant uuid; affected_memberships uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR item IN
    SELECT n.id,n.parent_id,n.code,n.name,n.node_type,n.state,c.depth FROM app.organization_closure c
    JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=c.descendant_id
    WHERE c.tenant_id=p_tenant AND c.ancestor_id=p_root ORDER BY c.depth,n.id
  LOOP
    SELECT authorization_scope_node_id INTO parent_scope FROM app.organization_nodes
      WHERE tenant_id=p_tenant AND id=item.parent_id;
    SELECT id INTO canonical_scope FROM app.authorization_scope_nodes
      WHERE tenant_id=p_tenant AND canonical_resource_id=item.id ORDER BY created_at DESC LIMIT 1;
    IF item.node_type IN ('LEGAL_ENTITY','REGION','BRANCH') AND canonical_scope IS NULL THEN
      IF item.node_type='LEGAL_ENTITY' THEN
        SELECT id INTO parent_scope FROM app.authorization_scope_nodes
          WHERE tenant_id=p_tenant AND scope_type='TENANT' AND status='ACTIVE';
      END IF;
      INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id,canonical_resource_id,status)
      VALUES(p_tenant,item.node_type,'ORG-'||item.id::text,item.name,parent_scope,item.id,item.state)
      RETURNING id INTO canonical_scope;
    END IF;
    IF item.node_type IN ('LEGAL_ENTITY','REGION','BRANCH') THEN
      UPDATE app.authorization_scope_nodes SET scope_type=item.node_type,name=item.name,parent_id=parent_scope,status=item.state,updated_at=now(),version=version+1
        WHERE tenant_id=p_tenant AND id=canonical_scope AND (scope_type IS DISTINCT FROM item.node_type OR name IS DISTINCT FROM item.name OR parent_id IS DISTINCT FROM parent_scope OR status IS DISTINCT FROM item.state);
      UPDATE app.organization_nodes SET authorization_scope_node_id=canonical_scope,updated_at=now()
        WHERE tenant_id=p_tenant AND id=item.id AND authorization_scope_node_id IS DISTINCT FROM canonical_scope;
    ELSIF parent_scope IS NOT NULL THEN
      UPDATE app.authorization_scope_nodes SET status='INACTIVE',updated_at=now(),version=version+1
        WHERE tenant_id=p_tenant AND canonical_resource_id=item.id AND status='ACTIVE';
      UPDATE app.organization_nodes SET authorization_scope_node_id=parent_scope,updated_at=now()
        WHERE tenant_id=p_tenant AND id=item.id AND authorization_scope_node_id IS DISTINCT FROM parent_scope;
    END IF;
  END LOOP;

  UPDATE app.clients c SET authorization_scope_node_id=n.authorization_scope_node_id,updated_at=now(),version=c.version+1
  FROM app.organization_nodes n JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
  WHERE c.tenant_id=p_tenant AND oc.ancestor_id=p_root AND c.tenant_id=n.tenant_id AND c.billing_entity_id=n.id
    AND c.authorization_scope_node_id IS DISTINCT FROM n.authorization_scope_node_id;
  UPDATE app.client_locations l SET authorization_scope_node_id=n.authorization_scope_node_id,updated_at=now(),version=l.version+1
  FROM app.organization_nodes n JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
  WHERE l.tenant_id=p_tenant AND oc.ancestor_id=p_root AND l.tenant_id=n.tenant_id AND l.organization_node_id=n.id
    AND l.authorization_scope_node_id IS DISTINCT FROM n.authorization_scope_node_id;

  FOR link IN
    SELECT l.id,l.grant_id,g.assignment_id,a.membership_id,g.action,n.authorization_scope_node_id desired_scope
    FROM app.employee_scope_grant_links l
    JOIN app.scope_grants g ON g.tenant_id=l.tenant_id AND g.id=l.grant_id
    JOIN app.membership_role_assignments a ON a.tenant_id=g.tenant_id AND a.id=g.assignment_id
    JOIN app.organization_nodes n ON n.tenant_id=l.tenant_id AND n.id=l.organization_node_id
    JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
    WHERE l.tenant_id=p_tenant AND l.state='ACTIVE' AND oc.ancestor_id=p_root
      AND g.scope_node_id IS DISTINCT FROM n.authorization_scope_node_id
  LOOP
    affected_memberships := array_append(affected_memberships,link.membership_id);
    INSERT INTO app.scope_grants(id,tenant_id,assignment_id,scope_node_id,action,status,effective_from)
    VALUES(gen_random_uuid(),p_tenant,link.assignment_id,link.desired_scope,link.action,'ACTIVE',now())
    ON CONFLICT(tenant_id,assignment_id,scope_node_id,action)
    DO UPDATE SET status='ACTIVE',effective_to=NULL,updated_at=now(),version=app.scope_grants.version+1
    RETURNING id INTO replacement_grant;
    UPDATE app.employee_scope_grant_links SET grant_id=replacement_grant WHERE tenant_id=p_tenant AND id=link.id;
    UPDATE app.scope_grants SET status='INACTIVE',effective_to=coalesce(effective_to,now()),updated_at=now(),version=version+1
      WHERE tenant_id=p_tenant AND id=link.grant_id
        AND NOT EXISTS(SELECT 1 FROM app.employee_scope_grant_links l WHERE l.tenant_id=p_tenant AND l.grant_id=link.grant_id AND l.state='ACTIVE');
  END LOOP;

  UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND status='ACTIVE' AND id=ANY(affected_memberships);
END $$;

COMMIT;
