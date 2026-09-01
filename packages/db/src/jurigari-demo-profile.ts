import { createHash } from "node:crypto";
import {
  DEMO_IDS,
  DEMO_SHOWCASE_MANIFEST,
  DEMO_SQL_STATEMENTS,
  DEMO_TENANT_ID,
  type DemoBootstrapIds,
  type DemoBootstrapProfile,
} from "./demo-seed.js";
import type { JurigariSeedConfig } from "./jurigari-demo-config.js";

export const JURIGARI_DATASET = "jurigari-production-demo";
export const JURIGARI_DATASET_VERSION = "2026.09.2";
export const JURIGARI_ANCHOR_DATE = "2026-08-31";
export const JURIGARI_TENANT_ID = "30000000-0000-4000-8000-000000000100";

export const JURIGARI_IDS: DemoBootstrapIds = {
  platform: "30000000-0000-4000-8000-000000000001",
  owner: "30000000-0000-4000-8000-000000000002",
  operations: "30000000-0000-4000-8000-000000000003",
  finance: "30000000-0000-4000-8000-000000000003",
  vendor: "30000000-0000-4000-8000-000000000003",
  driver: "30000000-0000-4000-8000-000000000003",
  client: "30000000-0000-4000-8000-000000000002",
  support: "30000000-0000-4000-8000-000000000003",
  analyst: "30000000-0000-4000-8000-000000000003",
  auditor: "30000000-0000-4000-8000-000000000002",
};

export const JURIGARI_EXEMPLAR = {
  clientCode: "TCPL",
  locationCode: "TCPL-KUN",
  vendorCode: "VEN-0142",
  indentNo: "IND-4231",
  vehicleRegistration: "KA 25 AB 4471",
  lrNo: "JGL/24118",
  invoiceNo: "INV-26-3427",
  invoiceTaxableMinor: 28_400_000,
  invoiceGstMinor: 1_420_000,
  invoiceTotalMinor: 29_820_000,
  receiptRef: "RCP-2026-0881",
  receiptAmountMinor: 15_000_000,
  deductionMinor: 840_000,
  balanceMinor: 14_820_000,
} as const;

const membershipIds = {
  piyana: "30000000-0000-4000-8000-000000000401",
  siddhartha: "30000000-0000-4000-8000-000000000402",
} as const;

function replaceSharedIds(statement: string, tenantId = JURIGARI_TENANT_ID) {
  let transformed = statement
    .replaceAll("11000000-0000-4000-8000-", "31000000-0000-4000-8000-")
    .replaceAll(DEMO_TENANT_ID, tenantId);
  for (const key of Object.keys(DEMO_IDS) as Array<keyof typeof DEMO_IDS>) {
    transformed = transformed.replaceAll(DEMO_IDS[key], JURIGARI_IDS[key]);
  }
  const demoMemberships = [
    "10000000-0000-4000-8000-000000000401",
    "10000000-0000-4000-8000-000000000402",
    "10000000-0000-4000-8000-000000000403",
    "10000000-0000-4000-8000-000000000404",
    "10000000-0000-4000-8000-000000000405",
    "10000000-0000-4000-8000-000000000406",
    "10000000-0000-4000-8000-000000000407",
    "10000000-0000-4000-8000-000000000408",
    "10000000-0000-4000-8000-000000000409",
  ];
  demoMemberships.forEach((id, index) => {
    transformed = transformed.replaceAll(
      id,
      index === 0 ? membershipIds.piyana : membershipIds.siddhartha,
    );
  });
  return transformed
    .replaceAll("10000000-0000-4000-8000-", "30000000-0000-4000-8000-")
    .replaceAll("Demo Logistics India Private Limited", "Jurigari Pvt Limited")
    .replaceAll("Demo Logistics India", "Jurigari Pvt Limited")
    .replaceAll("Demo Logistics", "Jurigari")
    .replaceAll("DEMO", "JG")
    .replaceAll("Demo", "Jurigari")
    .replaceAll("demo", "jurigari");
}

const membershipStatement = `INSERT INTO app.tenant_memberships(
  id,tenant_id,user_id,invited_name,invited_email,employee_code,role,portal_audience,status
) VALUES
  ('${membershipIds.piyana}','${JURIGARI_TENANT_ID}','${JURIGARI_IDS.owner}','Piyana Bandyopadhyay','piyana10@gmail.com','JG-PIYANA','TENANT_OWNER','INTERNAL','ACTIVE'),
  ('${membershipIds.siddhartha}','${JURIGARI_TENANT_ID}','${JURIGARI_IDS.operations}','Siddhartha','siddhartha09@gmail.com','JG-SIDDHARTHA','TENANT_OWNER','INTERNAL','ACTIVE')
ON CONFLICT(tenant_id,invited_email) DO UPDATE SET
  user_id=excluded.user_id,invited_name=excluded.invited_name,employee_code=excluded.employee_code,
  role='TENANT_OWNER',portal_audience='INTERNAL',status='ACTIVE',updated_at=now()`;

const assignmentStatement = `INSERT INTO app.membership_role_assignments(tenant_id,membership_id,role_id,status)
SELECT '${JURIGARI_TENANT_ID}',membership.id,role.id,'ACTIVE'
FROM app.tenant_memberships membership
JOIN app.roles role ON role.tenant_id=membership.tenant_id AND role.code='TENANT_OWNER'
WHERE membership.tenant_id='${JURIGARI_TENANT_ID}'
  AND membership.id IN ('${membershipIds.piyana}','${membershipIds.siddhartha}')
ON CONFLICT(tenant_id,membership_id,role_id) DO UPDATE SET
  status='ACTIVE',effective_to=null,updated_at=now()`;

const grantStatement = `INSERT INTO app.scope_grants(tenant_id,assignment_id,scope_node_id,action,status)
SELECT '${JURIGARI_TENANT_ID}',assignment.id,'30000000-0000-4000-8000-000000000200','ADMIN','ACTIVE'
FROM app.membership_role_assignments assignment
WHERE assignment.tenant_id='${JURIGARI_TENANT_ID}'
  AND assignment.membership_id IN ('${membershipIds.piyana}','${membershipIds.siddhartha}')
ON CONFLICT(tenant_id,assignment_id,scope_node_id,action) DO UPDATE SET
  status='ACTIVE',effective_to=null,updated_at=now()`;

const employeeStatement = `INSERT INTO app.employees(
  id,tenant_id,employee_code,display_name,email,home_node_id,linked_membership_id,active_from,state,created_by
) VALUES
  ('30000000-0000-4000-8000-000000000451','${JURIGARI_TENANT_ID}','JG-PIYANA','Piyana Bandyopadhyay','piyana10@gmail.com','30000000-0000-4000-8000-000000000301','${membershipIds.piyana}',current_date,'ACTIVE','${JURIGARI_IDS.owner}'),
  ('30000000-0000-4000-8000-000000000452','${JURIGARI_TENANT_ID}','JG-SIDDHARTHA','Siddhartha','siddhartha09@gmail.com','30000000-0000-4000-8000-000000000301','${membershipIds.siddhartha}',current_date,'ACTIVE','${JURIGARI_IDS.operations}')
ON CONFLICT(tenant_id,employee_code) DO UPDATE SET
  display_name=excluded.display_name,email=excluded.email,home_node_id=excluded.home_node_id,
  linked_membership_id=excluded.linked_membership_id,active_to=null,state='ACTIVE',updated_at=now(),version=employees.version+1`;

const exemplarStatements = [
  `UPDATE app.tenants SET name='Jurigari Pvt Limited',legal_name='Jurigari Pvt Limited',
     tax_identifier='36AAGCJ7322K1ZC',
     address='{"line1":"Alt.F CoWorking Space, 3rd floor-305","line2":"Begumpet","city":"Hyderabad","region":"Telangana","postalCode":"500016","country":"IN","website":"https://jurigari.com"}'::jsonb,
     timezone='Asia/Kolkata',locale='en-IN',currency='INR',support_name='Piyana Bandyopadhyay',
     support_email='admin@jurigari.com',support_mobile='+917766974950',short_name='Jurigari',
     primary_color='#16324f',accent_color='#d97706',status='ACTIVE',updated_at=now()
   WHERE id='${JURIGARI_TENANT_ID}'`,
  `UPDATE app.legal_entities SET code='JG',name='Jurigari Pvt Limited',tax_identifier='36AAGCJ7322K1ZC',is_default=true,status='ACTIVE',updated_at=now()
   WHERE tenant_id='${JURIGARI_TENANT_ID}' AND id='30000000-0000-4000-8000-000000000300'`,
  `INSERT INTO app.receipt_ledger_entries(id,tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reason,actor_id)
   VALUES('30000000-0000-4000-8000-000000000923','${JURIGARI_TENANT_ID}','30000000-0000-4000-8000-000000000921','30000000-0000-4000-8000-000000000901','DEDUCTION',840000,'Jurigari workbook deduction','${JURIGARI_IDS.operations}')
   ON CONFLICT(tenant_id,id) DO NOTHING`,
  `INSERT INTO app.tenant_configuration(tenant_id,namespace,schema_version,value)
   VALUES('${JURIGARI_TENANT_ID}','jurigari-demo-profile',1,
     '{"website":"https://jurigari.com","workbookExemplar":{"client":"TCPL","location":"TCPL-KUN","vendor":"VEN-0142","indent":"IND-4231","vehicle":"KA 25 AB 4471","lr":"JGL/24118","invoice":"INV-26-3427","taxableMinor":28400000,"gstMinor":1420000,"totalMinor":29820000,"receipt":"RCP-2026-0881","receiptAmountMinor":15000000,"deductionMinor":840000,"balanceMinor":14820000}}'::jsonb)
   ON CONFLICT(tenant_id,namespace) DO UPDATE SET value=excluded.value,updated_at=now(),version=tenant_configuration.version+1`,
] as const;

export function jurigariStatements(
  tenantId = JURIGARI_TENANT_ID,
  adoption?: JurigariSeedConfig["adoption"],
) {
  const transformed = DEMO_SQL_STATEMENTS.flatMap((statement) => {
    if (statement.startsWith("INSERT INTO app.tenant_memberships(")) {
      return membershipStatement;
    }
    if (statement.startsWith("INSERT INTO app.membership_role_assignments(")) {
      return assignmentStatement;
    }
    if (statement.startsWith("INSERT INTO app.scope_grants(")) {
      return grantStatement;
    }
    if (statement.startsWith("INSERT INTO app.transport_reference_masters(")) {
      return [employeeStatement, replaceSharedIds(statement)];
    }
    if (
      statement.startsWith(
        "INSERT INTO app.receipt_ledger_entries(id,tenant_id,receipt_id,invoice_id,entry_type,amount_minor,reason,actor_id) VALUES",
      )
    ) {
      return replaceSharedIds(statement, tenantId)
        .replace("'ALLOCATION',600000", "'ALLOCATION',14160000")
        .replace(
          "Jurigari partial client receipt",
          "Jurigari workbook receipt allocation net of deduction",
        );
    }
    if (
      statement.startsWith("INSERT INTO reporting.tenant_activity_projection")
    ) {
      return `INSERT INTO reporting.tenant_activity_projection(tenant_id,last_activity_at,user_count,config_count,event_count,refreshed_at)
        VALUES('${JURIGARI_TENANT_ID}',now(),2,5,3,now())
        ON CONFLICT(tenant_id) DO UPDATE SET last_activity_at=now(),user_count=2,config_count=5,event_count=3,refreshed_at=now(),updated_at=now()`;
    }
    let result = replaceSharedIds(statement, tenantId);
    if (statement.startsWith("INSERT INTO app.drivers(")) {
      result = result.replace(
        `'${membershipIds.siddhartha}','ACTIVE')`,
        `null,'ACTIVE')`,
      );
    }
    if (statement.startsWith("INSERT INTO app.clients(")) {
      result = result
        .replace(
          "'JG-RETAIL','Jurigari Retail India Limited'",
          "'TCPL','Tata Consumer Products Ltd'",
        )
        .replace(",30,'DIGITAL','ACTIVE')", ",45,'PORTAL','ACTIVE')")
        .replace(
          "credit_days=30,pod_mode='DIGITAL'",
          "credit_days=excluded.credit_days,pod_mode=excluded.pod_mode",
        );
    }
    if (statement.startsWith("INSERT INTO app.client_locations(")) {
      result = result.replace(
        "'BLR-DC','Bengaluru Distribution Centre'",
        "'TCPL-KUN','TCPL Kunigal'",
      );
    }
    if (statement.startsWith("INSERT INTO app.vendors(")) {
      result = result.replace(
        "'JG-FLEET','Jurigari Fleet Services Private Limited'",
        "'VEN-0142','Sahil Roadlines'",
      );
    }
    if (statement.startsWith("INSERT INTO app.vehicles(")) {
      result = result.replace("'KA01JG01'", "'KA 25 AB 4471'");
    }
    if (statement.startsWith("INSERT INTO app.indents(")) {
      result = result
        .replace("'JG-IND-DELIVERED'", "'IND-4231'")
        .replace("'JG-DELIVERED'", "'JURIGARI-WORKBOOK-IND-4231'");
    }
    if (statement.startsWith("INSERT INTO app.trips(")) {
      result = result.replace(
        "'JG-TRIP-DONE','JG-LR-DONE'",
        "'JG-TRIP-24118','JGL/24118'",
      );
    }
    if (statement.startsWith("INSERT INTO app.pod_tasks(")) {
      result = result.replace(
        ",1180000,false,'CLOSED'",
        ",29820000,false,'CLOSED'",
      );
    }
    if (statement.startsWith("INSERT INTO app.client_invoices(")) {
      result = result
        .replace("'JG-INV-POSTED'", "'INV-26-3427'")
        .replace(
          "'30000000-0000-4000-8000-000000000602',current_date-3,'INR',30,1000000,180000,1180000",
          "'30000000-0000-4000-8000-000000000601',current_date-3,'INR',45,28400000,1420000,29820000",
        );
    }
    if (statement.startsWith("INSERT INTO app.client_invoice_lines(")) {
      result = result.replace(
        '\'FREIGHT\',1000,1000000,1000000,1800,180000,1180000,\'{"basis":"PER_TRIP","lane":"BLR-HYD"}\'::jsonb',
        '\'FREIGHT\',1000,28400000,28400000,500,1420000,29820000,\'{"source":"Jurigari workbook","indentNo":"IND-4231","lrNo":"JGL/24118"}\'::jsonb',
      );
    }
    if (statement.startsWith("INSERT INTO app.pod_invoice_links(")) {
      result = result.replace(
        "'JG-INV-POSTED',current_date-3,1180000",
        "'INV-26-3427',current_date-3,29820000",
      );
    }
    if (statement.startsWith("INSERT INTO app.receipts(")) {
      result = result.replace(
        "'JG-RCPT-001','30000000-0000-4000-8000-000000000600',current_date-1,600000,'NEFT','JG-NEFT-001','JG-BANK-REF-001'",
        "'RCP-2026-0881','30000000-0000-4000-8000-000000000600',current_date-1,15000000,'NEFT','JG-NEFT-2026-0881','JG-BANK-2026-0881'",
      );
    }
    return result;
  });
  return [...transformed, ...exemplarStatements].map((statement) => {
    let remapped = statement.replaceAll(JURIGARI_TENANT_ID, tenantId);
    if (adoption) {
      remapped = remapped
        .replaceAll(
          "30000000-0000-4000-8000-000000000300",
          adoption.legalEntityId,
        )
        .replaceAll(
          "30000000-0000-4000-8000-000000000301",
          adoption.rootOrganizationId,
        )
        .replaceAll(
          "30000000-0000-4000-8000-000000000200",
          adoption.tenantScopeId,
        )
        .replaceAll(
          "30000000-0000-4000-8000-000000000201",
          adoption.legalScopeId,
        )
        .replaceAll(membershipIds.piyana, adoption.ownerMembershipId)
        .replace("'LEGAL_ENTITY','ORG-JG'", "'LEGAL_ENTITY','JG'");
    }
    return remapped;
  });
}

export const JURIGARI_SHOWCASE_MANIFEST = {
  ...DEMO_SHOWCASE_MANIFEST,
  internalEmployees: 2,
} as const;

export function jurigariContentHash(
  tenantId = JURIGARI_TENANT_ID,
  adoption?: JurigariSeedConfig["adoption"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        dataset: JURIGARI_DATASET,
        version: JURIGARI_DATASET_VERSION,
        anchor: JURIGARI_ANCHOR_DATE,
        statements: jurigariStatements(tenantId, adoption),
        users: [JURIGARI_IDS.owner, JURIGARI_IDS.operations],
      }),
    )
    .digest("hex");
}

export const JURIGARI_CONTENT_HASH = jurigariContentHash();

export function jurigariBootstrapProfile(
  config: JurigariSeedConfig,
): DemoBootstrapProfile {
  const tenantId = config.adoption?.tenantId ?? JURIGARI_TENANT_ID;
  const statements = jurigariStatements(tenantId, config.adoption);
  return {
    dataset: JURIGARI_DATASET,
    datasetVersion: JURIGARI_DATASET_VERSION,
    anchorDate: JURIGARI_ANCHOR_DATE,
    anchorTime: new Date("2026-08-31T12:00:00+05:30"),
    tenantId,
    tenantCode: "JG",
    displayName: "Jurigari demo tenant",
    lockKey: "logistics:jurigari-demo-seed",
    ids: JURIGARI_IDS,
    users: [
      [
        JURIGARI_IDS.owner,
        config.tenantOwnerEmail,
        "Piyana Bandyopadhyay",
        false,
      ],
      [JURIGARI_IDS.operations, config.operationsEmail, "Siddhartha", false],
    ],
    statements,
    contentHash: jurigariContentHash(tenantId, config.adoption),
    showcaseManifest: JURIGARI_SHOWCASE_MANIFEST,
    knownRowPrefix: "31000000-0000-4000-8000-",
    bankAccountHolder: "Sahil Roadlines",
    bankVersionId: "30000000-0000-4000-8000-000000000701",
    bankVendorId: "30000000-0000-4000-8000-000000000700",
    passwordVariable: "JURIGARI_USER_PASSWORD",
    rotateVariable: "JURIGARI_ROTATE_PASSWORD",
    rotationAuditAction: "jurigari.credentials.rotated",
    rotationReason:
      "Explicit JURIGARI_ROTATE_PASSWORD rotation with tenant session revocation",
    adoptExistingTenant: config.adoption
      ? {
          id: config.adoption.tenantId,
          allowedNames: ["Juri Gari", "Jurigari", "Jurigari Pvt Limited"],
          legalEntityId: config.adoption.legalEntityId,
          rootOrganizationId: config.adoption.rootOrganizationId,
          tenantScopeId: config.adoption.tenantScopeId,
          legalScopeId: config.adoption.legalScopeId,
          ownerMembershipId: config.adoption.ownerMembershipId,
        }
      : undefined,
  };
}
