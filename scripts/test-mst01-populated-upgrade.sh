#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
bash scripts/prepare-clean-test-database.sh
container_name="${CENTRAL_POSTGRES_CONTAINER:-shared-postgres}"
app_user="${POSTGRES_APP_USER:-logistics_app}"
test_database="${POSTGRES_TEST_DB:-logistics_test}"
for migration in packages/db/prisma/migrations/*/migration.sql; do
  [[ "$migration" == *202608250019_mst01_scope_provenance* || "$migration" == *202608250020_mst01_scope_backfill_correction* ]] && continue
  docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
SELECT set_config('app.platform_context','on',true);
INSERT INTO app.users(id,email,display_name,password_hash) VALUES('91000000-0000-4000-8000-000000000001','mst-upgrade@test.local','MST Upgrade','unused');
INSERT INTO app.tenants(id,code,name,legal_name,tax_identifier,address,timezone,locale,currency,fiscal_month,fiscal_day,support_name,support_email,short_name,primary_color,accent_color)
VALUES('92000000-0000-4000-8000-000000000001','MST-UPGRADE','MST Upgrade','MST Upgrade Ltd','MST-UPGRADE','{}','Asia/Kolkata','en-IN','INR',4,1,'Support','support@mst-upgrade.test','MST','#16324F','#D97706');
INSERT INTO app.authorization_scope_nodes(id,tenant_id,scope_type,code,name,status)
VALUES('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','TENANT','MST-UPGRADE','MST Upgrade','ACTIVE');
INSERT INTO app.organization_nodes(id,tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,active_from,created_by) VALUES
('94000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','LE','Legacy Entity','LEGAL_ENTITY',null,'93000000-0000-4000-8000-000000000001','Asia/Kolkata',current_date,'91000000-0000-4000-8000-000000000001'),
('94000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001','NORTH','Legacy North','REGION','94000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','Asia/Kolkata',current_date,'91000000-0000-4000-8000-000000000001'),
('94000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000001','BLR','Legacy Branch','BRANCH','94000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001','Asia/Kolkata',current_date,'91000000-0000-4000-8000-000000000001');
INSERT INTO app.organization_nodes(id,tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,active_from,created_by) VALUES
('94000000-0000-4000-8000-000000000004','92000000-0000-4000-8000-000000000001','HUB','Legacy Hub','HUB','94000000-0000-4000-8000-000000000003','93000000-0000-4000-8000-000000000001','Asia/Kolkata',current_date,'91000000-0000-4000-8000-000000000001'),
('94000000-0000-4000-8000-000000000005','92000000-0000-4000-8000-000000000001','TEAM','Legacy Team','TEAM','94000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000001','Asia/Kolkata',current_date,'91000000-0000-4000-8000-000000000001');
INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) VALUES
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',0),
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000002','94000000-0000-4000-8000-000000000002',0),
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000003',0),
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000002',1),
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000002','94000000-0000-4000-8000-000000000003',1),
('92000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',2);
INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth)
SELECT '92000000-0000-4000-8000-000000000001',ancestor,descendant,depth FROM (VALUES
('94000000-0000-4000-8000-000000000004'::uuid,'94000000-0000-4000-8000-000000000004'::uuid,0),
('94000000-0000-4000-8000-000000000005'::uuid,'94000000-0000-4000-8000-000000000005'::uuid,0),
('94000000-0000-4000-8000-000000000003'::uuid,'94000000-0000-4000-8000-000000000004'::uuid,1),
('94000000-0000-4000-8000-000000000002'::uuid,'94000000-0000-4000-8000-000000000004'::uuid,2),
('94000000-0000-4000-8000-000000000001'::uuid,'94000000-0000-4000-8000-000000000004'::uuid,3),
('94000000-0000-4000-8000-000000000004'::uuid,'94000000-0000-4000-8000-000000000005'::uuid,1),
('94000000-0000-4000-8000-000000000003'::uuid,'94000000-0000-4000-8000-000000000005'::uuid,2),
('94000000-0000-4000-8000-000000000002'::uuid,'94000000-0000-4000-8000-000000000005'::uuid,3),
('94000000-0000-4000-8000-000000000001'::uuid,'94000000-0000-4000-8000-000000000005'::uuid,4)
) x(ancestor,descendant,depth);
COMMIT;
SQL
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < packages/db/prisma/migrations/202608250019_mst01_scope_provenance/migration.sql >/dev/null
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 < packages/db/prisma/migrations/202608250020_mst01_scope_backfill_correction/migration.sql >/dev/null
docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
SELECT set_config('app.platform_context','on',true);
DO $$
BEGIN
  IF (SELECT count(DISTINCT authorization_scope_node_id) FROM app.organization_nodes WHERE tenant_id='92000000-0000-4000-8000-000000000001') <> 3 THEN RAISE EXCEPTION 'legacy nodes did not receive distinct scopes'; END IF;
  IF EXISTS(SELECT 1 FROM app.organization_nodes n JOIN app.authorization_scope_nodes s ON s.tenant_id=n.tenant_id AND s.id=n.authorization_scope_node_id WHERE n.tenant_id='92000000-0000-4000-8000-000000000001' AND n.node_type IN ('LEGAL_ENTITY','REGION','BRANCH') AND s.canonical_resource_id IS DISTINCT FROM n.id) THEN RAISE EXCEPTION 'canonical resource mapping missing'; END IF;
  IF EXISTS(SELECT 1 FROM app.organization_nodes n JOIN app.organization_nodes branch ON branch.tenant_id=n.tenant_id AND branch.id='94000000-0000-4000-8000-000000000003' WHERE n.id IN ('94000000-0000-4000-8000-000000000004','94000000-0000-4000-8000-000000000005') AND n.authorization_scope_node_id IS DISTINCT FROM branch.authorization_scope_node_id) THEN RAISE EXCEPTION 'recursive HUB/TEAM inheritance invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.authorization_scope_nodes branch JOIN app.authorization_scope_nodes region ON region.id=branch.parent_id JOIN app.authorization_scope_nodes entity ON entity.id=region.parent_id WHERE branch.canonical_resource_id='94000000-0000-4000-8000-000000000003' AND region.canonical_resource_id='94000000-0000-4000-8000-000000000002' AND entity.canonical_resource_id='94000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'scope ancestry backfill invalid'; END IF;
END $$;
COMMIT;
SQL
echo "MST01-M-002 populated organization scope upgrade passed"
