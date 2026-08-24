BEGIN;

CREATE TABLE app.module_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  module_key text NOT NULL CHECK(module_key IN ('masters','governance','configuration','control','alerts','data','integrations','operations','pod','finance')),
  resource_type text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  effective_from timestamptz,
  effective_to timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,module_key,resource_type,code),
  CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  CHECK(length(name) BETWEEN 2 AND 160),
  CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to>effective_from)
);
CREATE INDEX module_records_tenant_resource_status ON app.module_records(tenant_id,module_key,resource_type,status,name,id);
CREATE INDEX module_records_tenant_effective ON app.module_records(tenant_id,module_key,resource_type,effective_from,effective_to);

CREATE TABLE app.module_record_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  snapshot_no integer NOT NULL CHECK(snapshot_no>0),
  payload jsonb NOT NULL,
  captured_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,record_id,snapshot_no),
  FOREIGN KEY(tenant_id,record_id) REFERENCES app.module_records(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX module_snapshots_record_time ON app.module_record_snapshots(tenant_id,record_id,captured_at DESC);

CREATE TABLE app.module_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,record_id) REFERENCES app.module_records(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX module_workflow_record_time ON app.module_workflow_events(tenant_id,record_id,occurred_at DESC);

CREATE TABLE app.module_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  object_key text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size>=0),
  checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
  uploaded_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,object_key),
  FOREIGN KEY(tenant_id,record_id) REFERENCES app.module_records(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX module_documents_record ON app.module_documents(tenant_id,record_id,status,created_at DESC);

CREATE TABLE app.module_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  author_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,record_id) REFERENCES app.module_records(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX module_comments_record_time ON app.module_comments(tenant_id,record_id,created_at DESC);

CREATE TRIGGER module_snapshots_immutable BEFORE UPDATE OR DELETE ON app.module_record_snapshots FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER module_workflow_immutable BEFORE UPDATE OR DELETE ON app.module_workflow_events FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DO $$ DECLARE q text; s text; n text; p text; BEGIN
  FOREACH q IN ARRAY ARRAY[
    'app.module_records','app.module_record_snapshots','app.module_workflow_events','app.module_documents','app.module_comments'
  ] LOOP
    s:=split_part(q,'.',1); n:=split_part(q,'.',2); p:=n||'_tenant_isolation';
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,n);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,n);
    EXECUTE format('CREATE POLICY %I ON %I.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',p,s,n);
  END LOOP;
END $$;

COMMIT;
