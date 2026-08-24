-- Rapid intelligence modules: control views, alerts, imports and integrations.
BEGIN;
SELECT set_config('app.platform_context','on',true);

DROP TRIGGER IF EXISTS capability_catalog_read_only ON app.capability_catalog;
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,delegable) VALUES
  ('control.dashboard.read','Control tower','View scoped control-tower metrics and drill-down',false,true),
  ('alerts.read','Alerts','View scoped operational alerts',false,true),
  ('alerts.admin','Alerts','Acknowledge, assign, snooze and resolve alerts',true,true),
  ('data.import.admin','Data','Preview and commit tenant imports',true,true),
  ('integrations.read','Integrations','View integration health and delivery state',true,true),
  ('integrations.admin','Integrations','Configure integration endpoints',true,true),
  ('integrations.replay','Integrations','Replay dead-letter deliveries',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE r.code='TENANT_OWNER' AND c.code IN ('control.dashboard.read','alerts.read','alerts.admin','data.import.admin','integrations.read','integrations.admin','integrations.replay')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_read_only BEFORE INSERT OR UPDATE OR DELETE ON app.capability_catalog FOR EACH ROW EXECUTE FUNCTION app.reject_catalog_mutation();

CREATE TABLE app.control_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  lens text NOT NULL CHECK (lens IN ('PLACEMENT','POD','COLLECTION','TRIP','VENDOR_PAYABLE')),
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,owner_id,lens,name)
);
CREATE INDEX control_saved_views_tenant_owner ON app.control_saved_views(tenant_id,owner_id,lens,name);

CREATE TABLE app.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, name text NOT NULL, source_module text NOT NULL, event_type text,
  metric_code text, scope_node_ids uuid[] NOT NULL DEFAULT '{}', threshold jsonb NOT NULL DEFAULT '{}',
  severity text NOT NULL CHECK(severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  recipient_policy jsonb NOT NULL DEFAULT '{}', channels text[] NOT NULL DEFAULT ARRAY['IN_APP']::text[],
  quiet_hours jsonb NOT NULL DEFAULT '{}', repeat_policy jsonb NOT NULL DEFAULT '{}', escalation_levels jsonb NOT NULL DEFAULT '[]',
  acknowledgement_required boolean NOT NULL DEFAULT true, resolution_condition jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE INDEX alert_rules_tenant_active ON app.alert_rules(tenant_id,active,source_module,code);

CREATE TABLE app.operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  rule_id uuid, deduplication_key text NOT NULL, source_module text NOT NULL, source_record_id uuid,
  alert_type text NOT NULL, severity text NOT NULL CHECK(severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','ACKNOWLEDGED','SNOOZED','ESCALATED','RESOLVED')),
  title text NOT NULL, summary text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', owner_membership_id uuid,
  due_at timestamptz, snoozed_until timestamptz, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK(occurrence_count>0), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,deduplication_key),
  FOREIGN KEY(tenant_id,rule_id) REFERENCES app.alert_rules(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,owner_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX operational_alerts_tenant_queue ON app.operational_alerts(tenant_id,state,severity,due_at,last_seen_at DESC);

CREATE TABLE app.operational_alert_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  alert_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('ACKNOWLEDGE','ASSIGN','COMMENT','SNOOZE','ESCALATE','RESOLVE','AUTO_RESOLVE','REOPEN')),
  reason text, payload jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,alert_id) REFERENCES app.operational_alerts(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX operational_alert_actions_tenant_alert ON app.operational_alert_actions(tenant_id,alert_id,occurred_at DESC);

CREATE TABLE app.import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  dataset text NOT NULL, filename text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>=0), checksum text NOT NULL,
  source_timezone text NOT NULL, import_mode text NOT NULL CHECK(import_mode IN ('APPEND','UPSERT','FULL_FILE')),
  state text NOT NULL DEFAULT 'UPLOADED' CHECK(state IN ('UPLOADED','MAPPED','VALIDATED','COMMIT_QUEUED','COMMITTED','FAILED','CORRECTED')),
  uploader_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, idempotency_key_hash text NOT NULL,
  header_map jsonb NOT NULL DEFAULT '{}', summary jsonb NOT NULL DEFAULT '{}', correction_of uuid,
  committed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,dataset,checksum,import_mode),
  FOREIGN KEY(tenant_id,correction_of) REFERENCES app.import_jobs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX import_jobs_tenant_state ON app.import_jobs(tenant_id,state,dataset,created_at DESC);

CREATE TABLE app.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL, row_number integer NOT NULL CHECK(row_number>0), natural_key text, normalized_data jsonb NOT NULL,
  disposition text NOT NULL DEFAULT 'PENDING' CHECK(disposition IN ('PENDING','CREATE','UPDATE','UNCHANGED','DEACTIVATE','REJECT','WARNING','COMMITTED')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,job_id,row_number),
  FOREIGN KEY(tenant_id,job_id) REFERENCES app.import_jobs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX import_rows_tenant_job ON app.import_rows(tenant_id,job_id,disposition,row_number);

CREATE TABLE app.import_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL, row_number integer, column_name text, code text NOT NULL, message text NOT NULL,
  severity text NOT NULL CHECK(severity IN ('ERROR','WARNING')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,job_id) REFERENCES app.import_jobs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX import_errors_tenant_job ON app.import_errors(tenant_id,job_id,severity,row_number);

CREATE TABLE app.integration_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, integration_type text NOT NULL, name text NOT NULL, environment text NOT NULL,
  endpoint text, credential_reference text, scopes text[] NOT NULL DEFAULT '{}', allowed_events text[] NOT NULL DEFAULT '{}',
  mapping_version integer NOT NULL DEFAULT 1, rate_limit jsonb NOT NULL DEFAULT '{}', retry_policy jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','PAUSED','ERROR','INACTIVE')),
  last_success_at timestamptz, last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE INDEX integration_endpoints_tenant_state ON app.integration_endpoints(tenant_id,state,integration_type,name);

CREATE TABLE app.integration_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
  event_id text NOT NULL, event_type text NOT NULL, mapping_version integer NOT NULL, payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','SUCCEEDED','FAILED','DEAD_LETTER')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), leased_at timestamptz,
  last_error_code text, correlation_id text NOT NULL, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,endpoint_id,event_id),
  FOREIGN KEY(tenant_id,endpoint_id) REFERENCES app.integration_endpoints(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX integration_deliveries_tenant_queue ON app.integration_deliveries(tenant_id,state,available_at,endpoint_id);

CREATE TABLE app.integration_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL, reason_code text NOT NULL, safe_error text NOT NULL, replay_count integer NOT NULL DEFAULT 0,
  resolved_at timestamptz, resolution_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,delivery_id),
  FOREIGN KEY(tenant_id,delivery_id) REFERENCES app.integration_deliveries(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX integration_dead_letters_tenant_open ON app.integration_dead_letters(tenant_id,resolved_at,created_at DESC);

DO $$ DECLARE q text; s text; n text; p text; BEGIN
  FOREACH q IN ARRAY ARRAY[
    'app.control_saved_views','app.alert_rules','app.operational_alerts','app.operational_alert_actions',
    'app.import_jobs','app.import_rows','app.import_errors','app.integration_endpoints','app.integration_deliveries','app.integration_dead_letters'
  ] LOOP
    s:=split_part(q,'.',1); n:=split_part(q,'.',2); p:=n||'_tenant_isolation';
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,n);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,n);
    EXECUTE format('CREATE POLICY %I ON %I.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',p,s,n);
  END LOOP;
END $$;

COMMIT;
