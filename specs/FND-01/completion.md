# FND-01 — Completion Evidence

**Feature status:** Complete
**Test status:** Passing
**Commit:** Pending focused local commit; hash is reported after this evidence is committed
**Frontend URL:** `http://127.0.0.1:3000`
**Backend URL:** `http://127.0.0.1:4000`

## Delivered behavior

- Deployable Next.js frontend and NestJS backend using only the central shared PostgreSQL container.
- Atomic tenant provisioning with validated tenant/legal/support/branding fields, configurable defaults, exactly one expiring owner invitation, durable events, audit, and retry-safe idempotency.
- Opaque sessions, CSRF protection, existing-identity-safe invitation linking, active-membership revalidation, multi-tenant selection/switching, and tenant lifecycle enforcement.
- Forced PostgreSQL row-level security for all 13 tenant-bearing tables, explicit Platform/Tenant transaction contexts, immutable audit rows, tenant-safe documents/events/jobs/alerts/reporting/exports, and exact isolation inventory checks.
- Accessible responsive Platform Admin tenant registry, health/alert report, invitation flow, tenant setup checklist, switcher, and tenant isolation probe surfaces.
- Forward-only Prisma migrations, guarded clean-test reset/seed, restart-safe local deployment, real migration readiness, Vitest suites, Playwright desktop/mobile journeys, and Axe scans.

## Acceptance evidence

| Acceptance criterion | Test IDs | Test status | Result/evidence |
|---|---|---|---|
| Tenant provisioning creates defaults and exactly one future-expiring owner invitation. | `FND01-U-002`, `FND01-I-001/002`, `FND01-C-001/002`, `E2E-FND01-01/02` | Passing | Atomic, replay, concurrency, validation, invitation, and browser assertions pass. |
| Tenant A cannot retrieve, mutate, export, guess, subscribe to, or receive Tenant B data through current channels. | `FND01-A-001..005`, `E2E-FND01-03` | Passing | Exact 13-table RLS inventory, bidirectional service/DB tests, six immediate suspension denials, foreign document/report/export checks, and closed WebSocket path pass. |
| Multi-tenant switching and fresh login show only the selected tenant context. | `FND01-U-003`, `E2E-FND01-05` | Passing | Existing-account linking preserves credentials; fresh workspace selection and A/B branding/probe isolation pass on desktop/mobile. |
| Deactivation blocks access/jobs without deleting data and reactivation restores authorized access. | `FND01-U-004`, `FND01-I-004`, `E2E-FND01-04` | Passing | Lifecycle, session, job, typed-confirmation, persistence, and recovery assertions pass. |
| Automated isolation covers every tenant-owned table/resource. | `FND01-M-002`, `FND01-A-002/003/005` | Passing | Metadata inventory has zero omissions; every tenant-bearing table has forced RLS, policy, and tenant-leading index coverage. |
| Platform report/alerts reconcile without business-data leakage. | `FND01-U-005`, `FND01-R-001/003`, `E2E-FND01-05` | Passing | Canonical counts, repeated-failure alert deduplication, readiness, and privacy assertions pass. |
| Local bootstrap is deployable, accessible, responsive, and observable. | `FND01-M-001`, `FND01-X-001/002` | Passing | Clean/no-op migrations preserve an unrelated sentinel; health passes; Axe found zero serious/critical violations across five surfaces per viewport. |

## Commands and results

| Command | Result | Notes |
|---|---|---|
| `make policy-check` | Passing | Feature/test status synchronization and repository policy pass. |
| `make postgres-status` | Passing | `shared-postgres` accepts connections for project databases/schemas. |
| `make check` | Passing | Config 2/2, domain 17/17, backend migration/integration/security 17/17; format, lint, and typecheck pass. |
| `pnpm run build` | Passing | NestJS compiles; Next.js produces nine routes. |
| `make deploy-local` | Passing | Both migrations deploy, deterministic seed runs, frontend/backend restart and become ready. |
| `make health` | Passing | PostgreSQL, backend, frontend, and migration readiness are healthy. |
| `make e2e` | Passing | 14/14 Playwright project cases on desktop and mobile Chrome; Axe zero serious/critical findings. |
| `make verify` | Passing | Final synchronized tree: 36 non-browser tests and 14 Playwright project cases pass. |

## Local deployment evidence

- Backend readiness reports `status=ready`, `database=connected`, `migration=ready`, migration count `2`, and latest migration `202608240002_fnd01_security_hardening`.
- Frontend responds on port 3000 and backend on port 4000.
- Runtime PID/session/log evidence is kept under ignored `.sdlc/runtime/`; no generated Playwright artifacts are committed.

## Independent review

- Reviewer: required read-only `reviewer` agent.
- Blocking findings resolved: existing-identity credential takeover, stale membership authorization, incomplete mixed-scope RLS, multi-tenant re-login, approved test gaps, validation associations, list/lifecycle UX, ISO/contrast validation, owner-name persistence, and mobile header overlap.
- Remaining non-blocking findings: Prisma 6 reports its future Prisma 7 configuration migration warning; Next.js reports the current lint-command/plugin migration warning. Neither affects current passing gates.

## Migrations and operational notes

- `202608240001_fnd01_foundation` creates the baseline schemas and tenant platform.
- `202608240002_fnd01_security_hardening` is forward-only and adds identity snapshots, forced mixed-scope RLS policies, and tenant-leading indexes.
- Clean `logistics_test` application schemas accept both migrations; a second deploy is a no-op and an unrelated sentinel schema remains intact.
- Local E2E hooks are Platform Admin/CSRF guarded and startup rejects them when `APP_ENV=production`.
- No Redis, queue, object-store, Mailpit, worker, or project-specific PostgreSQL container was introduced.

## Decisions and follow-up

- FND-02 is the next dependency-ready feature and owns full role/scope administration, MFA, and account lifecycle beyond the secure FND-01 kernel.
- WebSockets remain absent in FND-01; the closed upgrade path is tested. Any future transport must reuse server-derived tenant context and add explicit isolation coverage.
- Invitation delivery remains a PostgreSQL-backed local adapter/outbox boundary; external providers belong to INT-01.

## Final checklist

- [x] Spec Approved/Verified and test plan Executed
- [x] Unit/integration/contract/security/migration tests pass
- [x] Local deployment and health pass
- [x] Playwright acceptance suite passes
- [x] Reviewer reports no unresolved blocking finding
- [x] `make verify` passes on the synchronized final tree
- [x] `FEATURES.md` status is accurate
- [x] `FEATURES.md` register and feature section have matching implementation/test status
- [x] `README.md` current status and next feature are accurate
- [x] `TODO.md` has no completed item and records every remaining item
- [x] Test plan and executable tests have matching IDs/status; no unexplained TODO/FIXME/skip/only remains
- [x] Affected architecture/API/runbook/package documentation is updated
- [x] Staged diff contains only feature files and no secrets/generated output
- [x] Focused local commit is prepared as the next operation; nothing will be pushed
