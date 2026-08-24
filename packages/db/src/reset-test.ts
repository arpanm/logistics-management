import { createDatabase } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/logistics_test(?:\?|$)/.test(url))
  throw new Error(
    "Refusing reset: TEST_DATABASE_URL must target logistics_test",
  );
const db = createDatabase(url);
try {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE audit.audit_events, reporting.tenant_activity_projection, app.login_attempts, app.platform_alerts, app.job_runs, app.outbox_events, app.idempotency_records, app.stored_documents, app.tenant_probe_records, app.setup_checklist_items, app.tenant_configuration, app.owner_invitations, app.tenant_memberships, app.legal_entities, app.sessions, app.tenants, app.users RESTART IDENTITY CASCADE`,
  );
  console.log("Reset only logistics_test application schemas");
} finally {
  await db.$disconnect();
}
