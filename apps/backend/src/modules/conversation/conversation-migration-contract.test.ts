import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../../packages/db/prisma/migrations/202609040004_int02_command_catalog_constraints/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("INT02-M-004 command catalogue and confirmation evidence", () => {
  it("persists tenant-isolated append-only confirmation outcomes", () => {
    expect(migration).toContain("conversation_confirmation_attempts");
    expect(migration).toContain("conversation_confirmation_attempts_immutable");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("outcome IN ('SUCCEEDED','DENIED','FAILED')");
    expect(migration).toContain(
      "GRANT SELECT,INSERT ON app.conversation_confirmation_attempts TO logistics_app",
    );
  });

  it("keeps the persisted proposal intents closed", () => {
    for (const intent of [
      "CLIENT_CREATE",
      "VENDOR_CREATE",
      "RECORD_RECEIPT",
      "OPERATIONS_STATUS_UPDATE",
      "FINANCE_STATUS_UPDATE",
      "APPROVAL_DECIDE",
      "IMPORT_COMMIT",
      "DOCUMENT_UPLOAD",
    ])
      expect(migration).toContain(`'${intent}'`);
  });
});
