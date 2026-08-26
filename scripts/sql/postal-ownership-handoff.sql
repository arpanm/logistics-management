\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_owner') THEN
    RAISE EXCEPTION 'Create NOLOGIN role logistics_postal_owner before postal ownership handoff';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_importer') THEN
    RAISE EXCEPTION 'Create LOGIN role logistics_postal_importer before postal ownership handoff';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_app') THEN
    RAISE EXCEPTION 'Create LOGIN role logistics_app before postal ownership handoff';
  END IF;
END $$;

-- RDS master users have rds_superuser rather than PostgreSQL superuser.
-- The migrated objects are owned by logistics_app, so the master must
-- temporarily assume that role; the existing owner must also be allowed to
-- transfer objects to logistics_postal_owner. Remove both memberships before
-- commit so neither the runtime nor master retains owner access.
DO $$
BEGIN
  EXECUTE format('GRANT logistics_app TO %I', session_user);
  EXECUTE format('GRANT logistics_postal_owner TO %I', session_user);
  GRANT logistics_postal_owner TO logistics_app;
END $$;

SET ROLE logistics_app;

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

-- Clean databases move the directory above after all migrations; upgraded
-- databases already have it in postal_reference before later migrations run.
-- Install every deferred snapshot FK idempotently after both orders converge.
DO $$
DECLARE
  target_table text;
  prefix text;
BEGIN
  IF to_regclass('app.organization_addresses') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='app' AND table_name='organization_addresses'
         AND column_name='postal_locality_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='app' AND table_name='organization_addresses'
         AND column_name='postal_directory_version_id'
     ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='app.organization_addresses'::regclass
        AND conname='organization_addresses_postal_locality_fk'
    ) THEN
      ALTER TABLE app.organization_addresses
        ADD CONSTRAINT organization_addresses_postal_locality_fk
        FOREIGN KEY (postal_locality_id)
        REFERENCES postal_reference.postal_localities(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='app.organization_addresses'::regclass
        AND conname='organization_addresses_postal_directory_version_fk'
    ) THEN
      ALTER TABLE app.organization_addresses
        ADD CONSTRAINT organization_addresses_postal_directory_version_fk
        FOREIGN KEY (postal_directory_version_id)
        REFERENCES postal_reference.postal_directory_versions(id) ON DELETE RESTRICT;
    END IF;
  END IF;
  FOREACH target_table IN ARRAY ARRAY['app.client_locations','app.vendors','app.drivers'] LOOP
    IF to_regclass(target_table) IS NULL THEN
      CONTINUE;
    END IF;
    prefix := split_part(target_table,'.',2);
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name=prefix
        AND column_name='postal_locality_id'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name=prefix
        AND column_name='postal_directory_version_id'
    ) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=target_table::regclass
        AND conname=prefix||'_postal_locality_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(postal_locality_id) REFERENCES postal_reference.postal_localities(id) ON DELETE RESTRICT',
        target_table,
        prefix||'_postal_locality_fk'
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=target_table::regclass
        AND conname=prefix||'_postal_directory_version_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(postal_directory_version_id) REFERENCES postal_reference.postal_directory_versions(id) ON DELETE RESTRICT',
        target_table,
        prefix||'_postal_directory_version_fk'
      );
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA postal_reference FROM PUBLIC,logistics_app,logistics_postal_importer;
GRANT USAGE ON SCHEMA postal_reference TO logistics_app,logistics_postal_importer;
REVOKE ALL ON postal_reference.postal_directory_versions,postal_reference.postal_localities FROM PUBLIC,logistics_app,logistics_postal_importer;
GRANT SELECT,REFERENCES ON postal_reference.postal_directory_versions,postal_reference.postal_localities TO logistics_app;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON postal_reference.postal_directory_versions,postal_reference.postal_localities TO logistics_postal_importer;
REVOKE ALL ON FUNCTION postal_reference.guard_postal_directory_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION postal_reference.guard_postal_directory_mutation() TO logistics_app,logistics_postal_importer;

RESET ROLE;

DO $$
BEGIN
  REVOKE logistics_postal_owner FROM logistics_app;
  EXECUTE format('REVOKE logistics_postal_owner FROM %I', session_user);
  EXECUTE format('REVOKE logistics_app FROM %I', session_user);
END $$;

COMMIT;
