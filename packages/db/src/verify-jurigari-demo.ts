import { pathToFileURL } from "node:url";
import { createDatabase, withPlatform } from "./index.js";
import {
  JURIGARI_DATASET,
  JURIGARI_DATASET_VERSION,
  JURIGARI_EXEMPLAR,
  JURIGARI_TENANT_ID,
  jurigariContentHash,
} from "./jurigari-demo-profile.js";

export async function verifyJurigariDemo(databaseUrl?: string) {
  const db = createDatabase(databaseUrl);
  try {
    const tenants = await withPlatform(
      db,
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            legalEntityId: string;
            rootOrganizationId: string;
            tenantScopeId: string;
            legalScopeId: string;
            ownerMembershipId: string;
          }>
        >`
        SELECT tenant.id::text id,
          (SELECT id::text FROM app.legal_entities WHERE tenant_id=tenant.id AND code='JG' LIMIT 1) "legalEntityId",
          (SELECT id::text FROM app.organization_nodes WHERE tenant_id=tenant.id AND node_type='LEGAL_ENTITY' AND code='JG' LIMIT 1) "rootOrganizationId",
          (SELECT id::text FROM app.authorization_scope_nodes WHERE tenant_id=tenant.id AND scope_type='TENANT' LIMIT 1) "tenantScopeId",
          (SELECT id::text FROM app.authorization_scope_nodes WHERE tenant_id=tenant.id AND scope_type='LEGAL_ENTITY' ORDER BY created_at,id LIMIT 1) "legalScopeId",
          (SELECT id::text FROM app.tenant_memberships WHERE tenant_id=tenant.id AND lower(invited_email)='piyana10@gmail.com' LIMIT 1) "ownerMembershipId"
        FROM app.tenants tenant WHERE code='JG'
      `,
    );
    const tenant = tenants[0];
    const tenantId = tenant?.id;
    if (!tenantId || tenants.length !== 1) {
      throw new Error("Jurigari verification requires exactly one JG tenant");
    }
    if (
      !tenant.legalEntityId ||
      !tenant.rootOrganizationId ||
      !tenant.tenantScopeId ||
      !tenant.legalScopeId ||
      !tenant.ownerMembershipId
    ) {
      throw new Error(
        "Jurigari verification could not resolve the adopted root graph",
      );
    }
    const contentHash =
      tenantId === JURIGARI_TENANT_ID
        ? jurigariContentHash(tenantId)
        : jurigariContentHash(tenantId, {
            tenantId,
            legalEntityId: tenant.legalEntityId,
            rootOrganizationId: tenant.rootOrganizationId,
            tenantScopeId: tenant.tenantScopeId,
            legalScopeId: tenant.legalScopeId,
            ownerMembershipId: tenant.ownerMembershipId,
          });
    const [result] = await withPlatform(db, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          markerCount: number;
          ownerCount: number;
          employeeCount: number;
          chainCount: number;
          taxableMinor: bigint;
          gstMinor: bigint;
          totalMinor: bigint;
          receiptAmountMinor: bigint;
          allocationMinor: bigint;
          deductionMinor: bigint;
          balanceMinor: bigint;
        }>
      >(
        `SELECT
          (SELECT count(*)::int FROM app.demo_bootstrap_runs
           WHERE tenant_id=$1::uuid AND dataset=$2 AND dataset_version=$3 AND content_hash=$4) "markerCount",
          (SELECT count(DISTINCT membership.id)::int FROM app.tenant_memberships membership
           JOIN app.membership_role_assignments assignment ON assignment.tenant_id=membership.tenant_id AND assignment.membership_id=membership.id AND assignment.status='ACTIVE'
           JOIN app.roles role ON role.tenant_id=assignment.tenant_id AND role.id=assignment.role_id AND role.code='TENANT_OWNER'
           WHERE membership.tenant_id=$1::uuid AND membership.status='ACTIVE' AND membership.portal_audience='INTERNAL'
             AND membership.invited_email=ANY(ARRAY['piyana10@gmail.com','siddhartha09@gmail.com'])) "ownerCount",
          (SELECT count(*)::int FROM app.employees employee
           JOIN app.tenant_memberships membership ON membership.tenant_id=employee.tenant_id AND membership.id=employee.linked_membership_id
           WHERE employee.tenant_id=$1::uuid AND employee.state='ACTIVE' AND membership.status='ACTIVE' AND membership.portal_audience='INTERNAL') "employeeCount",
          (SELECT count(*)::int FROM app.indents indent
           JOIN app.clients client ON client.tenant_id=indent.tenant_id AND client.id=indent.client_id AND client.code='TCPL'
           JOIN app.client_locations location ON location.tenant_id=indent.tenant_id AND location.id=indent.client_location_id
           JOIN app.allocations allocation ON allocation.tenant_id=indent.tenant_id AND allocation.indent_id=indent.id
           JOIN app.vendors vendor ON vendor.tenant_id=allocation.tenant_id AND vendor.id=allocation.vendor_id AND vendor.code='VEN-0142'
           JOIN app.trips trip ON trip.tenant_id=allocation.tenant_id AND trip.allocation_id=allocation.id
           JOIN app.vehicles vehicle ON vehicle.tenant_id=trip.tenant_id AND vehicle.id=trip.assigned_vehicle_id
           JOIN app.client_invoices invoice ON invoice.tenant_id=indent.tenant_id AND invoice.invoice_no='INV-26-3427'
           JOIN app.client_invoice_lines line ON line.tenant_id=invoice.tenant_id AND line.invoice_id=invoice.id
           JOIN app.invoice_service_links service ON service.tenant_id=line.tenant_id AND service.invoice_line_id=line.id AND service.trip_id=trip.id
           JOIN app.receipts receipt ON receipt.tenant_id=invoice.tenant_id AND receipt.client_id=invoice.client_id AND receipt.receipt_ref='RCP-2026-0881'
           WHERE indent.tenant_id=$1::uuid AND indent.indent_no='IND-4231' AND location.code='TCPL-KUN'
             AND trip.lr_no='JGL/24118' AND vehicle.registration_number='KA 25 AB 4471') "chainCount",
          (SELECT taxable_minor FROM app.client_invoices WHERE tenant_id=$1::uuid AND invoice_no='INV-26-3427') "taxableMinor",
          (SELECT tax_minor FROM app.client_invoices WHERE tenant_id=$1::uuid AND invoice_no='INV-26-3427') "gstMinor",
          (SELECT total_minor FROM app.client_invoices WHERE tenant_id=$1::uuid AND invoice_no='INV-26-3427') "totalMinor",
          (SELECT amount_minor FROM app.receipts WHERE tenant_id=$1::uuid AND receipt_ref='RCP-2026-0881') "receiptAmountMinor",
          (SELECT amount_minor FROM app.receipt_ledger_entries WHERE tenant_id=$1::uuid AND receipt_id='30000000-0000-4000-8000-000000000921' AND entry_type='ALLOCATION') "allocationMinor",
          (SELECT amount_minor FROM app.receipt_ledger_entries WHERE tenant_id=$1::uuid AND receipt_id='30000000-0000-4000-8000-000000000921' AND entry_type='DEDUCTION') "deductionMinor",
          ((SELECT total_minor FROM app.client_invoices WHERE tenant_id=$1::uuid AND invoice_no='INV-26-3427')-
           (SELECT amount_minor FROM app.receipts WHERE tenant_id=$1::uuid AND receipt_ref='RCP-2026-0881')) "balanceMinor"`,
        tenantId,
        JURIGARI_DATASET,
        JURIGARI_DATASET_VERSION,
        contentHash,
      ),
    );
    if (!result) throw new Error("Jurigari verification returned no result");
    const expected = {
      markerCount: 1,
      ownerCount: 2,
      employeeCount: 2,
      chainCount: 1,
      taxableMinor: BigInt(JURIGARI_EXEMPLAR.invoiceTaxableMinor),
      gstMinor: BigInt(JURIGARI_EXEMPLAR.invoiceGstMinor),
      totalMinor: BigInt(JURIGARI_EXEMPLAR.invoiceTotalMinor),
      receiptAmountMinor: BigInt(JURIGARI_EXEMPLAR.receiptAmountMinor),
      allocationMinor: BigInt(
        JURIGARI_EXEMPLAR.receiptAmountMinor - JURIGARI_EXEMPLAR.deductionMinor,
      ),
      deductionMinor: BigInt(JURIGARI_EXEMPLAR.deductionMinor),
      balanceMinor: BigInt(JURIGARI_EXEMPLAR.balanceMinor),
    };
    for (const [key, value] of Object.entries(expected)) {
      if (result[key as keyof typeof result] !== value) {
        throw new Error(
          `Jurigari verification failed for ${key}: expected ${String(value)}, received ${String(result[key as keyof typeof result])}`,
        );
      }
    }
    const summary = {
      tenantCode: "JG",
      datasetVersion: JURIGARI_DATASET_VERSION,
      owners: result.ownerCount,
      employees: result.employeeCount,
      workbookChain: result.chainCount,
      financeReconciled:
        result.totalMinor === result.taxableMinor + result.gstMinor,
      receiptReconciled:
        result.receiptAmountMinor ===
        result.allocationMinor + result.deductionMinor,
    };
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyJurigariDemo();
}
