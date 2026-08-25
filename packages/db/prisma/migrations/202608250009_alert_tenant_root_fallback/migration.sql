BEGIN;
SELECT set_config('app.platform_context','on',true);

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
  IF domain_capability IS NOT NULL AND alert_row.source_record_id IS NOT NULL THEN
    RETURN app.domain_resource_authorized(
      p_tenant,p_membership,p_user,p_capability,'READ',
      alert_row.source_module,alert_row.source_record_id
    );
  END IF;
  IF alert_row.source_record_id IS NOT NULL THEN RETURN false; END IF;
  RETURN EXISTS(
    SELECT 1 FROM app.membership_role_assignments a
    JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=p_capability
    JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action='ADMIN'
      AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
    JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.scope_type='TENANT' AND n.status='ACTIVE'
    WHERE a.tenant_id=p_tenant AND a.membership_id=p_membership AND a.status='ACTIVE'
      AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
      AND EXISTS(
        SELECT 1 FROM app.tenant_memberships m
        WHERE m.tenant_id=a.tenant_id AND m.id=a.membership_id AND m.user_id=p_user AND m.status='ACTIVE'
      )
  );
END $$;

COMMIT;
