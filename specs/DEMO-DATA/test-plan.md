# DEMO-DATA — Deterministic Demo Bootstrap Test Plan

**Plan status:** Detailed
**Overall test status:** Focused Passing / deeper coverage Planned
**Related request:** Repeatable initial demo/test tenant, personas, masters, operations, billing, collections, vendor settlement, documentation, local bootstrap, and AWS bootstrap
**Related product features:** `FND-01`, `FND-02`, `MST-01`, `MST-02`, `MST-03`, `OPS-01`, `OPS-02`, `OPS-03`, `DOC-01`, `FIN-01`, `FIN-02`, `FIN-03`, `CTL-01`, `DAT-01`, `GOV-01`

This plan covers the opt-in demo-data bootstrap as one coherent, referentially valid business story. It does not authorize test execution. All cases are new and remain **Planned / Not Run** until executable coverage is authored and an explicit batch/release test phase is requested.

## Critical risks

- A bootstrap or reset command could mutate a non-demo tenant, another project's schemas in the shared PostgreSQL container, or real production records.
- Re-running or concurrently invoking the bootstrap could create duplicate users, memberships, role grants, natural keys, ledger postings, audit events, or payment allocations.
- Direct SQL fixture creation could bypass domain invariants and leave a visually plausible but impossible lifecycle graph.
- Fixed demo credentials could be logged, committed as production secrets, emailed externally, or accidentally grant Platform Admin access to a tenant persona.
- Tenant and scoped-role isolation could be weakened to make the demo convenient, exposing commercial, bank, margin, or cross-tenant data.
- Invoice, receipt, deduction, vendor-bill, TDS/GST, payment, and margin totals could disagree across canonical rows, workbenches, control-tower projections, and ledgers.
- Time-relative dashboards could become misleading unless one explicit bootstrap anchor is persisted and reused.
- A partial bootstrap failure could leave an apparently usable tenant that cannot be repaired safely by rerunning the command.
- Production smoke verification could alter demo state or use Playwright against production, contrary to the testing policy.

## Deterministic fixture manifest

Use the real PostgreSQL schema and production bootstrap path. Tests use `logistics_test` in the central shared PostgreSQL container. No business API mocks, request interception, per-project database container, production data, arbitrary sleeps, or external email delivery are permitted.

### Stable namespace and time

- Demo tenant code: `DEMO`; tenant name: `Demo Logistics India`; locale/currency/timezone: `en-IN`, `INR`, `Asia/Kolkata`.
- Stable record IDs are derived from a documented UUID namespace plus immutable logical keys, or recovered by tenant-scoped unique natural keys. IDs must be identical after an idempotent rerun.
- Test anchor: `DEMO_DATA_AS_OF=2026-08-31`. All dates are derived from this date in `Asia/Kolkata`, converted to UTC for persistence, and recorded in a bootstrap manifest.
- A rerun with the same seed version and anchor is a no-op/reconciliation. A different anchor or incompatible seed version must fail safely unless an explicit versioned upgrade/reset operation is selected.
- All money is asserted as integer minor-unit strings or database `bigint`; quantities are integer milli-units.

### Identities and access

The manifest uses the independently configured Platform Admin supplied by the normal seed and these six active Demo-tenant memberships:

| Persona              | Stable email                     | Required role/scope                            |
| -------------------- | -------------------------------- | ---------------------------------------------- |
| Tenant administrator | `demo.owner@logistics.test`      | Tenant Owner at tenant root                    |
| Operations planner   | `demo.operations@logistics.test` | Traffic/Placement Executive at tenant root     |
| Finance executive    | `demo.finance@logistics.test`    | Finance Executive at tenant root               |
| Vendor owner         | `demo.vendor@logistics.test`     | Vendor Owner scoped to `DEMO-FLEET`            |
| Driver               | `demo.driver@logistics.test`     | Driver restricted by assigned-driver resources |
| Client viewer        | `demo.client@logistics.test`     | Client Viewer scoped to `DEMO-RETAIL`          |

An Auditor membership may be added as a ninth persona if the delivered manifest documents it; the count assertion reads the checked-in manifest, not an undocumented assumption. INTERNAL personas have exactly one linked Employee; Vendor Owner, Driver, and Client Viewer do not acquire internal Employee records. Passwords come from documented environment variables or a documented local-only default. Password hashes, invitation/reset tokens, session cookies, and AWS secret values are never asserted or printed. The production guide must identify how the operator sets/rotates demo passwords and prominently label the account as demonstration data.

### Master-data graph

At minimum the checked-in manifest must declare and seed:

- one legal-entity root created through the same tenant-provisioning invariant, one region, and two branches;
- one Employee for each INTERNAL membership and the required manager/home-node relationships;
- two clients with at least two locations each, two published effective-dated contracts, and at least three lanes/rate lines;
- two active vendors, two verified bank versions, at least three vehicles, three drivers, and active compliance evidence required for eligibility;
- one intentionally ineligible/expired compliance record so allocation exclusions are demonstrable;
- tenant settings/reason lists needed by the sample lifecycle, including cancellation, NTP, delay, deduction, dispute, and payment-failure reasons;
- a small import job whose rows exercise `CREATE`, `UPDATE` or `UNCHANGED`, and `REJECT` dispositions if “dispositions” refers to bulk-data disposition. Financial deduction/dispute examples are seeded separately.

Exact expected counts and natural keys must live in a machine-readable fixture manifest used by both bootstrap and assertions. Tests fail on undocumented surplus or missing demo-owned rows in the covered tables.

### Coherent operations and finance story

The sample graph must include records that make all main dashboards useful without violating lifecycle order:

- indents in representative Draft, Open, Part Allocated/Allocated, Cancelled, and completed/downstream states;
- allocations representing Offered, Accepted/Assigned, Placed, NTP/replacement, and completed outcomes, never exceeding requested vehicle quantity;
- trips representing Assigned, In Transit, Delivered, and a documented exception; milestone timestamps are monotonic and every trip references the correct allocation, vendor, vehicle, driver, lane, and snapshots;
- accepted and pending POD tasks/documents sufficient to demonstrate invoice eligibility and pending-document queues;
- client invoices in representative Draft/Pending Approval, Posted/Acknowledged, Part Paid, Paid, and Reversed/exception states, using eligible delivered services only;
- receipts with allocation, deduction, on-account where supported, and compensating reversal entries; no editable cumulative balance;
- vendor services/bills with Draft/validation exception, Approved/Part Paid, Paid, and Disputed examples, plus verified-bank payment batches in Pending Approval, Paid, Failed, and/or Reversed states supported by the canonical state machine;
- control-tower queues and totals derived from those same canonical rows, never separate display-only summaries.

The exact reconciliation exemplar is:

- client invoice: taxable `300003`, GST `54001`, total `354004`;
- posted receipt allocation `150002` plus accepted deduction `5001`, leaving invoice balance `199001`;
- vendor bill: taxable `240000`, GST `43200`, TDS `2400`, deduction `5000`, advance `10000`, payable `265800`;
- a paid vendor allocation of `165800` leaves `100000`, followed by a final `100000` allocation leaving zero; a reversed-payment example uses a compensating negative allocation and restores the derived balance;
- any contribution-margin figure must be recomputed from the documented canonical client/vendor bases and match the relevant report definition exactly.

## Environment and cleanup controls

- Fresh-install tests run migrations, the normal Platform Admin seed, and the explicit demo bootstrap against an empty `logistics_test` database.
- Existing-install tests create a non-demo sentinel tenant and representative records before bootstrap. The sentinel's row values, counts, IDs, timestamps, audit events, and sessions must remain unchanged.
- Each integration test uses a transaction-isolated database or a namespaced fresh database and cleans only its own demo namespace.
- Demo reset requires an exact tenant code plus an explicit acknowledgement flag. It removes/recreates only the known demo tenant graph and must refuse unknown, blank, wildcard, platform, or non-demo targets.
- Production reset is disabled by default and requires a separate explicit production acknowledgement. Ordinary deployment/update and `db:seed` never erase or silently refresh demo business state.
- A failure injection after each major bootstrap phase proves atomic rollback or a persisted resumable state. The subsequent same-version rerun converges to exactly one complete manifest.

## Requirement-to-test matrix

### Current focused execution evidence

| Executable scope                                | Result        | Evidence                                                                                                                                                                                              |
| ----------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/demo-seed-config.test.ts`      | Passing — 8/8 | Production confirmation, public-default rejection, minimum length, opt-in, and encryption-key guards on 2026-08-31                                                                                    |
| `packages/db/src/demo-seed.integration.test.ts` | Passing — 3/3 | Real `logistics_test`: migration 029, independent Platform Admin, version/hash marker, exact replay, unchanged password hashes/counts, mismatch rejection, dispositions, and Employee/persona linkage |
| `tests/e2e/demo-data.spec.ts` (`chromium`)      | Passing — 4/4 | Real local PostgreSQL/backend/frontend: Platform + Tenant Owner, Traffic operations/allocation/trip, Finance invoice/vendor-bill/payout, and Vendor/Client portals                                    |

The focused evidence proves the documented demonstration path. The deeper concurrency, direct-ID isolation, exact independent ledger reconciliation, failure injection, reset, accessibility/mobile, and AWS rows below remain `Planned` until separately executed.

| Test ID        | Acceptance/risk                                            | Layer                         | Preconditions                                                                    | Action                                                                                                                                                     | Expected result                                                                                                                                                                                         | Status  | Evidence                                  |
| -------------- | ---------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| DEMO-U-001     | Stable identifiers, amounts, dates, and password redaction | Unit                          | Checked-in fixture manifest and fixed anchor                                     | Materialize the manifest twice and inspect serialization/log-safe view                                                                                     | Byte-stable business manifest; UUID/natural keys, UTC instants, minor units, and milli-units are deterministic; secrets are absent                                                                      | Planned | Not run; executable coverage not authored |
| DEMO-U-002     | Derived finance arithmetic                                 | Unit                          | Exact exemplar amounts above                                                     | Calculate invoice balance, vendor payable, partial/final/reversed payouts, and contribution margin                                                         | Integer arithmetic produces `199001`, `265800`, `100000`, zero, and restored reversed balances without floating-point conversion                                                                        | Planned | Not run; executable coverage not authored |
| DEMO-MIG-001   | Fresh migration/bootstrap compatibility                    | Migration/integration         | Empty `logistics_test` database                                                  | Apply all migrations, normal seed, then demo bootstrap                                                                                                     | Schema reaches latest migration; exactly one complete Demo tenant manifest exists and normal Platform Admin remains valid                                                                               | Planned | Not run; executable coverage not authored |
| DEMO-MIG-002   | Upgrade-safe bootstrap                                     | Migration/integration         | Pre-demo current schema with non-demo sentinel data                              | Apply any demo migration/seed changes and bootstrap                                                                                                        | No sentinel or unrelated schema changes; constraints, RLS policies, indexes, ownership, and runtime privileges remain valid                                                                             | Planned | Not run; executable coverage not authored |
| DEMO-INT-001   | Exact counts and referential integrity                     | PostgreSQL integration        | Completed demo bootstrap                                                         | Compare every covered table to the machine-readable manifest; run FK/orphan and domain-state queries                                                       | Exact declared counts/natural keys; no missing/foreign references, duplicate one-to-one links, orphan ledgers, or impossible states                                                                     | Planned | Not run; executable coverage not authored |
| DEMO-INT-002   | Sequential idempotency                                     | Integration                   | One completed bootstrap                                                          | Run the identical bootstrap again                                                                                                                          | Same IDs/counts/hashes and financial effects; no duplicate audit/outbox/invitation/email/ledger entries; command reports reconciled/no-op                                                               | Planned | Not run; executable coverage not authored |
| DEMO-INT-003   | Concurrent idempotency                                     | Integration/concurrency       | Empty eligible database                                                          | Start two bootstrap processes with the same version/anchor and wait on process completion, not a sleep                                                     | Locking/unique keys allow one logical bootstrap; both exit deterministically or one reports already applied; final manifest exists once                                                                 | Planned | Not run; executable coverage not authored |
| DEMO-INT-004   | Anchor/version conflict                                    | Integration                   | Completed version/anchor A                                                       | Rerun with changed anchor or incompatible version without upgrade flag                                                                                     | Safe conflict explains remediation; no dates, IDs, ledger rows, passwords, or partial records change                                                                                                    | Planned | Not run; executable coverage not authored |
| DEMO-INT-005   | Membership-to-Employee invariant                           | Integration                   | Demo identities seeded                                                           | Reconcile membership types and Employee links                                                                                                              | Every INTERNAL persona has exactly one Employee; vendor/driver/client external personas have none; home/scope nodes belong to Demo tenant                                                               | Planned | Not run; executable coverage not authored |
| DEMO-INT-006   | Master graph and eligibility                               | Integration/API               | Demo masters seeded                                                              | Query clients, locations, contracts, lanes, vendors, banks, vehicles, drivers, and compliance through production repositories/APIs                         | All references resolve within Demo; effective records are selectable; intentionally expired asset is excluded with a human-readable reason                                                              | Planned | Not run; executable coverage not authored |
| DEMO-INT-007   | Operations lifecycle coherence                             | Integration/API               | Demo operational graph seeded                                                    | Validate indent demand, allocation quantities/states, trip state/milestone ordering, assignments, exceptions, delivery, and POD linkage                    | No over-allocation, time reversal, mismatched asset/vendor, invalid transition, duplicate trip/POD, or invoice-before-eligibility relationship                                                          | Planned | Not run; executable coverage not authored |
| DEMO-INT-008   | Client ledger reconciliation                               | Integration/reconciliation    | Demo invoices/receipts seeded                                                    | Independently aggregate invoice lines/tax, receipt ledger, deduction, reversal, ageing, and open balances                                                  | Registers, invoice detail, collections queue, SOA, and control tower equal canonical minor-unit totals including balance `199001`                                                                       | Planned | Not run; executable coverage not authored |
| DEMO-INT-009   | Vendor settlement reconciliation                           | Integration/reconciliation    | Demo bills/payment batches seeded                                                | Independently aggregate bill lines, GST/TDS/deduction/advance, allocations, failed/reversed/paid batches, outstanding, and margin                          | Payable `265800`; partial/final/reversal balances reconcile across bill, vendor ledger, payment-run dashboard, remittance, and control tower                                                            | Planned | Not run; executable coverage not authored |
| DEMO-INT-010   | Import disposition sample                                  | Integration/API               | Demo import fixture exists                                                       | Preview/commit/replay sample import and query row disposition/report                                                                                       | Declared CREATE/UPDATE-or-UNCHANGED/REJECT examples are visible and reconciled; replay creates no duplicate business effect                                                                             | Planned | Not run; executable coverage not authored |
| DEMO-AUD-001   | Bootstrap provenance and audit safety                      | Integration/security          | Completed bootstrap                                                              | Inspect bootstrap manifest, audit/outbox/log capture and redaction                                                                                         | Version, anchor, actor/source, record summary, correlation ID, and outcome are traceable once; no plaintext credentials/tokens/bank numbers                                                             | Planned | Not run; executable coverage not authored |
| DEMO-FAIL-001  | Atomic failure and recovery                                | Integration/failure injection | Fresh database; deterministic fault points                                       | Fail after identity, master, operations, and finance phases, then rerun normally                                                                           | Each failure leaves either no demo graph or an explicit resumable checkpoint; recovery converges to exact manifest once                                                                                 | Planned | Not run; executable coverage not authored |
| DEMO-RESET-001 | Local demo reset                                           | Integration/security          | Demo plus non-demo sentinel data                                                 | Invoke reset with exact confirmation, then bootstrap                                                                                                       | Only Demo-owned graph is replaced; sentinel and platform admin remain byte-for-byte unchanged; new graph reconciles exactly                                                                             | Planned | Not run; executable coverage not authored |
| DEMO-RESET-002 | Destructive-target refusal                                 | Integration/security          | Demo and sentinel tenants                                                        | Attempt reset with blank, wildcard, sentinel code/ID, malformed code, or without acknowledgement; attempt production reset without production flag         | Every unsafe invocation fails before mutation and prints no secret/database URL                                                                                                                         | Planned | Not run; executable coverage not authored |
| DEMO-AUTH-001  | Tenant and direct-ID isolation                             | API/security                  | Demo identities plus look-alike Tenant B sentinel graph                          | Use Demo sessions against Tenant B IDs and Tenant B session against Demo IDs across masters, operations, finance, exports, and reports                     | Non-leaking denial/empty scoped result in both directions; no mutation or cross-tenant idempotency replay                                                                                               | Planned | Not run; executable coverage not authored |
| DEMO-AUTH-002  | Persona permission matrix                                  | API/security                  | All documented Demo users                                                        | Exercise representative list/detail/create/update/approve/pay/export endpoints per persona                                                                 | Owner administers Demo; operations cannot finance; maker cannot approve own item; checker can approve in scope; collections cannot pay vendors; external roles see only assigned party/trip/client data | Planned | Not run; executable coverage not authored |
| DEMO-AUTH-003  | Sensitive-field masking                                    | API/security                  | Owner, finance, vendor, driver, client, auditor sessions                         | Read vendor bank, PAN/GSTIN, mobile, commercial rates, payments, margin, audit, and CSV exports                                                            | Each persona receives only allowed values; bank/PII/margin remain masked or absent outside explicit permission                                                                                          | Planned | Not run; executable coverage not authored |
| E2E-DEMO-001   | Platform and tenant login entry                            | Playwright                    | Local deployed services and documented test credential inputs                    | Sign in as Platform Admin, locate Demo tenant, sign out, then sign in as Tenant Owner                                                                      | Both land on the correct shell; Demo tenant/config/onboarding/user counts match manifest; session tenant is server-derived                                                                              | Planned | Not run; executable coverage not authored |
| E2E-DEMO-002   | Operations end-to-end demo                                 | Playwright/API                | Operations persona and completed demo bootstrap                                  | Open operations landing, search sample indent, drill allocation, open active trip, and inspect delivered/POD example                                       | Visible queues/CTAs/state history reference the same graph; role cannot see finance administration; no mutation is required for smoke path                                                              | Planned | Not run; executable coverage not authored |
| E2E-DEMO-003   | Client billing and collections demo                        | Playwright/API                | Finance maker/checker and collections personas                                   | Inspect invoice lifecycle examples, exact invoice/detail totals, part-paid receipt/deduction, SOA, and collections queue                                   | States and exact `354004`/`199001` values reconcile; maker/checker boundaries and persona navigation are correct                                                                                        | Planned | Not run; executable coverage not authored |
| E2E-DEMO-004   | Vendor bill and payout demo                                | Playwright/API                | Finance checker and Vendor Owner                                                 | Inspect bill, partial/final/failed/reversed payment examples, vendor ledger/remittance, and payment-run dashboard                                          | Payable/outstanding states reconcile; Vendor Owner sees only own masked settlement data and no client margin                                                                                            | Planned | Not run; executable coverage not authored |
| E2E-DEMO-005   | Client/driver/vendor scoped portals                        | Playwright/API                | Client Viewer, Driver, Vendor Owner                                              | Sign in separately and open each portal plus direct forbidden URLs                                                                                         | Each persona sees only its client, assigned current trip, or vendor records; forbidden modules/actions are absent and direct requests deny                                                              | Planned | Not run; executable coverage not authored |
| E2E-DEMO-006   | Control-tower reconciliation                               | Playwright/API                | Tenant Owner and seeded sample graph                                             | Drill placement, trip, POD/invoice, collection, and vendor-payable lenses; download permitted CSV                                                          | KPI/rows/colours/money equal supported API/canonical queries and contain no Tenant B records                                                                                                            | Planned | Not run; executable coverage not authored |
| E2E-DEMO-007   | Documentation and first-run usability                      | Playwright/documentation      | Fresh local environment following README exactly                                 | Use documented bootstrap command and credential table, then navigate the documented demo flow                                                              | Commands are copy-safe; every documented account works; routes/labels/sample references exist; no undocumented manual database edit is needed                                                           | Planned | Not run; executable coverage not authored |
| E2E-DEMO-008   | Accessibility and responsive role journeys                 | Playwright/Axe                | Demo users; desktop and narrow viewport                                          | Keyboard-navigate login, role landing, tables, drill-downs, and logout; run Axe                                                                            | Labels, focus, landmarks, status announcements, non-colour states, table containment, and zero serious/critical Axe violations                                                                          | Planned | Not run; executable coverage not authored |
| DEMO-AWS-001   | Production deployment/bootstrap smoke                      | AWS read-only smoke/API       | Explicitly seeded AWS environment; expected commit/version; HTTPS readiness      | Verify deployed SHA, backend/frontend readiness, bootstrap manifest/version, safe counts, then perform login/read-only role-page checks without Playwright | Services and RDS are ready; one Demo graph exists; documented users authenticate and see expected scoped landing data; no production mutation occurs                                                    | Planned | Not run; executable coverage not authored |
| DEMO-AWS-002   | AWS rerun and secret hygiene                               | AWS deployment smoke          | AWS Demo graph already exists; credentials in approved environment/secret source | Invoke normal deployment/update including demo reconciliation and inspect redacted logs                                                                    | Deployment is idempotent, does not reset sample state, prints no passwords/URLs/tokens, sends no unexpected invitation email, and keeps readiness green                                                 | Planned | Not run; executable coverage not authored |

## Planned executable targets

Focused executable targets now present:

- `packages/db/src/demo-seed-config.test.ts`: environment/security guard assertions.
- `packages/db/src/demo-seed.integration.test.ts`: focused migration, replay, password, disposition, and persona-link assertions.
- `tests/e2e/demo-data.spec.ts`: focused local cross-role/workbench assertions using real frontend/backend/PostgreSQL.

Still planned:

- `apps/backend/test/demo-data.integration.test.ts`: deeper `DEMO-AUTH-*` and production repository/API reconciliation portions.
- `scripts/verify-demo-aws.sh` or an equivalently documented read-only command: `DEMO-AWS-*`; it must not expose environment values or run Playwright against production.

## Playwright journeys

### E2E-DEMO-001 — Primary success

Use the documented credentials through the real login form, verify Platform Admin and Tenant Owner landing shells, then reconcile tenant/profile/user/master summary values through supported APIs. Logout between identities; never inject session cookies.

### E2E-DEMO-002/003/004 — Coherent business walkthrough

Navigate the existing sample graph rather than creating throwaway browser data. Each drill begins from a dashboard/search result, follows semantic links to its canonical detail, and checks the next/downstream record. Exact finance strings are parsed back to minor units for comparison.

### E2E-DEMO-005 — Role and tenant isolation

Open independent browser contexts for Client Viewer, Vendor Owner, and Driver. Assert the permitted portal first, then attempt direct URLs and API IDs belonging to another party and the sentinel tenant. A UI-hidden button alone is not evidence; assert the server response and absence of mutation.

### E2E-DEMO-006 — Report reconciliation

Use supported API facts for assertions and the UI for navigation. Parse downloaded CSV and compare its authorized visible row set, exact amounts, and state/risk values to the filtered screen. Do not query or modify production data.

### E2E-DEMO-007/008 — First-run documentation and accessibility

Exercise the documentation from a clean local environment. Use semantic locators and observable response/rendered state; do not use arbitrary sleeps. Test desktop plus a narrow mobile viewport and keyboard-only representative flows. Generated traces/screenshots stay out of Git unless failure evidence is explicitly requested.

## Invalid input and boundary catalogue

- Missing/blank Demo tenant code, duplicate natural keys, malformed email/mobile/GSTIN/PAN/vehicle registration, out-of-range dates, expired compliance, wrong vendor/vehicle/driver, and cross-tenant references fail before partial insertion.
- Allocation equals remaining requested count at the valid boundary; one unit above fails. Milestones at equal/monotonic instants follow the canonical rule; a decreasing instant fails.
- Client and vendor amounts accept exact bigint-safe strings and reject JSON floating-point values, negative deductions/advances, receipt over-allocation, vendor overpayment, missing UTR at paid transition, and duplicate trip billing.
- Maker/checker self-approval, stale versions, duplicate idempotency keys with changed payload, and impossible invoice/vendor-payment state transitions fail without audit/ledger side effects other than an allowed rejection audit.
- Expiry and ageing examples use the tenant-local date derived from the persisted anchor, including records immediately below/at/above configured boundaries.

## Failure recovery and operational safety

- Bootstrap holds a database advisory lock or equivalent transaction-scoped serialization and writes its completion manifest only after all required records reconcile.
- Any non-transactional preparation must be explicitly recoverable and versioned. Rerun repairs a known incomplete demo namespace but never overwrites ordinary operator changes silently.
- Reset exports or otherwise warns about Demo-only operator changes according to the documented contract; normal deploy never calls reset.
- Local/AWS commands print the seed version, anchor, tenant code, safe row summary, and result, but redact credentials, hashes, tokens, database URLs, PEM paths, bank values, and session material.
- AWS checks are limited to service/readiness, deployment SHA, safe manifest counts, authentication, and read-only role screens. Browser E2E remains local-only.

## Commands for an explicit batch/release test phase only

Command names below are provisional until implementation defines repository scripts. Do not execute them during planning.

```bash
# Focused non-browser demo bootstrap tests
pnpm --filter @logistics/db test -- demo-seed
pnpm --filter @logistics/backend test -- demo-data

# Local real-service browser journeys only
pnpm exec playwright test tests/e2e/demo-environment.spec.ts --project=chromium

# Read-only AWS verification after explicit deployment authorization
scripts/verify-demo-aws.sh
```

## Coverage readiness

- [x] Primary bootstrap and demo walkthrough paths are mapped.
- [x] Exact fixture counts are required through a machine-readable manifest rather than duplicated prose constants.
- [x] Tenant/role isolation, sensitive masking, invalid input, state transitions, concurrency, idempotency, migration, audit, failure recovery, accessibility, cleanup/reset safety, and report/ledger reconciliation are explicit.
- [x] Required fixtures are deterministic, tenant-isolated, and tied to one persisted version/anchor.
- [x] Local Playwright uses real frontend/backend/PostgreSQL without mocks, arbitrary sleeps, or production data.
- [x] AWS verification is read-only and explicitly excludes production Playwright.
- [x] Every case is accurately marked Planned/Not Run; no current passing result is claimed.

## Execution synchronization (only after an explicit test phase)

- [ ] Executable titles carry the stable IDs from this plan.
- [ ] Authored but unexecuted cases move to `Implemented / Not Run`, never Passing.
- [ ] The selected suite runs once and records command, commit, environment, exact counts, and concise evidence.
- [ ] No unexplained skipped/only/quarantined test remains.
- [ ] `FEATURES.md`, `README.md`, `TODO.md`, the demo manifest/docs, and any completion note show the same implementation/test result.
