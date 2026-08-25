BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_importer') THEN
    RAISE EXCEPTION 'Required database login logistics_postal_importer is missing; provision it before migrations';
  END IF;
END $$;
GRANT ALL PRIVILEGES ON app.postal_directory_versions,app.postal_localities TO logistics_postal_importer;
COMMIT;
