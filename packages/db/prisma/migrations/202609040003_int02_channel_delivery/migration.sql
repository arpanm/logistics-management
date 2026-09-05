-- INT-02: consented WhatsApp delivery with PostgreSQL leasing and evidence.
BEGIN;
SELECT set_config('app.platform_context','on',true);

-- A membership has one current delivery address. The link flow revokes its
-- previous binding before inserting the replacement.
WITH ranked AS (
  SELECT id,row_number() OVER(
    PARTITION BY tenant_id,membership_id
    ORDER BY linked_at DESC,id DESC
  ) AS position
  FROM app.whatsapp_bindings WHERE state='ACTIVE'
)
UPDATE app.whatsapp_bindings b
SET state='REVOKED',revoked_at=coalesce(revoked_at,now())
FROM ranked r WHERE b.id=r.id AND r.position>1;
CREATE UNIQUE INDEX whatsapp_bindings_active_membership
  ON app.whatsapp_bindings(tenant_id,membership_id)
  WHERE state='ACTIVE';

CREATE TABLE app.whatsapp_channel_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  proactive_state text NOT NULL DEFAULT 'OPTED_OUT'
    CHECK(proactive_state IN ('OPTED_IN','OPTED_OUT')),
  quiet_start time,
  quiet_end time,
  consent_source text CHECK(consent_source IN ('WHATSAPP','WEB_ADMIN')),
  consent_provider_event_id text,
  consented_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,membership_id),
  FOREIGN KEY(tenant_id,membership_id)
    REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  CHECK((quiet_start IS NULL)=(quiet_end IS NULL)),
  CHECK(proactive_state='OPTED_OUT' OR consented_at IS NOT NULL)
);

CREATE TABLE app.conversation_channel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  conversation_message_id uuid,
  notification_delivery_id uuid,
  category text NOT NULL CHECK(category IN ('TRANSACTIONAL','PROACTIVE')),
  template_code text,
  template_parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  rendered_body text NOT NULL CHECK(length(rendered_body) BETWEEN 1 AND 4096),
  deduplication_key text NOT NULL CHECK(length(deduplication_key) BETWEEN 8 AND 240),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING','LEASED','DELIVERED','RETRY','DEAD_LETTER','SUPPRESSED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token_hash text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,deduplication_key),
  FOREIGN KEY(tenant_id,membership_id)
    REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,conversation_message_id)
    REFERENCES app.conversation_messages(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,notification_delivery_id)
    REFERENCES app.notification_deliveries(tenant_id,id) ON DELETE RESTRICT,
  CHECK((lease_token_hash IS NULL)=(lease_expires_at IS NULL)),
  CHECK(category='TRANSACTIONAL' OR template_code IS NOT NULL)
);
CREATE INDEX conversation_channel_delivery_queue
  ON app.conversation_channel_deliveries(state,available_at,id)
  WHERE state IN ('PENDING','RETRY','LEASED');

CREATE TABLE app.conversation_channel_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK(attempt_no > 0),
  outcome text NOT NULL CHECK(outcome IN ('DELIVERED','RETRY','DEAD_LETTER','SUPPRESSED')),
  provider_message_id text,
  safe_error_code text,
  latency_ms integer CHECK(latency_ms IS NULL OR latency_ms >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,delivery_id,attempt_no),
  FOREIGN KEY(tenant_id,delivery_id)
    REFERENCES app.conversation_channel_deliveries(tenant_id,id) ON DELETE RESTRICT
);

CREATE TRIGGER conversation_channel_delivery_attempts_immutable
  BEFORE UPDATE OR DELETE ON app.conversation_channel_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY[
    'whatsapp_channel_preferences',
    'conversation_channel_deliveries',
    'conversation_channel_delivery_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',
      n||'_tenant_isolation',n
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE ON
  app.whatsapp_channel_preferences,
  app.conversation_channel_deliveries
  TO logistics_app;
GRANT SELECT,INSERT ON app.conversation_channel_delivery_attempts TO logistics_app;

COMMIT;
