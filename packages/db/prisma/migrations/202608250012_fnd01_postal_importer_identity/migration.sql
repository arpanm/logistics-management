BEGIN;
SELECT set_config('app.platform_context','on',true);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_importer') THEN
    RAISE EXCEPTION 'Required database login logistics_postal_importer is missing; provision it before migrations';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.guard_postal_directory_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF session_user <> 'logistics_postal_importer' THEN
    RAISE EXCEPTION 'postal directory mutations require logistics_postal_importer' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.postal_directory_versions,app.postal_localities FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.postal_directory_versions,app.postal_localities FROM logistics_app;
GRANT USAGE ON SCHEMA app TO logistics_postal_importer;
GRANT SELECT,INSERT,UPDATE ON app.postal_directory_versions,app.postal_localities TO logistics_postal_importer;

COMMIT;
