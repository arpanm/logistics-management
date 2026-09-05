# Logistics Operations Control Tower

A configurable, multi-tenant B2B logistics platform for managing client contracts, truck indents, vendor placement, trips, POD, client billing and collections, vendor payables, alerts, and control-tower reporting.

The product requirements and per-feature implementation/test status are maintained in [FEATURES.md](FEATURES.md). The active execution queue is [TODO.md](TODO.md), and failed-acceptance RCA is maintained in [BUGS.md](BUGS.md). Supplied Juri Gari prototypes and the workbook are preserved in `backup/` as read-only reference material and intentionally excluded from Git.

## Current project status

| Item                              | Status                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agentic SDLC scaffold             | Complete                                                                                                                                                                                                                                                                                                                                                                                               |
| Application bootstrap             | Complete — `FND-01` concurrent report reconciliation is fixed and verified                                                                                                                                                                                                                                                                                                                             |
| Automated feature tests           | Prior demo bootstrap: 12 focused database checks and 4 real-browser journeys passed locally; BUG-CTL-026 adds 6/6 contract, 4/4 PostgreSQL reconciliation, and 1/1 real-browser Placement checks passing                                                                                                                                                                                               |
| Local frontend/backend deployment | Healthy on ports 3000/4000 against shared PostgreSQL; production builds and readiness passed on 2026-09-05 with 33 migrations current                                                                                                                                                                                                                                                                  |
| Feature implementation            | The existing operational surface plus the INT-02 conversational command, governed-file, scoped-report, WhatsApp delivery, consent, and proactive-alert implementation are present locally; the authored conversational tests have not been run, WhatsApp remains disabled until a Meta account is configured, real malware scanning remains deployment work, and SES production access remains pending |

Agents synchronize this summary and only the trackers, specs, and executable test-case status materially affected by an implementation batch, once. Purely internal or mechanical work does not churn unrelated status files. New or changed tests remain `Implemented / Not Run` until an explicitly requested batch/release test phase executes them.

The implementation includes normalized canonical stores and actionable workbenches for access, masters, operations, POD, finance, governance, configuration, control tower, alerts, imports, and integrations. For a signed-in tenant user, `/` and `/app` now resolve through effective authorization: Control-capable internal users land directly on `/app/control`, restricted internal roles land on the first route for which they hold the exact required capability, users with no assigned application area see a neutral access message, and external users retain their dedicated portals. The sidebar keeps each destination in its owning domain: **Indent & Truck Allocation** precedes POD under Operations; **User & Access**, Roles, and **Activity & Audit** are ordered under Administration; and every Finance workbench has a direct link. On phones, three capability-derived primary destinations stay in a bottom navigation bar and **More** opens the complete authorized menu. The shared presentation follows the supplied Control Tower prototype with dark navy layered surfaces, cyan focus and operational emphasis, compact condensed labels, monospaced values, squared tabs and semantic red/yellow/green KPI signals. Control Tower now uses a compact icon action row, mobile-collapsed search/filter disclosure, reduced-height freshness and KPI regions, and prototype-aligned portfolio cards with monograms, full client/vendor identity, named ageing status, one canonical traffic signal per scoped location, and a dashed G/Y/R plus fill/open footer. UI-02 retains mobile bottom sheets with readable form grids and non-overlapping actions, structured tenant-timezone details, list-first User administration, server-filtered reconciliation cards, runtime-validated Control responses, safe masked/null Collection formatting, real vendor allocation summaries, and bounded long-name drills. Control drill responses are bound to the exact lens/query, preventing prior all-client locations from flashing under a newly selected client/vendor while preserving same-scope background refresh. Prior placement-vendor checks pass; the latest navigation, compact-layout, and portfolio-card cases are Implemented / Not Run.

## Implemented feature surface

| Feature | Implemented user surface                                                                                | Canonical behavior                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FND-01  | `/platform/tenants`, `/platform/tenants/:id`, `/platform/report`, `/app/setup`                          | PIN-first tenant provisioning plus Platform Admin tenant-user directory/dossiers, derived onboarding evidence, profile updates, safe enable/disable, lifecycle, setup, isolation, health, reports, and alerts                                                                                       |
| FND-02  | `/app/access/users`, `/app/access/roles`, `/app/access/reports`, `/mfa`                                 | Editable profiles, paginated directory, invitation lifecycle, scoped roles, permission review, Activity & audit, MFA, sessions, history, and atomic INTERNAL user-to-Employee linkage                                                                                                               |
| MST-01  | `/app/masters`, `/app/masters/locations`, `/app/masters/employees`                                      | Discoverable Masters hub, PIN-derived organization geography, structured geofences, employees, optional existing-user link or explicit invited access, scoped ownership, impact/reassignment, reports, export, alerts, and cycle-safe moves                                                         |
| MST-02  | `/app/masters/parties`, `/app/masters/client-locations`, `/app/masters/contracts`, `/app/masters/lanes` | PIN-derived client locations, tenant/scope-safe searchable contract-version references, versioned contracts, lanes, SLA rules, and effective rate cards                                                                                                                                             |
| MST-03  | `/app/masters/vendors`, `/app/masters/fleet`, `/app/masters/drivers`                                    | PIN-derived vendor/driver addresses, configured truck/body/cargo catalogs, compliance, eligibility, secure bank versions, and overrides                                                                                                                                                             |
| OPS-01  | `/app/operations`, `/app/operations/indents`                                                            | Complete filtered open-indent register with reconciled KPIs and contextual typed create/edit/cancel/submit/allocate actions, snapshots, versions, audit, reports, and alerts                                                                                                                        |
| OPS-02  | `/app/operations/allocations`                                                                           | Complete allocation register with accept/reject/expire, eligible vendor/vehicle/driver assign/replace, NTP/place/cancel/trip CTAs, and structured auto-allocation rule management                                                                                                                   |
| OPS-03  | `/app/operations/trips`, `/portal/driver`                                                               | Complete trip register and contextual accept/start/load/transit/arrival/unload/end/cancel forms plus immutable milestone, evidence, offline, and GPS handling                                                                                                                                       |
| DOC-01  | `/app/pod`, governed evidence panels                                                                    | POD tasks, review/submission, secure versioned documents, scoped downloads, ageing, and value-at-risk                                                                                                                                                                                               |
| FIN-01  | `/app/finance`, `/app/finance/invoices`                                                                 | Actionable pending-work dashboard and complete invoice register with exact minor-unit create/edit/submit/approve/reject/post/acknowledge/note/compensating-reversal lifecycle                                                                                                                       |
| FIN-02  | `/app/finance/receipts`                                                                                 | Complete collection and receipt registers with typed capture/allocation/follow-up forms, append-only ledger, exact reconciliation, reversal, ageing, and balances                                                                                                                                   |
| FIN-03  | `/app/finance/vendor-bills`, `/app/finance/payment-runs`                                                | Complete vendor service, bill, and payment-run registers with maker/checker, verified-bank, dispute, deduction, approve/submit/pay/fail/reverse actions, and margin reconciliation                                                                                                                  |
| CTL-01  | `/app/control`                                                                                          | Canonical Placement/POD vs Invoice/Collection/Trip/Vendor Payable lenses with prototype-depth KPIs, bucket filters, client/location/record drill, vendor summaries, ageing guidance, saved views, scoped CSV, contextual actions, and live freshness                                                |
| ALT-01  | `/app/alerts`                                                                                           | Scoped rules, deduplicated evaluation, work queues, acknowledgement, escalation, snooze, resolution, and delivery attempts                                                                                                                                                                          |
| DAT-01  | `/app/data`                                                                                             | Real CSV/XLSX parsing, header/row validation, seven canonical adapters, preview, commit, correction, and reconciliation                                                                                                                                                                             |
| GOV-01  | `/app/governance/policies` and record evidence panels                                                   | Structured policy administration plus documents, visibility-aware comments, role-sequenced approvals, immutable audit, and segregation                                                                                                                                                              |
| INT-01  | `/app/integrations` and owner activation email                                                          | API clients, signed webhooks, delivery/replay, plus encrypted PostgreSQL-leased Amazon SES owner invitations without a separate worker                                                                                                                                                              |
| INT-02  | `/app/assistant`                                                                                        | Session-bound English chat with a closed command catalogue, scoped reference/report/insight reads, confirmation-gated master/operations/finance/approval writes, DAT-01/GOV-01 file handoff, and verified WhatsApp text/media, replies, consent, retry/dead-letter, and proactive-template delivery |
| CFG-01  | `/app/configuration/settings`                                                                           | Typed tenant configuration, semantic validation, versioned publish/rollback, branding, codes, and thresholds                                                                                                                                                                                        |

The detailed fields, calculations, reports, alerts, acceptance criteria, and cross-feature journeys remain in [FEATURES.md](FEATURES.md).

All API-backed mutation forms use the same local outcome contract: the result appears beside the initiating Submit/Save/action button with validation fields and correlation reference where available. A successful create clears the form back to its documented defaults; a successful edit rebases the form to the persisted values; a failure retains non-secret input so it can be corrected in place.

INTERNAL access users and Employee masters are one-to-one within a tenant. Creating an INTERNAL user automatically creates or safely links the Employee at the tenant's active legal-entity root. Creating an Employee may leave it employee-only, link an existing unlinked INTERNAL membership, or create invited access when explicit roles, scopes, actions, destination, expiry, and reason are supplied. Client, vendor, and driver portal identities remain linked to their matching persona masters and do not create Employee records.

### Pending production-adoption TODOs

The Platform Admin tenant console now includes the tenant-user directory, Add user invitation, explicit profile editing, audited current-password step-up for destination reveal and password-reset links, enable/disable controls, tenant configuration editing, and representative onboarding/master data. Organization/branch, client, and vendor names can be edited in Platform context; contracts, imports, and roles remain in their governed workflows. [TODO.md](TODO.md) records the remaining platform-side role/scope editor, invitation reissue/revoke, session/MFA reset, deeper paging/filtering, and missing client/vendor persona-link work.

## Engineering baseline

- TypeScript monorepo managed with `pnpm`
- Next.js frontend in `apps/frontend`
- NestJS backend in `apps/backend`
- PostgreSQL with Prisma migrations
- Vitest for unit/integration tests
- Playwright for browser end-to-end tests
- One central Docker PostgreSQL container shared by this and other local projects

Redis, queues, object storage, Mailpit, and other supporting containers are intentionally excluded. PostgreSQL is the only local infrastructure dependency for now. The decision is documented in [ADR 0001](docs/decisions/0001-application-baseline.md).

## Central PostgreSQL

The project reuses one container named `shared-postgres` and one shared volume. It provisions project-specific roles, databases, and schemas inside that container. Project scripts never stop, reset, or delete the shared container or volume.

```bash
cp .env.example .env
make bootstrap
make postgres-up
```

Default project resources:

- Databases: `logistics`, `logistics_test`
- Schemas in each database: `app`, `audit`, `reporting`
- Application role: `logistics_app`

Other projects may use the same container with their own database/schema names.

Local and E2E bootstrap uses a small deterministic India postal fixture, including `500016`, `560043`, `700001`, and an ambiguous `110001`. It is test data, not the production directory. Production readiness rejects that fixture and requires the checksum-verified offline import described in the AWS section.

## Application commands

```bash
make dev
make check
make deploy-local
make refresh-local
make e2e
make verify
```

`make dev` provides frontend/backend hot reload. A production-style local instance started by `make deploy-local` does not hot reload; after a runtime-code batch, the rapid workflow finishes with one `make refresh-local` to migrate, rebuild every shared package and both apps, restart owned listeners, and verify readiness without reseeding. Documentation, process, agent-instruction, and test-only batches skip this runtime refresh. Test commands (`make check`, `make e2e`, and `make verify`) remain explicit batch/release actions. Review is risk-based: localized reversible work uses a focused self-review, while cross-module or protected authorization/tenant/finance/migration/secret/external-side-effect changes receive one bounded independent review.

See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) for setup and [docs/SDLC.md](docs/SDLC.md) for the feature workflow.

### Conversational Assistant

Tenant Owners can grant `conversation.use` and open <http://127.0.0.1:3000/app/assistant>. The Assistant always derives the user, active tenant, membership, role and scope from the authenticated session. It does not accept those security fields from chat text. The closed English command catalogue supports probe create/update, governed comments, client/vendor creation, receipt recording, operations and finance status changes, approval decisions, import preview/commit, governed-document upload, scoped reference search, status reports, and operational attention summaries. Missing or ambiguous references produce clarification; reads execute immediately, while every write displays a normalized proposal and requires explicit confirmation. High-risk finance, approval, and import actions require authenticated in-app confirmation.

CSV/XLSX messages use the existing DAT-01 preview and confirmation-gated commit path. Financial datasets whose bulk importer does not yet preserve canonical draft/approval/ledger evidence are rejected at conversational commit and must use the Finance workflow. PDF/JPEG/PNG messages create governed GOV-01 document/version records but remain quarantined with a `PENDING` scan state until a production malware scanner is configured. The UI enforces one attachment up to 5 MB, shows upload/scan state, and never treats attachment contents as instructions.

WhatsApp support is installed but disabled by default:

```dotenv
WHATSAPP_PROVIDER=disabled
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ADDRESS_ENCRYPTION_KEY=
WHATSAPP_ADDRESS_PEPPER=
```

When an approved Meta WhatsApp Business integration is selected, set `WHATSAPP_PROVIDER=meta` and configure `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_ALERT_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANGUAGE`, a random base64-encoded 32-byte `WHATSAPP_ADDRESS_ENCRYPTION_KEY`, and a separate random `WHATSAPP_ADDRESS_PEPPER` of at least 32 characters. Expose the public HTTPS `GET/POST /api/v1/webhooks/whatsapp` endpoint, subscribe the Meta app to message webhooks, and approve an alert template whose three body variables are severity, title, and summary. Restart the backend after configuration.

A Tenant Owner creates a short-lived link challenge in the authenticated Assistant and sends that code from the intended WhatsApp number. The backend verifies the exact raw-body signature before parsing, stores an HMAC lookup plus encrypted address and last four digits—not a plaintext phone number—and binds it to exactly one active membership. It retrieves media only through the Meta Graph API and allow-listed HTTPS provider hosts. Unknown, revoked, or ambiguous bindings fail closed. Low/medium-risk proposals can be confirmed or cancelled by reply; high-risk actions require the authenticated application. Transactional replies and approved-template proactive alerts use a PostgreSQL lease/retry/dead-letter queue. Proactive alerts require explicit `START ALERTS` or web consent, observe tenant-timezone quiet hours, and stop on `STOP`/`UNSUBSCRIBE` or unlink.

Deterministic Hindi/Hinglish and additional Indic-language interpretation, production model-provider evaluation, browser/mobile push delivery, real-provider WhatsApp verification, and production malware scanning remain disabled or pending until their provider credentials, evaluated language corpus, and operational policies are supplied. The English deterministic parser remains the safe fallback.

## Local setup and feature testing

### Prerequisites and first start

Install Git, Docker Desktop/Engine, Node.js 22 LTS, pnpm 11, GNU Make, and `screen`. Homebrew's latest Node release may not bundle Corepack, so install pnpm explicitly:

```bash
brew install node@22 pnpm
brew unlink node 2>/dev/null || true
brew link --overwrite node@22
```

Node.js 22 is the recommended runtime (Node.js 24 is also accepted). Node.js 25+ is not supported by the current Playwright toolchain and can leave full E2E workers waiting after their tests finish. `make bootstrap` checks the runtime version before installing dependencies.

Alternatively, with a Node.js distribution that includes Corepack:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
```

Installing pnpm only installs the package manager; it does **not** install this repository's dependencies or configure its Git hooks. Run the following sequence once after cloning, and run `make bootstrap` again whenever `package.json` or `pnpm-lock.yaml` changes:

```bash
cp .env.example .env
# Replace AUTH_SECRET, PLATFORM_ADMIN_PASSWORD, and MFA_ENCRYPTION_KEY in .env.
make bootstrap
make postgres-up
make deploy-local
make health
```

Do not skip `make bootstrap`: it installs locked dependencies and configures the Git hook. The hook runs the lightweight batch gate (policy/status, formatting, lint, and type checking), not database, browser, or full regression tests.

### Administrator login

Local `make deploy-local` applies migrations and runs the deterministic seed. Unless overridden in `.env`, sign in at <http://127.0.0.1:3000/login> with:

| Field    | Local development value |
| -------- | ----------------------- |
| Email    | `admin@local.test`      |
| Password | `LocalAdmin!234`        |

This is the **Platform Admin** account used to provision and manage tenants. It is not a Tenant Owner account. Each tenant's first Tenant Owner sets their own password through the invitation created during tenant provisioning; Vendor, Driver, Client, and employee users do the same. The password is never emailed or displayed later: after logout, the user signs in with the invitation email/mobile and the password they created.

Local and provider-disabled deployments do not send real email. The AWS deployment can deliver new-tenant owner activation mail through SES when the sender identity, sandbox/production access, EC2 permission, and environment settings below are complete. If the initial owner email is unavailable, open Platform Admin → Tenants → the tenant → **Generate replacement activation link**, enter an audit reason, and copy the one-time link to the owner through a trusted channel. Creating a replacement invalidates the previous link and queues the replacement for SES when enabled. The same tenant detail now shows all tenant memberships, masked activation/security/role facts, derived onboarding checks, tenant-specific profile editing, and **Disable user / Enable user** controls. Accepted login destinations and passwords remain read-only; disabling a membership revokes its tenant sessions and the last usable Tenant Owner cannot be disabled. Tenant Owners retain the advanced role/scope, invitation, MFA, session, and password-recovery workflows under `/app/access/users`; Platform Admin never impersonates them.

An activated user who forgets their password selects **Forgot your password?** at `/login`. The public request always returns the same non-enumerating response and records a rate-limited delivery request; the current provider-free deployment does not claim that email or SMS was sent. A tenant-root identity administrator can instead open the active user in `/app/access/users`, enter an audit reason, select **Generate password reset link**, and copy the one-time link through a trusted channel. Administrator-copy recovery is intentionally blocked for identities active in multiple tenants because changing their shared platform password would affect every workspace; those users require a configured verified delivery provider. Completing any reset invalidates the link, changes the password, and signs the identity out of every active session.

`make deploy-local` reseeds the Platform Admin and therefore resets its password to the current `PLATFORM_ADMIN_PASSWORD` value in `.env`. Never use the committed local default in AWS or any shared environment.

### Reusable end-to-end demo environment

After migrations and the normal Platform Admin seed, install the deterministic demo dataset once:

```bash
make demo-seed
make refresh-local
```

`make demo-seed` loads `.env`, requires `DEMO_DATA_ENABLED=true` internally, and creates or additively upgrades the reserved `DEMO` tenant. Dataset `2026.09.2` is transactionally anchored to `2026-08-31` and recorded in `app.demo_bootstrap_runs` with a content hash. An identical rerun verifies the configured password hashes and exits without changing IDs, timestamps, ledgers, passwords, or sessions. It never creates or changes the Platform Administrator.

Local credentials are intentionally disposable:

| Account              | Email                            | Local password   | Access                                                       |
| -------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------ |
| Platform Admin       | `admin@local.test`               | `LocalAdmin!234` | Platform tenant registry; independently created by `db:seed` |
| Tenant Owner         | `demo.owner@logistics.test`      | `DemoAccess!234` | Full `DEMO` tenant administration                            |
| Traffic / Operations | `demo.operations@logistics.test` | `DemoAccess!234` | Indents, allocations, trips, POD and control tower           |
| Finance Executive    | `demo.finance@logistics.test`    | `DemoAccess!234` | Invoices, receipts, vendor bills and payment runs            |
| Vendor Owner         | `demo.vendor@logistics.test`     | `DemoAccess!234` | Vendor-scoped portal                                         |
| Driver               | `demo.driver@logistics.test`     | `DemoAccess!234` | Assigned-trip driver portal                                  |
| Client Viewer        | `demo.client@logistics.test`     | `DemoAccess!234` | Client-scoped portal                                         |

The shared demo password is rejected in production. Never add it to `/etc/logistics-management.env`. AWS uses the same tenant code and role emails, but its `DEMO_USER_PASSWORD` is a protected environment-specific secret of at least 16 characters. The production Platform Admin continues to use the independently configured `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`.

The `2026.09.2` showcase contains 2 regions, 3 branches, 6 linked internal employees, at least 4 clients, 10 client locations, 5 vendors, 12 vehicles, 10 drivers, 6 lanes, 36 indents, 24 allocations, 18 trips, 14 POD tasks, 18 client invoices, 8 receipts, 14 vendor bills, 5 payment runs, and 12 alerts. The data spans open, progressing, exception, overdue, part-paid, paid, blocked, disputed, failed, reversed, expired, current and upcoming scenarios so every Control Tower lens and primary Operations/Finance workbench has meaningful rows.

Stable walkthrough anchors include:

- Client `DEMO-RETAIL`, locations `BLR-DC` and `HYD-STORE`, contract `DEMO-CONTRACT`, and lane `BLR-HYD`.
- Vendor `DEMO-FLEET`, two synthetic vehicles and two drivers with valid compliance.
- Indents `DEMO-IND-OPEN`, `DEMO-IND-OFFERED`, `DEMO-IND-LIVE`, and `DEMO-IND-DELIVERED`.
- Live trip/LR `DEMO-TRIP-LIVE` / `DEMO-LR-LIVE` and delivered trip/LR `DEMO-TRIP-DONE` / `DEMO-LR-DONE` with closed POD.
- Invoices `DEMO-INV-DRAFT` and `DEMO-INV-POSTED`, partial receipt `DEMO-RCPT-001`, paid vendor bill `DEMO-VBILL-001`, and paid run `DEMO-PAYOUT-001` / UTR `DEMO-UTR-000001`.
- A collection follow-up, acknowledged operational alert/action, saved control view, auto-allocation rule, and import rows with `CREATE`, `UPDATE`, and `REJECT` dispositions.

A concise demonstration flow is:

1. Use Platform Admin to search `DEMO` under `/platform/tenants` and inspect its users/onboarding.
2. Sign in as Tenant Owner and open Operations; search `DEMO-IND-OPEN`, then inspect Truck allocations and Trips.
3. Search the live and delivered records, then open POD and Control to show the same canonical chain.
4. Sign in as Finance Executive; open All invoices, Collections, Vendor payables, and Payment runs and search the stable references above.
5. Sign in separately as Vendor Owner, Driver, and Client Viewer to demonstrate their scoped portals.
6. Open Imports to show the three row dispositions and Alerts/Control to compare multi-row portfolios, risk colours, ageing, exceptions, and saved views.

Running `make demo-seed` again after pulling a newer dataset version performs the additive upgrade; it does not delete user-created demonstration rows. Run `make refresh-local` once afterward so frontend/backend processes serve the newly built UI.

Focused local verification uses real PostgreSQL, backend, frontend, and browser requests:

```bash
set -a; source .env; set +a
pnpm --filter @logistics/db exec vitest run \
  src/demo-seed-config.test.ts src/demo-seed.integration.test.ts
pnpm exec playwright test tests/e2e/demo-data.spec.ts --project=chromium
```

Do not use a demo tenant for real business data. Normal deployments never seed, reset, or rotate it. To rotate all AWS demo-user passwords, change the protected `DEMO_USER_PASSWORD`, run the production command below with `DEMO_ROTATE_PASSWORD=true`, and clear that one-shot flag afterward; the bootstrap increments authentication versions and revokes existing demo sessions. To take the demo offline without destructive shared-database cleanup, deactivate tenant `DEMO` from the Platform Admin screen.

### Jurigari production demonstration profile

The dedicated `JG` profile reuses the rich canonical demo graph without changing `db:seed`, `demo:seed`, first-time deployment, or recurring deployment. It is an explicit operator action and never stores or prints its password. The only main users are active INTERNAL Tenant Owners linked to Employee records:

| Name                 | Login email              |
| -------------------- | ------------------------ |
| Piyana Bandyopadhyay | `piyana10@gmail.com`     |
| Siddhartha           | `siddhartha09@gmail.com` |

The operator supplies their shared `JURIGARI_USER_PASSWORD` privately. There is no password in Git or this README. The stable chain is Tata Consumer Products Ltd (`TCPL`) → Kunigal (`TCPL-KUN`) → Sahil Roadlines (`VEN-0142`) → indent `IND-4231` → vehicle `KA 25 AB 4471` → LR `JGL/24118` → invoice `INV-26-3427` → receipt `RCP-2026-0881`. Invoice minor units reconcile as `28,400,000 + 1,420,000 = 29,820,000`; receipt is `15,000,000`, deduction `840,000`, and remaining invoice balance `14,820,000`.

For local or test installation, put `JURIGARI_USER_PASSWORD` and the existing `MFA_ENCRYPTION_KEY` in the protected `.env`, then run:

```bash
make jurigari-seed
make jurigari-verify
```

The first command requires the normal seeded Platform Admin. Replay of the same version/hash is a no-op; a code, email, or same-version content collision fails transactionally. Verification prints only secret-free counts and reconciliation. The AWS-only adoption controls can reuse a normally provisioned `JG` tenant only when the operator supplies the exact tenant, legal entity, root organization, tenant scope, legal scope, and Piyana invitation-membership UUIDs; the seed verifies that complete graph before materialization.

In local/test environments, `http://localhost:3000` and `http://127.0.0.1:3000` are treated as equivalent loopback origins on the configured port. Production accepts only the exact HTTPS origin configured in `FRONTEND_URL`.

Tenant primary and accent colors may use any valid six-digit hex value. Tenant-branded surfaces automatically select black or white foreground text for WCAG AA contrast; administrators do not need to alter a valid brand color merely to match a fixed text color.

Mobile fields accept common spaces, hyphens, dots, and parentheses and normalize them to E.164 for storage. Include the leading country code and `+`; for example, `+91 7766974950` is stored as `+917766974950`.

If a commit reports `rg: command not found`, pull the current scripts: the policy check no longer depends on ripgrep. If it reports `pnpm: command not found` or missing packages, install pnpm and run `make bootstrap`. A later PostgreSQL `42P01 relation "app.users" does not exist` in the attached log was a concurrent test-database reset, not a pnpm installation failure; wait for the other test/commit process to finish and rerun the commit once.

### Recommended manual flow

1. Sign in as Platform Admin, open `/platform/tenants`, provision a tenant, and use the local invitation link to activate its Tenant Owner. Reopen that tenant to add users, search memberships, reveal a login destination after password step-up, generate a copy-once reset link, edit tenant/user/master details, inspect onboarding/security evidence, or disable/re-enable a user with an audit reason.
2. As Tenant Owner, the successful login opens Control Tower by default. Open **Indent & Truck Allocation** under Operations or **User & Access**, Roles, and **Activity & Audit** under Administration; on mobile use the three role-aware bottom destinations or **More** for the full menu. Complete any outstanding onboarding at `/app/setup`, then create scoped users and roles under `/app/access/users` and `/app/access/roles`.
3. Build master data in dependency order: organization/employees → client/location/contract/lane/rate → vendor/vehicle/driver/compliance.
4. Open `/app/operations`. Its landing dashboard is the complete open-indent register: create or edit an indent, cancel eligible demand, or select **Allocate truck** directly on the row. Use the Allocations tab for offer acceptance/rejection, vehicle/driver assignment or replacement, NTP/placement/cancellation, auto-allocation rules, and trip creation. Use the Trips tab for the contextual Accept, Start, Load, Transit, Arrival, Unload, End, and exception actions.
5. Open **Dashboard** under Finance. Its landing dashboard shows actionable pending invoice, collection, vendor-payable, unbilled-service, and payout-run queues. Use **Invoices** for the complete filtered register and create/edit/submit/approve/reject/post/acknowledge/note/reverse lifecycle; **Collection & Receipt** for receipt capture/allocation and follow-ups; **Vendor Payable** for bill verification/approval/dispute; and **Payout Runs** for approve/submit/paid/fail/reverse actions.
6. Reconcile the same records in `/app/control`. The Placement, POD vs Invoice, Collection, Trip, and Vendor Payable lenses use canonical records and support KPI/bucket filtering, client → location → record drill-down, ageing guidance, saved views, live/pause freshness, vendor summaries, and visible-scope CSV. Continue exception, data, policy, and connector work in `/app/alerts`, `/app/data`, `/app/governance/policies`, and `/app/integrations`.
7. Invite Vendor, Driver, and Client users and verify their restricted `/portal/vendor`, `/portal/driver`, and `/portal/client` views.

Use unique codes and idempotency keys when repeating mutations. The UI creates these keys automatically; API clients must send `Idempotency-Key` where required.

Tenant provisioning automatically creates the company/default legal entity as the first canonical `LEGAL_ENTITY` organization node, its authorization scope, and its hierarchy closure row. The Organization checklist therefore starts complete from real master data; migration `202608250027_tenant_legal_entity_root` safely repairs older tenants missing that root. The remaining setup checklist derives completion from live tenant records and covers Users, Branches, Clients, Vendors, Commercial settings, Imports, and Branding. Its isolation-record panel provides both a sample CSV showing the export columns and a current-tenant-only CSV export.

### Explicit batch/release test flows

These commands are not automatic per-feature gates. Run the smallest scope explicitly requested, once:

```bash
# Non-browser batch test suite
make check

# Full desktop/mobile Playwright regression (release request only)
make e2e

# One feature or cross-feature journey
pnpm exec playwright test tests/e2e/all-feature-gaps.spec.ts \
  --project=chromium --grep "E2E-GAP-MST02-01"

# Foundation and access journeys
pnpm exec playwright test tests/e2e/fnd-01-tenant-foundation.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/fnd-02-identity-access.spec.ts --project=chromium

# Operations, Finance, and Control Tower workbenches
pnpm exec playwright test tests/e2e/operations-workbench.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/finance-workbench.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/control-tower-workbench.spec.ts --project=chromium
```

Playwright uses the deployed frontend/backend and PostgreSQL. It does not mock business APIs or write directly to business tables. Generated reports remain ignored under `playwright-report/` and `test-results/`.

Record failures in `BUGS.md`/`TODO.md`; do not automatically fix, retry, or rerun unless asked.

## AWS EC2 + RDS deployment and GitHub CI/CD

This is a low-cost single-instance starting topology: Nginx, Next.js, and NestJS on one EC2 instance; PostgreSQL on private Single-AZ RDS; GitHub Actions deploys through AWS Systems Manager. It intentionally adds no Redis, queue, object-storage, NAT Gateway, load balancer, or separate worker.

### 1. Understand the current Free Tier

AWS accounts created on or after July 15, 2025 use the credit-based Free Tier: new customers receive initial credits, and the Free account plan ends after six months or when credits are exhausted. It is not an unlimited free production environment. Check the live [AWS Free Tier guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html), [EC2 eligibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html), and [RDS eligibility](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html) before creating resources.

- Start with one Free-Tier-marked `t3.micro` Ubuntu 24.04 EC2 instance, 20 GiB `gp3`, and a 2 GiB swap file. A `t3.small` is more comfortable for builds but can consume credits faster.
- Use PostgreSQL on Single-AZ `db.t4g.micro` or `db.t3.micro` with 20 GiB `gp3`, no provisioned IOPS, and storage autoscaling disabled initially.
- RDS, snapshots beyond the included allowance, DNS registration, data transfer, and public IPv4 can consume credits or incur charges. Create AWS Budgets alerts before deploying.

### 2. Secure the account and budget

1. Enable MFA for the root user, create an administrative IAM identity, and stop using root for daily work.
2. In Billing → Budgets, create a small monthly cost budget plus actual and forecast email alerts. Also enable Free Tier usage alerts.
3. Choose one Region close to users and keep EC2, RDS, Systems Manager, and the deployment IAM role there.

### 3. Create networking and security groups

The default VPC is adequate for this first deployment. Create:

- `logistics-ec2-sg`: inbound TCP 80 and 443 from the internet; no inbound 22 is required because administration and deployment use Session Manager.
- `logistics-rds-sg`: inbound TCP 5432 only from `logistics-ec2-sg`; never from `0.0.0.0/0`.
- Keep RDS `Public access` set to `No`. EC2 and RDS must be in the same VPC; AWS can configure the EC2-to-RDS security-group relationship from the RDS console.

The repository can create this exact footprint from an administrator workstation with AWS CLI v2 and `jq`. It reuses the default VPC, creates only the EC2/RDS security groups, DB subnet group, SSM instance role/profile, one EC2 instance, and one private RDS instance. The RDS password is prompted and is not saved by the script:

```bash
export AWS_REGION=eu-north-1
export EC2_KEY_NAME=ControlTower       # existing AWS EC2 key-pair name
export ADMIN_CIDR='203.0.113.10/32'    # optional SSH; omit when using SSM only
./scripts/provision-aws-infrastructure.sh
```

Optional size/name overrides are `EC2_INSTANCE_TYPE`, `RDS_INSTANCE_CLASS`, `RDS_INSTANCE_ID`, `RDS_DATABASE_NAME`, and `APP_NAME`. The defaults are `t3.micro`, `db.t3.micro`, `logistics-postgres`, `logistics`, and `logistics-management`. Review current regional eligibility and pricing before running it.

### 4. Create PostgreSQL RDS

1. RDS → Create database → Standard create → PostgreSQL.
2. Choose the Free-Tier-marked template/class, Single-AZ, 20 GiB `gp3`, and a generated master password. Under **Additional configuration**, set **Initial database name** to `logistics`. The DB instance identifier (for example `database-1`) is not the PostgreSQL database name.
3. Place it in the same VPC, attach `logistics-rds-sg`, disable public access, enable deletion protection, automated backups, and encryption at rest.
4. Record the exact private RDS **Endpoint** from **Connectivity & security** (for example `database-1.cngus0cc0c50.eu-north-1.rds.amazonaws.com`) and port `5432`. The “Connected compute resources” panel confirms security-group routing only; it does not configure the application's database URL.

After EC2 exists, connect through Session Manager and verify DNS/network/TLS from that EC2 instance. Keep the download URL and `export` on separate commands; the correct CA URL ends in `.pem`, not `.pemexport`:

```bash
curl -fsSLo /tmp/aws-rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sudo install -o root -g root -m 0644 \
  /tmp/aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem
rm -f /tmp/aws-rds-global-bundle.pem
sudo test -r /etc/ssl/certs/aws-rds-global-bundle.pem
sudo -u logistics test -r /etc/ssl/certs/aws-rds-global-bundle.pem
ls -l /etc/ssl/certs/aws-rds-global-bundle.pem

export RDSHOST='database-1.cngus0cc0c50.eu-north-1.rds.amazonaws.com'
getent hosts "$RDSHOST"
pg_isready -h "$RDSHOST" -p 5432 -t 10
```

Replace the example endpoint with the exact endpoint from your RDS console. `pg_isready` should report `accepting connections`. If it times out, then inspect VPC/security-group/routing; if it succeeds, networking is working and any later failure is credentials, database name, TLS, or application configuration.

Connect as the RDS master user with certificate verification. The console's sample command uses the default `postgres` database; first confirm whether the required application database exists:

```bash
read -rsp 'RDS master password: ' PGPASSWORD; echo
export PGPASSWORD
psql "host=$RDSHOST port=5432 dbname=postgres user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user, inet_server_addr();"
psql "host=$RDSHOST port=5432 dbname=postgres user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -tAc "SELECT datname FROM pg_database WHERE datname='logistics';"
```

Run these as literal shell commands, not as Markdown-escaped text: do not add a standalone `\`, do not change a line continuation to `\\`, and use `pg_database` rather than `pg\_database`. The one-line `psql` commands above avoid line-continuation copy errors.

If the second command prints nothing because **Initial database name** was left blank, create it once:

```bash
createdb --maintenance-db="host=$RDSHOST port=5432 dbname=postgres user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" logistics
```

Then connect to `logistics` and create separate non-master runtime and postal-import roles. The block is safe to repeat. Use PostgreSQL's interactive `\password` command afterward so credentials do not enter SQL history; the backend never receives the importer credential:

```sql
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_postal_owner') THEN
    CREATE ROLE logistics_postal_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
    CREATE ROLE logistics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_postal_importer') THEN
    CREATE ROLE logistics_postal_importer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$roles$;
ALTER ROLE logistics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE logistics_postal_importer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE logistics TO logistics_app;
GRANT CONNECT ON DATABASE logistics TO logistics_postal_importer;
\password logistics_app
\password logistics_postal_importer
```

Use three different generated passwords for the RDS master, `logistics_app`, and `logistics_postal_importer`. Hexadecimal output from `openssl rand -hex 32` is already URL-safe; otherwise percent-encode special characters before placing a password in a PostgreSQL URL. A Prisma `P1000` error means the URL password does not match the role password (or the login role is absent), not that RDS networking or TLS failed. If credentials were temporarily reused during recovery, rotate the master and both application roles after readiness is restored.

Run the SQL through the verified master connection from the EC2 Session Manager shell (the prompt should resemble `ubuntu@ip-172-31-...`), not from a local macOS/zsh terminal. The RDS endpoint is private to the VPC. Then clear the master password:

```bash
psql "host=$RDSHOST port=5432 dbname=logistics user=postgres sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -v ON_ERROR_STOP=1
unset PGPASSWORD
```

### 5. Create and bootstrap EC2

1. In IAM, create an EC2 role with `AmazonSSMManagedInstanceCore`; attach it to the instance.
2. Launch an Ubuntu Server 24.04 LTS `t3.micro` in the same VPC with `logistics-ec2-sg`, the IAM role, encrypted 20 GiB `gp3`, and tags `Application=logistics-management`, `Environment=production`.
3. Connect using EC2 → Connect → Session Manager. Ubuntu AWS AMIs normally include SSM Agent; verify it with `systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service` or `systemctl status amazon-ssm-agent`.
4. Install the runtime and add swap. EC2 uses RDS and therefore does not need Docker:

```bash
sudo apt-get update
sudo apt-get install -y git nginx postgresql-client curl build-essential jq
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo useradd --system --create-home --shell /bin/bash logistics
sudo mkdir -p /opt/logistics-management
sudo chown logistics:logistics /opt/logistics-management
```

Clone the repository into `/opt/logistics-management`. For a private repository, add a read-only GitHub deploy key to the EC2 `logistics` user; do not place a personal access token in Git configuration.

```bash
sudo -u logistics git clone git@github.com:GITHUB_OWNER/GITHUB_REPOSITORY.git /opt/logistics-management
sudo -u logistics bash -lc 'cd /opt/logistics-management && make bootstrap-production'
```

`make bootstrap-production` installs the locked workspace dependencies and performs repository policy checks without requiring the local Docker/PostgreSQL stack. The recurring GitHub deployment also installs the exact lockfile before migration and build.

For a new Ubuntu instance, the preferred automated path installs the runtime, creates the deployment user and swap, clones the requested revision, creates the database roles, generates runtime secrets, installs the pinned postal directory, migrates/builds/seeds, configures systemd and Nginx, and verifies readiness. Run it from the repository checkout or copy the script to the host first:

```bash
sudo REPOSITORY_URL='git@github.com:GITHUB_OWNER/GITHUB_REPOSITORY.git' \
  RDS_HOST='database-1.REPLACE_REGION.rds.amazonaws.com' \
  PUBLIC_ORIGIN='http://EC2_PUBLIC_IP' \
  PLATFORM_ADMIN_EMAIL='admin@example.com' \
  SES_FROM_EMAIL='mukh.bad@gmail.com' \
  AWS_REGION='eu-north-1' \
  ./scripts/setup-aws-instance.sh
```

It prompts for the Platform Admin password and RDS master password without echoing either. A private Git repository requires the `logistics` account to have a read-only GitHub deploy key. Re-running against an existing checkout fetches the selected `REPOSITORY_REF` (default `main`) and performs the complete setup idempotently.

### 6. Configure application secrets and services

```bash
cd /opt/logistics-management
sudo cp deploy/aws/app.env.example /etc/logistics-management.env
sudo chown root:logistics /etc/logistics-management.env
sudo chmod 640 /etc/logistics-management.env

# Generate values before editing the file:
openssl rand -hex 32
openssl rand -base64 32  # MFA_ENCRYPTION_KEY: 44 base64 characters ending in =
sudoedit /etc/logistics-management.env

sudo cp deploy/aws/logistics-backend.service /etc/systemd/system/
sudo cp deploy/aws/logistics-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable logistics-backend.service logistics-frontend.service
```

Set `FRONTEND_URL` to the final HTTPS origin, keep `BACKEND_URL=http://127.0.0.1:4000`, set `APP_ENV=production`, keep `ENABLE_TEST_HOOKS=false`, URL-encode both database passwords, and use the private RDS endpoint in `DATABASE_URL` and `POSTAL_IMPORT_DATABASE_URL`. The two URLs must use `logistics_app` and `logistics_postal_importer` respectively. Do not copy `.env.example`, because it contains local `127.0.0.1` database URLs.

For the endpoint shown in the example above, the relevant lines would have this shape (replace both encoded passwords):

```dotenv
DATABASE_URL='postgresql://logistics_app:ENCODED_RUNTIME_PASSWORD@database-1.cngus0cc0c50.eu-north-1.rds.amazonaws.com:5432/logistics?schema=app&sslmode=require&sslcert=/etc/ssl/certs/aws-rds-global-bundle.pem&sslaccept=strict'
POSTAL_IMPORT_DATABASE_URL='postgresql://logistics_postal_importer:ENCODED_IMPORT_PASSWORD@database-1.cngus0cc0c50.eu-north-1.rds.amazonaws.com:5432/logistics?schema=app&sslmode=require&sslcert=/etc/ssl/certs/aws-rds-global-bundle.pem&sslaccept=strict'
SSL_CERT_FILE=/etc/ssl/certs/aws-rds-global-bundle.pem
```

Prisma uses `sslcert` for the server CA file, whereas `psql`/libpq uses `sslrootcert`. `SSL_CERT_FILE` also supplies the CA to Prisma's migration/runtime OpenSSL process. Keep `sslaccept=strict`; do not use `sslmode=no-verify` in production.

The file is sourced by Bash. Every comment must start with `#`; `:#` is treated as a command and causes `:#: command not found`. Keep URLs/secrets inside single quotes, do not add spaces around `=`, and do not paste Markdown formatting into the file. `MFA_ENCRYPTION_KEY` must come from `openssl rand -base64 32`; do not use the hexadecimal generator intended for `AUTH_SECRET`. Validate the file before any install/migration/build command:

```bash
sudo -u logistics /opt/logistics-management/scripts/validate-production-env.sh \
  /etc/logistics-management.env
```

The validator reports the malformed line without printing secrets and rejects `localhost`, `127.0.0.1`, placeholder endpoints, incorrect database users, missing TLS verification, and an incorrect database name.

The reviewed **All India Pincode Directory till last month** CSV from the Department of Posts [official OGD resource page](https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month) is pinned at `data/postal/india-post-pincode-directory-ogd-2025-10-03.csv`. It contains 165,627 source records, imports as 165,619 canonical rows after deterministic duplicate removal, and has SHA-256 `701ee84ba125a914e7ffc979c0308b3a041b8adffa85ec9d5f4e0579ecf062e5`. The application never downloads data at runtime. The first-setup script verifies and installs this file automatically. For an existing instance, copy and protect it as follows:

```bash
# Administrator workstation (macOS):
openssl dgst -sha256 data/postal/india-post-pincode-directory-ogd-2025-10-03.csv
scp -i aws/ControlTower.pem data/postal/india-post-pincode-directory-ogd-2025-10-03.csv \
  ubuntu@YOUR_EC2_PUBLIC_DNS:/tmp/india-post-pincode-directory.csv

# EC2 Session Manager or SSH shell:
sudo install -d -o root -g logistics -m 0750 /opt/logistics-secrets
sudo install -o root -g logistics -m 0640 \
  /tmp/india-post-pincode-directory.csv \
  /opt/logistics-secrets/india-post-pincode-directory.csv
sudo -u logistics sha256sum \
  /opt/logistics-secrets/india-post-pincode-directory.csv
```

Set the resulting digest and source release metadata in `/etc/logistics-management.env`: `POSTAL_DIRECTORY_SHA256`, `POSTAL_DIRECTORY_VERSION`, `POSTAL_DIRECTORY_SOURCE_NAME`, `POSTAL_DIRECTORY_SOURCE_URI`, and `POSTAL_DIRECTORY_IMPORTED_BY`. Use a stable version such as `ogd-YYYY-MM-DD` from the resource metadata, not `latest`. The importer validates the checksum, expected `logistics` database, separate PostgreSQL identity, minimum production row count, and source metadata before atomically activating a version.

Allow only the deployment account to restart these two services:

```bash
sudo visudo -f /etc/sudoers.d/logistics-deploy
```

Add this single line:

```text
logistics ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart logistics-backend.service logistics-frontend.service, /usr/bin/systemctl is-active --quiet logistics-backend.service, /usr/bin/systemctl is-active --quiet logistics-frontend.service
```

Before the first seed, replace `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` in `/etc/logistics-management.env`. Use a real operations mailbox and a unique password of at least 12 characters; production startup rejects the committed local password. Then apply migrations as the application role. Using a temporary RDS-master connection that is never written to the application environment, perform the one-time idempotent ownership handoff; this moves the reference tables and guard into `postal_reference`, owned by the NOLOGIN role, so the runtime cannot disable the immutability controls.

The preferred first-deployment command performs the ownership handoff, verifies it, imports and activates the checksum-pinned CSV, restarts both services, and waits for readiness. It prompts once for the RDS master password without echoing or storing it:

```bash
sudo /opt/logistics-management/scripts/bootstrap-aws-postal.sh
```

The default RDS master username is `postgres`. If a different username was selected, run `sudo RDS_MASTER_USER=YOUR_USER /opt/logistics-management/scripts/bootstrap-aws-postal.sh`. The equivalent manual commands are retained below for recovery and auditability.

```bash
sudo -u logistics /opt/logistics-management/scripts/validate-production-env.sh /etc/logistics-management.env
sudo -u logistics bash -lc 'cd /opt/logistics-management && set -a && source /etc/logistics-management.env && set +a && corepack pnpm run db:migrate'

# Run interactively from the Session Manager shell. Do not save the master URL.
read -rsp 'RDS master PostgreSQL URL: ' RDS_MASTER_URL; echo
psql "$RDS_MASTER_URL" -v ON_ERROR_STOP=1 \
  -f /opt/logistics-management/scripts/sql/postal-ownership-handoff.sql
unset RDS_MASTER_URL

sudo -u logistics bash -lc 'cd /opt/logistics-management && set -a && source /etc/logistics-management.env && set +a && pnpm --filter @logistics/db postal:verify-ownership && pnpm --filter @logistics/db postal:import -- --file "$POSTAL_DIRECTORY_FILE" --version "$POSTAL_DIRECTORY_VERSION" --sha256 "$POSTAL_DIRECTORY_SHA256" --source-name "$POSTAL_DIRECTORY_SOURCE_NAME" --source-uri "$POSTAL_DIRECTORY_SOURCE_URI" --imported-by "$POSTAL_DIRECTORY_IMPORTED_BY" --activate true && pnpm run build && pnpm run db:seed'
sudo systemctl start logistics-backend.service logistics-frontend.service
```

`APP_ENV=production` makes the workspace command wrapper preserve the variables sourced from `/etc/logistics-management.env`; it must never reload the repository's local `.env`, whose PostgreSQL host is normally `127.0.0.1`. On an older checkout that predates this protection, bypass the wrapper for the migration:

```bash
sudo -u logistics bash -lc 'set -euo pipefail; cd /opt/logistics-management; set -a; source /etc/logistics-management.env; set +a; corepack pnpm --filter @logistics/db run db:migrate'
```

The handoff is required once for a blank RDS database and is safe to repeat. Recurring GitHub deployments verify ownership and stop before import/restart if it is missing; they do not require or store the RDS master password.

AWS RDS master users have `rds_superuser`, not PostgreSQL's unrestricted superuser. The handoff script therefore grants the master temporary membership in the existing `logistics_app` owner and target `logistics_postal_owner`, performs the transfer inside one transaction, resets the role, and revokes both memberships before commit. Do not replace the script with bare `ALTER ... OWNER` commands; those fail with `must be owner` or `must be able to SET ROLE` on RDS.

After Nginx and TLS are configured, sign in at `https://YOUR_DOMAIN/login` using the exact production `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` that were present for this seed. There is no universal production password and the local `admin@local.test` account is not created unless you explicitly configure it—which you must not do.

The seed upserts the Platform Admin by email and rewrites its password hash. To rotate that bootstrap password, update `PLATFORM_ADMIN_PASSWORD` in the protected environment file and run `pnpm run db:seed` once from a Session Manager shell. Do not run the seed on every deployment. Tenant users continue to authenticate with their invitation-created credentials and MFA policy, independently of this Platform Admin.

#### Configure Amazon SES owner-invitation email

This deployment uses Amazon SES in the same region as the application (`eu-north-1`) and the EC2 instance profile—never a committed AWS access key. The temporary sender selected for this account is `mukh.bad@gmail.com`. A verified domain should replace it later for stronger branding and mail authentication.

1. Open AWS Console → Amazon SES → **Identities** in Europe (Stockholm) → **Create identity** → Email address. Enter `mukh.bad@gmail.com`, create it, then open the AWS verification message in that Gmail inbox and select the verification link. SES identities are regional; verification in another region does not satisfy `eu-north-1`.
2. Open SES → **Account dashboard**. A new account is in the sandbox (this account currently shows 200 messages/day and 1 message/second). Sandbox sending works only to verified recipients or the SES mailbox simulator. From **Get set up**, request production access for transactional mail before inviting arbitrary tenant-owner addresses. Describe the mail as requested account-activation messages, state that recipients are supplied by a Platform Admin during tenant onboarding, and confirm that bounces/complaints will be monitored. Do not claim production sending until AWS approves it.
3. Attach a least-privilege inline policy to the EC2 instance role (currently `LogisticsEc2SsmRole`). Copy `deploy/aws/ec2-ses-send-policy.json`, replacing the region, account ID, and verified identity placeholders. Name the inline policy `LogisticsSesOwnerInvitationSend`. It grants only `ses:SendEmail` from that identity; the GitHub deployment role does not need SES sending permission.
4. Generate a dedicated envelope key once and add the following protected settings to `/etc/logistics-management.env`. Do not rotate this key while invitations are queued; reissue any pending invitations before an approved rotation.

```bash
openssl rand -base64 32
sudoedit /etc/logistics-management.env
```

```dotenv
EMAIL_DELIVERY_PROVIDER=ses
AWS_REGION=eu-north-1
SES_FROM_EMAIL=mukh.bad@gmail.com
EMAIL_TOKEN_ENCRYPTION_KEY='REPLACE_WITH_THE_GENERATED_44_CHARACTER_BASE64_VALUE'
INVITATION_DELIVERY_POLL_SECONDS=15
INVITATION_DELIVERY_MAX_ATTEMPTS=3
```

For a brand-new host, pass `SES_FROM_EMAIL='mukh.bad@gmail.com'` and `AWS_REGION='eu-north-1'` to `scripts/setup-aws-instance.sh`; it generates and protects the envelope key automatically. Omitting `SES_FROM_EMAIL` leaves delivery disabled and retains the audited manual replacement-link flow.

5. Pull/deploy the migration and backend code, validate configuration, restart, and inspect only sanitized service output:

```bash
sudo -u logistics /opt/logistics-management/scripts/validate-production-env.sh \
  /etc/logistics-management.env
sudo /opt/logistics-management/scripts/update-aws-deployment.sh
sudo systemctl is-active logistics-backend.service
sudo journalctl -u logistics-backend.service -n 100 --no-pager
```

6. In the SES sandbox, first use a separately verified recipient and create a disposable tenant. Tenant detail should move from queued to delivered after SES accepts the message. `DELIVERED` means accepted by SES, not proven inbox placement. Existing invitations created before this migration have no recoverable delivery token; use **Generate replacement activation link** once to rotate and queue them safely. After production access is approved, repeat with a real tenant-owner mailbox.

The invitation token is AES-GCM encrypted only while pending and is cleared after terminal completion. It is never stored in plaintext, added to the outbox/audit/logs, or returned by production tenant creation. SES owner-invitation delivery does not yet send general user invitations or password-reset mail; those continue to use the audited copy-once administrator flow described above.

### 7. Verify services before Nginx or DNS

Both applications intentionally listen only on EC2 loopback until Nginx is configured. Run these checks only after the production build completes. From the EC2 Session Manager shell, verify the build artifacts, units, listeners, and complete frontend-to-database path:

```bash
test -f /opt/logistics-management/apps/backend/dist/main.js && echo 'backend build present'
test -f /opt/logistics-management/apps/frontend/.next/BUILD_ID && echo 'frontend build present'

sudo systemctl is-active logistics-backend.service logistics-frontend.service
sudo systemctl status --no-pager --full logistics-backend.service logistics-frontend.service
sudo ss -lntp | grep -E '127\.0\.0\.1:(3000|4000)'

# Process-only backend liveness.
curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:4000/api/v1/health/live | jq

# Backend + RDS + migrations + production postal data/ownership readiness.
curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:4000/api/v1/health/ready | jq

# Frontend rendering.
curl --fail --silent --show-error --output /dev/null \
  --write-out 'frontend /login HTTP %{http_code}\n' \
  http://127.0.0.1:3000/login

# Full frontend rewrite -> backend -> RDS readiness path.
curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:3000/api/v1/health/ready | jq
```

Expected results are both units `active`, listeners only on `127.0.0.1:3000` and `127.0.0.1:4000`, liveness `{ "status": "ok", "service": "backend" }`, readiness with `status: "ready"` and `database: "connected"`, and `/login` HTTP `200`. A working backend liveness probe with a failing readiness probe means the process is up but a database migration, production postal import, or ownership handoff is incomplete. Inspect without exposing secrets:

```bash
sudo journalctl -u logistics-backend.service -n 100 --no-pager
sudo journalctl -u logistics-frontend.service -n 100 --no-pager
```

Diagnose a backend `503 NOT_READY` in prerequisite order:

```bash
sudo -u logistics bash -lc 'set -euo pipefail; cd /opt/logistics-management; set -a; source /etc/logistics-management.env; set +a; corepack pnpm --filter @logistics/db exec prisma migrate status'
sudo -u logistics bash -lc 'set -euo pipefail; cd /opt/logistics-management; set -a; source /etc/logistics-management.env; set +a; corepack pnpm --filter @logistics/db run postal:verify-ownership'
sudo -u logistics bash -lc 'set -euo pipefail; set -a; source /etc/logistics-management.env; set +a; test -r "$POSTAL_DIRECTORY_FILE"; printf "%s  %s\n" "$POSTAL_DIRECTORY_SHA256" "$POSTAL_DIRECTORY_FILE" | sha256sum --check --status; echo "postal source and checksum present"'
```

All three must pass, and the configured postal directory must already have been imported and activated with the production import command in the preceding section.

An old checkout may fail the full production import with Prisma `P2028` after exactly five seconds. The current importer keeps the entire activation atomic but gives this one bounded transaction up to five minutes for the 100,000+ row RDS load. Pull the current code; do not split the import into partially committed batches or raise application-wide transaction timeouts.

Ports 3000 and 4000 should not be opened in the EC2 security group. External browser access begins only after Nginx proxies ports 80/443.

If either build check prints nothing, stop the restart loop, build with the protected production environment, and then start both units:

```bash
sudo systemctl stop logistics-backend.service logistics-frontend.service
sudo systemctl reset-failed logistics-backend.service logistics-frontend.service
sudo -u logistics bash -lc 'set -euo pipefail; cd /opt/logistics-management; set -a; source /etc/logistics-management.env; set +a; corepack pnpm run build'
test -f /opt/logistics-management/apps/backend/dist/main.js && echo 'backend build present'
test -f /opt/logistics-management/apps/frontend/.next/BUILD_ID && echo 'frontend build present'
sudo systemctl start logistics-backend.service logistics-frontend.service
```

### 8. Configure Nginx and verify public access

The committed Nginx server is a port-80 default server (`server_name _`) so it works immediately with either the EC2 public IP or public DNS. Ensure the EC2 security group permits inbound TCP 80, then install it. Keep ports 3000 and 4000 bound to loopback and closed in the security group.

```bash
sudo cp deploy/aws/nginx.conf /etc/nginx/sites-available/logistics-management
sudo ln -sfn /etc/nginx/sites-available/logistics-management /etc/nginx/sites-enabled/logistics-management
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

curl -fsS -o /dev/null -w 'public IP login HTTP %{http_code}\n' \
  http://YOUR_EC2_PUBLIC_IP/login
curl -fsS http://YOUR_EC2_PUBLIC_DNS/api/v1/health/ready | jq
```

Run the same two URLs from a workstation outside AWS and open `http://YOUR_EC2_PUBLIC_IP/login` in a browser. HTTP 200 on `/login` proves public Nginx → frontend connectivity; `status: ready` proves public Nginx → backend → RDS connectivity. A 503 readiness response is not an Nginx failure—run the three prerequisite diagnostics in section 7. Production authentication uses secure cookies, so plain HTTP is only a smoke test; complete login requires HTTPS.

If no domain is available yet, Certbot 5.4 or newer can request a publicly trusted, short-lived Let's Encrypt certificate for the EC2 public IP. These certificates last about six days, so automatic renewal is mandatory. Keep inbound TCP 80 open for ACME HTTP validation and TCP 443 open for the application. The committed `nginx-self-signed.conf` provides the validation webroot during issuance; after issuance, install `nginx-ip-certificate.conf`, replacing its example IP path when the EC2 address differs.

```bash
sudo install -d -o root -g root -m 0700 /etc/nginx/tls
sudo openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 \
  -keyout /etc/nginx/tls/logistics-self-signed.key \
  -out /etc/nginx/tls/logistics-self-signed.crt \
  -subj '/CN=YOUR_EC2_PUBLIC_IP' \
  -addext 'subjectAltName=IP:YOUR_EC2_PUBLIC_IP'
sudo chmod 0600 /etc/nginx/tls/logistics-self-signed.key
sudo chmod 0644 /etc/nginx/tls/logistics-self-signed.crt
sudo cp deploy/aws/nginx-self-signed.conf /etc/nginx/sites-available/logistics-management
sudo nginx -t
sudo systemctl reload nginx

sudo snap install certbot --classic
sudo install -d -o www-data -g www-data -m 0755 \
  /var/www/certbot/.well-known/acme-challenge
sudo certbot certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/certbot \
  --ip-address YOUR_EC2_PUBLIC_IP

# Replace 13.61.27.202 in this file if the instance uses another address.
sudo cp deploy/aws/nginx-ip-certificate.conf \
  /etc/nginx/sites-available/logistics-management
sudo install -d -o root -g root -m 0755 \
  /etc/letsencrypt/renewal-hooks/deploy
sudo install -o root -g root -m 0755 \
  deploy/aws/certbot-reload-nginx.sh \
  /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run --run-deploy-hooks
curl -fsS https://YOUR_EC2_PUBLIC_IP/api/v1/health/ready | jq
```

Certbot's snap installs `snap.certbot.renew.timer`. Verify it with `systemctl list-timers --all | grep snap.certbot.renew`. The self-signed certificate is only a temporary bootstrap dependency and is no longer served after the trusted certificate configuration is installed.

To add a domain later:

1. Prefer a stable Elastic IP if its cost is acceptable, and point the domain's DNS `A` record at it.
2. Change `server_name _;` in `/etc/nginx/sites-available/logistics-management` to `server_name logistics.example.com;`, then run `sudo nginx -t && sudo systemctl reload nginx`.
3. Install Certbot and issue the certificate.
4. Change `FRONTEND_URL` in `/etc/logistics-management.env` to the exact `https://` origin and restart both application services.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d logistics.example.com
sudoedit /etc/logistics-management.env
sudo systemctl restart logistics-backend.service logistics-frontend.service
curl -fsS https://logistics.example.com/api/v1/health/ready | jq
```

### 9. Pull and deploy the latest verified `main`

The currently deployed starter environment uses the following non-secret identifiers. Update this block whenever the infrastructure is replaced:

| Setting       | Current value                                               |
| ------------- | ----------------------------------------------------------- |
| AWS account   | `997979359169`                                              |
| Region        | `eu-north-1`                                                |
| EC2 instance  | `i-0725da18037cca6f0`                                       |
| Public origin | `https://13.61.27.202`                                      |
| RDS endpoint  | `database-1.cngus0cc0c50.eu-north-1.rds.amazonaws.com:5432` |
| Checkout      | `/opt/logistics-management`                                 |
| Runtime user  | `logistics`                                                 |
| Services      | `logistics-backend.service`, `logistics-frontend.service`   |

These are resource identifiers, not credentials. Never commit the EC2 private key, `/etc/logistics-management.env`, RDS passwords, invitation tokens, or production administrator password. The workstation key currently used for break-glass SSH is `aws/ControlTower.pem`; it is Git-ignored and must remain readable only by its owner (`chmod 400 aws/ControlTower.pem`). Prefer Session Manager for routine administration.

The normal release flow is:

```bash
# Developer workstation
make policy-check
make check
git status --short
git push origin main

# Observe both workflows when GitHub CLI is installed and authenticated.
gh run list --branch main --limit 10
```

`Quality` checks the pushed SHA first. Only a successful `main` run triggers `Deploy AWS`, which sends that same SHA to EC2 through Systems Manager. Do not start a simultaneous manual deployment while the GitHub deployment is running; deployments are serialized and the host deployer also uses a lock.

After the workflow completes, verify the public frontend and the complete Nginx → backend → RDS path from the workstation:

```bash
curl -fsS -o /dev/null -w 'login HTTP %{http_code}\n' \
  https://13.61.27.202/login
curl -fsS https://13.61.27.202/api/v1/health/ready | jq
```

Expected results are login HTTP `200`, readiness `status: "ready"`, and `database: "connected"`. Do not add `--insecure` to routine verification; a certificate failure means the IP certificate or renewal needs repair.

On the EC2 instance, the update wrapper fetches `origin/main`, resolves the exact SHA, and delegates to the locked deployment script. That script refuses dirty tracked changes, validates the protected environment and postal checksum, applies migrations, verifies ownership, imports idempotently, builds once, restarts once, and checks readiness:

```bash
sudo /opt/logistics-management/scripts/update-aws-deployment.sh
```

Use this for a manual deployment. GitHub Actions invokes the underlying SHA-pinned deployment automatically.

For break-glass SSH from the repository workstation, first make sure no GitHub deployment is active, then run:

```bash
chmod 400 aws/ControlTower.pem
ssh -i aws/ControlTower.pem ubuntu@13.61.27.202 \
  'sudo /opt/logistics-management/scripts/update-aws-deployment.sh'
```

Confirm the exact deployed revision and both internal application paths afterward:

```bash
ssh -i aws/ControlTower.pem ubuntu@13.61.27.202 <<'REMOTE'
set -e
sudo -u logistics git -C /opt/logistics-management rev-parse HEAD
sudo systemctl is-active logistics-backend.service logistics-frontend.service
curl -fsS http://127.0.0.1:4000/api/v1/health/ready | jq
curl -fsS http://127.0.0.1:3000/api/v1/health/ready | jq
REMOTE
```

The SHA printed by EC2 must equal the pushed `main` SHA. The deployer applies all forward migrations before restarting, including automatic tenant legal-entity roots and internal-user/employee linkage. It deliberately does not rerun `db:seed`; production administrator password rotation remains the explicit procedure in section 6.

#### Install or rotate the AWS demo tenant

Demo installation is an explicit post-deployment step and is never part of recurring deployment. First add a unique password of at least 16 characters to the protected file; do not commit or paste its value into a shell command/history:

```bash
sudoedit /etc/logistics-management.env
```

Add or update:

```dotenv
DEMO_USER_PASSWORD='REPLACE_WITH_A_UNIQUE_PRODUCTION_DEMO_PASSWORD'
```

Then run the versioned bootstrap without persisting its one-shot production acknowledgements:

```bash
sudo -u logistics bash -lc '
  set -euo pipefail
  cd /opt/logistics-management
  set -a
  source /etc/logistics-management.env
  set +a
  export DEMO_DATA_ENABLED=true
  export DEMO_DATA_PRODUCTION_CONFIRM=SEED_PUBLIC_DEMO_DATA
  corepack pnpm run demo:seed
'
```

The command requires the existing production `PLATFORM_ADMIN_EMAIL`, RDS TLS settings, and 32-byte base64 `MFA_ENCRYPTION_KEY`; it prints no password, connection URL, or bank value. It creates the same `DEMO` emails and record codes documented in the local demo section. Verify the manifest and services without reading secrets:

```bash
sudo -u logistics bash -lc '
  set -euo pipefail
  cd /opt/logistics-management
  set -a
  source /etc/logistics-management.env
  set +a
  export DEMO_DATA_ENABLED=true
  export DEMO_DATA_PRODUCTION_CONFIRM=SEED_PUBLIC_DEMO_DATA
  corepack pnpm run demo:seed
'
sudo systemctl is-active logistics-backend.service logistics-frontend.service
curl -fsS https://13.61.27.202/api/v1/health/ready | jq
```

The second identical invocation must report that no data changes were required. For an intentional password rotation only, set `DEMO_ROTATE_PASSWORD=true` for that invocation after changing `DEMO_USER_PASSWORD`; all demo sessions are revoked with real security timestamps and a secret-free immutable audit event. Production credentials are never listed in this repository: the deployment owner supplies the protected password privately to demonstrators and rotates or deactivates `DEMO` after use.

#### Install or verify the Jurigari profile on AWS

Add the password only to `/etc/logistics-management.env` with `sudoedit`; do not paste it into a command or commit it:

```dotenv
JURIGARI_USER_PASSWORD='SUPPLY_PRIVATELY'
```

Then explicitly authorize the production bootstrap for that invocation:

```bash
sudo -u logistics bash -lc '
  set -euo pipefail
  cd /opt/logistics-management
  set -a; source /etc/logistics-management.env; set +a
  export JURIGARI_DATA_ENABLED=true
  export JURIGARI_DATA_PRODUCTION_CONFIRM=SEED_JURIGARI_PRODUCTION_DATA
  export JURIGARI_ADOPT_TENANT_ID=415f88a2-675a-476c-8031-87c3ff1ae23b
  export JURIGARI_ADOPT_LEGAL_ENTITY_ID=8fa9ddab-d6fa-4e31-a9c0-ab5527889b54
  export JURIGARI_ADOPT_ROOT_ORGANIZATION_ID=59d8d9fb-9c0b-413f-b7c3-9ff0a2d8cd12
  export JURIGARI_ADOPT_TENANT_SCOPE_ID=a22b8bf4-9b96-46d6-bff4-9dbf12673926
  export JURIGARI_ADOPT_LEGAL_SCOPE_ID=d10ed9f1-ef94-4a31-a334-8d060d12d9ec
  export JURIGARI_ADOPT_OWNER_MEMBERSHIP_ID=d13a6a02-a72f-4c4d-8934-c28673270c61
  export JURIGARI_ADOPT_OWNER_EMPLOYEE_ID=5f060f59-2708-4c57-a593-612d6d37f76e
  export JURIGARI_ADOPT_EXISTING_TENANT_CONFIRM=ADOPT_EXISTING_JURIGARI_TENANT
  corepack pnpm run jurigari:seed
  corepack pnpm run jurigari:verify
'
```

The adoption variables are needed only when reusing an existing `JG` tenant. Resolve every UUID with a platform-context, read-only query; never copy these account-specific examples to another account. Adoption fails unless the code/name and complete provisioned root graph exactly match the supplied IDs and the sole existing membership is Piyana's invitation. Reserved user-email collisions still fail closed.

Production evidence recorded on 2026-09-02: dataset `2026.09.2` installed on AWS, the identical replay made no changes, the secret-free verifier reconciled both owners/employees and the workbook finance chain, backend/frontend readiness reported PostgreSQL connected, and both configured users passed public HTTPS login and `/auth/me`. The password remains only in the protected server environment.

Production normally requires at least 16 characters. If the deployment owner explicitly confirms use of a supplied 12–15 character demonstration password, both additional one-shot controls are required; this narrow profile exception does not weaken any generic authentication policy:

```bash
export JURIGARI_ALLOW_12_CHAR_PRODUCTION_PASSWORD=true
export JURIGARI_12_CHAR_PASSWORD_CONFIRM=I_ACCEPT_DEDICATED_12_CHAR_JURIGARI_PASSWORD
```

Set those variables inside the same protected `sudo -u logistics bash -lc` invocation before `jurigari:seed`, then let them disappear with the shell. For an intentional rotation, change the protected password and set `JURIGARI_ROTATE_PASSWORD=true` only for one invocation; both users' sessions are revoked and the action is audited. Recurring `update-aws-deployment.sh` continues to omit this seed.

For the one update from a checkout that predates `update-aws-deployment.sh`, bootstrap it with the older SHA-based deployer that is already on EC2. This fetches `main`, deploys that exact commit, and makes the updater available; use the normal command above thereafter:

```bash
sudo -u logistics git -C /opt/logistics-management fetch --no-tags origin main
LATEST_SHA="$(sudo -u logistics git -C /opt/logistics-management rev-parse origin/main)"
sudo -u logistics /opt/logistics-management/scripts/deploy-aws.sh "$LATEST_SHA"
```

The deployment account's sudoers entry must include `systemctl daemon-reload` as shown in section 6. This prevents a stale systemd unit cache after service-file updates. The deployer waits up to two minutes for connection-refused and HTTP readiness failures while the applications start.

### 10. Configure GitHub OIDC and deployment permissions

The committed `Quality` workflow runs `make check`. After a successful `main` run, `.github/workflows/deploy-aws.yml` deploys that exact verified commit through SSM. The deployment validates the protected pinned CSV configuration, applies migrations, performs the idempotent postal activation, builds, restarts, and checks readiness. It uses GitHub OIDC, so no long-lived AWS access key is stored in GitHub.

1. IAM → Identity providers → Add provider: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Replace placeholders in `deploy/aws/github-oidc-trust-policy.json`. Create an IAM role (for example `LogisticsGitHubDeploy`) with that trust policy. If your GitHub organization enables immutable repository identities, use the exact OIDC subject recorded by CloudTrail (for example `repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:environment:production`) rather than the legacy `repo:OWNER/REPOSITORY:environment:production` form.
3. Replace placeholders in `deploy/aws/github-ssm-policy.json` and attach it to the role. It limits deployment to `AWS-RunShellScript` and the one EC2 instance.
4. GitHub → Settings → Environments → create `production`, allow only `main`, and optionally require approval.
5. Add these GitHub environment variables (not secrets): `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, and `AWS_EC2_INSTANCE_ID`.
6. Push to `main`. After `Quality` succeeds, `Deploy AWS` starts automatically for that verified SHA. Inspect its SSM output and then verify `/api/v1/health/ready` and `/login`.

### 11. Production operations checklist

- Keep RDS private, require TLS, rotate the bootstrap admin password, `AUTH_SECRET`, MFA key, database password, API credentials, and GitHub deploy key under an approved rotation procedure.
- Verify the SES identity in the deployment region, obtain production access before arbitrary-recipient onboarding, scope EC2 to the one sender identity, and monitor SES bounce/complaint reputation. Do not rotate `EMAIL_TOKEN_ENCRYPTION_KEY` with queued invitations.
- Review automated RDS backups and perform a restore drill. Deletion protection is not a backup.
- Configure CloudWatch alarms for EC2 CPU/status, RDS CPU/connections/storage, disk usage, service restarts, and application readiness.
- Patch Ubuntu, Node.js, PostgreSQL minor versions, SSM Agent, and dependencies regularly.
- For rollback, redeploy a known-good Git SHA only after checking migration compatibility. Forward-only database migrations are not automatically reversed.
- Before meaningful traffic, move builds off the smallest EC2 size or build an artifact in CI; the swap-backed `t3.micro` path prioritizes cost over deployment speed.

AWS references: [RDS PostgreSQL setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_GettingStarted.CreatingConnecting.PostgreSQL.html), [EC2/RDS private connectivity](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/ec2-rds-connect.html), [Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-systems-manager-session-manager.html), [SES identity verification](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), and [Run Command permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command-setting-up.html).

## Run a feature

Open the repository as a trusted Codex project and invoke:

```text
$feature-sdlc Implement FND-02.
```

The skill implements dependency-compatible features/TODOs in rapid batches. Small/localized changes stay with the primary agent and use concise self-review; parallel implementation workers are used only where non-overlapping delegation saves time, and an independent reviewer is reserved for standard/high-risk batches. It keeps acceptance notes lightweight, authors tests as `Implemented / Not Run`, synchronizes only affected trackers once per batch, and supports one related local commit. Specialist spec/test/E2E agents and deployment/regression execution are used only for material risk or an explicit request.

## Commands

| Command                   | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `make bootstrap`          | Validate prerequisites, configure hooks, and install dependencies when present. |
| `make postgres-up`        | Create/start central PostgreSQL and provision this project's databases/schemas. |
| `make postgres-provision` | Add or repair only this project's role, databases, and schemas.                 |
| `make postgres-status`    | Verify the shared container and project database.                               |
| `make demo-seed`          | Install/reconcile the opt-in versioned local demo tenant and business records.  |
| `make dev`                | Start frontend and backend in development mode.                                 |
| `make check`              | Lightweight batch gate: formatting, linting, and type checks only.              |
| `make test`               | Explicit test phase: run non-browser test suites.                               |
| `make deploy-local`       | Explicit deploy/test phase: migrate, build, and start local services.           |
| `make refresh-local`      | Refresh a running local build without reseeding tenant/user data.               |
| `make e2e`                | Explicit test phase: full Playwright regression against local services.         |
| `make verify`             | Explicit release phase: full repository and application verification.           |
| `make status`             | Show feature, test, TODO, and Git status.                                       |

## Documentation map

- [AGENTS.md](AGENTS.md) — binding instructions for Codex and subagents
- `.agents/skills/feature-sdlc/SKILL.md` — reusable feature execution workflow
- [FEATURES.md](FEATURES.md) — scope, implementation status, test status, acceptance criteria, and prompts
- [TODO.md](TODO.md) — active execution queue and unresolved work
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — boundaries and engineering invariants
- [docs/SDLC.md](docs/SDLC.md) — specification-to-commit lifecycle
- [docs/TESTING.md](docs/TESTING.md) — test strategy and status conventions
- [docs/API.md](docs/API.md) — current HTTP authentication, tenancy, and route contract
- [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) — shared PostgreSQL and local deployment
- [CONTRIBUTING.md](CONTRIBUTING.md) — commit and review conventions
- [specs/README.md](specs/README.md) — per-feature artifact layout
