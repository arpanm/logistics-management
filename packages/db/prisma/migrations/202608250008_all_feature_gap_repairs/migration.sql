-- Forward-only security and upgrade repairs discovered by consolidated review.
BEGIN;
SELECT set_config('app.platform_context','on',true);

-- Existing overrides remain readable, while every newly created override is
-- tied to one immutable approval decision.  The unique key prevents replaying
-- a decision for multiple overrides.
ALTER TABLE app.eligibility_overrides
  ADD COLUMN IF NOT EXISTS approval_decision_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS eligibility_overrides_approval_decision
  ON app.eligibility_overrides(tenant_id,approval_decision_id)
  WHERE approval_decision_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='eligibility_overrides_approval_decision_fk'
      AND conrelid='app.eligibility_overrides'::regclass
  ) THEN
    ALTER TABLE app.eligibility_overrides
      ADD CONSTRAINT eligibility_overrides_approval_decision_fk
      FOREIGN KEY(tenant_id,approval_decision_id)
      REFERENCES app.approval_decisions(tenant_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Reapply the same-assignment canonical evaluator here so installations that
-- already ran the original 007 receive the repaired definition forward-only.
CREATE OR REPLACE FUNCTION app.domain_resource_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text,
  p_action text, p_resource text, p_resource_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
DECLARE resource_nodes uuid[] := '{}'; assigned_membership uuid; audience text;
BEGIN
  SELECT portal_audience INTO audience FROM app.tenant_memberships
  WHERE tenant_id=p_tenant AND id=p_membership AND user_id=p_user AND status='ACTIVE';
  IF audience IS NULL THEN RETURN false; END IF;
  CASE p_resource
    WHEN 'organization-nodes' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.organization_nodes WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'employees' THEN SELECT ARRAY[n.authorization_scope_node_id],e.linked_membership_id INTO resource_nodes,assigned_membership FROM app.employees e JOIN app.organization_nodes n ON n.tenant_id=e.tenant_id AND n.id=e.home_node_id WHERE e.tenant_id=p_tenant AND e.id=p_resource_id;
    WHEN 'clients' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.clients WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'client-locations' THEN SELECT ARRAY_REMOVE(ARRAY[l.authorization_scope_node_id,c.authorization_scope_node_id],null) INTO resource_nodes FROM app.client_locations l JOIN app.clients c ON c.tenant_id=l.tenant_id AND c.id=l.client_id WHERE l.tenant_id=p_tenant AND l.id=p_resource_id;
    WHEN 'contracts' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.contracts t JOIN app.clients c ON c.tenant_id=t.tenant_id AND c.id=t.client_id WHERE t.tenant_id=p_tenant AND t.id=p_resource_id;
    WHEN 'lanes' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.contract_lanes l JOIN app.contract_versions v ON v.tenant_id=l.tenant_id AND v.id=l.contract_version_id JOIN app.contracts t ON t.tenant_id=v.tenant_id AND t.id=v.contract_id JOIN app.clients c ON c.tenant_id=t.tenant_id AND c.id=t.client_id WHERE l.tenant_id=p_tenant AND l.id=p_resource_id;
    WHEN 'vendors' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.vendors WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'vehicles' THEN SELECT ARRAY[v.authorization_scope_node_id] INTO resource_nodes FROM app.vehicles a JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=p_tenant AND a.id=p_resource_id;
    WHEN 'drivers' THEN SELECT ARRAY[v.authorization_scope_node_id],d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.drivers d JOIN app.vendors v ON v.tenant_id=d.tenant_id AND v.id=d.vendor_id WHERE d.tenant_id=p_tenant AND d.id=p_resource_id;
    WHEN 'indents' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,l.authorization_scope_node_id],null),i.owner_membership_id INTO resource_nodes,assigned_membership FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE i.tenant_id=p_tenant AND i.id=p_resource_id;
    WHEN 'allocations' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),a.owner_membership_id INTO resource_nodes,assigned_membership FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=p_tenant AND a.id=p_resource_id;
    WHEN 'trips' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id WHERE t.tenant_id=p_tenant AND t.id=p_resource_id;
    WHEN 'pod-tasks' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id WHERE p.tenant_id=p_tenant AND p.id=p_resource_id;
    WHEN 'invoices' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.client_invoices i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id WHERE i.tenant_id=p_tenant AND i.id=p_resource_id;
    WHEN 'receipts' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.receipts r JOIN app.clients c ON c.tenant_id=r.tenant_id AND c.id=r.client_id WHERE r.tenant_id=p_tenant AND r.id=p_resource_id;
    WHEN 'vendor-bills' THEN SELECT ARRAY[v.authorization_scope_node_id] INTO resource_nodes FROM app.vendor_bills b JOIN app.vendors v ON v.tenant_id=b.tenant_id AND v.id=b.vendor_id WHERE b.tenant_id=p_tenant AND b.id=p_resource_id;
    WHEN 'configurations' THEN resource_nodes := '{}';
    ELSE RETURN false;
  END CASE;
  IF audience='DRIVER' AND p_resource IN ('trips','pod-tasks') AND assigned_membership IS DISTINCT FROM p_membership THEN RETURN false; END IF;
  IF audience='DRIVER' AND p_resource NOT IN ('trips','pod-tasks','drivers') THEN RETURN false; END IF;
  IF audience='CLIENT' AND p_resource NOT IN ('clients','client-locations','indents','trips','pod-tasks','invoices') THEN RETURN false; END IF;
  IF audience='VENDOR' AND p_resource NOT IN ('vendors','vehicles','drivers','allocations','trips','pod-tasks','vendor-bills') THEN RETURN false; END IF;
  RETURN EXISTS(
    SELECT 1 FROM app.membership_role_assignments a
    JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=p_capability
    JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN (p_action,'ADMIN')
    JOIN app.authorization_scope_nodes gn ON gn.tenant_id=g.tenant_id AND gn.id=g.scope_node_id AND gn.status='ACTIVE'
    WHERE a.tenant_id=p_tenant AND a.membership_id=p_membership AND a.status='ACTIVE' AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
      AND ((gn.scope_type='TENANT' AND audience='INTERNAL') OR EXISTS(
        WITH RECURSIVE ancestors AS (
          SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n WHERE n.tenant_id=p_tenant AND n.id=ANY(resource_nodes)
          UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors x ON x.parent_id=n.id WHERE n.tenant_id=p_tenant
        ) SELECT 1 FROM ancestors WHERE id=g.scope_node_id
      ))
  );
END $$;

-- One assignment must contain the requested alert capability and enough
-- active grants to cover every rule scope.  Empty rule scopes mean tenant-wide.
CREATE OR REPLACE FUNCTION app.alert_rule_scope_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text,
  p_action text, p_scope_nodes uuid[]
) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1
    FROM app.tenant_memberships m
    JOIN app.membership_role_assignments a
      ON a.tenant_id=m.tenant_id AND a.membership_id=m.id
      AND a.status='ACTIVE' AND a.effective_from<=now()
      AND (a.effective_to IS NULL OR a.effective_to>now())
    JOIN app.role_capabilities c
      ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id
      AND c.capability_code=p_capability
    WHERE m.tenant_id=p_tenant AND m.id=p_membership AND m.user_id=p_user
      AND m.status='ACTIVE' AND m.portal_audience='INTERNAL'
      AND (
        (cardinality(p_scope_nodes)=0 AND EXISTS(
          SELECT 1 FROM app.scope_grants g
          JOIN app.authorization_scope_nodes n
            ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id
            AND n.status='ACTIVE' AND n.scope_type='TENANT'
          WHERE g.tenant_id=a.tenant_id AND g.assignment_id=a.id
            AND g.status='ACTIVE' AND g.effective_from<=now()
            AND (g.effective_to IS NULL OR g.effective_to>now())
            AND g.action IN (p_action,'ADMIN')
        ))
        OR
        (cardinality(p_scope_nodes)>0 AND NOT EXISTS(
          SELECT 1 FROM unnest(p_scope_nodes) requested(scope_node_id)
          WHERE NOT EXISTS(
            SELECT 1 FROM app.scope_grants g
            JOIN app.authorization_scope_nodes grant_node
              ON grant_node.tenant_id=g.tenant_id AND grant_node.id=g.scope_node_id
              AND grant_node.status='ACTIVE'
            WHERE g.tenant_id=a.tenant_id AND g.assignment_id=a.id
              AND g.status='ACTIVE' AND g.effective_from<=now()
              AND (g.effective_to IS NULL OR g.effective_to>now())
              AND g.action IN (p_action,'ADMIN')
              AND (
                grant_node.scope_type='TENANT'
                OR EXISTS(
                  WITH RECURSIVE ancestors AS (
                    SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n
                    WHERE n.tenant_id=p_tenant AND n.id=requested.scope_node_id AND n.status='ACTIVE'
                    UNION ALL
                    SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n
                    JOIN ancestors x ON x.parent_id=n.id
                    WHERE n.tenant_id=p_tenant AND n.status='ACTIVE'
                  ) SELECT 1 FROM ancestors WHERE id=g.scope_node_id
                )
              )
          )
        ))
      )
  );
$$;

CREATE OR REPLACE FUNCTION app.alert_rule_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text,
  p_action text, p_rule uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM app.alert_rules r
    WHERE r.tenant_id=p_tenant AND r.id=p_rule
      AND app.alert_rule_scope_authorized(
        p_tenant,p_membership,p_user,p_capability,p_action,r.scope_node_ids
      )
  );
$$;

-- Reapply the repaired source-resource/alert evaluator as a forward migration.
CREATE OR REPLACE FUNCTION app.operational_alert_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text, p_alert uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
DECLARE alert_row app.operational_alerts%ROWTYPE; domain_capability text;
BEGIN
  SELECT * INTO alert_row FROM app.operational_alerts WHERE tenant_id=p_tenant AND id=p_alert;
  IF NOT FOUND THEN RETURN false; END IF;
  IF alert_row.rule_id IS NOT NULL THEN
    RETURN app.alert_rule_authorized(
      p_tenant,p_membership,p_user,p_capability,
      CASE WHEN p_capability='alerts.admin' THEN 'UPDATE' ELSE 'READ' END,
      alert_row.rule_id
    );
  END IF;
  domain_capability := CASE alert_row.source_module
    WHEN 'organization-nodes' THEN 'masters.read' WHEN 'employees' THEN 'masters.read'
    WHEN 'clients' THEN 'masters.read' WHEN 'client-locations' THEN 'masters.read'
    WHEN 'contracts' THEN 'masters.read' WHEN 'lanes' THEN 'masters.read'
    WHEN 'vendors' THEN 'masters.read' WHEN 'vehicles' THEN 'masters.read'
    WHEN 'drivers' THEN 'masters.read' WHEN 'indents' THEN 'operations.read'
    WHEN 'allocations' THEN 'operations.read' WHEN 'trips' THEN 'operations.read'
    WHEN 'pod-tasks' THEN 'pod.read' WHEN 'invoices' THEN 'finance.read'
    WHEN 'receipts' THEN 'finance.read' WHEN 'vendor-bills' THEN 'finance.read'
    WHEN 'configurations' THEN 'configuration.read' ELSE NULL END;
  IF domain_capability IS NULL OR alert_row.source_record_id IS NULL THEN RETURN false; END IF;
  RETURN app.domain_resource_authorized(
    p_tenant,p_membership,p_user,p_capability,'READ',
    alert_row.source_module,alert_row.source_record_id
  );
END $$;

-- Upgrade-safe capability repair for tenants/roles created before migration 007.
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE r.code='TENANT_OWNER' AND c.active
ON CONFLICT DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE c.active AND (
  (r.code IN ('REGIONAL_MANAGER','KEY_ACCOUNT_MANAGER','TRAFFIC_PLACEMENT_EXECUTIVE') AND c.code IN ('masters.read','operations.read','operations.admin','pod.read'))
  OR (r.code IN ('FINANCE_EXECUTIVE','COLLECTION_EXECUTIVE') AND c.code IN ('finance.read','finance.admin','pod.read','governance.read'))
  OR (r.code IN ('LOADING_EXECUTIVE','UNLOADING_EXECUTIVE') AND c.code IN ('operations.read','operations.admin','pod.read','pod.admin'))
  OR (r.code='VENDOR_OWNER' AND c.code IN ('masters.read','operations.read','finance.read','governance.read'))
  OR (r.code='DRIVER' AND c.code IN ('operations.read','operations.admin','governance.read'))
  OR (r.code='CLIENT_VIEWER' AND c.code IN ('operations.read','pod.read','finance.read','governance.read'))
  OR (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('masters.read','operations.read','pod.read','finance.read','governance.read','configuration.read'))
)
ON CONFLICT DO NOTHING;

COMMIT;
