import argon2 from "argon2";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./index.js";
import { demoSeedConfig } from "./demo-seed-config.js";

const ids = {
  platform: "10000000-0000-4000-8000-000000000001",
  owner: "10000000-0000-4000-8000-000000000002",
  operations: "10000000-0000-4000-8000-000000000003",
  finance: "10000000-0000-4000-8000-000000000004",
  vendor: "10000000-0000-4000-8000-000000000005",
  driver: "10000000-0000-4000-8000-000000000006",
  client: "10000000-0000-4000-8000-000000000007",
} as const;

const tenantId = "10000000-0000-4000-8000-000000000100";
export const DEMO_DATASET = "logistics-end-to-end-demo";
export const DEMO_DATASET_VERSION = "2026.08.1";
export const DEMO_ANCHOR_DATE = "2026-08-31";
const anchorDateSql = `'${DEMO_ANCHOR_DATE}'::date`;
const anchorTimeSql = `'2026-08-31T12:00:00+05:30'::timestamptz`;
const anchorTime = new Date("2026-08-31T12:00:00+05:30");

const statements = [
  `INSERT INTO app.tenants(id,code,name,legal_name,tax_identifier,address,timezone,locale,currency,fiscal_month,fiscal_day,support_name,support_email,support_mobile,short_name,primary_color,accent_color,status,lifecycle_actor_id)
   VALUES('${tenantId}','DEMO','Demo Logistics India','Demo Logistics India Private Limited','29AABCD1234E1Z5',
     '{"line1":"42 Demo Logistics Park","city":"Bengaluru","region":"Karnataka","postalCode":"560001","country":"IN"}'::jsonb,
     'Asia/Kolkata','en-IN','INR',4,1,'Demo Support','demo.owner@logistics.test','+919900000001','Demo Logistics','#16324f','#d97706','ACTIVE','${ids.platform}')
   ON CONFLICT(code) DO UPDATE SET name=excluded.name,legal_name=excluded.legal_name,address=excluded.address,timezone=excluded.timezone,locale=excluded.locale,currency=excluded.currency,status='ACTIVE',lifecycle_actor_id=excluded.lifecycle_actor_id,updated_at=now()`,
  `INSERT INTO app.legal_entities(id,tenant_id,code,name,tax_identifier,is_default,status)
   VALUES('10000000-0000-4000-8000-000000000300','${tenantId}','DEMO','Demo Logistics India Private Limited','29AABCD1234E1Z5',true,'ACTIVE')
   ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name,tax_identifier=excluded.tax_identifier,is_default=true,status='ACTIVE',updated_at=now()`,
  `INSERT INTO app.authorization_scope_nodes(id,tenant_id,scope_type,code,name,parent_id,canonical_resource_id,status) VALUES
   ('10000000-0000-4000-8000-000000000200','${tenantId}','TENANT','TENANT','Entire demo tenant',null,null,'ACTIVE'),
   ('10000000-0000-4000-8000-000000000201','${tenantId}','LEGAL_ENTITY','ORG-DEMO','Demo Logistics India','10000000-0000-4000-8000-000000000200','10000000-0000-4000-8000-000000000301','ACTIVE'),
   ('10000000-0000-4000-8000-000000000204','${tenantId}','BRANCH','ORG-BLR-HUB','Bengaluru Operations Hub','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000302','ACTIVE'),
   ('10000000-0000-4000-8000-000000000202','${tenantId}','CLIENT','CLIENT-DEMO','Demo Retail Client','10000000-0000-4000-8000-000000000204','10000000-0000-4000-8000-000000000600','ACTIVE'),
   ('10000000-0000-4000-8000-000000000203','${tenantId}','VENDOR','VENDOR-DEMO','Demo Fleet Vendor','10000000-0000-4000-8000-000000000204','10000000-0000-4000-8000-000000000700','ACTIVE')
   ON CONFLICT(tenant_id,scope_type,code) DO UPDATE SET name=excluded.name,status='ACTIVE',updated_at=now()`,
  `INSERT INTO app.organization_nodes(id,tenant_id,code,name,node_type,parent_id,authorization_scope_node_id,timezone,address,latitude,longitude,postal_codes,geofence,active_from,state,created_by) VALUES
   ('10000000-0000-4000-8000-000000000301','${tenantId}','DEMO','Demo Logistics India Private Limited','LEGAL_ENTITY',null,'10000000-0000-4000-8000-000000000201','Asia/Kolkata','42 Demo Logistics Park, Bengaluru',12.971599,77.594566,ARRAY['560001'],'{"type":"RADIUS","radiusKm":25}'::jsonb,current_date,'ACTIVE','${ids.platform}'),
   ('10000000-0000-4000-8000-000000000302','${tenantId}','BLR-HUB','Bengaluru Operations Hub','BRANCH','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000204','Asia/Kolkata','Peenya Industrial Area, Bengaluru',13.028500,77.519700,ARRAY['560058'],'{"type":"RADIUS","radiusKm":15}'::jsonb,current_date,'ACTIVE','${ids.platform}')
   ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) VALUES
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000301',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000302',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000302',0)
   ON CONFLICT DO NOTHING`,
  `INSERT INTO app.roles(tenant_id,code,name,description,protected,privilege_level,portal_audiences,status) VALUES
   ('${tenantId}','TENANT_OWNER','Tenant Owner','Complete demo tenant administration',true,'PROTECTED',ARRAY['INTERNAL'],'ACTIVE'),
   ('${tenantId}','TRAFFIC_PLACEMENT_EXECUTIVE','Traffic / Placement Executive','Demo operations workbench user',false,'STANDARD',ARRAY['INTERNAL'],'ACTIVE'),
   ('${tenantId}','FINANCE_EXECUTIVE','Finance Executive','Demo finance workbench user',false,'PRIVILEGED',ARRAY['INTERNAL'],'ACTIVE'),
   ('${tenantId}','VENDOR_OWNER','Vendor Owner','Demo vendor portal user',false,'STANDARD',ARRAY['VENDOR'],'ACTIVE'),
   ('${tenantId}','DRIVER','Driver','Demo driver portal user',false,'STANDARD',ARRAY['DRIVER'],'ACTIVE'),
   ('${tenantId}','CLIENT_VIEWER','Client Viewer','Demo client portal user',false,'STANDARD',ARRAY['CLIENT'],'ACTIVE')
   ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name,description=excluded.description,portal_audiences=excluded.portal_audiences,status='ACTIVE',updated_at=now()`,
  `INSERT INTO app.role_capabilities(tenant_id,role_id,capability_code)
   SELECT r.tenant_id,r.id,c.code FROM app.roles r CROSS JOIN app.capability_catalog c
   WHERE r.tenant_id='${tenantId}' AND c.active AND (
     r.code='TENANT_OWNER' OR
     (r.code='TRAFFIC_PLACEMENT_EXECUTIVE' AND c.code IN ('identity.user.read','masters.read','masters.admin','operations.read','operations.admin','pod.read','pod.admin','control.dashboard.read','alerts.read')) OR
     (r.code='FINANCE_EXECUTIVE' AND c.code IN ('identity.user.read','masters.read','operations.read','pod.read','finance.read','finance.admin','governance.read','sensitive.payment.read','sensitive.bank_detail.read','control.dashboard.read')) OR
     (r.code='VENDOR_OWNER' AND c.code IN ('masters.read','operations.read','finance.read','governance.read','sensitive.payment.read')) OR
     (r.code='DRIVER' AND c.code IN ('operations.read','operations.admin','governance.read')) OR
     (r.code='CLIENT_VIEWER' AND c.code IN ('operations.read','pod.read','finance.read','governance.read'))
   ) ON CONFLICT DO NOTHING`,
  `INSERT INTO app.tenant_memberships(id,tenant_id,user_id,invited_name,invited_email,employee_code,role,portal_audience,status) VALUES
   ('10000000-0000-4000-8000-000000000401','${tenantId}','${ids.owner}','Demo Tenant Owner','demo.owner@logistics.test','DEMO-OWNER','TENANT_OWNER','INTERNAL','ACTIVE'),
   ('10000000-0000-4000-8000-000000000402','${tenantId}','${ids.operations}','Demo Operations User','demo.operations@logistics.test','DEMO-OPS',null,'INTERNAL','ACTIVE'),
   ('10000000-0000-4000-8000-000000000403','${tenantId}','${ids.finance}','Demo Finance User','demo.finance@logistics.test','DEMO-FIN',null,'INTERNAL','ACTIVE'),
   ('10000000-0000-4000-8000-000000000404','${tenantId}','${ids.vendor}','Demo Vendor User','demo.vendor@logistics.test','DEMO-VENDOR',null,'VENDOR','ACTIVE'),
   ('10000000-0000-4000-8000-000000000405','${tenantId}','${ids.driver}','Demo Driver User','demo.driver@logistics.test','DEMO-DRIVER',null,'DRIVER','ACTIVE'),
   ('10000000-0000-4000-8000-000000000406','${tenantId}','${ids.client}','Demo Client User','demo.client@logistics.test','DEMO-CLIENT',null,'CLIENT','ACTIVE')
   ON CONFLICT(tenant_id,invited_email) DO UPDATE SET user_id=excluded.user_id,invited_name=excluded.invited_name,employee_code=excluded.employee_code,role=excluded.role,portal_audience=excluded.portal_audience,status='ACTIVE',updated_at=now()`,
  `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id,status)
   SELECT '${tenantId}',m.id,r.id,'ACTIVE' FROM app.tenant_memberships m JOIN app.roles r ON r.tenant_id=m.tenant_id AND r.code=CASE m.id
     WHEN '10000000-0000-4000-8000-000000000401' THEN 'TENANT_OWNER'
     WHEN '10000000-0000-4000-8000-000000000402' THEN 'TRAFFIC_PLACEMENT_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000403' THEN 'FINANCE_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000404' THEN 'VENDOR_OWNER'
     WHEN '10000000-0000-4000-8000-000000000405' THEN 'DRIVER'
     WHEN '10000000-0000-4000-8000-000000000406' THEN 'CLIENT_VIEWER' END
   WHERE m.tenant_id='${tenantId}' AND m.id IN ('10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000402','10000000-0000-4000-8000-000000000403','10000000-0000-4000-8000-000000000404','10000000-0000-4000-8000-000000000405','10000000-0000-4000-8000-000000000406')
   ON CONFLICT(tenant_id,membership_id,role_id) DO UPDATE SET status='ACTIVE',effective_to=null,updated_at=now()`,
  `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action,status)
   SELECT '${tenantId}',a.id,CASE m.portal_audience WHEN 'CLIENT' THEN '10000000-0000-4000-8000-000000000202'::uuid WHEN 'VENDOR' THEN '10000000-0000-4000-8000-000000000203'::uuid WHEN 'DRIVER' THEN '10000000-0000-4000-8000-000000000203'::uuid ELSE '10000000-0000-4000-8000-000000000200'::uuid END,'ADMIN','ACTIVE'
   FROM app.membership_role_assignments a JOIN app.tenant_memberships m ON m.tenant_id=a.tenant_id AND m.id=a.membership_id
   WHERE a.tenant_id='${tenantId}'
   ON CONFLICT(tenant_id,assignment_id,scope_node_id,action) DO UPDATE SET status='ACTIVE',effective_to=null,updated_at=now()`,
  `INSERT INTO app.transport_reference_masters(id,tenant_id,kind,code,name,description,capacity_milli,state,created_by) VALUES
   ('10000000-0000-4000-8000-000000000501','${tenantId}','TRUCK_TYPE','32FT_SXL','32 FT SXL','Single-axle closed truck',9000000,'ACTIVE','${ids.owner}'),
   ('10000000-0000-4000-8000-000000000502','${tenantId}','BODY_TYPE','CONTAINER','Container','Closed container body',null,'ACTIVE','${ids.owner}'),
   ('10000000-0000-4000-8000-000000000503','${tenantId}','CARGO_TYPE','FMCG','FMCG','Packaged consumer goods',null,'ACTIVE','${ids.owner}')
   ON CONFLICT(tenant_id,kind,code) DO UPDATE SET name=excluded.name,description=excluded.description,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.clients(id,tenant_id,code,legal_name,industry,billing_entity_id,authorization_scope_node_id,tax_identifier,escalation_email,escalation_mobile,credit_days,pod_mode,state) VALUES
   ('10000000-0000-4000-8000-000000000600','${tenantId}','DEMO-RETAIL','Demo Retail India Limited','Retail','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000202','29AACCD5678K1Z2','demo.client@logistics.test','+919900000006',30,'DIGITAL','ACTIVE')
   ON CONFLICT(tenant_id,code) DO UPDATE SET legal_name=excluded.legal_name,credit_days=30,pod_mode='DIGITAL',state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.client_locations(id,tenant_id,client_id,code,name,location_type,organization_node_id,authorization_scope_node_id,mobile,geofence,state) VALUES
   ('10000000-0000-4000-8000-000000000601','${tenantId}','10000000-0000-4000-8000-000000000600','BLR-DC','Bengaluru Distribution Centre','WAREHOUSE','10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000202','+919900000061','{"type":"RADIUS","latitude":13.0285,"longitude":77.5197,"radiusKm":3}'::jsonb,'ACTIVE'),
   ('10000000-0000-4000-8000-000000000602','${tenantId}','10000000-0000-4000-8000-000000000600','HYD-STORE','Hyderabad Regional Store','STORE','10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000202','+919900000062','{"type":"RADIUS","latitude":17.385,"longitude":78.4867,"radiusKm":3}'::jsonb,'ACTIVE')
   ON CONFLICT(tenant_id,client_id,code) DO UPDATE SET name=excluded.name,geofence=excluded.geofence,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.contracts(id,tenant_id,client_id,code,name,state,current_version,effective_from,created_by) VALUES
   ('10000000-0000-4000-8000-000000000610','${tenantId}','10000000-0000-4000-8000-000000000600','DEMO-CONTRACT','Demo Retail Primary Contract','PUBLISHED',1,current_date-30,'${ids.owner}')
   ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name,state='PUBLISHED',current_version=1,updated_at=now()`,
  `INSERT INTO app.contract_versions(id,tenant_id,contract_id,version,credit_days,pod_mode,document_requirements,terms,snapshot_hash,published_at,created_by) VALUES
   ('10000000-0000-4000-8000-000000000611','${tenantId}','10000000-0000-4000-8000-000000000610',1,30,'DIGITAL','["LR","POD"]'::jsonb,'{"currency":"INR","fuelSurchargeIncluded":true}'::jsonb,'demo-contract-v1',now()-interval '30 days','${ids.owner}')
   ON CONFLICT(tenant_id,contract_id,version) DO NOTHING`,
  `INSERT INTO app.contract_lanes(id,tenant_id,contract_version_id,code,origin_location_id,destination_location_id,truck_type,cargo_type,quantity_min_milli,quantity_max_milli,priority,service_window,truck_type_id,cargo_type_id) VALUES
   ('10000000-0000-4000-8000-000000000612','${tenantId}','10000000-0000-4000-8000-000000000611','BLR-HYD','10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000602','32 FT SXL','FMCG',1000000,9000000,100,'{"pickupHours":4,"transitHours":14}'::jsonb,'10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000503')
   ON CONFLICT(tenant_id,contract_version_id,code) DO NOTHING`,
  `INSERT INTO app.client_rate_lines(id,tenant_id,lane_id,charge_code,basis,amount_minor,tax_basis_points,effective_from,priority,state) VALUES
   ('10000000-0000-4000-8000-000000000613','${tenantId}','10000000-0000-4000-8000-000000000612','FREIGHT','PER_TRIP',1000000,1800,now()-interval '30 days',100,'PUBLISHED') ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.sla_rules(id,tenant_id,lane_id,placement_minutes,transit_minutes,pod_minutes,effective_from,priority) VALUES
   ('10000000-0000-4000-8000-000000000614','${tenantId}','10000000-0000-4000-8000-000000000612',240,840,1440,now()-interval '30 days',100) ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.vendors(id,tenant_id,code,legal_name,pan,gstin,tds_basis_points,msme_number,payment_terms_days,authorization_scope_node_id,state) VALUES
   ('10000000-0000-4000-8000-000000000700','${tenantId}','DEMO-FLEET','Demo Fleet Services Private Limited','AABCD4321F','29AABCD4321F1Z8',200,'UDYAM-KR-00-0000001',15,'10000000-0000-4000-8000-000000000203','ACTIVE')
   ON CONFLICT(tenant_id,code) DO UPDATE SET legal_name=excluded.legal_name,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.vendor_service_scopes(id,tenant_id,vendor_id,lane_id,effective_from) VALUES
   ('10000000-0000-4000-8000-000000000730','${tenantId}','10000000-0000-4000-8000-000000000700','10000000-0000-4000-8000-000000000612',now()-interval '30 days') ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.vehicles(id,tenant_id,vendor_id,registration_number,vehicle_type,make,model,model_year,capacity_milli,gps_device_id,state,truck_type_id,body_type_id) VALUES
   ('10000000-0000-4000-8000-000000000711','${tenantId}','10000000-0000-4000-8000-000000000700','KA01DEMO01','32 FT SXL','Tata','LPT',2025,9000000,'DEMO-GPS-01','ACTIVE','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000502'),
   ('10000000-0000-4000-8000-000000000712','${tenantId}','10000000-0000-4000-8000-000000000700','KA01DEMO02','32 FT SXL','Ashok Leyland','Ecomet',2024,9000000,'DEMO-GPS-02','ACTIVE','10000000-0000-4000-8000-000000000501','10000000-0000-4000-8000-000000000502')
   ON CONFLICT(tenant_id,registration_number) DO UPDATE SET state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.drivers(id,tenant_id,vendor_id,code,display_name,mobile,licence_number,licence_class,licence_valid_to,emergency_contact,portal_membership_id,state) VALUES
   ('10000000-0000-4000-8000-000000000721','${tenantId}','10000000-0000-4000-8000-000000000700','DRV-DEMO-01','Ravi Demo','+919900000071','KA-DEMO-0001','HMV',(current_date+interval '5 years')::date,'+919900000091',null,'ACTIVE'),
   ('10000000-0000-4000-8000-000000000722','${tenantId}','10000000-0000-4000-8000-000000000700','DRV-DEMO-02','Arun Demo','+919900000072','KA-DEMO-0002','HMV',(current_date+interval '5 years')::date,'+919900000092','10000000-0000-4000-8000-000000000405','ACTIVE')
   ON CONFLICT(tenant_id,code) DO UPDATE SET display_name=excluded.display_name,licence_valid_to=excluded.licence_valid_to,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.compliance_records(id,tenant_id,subject_type,subject_id,requirement_code,valid_from,valid_to,verification_state,verified_by,verified_at) VALUES
   ('10000000-0000-4000-8000-000000000741','${tenantId}','VENDOR','10000000-0000-4000-8000-000000000700','GST',current_date-30,current_date+365,'VERIFIED','${ids.owner}',now()),
   ('10000000-0000-4000-8000-000000000742','${tenantId}','VEHICLE','10000000-0000-4000-8000-000000000711','FITNESS',current_date-30,current_date+365,'VERIFIED','${ids.owner}',now()),
   ('10000000-0000-4000-8000-000000000743','${tenantId}','VEHICLE','10000000-0000-4000-8000-000000000712','FITNESS',current_date-30,current_date+365,'VERIFIED','${ids.owner}',now()),
   ('10000000-0000-4000-8000-000000000744','${tenantId}','DRIVER','10000000-0000-4000-8000-000000000721','LICENCE',current_date-30,current_date+365,'VERIFIED','${ids.owner}',now()),
   ('10000000-0000-4000-8000-000000000745','${tenantId}','DRIVER','10000000-0000-4000-8000-000000000722','LICENCE',current_date-30,current_date+365,'VERIFIED','${ids.owner}',now())
   ON CONFLICT(tenant_id,subject_type,subject_id,requirement_code) DO UPDATE SET valid_to=excluded.valid_to,verification_state='VERIFIED',verified_by=excluded.verified_by,verified_at=now()`,
  `INSERT INTO app.indents(id,tenant_id,indent_no,client_id,client_location_id,contract_version_id,lane_id,requested_vehicles,quantity_milli,pickup_window_start,pickup_window_end,committed_placement_at,owner_membership_id,source,source_reference,cargo_type,body_type,commercial_snapshot,state,created_by,body_type_id,cargo_type_id) VALUES
   ('10000000-0000-4000-8000-000000000801','${tenantId}','DEMO-IND-OPEN','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000611','10000000-0000-4000-8000-000000000612',2,18000000,now()+interval '1 day',now()+interval '1 day 4 hours',now()+interval '20 hours','10000000-0000-4000-8000-000000000402','MANUAL','DEMO-OPEN','FMCG','CONTAINER','{"clientRateMinor":"1000000","currency":"INR"}'::jsonb,'OPEN','${ids.operations}','10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000503'),
   ('10000000-0000-4000-8000-000000000802','${tenantId}','DEMO-IND-OFFERED','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000611','10000000-0000-4000-8000-000000000612',2,18000000,now()+interval '8 hours',now()+interval '12 hours',now()+interval '6 hours','10000000-0000-4000-8000-000000000402','MANUAL','DEMO-OFFERED','FMCG','CONTAINER','{"clientRateMinor":"1000000","currency":"INR"}'::jsonb,'PARTIALLY_ALLOCATED','${ids.operations}','10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000503'),
   ('10000000-0000-4000-8000-000000000803','${tenantId}','DEMO-IND-LIVE','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000611','10000000-0000-4000-8000-000000000612',1,9000000,now()-interval '4 hours',now()-interval '2 hours',now()-interval '5 hours','10000000-0000-4000-8000-000000000402','MANUAL','DEMO-LIVE','FMCG','CONTAINER','{"clientRateMinor":"1000000","currency":"INR"}'::jsonb,'FULFILLED','${ids.operations}','10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000503'),
   ('10000000-0000-4000-8000-000000000804','${tenantId}','DEMO-IND-DELIVERED','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000601','10000000-0000-4000-8000-000000000611','10000000-0000-4000-8000-000000000612',1,9000000,now()-interval '4 days',now()-interval '4 days'+interval '4 hours',now()-interval '5 days','10000000-0000-4000-8000-000000000402','MANUAL','DEMO-DELIVERED','FMCG','CONTAINER','{"clientRateMinor":"1000000","currency":"INR"}'::jsonb,'CLOSED','${ids.operations}','10000000-0000-4000-8000-000000000502','10000000-0000-4000-8000-000000000503')
   ON CONFLICT(tenant_id,indent_no) DO NOTHING`,
  `INSERT INTO app.allocations(id,tenant_id,indent_id,vendor_id,allotted_vehicles,offered_rate_minor,offer_channel,offered_at,expires_at,response_at,state,owner_membership_id,created_by) VALUES
   ('10000000-0000-4000-8000-000000000811','${tenantId}','10000000-0000-4000-8000-000000000802','10000000-0000-4000-8000-000000000700',1,750000,'PORTAL',now()-interval '30 minutes',now()+interval '2 hours',null,'OFFERED','10000000-0000-4000-8000-000000000402','${ids.operations}'),
   ('10000000-0000-4000-8000-000000000812','${tenantId}','10000000-0000-4000-8000-000000000803','10000000-0000-4000-8000-000000000700',1,750000,'PORTAL',now()-interval '1 day',now()+interval '1 day',now()-interval '23 hours','PLACED','10000000-0000-4000-8000-000000000402','${ids.operations}'),
   ('10000000-0000-4000-8000-000000000813','${tenantId}','10000000-0000-4000-8000-000000000804','10000000-0000-4000-8000-000000000700',1,750000,'PORTAL',now()-interval '6 days',now()-interval '5 days',now()-interval '6 days','PLACED','10000000-0000-4000-8000-000000000402','${ids.operations}')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.allocation_assignments(id,tenant_id,allocation_id,vehicle_id,driver_id,assigned_from,assigned_to,assigned_by) VALUES
   ('10000000-0000-4000-8000-000000000821','${tenantId}','10000000-0000-4000-8000-000000000812','10000000-0000-4000-8000-000000000712','10000000-0000-4000-8000-000000000722',now()-interval '1 day',null,'${ids.operations}'),
   ('10000000-0000-4000-8000-000000000822','${tenantId}','10000000-0000-4000-8000-000000000813','10000000-0000-4000-8000-000000000711','10000000-0000-4000-8000-000000000721',now()-interval '6 days',now()-interval '3 days','${ids.operations}')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.trips(id,tenant_id,allocation_id,trip_no,lr_no,assigned_driver_id,assigned_vehicle_id,planned_pickup_at,planned_delivery_at,tracking_consent_from,tracking_consent_to,state) VALUES
   ('10000000-0000-4000-8000-000000000831','${tenantId}','10000000-0000-4000-8000-000000000812','DEMO-TRIP-LIVE','DEMO-LR-LIVE','10000000-0000-4000-8000-000000000722','10000000-0000-4000-8000-000000000712',now()-interval '4 hours',now()+interval '10 hours',now()-interval '5 hours',now()+interval '1 day','IN_TRANSIT'),
   ('10000000-0000-4000-8000-000000000832','${tenantId}','10000000-0000-4000-8000-000000000813','DEMO-TRIP-DONE','DEMO-LR-DONE','10000000-0000-4000-8000-000000000721','10000000-0000-4000-8000-000000000711',now()-interval '5 days',now()-interval '4 days',now()-interval '6 days',now()-interval '3 days','DELIVERED')
   ON CONFLICT(tenant_id,trip_no) DO NOTHING`,
  `INSERT INTO app.trip_events(id,tenant_id,trip_id,event_key,event_type,source,device_at,actor_id,latitude,longitude,speed_kph,odometer_km,evidence) VALUES
   ('10000000-0000-4000-8000-000000000841','${tenantId}','10000000-0000-4000-8000-000000000831','DEMO-LIVE-START','TRIP_STARTED','MOBILE',now()-interval '4 hours','${ids.driver}',13.028500,77.519700,0,12500,'{"demo":true}'::jsonb),
   ('10000000-0000-4000-8000-000000000842','${tenantId}','10000000-0000-4000-8000-000000000831','DEMO-LIVE-GPS','GPS_POSITION','GPS',now()-interval '10 minutes',null,14.520000,77.900000,52,12610,'{"demo":true}'::jsonb),
   ('10000000-0000-4000-8000-000000000843','${tenantId}','10000000-0000-4000-8000-000000000832','DEMO-DONE-DELIVERED','DELIVERED','MOBILE',now()-interval '4 days','${ids.operations}',17.385000,78.486700,0,13420,'{"receiver":"Demo Store"}'::jsonb)
   ON CONFLICT(tenant_id,trip_id,event_key) DO NOTHING`,
  `INSERT INTO app.pod_tasks(id,tenant_id,trip_id,delivered_at,receiver_name,receiver_evidence,received_at,submitted_at,contract_snapshot,invoice_value_minor,prior_period,state) VALUES
   ('10000000-0000-4000-8000-000000000851','${tenantId}','10000000-0000-4000-8000-000000000832',now()-interval '4 days','Demo Store Receiver','{"signature":"demo-receiver","packages":120}'::jsonb,now()-interval '3 days 20 hours',now()-interval '3 days','{"contract":"DEMO-CONTRACT","version":1}'::jsonb,1180000,false,'CLOSED')
   ON CONFLICT(tenant_id,trip_id) DO NOTHING`,
  `INSERT INTO app.client_invoices(id,tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,acknowledged_at,due_date,state,created_by,posted_at) VALUES
   ('10000000-0000-4000-8000-000000000901','${tenantId}','DEMO-INV-POSTED','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000602',current_date-3,'INR',30,1000000,180000,1180000,now()-interval '2 days',current_date+28,'SUBMITTED','${ids.finance}',now()-interval '3 days'),
   ('10000000-0000-4000-8000-000000000902','${tenantId}','DEMO-INV-DRAFT','10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000601',current_date,'INR',30,500000,90000,590000,null,null,'DRAFT','${ids.finance}',null)
   ON CONFLICT(tenant_id,invoice_no) DO NOTHING`,
  `INSERT INTO app.client_invoice_lines(id,tenant_id,invoice_id,line_no,charge_code,quantity_milli,rate_minor,taxable_minor,tax_basis_points,tax_minor,total_minor,rate_snapshot) VALUES
   ('10000000-0000-4000-8000-000000000911','${tenantId}','10000000-0000-4000-8000-000000000901',1,'FREIGHT',1000,1000000,1000000,1800,180000,1180000,'{"basis":"PER_TRIP","lane":"BLR-HYD"}'::jsonb),
   ('10000000-0000-4000-8000-000000000912','${tenantId}','10000000-0000-4000-8000-000000000902',1,'FREIGHT',1000,500000,500000,1800,90000,590000,'{"basis":"PER_TRIP","demo":"pending"}'::jsonb)
   ON CONFLICT(tenant_id,invoice_id,line_no) DO NOTHING`,
  `INSERT INTO app.invoice_service_links(tenant_id,invoice_line_id,trip_id,pod_task_id) VALUES
   ('${tenantId}','10000000-0000-4000-8000-000000000911','10000000-0000-4000-8000-000000000832','10000000-0000-4000-8000-000000000851') ON CONFLICT DO NOTHING`,
  `INSERT INTO app.pod_invoice_links(tenant_id,pod_task_id,invoice_reference,invoice_date,value_minor) VALUES
   ('${tenantId}','10000000-0000-4000-8000-000000000851','DEMO-INV-POSTED',current_date-3,1180000) ON CONFLICT DO NOTHING`,
  `INSERT INTO app.receipts(id,tenant_id,receipt_ref,client_id,payment_date,amount_minor,mode,instrument_no,bank_reference,state,created_by) VALUES
   ('10000000-0000-4000-8000-000000000921','${tenantId}','DEMO-RCPT-001','10000000-0000-4000-8000-000000000600',current_date-1,600000,'NEFT','DEMO-NEFT-001','DEMO-BANK-REF-001','RECONCILED','${ids.finance}')
   ON CONFLICT(tenant_id,receipt_ref) DO NOTHING`,
  `INSERT INTO app.receipt_ledger_entries(id,tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reason,actor_id) VALUES
   ('10000000-0000-4000-8000-000000000922','${tenantId}','10000000-0000-4000-8000-000000000921','10000000-0000-4000-8000-000000000901','ALLOCATION',600000,'Demo partial client receipt','${ids.finance}')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.vendor_bills(id,tenant_id,vendor_id,vendor_invoice_no,invoice_date,taxable_minor,gst_minor,tds_minor,deduction_minor,advance_minor,payable_minor,state,verified_by,approved_by,created_by) VALUES
   ('10000000-0000-4000-8000-000000000931','${tenantId}','10000000-0000-4000-8000-000000000700','DEMO-VBILL-001',current_date-3,750000,135000,15000,0,0,870000,'PAID','${ids.operations}','${ids.finance}','${ids.owner}')
   ON CONFLICT(tenant_id,vendor_id,vendor_invoice_no) DO NOTHING`,
  `INSERT INTO app.vendor_bill_lines(id,tenant_id,vendor_bill_id,trip_id,rate_snapshot,expected_minor,claimed_minor,variance_minor,validation_state) VALUES
   ('10000000-0000-4000-8000-000000000932','${tenantId}','10000000-0000-4000-8000-000000000931','10000000-0000-4000-8000-000000000832','{"offeredRateMinor":"750000","currency":"INR"}'::jsonb,750000,750000,0,'MATCHED')
   ON CONFLICT(tenant_id,vendor_bill_id,trip_id) DO NOTHING`,
  `INSERT INTO app.payment_batches(id,tenant_id,batch_no,bank_version_id,total_minor,state,maker_id,checker_id,utr) VALUES
   ('10000000-0000-4000-8000-000000000941','${tenantId}','DEMO-PAYOUT-001','10000000-0000-4000-8000-000000000701',870000,'PAID','${ids.owner}','${ids.finance}','DEMO-UTR-000001')
   ON CONFLICT(tenant_id,batch_no) DO NOTHING`,
  `INSERT INTO app.payment_allocations(id,tenant_id,payment_batch_id,vendor_bill_id,amount_minor) VALUES
   ('10000000-0000-4000-8000-000000000942','${tenantId}','10000000-0000-4000-8000-000000000941','10000000-0000-4000-8000-000000000931',870000)
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.collection_followups(id,tenant_id,invoice_id,outcome,note,promised_at,promised_minor,next_followup_at,actor_id,created_at) VALUES
   ('10000000-0000-4000-8000-000000000943','${tenantId}','10000000-0000-4000-8000-000000000901','PART_PAYMENT_PROMISED','Demo client confirmed the remaining balance after the partial receipt.',current_date+7,580000,now()+interval '3 days','${ids.finance}',now()-interval '1 day')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.import_jobs(id,tenant_id,dataset,filename,media_type,byte_size,checksum,source_timezone,import_mode,state,uploader_id,idempotency_key_hash,header_map,summary,committed_at) VALUES
   ('10000000-0000-4000-8000-000000000951','${tenantId}','vendors','demo-vendors.csv','text/csv',512,'demo-vendors-checksum-v1','Asia/Kolkata','UPSERT','COMMITTED','${ids.operations}','demo-import-key-v1','{"vendor_code":"code","vendor_name":"legalName"}'::jsonb,'{"created":1,"updated":1,"rejected":1}'::jsonb,now()-interval '2 days')
   ON CONFLICT(tenant_id,dataset,checksum,import_mode) DO NOTHING`,
  `INSERT INTO app.import_rows(id,tenant_id,job_id,row_number,natural_key,normalized_data,disposition) VALUES
   ('10000000-0000-4000-8000-000000000952','${tenantId}','10000000-0000-4000-8000-000000000951',1,'DEMO-FLEET','{"code":"DEMO-FLEET","legalName":"Demo Fleet Services Private Limited"}'::jsonb,'CREATE'),
   ('10000000-0000-4000-8000-000000000953','${tenantId}','10000000-0000-4000-8000-000000000951',2,'DEMO-FLEET','{"code":"DEMO-FLEET","paymentTermsDays":15}'::jsonb,'UPDATE'),
   ('10000000-0000-4000-8000-000000000954','${tenantId}','10000000-0000-4000-8000-000000000951',3,'INVALID-DEMO','{"code":""}'::jsonb,'REJECT')
   ON CONFLICT(tenant_id,job_id,row_number) DO NOTHING`,
  `INSERT INTO app.import_errors(id,tenant_id,job_id,row_number,column_name,code,message,severity) VALUES
   ('10000000-0000-4000-8000-000000000955','${tenantId}','10000000-0000-4000-8000-000000000951',3,'vendor_code','REQUIRED','Vendor code is required','ERROR')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.auto_allocation_rules(id,tenant_id,name,priority,client_id,lane_id,vendor_id,max_vehicles,offer_rate_minor,offer_valid_minutes,active,created_by,updated_by) VALUES
   ('10000000-0000-4000-8000-000000000961','${tenantId}','Demo preferred vendor allocation',10,'10000000-0000-4000-8000-000000000600','10000000-0000-4000-8000-000000000612','10000000-0000-4000-8000-000000000700',1,750000,120,true,'${ids.operations}','${ids.operations}')
   ON CONFLICT(tenant_id,name) DO NOTHING`,
  `INSERT INTO app.control_saved_views(id,tenant_id,owner_id,lens,name,filters,is_default,created_at,updated_at) VALUES
   ('10000000-0000-4000-8000-000000000962','${tenantId}','${ids.operations}','PLACEMENT','Demo open placements','{"states":["OPEN","PARTIALLY_ALLOCATED"]}'::jsonb,true,now(),now()),
   ('10000000-0000-4000-8000-000000000963','${tenantId}','${ids.finance}','COLLECTION','Demo receivables','{"states":["POSTED","SUBMITTED"]}'::jsonb,true,now(),now())
   ON CONFLICT(tenant_id,owner_id,lens,name) DO NOTHING`,
  `INSERT INTO app.alert_rules(id,tenant_id,code,name,source_module,metric_code,scope_node_ids,threshold,severity,recipient_policy,channels,acknowledgement_required,resolution_condition,active,created_at,updated_at) VALUES
   ('10000000-0000-4000-8000-000000000964','${tenantId}','DEMO-PLACEMENT-SLA','Demo placement SLA risk','operations','placement_delay_minutes',ARRAY['10000000-0000-4000-8000-000000000204'::uuid],'{"operator":"gte","value":60}'::jsonb,'HIGH','{"roleCodes":["TRAFFIC_PLACEMENT_EXECUTIVE"]}'::jsonb,ARRAY['IN_APP'],true,'{"state":"FULFILLED"}'::jsonb,true,now()-interval '2 days',now()-interval '2 days')
   ON CONFLICT(tenant_id,code) DO NOTHING`,
  `INSERT INTO app.operational_alerts(id,tenant_id,rule_id,deduplication_key,source_module,source_record_id,alert_type,severity,state,title,summary,evidence,owner_membership_id,due_at,first_seen_at,last_seen_at,occurrence_count,created_at,updated_at) VALUES
   ('10000000-0000-4000-8000-000000000965','${tenantId}','10000000-0000-4000-8000-000000000964','demo:placement:DEMO-IND-OPEN','operations','10000000-0000-4000-8000-000000000801','PLACEMENT_SLA_RISK','HIGH','ACKNOWLEDGED','Placement commitment needs attention','DEMO-IND-OPEN is approaching its committed placement time.','{"indentNo":"DEMO-IND-OPEN","minutesRemaining":60}'::jsonb,'10000000-0000-4000-8000-000000000402',now()+interval '1 hour',now()-interval '2 hours',now()-interval '30 minutes',2,now()-interval '2 hours',now()-interval '30 minutes')
   ON CONFLICT(tenant_id,deduplication_key) DO NOTHING`,
  `INSERT INTO app.operational_alert_actions(id,tenant_id,alert_id,actor_id,action,reason,payload,occurred_at) VALUES
   ('10000000-0000-4000-8000-000000000966','${tenantId}','10000000-0000-4000-8000-000000000965','${ids.operations}','ACKNOWLEDGE','Demo operations user is arranging placement.','{"ownerMembershipId":"10000000-0000-4000-8000-000000000402"}'::jsonb,now()-interval '30 minutes')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value) VALUES
   ('${tenantId}','branding',1,'{"shortName":"Demo Logistics","primaryColor":"#16324f","accentColor":"#d97706"}'::jsonb),
   ('${tenantId}','commercial',1,'{"currency":"INR","timezone":"Asia/Kolkata","taxBasisPoints":1800}'::jsonb),
   ('${tenantId}','demo-bootstrap',1,'{"manifestVersion":"2026.08.1","tenantCode":"DEMO","disposable":true}'::jsonb)
   ON CONFLICT(tenant_id,namespace) DO NOTHING`,
  `INSERT INTO app.setup_checklist_items(tenant_id,key,label,display_order,state,completed_by,completed_at) VALUES
   ('${tenantId}','organization','Organization',1,'COMPLETE','${ids.owner}',now()),('${tenantId}','users','Users',2,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','branches','Branches',3,'COMPLETE','${ids.owner}',now()),('${tenantId}','clients','Clients',4,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','vendors','Vendors',5,'COMPLETE','${ids.owner}',now()),('${tenantId}','commercial','Commercial settings',6,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','imports','Imports',7,'COMPLETE','${ids.owner}',now()),('${tenantId}','branding','Branding',8,'COMPLETE','${ids.owner}',now())
   ON CONFLICT(tenant_id,key) DO UPDATE SET state='COMPLETE',completed_by=excluded.completed_by,completed_at=coalesce(app.setup_checklist_items.completed_at,excluded.completed_at),updated_at=now()`,
  `INSERT INTO reporting.tenant_activity_projection(tenant_id,last_activity_at,user_count,config_count,event_count,refreshed_at) VALUES
   ('${tenantId}',now(),6,3,3,now()) ON CONFLICT(tenant_id) DO UPDATE SET last_activity_at=now(),user_count=6,config_count=3,event_count=3,refreshed_at=now(),updated_at=now()`,
] as const;

export const DEMO_CONTENT_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      dataset: DEMO_DATASET,
      version: DEMO_DATASET_VERSION,
      anchor: DEMO_ANCHOR_DATE,
      statements,
      bankEnvelopeVersion: 1,
      userIds: [
        ids.owner,
        ids.operations,
        ids.finance,
        ids.vendor,
        ids.driver,
        ids.client,
      ],
    }),
  )
  .digest("hex");

export async function seedDemoData(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrl?: string,
) {
  const config = demoSeedConfig(env);
  const db = createDatabase(databaseUrl);
  const passwordHash = await argon2.hash(config.password, {
    type: argon2.argon2id,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update("0000000000000001", "utf8"),
    cipher.final(),
  ]);
  const bankEnvelope = Buffer.from(
    JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }),
    "utf8",
  );
  const users = [
    [ids.owner, config.tenantOwnerEmail, "Demo Tenant Owner", false],
    [ids.operations, config.operationsEmail, "Demo Operations User", false],
    [ids.finance, config.financeEmail, "Demo Finance User", false],
    [ids.vendor, config.vendorEmail, "Demo Vendor User", false],
    [ids.driver, config.driverEmail, "Demo Driver User", false],
    [ids.client, config.clientEmail, "Demo Client User", false],
  ] as const;

  try {
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.platform_context','on',true)",
        );
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended('logistics:demo-seed',0))",
        );
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.current_tenant_id',$1,true)",
          tenantId,
        );
        const platformAdmins = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text FROM app.users
          WHERE lower(email)=lower(${config.platformAdminEmail})
            AND is_platform_admin AND status='ACTIVE'
          ORDER BY created_at,id LIMIT 1
        `;
        const platformAdminId = platformAdmins[0]?.id;
        if (!platformAdminId) {
          throw new Error(
            `Active platform administrator ${config.platformAdminEmail} was not found. Run db:seed with PLATFORM_ADMIN_EMAIL first; demo bootstrap never creates or changes the platform administrator.`,
          );
        }
        const existingTenant = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          "SELECT id::text FROM app.tenants WHERE code='DEMO'",
        );
        if (existingTenant[0] && existingTenant[0].id !== tenantId) {
          throw new Error(
            "Tenant code DEMO already belongs to another tenant; choose a non-conflicting database before bootstrapping demo data.",
          );
        }

        let rotated = false;
        for (const [id, email] of users) {
          const existing = await tx.$queryRaw<
            Array<{ id: string; password_hash: string }>
          >`
            SELECT id::text,password_hash FROM app.users WHERE email=${email}
          `;
          if (existing[0] && existing[0].id !== id) {
            throw new Error(
              `Reserved demo identity ${email} already exists with a different id; change its email or remove it before bootstrapping demo data.`,
            );
          }
          if (
            existing[0] &&
            !(await argon2.verify(existing[0].password_hash, config.password))
          ) {
            if (!config.rotatePassword) {
              throw new Error(
                `Configured DEMO_USER_PASSWORD does not match existing demo identity ${email}. Reuse the original password or set DEMO_ROTATE_PASSWORD=true to rotate all demo users and revoke their sessions.`,
              );
            }
            rotated = true;
          }
        }
        if (rotated) {
          await tx.$executeRaw`
            UPDATE app.users SET password_hash=${passwordHash},auth_version=auth_version+1,
              credentials_changed_at=${anchorTime},updated_at=${anchorTime},version=version+1
            WHERE id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid)
          `;
          await tx.$executeRaw`
            UPDATE app.sessions SET revoked_at=${anchorTime},
              revoked_reason='DEMO_PASSWORD_ROTATED',updated_at=${anchorTime},version=version+1
            WHERE user_id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid)
              AND revoked_at IS NULL
          `;
        }

        if (existingTenant[0]) {
          const markers = await tx.$queryRaw<Array<{ content_hash: string }>>`
            SELECT content_hash::text FROM app.demo_bootstrap_runs
            WHERE tenant_id=${tenantId}::uuid AND dataset=${DEMO_DATASET}
              AND dataset_version=${DEMO_DATASET_VERSION}
            FOR UPDATE
          `;
          if (markers[0] && markers[0].content_hash !== DEMO_CONTENT_HASH) {
            throw new Error(
              `Demo dataset ${DEMO_DATASET_VERSION} already exists with a different content hash. Bump the dataset version before changing seeded content.`,
            );
          }
          if (markers[0]) {
            const count = await tx.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int count FROM app.users
              WHERE id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid)
            `;
            if (count[0]?.count !== users.length) {
              throw new Error(
                "Demo bootstrap marker exists but one or more configured demo identities are missing.",
              );
            }
            return { replayed: true, rotated };
          }
        }

        for (const [id, email, displayName, platformAdmin] of users) {
          await tx.$executeRaw`
          INSERT INTO app.users(id,email,display_name,password_hash,status,is_platform_admin)
          VALUES(${id}::uuid,${email},${displayName},${passwordHash},'ACTIVE',${platformAdmin})
          ON CONFLICT(email) DO NOTHING
        `;
          const actual = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text FROM app.users WHERE email=${email}
        `;
          if (actual[0]?.id !== id) {
            throw new Error(
              `Reserved demo identity ${email} already exists with a different id; change its email or remove it before bootstrapping demo data.`,
            );
          }
        }
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.actor_user_id',$1,true)",
          platformAdminId,
        );
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.correlation_id','demo-bootstrap',true)",
        );
        for (const statement of statements) {
          const anchored = statement
            .replaceAll(ids.platform, platformAdminId)
            .replaceAll("current_date", anchorDateSql)
            .replaceAll("now()", anchorTimeSql);
          await tx.$executeRawUnsafe(anchored);
          if (statement.startsWith("INSERT INTO app.vendors(")) {
            await tx.$executeRaw`
              INSERT INTO app.vendor_bank_versions(id,tenant_id,vendor_id,version,account_holder,account_ciphertext,account_last4,ifsc,state,maker_id,checker_id,verified_at)
              VALUES('10000000-0000-4000-8000-000000000701'::uuid,${tenantId}::uuid,'10000000-0000-4000-8000-000000000700'::uuid,1,'Demo Fleet Services',${bankEnvelope},'0001','HDFC0000001','VERIFIED',${ids.owner}::uuid,${ids.finance}::uuid,${anchorTime}-interval '20 days')
              ON CONFLICT(tenant_id,vendor_id,version) DO NOTHING
            `;
          }
        }
        await tx.$executeRaw`
          INSERT INTO app.demo_bootstrap_runs(tenant_id,dataset,dataset_version,content_hash,anchor_date,summary)
          VALUES(${tenantId}::uuid,${DEMO_DATASET},${DEMO_DATASET_VERSION},${DEMO_CONTENT_HASH},${DEMO_ANCHOR_DATE}::date,
            '{"tenantCode":"DEMO","users":6,"indents":4,"trips":2,"clientInvoices":2,"vendorPayouts":1}'::jsonb)
          ON CONFLICT(tenant_id,dataset,dataset_version) DO NOTHING
        `;
        return { replayed: false, rotated };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    console.log(
      result.replayed
        ? `Demo tenant DEMO already matches ${DEMO_DATASET_VERSION}; no data changes were required${result.rotated ? " after explicit password rotation" : ""}.`
        : `Demo tenant DEMO is ready with ${config.tenantOwnerEmail} and role-specific users.`,
    );
    return result;
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await seedDemoData();
}
