ALTER TABLE app.tenant_memberships
  ADD COLUMN invited_name text NOT NULL DEFAULT 'Invited Owner';
ALTER TABLE app.tenant_memberships ALTER COLUMN invited_name DROP DEFAULT;

CREATE INDEX idempotency_records_tenant_operation ON app.idempotency_records(tenant_id, operation);
CREATE INDEX platform_alerts_tenant_state ON app.platform_alerts(tenant_id, state);

DO $$
DECLARE
  qualified_table text;
  schema_name text;
  table_name text;
  policy_name text;
BEGIN
  FOREACH qualified_table IN ARRAY ARRAY[
    'app.idempotency_records',
    'app.outbox_events',
    'app.job_runs',
    'app.platform_alerts',
    'audit.audit_events'
  ] LOOP
    schema_name := split_part(qualified_table, '.', 1);
    table_name := split_part(qualified_table, '.', 2);
    policy_name := table_name || '_mixed_context_isolation';
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', policy_name, schema_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I USING (
         current_setting(''app.platform_context'', true) = ''on''
         OR (tenant_id IS NOT NULL AND tenant_id = nullif(current_setting(''app.current_tenant_id'', true), '''')::uuid)
       ) WITH CHECK (
         current_setting(''app.platform_context'', true) = ''on''
         OR (tenant_id IS NOT NULL AND tenant_id = nullif(current_setting(''app.current_tenant_id'', true), '''')::uuid)
       )',
      policy_name, schema_name, table_name
    );
  END LOOP;
END $$;
