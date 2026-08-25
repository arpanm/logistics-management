BEGIN;

ALTER TABLE app.users
  ADD COLUMN membership_version integer NOT NULL DEFAULT 1
  CHECK (membership_version > 0);

CREATE OR REPLACE FUNCTION app.bump_user_membership_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.user_id IS NOT NULL THEN
      UPDATE app.users SET membership_version=membership_version+1
      WHERE id=NEW.user_id;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    IF OLD.user_id IS NOT NULL THEN
      UPDATE app.users SET membership_version=membership_version+1
      WHERE id=OLD.user_id;
    END IF;
    IF NEW.user_id IS NOT NULL THEN
      UPDATE app.users SET membership_version=membership_version+1
      WHERE id=NEW.user_id;
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.user_id IS NOT NULL THEN
    UPDATE app.users SET membership_version=membership_version+1
    WHERE id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_membership_identity_version
  AFTER INSERT OR UPDATE OF user_id,status ON app.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.bump_user_membership_version();

CREATE TABLE app.password_reset_request_limits (
  bucket_kind text NOT NULL
    CHECK (bucket_kind IN ('GLOBAL','SOURCE','IDENTIFIER')),
  key_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_kind,key_hash,window_start)
);
CREATE INDEX password_reset_request_limits_recent
  ON app.password_reset_request_limits(bucket_kind,key_hash,window_start DESC);
CREATE INDEX password_reset_request_limits_cleanup
  ON app.password_reset_request_limits(window_start);
ALTER TABLE app.password_reset_request_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.password_reset_request_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_request_limits_platform_only
  ON app.password_reset_request_limits
  USING (current_setting('app.platform_context',true)='on')
  WITH CHECK (current_setting('app.platform_context',true)='on');

CREATE TABLE app.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  user_membership_version integer NOT NULL CHECK (user_membership_version > 0),
  requested_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  request_source text NOT NULL CHECK (request_source IN ('SELF_SERVICE','TENANT_ADMIN')),
  token_hash text NOT NULL UNIQUE,
  token_envelope text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,membership_id)
    REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (requested_by IS NULL OR request_source='TENANT_ADMIN'),
  CHECK (
    request_source<>'SELF_SERVICE'
    OR token_envelope IS NOT NULL
    OR used_at IS NOT NULL
    OR revoked_at IS NOT NULL
  )
);

CREATE INDEX password_reset_tokens_tenant_membership
  ON app.password_reset_tokens(tenant_id,membership_id,created_at DESC);
CREATE INDEX password_reset_tokens_user_live
  ON app.password_reset_tokens(user_id,expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION app.validate_password_reset_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.tenant_memberships m
    WHERE m.tenant_id=NEW.tenant_id AND m.id=NEW.membership_id
      AND m.user_id=NEW.user_id AND m.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'password reset membership mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER password_reset_membership_validate
  BEFORE INSERT OR UPDATE OF tenant_id,membership_id,user_id
  ON app.password_reset_tokens FOR EACH ROW
  EXECUTE FUNCTION app.validate_password_reset_membership();

ALTER TABLE app.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_tenant_isolation
  ON app.password_reset_tokens
  USING (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  );

GRANT SELECT,INSERT,UPDATE,DELETE ON app.password_reset_tokens TO logistics_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.password_reset_request_limits TO logistics_app;

COMMIT;
