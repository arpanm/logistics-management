-- INT-02: atomic, retryable claims for provider webhook events.
BEGIN;
SELECT set_config('app.platform_context','on',true);

-- This table is deliberately global and contains no message, phone, actor, or
-- tenant data. It coordinates delivery before an identity can be established.
CREATE TABLE app.conversation_provider_event_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 200),
  body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN ('PROCESSING','RETRY','COMPLETED')),
  attempts integer NOT NULL DEFAULT 1 CHECK(attempts > 0),
  lease_token_hash text,
  lease_expires_at timestamptz,
  disposition text CHECK(disposition IN ('ACCEPTED','UNBOUND','AMBIGUOUS','INVALID')),
  reply_ciphertext bytea,
  safe_error_code text,
  first_claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(provider,provider_event_id),
  CHECK((lease_token_hash IS NULL)=(lease_expires_at IS NULL)),
  CHECK((state='PROCESSING')=(lease_token_hash IS NOT NULL)),
  CHECK((state='COMPLETED')=(completed_at IS NOT NULL))
);
CREATE INDEX conversation_provider_event_claim_retry
  ON app.conversation_provider_event_claims(state,lease_expires_at,updated_at)
  WHERE state IN ('PROCESSING','RETRY');

CREATE TABLE app.conversation_provider_event_claim_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES app.conversation_provider_event_claims(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK(attempt_no > 0),
  outcome text NOT NULL CHECK(outcome IN ('CLAIMED','RETRY','COMPLETED')),
  safe_error_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(claim_id,attempt_no,outcome)
);
CREATE TRIGGER conversation_provider_event_claim_attempts_immutable
  BEFORE UPDATE OR DELETE ON app.conversation_provider_event_claim_attempts
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

GRANT SELECT,INSERT,UPDATE ON app.conversation_provider_event_claims TO logistics_app;
GRANT SELECT,INSERT ON app.conversation_provider_event_claim_attempts TO logistics_app;

COMMIT;
