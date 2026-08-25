BEGIN;
SELECT set_config('app.platform_context','on',true);

CREATE TABLE app.postal_directory_versions (
  id uuid PRIMARY KEY,
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  version text NOT NULL,
  source_name text NOT NULL,
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT false,
  imported_at timestamptz NOT NULL,
  UNIQUE (country, version)
);

CREATE UNIQUE INDEX postal_directory_one_active_country
  ON app.postal_directory_versions(country) WHERE active;

CREATE TABLE app.postal_localities (
  id uuid PRIMARY KEY,
  directory_version_id uuid NOT NULL REFERENCES app.postal_directory_versions(id),
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  postal_code text NOT NULL CHECK (postal_code ~ '^[1-9][0-9]{5}$'),
  locality_code text NOT NULL,
  locality_name text NOT NULL,
  city_name text NOT NULL,
  region_name text NOT NULL,
  UNIQUE (directory_version_id, postal_code, locality_code)
);

CREATE INDEX postal_localities_lookup
  ON app.postal_localities(country, postal_code, locality_name, id);

INSERT INTO app.postal_directory_versions
  (id,country,version,source_name,checksum_sha256,active,imported_at)
VALUES
  ('10000000-0000-4000-8000-000000000001','IN','2026-08-25-fixture','Repository bootstrap fixture',repeat('a',64),true,'2026-08-25T00:00:00Z');

INSERT INTO app.postal_localities
  (id,directory_version_id,country,postal_code,locality_code,locality_name,city_name,region_name)
VALUES
  ('50001600-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','IN','500016','BEGUMPET','Begumpet','Hyderabad','Telangana'),
  ('56004300-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','IN','560043','BANASWADI','Banaswadi','Bengaluru','Karnataka'),
  ('70000100-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','IN','700001','KOLKATA-GPO','Kolkata GPO','Kolkata','West Bengal'),
  ('11000100-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','IN','110001','CONNAUGHT-PLACE','Connaught Place','New Delhi','Delhi'),
  ('11000100-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','IN','110001','PARLIAMENT-STREET','Parliament Street','New Delhi','Delhi');

COMMIT;
