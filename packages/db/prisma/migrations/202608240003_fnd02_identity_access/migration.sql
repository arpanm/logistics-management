-- FND-02: identity, roles, scoped authorization, MFA and security reporting.
BEGIN;
SELECT set_config('app.platform_context','on',true);
ALTER TABLE app.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE app.users ADD COLUMN mobile_e164 text UNIQUE;
ALTER TABLE app.users ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE app.users ADD COLUMN last_login_at timestamptz;
ALTER TABLE app.users ADD COLUMN credentials_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.users ADD CONSTRAINT users_identifier_required CHECK (email IS NOT NULL OR mobile_e164 IS NOT NULL);
ALTER TABLE app.users ADD CONSTRAINT users_mobile_e164 CHECK (mobile_e164 IS NULL OR mobile_e164 ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE app.tenant_memberships DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE app.tenant_memberships ALTER COLUMN invited_email DROP NOT NULL;
ALTER TABLE app.tenant_memberships ALTER COLUMN role DROP NOT NULL;
ALTER TABLE app.tenant_memberships ADD COLUMN invited_mobile text;
ALTER TABLE app.tenant_memberships ADD COLUMN employee_code text;
ALTER TABLE app.tenant_memberships ADD COLUMN portal_audience text NOT NULL DEFAULT 'INTERNAL' CHECK (portal_audience IN ('INTERNAL','VENDOR','DRIVER','CLIENT'));
ALTER TABLE app.tenant_memberships ADD COLUMN authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE app.tenant_memberships ADD COLUMN last_activity_at timestamptz;
ALTER TABLE app.tenant_memberships ADD CONSTRAINT tenant_membership_destination CHECK (invited_email IS NOT NULL OR invited_mobile IS NOT NULL);
ALTER TABLE app.tenant_memberships ADD CONSTRAINT tenant_membership_mobile CHECK (invited_mobile IS NULL OR invited_mobile ~ '^\+[1-9][0-9]{7,14}$');
UPDATE app.tenant_memberships SET employee_code = 'OWNER-' || upper(substr(replace(id::text,'-',''),1,8)) WHERE employee_code IS NULL;
ALTER TABLE app.tenant_memberships ALTER COLUMN employee_code SET NOT NULL;
CREATE UNIQUE INDEX tenant_memberships_employee_code ON app.tenant_memberships(tenant_id,employee_code);
CREATE UNIQUE INDEX tenant_memberships_mobile ON app.tenant_memberships(tenant_id,invited_mobile) WHERE invited_mobile IS NOT NULL;
CREATE INDEX tenant_memberships_directory ON app.tenant_memberships(tenant_id,status,invited_name,id);

CREATE TABLE app.capability_catalog (
  code text PRIMARY KEY, capability_group text NOT NULL, description text NOT NULL,
  privileged boolean NOT NULL DEFAULT false, sensitive_class text, delegable boolean NOT NULL DEFAULT true,
  introduced_version integer NOT NULL DEFAULT 2, active boolean NOT NULL DEFAULT true
);
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,sensitive_class,delegable) VALUES
('identity.user.read','Identity','View tenant users',false,null,true),
('identity.user.admin','Identity','Administer tenant users',true,null,true),
('identity.role.read','Identity','View roles and capabilities',false,null,true),
('identity.role.admin','Identity','Administer roles',true,null,true),
('identity.session.admin','Security','Reset tenant sessions',true,null,true),
('identity.mfa.admin','Security','Reset MFA factors',true,null,false),
('identity.report.read','Reporting','View identity and security reports',true,null,true),
('identity.audit.read','Reporting','View permission audit history',true,null,true),
('probe.read','Access proof','Read scoped proof resources',false,null,true),
('probe.create','Access proof','Create scoped proof resources',false,null,true),
('probe.update','Access proof','Update scoped proof resources',false,null,true),
('probe.approve','Access proof','Approve scoped proof resources',true,null,true),
('probe.export','Access proof','Export scoped proof resources',true,null,true),
('sensitive.tax_identifier.read','Sensitive data','Reveal tax identifiers',true,'tax_identifier',true),
('sensitive.mobile.read','Sensitive data','Reveal mobile numbers',true,'mobile',true),
('sensitive.bank_detail.read','Sensitive data','Reveal bank details',true,'bank_detail',true),
('sensitive.commercial_rate.read','Sensitive data','Reveal commercial rates',true,'commercial_rate',true),
('sensitive.payment.read','Sensitive data','Reveal payment values',true,'payment',true);
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,sensitive_class,delegable)
VALUES('sensitive.internal_margin.read','Sensitive data','Reveal internal margins',true,'internal_margin',true);

CREATE TABLE app.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', protected boolean NOT NULL DEFAULT false,
  privilege_level text NOT NULL DEFAULT 'STANDARD' CHECK (privilege_level IN ('STANDARD','PRIVILEGED','PROTECTED')),
  portal_audiences text[] NOT NULL DEFAULT ARRAY['INTERNAL']::text[], status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE INDEX roles_tenant_status_name ON app.roles(tenant_id,status,name,id);

CREATE TABLE app.role_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL, capability_code text NOT NULL REFERENCES app.capability_catalog(code) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,role_id,capability_code),
  FOREIGN KEY(tenant_id,role_id) REFERENCES app.roles(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX role_capabilities_tenant_role ON app.role_capabilities(tenant_id,role_id,capability_code);

CREATE TABLE app.authorization_scope_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK(scope_type IN ('TENANT','LEGAL_ENTITY','REGION','BRANCH','CLIENT','LOCATION','VENDOR','ASSIGNED_TRIP')),
  code text NOT NULL, name text NOT NULL, parent_id uuid, canonical_resource_id uuid, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,scope_type,code),
  FOREIGN KEY(tenant_id,parent_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((scope_type='TENANT' AND parent_id IS NULL) OR scope_type<>'TENANT')
);
CREATE UNIQUE INDEX scope_nodes_one_root ON app.authorization_scope_nodes(tenant_id) WHERE scope_type='TENANT' AND status='ACTIVE';
CREATE INDEX scope_nodes_tenant_parent_type ON app.authorization_scope_nodes(tenant_id,parent_id,scope_type,name,id);

CREATE OR REPLACE FUNCTION app.validate_scope_node() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_type text; cycle_found boolean; depth_count integer;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'scope hierarchy cycle'; END IF;
  SELECT scope_type INTO parent_type FROM app.authorization_scope_nodes WHERE tenant_id=NEW.tenant_id AND id=NEW.parent_id;
  IF parent_type IS NULL THEN RAISE EXCEPTION 'scope parent is outside tenant'; END IF;
  IF NOT ((NEW.scope_type='LEGAL_ENTITY' AND parent_type='TENANT') OR
          (NEW.scope_type='REGION' AND parent_type IN ('TENANT','LEGAL_ENTITY')) OR
          (NEW.scope_type='BRANCH' AND parent_type IN ('REGION','LEGAL_ENTITY')) OR
          (NEW.scope_type='CLIENT' AND parent_type IN ('TENANT','REGION','BRANCH')) OR
          (NEW.scope_type='LOCATION' AND parent_type IN ('CLIENT','BRANCH')) OR
          (NEW.scope_type='VENDOR' AND parent_type IN ('TENANT','REGION','BRANCH')) OR
          (NEW.scope_type='ASSIGNED_TRIP' AND parent_type IN ('TENANT','REGION','BRANCH','CLIENT','LOCATION','VENDOR'))) THEN
    RAISE EXCEPTION 'invalid scope parent type';
  END IF;
  WITH RECURSIVE ancestors(id,parent_id,depth) AS (
    SELECT id,parent_id,1 FROM app.authorization_scope_nodes WHERE tenant_id=NEW.tenant_id AND id=NEW.parent_id
    UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM app.authorization_scope_nodes n JOIN ancestors a ON n.id=a.parent_id WHERE n.tenant_id=NEW.tenant_id AND a.depth<14
  ) SELECT bool_or(id=NEW.id),max(depth) INTO cycle_found,depth_count FROM ancestors;
  IF cycle_found OR coalesce(depth_count,0)>12 THEN RAISE EXCEPTION 'scope hierarchy cycle or depth exceeded'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authorization_scope_nodes_validate BEFORE INSERT OR UPDATE OF tenant_id,parent_id,scope_type ON app.authorization_scope_nodes FOR EACH ROW EXECUTE FUNCTION app.validate_scope_node();

CREATE TABLE app.membership_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, role_id uuid NOT NULL, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  effective_from timestamptz NOT NULL DEFAULT now(), effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,membership_id,role_id),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,role_id) REFERENCES app.roles(tenant_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE INDEX membership_assignments_tenant_member ON app.membership_role_assignments(tenant_id,membership_id,status);
CREATE INDEX membership_assignments_tenant_role ON app.membership_role_assignments(tenant_id,role_id,status);

CREATE TABLE app.scope_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL, scope_node_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('READ','CREATE','UPDATE','APPROVE','EXPORT','ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')), effective_from timestamptz NOT NULL DEFAULT now(), effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,assignment_id,scope_node_id,action),
  FOREIGN KEY(tenant_id,assignment_id) REFERENCES app.membership_role_assignments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,scope_node_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE INDEX scope_grants_tenant_assignment_action ON app.scope_grants(tenant_id,assignment_id,action,status);

CREATE TABLE app.access_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, authentication_method text NOT NULL DEFAULT 'LOCAL_PASSWORD' CHECK(authentication_method='LOCAL_PASSWORD'),
  destination_hash text NOT NULL, masked_destination text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  used_at timestamptz, revoked_at timestamptz, delivery_state text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX access_invitations_one_live ON app.access_invitations(tenant_id,membership_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX access_invitations_tenant_state ON app.access_invitations(tenant_id,delivery_state,expires_at);

CREATE TABLE app.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  factor_type text NOT NULL DEFAULT 'TOTP' CHECK(factor_type='TOTP'), encrypted_secret text NOT NULL, key_version integer NOT NULL,
  verified_at timestamptz, disabled_at timestamptz, last_timestep bigint,
  setup_timestep bigint, recovery_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX mfa_factors_one_active_totp ON app.mfa_factors(user_id) WHERE disabled_at IS NULL;
CREATE TABLE app.mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factor_id uuid NOT NULL REFERENCES app.mfa_factors(id) ON DELETE RESTRICT,
  code_hash text NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(factor_id,code_hash)
);

ALTER TABLE app.sessions ADD COLUMN user_auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE app.sessions ADD COLUMN membership_id uuid;
ALTER TABLE app.sessions ADD COLUMN membership_auth_version integer;
ALTER TABLE app.sessions ADD COLUMN mfa_satisfied_at timestamptz;
ALTER TABLE app.sessions ADD COLUMN assurance_level text NOT NULL DEFAULT 'PASSWORD' CHECK(assurance_level IN ('PASSWORD','MFA','RESTRICTED_MFA'));
ALTER TABLE app.sessions ADD CONSTRAINT sessions_tenant_membership_fk FOREIGN KEY(active_tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT;
UPDATE app.sessions s SET user_auth_version=u.auth_version FROM app.users u WHERE u.id=s.user_id;
UPDATE app.sessions s SET membership_id=m.id,membership_auth_version=m.authorization_version FROM app.tenant_memberships m WHERE m.tenant_id=s.active_tenant_id AND m.user_id=s.user_id AND m.status='ACTIVE';
UPDATE app.sessions SET revoked_at=coalesce(revoked_at,now()),revoked_reason=coalesce(revoked_reason,'AUTHORIZATION_BACKFILL'),active_tenant_id=NULL WHERE active_tenant_id IS NOT NULL AND membership_id IS NULL;
CREATE INDEX sessions_user_tenant_active ON app.sessions(user_id,active_tenant_id,revoked_at,expires_at);

CREATE TABLE app.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES app.users(id), membership_id uuid, session_id uuid REFERENCES app.sessions(id),
  event_type text NOT NULL, outcome text NOT NULL, safe_target_hash text, metadata jsonb NOT NULL DEFAULT '{}', correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX security_events_tenant_time_type ON app.security_events(tenant_id,occurred_at DESC,event_type);
CREATE TRIGGER security_events_immutable BEFORE UPDATE OR DELETE ON app.security_events FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

CREATE TABLE app.security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  alert_type text NOT NULL, severity text NOT NULL, deduplication_key text NOT NULL, user_id uuid REFERENCES app.users(id), membership_id uuid,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','ACKNOWLEDGED','RESOLVED')), occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,deduplication_key), FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX security_alerts_tenant_open ON app.security_alerts(tenant_id,state,alert_type,last_seen_at DESC);

CREATE TABLE app.authorization_probe_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  label text NOT NULL, scope_node_ids uuid[] NOT NULL, assigned_user_id uuid REFERENCES app.users(id), status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','COMPLETED')),
  resource_type text NOT NULL DEFAULT 'WORK_ITEM' CHECK(resource_type IN ('WORK_ITEM','ALLOCATION','TRIP','PAYMENT','CLIENT_STATUS')),
  tax_identifier text, mobile text, bank_detail text, commercial_rate_minor bigint, payment_minor bigint, internal_margin_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id)
);
CREATE INDEX authorization_probes_tenant_status ON app.authorization_probe_records(tenant_id,status,label,id);

CREATE OR REPLACE FUNCTION app.validate_authorization_probe() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node_id uuid;
BEGIN
  IF cardinality(NEW.scope_node_ids)=0 THEN RAISE EXCEPTION 'probe scope is required'; END IF;
  FOREACH node_id IN ARRAY NEW.scope_node_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM app.authorization_scope_nodes n WHERE n.tenant_id=NEW.tenant_id AND n.id=node_id AND n.status='ACTIVE') THEN
      RAISE EXCEPTION 'probe scope is outside tenant';
    END IF;
  END LOOP;
  IF NEW.assigned_user_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM app.tenant_memberships m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.assigned_user_id AND m.status='ACTIVE'
  ) THEN RAISE EXCEPTION 'assigned user is outside tenant'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authorization_probe_validate BEFORE INSERT OR UPDATE OF tenant_id,scope_node_ids,assigned_user_id ON app.authorization_probe_records FOR EACH ROW EXECUTE FUNCTION app.validate_authorization_probe();

CREATE TABLE reporting.identity_activity_projection (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, membership_id uuid NOT NULL,
  last_login_at timestamptz, last_activity_at timestamptz, failed_login_count integer NOT NULL DEFAULT 0,
  active_session_count integer NOT NULL DEFAULT 0, role_count integer NOT NULL DEFAULT 0, privileged boolean NOT NULL DEFAULT false,
  refreshed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,membership_id),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX identity_projection_tenant_activity ON reporting.identity_activity_projection(tenant_id,last_activity_at,membership_id);

-- Backfill tenant authorization roots, baseline role templates and owner assignments.
INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name)
SELECT id,'TENANT','TENANT','Entire tenant' FROM app.tenants ON CONFLICT DO NOTHING;

WITH templates(code,name,audiences,level,protected) AS (VALUES
('TENANT_OWNER','Tenant Owner',ARRAY['INTERNAL']::text[],'PROTECTED',true),
('MIS_EXECUTIVE','MIS Executive',ARRAY['INTERNAL']::text[],'STANDARD',false),
('REGIONAL_MANAGER','Regional Manager',ARRAY['INTERNAL']::text[],'STANDARD',false),
('KEY_ACCOUNT_MANAGER','Key Account Manager',ARRAY['INTERNAL']::text[],'STANDARD',false),
('TRAFFIC_PLACEMENT_EXECUTIVE','Traffic / Placement Executive',ARRAY['INTERNAL']::text[],'STANDARD',false),
('FINANCE_EXECUTIVE','Finance Executive',ARRAY['INTERNAL']::text[],'PRIVILEGED',false),
('COLLECTION_EXECUTIVE','Collection Executive',ARRAY['INTERNAL']::text[],'PRIVILEGED',false),
('LOADING_EXECUTIVE','Loading Executive',ARRAY['INTERNAL']::text[],'STANDARD',false),
('UNLOADING_EXECUTIVE','Unloading Executive',ARRAY['INTERNAL']::text[],'STANDARD',false),
('VENDOR_OWNER','Vendor Owner',ARRAY['VENDOR']::text[],'STANDARD',false),
('DRIVER','Driver',ARRAY['DRIVER']::text[],'STANDARD',false),
('CLIENT_VIEWER','Client Viewer',ARRAY['CLIENT']::text[],'STANDARD',false),
('AUDITOR','Auditor',ARRAY['INTERNAL']::text[],'PRIVILEGED',false)
)
INSERT INTO app.roles(tenant_id,code,name,description,portal_audiences,privilege_level,protected)
SELECT t.id,x.code,x.name,'Baseline role template',x.audiences,x.level,x.protected FROM app.tenants t CROSS JOIN templates x ON CONFLICT DO NOTHING;

INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE r.code='TENANT_OWNER'
   OR (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('identity.user.read','identity.role.read','identity.report.read','identity.audit.read','probe.read','probe.export'))
   OR (r.code IN ('REGIONAL_MANAGER','KEY_ACCOUNT_MANAGER','TRAFFIC_PLACEMENT_EXECUTIVE') AND c.code IN ('probe.read','probe.create','probe.update','probe.export'))
   OR (r.code IN ('FINANCE_EXECUTIVE','COLLECTION_EXECUTIVE') AND c.code IN ('probe.read','probe.approve','probe.export','sensitive.payment.read','sensitive.bank_detail.read'))
   OR (r.code IN ('LOADING_EXECUTIVE','UNLOADING_EXECUTIVE') AND c.code IN ('probe.read','probe.update'))
   OR (r.code='VENDOR_OWNER' AND c.code IN ('probe.read','probe.update','sensitive.payment.read'))
   OR (r.code='DRIVER' AND c.code IN ('probe.read','probe.update'))
   OR (r.code='CLIENT_VIEWER' AND c.code='probe.read')
ON CONFLICT DO NOTHING;

INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id)
SELECT m.tenant_id,m.id,r.id FROM app.tenant_memberships m JOIN app.roles r ON r.tenant_id=m.tenant_id AND r.code='TENANT_OWNER'
WHERE m.role='TENANT_OWNER' ON CONFLICT DO NOTHING;
INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action)
SELECT a.tenant_id,a.id,n.id,'ADMIN' FROM app.membership_role_assignments a
JOIN app.roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.code='TENANT_OWNER'
JOIN app.authorization_scope_nodes n ON n.tenant_id=a.tenant_id AND n.scope_type='TENANT'
ON CONFLICT DO NOTHING;

DO $$ DECLARE q text; s text; n text; p text; BEGIN
  FOREACH q IN ARRAY ARRAY[
    'app.roles','app.role_capabilities','app.authorization_scope_nodes','app.membership_role_assignments','app.scope_grants',
    'app.access_invitations','app.security_events','app.security_alerts','app.authorization_probe_records','reporting.identity_activity_projection'
  ] LOOP
    s:=split_part(q,'.',1); n:=split_part(q,'.',2); p:=n||'_tenant_isolation';
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,n);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,n);
    EXECUTE format('CREATE POLICY %I ON %I.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',p,s,n);
  END LOOP;
END $$;

ALTER TABLE app.sessions ADD CONSTRAINT sessions_context_consistent CHECK (
  (active_tenant_id IS NULL AND membership_id IS NULL AND membership_auth_version IS NULL)
  OR (active_tenant_id IS NOT NULL AND membership_id IS NOT NULL AND membership_auth_version IS NOT NULL)
);
CREATE OR REPLACE FUNCTION app.validate_tenant_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_tenant_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM app.tenant_memberships m
    WHERE m.tenant_id=NEW.active_tenant_id AND m.id=NEW.membership_id AND m.user_id=NEW.user_id AND m.status='ACTIVE'
  ) THEN RAISE EXCEPTION 'tenant session membership mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_tenant_membership_validate BEFORE INSERT OR UPDATE OF user_id,active_tenant_id,membership_id ON app.sessions FOR EACH ROW EXECUTE FUNCTION app.validate_tenant_session();

ALTER TABLE app.roles ADD CONSTRAINT roles_audiences_valid CHECK (
  cardinality(portal_audiences)>0 AND portal_audiences <@ ARRAY['INTERNAL','VENDOR','DRIVER','CLIENT']::text[]
);
ALTER TABLE app.mfa_factors ADD CONSTRAINT mfa_envelope_format CHECK (encrypted_secret ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
CREATE UNIQUE INDEX users_email_normalized ON app.users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX memberships_email_normalized ON app.tenant_memberships(tenant_id,lower(invited_email)) WHERE invited_email IS NOT NULL;

CREATE OR REPLACE FUNCTION app.reject_catalog_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'capability catalogue is migration-managed'; END $$;
CREATE TRIGGER capability_catalog_read_only BEFORE INSERT OR UPDATE OR DELETE ON app.capability_catalog FOR EACH ROW EXECUTE FUNCTION app.reject_catalog_mutation();

COMMIT;
