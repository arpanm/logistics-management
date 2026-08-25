-- Canonical governed, master, operations, finance, and edge records.
BEGIN;
SELECT set_config('app.platform_context','on',true);

-- Batch A: governed evidence and tenant configuration.
CREATE TABLE app.invitation_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  invitation_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('EMAIL','SMS')),
  destination_hash text NOT NULL, state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(), leased_at timestamptz,
  delivered_at timestamptz, failure_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,invitation_id,channel),
  FOREIGN KEY(tenant_id,invitation_id) REFERENCES app.owner_invitations(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX invitation_delivery_queue ON app.invitation_delivery_attempts(tenant_id,state,available_at);

CREATE TABLE app.governed_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  target_type text NOT NULL, target_id uuid NOT NULL, category text NOT NULL, confidentiality text NOT NULL CHECK(confidentiality IN ('INTERNAL','CLIENT','VENDOR','DRIVER')),
  current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0), verification_state text NOT NULL DEFAULT 'PENDING' CHECK(verification_state IN ('PENDING','VERIFIED','REJECTED','QUARANTINED')),
  issue_date date, expiry_date date, retention_until date, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,target_type,target_id,category,current_version)
);
CREATE INDEX governed_documents_target ON app.governed_documents(tenant_id,target_type,target_id,confidentiality);
CREATE TABLE app.governed_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, document_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), file_name text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
  checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[a-f0-9]{64}$'), content bytea NOT NULL, malware_state text NOT NULL CHECK(malware_state IN ('PENDING','CLEAN','REJECTED')),
  source text NOT NULL CHECK(source IN ('UPLOAD','IMPORT','API','GENERATED')), uploaded_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,document_id) REFERENCES app.governed_documents(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX governed_document_versions_document ON app.governed_document_versions(tenant_id,document_id,version DESC);
CREATE TABLE app.document_scan_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, document_version_id uuid NOT NULL,
  scanner text NOT NULL, signature_version text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('CLEAN','REJECTED')),
  reason_code text, scanned_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,document_version_id),
  FOREIGN KEY(tenant_id,document_version_id) REFERENCES app.governed_document_versions(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.document_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, document_version_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE, audience text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, issued_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,document_version_id) REFERENCES app.governed_document_versions(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.governed_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  target_type text NOT NULL, target_id uuid NOT NULL, body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), visibility text NOT NULL CHECK(visibility IN ('INTERNAL','CLIENT','VENDOR','DRIVER')),
  author_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, resolved_at timestamptz, resolved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1, UNIQUE(tenant_id,id)
);
CREATE INDEX governed_comments_target ON app.governed_comments(tenant_id,target_type,target_id,visibility,created_at DESC);
CREATE TABLE app.governed_comment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, comment_id uuid NOT NULL,
  version integer NOT NULL, body text NOT NULL, edited_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, edited_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,comment_id,version), FOREIGN KEY(tenant_id,comment_id) REFERENCES app.governed_comments(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.approval_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, target_type text NOT NULL, minimum_minor bigint, maximum_minor bigint, steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array'), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), CHECK(maximum_minor IS NULL OR minimum_minor IS NULL OR maximum_minor>minimum_minor)
);
CREATE TABLE app.approval_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, definition_id uuid NOT NULL,
  target_type text NOT NULL, target_id uuid NOT NULL, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
  requester_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPROVED','REJECTED','INVALIDATED','EXPIRED')),
  current_step integer NOT NULL DEFAULT 1, expires_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,definition_id) REFERENCES app.approval_definitions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX approval_instances_queue ON app.approval_instances(tenant_id,state,target_type,created_at);
CREATE TABLE app.approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, instance_id uuid NOT NULL,
  step integer NOT NULL CHECK(step>0), decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')), actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  actor_role_id uuid NOT NULL, comment text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,instance_id,step),
  FOREIGN KEY(tenant_id,instance_id) REFERENCES app.approval_instances(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,actor_role_id) REFERENCES app.roles(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.configuration_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  namespace text NOT NULL, version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  value jsonb NOT NULL, value_hash text NOT NULL, effective_from timestamptz NOT NULL, effective_to timestamptz,
  rollback_of uuid, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, published_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, UNIQUE(tenant_id,id), UNIQUE(tenant_id,namespace,version),
  FOREIGN KEY(tenant_id,rollback_of) REFERENCES app.configuration_versions(tenant_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE INDEX configuration_effective ON app.configuration_versions(tenant_id,namespace,state,effective_from,effective_to);
CREATE TABLE app.configuration_projection_versions (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE RESTRICT, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

-- Batch B: organization, commercial and supply masters.
CREATE TABLE app.organization_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, name text NOT NULL, node_type text NOT NULL CHECK(node_type IN ('LEGAL_ENTITY','REGION','BRANCH','TEAM','HUB')),
  parent_id uuid, authorization_scope_node_id uuid, timezone text NOT NULL, address text, latitude numeric(9,6), longitude numeric(9,6), postal_codes text[] NOT NULL DEFAULT '{}', geofence jsonb NOT NULL DEFAULT '{}',
  active_from date NOT NULL, active_to date, state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','INACTIVE')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), FOREIGN KEY(tenant_id,parent_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,authorization_scope_node_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK(active_to IS NULL OR active_to>=active_from)
);
CREATE INDEX organization_nodes_parent ON app.organization_nodes(tenant_id,parent_id,state);
CREATE TABLE app.organization_closure (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, ancestor_id uuid NOT NULL, descendant_id uuid NOT NULL, depth integer NOT NULL CHECK(depth>=0),
  PRIMARY KEY(tenant_id,ancestor_id,descendant_id), FOREIGN KEY(tenant_id,ancestor_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,descendant_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX organization_closure_descendant ON app.organization_closure(tenant_id,descendant_id,depth);
CREATE TABLE app.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  employee_code text NOT NULL, display_name text NOT NULL, email text, mobile text, manager_id uuid, home_node_id uuid NOT NULL, linked_membership_id uuid,
  active_from date NOT NULL, active_to date, state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','INACTIVE')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,employee_code), FOREIGN KEY(tenant_id,manager_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,home_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,linked_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT, CHECK(active_to IS NULL OR active_to>=active_from)
);
CREATE TABLE app.operational_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, employee_id uuid NOT NULL,
  assignment_type text NOT NULL CHECK(assignment_type IN ('MANAGER','KAM','TRAFFIC','QUEUE_OWNER')), organization_node_id uuid, client_id uuid,
  effective_from timestamptz NOT NULL, effective_to timestamptz, exception_reason text, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT, CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE INDEX operational_assignments_effective ON app.operational_assignments(tenant_id,assignment_type,effective_from,effective_to);
CREATE TABLE app.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  code text NOT NULL, legal_name text NOT NULL, industry text, billing_entity_id uuid NOT NULL, account_manager_employee_id uuid, authorization_scope_node_id uuid,
  tax_identifier text, escalation_email text, escalation_mobile text, credit_days integer NOT NULL DEFAULT 0 CHECK(credit_days BETWEEN 0 AND 365), pod_mode text NOT NULL DEFAULT 'PHYSICAL',
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','INACTIVE')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), FOREIGN KEY(tenant_id,billing_entity_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,account_manager_employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,authorization_scope_node_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE app.operational_assignments ADD CONSTRAINT operational_assignments_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT;
CREATE TABLE app.client_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, client_id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, location_type text NOT NULL, organization_node_id uuid NOT NULL, manager_employee_id uuid, authorization_scope_node_id uuid, mobile text, geofence jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','INACTIVE')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,client_id,code), FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,manager_employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,authorization_scope_node_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, client_id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING_APPROVAL','APPROVED','PUBLISHED','SUPERSEDED','INACTIVE')),
  current_version integer NOT NULL DEFAULT 1, effective_from date NOT NULL, effective_to date, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT, CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE app.contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, contract_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), credit_days integer NOT NULL CHECK(credit_days BETWEEN 0 AND 365), pod_mode text NOT NULL,
  document_requirements jsonb NOT NULL DEFAULT '[]', terms jsonb NOT NULL DEFAULT '{}', snapshot_hash text NOT NULL, published_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,contract_id,version),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES app.contracts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.contract_lanes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, contract_version_id uuid NOT NULL,
  code text NOT NULL, origin_location_id uuid NOT NULL, destination_location_id uuid NOT NULL, truck_type text NOT NULL, cargo_type text,
  quantity_min_milli bigint NOT NULL DEFAULT 0, quantity_max_milli bigint, priority integer NOT NULL DEFAULT 0, service_window jsonb NOT NULL DEFAULT '{}',
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,contract_version_id,code), FOREIGN KEY(tenant_id,contract_version_id) REFERENCES app.contract_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,origin_location_id) REFERENCES app.client_locations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,destination_location_id) REFERENCES app.client_locations(tenant_id,id) ON DELETE RESTRICT,
  CHECK(quantity_max_milli IS NULL OR quantity_max_milli>quantity_min_milli)
);
CREATE TABLE app.sla_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, lane_id uuid NOT NULL,
  placement_minutes integer NOT NULL CHECK(placement_minutes>=0), transit_minutes integer NOT NULL CHECK(transit_minutes>=0), pod_minutes integer NOT NULL CHECK(pod_minutes>=0),
  effective_from timestamptz NOT NULL, effective_to timestamptz, priority integer NOT NULL DEFAULT 0, UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,lane_id) REFERENCES app.contract_lanes(tenant_id,id) ON DELETE RESTRICT, CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE app.client_rate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, lane_id uuid NOT NULL,
  charge_code text NOT NULL, basis text NOT NULL, amount_minor bigint NOT NULL, tax_basis_points integer NOT NULL DEFAULT 0 CHECK(tax_basis_points BETWEEN 0 AND 10000),
  effective_from timestamptz NOT NULL, effective_to timestamptz, priority integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED','PUBLISHED','SUPERSEDED')),
  version integer NOT NULL DEFAULT 1, UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,lane_id) REFERENCES app.contract_lanes(tenant_id,id) ON DELETE RESTRICT,
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE INDEX client_rate_effective ON app.client_rate_lines(tenant_id,lane_id,charge_code,state,effective_from,effective_to,priority DESC);
CREATE TABLE app.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, code text NOT NULL, legal_name text NOT NULL,
  pan text, gstin text, tds_basis_points integer NOT NULL DEFAULT 0, msme_number text, payment_terms_days integer NOT NULL DEFAULT 0, onboarding_employee_id uuid, authorization_scope_node_id uuid,
  state text NOT NULL DEFAULT 'ONBOARDING' CHECK(state IN ('ONBOARDING','ACTIVE','BLOCKED','INACTIVE')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), UNIQUE(tenant_id,pan), UNIQUE(tenant_id,gstin), FOREIGN KEY(tenant_id,onboarding_employee_id) REFERENCES app.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,authorization_scope_node_id) REFERENCES app.authorization_scope_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.vendor_service_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_id uuid NOT NULL,
  organization_node_id uuid, lane_id uuid, effective_from timestamptz NOT NULL, effective_to timestamptz, UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,organization_node_id) REFERENCES app.organization_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,lane_id) REFERENCES app.contract_lanes(tenant_id,id) ON DELETE RESTRICT, CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE app.vendor_bank_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_id uuid NOT NULL,
  version integer NOT NULL, account_holder text NOT NULL, account_ciphertext bytea NOT NULL, account_last4 text NOT NULL, ifsc text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK(state IN ('PENDING_VERIFICATION','VERIFIED','REJECTED','SUPERSEDED')),
  maker_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, checker_id uuid REFERENCES app.users(id) ON DELETE RESTRICT, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,vendor_id,version), FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT,
  CHECK(checker_id IS NULL OR checker_id<>maker_id)
);
CREATE TABLE app.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_id uuid NOT NULL,
  registration_number text NOT NULL, vehicle_type text NOT NULL, make text, model text, model_year integer, capacity_milli bigint NOT NULL CHECK(capacity_milli>0), gps_device_id text,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','BLOCKED','INACTIVE')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,registration_number), FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_id uuid NOT NULL,
  code text NOT NULL, display_name text NOT NULL, mobile text NOT NULL, licence_number text NOT NULL, licence_class text NOT NULL, licence_valid_to date NOT NULL,
  emergency_contact text, portal_membership_id uuid, state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','BLOCKED','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code), UNIQUE(tenant_id,licence_number), FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,portal_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.compliance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK(subject_type IN ('VENDOR','VEHICLE','DRIVER')), subject_id uuid NOT NULL, requirement_code text NOT NULL, document_id uuid,
  valid_from date, valid_to date, verification_state text NOT NULL DEFAULT 'PENDING' CHECK(verification_state IN ('PENDING','VERIFIED','REJECTED')),
  verified_by uuid REFERENCES app.users(id) ON DELETE RESTRICT, verified_at timestamptz, UNIQUE(tenant_id,id), UNIQUE(tenant_id,subject_type,subject_id,requirement_code),
  FOREIGN KEY(tenant_id,document_id) REFERENCES app.governed_documents(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.eligibility_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL, subject_id uuid NOT NULL, context_type text NOT NULL, context_id uuid NOT NULL, reason text NOT NULL,
  expires_at timestamptz NOT NULL, approved_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), CHECK(approved_by<>created_by)
);

-- Batch C: contract-to-delivery execution.
CREATE TABLE app.indents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, indent_no text NOT NULL,
  client_id uuid NOT NULL, client_location_id uuid NOT NULL, contract_version_id uuid NOT NULL, lane_id uuid NOT NULL,
  requested_vehicles integer NOT NULL CHECK(requested_vehicles>0), quantity_milli bigint NOT NULL CHECK(quantity_milli>0), pickup_window_start timestamptz NOT NULL, pickup_window_end timestamptz NOT NULL,
  committed_placement_at timestamptz NOT NULL, commitment_override_reason text, owner_membership_id uuid, source text NOT NULL CHECK(source IN ('MANUAL','COPY','IMPORT','API')),
  source_reference text, cargo_type text, body_type text, commercial_snapshot jsonb NOT NULL, configuration_version_id uuid,
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','OPEN','PARTIALLY_ALLOCATED','FULFILLED','CANCELLED','CLOSED')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,indent_no), UNIQUE(tenant_id,source,source_reference),
  FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,client_location_id) REFERENCES app.client_locations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,contract_version_id) REFERENCES app.contract_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,lane_id) REFERENCES app.contract_lanes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,owner_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,configuration_version_id) REFERENCES app.configuration_versions(tenant_id,id) ON DELETE RESTRICT,
  CHECK(pickup_window_end>pickup_window_start)
);
CREATE INDEX indents_queue ON app.indents(tenant_id,state,committed_placement_at,client_id);
CREATE TABLE app.indent_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, indent_id uuid NOT NULL,
  cancelled_vehicles integer NOT NULL CHECK(cancelled_vehicles>0), reason text NOT NULL, vendor_cost_minor bigint NOT NULL DEFAULT 0,
  cancelled_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, cancelled_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,indent_id) REFERENCES app.indents(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, indent_id uuid NOT NULL, vendor_id uuid NOT NULL,
  allotted_vehicles integer NOT NULL CHECK(allotted_vehicles>0), offered_rate_minor bigint NOT NULL CHECK(offered_rate_minor>=0), offer_channel text NOT NULL,
  offered_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, response_at timestamptz, rejection_reason text,
  state text NOT NULL DEFAULT 'OFFERED' CHECK(state IN ('OFFERED','ACCEPTED','REJECTED','EXPIRED','VEHICLE_ASSIGNED','NTP_RELEASED','PLACED','CANCELLED')),
  owner_membership_id uuid, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,indent_id) REFERENCES app.indents(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,owner_membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT, CHECK(expires_at>offered_at)
);
CREATE INDEX allocations_queue ON app.allocations(tenant_id,state,expires_at,indent_id);
CREATE TABLE app.allocation_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, allocation_id uuid NOT NULL,
  vehicle_id uuid NOT NULL, driver_id uuid NOT NULL, assigned_from timestamptz NOT NULL DEFAULT now(), assigned_to timestamptz, replacement_reason text,
  assigned_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,allocation_id) REFERENCES app.allocations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,vehicle_id) REFERENCES app.vehicles(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,driver_id) REFERENCES app.drivers(tenant_id,id) ON DELETE RESTRICT, CHECK(assigned_to IS NULL OR assigned_to>assigned_from)
);
CREATE UNIQUE INDEX allocation_one_current_assignment ON app.allocation_assignments(tenant_id,allocation_id) WHERE assigned_to IS NULL;
CREATE TABLE app.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, allocation_id uuid NOT NULL,
  trip_no text NOT NULL, lr_no text NOT NULL, assigned_driver_id uuid NOT NULL, assigned_vehicle_id uuid NOT NULL,
  planned_pickup_at timestamptz NOT NULL, planned_delivery_at timestamptz NOT NULL, tracking_consent_from timestamptz, tracking_consent_to timestamptz,
  state text NOT NULL DEFAULT 'PLANNED' CHECK(state IN ('PLANNED','AT_ORIGIN','LOADED','IN_TRANSIT','AT_DESTINATION','DELIVERED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,trip_no), UNIQUE(tenant_id,lr_no), FOREIGN KEY(tenant_id,allocation_id) REFERENCES app.allocations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,assigned_driver_id) REFERENCES app.drivers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,assigned_vehicle_id) REFERENCES app.vehicles(tenant_id,id) ON DELETE RESTRICT, CHECK(planned_delivery_at>planned_pickup_at),
  CHECK(tracking_consent_to IS NULL OR tracking_consent_from IS NULL OR tracking_consent_to>tracking_consent_from)
);
CREATE TABLE app.trip_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, trip_id uuid NOT NULL,
  event_key text NOT NULL, event_type text NOT NULL, source text NOT NULL CHECK(source IN ('WEB','MOBILE','OFFLINE','GPS','API')),
  device_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), actor_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  latitude numeric(9,6), longitude numeric(9,6), speed_kph numeric(8,2), odometer_km numeric(12,2), evidence jsonb NOT NULL DEFAULT '{}', ordering_conflict boolean NOT NULL DEFAULT false,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,trip_id,event_key), FOREIGN KEY(tenant_id,trip_id) REFERENCES app.trips(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX trip_events_timeline ON app.trip_events(tenant_id,trip_id,device_at,received_at);
CREATE TABLE app.pod_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, trip_id uuid NOT NULL,
  delivered_at timestamptz NOT NULL, receiver_name text, receiver_evidence jsonb NOT NULL DEFAULT '{}', received_at timestamptz, submitted_at timestamptz,
  contract_snapshot jsonb NOT NULL, invoice_value_minor bigint NOT NULL DEFAULT 0, prior_period boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'AWAITING_POD' CHECK(state IN ('AWAITING_POD','RECEIVED','UNDER_REVIEW','ACCEPTED','SUBMITTED_TO_CLIENT','CLOSED','REJECTED','CORRECTION_REQUIRED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,trip_id), FOREIGN KEY(tenant_id,trip_id) REFERENCES app.trips(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.pod_invoice_links (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, pod_task_id uuid NOT NULL, invoice_reference text NOT NULL, invoice_date date, value_minor bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,pod_task_id,invoice_reference), FOREIGN KEY(tenant_id,pod_task_id) REFERENCES app.pod_tasks(tenant_id,id) ON DELETE RESTRICT
);

-- Batch D: immutable finance and settlement ledgers.
CREATE TABLE app.client_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, invoice_no text NOT NULL,
  client_id uuid NOT NULL, client_location_id uuid NOT NULL, invoice_date date NOT NULL, currency text NOT NULL, credit_days integer NOT NULL CHECK(credit_days BETWEEN 0 AND 365),
  taxable_minor bigint NOT NULL, tax_minor bigint NOT NULL, total_minor bigint NOT NULL, acknowledged_at timestamptz, due_date date,
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING_APPROVAL','REJECTED','APPROVED','POSTED','SUBMITTED','REVERSED')),
  reversal_of uuid, created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz, version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,invoice_no), FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,client_location_id) REFERENCES app.client_locations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,reversal_of) REFERENCES app.client_invoices(tenant_id,id) ON DELETE RESTRICT, CHECK(total_minor=taxable_minor+tax_minor)
);
CREATE TABLE app.client_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK(line_no>0), charge_code text NOT NULL, quantity_milli bigint NOT NULL, rate_minor bigint NOT NULL,
  taxable_minor bigint NOT NULL, tax_basis_points integer NOT NULL CHECK(tax_basis_points BETWEEN 0 AND 10000), tax_minor bigint NOT NULL, total_minor bigint NOT NULL,
  rate_snapshot jsonb NOT NULL, UNIQUE(tenant_id,id), UNIQUE(tenant_id,invoice_id,line_no), FOREIGN KEY(tenant_id,invoice_id) REFERENCES app.client_invoices(tenant_id,id) ON DELETE RESTRICT,
  CHECK(total_minor=taxable_minor+tax_minor)
);
CREATE TABLE app.invoice_service_links (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, invoice_line_id uuid NOT NULL, trip_id uuid NOT NULL, pod_task_id uuid,
  PRIMARY KEY(tenant_id,invoice_line_id,trip_id), UNIQUE(tenant_id,trip_id), FOREIGN KEY(tenant_id,invoice_line_id) REFERENCES app.client_invoice_lines(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,trip_id) REFERENCES app.trips(tenant_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,pod_task_id) REFERENCES app.pod_tasks(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, receipt_ref text NOT NULL,
  client_id uuid NOT NULL, payment_date date NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), mode text NOT NULL, instrument_no text NOT NULL,
  bank_reference text, state text NOT NULL DEFAULT 'UNRECONCILED' CHECK(state IN ('UNRECONCILED','PENDING_APPROVAL','RECONCILED','REVERSED')),
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,receipt_ref), UNIQUE(tenant_id,instrument_no), FOREIGN KEY(tenant_id,client_id) REFERENCES app.clients(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.receipt_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, receipt_id uuid NOT NULL,
  invoice_id uuid, entry_type text NOT NULL CHECK(entry_type IN ('ALLOCATION','DEDUCTION','ON_ACCOUNT','REVERSAL')),
  amount_minor bigint NOT NULL CHECK(amount_minor<>0), reverses_entry_id uuid, reason text, actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,receipt_id) REFERENCES app.receipts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,invoice_id) REFERENCES app.client_invoices(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,reverses_entry_id) REFERENCES app.receipt_ledger_entries(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX receipt_ledger_invoice ON app.receipt_ledger_entries(tenant_id,invoice_id,created_at);
CREATE TABLE app.collection_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, invoice_id uuid NOT NULL,
  outcome text NOT NULL, note text NOT NULL, promised_at date, promised_minor bigint, next_followup_at timestamptz,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,invoice_id) REFERENCES app.client_invoices(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_id uuid NOT NULL,
  vendor_invoice_no text NOT NULL, invoice_date date NOT NULL, taxable_minor bigint NOT NULL, gst_minor bigint NOT NULL, tds_minor bigint NOT NULL,
  deduction_minor bigint NOT NULL DEFAULT 0, advance_minor bigint NOT NULL DEFAULT 0, payable_minor bigint NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','VALIDATION_EXCEPTION','PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL','APPROVED','PART_PAID','PAID','DISPUTED','REVERSED')),
  verified_by uuid REFERENCES app.users(id) ON DELETE RESTRICT, approved_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,vendor_id,vendor_invoice_no), FOREIGN KEY(tenant_id,vendor_id) REFERENCES app.vendors(tenant_id,id) ON DELETE RESTRICT,
  CHECK(payable_minor=taxable_minor+gst_minor-tds_minor-deduction_minor-advance_minor), CHECK(approved_by IS NULL OR approved_by<>created_by)
);
CREATE TABLE app.vendor_bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, vendor_bill_id uuid NOT NULL,
  trip_id uuid NOT NULL, rate_snapshot jsonb NOT NULL, expected_minor bigint NOT NULL, claimed_minor bigint NOT NULL, variance_minor bigint NOT NULL,
  validation_state text NOT NULL CHECK(validation_state IN ('MATCHED','VARIANCE','BLOCKED')), UNIQUE(tenant_id,id), UNIQUE(tenant_id,vendor_bill_id,trip_id), UNIQUE(tenant_id,trip_id),
  FOREIGN KEY(tenant_id,vendor_bill_id) REFERENCES app.vendor_bills(tenant_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,trip_id) REFERENCES app.trips(tenant_id,id) ON DELETE RESTRICT,
  CHECK(variance_minor=claimed_minor-expected_minor)
);
CREATE TABLE app.payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, batch_no text NOT NULL,
  bank_version_id uuid NOT NULL, total_minor bigint NOT NULL CHECK(total_minor>0), state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING_APPROVAL','APPROVED','SUBMITTED','PAID','FAILED','REVERSED')),
  maker_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, checker_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  utr text, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1, UNIQUE(tenant_id,id), UNIQUE(tenant_id,batch_no), UNIQUE(tenant_id,utr),
  FOREIGN KEY(tenant_id,bank_version_id) REFERENCES app.vendor_bank_versions(tenant_id,id) ON DELETE RESTRICT, CHECK(checker_id IS NULL OR checker_id<>maker_id)
);
CREATE TABLE app.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, payment_batch_id uuid NOT NULL,
  vendor_bill_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor<>0), reversal_of uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,payment_batch_id) REFERENCES app.payment_batches(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,vendor_bill_id) REFERENCES app.vendor_bills(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,reversal_of) REFERENCES app.payment_allocations(tenant_id,id) ON DELETE RESTRICT
);

-- Batch E: canonical external edges.
CREATE TABLE app.api_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, code text NOT NULL,
  name text NOT NULL, credential_hash text NOT NULL, scopes text[] NOT NULL, state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','ROTATING','REVOKED')),
  rotated_from uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, UNIQUE(tenant_id,id), UNIQUE(tenant_id,code),
  FOREIGN KEY(tenant_id,rotated_from) REFERENCES app.api_clients(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, api_client_id uuid NOT NULL,
  event_key text NOT NULL, event_type text NOT NULL, payload_hash text NOT NULL, signature_version integer NOT NULL, correlation_id text NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK(state IN ('RECEIVED','PROCESSED','REJECTED')), received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,api_client_id,event_key), FOREIGN KEY(tenant_id,api_client_id) REFERENCES app.api_clients(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.integration_mapping_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, endpoint_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), schema jsonb NOT NULL, mapping jsonb NOT NULL, mapping_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,endpoint_id,version),
  FOREIGN KEY(tenant_id,endpoint_id) REFERENCES app.integration_endpoints(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.integration_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, delivery_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK(attempt_no>0), lease_token_hash text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  outcome text CHECK(outcome IN ('SUCCEEDED','RETRY','DEAD_LETTER')), status_code integer, latency_ms integer, safe_error_code text,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,delivery_id,attempt_no), FOREIGN KEY(tenant_id,delivery_id) REFERENCES app.integration_deliveries(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, alert_id uuid NOT NULL,
  membership_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('IN_APP','EMAIL','SMS','WHATSAPP')), destination_hash text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','LEASED','DELIVERED','FAILED','SUPPRESSED')), attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), leased_at timestamptz, delivered_at timestamptz, safe_error_code text,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,alert_id,membership_id,channel), FOREIGN KEY(tenant_id,alert_id) REFERENCES app.operational_alerts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,membership_id) REFERENCES app.tenant_memberships(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX notification_delivery_queue ON app.notification_deliveries(tenant_id,state,available_at);
CREATE TABLE app.notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, delivery_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK(attempt_no>0), outcome text NOT NULL CHECK(outcome IN ('DELIVERED','RETRY','FAILED','SUPPRESSED')),
  provider_reference text, safe_error_code text, occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,delivery_id,attempt_no),
  FOREIGN KEY(tenant_id,delivery_id) REFERENCES app.notification_deliveries(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.alert_rule_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT, rule_id uuid NOT NULL,
  evaluation_key text NOT NULL, observed_value numeric, boundary_value numeric, matched boolean NOT NULL, source_record_id uuid,
  evaluated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,rule_id,evaluation_key),
  FOREIGN KEY(tenant_id,rule_id) REFERENCES app.alert_rules(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.accounting_reconciliation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  document_type text NOT NULL, document_id uuid NOT NULL, event_key text NOT NULL, external_reference text,
  state text NOT NULL CHECK(state IN ('PENDING','EXPORTED','ACKNOWLEDGED','FAILED','REVERSED')), amount_minor bigint NOT NULL,
  safe_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_key)
);

-- Explicit command/evidence stores used by the canonical master, operations and
-- finance services.  These records are append-only; mutable aggregate state
-- remains on the owning header and is guarded by optimistic versions.
CREATE TABLE app.contract_change_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL, from_version integer NOT NULL, to_version integer NOT NULL, reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES app.contracts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.invoice_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL, note_type text NOT NULL CHECK(note_type IN ('ACKNOWLEDGEMENT','CREDIT_NOTE','DEBIT_NOTE','REVERSAL')),
  amount_minor bigint NOT NULL DEFAULT 0, reason text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}', actor_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,invoice_id) REFERENCES app.client_invoices(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.gps_device_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  device_id text NOT NULL, trip_id uuid, event_key text NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL, speed_kph numeric(8,2), odometer_km numeric(12,2), payload_hash text NOT NULL,
  freshness_state text NOT NULL CHECK(freshness_state IN ('CURRENT','STALE','FUTURE')), UNIQUE(tenant_id,id), UNIQUE(tenant_id,device_id,event_key),
  FOREIGN KEY(tenant_id,trip_id) REFERENCES app.trips(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX gps_observations_device_time ON app.gps_device_observations(tenant_id,device_id,observed_at DESC);

-- One same-assignment capability/scope evaluator for every canonical resource.
CREATE FUNCTION app.domain_resource_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text,
  p_action text, p_resource text, p_resource_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
DECLARE
  resource_nodes uuid[] := '{}';
  assigned_membership uuid;
  audience text;
BEGIN
  SELECT portal_audience INTO audience FROM app.tenant_memberships
   WHERE tenant_id=p_tenant AND id=p_membership AND user_id=p_user AND status='ACTIVE';
  IF audience IS NULL THEN RETURN false; END IF;

  CASE p_resource
    WHEN 'organization-nodes' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.organization_nodes WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'employees' THEN SELECT ARRAY[n.authorization_scope_node_id],e.linked_membership_id INTO resource_nodes,assigned_membership FROM app.employees e JOIN app.organization_nodes n ON n.tenant_id=e.tenant_id AND n.id=e.home_node_id WHERE e.tenant_id=p_tenant AND e.id=p_resource_id;
    WHEN 'clients' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.clients WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'client-locations' THEN SELECT ARRAY_REMOVE(ARRAY[l.authorization_scope_node_id,c.authorization_scope_node_id],null) INTO resource_nodes FROM app.client_locations l JOIN app.clients c ON c.tenant_id=l.tenant_id AND c.id=l.client_id WHERE l.tenant_id=p_tenant AND l.id=p_resource_id;
    WHEN 'contracts' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.contracts t JOIN app.clients c ON c.tenant_id=t.tenant_id AND c.id=t.client_id WHERE t.tenant_id=p_tenant AND t.id=p_resource_id;
    WHEN 'lanes' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.contract_lanes l JOIN app.contract_versions v ON v.tenant_id=l.tenant_id AND v.id=l.contract_version_id JOIN app.contracts t ON t.tenant_id=v.tenant_id AND t.id=v.contract_id JOIN app.clients c ON c.tenant_id=t.tenant_id AND c.id=t.client_id WHERE l.tenant_id=p_tenant AND l.id=p_resource_id;
    WHEN 'vendors' THEN SELECT ARRAY[authorization_scope_node_id] INTO resource_nodes FROM app.vendors WHERE tenant_id=p_tenant AND id=p_resource_id;
    WHEN 'vehicles' THEN SELECT ARRAY[v.authorization_scope_node_id] INTO resource_nodes FROM app.vehicles a JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=p_tenant AND a.id=p_resource_id;
    WHEN 'drivers' THEN SELECT ARRAY[v.authorization_scope_node_id],d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.drivers d JOIN app.vendors v ON v.tenant_id=d.tenant_id AND v.id=d.vendor_id WHERE d.tenant_id=p_tenant AND d.id=p_resource_id;
    WHEN 'indents' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,l.authorization_scope_node_id],null),i.owner_membership_id INTO resource_nodes,assigned_membership FROM app.indents i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.client_locations l ON l.tenant_id=i.tenant_id AND l.id=i.client_location_id WHERE i.tenant_id=p_tenant AND i.id=p_resource_id;
    WHEN 'allocations' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),a.owner_membership_id INTO resource_nodes,assigned_membership FROM app.allocations a JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id WHERE a.tenant_id=p_tenant AND a.id=p_resource_id;
    WHEN 'trips' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id WHERE t.tenant_id=p_tenant AND t.id=p_resource_id;
    WHEN 'pod-tasks' THEN SELECT ARRAY_REMOVE(ARRAY[c.authorization_scope_node_id,v.authorization_scope_node_id],null),d.portal_membership_id INTO resource_nodes,assigned_membership FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id JOIN app.vendors v ON v.tenant_id=a.tenant_id AND v.id=a.vendor_id JOIN app.drivers d ON d.tenant_id=t.tenant_id AND d.id=t.assigned_driver_id WHERE p.tenant_id=p_tenant AND p.id=p_resource_id;
    WHEN 'invoices' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.client_invoices i JOIN app.clients c ON c.tenant_id=i.tenant_id AND c.id=i.client_id WHERE i.tenant_id=p_tenant AND i.id=p_resource_id;
    WHEN 'receipts' THEN SELECT ARRAY[c.authorization_scope_node_id] INTO resource_nodes FROM app.receipts r JOIN app.clients c ON c.tenant_id=r.tenant_id AND c.id=r.client_id WHERE r.tenant_id=p_tenant AND r.id=p_resource_id;
    WHEN 'vendor-bills' THEN SELECT ARRAY[v.authorization_scope_node_id] INTO resource_nodes FROM app.vendor_bills b JOIN app.vendors v ON v.tenant_id=b.tenant_id AND v.id=b.vendor_id WHERE b.tenant_id=p_tenant AND b.id=p_resource_id;
    WHEN 'configurations' THEN resource_nodes := '{}';
    ELSE RETURN false;
  END CASE;

  IF audience='DRIVER' AND p_resource IN ('trips','pod-tasks') AND assigned_membership IS DISTINCT FROM p_membership THEN RETURN false; END IF;
  IF audience='DRIVER' AND p_resource NOT IN ('trips','pod-tasks','drivers') THEN RETURN false; END IF;
  IF audience='CLIENT' AND p_resource NOT IN ('clients','client-locations','indents','trips','pod-tasks','invoices') THEN RETURN false; END IF;
  IF audience='VENDOR' AND p_resource NOT IN ('vendors','vehicles','drivers','allocations','trips','pod-tasks','vendor-bills') THEN RETURN false; END IF;

  RETURN EXISTS(
    SELECT 1 FROM app.membership_role_assignments a
    JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=p_capability
    JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE'
      AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN (p_action,'ADMIN')
    JOIN app.authorization_scope_nodes gn ON gn.tenant_id=g.tenant_id AND gn.id=g.scope_node_id AND gn.status='ACTIVE'
    WHERE a.tenant_id=p_tenant AND a.membership_id=p_membership AND a.status='ACTIVE'
      AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
      AND (
        (gn.scope_type='TENANT' AND audience='INTERNAL')
        OR EXISTS(
          WITH RECURSIVE ancestors AS (
            SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n WHERE n.tenant_id=p_tenant AND n.id=ANY(resource_nodes)
            UNION ALL SELECT n.id,n.parent_id FROM app.authorization_scope_nodes n JOIN ancestors x ON x.parent_id=n.id WHERE n.tenant_id=p_tenant
          ) SELECT 1 FROM ancestors WHERE id=g.scope_node_id
        )
      )
  );
END $$;

CREATE FUNCTION app.operational_alert_authorized(
  p_tenant uuid, p_membership uuid, p_user uuid, p_capability text, p_alert uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=app,pg_temp AS $$
DECLARE
  alert_row app.operational_alerts%ROWTYPE;
  audience text;
  domain_capability text;
BEGIN
  SELECT * INTO alert_row FROM app.operational_alerts WHERE tenant_id=p_tenant AND id=p_alert;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT portal_audience INTO audience FROM app.tenant_memberships WHERE tenant_id=p_tenant AND id=p_membership AND user_id=p_user AND status='ACTIVE';
  IF audience IS DISTINCT FROM 'INTERNAL' THEN RETURN false; END IF;

  IF alert_row.rule_id IS NOT NULL THEN
    RETURN EXISTS(
      SELECT 1 FROM app.alert_rules r
      JOIN app.membership_role_assignments a ON a.tenant_id=r.tenant_id AND a.membership_id=p_membership AND a.status='ACTIVE'
        AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
      JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=p_capability
      JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE'
        AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()) AND g.action IN ('READ','UPDATE','ADMIN')
      JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.status='ACTIVE'
      WHERE r.tenant_id=p_tenant AND r.id=alert_row.rule_id AND (
        (cardinality(r.scope_node_ids)=0 AND n.scope_type='TENANT')
        OR EXISTS(
          WITH RECURSIVE ancestors AS (
            SELECT s.id,s.parent_id FROM app.authorization_scope_nodes s WHERE s.tenant_id=p_tenant AND s.id=ANY(r.scope_node_ids)
            UNION ALL SELECT s.id,s.parent_id FROM app.authorization_scope_nodes s JOIN ancestors x ON x.parent_id=s.id WHERE s.tenant_id=p_tenant
          ) SELECT 1 FROM ancestors WHERE id=g.scope_node_id
        )
      )
    );
  END IF;

  domain_capability := CASE alert_row.source_module
    WHEN 'organization-nodes' THEN 'masters.read' WHEN 'employees' THEN 'masters.read' WHEN 'clients' THEN 'masters.read'
    WHEN 'client-locations' THEN 'masters.read' WHEN 'contracts' THEN 'masters.read' WHEN 'lanes' THEN 'masters.read'
    WHEN 'vendors' THEN 'masters.read' WHEN 'vehicles' THEN 'masters.read' WHEN 'drivers' THEN 'masters.read'
    WHEN 'indents' THEN 'operations.read' WHEN 'allocations' THEN 'operations.read' WHEN 'trips' THEN 'operations.read'
    WHEN 'pod-tasks' THEN 'pod.read' WHEN 'invoices' THEN 'finance.read' WHEN 'receipts' THEN 'finance.read'
    WHEN 'vendor-bills' THEN 'finance.read' WHEN 'configurations' THEN 'configuration.read' ELSE NULL END;

  IF domain_capability IS NOT NULL AND alert_row.source_record_id IS NOT NULL THEN
    -- The alert capability and the source-resource scope must be supplied by
    -- the same assignment.  Passing the alert capability into the canonical
    -- evaluator prevents a tenant-wide alert capability on one role from
    -- being combined with a narrow resource grant on another role.
    RETURN app.domain_resource_authorized(
      p_tenant,p_membership,p_user,p_capability,'READ',
      alert_row.source_module,alert_row.source_record_id
    );
  END IF;

  RETURN EXISTS(
    SELECT 1 FROM app.membership_role_assignments a
    JOIN app.role_capabilities c ON c.tenant_id=a.tenant_id AND c.role_id=a.role_id AND c.capability_code=p_capability
    JOIN app.scope_grants g ON g.tenant_id=a.tenant_id AND g.assignment_id=a.id AND g.status='ACTIVE' AND g.action IN ('READ','UPDATE','ADMIN')
    JOIN app.authorization_scope_nodes n ON n.tenant_id=g.tenant_id AND n.id=g.scope_node_id AND n.scope_type='TENANT' AND n.status='ACTIVE'
    WHERE a.tenant_id=p_tenant AND a.membership_id=p_membership AND a.status='ACTIVE'
      AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now())
      AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now())
  );
END $$;

-- Append-only evidence and ledgers.
CREATE TRIGGER governed_document_versions_immutable BEFORE UPDATE OR DELETE ON app.governed_document_versions FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER governed_comment_history_immutable BEFORE UPDATE OR DELETE ON app.governed_comment_history FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON app.approval_decisions FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER trip_events_immutable BEFORE UPDATE OR DELETE ON app.trip_events FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER receipt_ledger_immutable BEFORE UPDATE OR DELETE ON app.receipt_ledger_entries FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER payment_allocations_immutable BEFORE UPDATE OR DELETE ON app.payment_allocations FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER integration_attempts_immutable BEFORE UPDATE OR DELETE ON app.integration_delivery_attempts FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER document_scan_results_immutable BEFORE UPDATE OR DELETE ON app.document_scan_results FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER notification_attempts_immutable BEFORE UPDATE OR DELETE ON app.notification_delivery_attempts FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER alert_evaluations_immutable BEFORE UPDATE OR DELETE ON app.alert_rule_evaluations FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER contract_change_notes_immutable BEFORE UPDATE OR DELETE ON app.contract_change_notes FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER invoice_notes_immutable BEFORE UPDATE OR DELETE ON app.invoice_notes FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER gps_observations_immutable BEFORE UPDATE OR DELETE ON app.gps_device_observations FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DO $$ DECLARE q text; s text; n text; p text; BEGIN
  FOREACH q IN ARRAY ARRAY[
    'app.invitation_delivery_attempts','app.governed_documents','app.governed_document_versions','app.document_scan_results','app.document_access_tokens','app.governed_comments','app.governed_comment_history',
    'app.approval_definitions','app.approval_instances','app.approval_decisions','app.configuration_versions','app.configuration_projection_versions',
    'app.organization_nodes','app.organization_closure','app.employees','app.operational_assignments','app.clients','app.client_locations','app.contracts','app.contract_versions',
    'app.contract_lanes','app.sla_rules','app.client_rate_lines','app.vendors','app.vendor_service_scopes','app.vendor_bank_versions','app.vehicles','app.drivers','app.compliance_records','app.eligibility_overrides',
    'app.indents','app.indent_cancellations','app.allocations','app.allocation_assignments','app.trips','app.trip_events','app.pod_tasks','app.pod_invoice_links',
    'app.client_invoices','app.client_invoice_lines','app.invoice_service_links','app.receipts','app.receipt_ledger_entries','app.collection_followups','app.vendor_bills','app.vendor_bill_lines','app.payment_batches','app.payment_allocations',
    'app.api_clients','app.webhook_events','app.integration_mapping_versions','app.integration_delivery_attempts','app.notification_deliveries','app.notification_delivery_attempts','app.alert_rule_evaluations','app.accounting_reconciliation_entries',
    'app.contract_change_notes','app.invoice_notes','app.gps_device_observations'
  ] LOOP
    s:=split_part(q,'.',1); n:=split_part(q,'.',2); p:=n||'_tenant_isolation';
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,n);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,n);
    EXECUTE format('CREATE POLICY %I ON %I.%I USING (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'') WITH CHECK (tenant_id=nullif(current_setting(''app.current_tenant_id'',true),'''')::uuid OR current_setting(''app.platform_context'',true)=''on'')',p,s,n);
  END LOOP;
END $$;

-- Domain capabilities are immutable catalog entries and owners receive them by default.
DROP TRIGGER IF EXISTS capability_catalog_read_only ON app.capability_catalog;
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,delegable) VALUES
 ('masters.read','Business','View scoped master data',false,true),('masters.admin','Business','Manage scoped master data',true,true),
 ('operations.read','Business','View scoped operational records',false,true),('operations.admin','Business','Manage scoped operational records',true,true),
 ('pod.read','Business','View scoped POD records',false,true),('pod.admin','Business','Manage scoped POD records',true,true),
 ('finance.read','Finance','View scoped financial records',true,true),('finance.admin','Finance','Post and settle financial records',true,true),
 ('governance.read','Governance','View governed evidence',true,true),('governance.admin','Governance','Manage evidence and approvals',true,true),
 ('configuration.read','Configuration','View tenant configuration',false,true),('configuration.admin','Configuration','Publish tenant configuration',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE r.code='TENANT_OWNER' AND c.active
ON CONFLICT DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
WHERE c.active AND (
  (r.code IN ('REGIONAL_MANAGER','KEY_ACCOUNT_MANAGER','TRAFFIC_PLACEMENT_EXECUTIVE') AND c.code IN ('masters.read','operations.read','operations.admin','pod.read'))
  OR (r.code IN ('FINANCE_EXECUTIVE','COLLECTION_EXECUTIVE') AND c.code IN ('finance.read','finance.admin','pod.read','governance.read'))
  OR (r.code IN ('LOADING_EXECUTIVE','UNLOADING_EXECUTIVE') AND c.code IN ('operations.read','operations.admin','pod.read','pod.admin'))
  OR (r.code='VENDOR_OWNER' AND c.code IN ('masters.read','operations.read','finance.read','governance.read'))
  OR (r.code='DRIVER' AND c.code IN ('operations.read','operations.admin','governance.read'))
  OR (r.code='CLIENT_VIEWER' AND c.code IN ('operations.read','pod.read','finance.read','governance.read'))
  OR (r.code IN ('MIS_EXECUTIVE','AUDITOR') AND c.code IN ('masters.read','operations.read','pod.read','finance.read','governance.read','configuration.read'))
)
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_read_only BEFORE INSERT OR UPDATE OR DELETE ON app.capability_catalog FOR EACH ROW EXECUTE FUNCTION app.reject_catalog_mutation();

COMMIT;
