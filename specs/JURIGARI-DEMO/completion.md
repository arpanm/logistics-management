# JURIGARI-DEMO completion evidence

**Implementation:** Complete / AWS deployed
**Focused tests:** Passing
**Production installation:** Passing

## Delivered

- Versioned opt-in Jurigari profile with exact public company details and workbook exemplar chain.
- Exactly two active INTERNAL Tenant Owners linked to Employee records.
- Safe explicit adoption of the provisioned production `JG` graph by exact tenant/name and legal-entity/root-organization/scope/Piyana-membership/Employee UUID checks.
- Insert-only posted invoice, reconciled receipt, and receipt-ledger materialization with exact minor-unit reconciliation.
- Secret-free verifier, local/AWS runbook, package scripts, and local-only real Playwright login/data traversal.

## Evidence (2026-09-02)

- `jurigari-demo-config.test.ts` + `jurigari-demo-profile.test.ts`: 12/12 passing.
- `jurigari-demo.integration.test.ts`: 2/2 passing against migrated PostgreSQL, including first-run/replay/verifier evidence.
- `pnpm --filter @logistics/db run typecheck`: passing.
- `tests/e2e/jurigari-demo.spec.ts --project=chromium`: 2/2 passing with real local services and PostgreSQL; no mocks.
- AWS commit `037743c0a272b0baf1acea8bad2de747be44c8b6`: deployed; first seed and secret-free verifier passed.
- Identical AWS replay reported no data changes; verifier reported 2 owners, 2 employees, one workbook chain, and exact invoice/receipt reconciliation.
- EC2 backend/frontend services active; direct and proxied readiness reported database connected and 28 migrations ready.
- Public HTTPS login and authenticated `/auth/me` returned HTTP 200 for both configured user emails.

## Explicitly remaining

- JGD-I-004 collision rollback integration, JGD-I-005 concurrent first run, JGD-I-006 rotation/recovery/audit, and JGD-A-001 dedicated cross-tenant integration remain Planned.
- Rotate the shared demonstration password or deactivate tenant `JG` after demonstrations.
