-- INT-02 command catalogue: keep persisted proposals constrained to the
-- reviewed, server-registered write intents. Read-only queries are executed
-- immediately and deliberately cannot be inserted as proposals.
BEGIN;
SELECT set_config('app.platform_context','on',true);

ALTER TABLE app.conversation_proposals
  DROP CONSTRAINT conversation_proposals_intent_check;

ALTER TABLE app.conversation_proposals
  ADD CONSTRAINT conversation_proposals_intent_check CHECK (
    intent IN (
      'PROBE_CREATE',
      'PROBE_UPDATE',
      'GOVERNED_COMMENT_CREATE',
      'IMPORT_PREVIEW',
      'IMPORT_COMMIT',
      'DOCUMENT_UPLOAD',
      'CLIENT_CREATE',
      'VENDOR_CREATE',
      'RECORD_RECEIPT',
      'OPERATIONS_STATUS_UPDATE',
      'FINANCE_STATUS_UPDATE',
      'APPROVAL_DECIDE'
    )
  );

-- Confirmation attempts are deliberately separate from business executions:
-- rejected/failed commands roll their business transaction back, while this
-- append-only record preserves a safe operational and security outcome.
CREATE TABLE app.conversation_confirmation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  proposal_id uuid,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  idempotency_key_hash text NOT NULL,
  request_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','DENIED','FAILED')),
  error_code text,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,proposal_id) REFERENCES app.conversation_proposals(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX conversation_confirmation_attempts_lookup
  ON app.conversation_confirmation_attempts(tenant_id,membership_id,idempotency_key_hash,created_at DESC);

CREATE TRIGGER conversation_confirmation_attempts_immutable
  BEFORE UPDATE OR DELETE ON app.conversation_confirmation_attempts
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

ALTER TABLE app.conversation_confirmation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversation_confirmation_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_confirmation_attempts_tenant_isolation ON app.conversation_confirmation_attempts
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');
GRANT SELECT,INSERT ON app.conversation_confirmation_attempts TO logistics_app;

COMMIT;
