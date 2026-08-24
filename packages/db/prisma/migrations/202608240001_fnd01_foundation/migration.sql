CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS reporting;

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);

CREATE TABLE app.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,30}$'),
  name text NOT NULL, legal_name text NOT NULL, tax_identifier text NOT NULL, address jsonb NOT NULL,
  timezone text NOT NULL, locale text NOT NULL, currency char(3) NOT NULL,
  fiscal_month smallint NOT NULL CHECK (fiscal_month BETWEEN 1 AND 12), fiscal_day smallint NOT NULL CHECK (fiscal_day BETWEEN 1 AND 31),
  support_name text NOT NULL, support_email text NOT NULL, support_mobile text,
  short_name text NOT NULL, primary_color char(7) NOT NULL, accent_color char(7) NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  lifecycle_reason text, lifecycle_actor_id uuid REFERENCES app.users(id), lifecycle_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, active_tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  context_version integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL, revoked_at timestamptz, revoked_reason text,
  last_seen_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);

CREATE TABLE app.legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, name text NOT NULL, tax_identifier text, is_default boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,code)
);
CREATE UNIQUE INDEX legal_entities_one_default ON app.legal_entities(tenant_id) WHERE is_default;

CREATE TABLE app.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT, invited_email text NOT NULL, role text NOT NULL CHECK (role='TENANT_OWNER'),
  status text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,invited_email), UNIQUE NULLS NOT DISTINCT (tenant_id,user_id)
);

CREATE TABLE app.owner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, email text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  accepted_at timestamptz, revoked_at timestamptz, delivery_state text NOT NULL DEFAULT 'PENDING_DELIVERY',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,membership_id), FOREIGN KEY (tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE app.tenant_configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  namespace text NOT NULL, schema_version integer NOT NULL, value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,namespace)
);

CREATE TABLE app.setup_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  key text NOT NULL, label text NOT NULL, display_order integer NOT NULL, state text NOT NULL CHECK (state IN ('NOT_STARTED','COMPLETE','NOT_AVAILABLE')),
  completed_by uuid REFERENCES app.users(id), completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,key)
);

CREATE TABLE app.tenant_probe_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  label text NOT NULL, note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id)
);
CREATE INDEX tenant_probe_records_tenant_search ON app.tenant_probe_records(tenant_id,label);

CREATE TABLE app.stored_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  probe_id uuid NOT NULL, media_type text NOT NULL, byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 32768), sha256 text NOT NULL, content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,probe_id) REFERENCES app.tenant_probe_records(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE app.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL CHECK (scope IN ('PLATFORM','TENANT')), tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES app.users(id), operation text NOT NULL, key_hash text NOT NULL, request_hash text NOT NULL, resource_id uuid, response_json jsonb NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'COMPLETE',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK ((scope='PLATFORM' AND tenant_id IS NULL) OR (scope='TENANT' AND tenant_id IS NOT NULL)), UNIQUE(actor_id,operation,key_hash)
);

CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('PLATFORM','TENANT')), aggregate_type text NOT NULL, aggregate_id uuid, event_type text NOT NULL, event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL, deduplication_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'PENDING', available_at timestamptz NOT NULL DEFAULT now(), leased_at timestamptz, processed_at timestamptz, attempts integer NOT NULL DEFAULT 0, error_class text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK ((scope='PLATFORM' AND tenant_id IS NULL) OR (scope='TENANT' AND tenant_id IS NOT NULL))
);
CREATE INDEX outbox_events_tenant_state ON app.outbox_events(tenant_id,state,available_at);

CREATE TABLE app.job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('PLATFORM','TENANT')), job_type text NOT NULL, job_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0, leased_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(), error_class text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK ((scope='PLATFORM' AND tenant_id IS NULL) OR (scope='TENANT' AND tenant_id IS NOT NULL))
);
CREATE INDEX job_runs_tenant_state ON app.job_runs(tenant_id,state,next_at);

CREATE TABLE app.platform_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  type text NOT NULL, severity text NOT NULL, deduplication_key text NOT NULL UNIQUE, summary text NOT NULL, state text NOT NULL DEFAULT 'OPEN', occurrence_count integer NOT NULL DEFAULT 1,
  correlation_id text, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);

CREATE TABLE app.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_hash text NOT NULL, window_start timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(identity_hash,window_start)
);

CREATE TABLE audit.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT, actor_id uuid REFERENCES app.users(id),
  action text NOT NULL, target_type text NOT NULL, target_id uuid, source text NOT NULL DEFAULT 'HTTP', before_json jsonb, after_json jsonb, reason text,
  correlation_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time ON audit.audit_events(tenant_id,occurred_at DESC);

CREATE TABLE reporting.tenant_activity_projection (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE RESTRICT, last_activity_at timestamptz, user_count integer NOT NULL DEFAULT 0,
  probe_count integer NOT NULL DEFAULT 0, config_count integer NOT NULL DEFAULT 0, event_count integer NOT NULL DEFAULT 0,
  refreshed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);

CREATE VIEW reporting.platform_tenant_health AS
SELECT t.id, t.code, t.name, t.status,
  count(DISTINCT m.user_id) FILTER (WHERE m.status='ACTIVE')::int AS active_user_count,
  count(DISTINCT c.id) FILTER (WHERE c.state='COMPLETE')::int AS setup_complete,
  count(DISTINCT c.id)::int AS setup_total,
  p.last_activity_at, p.refreshed_at,
  count(DISTINCT o.id) FILTER (WHERE o.state='PENDING')::int AS pending_events,
  count(DISTINCT o.id) FILTER (WHERE o.state='FAILED')::int AS failed_events,
  count(DISTINCT j.id) FILTER (WHERE j.state='PENDING')::int AS pending_jobs,
  count(DISTINCT j.id) FILTER (WHERE j.state='FAILED')::int AS failed_jobs
FROM app.tenants t
LEFT JOIN app.tenant_memberships m ON m.tenant_id=t.id
LEFT JOIN app.setup_checklist_items c ON c.tenant_id=t.id
LEFT JOIN reporting.tenant_activity_projection p ON p.tenant_id=t.id
LEFT JOIN app.outbox_events o ON o.tenant_id=t.id
LEFT JOIN app.job_runs j ON j.tenant_id=t.id
GROUP BY t.id,p.last_activity_at,p.refreshed_at;

CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit.audit_events FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['legal_entities','tenant_memberships','owner_invitations','tenant_configuration','setup_checklist_items','tenant_probe_records','stored_documents'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id = nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',tbl);
  END LOOP;
END $$;

ALTER TABLE reporting.tenant_activity_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.tenant_activity_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_activity_isolation ON reporting.tenant_activity_projection USING (tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on') WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');
