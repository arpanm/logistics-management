BEGIN;
SELECT set_config('app.platform_context','on',true);

ALTER TABLE app.employees
  ADD COLUMN designation text,
  ADD CONSTRAINT employees_designation_length CHECK (designation IS NULL OR length(designation) BETWEEN 1 AND 120);

CREATE TABLE app.employee_region_coverage (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  organization_node_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, employee_id, organization_node_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX employee_region_coverage_node ON app.employee_region_coverage(tenant_id,organization_node_id,employee_id);

CREATE TABLE app.organization_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  organization_node_id uuid NOT NULL,
  line1 text NOT NULL CHECK (length(line1) BETWEEN 2 AND 160),
  line2 text,
  country char(2) NOT NULL DEFAULT 'IN' CHECK (country='IN'),
  postal_code text NOT NULL CHECK (postal_code ~ '^[1-9][0-9]{5}$'),
  postal_locality_id uuid NOT NULL,
  postal_directory_version_id uuid NOT NULL,
  postal_directory_version text NOT NULL,
  locality text NOT NULL,
  district text NOT NULL,
  city text NOT NULL,
  region text NOT NULL,
  provenance text NOT NULL DEFAULT 'DIRECTORY' CHECK (provenance='DIRECTORY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization_node_id),
  FOREIGN KEY (tenant_id, organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX organization_addresses_postal ON app.organization_addresses(tenant_id,postal_code,organization_node_id);

ALTER TABLE app.employee_region_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employee_region_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_employee_region_coverage ON app.employee_region_coverage
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');
CREATE POLICY tenant_isolation_organization_addresses ON app.organization_addresses
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on')
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid OR current_setting('app.platform_context',true)='on');

COMMIT;
