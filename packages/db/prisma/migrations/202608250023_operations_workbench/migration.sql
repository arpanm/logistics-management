-- OPS-01/02/03 product workbench: tenant-owned, versioned allocation policy.
CREATE TABLE app.auto_allocation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  client_id uuid,
  lane_id uuid,
  vendor_id uuid,
  max_vehicles integer NOT NULL DEFAULT 1 CHECK (max_vehicles > 0),
  offer_rate_minor bigint NOT NULL DEFAULT 0 CHECK (offer_rate_minor >= 0),
  offer_valid_minutes integer NOT NULL DEFAULT 120 CHECK (offer_valid_minutes BETWEEN 5 AND 10080),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,name),
  FOREIGN KEY (tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,lane_id) REFERENCES app.contract_lanes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX auto_allocation_rules_match
  ON app.auto_allocation_rules(tenant_id,active,priority,client_id,lane_id);

CREATE TABLE app.auto_allocation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  rule_id uuid NOT NULL,
  indent_id uuid NOT NULL,
  allocation_id uuid,
  decision text NOT NULL CHECK (decision IN ('ALLOCATED','NO_ELIGIBLE_VENDOR','NO_REMAINING_DEMAND')),
  evidence jsonb NOT NULL DEFAULT '{}',
  executed_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  executed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES app.auto_allocation_rules(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,indent_id) REFERENCES app.indents(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,allocation_id) REFERENCES app.allocations(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX auto_allocation_executions_indent
  ON app.auto_allocation_executions(tenant_id,indent_id,executed_at DESC);
CREATE UNIQUE INDEX auto_allocation_execution_once
  ON app.auto_allocation_executions(tenant_id,rule_id,indent_id,allocation_id)
  WHERE allocation_id IS NOT NULL;

ALTER TABLE app.auto_allocation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auto_allocation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auto_allocation_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.auto_allocation_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY auto_allocation_rules_tenant ON app.auto_allocation_rules
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);
CREATE POLICY auto_allocation_executions_tenant ON app.auto_allocation_executions
  USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON app.auto_allocation_rules TO logistics_app;
GRANT SELECT,INSERT ON app.auto_allocation_executions TO logistics_app;
