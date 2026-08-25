\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_owner') THEN
    RAISE EXCEPTION 'Create NOLOGIN role logistics_postal_owner before postal ownership handoff';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_importer') THEN
    RAISE EXCEPTION 'Create LOGIN role logistics_postal_importer before postal ownership handoff';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS postal_reference AUTHORIZATION logistics_postal_owner;
ALTER SCHEMA postal_reference OWNER TO logistics_postal_owner;

DO $$
BEGIN
  IF to_regclass('app.postal_directory_versions') IS NOT NULL THEN
    ALTER TABLE app.postal_directory_versions SET SCHEMA postal_reference;
  END IF;
  IF to_regclass('app.postal_localities') IS NOT NULL THEN
    ALTER TABLE app.postal_localities SET SCHEMA postal_reference;
  END IF;
  IF to_regprocedure('app.guard_postal_directory_mutation()') IS NOT NULL THEN
    ALTER FUNCTION app.guard_postal_directory_mutation() SET SCHEMA postal_reference;
  END IF;
END $$;

ALTER TABLE postal_reference.postal_directory_versions OWNER TO logistics_postal_owner;
ALTER TABLE postal_reference.postal_localities OWNER TO logistics_postal_owner;
ALTER FUNCTION postal_reference.guard_postal_directory_mutation() OWNER TO logistics_postal_owner;

REVOKE ALL ON SCHEMA postal_reference FROM PUBLIC,logistics_app,logistics_postal_importer;
GRANT USAGE ON SCHEMA postal_reference TO logistics_app,logistics_postal_importer;
REVOKE ALL ON postal_reference.postal_directory_versions,postal_reference.postal_localities FROM PUBLIC,logistics_app,logistics_postal_importer;
GRANT SELECT ON postal_reference.postal_directory_versions,postal_reference.postal_localities TO logistics_app;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON postal_reference.postal_directory_versions,postal_reference.postal_localities TO logistics_postal_importer;
REVOKE ALL ON FUNCTION postal_reference.guard_postal_directory_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION postal_reference.guard_postal_directory_mutation() TO logistics_app,logistics_postal_importer;
