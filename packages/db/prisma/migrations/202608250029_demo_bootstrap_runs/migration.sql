BEGIN;
SELECT set_config('app.platform_context','on',true);

CREATE TABLE app.demo_bootstrap_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  dataset text NOT NULL CHECK (dataset ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  dataset_version text NOT NULL CHECK (length(dataset_version) BETWEEN 1 AND 40),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  anchor_date date NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,dataset,dataset_version)
);
CREATE INDEX demo_bootstrap_runs_tenant_dataset
  ON app.demo_bootstrap_runs(tenant_id,dataset,anchor_date DESC);

ALTER TABLE app.demo_bootstrap_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.demo_bootstrap_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_bootstrap_runs_tenant_isolation ON app.demo_bootstrap_runs
  USING (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid
    OR current_setting('app.platform_context',true)='on'
  );

GRANT USAGE ON SCHEMA app TO logistics_app;
GRANT SELECT,INSERT ON app.demo_bootstrap_runs TO logistics_app;

COMMIT;
