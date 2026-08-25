BEGIN;
SELECT set_config('app.platform_context','on',true);

ALTER TABLE app.postal_directory_versions
  ADD COLUMN status text,
  ADD COLUMN source_uri text,
  ADD COLUMN source_filename text,
  ADD COLUMN row_count integer,
  ADD COLUMN imported_by text,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_by text;

UPDATE app.postal_directory_versions v
SET status=CASE WHEN active THEN 'ACTIVE' ELSE 'RETIRED' END,
    source_filename='repository-bootstrap-fixture.csv',
    source_uri='repository://FND-01/postal-fixture',
    row_count=(SELECT count(*)::int FROM app.postal_localities l WHERE l.directory_version_id=v.id),
    imported_by='migration:202608250011',
    activated_at=CASE WHEN active THEN imported_at ELSE NULL END,
    activated_by=CASE WHEN active THEN 'migration:202608250011' ELSE NULL END;

ALTER TABLE app.postal_directory_versions
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN row_count SET NOT NULL,
  ALTER COLUMN imported_by SET NOT NULL,
  ADD CONSTRAINT postal_directory_status_check CHECK (status IN ('STAGED','ACTIVE','RETIRED')),
  ADD CONSTRAINT postal_directory_active_status_check CHECK (active=(status='ACTIVE')),
  ADD CONSTRAINT postal_directory_activation_check CHECK (
    (status='ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
    OR status<>'ACTIVE'
  ),
  ADD CONSTRAINT postal_directory_row_count_check CHECK (row_count>0);

ALTER TABLE app.postal_localities
  ADD COLUMN district_name text,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

UPDATE app.postal_localities SET district_name=CASE postal_code
  WHEN '500016' THEN 'Hyderabad'
  WHEN '560043' THEN 'Bengaluru Urban'
  WHEN '700001' THEN 'Kolkata'
  WHEN '110001' THEN 'New Delhi'
  ELSE region_name
END;

ALTER TABLE app.postal_localities ALTER COLUMN district_name SET NOT NULL;

CREATE UNIQUE INDEX postal_localities_canonical_identity
  ON app.postal_localities(
    directory_version_id,country,postal_code,
    lower(locality_name),lower(district_name),lower(city_name),lower(region_name)
  );

WITH matches AS (
  SELECT t.id,l.id AS locality_id,l.locality_name,l.city_name,l.region_name,l.district_name,
         v.id AS version_id,v.version,
         count(*) OVER (PARTITION BY t.id) AS match_count
  FROM app.tenants t
  JOIN app.postal_directory_versions v ON v.status='ACTIVE'
  JOIN app.postal_localities l ON l.directory_version_id=v.id AND l.active
    AND l.country=upper(coalesce(t.address->>'country','IN'))
    AND l.postal_code=t.address->>'postalCode'
    AND (t.address->>'city' IS NULL OR lower(l.city_name)=lower(t.address->>'city'))
    AND (t.address->>'region' IS NULL OR lower(l.region_name)=lower(t.address->>'region'))
  WHERE NOT (t.address ? 'postalLocalityId')
), unique_matches AS (
  SELECT * FROM matches WHERE match_count=1
)
UPDATE app.tenants t SET address=t.address || jsonb_build_object(
  'postalLocalityId',m.locality_id,
  'locality',m.locality_name,
  'city',m.city_name,
  'region',m.region_name,
  'district',m.district_name,
  'directoryVersionId',m.version_id,
  'directoryVersion',m.version,
  'postalReferenceStatus','LEGACY_SNAPSHOT'
) FROM unique_matches m WHERE t.id=m.id;

UPDATE app.tenants
SET address=address || jsonb_build_object('postalReferenceStatus','LEGACY_SNAPSHOT')
WHERE NOT (address ? 'postalReferenceStatus');

CREATE OR REPLACE FUNCTION app.guard_postal_directory_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.postal_import_context',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'postal directory rows are immutable outside the offline importer' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER postal_directory_versions_import_only
BEFORE INSERT OR UPDATE OR DELETE ON app.postal_directory_versions
FOR EACH ROW EXECUTE FUNCTION app.guard_postal_directory_mutation();

CREATE TRIGGER postal_localities_import_only
BEFORE INSERT OR UPDATE OR DELETE ON app.postal_localities
FOR EACH ROW EXECUTE FUNCTION app.guard_postal_directory_mutation();

REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.postal_directory_versions,app.postal_localities FROM PUBLIC;

COMMIT;
