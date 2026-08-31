# DEMO-DATA — Deterministic demonstration environment

**Status:** Complete
**Test status:** Focused Passing — 11 database checks and 4 Chromium journeys passed locally on 2026-08-31; deeper cases remain Planned
**Feature source:** User-requested cross-feature demonstration bootstrap
**Owner:** Primary agent

## Problem and outcome

A newly migrated environment currently contains only the explicitly seeded Platform Administrator. A useful demonstration requires a coherent tenant, actors with different permissions, master data, operational lifecycles, collection dispositions, client receivables, vendor payables, and settled examples. Manually recreating this graph is slow and inconsistent.

Provide an explicit, deterministic and idempotent bootstrap which creates one tenant-neutral demonstration company and a reconciled cross-module dataset. The same command works against the shared local PostgreSQL database and an AWS RDS deployment. It is safe to rerun, produces a summary without printing passwords, and never changes records outside the marked demo tenant.

Demo data is **bootstrap data, not schema migration data**. Prisma migrations remain deterministic DDL/reference-data changes. The bootstrap runs after `db:migrate` and the Platform Administrator seed because demo records are mutable, password-derived and environment-selective.

## In scope

- An opt-in `demo:seed` database command and root command/Make target.
- One stable demo tenant with legal entity, authorization root, configuration and completed setup checklist.
- Active users for representative internal and external portal roles.
- Organization, employee, client/location, contract/version/lane/rate/SLA, vendor, bank, vehicle, driver and compliance examples.
- Open, partially allocated, fulfilled and delivered operations, including trip events, exception/alert dispositions and POD states.
- Draft, approval, posted, part-collected and paid client invoices; receipts and allocation ledger entries; collection follow-up dispositions.
- Draft, approval, part-paid and paid vendor bills; payment runs/batches and vendor payouts.
- Audit/provenance and a versioned bootstrap-run record.
- Local and AWS execution documentation, credential inventory, demo script/story and safe cleanup/reset instructions.
- Automated unit/integration/authorization/reconciliation cases and one no-mock Playwright demo journey, authored separately by the implementation owner.

## Out of scope

- Creating PostgreSQL, EC2, RDS or auxiliary infrastructure.
- Sending real email/SMS/WhatsApp, calling GPS/accounting/bank systems, or storing real personal, tax or bank data.
- Making public production credentials universal or committing a production password.
- Running the demo seed automatically during every deployment or `db:migrate`.
- Using the demo tenant for performance, security-penetration or production business data.
- A general-purpose fixture factory or tenant backup/restore system.

## Dependencies and assumptions

| Item                     | State/decision                                                                                                               | Evidence                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Foundation and access    | FND-01/FND-02 migrations and Platform Admin seed run first                                                                   | Existing `packages/db/src/seed.ts` seeds only the Platform Admin                                                     |
| Business model           | All MST/OPS/DOC/FIN/CTL migrations run first                                                                                 | Canonical tables are created by `202608250007_all_feature_canonical` and later workbench migrations                  |
| Infrastructure           | Existing Next.js, NestJS and PostgreSQL only                                                                                 | Repository architecture invariant                                                                                    |
| “Initial migration data” | Implement as a post-migration, opt-in versioned bootstrap                                                                    | Mutable examples and password hashes must not be embedded in migration history                                       |
| “Dispositions”           | Seed collection follow-up outcomes plus operational-alert resolution/exception actions; do not invent a new ambiguous entity | Current model represents collection dispositions in `collection_followups` and operational outcomes in alert actions |
| Reference date           | Derive dates from one persisted bootstrap anchor date in tenant timezone, not from each rerun’s wall clock                   | Keeps states and ageing deterministic between reruns                                                                 |
| Currency/timezone        | `INR`, `Asia/Kolkata`, `en-IN`; stored timestamps remain UTC                                                                 | Product defaults and timezone invariant                                                                              |
| Deployment               | Demo bootstrap is separately enabled in local/AWS; normal update deploy does not seed                                        | Prevents surprise data/password mutation                                                                             |

## Actors, permissions, and scopes

All identities use reserved `@demo.logistics.test` addresses. These addresses are non-deliverable and must be suppressed by notification adapters.

| Actor/capability                                                       | Allowed scope               | Sensitive fields/actions                                    | Denied behavior                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Platform Admin (`admin@local.test` locally; configured address in AWS) | Platform                    | Provision/read demo tenant, lifecycle administration        | No tenant business access unless explicitly switching through supported platform flow; password is independently configured |
| Tenant Owner (`demo.owner@logistics.test`)                             | Entire demo tenant, `ADMIN` | User/config/master/operations/finance administration        | No platform-wide access                                                                                                     |
| Traffic Executive (`demo.operations@logistics.test`)                   | Demo tenant operations      | Indents, allocations, trips, POD, alerts and control        | No finance administration                                                                                                   |
| Finance Executive (`demo.finance@logistics.test`)                      | Demo tenant finance         | Invoices, receipts, vendor bills, verified bank and payouts | No Platform administration                                                                                                  |
| Vendor Owner (`demo.vendor@logistics.test`)                            | Demo vendor scope           | Own fleet, allocations, trips, bills/payment status         | No other vendors or tenant-user administration                                                                              |
| Driver (`demo.driver@logistics.test`)                                  | Assigned-driver resources   | Own trip execution and evidence                             | No unrelated trips or financial administration                                                                              |
| Client Viewer (`demo.client@logistics.test`)                           | Demo client scope           | Own indents, trips, PODs and invoices                       | No internal margins, vendor administration, or other clients                                                                |

The bootstrap assigns existing baseline roles and compatible `membership_role_assignments`/`scope_grants`; it does not create weaker roles or bypass server-side authorization. Every internal membership has exactly one linked Employee. External Vendor, Driver and Client memberships do not create Employees; they link through the appropriate vendor/driver/client records.

## UX flow

### Primary flow

1. An operator migrates the database and runs the normal Platform Admin seed.
2. The operator sets `DEMO_DATA_ENABLED=true` and an environment-appropriate `DEMO_USER_PASSWORD`, then runs `pnpm run demo:seed` (or the documented Make target).
3. The command validates environment policy, acquires a PostgreSQL advisory lock and starts a transaction in platform context.
4. It upserts the marked tenant and graph in dependency order, hashes the shared demo-user password once per invocation with Argon2id, reconciles ledger totals and records bootstrap version/provenance.
5. It prints only tenant code, bootstrap version, counts, role email addresses and safe login URL. It never prints passwords, password hashes, connection strings, bank ciphertext or tokens.
6. A demonstrator signs in as each documented actor and follows the README story: control tower → open indent → allocation/trip → POD → client invoice/receipt → vendor bill/payment.

### Validation, loading, empty, error, retry, and stale states

- Missing opt-in returns a non-zero exit with “demo bootstrap disabled”; no writes occur.
- Local/test may use the documented local demo password. Production rejects the committed/default password, passwords under 16 characters, and a missing explicit `DEMO_DATA_ALLOW_PRODUCTION=true` acknowledgement.
- Unsupported schema version or missing dependency tables fails before mutation.
- Any row or reconciliation failure rolls back the complete bootstrap transaction and records no successful run.
- Concurrent invocations serialize on a stable advisory-lock key; the loser waits within a bounded timeout then exits retryably.
- Rerunning the same version reports `replayed: true` and leaves canonical counts, amounts and user auth versions unchanged unless an explicit password-rotation flag is supplied.
- A newer dataset version applies documented additive/corrective upserts. It never silently deletes user-added records in the demo tenant.

### Responsive and accessibility behavior

No new application screen is required. Existing screens must render the seeded rows in their standard loading/empty/error/responsive states. README demo paths use semantic labels rather than pixel positions and identify expected visible record codes.

## Data model and migration

### Bootstrap metadata

Add an application-owned `app.demo_bootstrap_runs` table through a forward migration:

- `id uuid`, `tenant_id uuid`, `dataset_code text`, `dataset_version integer`, `content_hash text`
- `anchor_date date`, `state text` (`RUNNING`, `COMPLETE`, `FAILED` if failure is recorded outside the main transaction)
- `created_by uuid`, `started_at`, `completed_at`, safe `summary jsonb`
- unique `(tenant_id, dataset_code, dataset_version)` and tenant RLS/policy consistent with other app tables.

The successful run row is written inside the same transaction as the data graph. `content_hash` covers canonical non-secret fixture definitions, not password values or hashes. Audit entries use source `DEMO_BOOTSTRAP` and dataset version.

### Stable dataset

Reserved tenant identity:

- code `DEMO`, name `Acme Logistics Demo`, legal name `Acme Logistics Demo Private Limited`
- synthetic tax identifier, telephone numbers, addresses, vehicle registrations, licences, bank last-four and invoice references clearly marked non-real
- timezone `Asia/Kolkata`, currency `INR`, fiscal year start 1 April
- one legal entity, South Region, Hyderabad Branch and Bengaluru Branch; closure/scope rows must reconcile
- completed setup checklist corresponding to actually seeded sections

Dataset version `2026.08.1` contains:

| Area                    | Required records and lifecycle coverage                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | 6 active tenant memberships/roles; 3 INTERNAL Employees and Vendor/Driver/Client portal links                                                                 |
| Client masters          | 1 client, 2 locations, 1 published contract/version, 1 lane, SLA and published rate                                                                           |
| Supply masters          | 1 active vendor, runtime-encrypted verified synthetic bank version, 2 vehicles, 2 drivers and valid compliance                                                |
| Operations              | 4 indents covering open, partially allocated, live/fulfilled and delivered/closed; offered/placed allocations, 2 assignments, and live/delivered trips/events |
| Exceptions/dispositions | 1 acknowledged operational alert/action, 1 collection follow-up, and import row dispositions `CREATE`, `UPDATE`, and `REJECT`                                 |
| POD                     | 1 closed delivered-trip POD with invoice eligibility                                                                                                          |
| Client finance          | 1 draft invoice, 1 submitted/part-collected invoice, and 1 reconciled partial receipt/allocation                                                              |
| Vendor finance          | 1 paid vendor bill, exact trip line, verified-bank paid batch/allocation and synthetic UTR                                                                    |
| Control tower           | Seeded saved view plus canonical placement, trip, POD/invoice, collection and vendor-payable records                                                          |

### Invariants, indexes, and tenant isolation

- Use existing tenant-scoped natural keys (`DEMO-*`) and `ON CONFLICT`/select-then-update inside one platform transaction; never use cross-tenant lookups by code alone.
- Foreign keys always use `(tenant_id, id)` relationships where supported.
- Stable IDs are resolved by tenant plus natural key; generated UUID values need not match across databases, while all business codes, dates, states and amounts do.
- An indent’s allocated vehicles never exceed remaining eligible demand. Trip state is supported by an ordered event timeline and its current assignment.
- Delivered/POD/invoice/vendor-bill service chains point to the same trip and tenant.
- Invoice `total_minor = taxable_minor + tax_minor`; receipt ledger allocation/reversal totals determine collected balance.
- Vendor bill `payable_minor = taxable + GST - TDS - deduction - advance`; net payment allocations never exceed payable and state matches amount paid.
- Maker and checker differ for verified bank versions and approved/paid financial records. Separate demo Finance and Owner users satisfy segregation.
- Money is integer minor units; quantities use existing milli-units. Synthetic bank account content uses the normal encryption envelope/key and never plaintext columns.
- External demo notification destinations are suppressed; no invitation/reset/notification job may attempt real delivery.
- Bootstrap changes do not revoke sessions or rotate hashes/auth versions on a replay. Password rotation is explicit.

### Migration/backfill and reversal plan

- The metadata-table migration is forward-safe and empty by default; it does not create the tenant.
- `demo:seed` creates or advances only tenant `DEMO`. If a non-demo tenant already owns code `DEMO`, fail safely rather than adopting it; marker/provenance must match.
- No destructive demo-reset command is implemented. Operators deactivate `DEMO` through Platform Admin; disposable local/test databases use the existing project-specific test reset only.
- Ordinary rerun is preferred recovery. No downgrade of a higher dataset version is supported.

## Domain rules and calculations

- Persist one anchor date (default a fixed fixture date supplied in the dataset definition) and construct UTC instants from tenant-local business times. A deployment override is allowed only on first creation; reruns use the persisted anchor.
- Ageing examples deliberately cover green/yellow/red buckets without relying on today. Reports calculate “as of” current time, so README notes that ageing colors may naturally evolve while canonical dates remain stable.
- Invoice examples use exact paise values and reconcile to service-linked trips. Posted financial records are never updated destructively on replay; fixture differences require a compensating record or a new demo dataset version.
- Receipt and payment allocations are append-only. Seed version replay detects their stable natural event keys in provenance rather than duplicating ledger entries.
- Payment batch `PAID` requires a synthetic UTR and compatible bank version; no external bank call occurs.
- “Payout” means canonical `payment_batches` plus `payment_allocations`; no duplicate payout table is introduced.
- Collection “disposition” means `collection_followups.outcome` and optional promise/next-follow-up fields. Operational disposition uses alert actions with reason/payload.

## API, events, and jobs

| Interface/event/job          | Input                                                                        | Output/effect                                   | Auth/idempotency/failure behavior                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm run demo:seed`         | Environment flags, optional dataset version/anchor on first run              | Complete demo graph and safe JSON/text summary  | Operator shell only; advisory lock + version/content hash; transaction rollback on error |
| `make demo-seed`             | Pass-through to repository command                                           | Same as above                                   | Uses current protected environment; no implicit production enablement                    |
| AWS setup/update integration | Separate documented SSM/SSH command with one-shot production acknowledgement | Runs once after migrate and Platform Admin seed | Normal recurring deploy remains off; production acknowledgement/password required        |

The bootstrap may directly persist canonical rows because it is an environment provisioning tool, but it must reproduce all domain invariants and audit provenance. It must not enqueue real external deliveries. Existing application APIs remain unchanged.

## Reports and alerts

- Seed enough canonical records for all five control-tower lenses: placement, trip, POD, collection and vendor payable.
- KPI totals must reconcile to drill-down rows and canonical ledgers at the saved anchor/content version.
- Alerts include deterministic deduplication keys (`DEMO:<version>:<scenario>`) and action history. Reruns update neither occurrence count nor action history.
- README lists expected record codes and qualitative states, not brittle totals tied to live ageing time.
- No real recipients or external alert channels are seeded; channels are `IN_APP` only.

## Audit, observability, and security

- One summary audit event records dataset code/version/hash, tenant, counts, actor, correlation ID and replay status. It excludes secrets and sensitive plaintext.
- Structured console output includes duration, created/unchanged/corrected counts and reconciliation checks. It redacts database URL and all credentials.
- Metrics/logs distinguish disabled, created, replayed, upgraded, validation-failed and lock-timeout outcomes.
- Local documentation may publish the reserved emails and the committed **local-only** demo password `DemoAccess!234`. `APP_ENV=production` rejects that password and any missing/short replacement.
- Production uses `DEMO_USER_PASSWORD` from `/etc/logistics-management.env` or a managed secret, minimum 16 characters and unique to that environment. README names the variable and retrieval/rotation procedure but never includes its value. Platform Admin credentials remain separate and are never shared with tenant demo users.
- A public AWS URL with known credentials would allow unauthorized mutation and is prohibited. Demo accounts should be shared privately, rotated after demonstrations, and suspended or the demo tenant deactivated when not in use.
- Password rotation requires `DEMO_ROTATE_PASSWORD=true`; it rehashes active demo users, increments auth versions, revokes their sessions with reason `DEMO_PASSWORD_ROTATED`, and records an audit event.
- Production bootstrapping requires TLS database configuration and must not echo the sourced environment.

## Documentation contract

README and the affected deployment runbook must include:

1. prerequisites and the exact local command sequence (`bootstrap/migrate`, normal admin seed, demo seed, service refresh);
2. a credentials table with login URL, role, reserved email, scope, and local-only password; Platform Admin shown separately;
3. a prominent statement that the local password is rejected in production;
4. AWS command through the deployment user with `/etc/logistics-management.env`, plus SSM/GitHub CI optional flag behavior;
5. how to set/rotate the protected production demo password without printing it;
6. expected safe command summary and verification queries/counts;
7. a 10–15 minute end-to-end demonstration script referencing stable codes;
8. reset/deactivation procedure and warning that reset is destructive only within the demo tenant;
9. normal production update behavior: migrations/build/restart do not reseed or rotate demo credentials.

## Lightweight acceptance notes

| Acceptance criterion                                                                                         | Design section             | Planned test IDs               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------ |
| A clean migrated local database can explicitly create the complete demo graph                                | UX flow; Data model        | `DEMO-INT-01`                  |
| A second identical run changes no canonical counts, ledger entries, hashes, auth versions or audit actions   | Invariants; Domain rules   | `DEMO-IDEM-01`                 |
| A concurrent run serializes or exits retryably without partial/duplicate records                             | UX failure states          | `DEMO-CONC-01`                 |
| Demo tenant records cannot be read or mutated from a second tenant/scoped actor                              | Actors; tenant isolation   | `DEMO-AUTH-01`, `DEMO-AUTH-02` |
| Each demo login receives only the documented role/scope and portal audience                                  | Actors                     | `DEMO-AUTH-03`                 |
| Internal users link one-to-one to Employees; external actors do not create Employees                         | Actors; invariants         | `DEMO-INT-02`                  |
| Operations and POD records form valid, coherent lifecycle examples                                           | Stable dataset; invariants | `DEMO-OPS-01`                  |
| Client invoices/receipts and vendor bills/payouts exactly reconcile                                          | Domain rules               | `DEMO-FIN-01`, `DEMO-REC-01`   |
| Collection and operational dispositions appear without duplicate alerts/actions                              | Reports and alerts         | `DEMO-CTL-01`                  |
| Default/demo password is rejected in production and no output contains a password/hash/URL secret            | Security                   | `DEMO-SEC-01`, `DEMO-SEC-02`   |
| Failure midway rolls back the graph and a retry succeeds                                                     | Failure recovery           | `DEMO-FAIL-01`                 |
| AWS opt-in command produces the same content version and healthy services without automatic recurring reseed | API/jobs; Documentation    | `DEMO-AWS-01`                  |
| A real browser can follow the documented Owner → Traffic → Finance → Vendor demo story with no mocked API    | UX; Documentation          | `DEMO-E2E-01`                  |

All planned/executable test cases remain `Planned` or `Implemented / Not Run` until an explicitly requested test phase records current evidence. Playwright must never target production.

## Failure recovery

- Preflight validates flags, schema, encryption key availability, baseline roles and content version before opening the write transaction.
- On graph-validation or SQL failure, roll back and print a safe correlation ID plus failed phase; never emit raw payloads containing sensitive values.
- If application rows predate the run but conflict with reserved natural keys and lack demo provenance, abort with a collision report. Never overwrite them.
- If a prior complete run exists with the same version but different content hash, abort and require a new version. This prevents silently rewriting posted finance history.
- If an AWS deployment builds successfully but demo seeding fails, application deployment remains healthy and the demo step is reported separately; rerun only `demo:seed` after correcting configuration.

## Open decisions

| Decision                                                    | Safe default                                               | Owner/impact                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Exact public-facing demo company name/logo                  | Tenant-neutral “Acme Logistics Demo”; no customer branding | Product owner may replace synthetic branding without changing behavior |
| Whether production demo accounts remain continuously active | Deactivate outside scheduled demos and rotate before reuse | Deployment owner; materially reduces public attack surface             |
| Anchor date override                                        | Fixed dataset date on first run; persisted thereafter      | Deployment owner may set first-run anchor for fresher dashboard ageing |

## Readiness

- [x] Intended outcome and material rules are clear
- [x] Dependencies and affected interfaces are identified
- [x] Planned automated coverage is listed
