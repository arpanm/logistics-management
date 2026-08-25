BEGIN;
SELECT set_config('app.platform_context','on',true);

-- MST-01 exports are independently grantable from ordinary master reads.
DROP TRIGGER IF EXISTS capability_catalog_read_only ON app.capability_catalog;
INSERT INTO app.capability_catalog(code,capability_group,description,privileged,delegable)
VALUES ('masters.export','Business','Export scoped master reports',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
SELECT r.tenant_id,r.id,'masters.export'
FROM app.roles r
WHERE r.code='TENANT_OWNER'
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_read_only
BEFORE INSERT OR UPDATE OR DELETE ON app.capability_catalog
FOR EACH ROW EXECUTE FUNCTION app.reject_catalog_mutation();

COMMIT;
