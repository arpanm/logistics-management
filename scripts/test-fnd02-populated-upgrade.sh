#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/prepare-clean-test-database.sh
container_name="${CENTRAL_POSTGRES_CONTAINER:-shared-postgres}"
app_user="${POSTGRES_APP_USER:-logistics_app}"
test_database="${POSTGRES_TEST_DB:-logistics_test}"
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < packages/db/prisma/migrations/202608240001_fnd01_foundation/migration.sql
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < packages/db/prisma/migrations/202608240002_fnd01_security_hardening/migration.sql
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.platform_context','on',true);
INSERT INTO app.users(id,email,display_name,password_hash)
VALUES('10000000-0000-0000-0000-000000000001','frozen-owner@test.local','Frozen Owner','frozen-hash');
INSERT INTO app.tenants(id,code,name,legal_name,tax_identifier,address,timezone,locale,currency,fiscal_month,fiscal_day,support_name,support_email,short_name,primary_color,accent_color)
VALUES('20000000-0000-0000-0000-000000000001','FROZEN','Frozen Logistics','Frozen Logistics Ltd','FROZEN-TAX','{}','Asia/Kolkata','en-IN','INR',4,1,'Support','support@frozen.test','Frozen','#16324F','#D97706');
INSERT INTO app.tenant_memberships(id,tenant_id,user_id,invited_email,invited_name,role,status)
VALUES('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','frozen-owner@test.local','Frozen Owner','TENANT_OWNER','ACTIVE');
INSERT INTO app.sessions(id,token_hash,csrf_hash,user_id,active_tenant_id,expires_at)
VALUES('40000000-0000-0000-0000-000000000001','frozen-token','frozen-csrf','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',now()+interval '1 day');
INSERT INTO app.tenant_probe_records(id,tenant_id,label,note)
VALUES('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Frozen Probe','survive-upgrade');
INSERT INTO app.outbox_events(id,tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key)
VALUES('60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','TENANT','probe','50000000-0000-0000-0000-000000000001','frozen.event.v1','{}','frozen-event');
INSERT INTO audit.audit_events(id,tenant_id,actor_id,action,target_type,target_id,correlation_id)
VALUES('70000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','frozen.audit','probe','50000000-0000-0000-0000-000000000001','frozen-correlation');
COMMIT;
SQL
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < packages/db/prisma/migrations/202608240003_fnd02_identity_access/migration.sql
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT set_config('app.platform_context','on',true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.users WHERE id='10000000-0000-0000-0000-000000000001' AND auth_version=1) THEN RAISE EXCEPTION 'frozen user not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tenant_memberships WHERE id='30000000-0000-0000-0000-000000000001' AND employee_code IS NOT NULL AND portal_audience='INTERNAL') THEN RAISE EXCEPTION 'owner membership not backfilled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.sessions WHERE id='40000000-0000-0000-0000-000000000001' AND membership_id='30000000-0000-0000-0000-000000000001' AND user_auth_version=1 AND membership_auth_version=1) THEN RAISE EXCEPTION 'session not backfilled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.membership_role_assignments a JOIN app.roles r ON r.id=a.role_id JOIN app.scope_grants g ON g.assignment_id=a.id JOIN app.authorization_scope_nodes n ON n.id=g.scope_node_id WHERE a.membership_id='30000000-0000-0000-0000-000000000001' AND r.code='TENANT_OWNER' AND n.scope_type='TENANT' AND g.action='ADMIN') THEN RAISE EXCEPTION 'owner authorization not seeded'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tenant_probe_records WHERE id='50000000-0000-0000-0000-000000000001' AND note='survive-upgrade') THEN RAISE EXCEPTION 'probe not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.outbox_events WHERE id='60000000-0000-0000-0000-000000000001' AND event_type='frozen.event.v1') THEN RAISE EXCEPTION 'event not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.audit_events WHERE id='70000000-0000-0000-0000-000000000001' AND correlation_id='frozen-correlation') THEN RAISE EXCEPTION 'audit not preserved'; END IF;
END $$;
COMMIT;
SQL
echo "FND02-M-001 populated frozen FND-01 upgrade passed"
