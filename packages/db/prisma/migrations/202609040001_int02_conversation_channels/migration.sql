-- INT-02: channel-neutral, confirmation-gated conversational commands.
BEGIN;
SELECT set_config('app.platform_context','on',true);

DROP TRIGGER IF EXISTS capability_catalog_read_only ON app.capability_catalog;
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,delegable,introduced_version)
VALUES
  ('conversation.use','Integrations','Use authenticated conversational workflows',false,true,3),
  ('conversation.admin','Integrations','Manage conversational channels and bindings',true,true,3)
ON CONFLICT(code) DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r
JOIN app.capability_catalog c ON c.code IN ('conversation.use','conversation.admin')
WHERE r.code='TENANT_OWNER'
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_read_only BEFORE UPDATE OR DELETE ON app.capability_catalog FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

CREATE TABLE app.conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK(channel IN ('WEB','WHATSAPP')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')), idempotency_key_hash text, request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  CHECK((idempotency_key_hash IS NULL)=(request_hash IS NULL))
);
CREATE INDEX conversation_threads_actor ON app.conversation_threads(tenant_id,membership_id,state,updated_at DESC);
CREATE UNIQUE INDEX conversation_threads_idempotency ON app.conversation_threads(tenant_id,actor_id,idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL;

CREATE TABLE app.conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL, actor_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
  kind text NOT NULL CHECK(kind IN ('USER','ASSISTANT','SYSTEM')),
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
  provider_event_id text, idempotency_key_hash text, request_hash text, in_reply_to_id uuid, correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,thread_id) REFERENCES app.conversation_threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,in_reply_to_id) REFERENCES app.conversation_messages(tenant_id,id) ON DELETE RESTRICT,
  CHECK((idempotency_key_hash IS NULL)=(request_hash IS NULL))
);
CREATE INDEX conversation_messages_thread ON app.conversation_messages(tenant_id,thread_id,created_at,id);
CREATE UNIQUE INDEX conversation_messages_provider_event ON app.conversation_messages(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX conversation_messages_idempotency ON app.conversation_messages(tenant_id,actor_id,idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL;

CREATE TABLE app.conversation_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL, filename text NOT NULL, media_type text NOT NULL,
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 5000000), checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL, scan_state text NOT NULL DEFAULT 'QUARANTINED' CHECK(scan_state IN ('QUARANTINED','PENDING','CLEAN','REJECTED')),
  dataset text, import_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,message_id) REFERENCES app.conversation_messages(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX conversation_attachments_message ON app.conversation_attachments(tenant_id,message_id);

CREATE TABLE app.conversation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL, source_message_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, intent text NOT NULL CHECK(intent IN ('PROBE_CREATE','PROBE_UPDATE','GOVERNED_COMMENT_CREATE','IMPORT_PREVIEW')),
  arguments jsonb NOT NULL CHECK(jsonb_typeof(arguments)='object'), summary text NOT NULL,
  risk text NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH')), requires_step_up boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED','DENIED','EXECUTED','FAILED')),
  confirmed_at timestamptz, cancelled_at timestamptz, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,thread_id) REFERENCES app.conversation_threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,source_message_id) REFERENCES app.conversation_messages(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX conversation_proposals_pending ON app.conversation_proposals(tenant_id,membership_id,state,expires_at);

CREATE TABLE app.conversation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, idempotency_key_hash text NOT NULL, request_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('SUCCEEDED','FAILED','DENIED')), result jsonb, error_code text,
  correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,proposal_id), UNIQUE(tenant_id,membership_id,idempotency_key_hash),
  FOREIGN KEY(tenant_id,proposal_id) REFERENCES app.conversation_proposals(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE app.whatsapp_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX whatsapp_link_challenges_active ON app.whatsapp_link_challenges(tenant_id,membership_id,expires_at) WHERE consumed_at IS NULL;

CREATE TABLE app.whatsapp_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  address_hash text NOT NULL CHECK(address_hash ~ '^[0-9a-f]{64}$'), address_ciphertext bytea NOT NULL,
  address_last4 text NOT NULL CHECK(address_last4 ~ '^[0-9]{4}$'), provider text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
  linked_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX whatsapp_bindings_lookup ON app.whatsapp_bindings(provider,address_hash,state);
CREATE UNIQUE INDEX whatsapp_bindings_active_address ON app.whatsapp_bindings(tenant_id,address_hash) WHERE state='ACTIVE';

-- Global receipt contains only verification/dedupe evidence, never message content or identity.
CREATE TABLE app.conversation_provider_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_id text NOT NULL,
  body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[0-9a-f]{64}$'), signature_verified boolean NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('ACCEPTED','DUPLICATE','UNBOUND','AMBIGUOUS','INVALID')),
  received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,provider_event_id)
);

CREATE TRIGGER conversation_messages_immutable BEFORE UPDATE OR DELETE ON app.conversation_messages FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER conversation_executions_immutable BEFORE UPDATE OR DELETE ON app.conversation_executions FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER conversation_provider_receipts_immutable BEFORE UPDATE OR DELETE ON app.conversation_provider_receipts FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['conversation_threads','conversation_messages','conversation_attachments','conversation_proposals','conversation_executions','whatsapp_link_challenges','whatsapp_bindings'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY %I ON app.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',n||'_tenant_isolation',n);
  END LOOP;
END $$;

-- Runtime gets only the operations needed by this module. In particular,
-- provider receipts can be appended/read for dedupe but never changed/deleted.
GRANT SELECT,INSERT,UPDATE ON app.conversation_threads,app.conversation_attachments,app.conversation_proposals,app.whatsapp_link_challenges,app.whatsapp_bindings TO logistics_app;
GRANT SELECT,INSERT ON app.conversation_messages,app.conversation_executions,app.conversation_provider_receipts TO logistics_app;

COMMIT;
