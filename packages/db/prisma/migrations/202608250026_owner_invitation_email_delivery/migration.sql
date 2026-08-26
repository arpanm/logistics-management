BEGIN;

ALTER TABLE app.invitation_delivery_attempts
  ADD COLUMN secret_envelope text,
  ADD COLUMN provider_message_id text;

COMMENT ON COLUMN app.invitation_delivery_attempts.secret_envelope IS
  'AES-256-GCM authenticated envelope for one pending activation token; cleared after a delivery attempt.';
COMMENT ON COLUMN app.invitation_delivery_attempts.provider_message_id IS
  'Opaque provider receipt identifier; never an activation credential.';

COMMIT;
