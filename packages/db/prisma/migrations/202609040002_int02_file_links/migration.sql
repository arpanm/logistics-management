-- INT-02: append-only evidence linking quarantined conversation files to
-- governed DAT-01 and GOV-01 records created from confirmed proposals.
BEGIN;
SELECT set_config('app.platform_context','on',true);

CREATE TABLE app.conversation_file_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('IMPORT_PREVIEW','IMPORT_COMMIT','GOVERNED_DOCUMENT')),
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  idempotency_key_hash text NOT NULL CHECK(idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  import_job_id uuid,
  document_version_id uuid,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,attachment_id,operation),
  FOREIGN KEY(tenant_id,attachment_id)
    REFERENCES app.conversation_attachments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,import_job_id)
    REFERENCES app.import_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,document_version_id)
    REFERENCES app.governed_document_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,membership_id)
    REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  CHECK(
    (operation IN ('IMPORT_PREVIEW','IMPORT_COMMIT') AND import_job_id IS NOT NULL AND document_version_id IS NULL)
    OR
    (operation='GOVERNED_DOCUMENT' AND import_job_id IS NULL AND document_version_id IS NOT NULL)
  )
);
CREATE INDEX conversation_file_handoffs_actor
  ON app.conversation_file_handoffs(tenant_id,membership_id,created_at DESC);

ALTER TABLE app.conversation_file_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversation_file_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_file_handoffs_tenant_isolation
  ON app.conversation_file_handoffs
  USING (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  );

CREATE TRIGGER conversation_file_handoffs_immutable
  BEFORE UPDATE OR DELETE ON app.conversation_file_handoffs
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

GRANT SELECT,INSERT ON app.conversation_file_handoffs TO logistics_app;

COMMIT;
