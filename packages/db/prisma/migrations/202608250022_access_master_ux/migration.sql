BEGIN;
SELECT set_config('app.platform_context','on',true);

ALTER TABLE app.client_locations
  ADD COLUMN address_snapshot jsonb,
  ADD COLUMN postal_locality_id uuid,
  ADD COLUMN postal_directory_version_id uuid,
  ADD CONSTRAINT client_locations_postal_snapshot_complete CHECK (
    (address_snapshot IS NULL AND postal_locality_id IS NULL AND postal_directory_version_id IS NULL)
    OR (address_snapshot IS NOT NULL AND postal_locality_id IS NOT NULL AND postal_directory_version_id IS NOT NULL)
  );

ALTER TABLE app.vendors
  ADD COLUMN address_snapshot jsonb,
  ADD COLUMN postal_locality_id uuid,
  ADD COLUMN postal_directory_version_id uuid,
  ADD CONSTRAINT vendors_postal_snapshot_complete CHECK (
    (address_snapshot IS NULL AND postal_locality_id IS NULL AND postal_directory_version_id IS NULL)
    OR (address_snapshot IS NOT NULL AND postal_locality_id IS NOT NULL AND postal_directory_version_id IS NOT NULL)
  );

ALTER TABLE app.drivers
  ADD COLUMN address_snapshot jsonb,
  ADD COLUMN postal_locality_id uuid,
  ADD COLUMN postal_directory_version_id uuid,
  ADD CONSTRAINT drivers_postal_snapshot_complete CHECK (
    (address_snapshot IS NULL AND postal_locality_id IS NULL AND postal_directory_version_id IS NULL)
    OR (address_snapshot IS NOT NULL AND postal_locality_id IS NOT NULL AND postal_directory_version_id IS NOT NULL)
  );

CREATE TABLE app.transport_reference_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('TRUCK_TYPE','BODY_TYPE','CARGO_TYPE')),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description text,
  capacity_milli bigint CHECK (capacity_milli IS NULL OR capacity_milli > 0),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,kind,code)
);
CREATE INDEX transport_reference_lookup
  ON app.transport_reference_masters(tenant_id,kind,state,name,id);

ALTER TABLE app.vehicles
  ADD COLUMN truck_type_id uuid,
  ADD COLUMN body_type_id uuid,
  ADD CONSTRAINT vehicles_truck_type_fk FOREIGN KEY(tenant_id,truck_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT vehicles_body_type_fk FOREIGN KEY(tenant_id,body_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT;

ALTER TABLE app.contract_lanes
  ADD COLUMN truck_type_id uuid,
  ADD COLUMN cargo_type_id uuid,
  ADD CONSTRAINT contract_lanes_truck_type_fk FOREIGN KEY(tenant_id,truck_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT contract_lanes_cargo_type_fk FOREIGN KEY(tenant_id,cargo_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT;

ALTER TABLE app.indents
  ADD COLUMN body_type_id uuid,
  ADD COLUMN cargo_type_id uuid,
  ADD CONSTRAINT indents_body_type_fk FOREIGN KEY(tenant_id,body_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT indents_cargo_type_fk FOREIGN KEY(tenant_id,cargo_type_id)
    REFERENCES app.transport_reference_masters(tenant_id,id) ON DELETE RESTRICT;

ALTER TABLE app.transport_reference_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transport_reference_masters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_transport_reference_masters ON app.transport_reference_masters
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');

-- The runtime role owns application DML, while postal mutation remains limited
-- to the offline importer. UUID primary keys do not create a new sequence, but
-- retaining schema-wide sequence usage keeps this migration compatible with
-- existing repository privilege policy.
GRANT USAGE ON SCHEMA app TO logistics_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.transport_reference_masters TO logistics_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app TO logistics_app;

-- Fresh databases still hold the directory in app until the ownership handoff;
-- upgraded databases have already moved it to postal_reference. Resolve both
-- forward-safe paths without weakening the immutable postal write boundary.
DO $$
DECLARE
  locality_table text;
  version_table text;
  target_table text;
  prefix text;
BEGIN
  IF to_regclass('postal_reference.postal_localities') IS NOT NULL THEN
    locality_table := 'postal_reference.postal_localities';
    version_table := 'postal_reference.postal_directory_versions';
  ELSE
    locality_table := 'app.postal_localities';
    version_table := 'app.postal_directory_versions';
  END IF;

  FOREACH target_table IN ARRAY ARRAY['app.client_locations','app.vendors','app.drivers'] LOOP
    prefix := split_part(target_table,'.',2);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=target_table::regclass
        AND conname=prefix||'_postal_locality_fk'
    ) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(postal_locality_id) REFERENCES %s(id) ON DELETE RESTRICT',
          target_table,
          prefix||'_postal_locality_fk',
          locality_table
        );
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Deferring % postal-locality FK to the administrator ownership handoff', target_table;
      END;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=target_table::regclass
        AND conname=prefix||'_postal_directory_version_fk'
    ) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(postal_directory_version_id) REFERENCES %s(id) ON DELETE RESTRICT',
          target_table,
          prefix||'_postal_directory_version_fk',
          version_table
        );
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Deferring % postal-version FK to the administrator ownership handoff', target_table;
      END;
    END IF;
  END LOOP;
END $$;

COMMIT;
