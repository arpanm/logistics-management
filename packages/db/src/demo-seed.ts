import argon2 from "argon2";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDatabase } from "./index.js";
import { demoSeedConfig, type DemoSeedConfig } from "./demo-seed-config.js";

export const DEMO_IDS = {
  platform: "10000000-0000-4000-8000-000000000001",
  owner: "10000000-0000-4000-8000-000000000002",
  operations: "10000000-0000-4000-8000-000000000003",
  finance: "10000000-0000-4000-8000-000000000004",
  vendor: "10000000-0000-4000-8000-000000000005",
  driver: "10000000-0000-4000-8000-000000000006",
  client: "10000000-0000-4000-8000-000000000007",
  support: "10000000-0000-4000-8000-000000000008",
  analyst: "10000000-0000-4000-8000-000000000009",
  auditor: "10000000-0000-4000-8000-000000000010",
} as const;
const ids = DEMO_IDS;

export const DEMO_TENANT_ID = "10000000-0000-4000-8000-000000000100";
const tenantId = DEMO_TENANT_ID;
export const DEMO_DATASET = "logistics-end-to-end-demo";
export const DEMO_DATASET_VERSION = "2026.09.2";
export const DEMO_ANCHOR_DATE = "2026-08-31";
const anchorTime = new Date("2026-08-31T12:00:00+05:30");

/** Stable presentation baseline. Canonical records are materialized below; projections remain derived. */
export const DEMO_SHOWCASE_MANIFEST = {
  tenant: 1,
  regions: 2,
  branches: 3,
  internalEmployees: 6,
  clients: 4,
  clientLocations: 10,
  vendors: 5,
  activeVendors: 4,
  vehicles: 12,
  drivers: 10,
  indents: 36,
  allocations: 24,
  trips: 18,
  podTasks: 14,
  clientInvoices: 18,
  receipts: 8,
  vendorBills: 14,
  paymentBatches: 5,
  alerts: 12,
  lanes: 6,
  currentCommercialExamples: 2,
  expiredCommercialExamples: 1,
  upcomingCommercialExamples: 2,
  placementLensRows: 10,
  podLensRows: 10,
  collectionLensRows: 10,
  tripLensRows: 10,
  vendorPayableLensRows: 10,
  placementPortfolios: 3,
  podPortfolios: 3,
  collectionPortfolios: 3,
  tripPortfolios: 3,
  vendorPayablePortfolios: 3,
  notificationSuppression: 1,
} as const;
type ShowcaseCountKey = keyof Omit<typeof DEMO_SHOWCASE_MANIFEST, "tenant">;
export type DemoShowcaseManifest = {
  readonly [K in keyof typeof DEMO_SHOWCASE_MANIFEST]: number;
};

export function validateDemoShowcaseCounts(
  counts: Record<ShowcaseCountKey, number>,
) {
  validateDemoShowcaseCountsFor(DEMO_SHOWCASE_MANIFEST, counts);
}

export function validateDemoShowcaseCountsFor(
  manifest: DemoShowcaseManifest,
  counts: Record<ShowcaseCountKey, number>,
) {
  for (const [key, minimum] of Object.entries(manifest)) {
    if (key === "tenant") continue;
    const count = counts[key as ShowcaseCountKey];
    if (!Number.isSafeInteger(count) || count < minimum) {
      throw new Error(
        `Demo showcase reconciliation failed for ${key}: expected at least ${minimum}, received ${count}.`,
      );
    }
  }
}

export const DEMO_SQL_STATEMENTS = [
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
   ('10000000-0000-4000-8000-000000000302','${tenantId}','BLR-HUB','Bengaluru Operations Hub','BRANCH','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000204','Asia/Kolkata','Peenya Industrial Area, Bengaluru',13.028500,77.519700,ARRAY['560058'],'{"type":"RADIUS","radiusKm":15}'::jsonb,current_date,'ACTIVE','${ids.platform}'),
   ('10000000-0000-4000-8000-000000000303','${tenantId}','WEST','Demo West Region','REGION','10000000-0000-4000-8000-000000000301',null,'Asia/Kolkata','Mumbai, Maharashtra',19.076000,72.877700,ARRAY['400001'],'{}'::jsonb,current_date,'ACTIVE','${ids.platform}'),
   ('10000000-0000-4000-8000-000000000304','${tenantId}','NORTH','Demo North Region','REGION','10000000-0000-4000-8000-000000000301',null,'Asia/Kolkata','Delhi NCR',28.613900,77.209000,ARRAY['110001'],'{}'::jsonb,current_date,'ACTIVE','${ids.platform}'),
   ('10000000-0000-4000-8000-000000000305','${tenantId}','MUM-HUB','Mumbai Operations Hub','BRANCH','10000000-0000-4000-8000-000000000303',null,'Asia/Kolkata','Bhiwandi, Maharashtra',19.281300,73.048300,ARRAY['421302'],'{}'::jsonb,current_date,'ACTIVE','${ids.platform}'),
   ('10000000-0000-4000-8000-000000000306','${tenantId}','DEL-HUB','Delhi Operations Hub','BRANCH','10000000-0000-4000-8000-000000000304',null,'Asia/Kolkata','Gurugram, Haryana',28.459500,77.026600,ARRAY['122001'],'{}'::jsonb,current_date,'ACTIVE','${ids.platform}')
   ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name,state='ACTIVE',updated_at=now()`,
  `INSERT INTO app.organization_closure(tenant_id,ancestor_id,descendant_id,depth) VALUES
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000301',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000302',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000302','10000000-0000-4000-8000-000000000302',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000303',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000304',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000305',2),
   ('${tenantId}','10000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000306',2),
   ('${tenantId}','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000303',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000303','10000000-0000-4000-8000-000000000305',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000304','10000000-0000-4000-8000-000000000304',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000304','10000000-0000-4000-8000-000000000306',1),
   ('${tenantId}','10000000-0000-4000-8000-000000000305','10000000-0000-4000-8000-000000000305',0),
   ('${tenantId}','10000000-0000-4000-8000-000000000306','10000000-0000-4000-8000-000000000306',0)
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
   ('10000000-0000-4000-8000-000000000406','${tenantId}','${ids.client}','Demo Client User','demo.client@logistics.test','DEMO-CLIENT',null,'CLIENT','ACTIVE'),
   ('10000000-0000-4000-8000-000000000407','${tenantId}','${ids.support}','Demo Regional Support','demo.support@logistics.test','DEMO-SUPPORT',null,'INTERNAL','ACTIVE'),
   ('10000000-0000-4000-8000-000000000408','${tenantId}','${ids.analyst}','Demo Control Analyst','demo.analyst@logistics.test','DEMO-ANALYST',null,'INTERNAL','ACTIVE'),
   ('10000000-0000-4000-8000-000000000409','${tenantId}','${ids.auditor}','Demo Internal Auditor','demo.auditor@logistics.test','DEMO-AUDITOR',null,'INTERNAL','ACTIVE')
   ON CONFLICT(tenant_id,invited_email) DO UPDATE SET user_id=excluded.user_id,invited_name=excluded.invited_name,employee_code=excluded.employee_code,role=excluded.role,portal_audience=excluded.portal_audience,status='ACTIVE',updated_at=now()`,
  `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id,status)
   SELECT '${tenantId}',m.id,r.id,'ACTIVE' FROM app.tenant_memberships m JOIN app.roles r ON r.tenant_id=m.tenant_id AND r.code=CASE m.id
     WHEN '10000000-0000-4000-8000-000000000401' THEN 'TENANT_OWNER'
     WHEN '10000000-0000-4000-8000-000000000402' THEN 'TRAFFIC_PLACEMENT_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000403' THEN 'FINANCE_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000404' THEN 'VENDOR_OWNER'
     WHEN '10000000-0000-4000-8000-000000000405' THEN 'DRIVER'
     WHEN '10000000-0000-4000-8000-000000000406' THEN 'CLIENT_VIEWER'
     WHEN '10000000-0000-4000-8000-000000000407' THEN 'TRAFFIC_PLACEMENT_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000408' THEN 'FINANCE_EXECUTIVE'
     WHEN '10000000-0000-4000-8000-000000000409' THEN 'TENANT_OWNER' END
   WHERE m.tenant_id='${tenantId}' AND m.id IN ('10000000-0000-4000-8000-000000000401','10000000-0000-4000-8000-000000000402','10000000-0000-4000-8000-000000000403','10000000-0000-4000-8000-000000000404','10000000-0000-4000-8000-000000000405','10000000-0000-4000-8000-000000000406','10000000-0000-4000-8000-000000000407','10000000-0000-4000-8000-000000000408','10000000-0000-4000-8000-000000000409')
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
  `INSERT INTO app.clients(id,tenant_id,code,legal_name,industry,billing_entity_id,credit_days,pod_mode,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((600000+g)::text,12,'0'))::uuid,'${tenantId}',
     'DEMO-CLIENT-'||lpad(g::text,2,'0'),
     (ARRAY['Demo Consumer Products Limited','Demo Healthcare Distribution Limited','Demo Industrial Components Limited'])[g],
     (ARRAY['Consumer goods','Healthcare','Manufacturing'])[g],'10000000-0000-4000-8000-000000000301'::uuid,
     (ARRAY[30,45,21])[g],'DIGITAL','ACTIVE'
   FROM generate_series(1,3) g ON CONFLICT(tenant_id,code) DO NOTHING`,
  `INSERT INTO app.client_locations(id,tenant_id,client_id,code,name,location_type,organization_node_id,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((601000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((600000+((g-1)%3)+1)::text,12,'0'))::uuid,
     'DEMO-LOC-'||lpad(g::text,2,'0'),
     (ARRAY['Pune Fulfilment Centre','Chennai Regional Depot','Mumbai Retail Hub','Delhi Distribution Centre','Ahmedabad Cross-dock','Kolkata Regional Store','Jaipur Service Centre','Kochi Customer Warehouse'])[g],
     CASE WHEN g%3=0 THEN 'STORE' ELSE 'WAREHOUSE' END,
     (ARRAY['10000000-0000-4000-8000-000000000302'::uuid,'10000000-0000-4000-8000-000000000305'::uuid,'10000000-0000-4000-8000-000000000306'::uuid])[((g-1)%3)+1],'ACTIVE'
   FROM generate_series(1,8) g ON CONFLICT(tenant_id,client_id,code) DO NOTHING`,
  `INSERT INTO app.contracts(id,tenant_id,client_id,code,name,state,current_version,effective_from,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((610000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((600000+g)::text,12,'0'))::uuid,'DEMO-CONTRACT-'||lpad(g::text,2,'0'),
     'DEMO showcase contract '||lpad(g::text,2,'0'),'PUBLISHED',1,current_date-60,'${ids.owner}'::uuid
   FROM generate_series(1,3) g ON CONFLICT(tenant_id,code) DO NOTHING`,
  `INSERT INTO app.contract_versions(id,tenant_id,contract_id,version,credit_days,pod_mode,document_requirements,terms,snapshot_hash,published_at,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((611000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((610000+g)::text,12,'0'))::uuid,1,30,'DIGITAL','["LR","POD"]'::jsonb,
     '{"currency":"INR","synthetic":true}'::jsonb,'demo-showcase-contract-'||g,now()-interval '60 days','${ids.owner}'::uuid
   FROM generate_series(1,3) g ON CONFLICT(tenant_id,contract_id,version) DO NOTHING`,
  `INSERT INTO app.contract_lanes(id,tenant_id,contract_version_id,code,origin_location_id,destination_location_id,truck_type,cargo_type,quantity_min_milli,quantity_max_milli,priority,service_window)
   SELECT ('11000000-0000-4000-8000-'||lpad((612000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((611000+((g-1)%3)+1)::text,12,'0'))::uuid,'DEMO-LANE-'||lpad(g::text,2,'0'),
     ('11000000-0000-4000-8000-'||lpad((601000+g)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((601003+g)::text,12,'0'))::uuid,'32 FT SXL','FMCG',1000000,9000000,100,
     '{"pickupHours":4,"transitHours":18}'::jsonb
   FROM generate_series(1,5) g ON CONFLICT(tenant_id,contract_version_id,code) DO NOTHING`,
  `INSERT INTO app.client_rate_lines(id,tenant_id,lane_id,charge_code,basis,amount_minor,tax_basis_points,effective_from,effective_to,priority,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((613000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((612000+g)::text,12,'0'))::uuid,'FREIGHT','PER_TRIP',800000+(g*25000),1800,
     CASE WHEN g=2 THEN now()-interval '180 days' WHEN g IN (3,5) THEN now()+interval '30 days' ELSE now()-interval '30 days' END,
     CASE WHEN g=2 THEN now()-interval '30 days' ELSE null END,100,
     CASE WHEN g=2 THEN 'SUPERSEDED' WHEN g=5 THEN 'APPROVED' ELSE 'PUBLISHED' END
   FROM generate_series(1,5) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.sla_rules(id,tenant_id,lane_id,placement_minutes,transit_minutes,pod_minutes,effective_from,effective_to,priority)
   SELECT ('11000000-0000-4000-8000-'||lpad((614000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((612000+g)::text,12,'0'))::uuid,240,1080,1440,
     CASE WHEN g=2 THEN now()-interval '180 days' WHEN g IN (3,5) THEN now()+interval '30 days' ELSE now()-interval '30 days' END,
     CASE WHEN g=2 THEN now()-interval '30 days' ELSE null END,100
   FROM generate_series(1,5) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.vendors(id,tenant_id,code,legal_name,pan,gstin,tds_basis_points,payment_terms_days,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((700000+g)::text,12,'0'))::uuid,'${tenantId}',
     'DEMO-VENDOR-'||lpad(g::text,2,'0'),
     (ARRAY['Demo Express Carriers Private Limited','Demo Southern Roadways Limited','Demo National Freight Services','Demo Expired Compliance Transport'])[g],
     'DMOPN'||lpad(g::text,4,'0')||'X','29DMOGS'||lpad(g::text,4,'0')||'Z5',200,15,
     CASE WHEN g=4 THEN 'BLOCKED' ELSE 'ACTIVE' END
   FROM generate_series(1,4) g ON CONFLICT(tenant_id,code) DO NOTHING`,
  `INSERT INTO app.vehicles(id,tenant_id,vendor_id,registration_number,vehicle_type,make,model,model_year,capacity_milli,gps_device_id,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((710000+g)::text,12,'0'))::uuid,'${tenantId}',
     CASE WHEN g<=3 THEN '10000000-0000-4000-8000-000000000700'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((700000+((g-4)%3)+1)::text,12,'0'))::uuid END,
     'DEMO'||lpad(g::text,6,'0'),'32 FT SXL',CASE WHEN g%2=0 THEN 'Tata' ELSE 'Ashok Leyland' END,
     CASE WHEN g%2=0 THEN 'LPT' ELSE 'Ecomet' END,2024,9000000,'DEMO-GPS-'||lpad((g+2)::text,2,'0'),
     CASE WHEN g=10 THEN 'BLOCKED' ELSE 'ACTIVE' END
   FROM generate_series(1,10) g ON CONFLICT(tenant_id,registration_number) DO NOTHING`,
  `INSERT INTO app.drivers(id,tenant_id,vendor_id,code,display_name,mobile,licence_number,licence_class,licence_valid_to,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((720000+g)::text,12,'0'))::uuid,'${tenantId}',
     CASE WHEN g<=2 THEN '10000000-0000-4000-8000-000000000700'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((700000+((g-3)%3)+1)::text,12,'0'))::uuid END,
     'DRV-DEMO-'||lpad((g+2)::text,2,'0'),'Demo Driver '||lpad((g+2)::text,2,'0'),'+91980000'||lpad(g::text,4,'0'),
     'DEMO-LIC-'||lpad((g+2)::text,4,'0'),'HMV',(current_date+CASE WHEN g=8 THEN -1 ELSE 730 END)::date,
     CASE WHEN g=8 THEN 'BLOCKED' ELSE 'ACTIVE' END
   FROM generate_series(1,8) g ON CONFLICT(tenant_id,code) DO NOTHING`,
  `INSERT INTO app.indents(id,tenant_id,indent_no,client_id,client_location_id,contract_version_id,lane_id,requested_vehicles,quantity_milli,pickup_window_start,pickup_window_end,committed_placement_at,owner_membership_id,source,source_reference,cargo_type,body_type,commercial_snapshot,state,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((800000+g)::text,12,'0'))::uuid,'${tenantId}','DEMO-IND-'||lpad((g+4)::text,3,'0'),
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000600'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((600000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     CASE WHEN g%4=0 THEN (CASE WHEN g%8=0 THEN '10000000-0000-4000-8000-000000000602' ELSE '10000000-0000-4000-8000-000000000601' END)::uuid ELSE ('11000000-0000-4000-8000-'||lpad((601000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000611'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((611000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000612'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((612000+((g-1)%3)+1)::text,12,'0'))::uuid END,1,9000000,
     now()+((g-20)||' hours')::interval,now()+((g-16)||' hours')::interval,now()+((g-22)||' hours')::interval,
     '10000000-0000-4000-8000-000000000402'::uuid,'MANUAL','DEMO-SHOWCASE-'||lpad(g::text,3,'0'),'FMCG','CONTAINER',
     jsonb_build_object('clientRateMinor','1000000','currency','INR','manifest','${DEMO_DATASET_VERSION}'),
     (ARRAY['OPEN','PARTIALLY_ALLOCATED','FULFILLED','CLOSED','CANCELLED','DRAFT'])[((g-1)%6)+1],'${ids.operations}'::uuid
   FROM generate_series(1,32) g ON CONFLICT(tenant_id,indent_no) DO NOTHING`,
  `INSERT INTO app.allocations(id,tenant_id,indent_id,vendor_id,allotted_vehicles,offered_rate_minor,offer_channel,offered_at,expires_at,response_at,state,owner_membership_id,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((810000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((800000+g)::text,12,'0'))::uuid,
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000700'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((700000+(g%3)+1)::text,12,'0'))::uuid END,
     1,650000+(g*5000),'PORTAL',now()-((g+2)||' hours')::interval,now()+interval '2 hours',
     CASE WHEN g%5=0 THEN null ELSE now()-((g+1)||' hours')::interval END,
     CASE WHEN g<=16 THEN 'PLACED' ELSE (ARRAY['OFFERED','ACCEPTED','REJECTED','EXPIRED','NTP_RELEASED'])[((g-17)%5)+1] END,
     '10000000-0000-4000-8000-000000000402'::uuid,'${ids.operations}'::uuid
   FROM generate_series(1,21) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.allocation_assignments(id,tenant_id,allocation_id,vehicle_id,driver_id,assigned_from,assigned_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((820000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((810000+g)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((710000+((g-1)%10)+1)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((720000+((g-1)%8)+1)::text,12,'0'))::uuid,now()-((g+5)||' hours')::interval,'${ids.operations}'::uuid
   FROM generate_series(1,16) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.trips(id,tenant_id,allocation_id,trip_no,lr_no,assigned_driver_id,assigned_vehicle_id,planned_pickup_at,planned_delivery_at,tracking_consent_from,tracking_consent_to,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((830000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((810000+g)::text,12,'0'))::uuid,'DEMO-TRIP-'||lpad((g+2)::text,3,'0'),'DEMO-LR-'||lpad((g+2)::text,3,'0'),
     ('11000000-0000-4000-8000-'||lpad((720000+((g-1)%8)+1)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((710000+((g-1)%10)+1)::text,12,'0'))::uuid,
     now()-((g+5)||' hours')::interval,now()+((10-g)||' hours')::interval,now()-((g+6)||' hours')::interval,now()+interval '2 days',
     (ARRAY['PLANNED','AT_ORIGIN','LOADED','IN_TRANSIT','AT_DESTINATION','DELIVERED','CANCELLED'])[((g-1)%7)+1]
   FROM generate_series(1,16) g ON CONFLICT(tenant_id,trip_no) DO NOTHING`,
  `INSERT INTO app.pod_tasks(id,tenant_id,trip_id,delivered_at,receiver_name,receiver_evidence,received_at,submitted_at,contract_snapshot,invoice_value_minor,prior_period,state)
   SELECT ('11000000-0000-4000-8000-'||lpad((850000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((830000+g)::text,12,'0'))::uuid,now()-((g+1)||' days')::interval,
     'Demo Receiver '||lpad(g::text,2,'0'),jsonb_build_object('packages',80+g,'manifest','${DEMO_DATASET_VERSION}'),
     CASE WHEN g%4=0 THEN null ELSE now()-(g||' days')::interval END,
     CASE WHEN g%3=0 THEN null ELSE now()-((g-1)||' days')::interval END,
     '{"contract":"DEMO-CONTRACT","version":1}'::jsonb,590000+(g*10000),g>10,
     (ARRAY['AWAITING_POD','RECEIVED','UNDER_REVIEW','ACCEPTED','SUBMITTED_TO_CLIENT','CLOSED','REJECTED','CORRECTION_REQUIRED'])[((g-1)%8)+1]
   FROM generate_series(1,13) g ON CONFLICT(tenant_id,trip_id) DO NOTHING`,
  `INSERT INTO app.client_invoices(id,tenant_id,invoice_no,client_id,client_location_id,invoice_date,currency,credit_days,taxable_minor,tax_minor,total_minor,acknowledged_at,due_date,state,reversal_of,created_by,posted_at)
   SELECT ('11000000-0000-4000-8000-'||lpad((900000+g)::text,12,'0'))::uuid,'${tenantId}','DEMO-INV-'||lpad((g+2)::text,3,'0'),
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000600'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((600000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000601'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((601000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     current_date-(g*7), 'INR',30,
     500000+((CASE WHEN g%7=6 THEN g-1 ELSE g END)*10000),
     90000+((CASE WHEN g%7=6 THEN g-1 ELSE g END)*1800),
     590000+((CASE WHEN g%7=6 THEN g-1 ELSE g END)*11800),
     CASE WHEN g%6=0 THEN null ELSE now()-(g*7||' days')::interval END,current_date-(g*7)+30,
     (ARRAY['DRAFT','PENDING_APPROVAL','APPROVED','POSTED','SUBMITTED','REVERSED','REJECTED'])[((g-1)%7)+1],
     CASE WHEN g%7=6 THEN ('11000000-0000-4000-8000-'||lpad((900000+g-1)::text,12,'0'))::uuid ELSE null END,
     '${ids.finance}'::uuid,CASE WHEN g%7 IN (1,2) THEN null ELSE now()-(g*7||' days')::interval END
   FROM generate_series(1,16) g ON CONFLICT(tenant_id,invoice_no) DO NOTHING`,
  `INSERT INTO app.receipts(id,tenant_id,receipt_ref,client_id,payment_date,amount_minor,mode,instrument_no,bank_reference,state,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((920000+g)::text,12,'0'))::uuid,'${tenantId}','DEMO-RCPT-'||lpad((g+1)::text,3,'0'),
     CASE WHEN g%4=0 THEN ('11000000-0000-4000-8000-'||lpad((600000+((g-2)%3)+1)::text,12,'0'))::uuid ELSE ('11000000-0000-4000-8000-'||lpad((600000+((g-1)%3)+1)::text,12,'0'))::uuid END,
     current_date-g,250000+((CASE WHEN g%4=0 THEN g-1 ELSE g END)*10000),'NEFT','DEMO-NEFT-'||lpad((g+1)::text,3,'0'),'DEMO-BANK-'||lpad((g+1)::text,3,'0'),
     (ARRAY['UNRECONCILED','PENDING_APPROVAL','RECONCILED','REVERSED'])[((g-1)%4)+1],'${ids.finance}'::uuid
   FROM generate_series(1,7) g ON CONFLICT(tenant_id,receipt_ref) DO NOTHING`,
  `INSERT INTO app.receipt_ledger_entries(id,tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reverses_entry_id,reason,actor_id)
   SELECT ('11000000-0000-4000-8000-'||lpad((922000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((920000+g)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((900000+(CASE WHEN g%4=0 THEN g-1 ELSE g END))::text,12,'0'))::uuid,
     (ARRAY['ALLOCATION','DEDUCTION','ON_ACCOUNT','REVERSAL'])[((g-1)%4)+1],
     CASE WHEN g%4=0 THEN -(250000+((g-1)*10000)) ELSE 250000+(g*10000) END,
     CASE WHEN g%4=0 THEN ('11000000-0000-4000-8000-'||lpad((922000+g-1)::text,12,'0'))::uuid ELSE null END,
     'Synthetic DEMO reconciliation example','${ids.finance}'::uuid
   FROM generate_series(1,7) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.vendor_bills(id,tenant_id,vendor_id,vendor_invoice_no,invoice_date,taxable_minor,gst_minor,tds_minor,deduction_minor,advance_minor,payable_minor,state,verified_by,approved_by,created_by)
   SELECT ('11000000-0000-4000-8000-'||lpad((930000+g)::text,12,'0'))::uuid,'${tenantId}',
     CASE WHEN g%4=0 THEN '10000000-0000-4000-8000-000000000700'::uuid ELSE ('11000000-0000-4000-8000-'||lpad((700000+(g%3)+1)::text,12,'0'))::uuid END,
     'DEMO-VBILL-'||lpad((g+1)::text,3,'0'),current_date-(g*8),600000+(g*10000),108000+(g*1800),12000+(g*200),0,0,696000+(g*11600),
     (ARRAY['DRAFT','VALIDATION_EXCEPTION','PENDING_OPERATIONAL_VERIFICATION','PENDING_FINANCE_APPROVAL','APPROVED','PART_PAID','PAID','DISPUTED','REVERSED'])[((g-1)%9)+1],
     CASE WHEN g%3=1 THEN null ELSE '${ids.operations}'::uuid END,CASE WHEN g%4<2 THEN null ELSE '${ids.finance}'::uuid END,'${ids.owner}'::uuid
   FROM generate_series(1,13) g ON CONFLICT(tenant_id,vendor_id,vendor_invoice_no) DO NOTHING`,
  `INSERT INTO app.payment_batches(id,tenant_id,batch_no,bank_version_id,total_minor,state,maker_id,checker_id,utr)
   SELECT ('11000000-0000-4000-8000-'||lpad((940000+g)::text,12,'0'))::uuid,'${tenantId}','DEMO-PAYOUT-'||lpad((g+1)::text,3,'0'),
     '10000000-0000-4000-8000-000000000701'::uuid,696000+((CASE WHEN g=4 THEN 3 ELSE g END)*11600),
     (ARRAY['DRAFT','PENDING_APPROVAL','FAILED','REVERSED'])[g],'${ids.owner}'::uuid,
     CASE WHEN g=1 THEN null ELSE '${ids.finance}'::uuid END,CASE WHEN g>=3 THEN 'DEMO-UTR-'||lpad((g+1)::text,6,'0') ELSE null END
   FROM generate_series(1,4) g ON CONFLICT(tenant_id,batch_no) DO NOTHING`,
  `INSERT INTO app.payment_allocations(id,tenant_id,payment_batch_id,vendor_bill_id,amount_minor,reversal_of)
   SELECT ('11000000-0000-4000-8000-'||lpad((942000+g)::text,12,'0'))::uuid,'${tenantId}',
     ('11000000-0000-4000-8000-'||lpad((940000+g)::text,12,'0'))::uuid,
     ('11000000-0000-4000-8000-'||lpad((930000+(CASE WHEN g=4 THEN 3 ELSE g END))::text,12,'0'))::uuid,
     CASE WHEN g=4 THEN -(696000+(3*11600)) ELSE 696000+(g*11600) END,
     CASE WHEN g=4 THEN '11000000-0000-4000-8000-000000942003'::uuid ELSE null END
   FROM generate_series(1,4) g ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.operational_alerts(id,tenant_id,rule_id,deduplication_key,source_module,source_record_id,alert_type,severity,state,title,summary,evidence,owner_membership_id,due_at,snoozed_until,first_seen_at,last_seen_at,occurrence_count,resolved_at)
   SELECT ('11000000-0000-4000-8000-'||lpad((965000+g)::text,12,'0'))::uuid,'${tenantId}','10000000-0000-4000-8000-000000000964'::uuid,
     'demo:showcase:alert:'||lpad(g::text,2,'0'),'operations',('11000000-0000-4000-8000-'||lpad((800000+g)::text,12,'0'))::uuid,
     'DEMO_SHOWCASE_RISK',(ARRAY['INFO','WARNING','HIGH','CRITICAL'])[((g-1)%4)+1],
     (ARRAY['OPEN','ACKNOWLEDGED','SNOOZED','ESCALATED','RESOLVED'])[((g-1)%5)+1],
     'DEMO portfolio signal '||lpad(g::text,2,'0'),'Synthetic demonstration alert linked to a canonical indent.',
     jsonb_build_object('synthetic',true,'manifest','${DEMO_DATASET_VERSION}','ordinal',g),'10000000-0000-4000-8000-000000000402'::uuid,
     now()+(g||' hours')::interval,CASE WHEN g%5=3 THEN now()+interval '1 day' ELSE null END,now()-(g||' hours')::interval,now()-interval '10 minutes',g,
     CASE WHEN g%5=0 THEN now()-interval '10 minutes' ELSE null END
   FROM generate_series(1,11) g ON CONFLICT(tenant_id,deduplication_key) DO NOTHING`,
  `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value) VALUES
   ('${tenantId}','branding',1,'{"shortName":"Demo Logistics","primaryColor":"#16324f","accentColor":"#d97706"}'::jsonb),
   ('${tenantId}','commercial',1,'{"currency":"INR","timezone":"Asia/Kolkata","taxBasisPoints":1800}'::jsonb),
   ('${tenantId}','notifications',1,'{"suppressOutbound":true,"syntheticDestinationsOnly":true}'::jsonb),
   ('${tenantId}','demo-bootstrap',1,'{"manifestVersion":"2026.09.2","tenantCode":"DEMO","disposable":true}'::jsonb)
   ON CONFLICT(tenant_id,namespace) DO NOTHING`,
  `UPDATE app.tenant_configuration
   SET value=jsonb_set(value,'{manifestVersion}',to_jsonb('${DEMO_DATASET_VERSION}'::text),true),updated_at=now(),version=version+1
   WHERE tenant_id='${tenantId}' AND namespace='demo-bootstrap'
     AND value->>'manifestVersion' IN ('2026.08.1','2026.09.1')`,
  `INSERT INTO app.setup_checklist_items(tenant_id,key,label,display_order,state,completed_by,completed_at) VALUES
   ('${tenantId}','organization','Organization',1,'COMPLETE','${ids.owner}',now()),('${tenantId}','users','Users',2,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','branches','Branches',3,'COMPLETE','${ids.owner}',now()),('${tenantId}','clients','Clients',4,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','vendors','Vendors',5,'COMPLETE','${ids.owner}',now()),('${tenantId}','commercial','Commercial settings',6,'COMPLETE','${ids.owner}',now()),
   ('${tenantId}','imports','Imports',7,'COMPLETE','${ids.owner}',now()),('${tenantId}','branding','Branding',8,'COMPLETE','${ids.owner}',now())
   ON CONFLICT(tenant_id,key) DO UPDATE SET state='COMPLETE',completed_by=excluded.completed_by,completed_at=coalesce(app.setup_checklist_items.completed_at,excluded.completed_at),updated_at=now()`,
  `INSERT INTO reporting.tenant_activity_projection(tenant_id,last_activity_at,user_count,config_count,event_count,refreshed_at) VALUES
   ('${tenantId}',now(),9,4,3,now()) ON CONFLICT(tenant_id) DO UPDATE SET last_activity_at=now(),user_count=9,config_count=4,event_count=3,refreshed_at=now(),updated_at=now()`,
] as const;
const statements = DEMO_SQL_STATEMENTS;

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
        ids.support,
        ids.analyst,
        ids.auditor,
      ],
    }),
  )
  .digest("hex");

export type DemoBootstrapIds = {
  readonly [K in keyof typeof DEMO_IDS]: string;
};
export type DemoBootstrapUser = readonly [
  id: string,
  email: string,
  displayName: string,
  platformAdmin: boolean,
];
export type DemoBootstrapProfile = {
  dataset: string;
  datasetVersion: string;
  anchorDate: string;
  anchorTime: Date;
  tenantId: string;
  tenantCode: string;
  displayName: string;
  lockKey: string;
  ids: DemoBootstrapIds;
  users: readonly DemoBootstrapUser[];
  statements: readonly string[];
  contentHash: string;
  showcaseManifest: DemoShowcaseManifest;
  knownRowPrefix: string;
  bankAccountHolder: string;
  bankVersionId: string;
  bankVendorId: string;
  passwordVariable: string;
  rotateVariable: string;
  rotationAuditAction: string;
  rotationReason: string;
  adoptExistingTenant?: {
    id: string;
    allowedNames: readonly string[];
    requiresPristine: true;
  };
};

export function assertDemoProfileAdoptionState(
  profile: Pick<DemoBootstrapProfile, "tenantCode" | "adoptExistingTenant">,
  dependentRowCount: number,
) {
  if (profile.adoptExistingTenant && dependentRowCount !== 0) {
    throw new Error(
      `Tenant code ${profile.tenantCode} has ${dependentRowCount} dependent row(s) and cannot be adopted by the deterministic demo profile; use a pristine tenant reservation or a different tenant code.`,
    );
  }
}

export function assertDemoProfileTenantCollision(
  profile: Pick<
    DemoBootstrapProfile,
    "tenantCode" | "tenantId" | "displayName" | "adoptExistingTenant"
  >,
  existingTenant?: { id: string; name: string; legal_name: string },
) {
  if (!existingTenant) return;
  if (existingTenant.id === profile.tenantId && !profile.adoptExistingTenant) {
    return;
  }
  const adoption = profile.adoptExistingTenant;
  const allowedName = adoption?.allowedNames.some(
    (name) =>
      name.toLowerCase() === existingTenant.name.toLowerCase() ||
      name.toLowerCase() === existingTenant.legal_name.toLowerCase(),
  );
  if (
    !adoption ||
    adoption.id !== existingTenant.id ||
    profile.tenantId !== existingTenant.id ||
    !allowedName
  ) {
    throw new Error(
      `Tenant code ${profile.tenantCode} already belongs to another tenant; resolve the collision before bootstrapping ${profile.displayName}.`,
    );
  }
}

export function assertDemoProfileIdentityCollision(
  profile: Pick<DemoBootstrapProfile, "tenantCode">,
  email: string,
  expectedUserId: string,
  existingUserId?: string,
) {
  if (existingUserId && existingUserId !== expectedUserId) {
    throw new Error(
      `Reserved ${profile.tenantCode} identity ${email} already exists with a different id; resolve the identity collision before bootstrapping.`,
    );
  }
}

export function demoBootstrapProfile(
  config: DemoSeedConfig,
): DemoBootstrapProfile {
  return {
    dataset: DEMO_DATASET,
    datasetVersion: DEMO_DATASET_VERSION,
    anchorDate: DEMO_ANCHOR_DATE,
    anchorTime,
    tenantId,
    tenantCode: "DEMO",
    displayName: "Demo tenant",
    lockKey: "logistics:demo-seed",
    ids,
    users: [
      [ids.owner, config.tenantOwnerEmail, "Demo Tenant Owner", false],
      [ids.operations, config.operationsEmail, "Demo Operations User", false],
      [ids.finance, config.financeEmail, "Demo Finance User", false],
      [ids.vendor, config.vendorEmail, "Demo Vendor User", false],
      [ids.driver, config.driverEmail, "Demo Driver User", false],
      [ids.client, config.clientEmail, "Demo Client User", false],
      [
        ids.support,
        "demo.support@logistics.test",
        "Demo Regional Support",
        false,
      ],
      [
        ids.analyst,
        "demo.analyst@logistics.test",
        "Demo Control Analyst",
        false,
      ],
      [
        ids.auditor,
        "demo.auditor@logistics.test",
        "Demo Internal Auditor",
        false,
      ],
    ],
    statements,
    contentHash: DEMO_CONTENT_HASH,
    showcaseManifest: DEMO_SHOWCASE_MANIFEST,
    knownRowPrefix: "11000000-0000-4000-8000-",
    bankAccountHolder: "Demo Fleet Services",
    bankVersionId: "10000000-0000-4000-8000-000000000701",
    bankVendorId: "10000000-0000-4000-8000-000000000700",
    passwordVariable: "DEMO_USER_PASSWORD",
    rotateVariable: "DEMO_ROTATE_PASSWORD",
    rotationAuditAction: "demo.credentials.rotated",
    rotationReason:
      "Explicit DEMO_ROTATE_PASSWORD rotation with tenant session revocation",
  };
}

export async function seedDemoData(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrl?: string,
) {
  const config = demoSeedConfig(env);
  return seedDemoProfile(demoBootstrapProfile(config), config, databaseUrl);
}

export async function seedDemoProfile(
  profile: DemoBootstrapProfile,
  config: DemoSeedConfig,
  databaseUrl?: string,
) {
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
  const { ids, users } = profile;
  const tenantId = profile.tenantId;
  const anchorTime = profile.anchorTime;
  const profileAnchorDateSql = `'${profile.anchorDate}'::date`;
  const profileAnchorTimeSql = `'${profile.anchorTime.toISOString()}'::timestamptz`;

  try {
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.platform_context','on',true)",
        );
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          profile.lockKey,
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
        const existingTenant = await tx.$queryRawUnsafe<
          Array<{ id: string; name: string; legal_name: string }>
        >(
          "SELECT id::text,name,legal_name FROM app.tenants WHERE code=$1",
          profile.tenantCode,
        );
        assertDemoProfileTenantCollision(profile, existingTenant[0]);
        if (profile.adoptExistingTenant && existingTenant[0]) {
          const [adoptionState] = await tx.$queryRaw<
            Array<{ dependentRowCount: number }>
          >`
            SELECT (
              (SELECT count(*) FROM app.legal_entities WHERE tenant_id=${tenantId}::uuid) +
              (SELECT count(*) FROM app.authorization_scope_nodes WHERE tenant_id=${tenantId}::uuid) +
              (SELECT count(*) FROM app.organization_nodes WHERE tenant_id=${tenantId}::uuid) +
              (SELECT count(*) FROM app.tenant_memberships WHERE tenant_id=${tenantId}::uuid)
            )::int "dependentRowCount"
          `;
          assertDemoProfileAdoptionState(
            profile,
            adoptionState?.dependentRowCount ?? -1,
          );
        }

        let rotated = false;
        let revokedSessionCount = 0;
        let rotationAudited = false;
        for (const [id, email] of users) {
          const existing = await tx.$queryRaw<
            Array<{ id: string; password_hash: string }>
          >`
            SELECT id::text,password_hash FROM app.users WHERE email=${email}
          `;
          assertDemoProfileIdentityCollision(
            profile,
            email,
            id,
            existing[0]?.id,
          );
          if (
            existing[0] &&
            !(await argon2.verify(existing[0].password_hash, config.password))
          ) {
            if (!config.rotatePassword) {
              throw new Error(
                `Configured ${profile.passwordVariable} does not match existing ${profile.tenantCode} identity ${email}. Reuse the original password or set ${profile.rotateVariable}=true to rotate the profile users and revoke their sessions.`,
              );
            }
            rotated = true;
          }
        }
        if (rotated) {
          await tx.$executeRaw`
            UPDATE app.users SET password_hash=${passwordHash},auth_version=auth_version+1,
              credentials_changed_at=transaction_timestamp(),updated_at=transaction_timestamp(),version=version+1
            WHERE id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid,${ids.support}::uuid,${ids.analyst}::uuid,${ids.auditor}::uuid)
          `;
          const revoked = await tx.$queryRaw<Array<{ count: number }>>`
            WITH affected AS (
              UPDATE app.sessions SET revoked_at=transaction_timestamp(),
                revoked_reason=${`${profile.tenantCode}_PASSWORD_ROTATED`},updated_at=transaction_timestamp(),version=version+1
              WHERE user_id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid,${ids.support}::uuid,${ids.analyst}::uuid,${ids.auditor}::uuid)
                AND revoked_at IS NULL
              RETURNING id
            ) SELECT count(*)::int count FROM affected
          `;
          revokedSessionCount = revoked[0]?.count ?? 0;
        }
        const auditRotation = async () => {
          if (!rotated || rotationAudited) return;
          const after = JSON.stringify({
            dataset: profile.dataset,
            datasetVersion: profile.datasetVersion,
            affectedUserCount: users.length,
            revokedSessionCount,
            sessionsRevoked: revokedSessionCount > 0,
          });
          await tx.$executeRaw`
            INSERT INTO audit.audit_events(
              tenant_id,actor_id,action,target_type,target_id,source,after_json,reason,correlation_id
            ) VALUES(
              ${tenantId}::uuid,${platformAdminId}::uuid,${profile.rotationAuditAction},
              'demo_bootstrap',${tenantId}::uuid,'BOOTSTRAP',${after}::jsonb,
              ${profile.rotationReason},
              ${`${profile.tenantCode.toLowerCase()}-bootstrap-password-rotation:${profile.datasetVersion}`}
            )
          `;
          rotationAudited = true;
        };

        if (existingTenant[0]) {
          const markers = await tx.$queryRaw<Array<{ content_hash: string }>>`
            SELECT content_hash::text FROM app.demo_bootstrap_runs
            WHERE tenant_id=${tenantId}::uuid AND dataset=${profile.dataset}
              AND dataset_version=${profile.datasetVersion}
            FOR UPDATE
          `;
          if (markers[0] && markers[0].content_hash !== profile.contentHash) {
            throw new Error(
              `${profile.tenantCode} dataset ${profile.datasetVersion} already exists with a different content hash. Bump the dataset version before changing seeded content.`,
            );
          }
          if (markers[0]) {
            const count = await tx.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int count FROM app.users
              WHERE id IN (${ids.owner}::uuid,${ids.operations}::uuid,${ids.finance}::uuid,${ids.vendor}::uuid,${ids.driver}::uuid,${ids.client}::uuid,${ids.support}::uuid,${ids.analyst}::uuid,${ids.auditor}::uuid)
            `;
            if (count[0]?.count !== users.length) {
              throw new Error(
                `${profile.tenantCode} bootstrap marker exists but one or more configured identities are missing.`,
              );
            }
            await auditRotation();
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
          if (!actual[0]) {
            throw new Error(
              `Configured ${profile.tenantCode} identity ${email} was not materialized.`,
            );
          }
          assertDemoProfileIdentityCollision(profile, email, id, actual[0]?.id);
        }
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.actor_user_id',$1,true)",
          platformAdminId,
        );
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.correlation_id',$1,true)",
          `${profile.tenantCode.toLowerCase()}-bootstrap`,
        );
        for (const [
          statementIndex,
          statement,
        ] of profile.statements.entries()) {
          const anchored = statement
            .replaceAll(ids.platform, platformAdminId)
            .replaceAll("current_date", profileAnchorDateSql)
            .replaceAll("now()", profileAnchorTimeSql);
          try {
            await tx.$executeRawUnsafe(anchored);
          } catch (error) {
            const target =
              statement.match(/^(?:INSERT INTO|UPDATE)\s+([^\s(]+)/)?.[1] ??
              "unknown";
            throw new Error(
              `${profile.tenantCode} bootstrap statement ${statementIndex + 1} (${target}) failed`,
              { cause: error },
            );
          }
          if (statement.startsWith("INSERT INTO app.vendors(")) {
            await tx.$executeRaw`
              INSERT INTO app.vendor_bank_versions(id,tenant_id,vendor_id,version,account_holder,account_ciphertext,account_last4,ifsc,state,maker_id,checker_id,verified_at)
              VALUES(${profile.bankVersionId}::uuid,${tenantId}::uuid,${profile.bankVendorId}::uuid,1,${profile.bankAccountHolder},${bankEnvelope},'0001','HDFC0000001','VERIFIED',${ids.owner}::uuid,${ids.finance}::uuid,${anchorTime}-interval '20 days')
              ON CONFLICT(tenant_id,vendor_id,version) DO NOTHING
            `;
          }
        }
        const [showcaseCounts] = await tx.$queryRaw<
          Array<Record<ShowcaseCountKey, number>>
        >`
          SELECT
            (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=${tenantId}::uuid AND node_type='REGION') "regions",
            (SELECT count(*)::int FROM app.organization_nodes WHERE tenant_id=${tenantId}::uuid AND node_type='BRANCH') "branches",
            (SELECT count(*)::int FROM app.employees e JOIN app.tenant_memberships m ON m.tenant_id=e.tenant_id AND m.id=e.linked_membership_id WHERE e.tenant_id=${tenantId}::uuid AND m.portal_audience='INTERNAL') "internalEmployees",
            (SELECT count(*)::int FROM app.clients WHERE tenant_id=${tenantId}::uuid) "clients",
            (SELECT count(*)::int FROM app.client_locations WHERE tenant_id=${tenantId}::uuid) "clientLocations",
            (SELECT count(*)::int FROM app.vendors WHERE tenant_id=${tenantId}::uuid) "vendors",
            (SELECT count(*)::int FROM app.vendors WHERE tenant_id=${tenantId}::uuid AND state='ACTIVE') "activeVendors",
            (SELECT count(*)::int FROM app.vehicles WHERE tenant_id=${tenantId}::uuid) "vehicles",
            (SELECT count(*)::int FROM app.drivers WHERE tenant_id=${tenantId}::uuid) "drivers",
            (SELECT count(*)::int FROM app.indents WHERE tenant_id=${tenantId}::uuid) "indents",
            (SELECT count(*)::int FROM app.allocations WHERE tenant_id=${tenantId}::uuid) "allocations",
            (SELECT count(*)::int FROM app.trips WHERE tenant_id=${tenantId}::uuid) "trips",
            (SELECT count(*)::int FROM app.pod_tasks WHERE tenant_id=${tenantId}::uuid) "podTasks",
            (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id=${tenantId}::uuid) "clientInvoices",
            (SELECT count(*)::int FROM app.receipts WHERE tenant_id=${tenantId}::uuid) "receipts",
            (SELECT count(*)::int FROM app.vendor_bills WHERE tenant_id=${tenantId}::uuid) "vendorBills",
            (SELECT count(*)::int FROM app.payment_batches WHERE tenant_id=${tenantId}::uuid) "paymentBatches",
            (SELECT count(*)::int FROM app.operational_alerts WHERE tenant_id=${tenantId}::uuid) "alerts",
            (SELECT count(*)::int FROM app.contract_lanes WHERE tenant_id=${tenantId}::uuid) "lanes",
            (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id=${tenantId}::uuid AND effective_from<=${anchorTime} AND (effective_to IS NULL OR effective_to>${anchorTime})) "currentCommercialExamples",
            (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id=${tenantId}::uuid AND effective_to<=${anchorTime}) "expiredCommercialExamples",
            (SELECT count(*)::int FROM app.client_rate_lines WHERE tenant_id=${tenantId}::uuid AND effective_from>${anchorTime}) "upcomingCommercialExamples",
            (SELECT count(*)::int FROM app.indents WHERE tenant_id=${tenantId}::uuid AND state IN ('OPEN','PARTIALLY_ALLOCATED')) "placementLensRows",
            (SELECT count(*)::int FROM app.pod_tasks WHERE tenant_id=${tenantId}::uuid) "podLensRows",
            (SELECT count(*)::int FROM app.client_invoices WHERE tenant_id=${tenantId}::uuid) "collectionLensRows",
            (SELECT count(*)::int FROM app.trips WHERE tenant_id=${tenantId}::uuid) "tripLensRows",
            (SELECT count(*)::int FROM app.vendor_bills WHERE tenant_id=${tenantId}::uuid) "vendorPayableLensRows",
            (SELECT count(DISTINCT client_id)::int FROM app.indents WHERE tenant_id=${tenantId}::uuid AND state IN ('OPEN','PARTIALLY_ALLOCATED')) "placementPortfolios",
            (SELECT count(DISTINCT i.client_id)::int FROM app.pod_tasks p JOIN app.trips t ON t.tenant_id=p.tenant_id AND t.id=p.trip_id JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE p.tenant_id=${tenantId}::uuid) "podPortfolios",
            (SELECT count(DISTINCT client_id)::int FROM app.client_invoices WHERE tenant_id=${tenantId}::uuid) "collectionPortfolios",
            (SELECT count(DISTINCT i.client_id)::int FROM app.trips t JOIN app.allocations a ON a.tenant_id=t.tenant_id AND a.id=t.allocation_id JOIN app.indents i ON i.tenant_id=a.tenant_id AND i.id=a.indent_id WHERE t.tenant_id=${tenantId}::uuid) "tripPortfolios",
            (SELECT count(DISTINCT vendor_id)::int FROM app.vendor_bills WHERE tenant_id=${tenantId}::uuid) "vendorPayablePortfolios",
            (SELECT count(*)::int FROM app.tenant_configuration WHERE tenant_id=${tenantId}::uuid AND namespace='notifications' AND value->>'suppressOutbound'='true' AND value->>'syntheticDestinationsOnly'='true') "notificationSuppression"
        `;
        if (!showcaseCounts)
          throw new Error("Demo showcase reconciliation returned no counts.");
        validateDemoShowcaseCountsFor(profile.showcaseManifest, showcaseCounts);
        const [integrity] = await tx.$queryRaw<
          Array<{
            financialMismatchCount: number;
            invalidQuantityCount: number;
            foreignTenantRowCount: number;
          }>
        >`
          SELECT
            ((SELECT count(*) FROM app.client_invoices WHERE tenant_id=${tenantId}::uuid AND total_minor<>taxable_minor+tax_minor)
              +(SELECT count(*) FROM app.vendor_bills WHERE tenant_id=${tenantId}::uuid AND payable_minor<>taxable_minor+gst_minor-tds_minor-deduction_minor-advance_minor))::int "financialMismatchCount",
            ((SELECT count(*) FROM app.indents WHERE tenant_id=${tenantId}::uuid AND (requested_vehicles<=0 OR quantity_milli<=0))
              +(SELECT count(*) FROM app.allocations WHERE tenant_id=${tenantId}::uuid AND allotted_vehicles<=0))::int "invalidQuantityCount",
            (SELECT count(*)::int FROM (
              SELECT tenant_id FROM app.clients WHERE id::text LIKE ${`${profile.knownRowPrefix}%`}
              UNION ALL SELECT tenant_id FROM app.indents WHERE id::text LIKE ${`${profile.knownRowPrefix}%`}
              UNION ALL SELECT tenant_id FROM app.client_invoices WHERE id::text LIKE ${`${profile.knownRowPrefix}%`}
              UNION ALL SELECT tenant_id FROM app.vendor_bills WHERE id::text LIKE ${`${profile.knownRowPrefix}%`}
            ) known_demo_rows WHERE tenant_id<>${tenantId}::uuid) "foreignTenantRowCount"
        `;
        if (
          !integrity ||
          Object.values(integrity).some((count) => count !== 0)
        ) {
          throw new Error(
            `Demo showcase integrity reconciliation failed: ${JSON.stringify(integrity ?? {})}.`,
          );
        }
        const summary = JSON.stringify({
          tenantCode: profile.tenantCode,
          manifest: profile.showcaseManifest,
        });
        await tx.$executeRaw`
          INSERT INTO app.demo_bootstrap_runs(tenant_id,dataset,dataset_version,content_hash,anchor_date,summary)
          VALUES(${tenantId}::uuid,${profile.dataset},${profile.datasetVersion},${profile.contentHash},${profile.anchorDate}::date,
            ${summary}::jsonb)
          ON CONFLICT(tenant_id,dataset,dataset_version) DO NOTHING
        `;
        await auditRotation();
        return { replayed: false, rotated };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    console.log(
      result.replayed
        ? `${profile.displayName} ${profile.tenantCode} already matches ${profile.datasetVersion}; no data changes were required${result.rotated ? " after explicit password rotation" : ""}.`
        : `${profile.displayName} ${profile.tenantCode} is ready with ${users.length} protected profile users.`,
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
