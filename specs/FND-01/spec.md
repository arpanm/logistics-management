# FND-01 — Multi-tenant product foundation

**Status:** Verified
**Feature source:** `FEATURES.md` section FND-01
**Owner:** Primary agent

## Problem and outcome

The product needs a safe reusable boundary between logistics companies before any business module is added. FND-01 establishes a deployable Next.js frontend, NestJS backend, and Prisma/PostgreSQL persistence layer in which a Platform Admin can provision a tenant, invite its first owner, inspect platform-level health, deactivate or reactivate the tenant, and prove that tenant-owned data cannot cross that boundary.

The completed slice provides:

- a platform tenant registry and protected Platform Admin console;
- atomic, idempotent tenant provisioning with configurable bootstrap defaults;
- a minimal authentication/session and owner-invitation kernel required to exercise tenancy;
- server-derived active-tenant context and a multi-tenant switcher;
- a setup checklist, branding/configuration summary, default legal entity, and a deliberately non-business `tenant probe` resource used to prove isolation;
- PostgreSQL-backed audit events, invitation-delivery events, jobs, platform alerts, and a reconciled platform health report;
- local production-style deployment and automated isolation verification against the central PostgreSQL service.

FND-01 is not the general identity/authorization feature. FND-02 will add the full role catalogue, hierarchical scopes, MFA hooks, sensitive-field permissions, account administration, and external portals without weakening this foundation.

## In scope

1. Bootstrap the repository layout from `docs/ARCHITECTURE.md`: independently buildable Next.js and NestJS applications plus shared domain, database, authentication, configuration, UI, and observability packages where the implementation needs them.
2. Provision, read, list, deactivate, and reactivate tenants through Platform Admin-only APIs and UI.
3. Capture every tenant field listed in FND-01, validate it, and show deterministic loading, success, validation, conflict, error, and retry states.
4. Atomically create tenant defaults, one default legal entity, setup-checklist rows, the first Tenant Owner membership/invitation, an invitation-delivery event, and audit evidence.
5. Minimal local authentication for a seeded Platform Admin and accepted Tenant Owner invitations, using hashed passwords and opaque database-backed sessions.
6. Resolve active tenant exclusively from the authenticated server session and membership. Never authorize with a tenant ID supplied in a query, path, body, cookie, or frontend state alone.
7. Tenant switcher for a user with at least two active memberships and tenant-specific UI state invalidation on switch.
8. Tenant setup overview and configuration/branding summary. The checklist links future areas but does not implement those modules.
9. Tenant-scoped `tenant probe` CRUD/list/export/event/document/report behavior solely as an isolation harness. The probe is not presented as a logistics business feature.
10. Platform health report and persisted operational alerts described below.
11. UTC timestamps, tenant-timezone rendering, optimistic versions, validation, audit, structured logs, correlation IDs, security headers, CSRF protection, and safe error envelopes.
12. Forward migration, deterministic development/E2E seed, clean-test-database migration, local deploy scripts, readiness endpoints, and all required automated tests.

## Out of scope

- General user administration, multi-role assignment, hierarchical resource scopes, MFA, password reset, SSO, vendor/driver/client portals, and fine-grained permissions (FND-02).
- Organization hierarchy, employee masters, and user-created legal entities beyond the single bootstrap legal entity (MST-01).
- Clients, vendors, vehicles, drivers, contracts, operations, documents, billing, or other logistics transaction models.
- Customer-configurable role editing or no-code branding/configuration screens (CFG-01). FND-01 only reads bootstrap configuration and renders its branding.
- A real email/SMS provider. Invitation delivery is a durable PostgreSQL event processed by an in-process adapter. Local mode exposes the one-time invitation URL to the Platform Admin after creation without logging it.
- WebSockets. Because the feature introduces no websocket endpoint, the isolation criterion is satisfied by proving there is no websocket transport and by applying the same tenant-context contract to the event-delivery abstraction.
- Redis, message brokers, external queues, object storage, Mailpit, a separate worker, or a project-specific PostgreSQL container.
- Precise per-table disk attribution. The report exposes current project database size and tenant-owned row counts; a tenant storage estimate is explicitly labelled as an estimate if implemented.

## Dependencies and assumptions

| Item | State/decision | Evidence |
|---|---|---|
| Feature dependency | Ready; FND-01 has no feature dependency. | `FEATURES.md` register |
| Runtime architecture | Next.js frontend, NestJS backend, PostgreSQL/Prisma, Vitest, and Playwright in a TypeScript `pnpm` monorepo. | ADR 0001 |
| Local infrastructure | Use only `shared-postgres`, with project databases `logistics` and `logistics_test` and schemas `app`, `audit`, `reporting`. | `docs/LOCAL_DEVELOPMENT.md` |
| Authentication boundary | Implement the smallest secure password/session kernel needed for FND-01. FND-02 extends it; it does not replace tenant/session semantics. | Safe dependency-unblocking decision |
| Platform Admin bootstrap | A deterministic local/E2E Platform Admin is seeded from environment variables; production-like startup rejects placeholder credentials. Seed is idempotent and secrets are never committed or logged. | Local bootstrap requirement |
| Invitation delivery | “Sent” means one durable `owner_invitation.requested` outbox row is committed and processed exactly once by the configured in-process delivery adapter. Local mode additionally returns the plaintext URL once to the authorized creator. | Infrastructure boundary and testability |
| Invitation lifetime | Default 72 hours, read from typed application configuration and persisted as an absolute UTC expiry. | Configurable safe default |
| Tenant defaults | Stored as versioned JSON configuration rows seeded from application-owned, tenant-neutral templates. Defaults contain no Juri Gari names/codes. | Product-wide configuration rule |
| Deactivation | Suspends tenant access and tenant jobs/events without deleting data or global user identity. A user may still use another active membership. | FND-01 acceptance criterion |
| Branding | Bootstrap fields are display name, optional short name, primary colour, accent colour, and initials mark. Uploaded logos wait for the governed document/configuration features. | Smallest PostgreSQL-only slice |
| Probe resource | A label and note in `app.tenant_probe_records` prove scoped CRUD, search, guessed-ID denial, export, event, report, and document access. It has no downstream business meaning. | FND-01 master prompt |
| Browser delivery | Frontend and backend are same-site in local usage through documented origins; API CORS is allow-listed and credentialed. | Deployment baseline |

The current infrastructure boundary is Next.js frontend, NestJS backend, and the shared central PostgreSQL container only. Introducing anything else requires an approved ADR and explicit user authorization.

## Actors, permissions, and scopes

FND-01 uses three fixed bootstrap capabilities. They are centralized policy constants, not scattered UI role checks, so FND-02 can extend them.

| Actor/capability | Allowed scope | Sensitive fields/actions | Denied behavior |
|---|---|---|---|
| Platform Admin / `platform:admin` | Global tenant registry, provisioning, platform report/alerts, tenant lifecycle | Can view tax identifier, invitation email, delivery status, health, deactivate/reactivate, and copy the one-time local invite URL | Cannot read tenant probe contents or future tenant business data through platform reports; cannot switch into a tenant without an explicit membership |
| Tenant Owner / `tenant:owner` | Active tenants for which the user has an active owner membership | Can read tenant profile/configuration, checklist, and own tenant probe resources; can update checklist/probe only | Cannot create/deactivate tenants, see platform health, see another tenant, or alter bootstrap roles/policies in FND-01 |
| Authenticated multi-tenant user | Active memberships explicitly assigned to the identity | Can list membership-safe switcher summaries and select one active tenant | Cannot submit an arbitrary tenant ID without a membership, select an inactive tenant, or preserve old tenant response/cache state after switch |
| Unauthenticated or expired-session caller | Login, readiness, and invitation acceptance endpoints only | May submit credentials or a valid invitation token | Receives a non-enumerating denial for protected data; no tenant existence or record-existence leak |
| PostgreSQL-backed dispatcher | Rows leased for one active tenant or platform event | May update delivery/job state and append audit/alert data | Must not lease inactive-tenant rows or deliver a row under a different tenant context |

All protected service and repository entry points accept a typed authorization context constructed from the validated server session. Platform-global access uses a separate explicit `PlatformContext`; it is never represented by a missing tenant filter.

## UX flow

### Primary flow: Platform Admin provisions a tenant

1. The Platform Admin signs in at `/login`. A valid session lands on `/platform/tenants`; an invalid credential shows a generic error and creates no session.
2. The tenant list displays name, code, status, owner invitation status, active user count, last activity, and setup progress. It supports server pagination, status filter, code/name search, and empty/retry states.
3. The Admin selects **Create tenant** and completes one labelled form:

   | Field | Type and validation | Required/default |
   |---|---|---|
   | Tenant name | Trimmed text, 2–120 Unicode characters | Required |
   | Tenant code | Uppercase `A-Z0-9-`, 2–30; normalized before validation; globally unique and immutable | Required |
   | Legal name | Trimmed text, 2–160 characters | Required |
   | GSTIN / tax identifier | Trimmed uppercase text, 2–32, letters/digits/hyphen; tenant locale may later add stricter rules | Required |
   | Registered address | Address line 1, optional line 2, city, state/region, postal code, country ISO alpha-2; each bounded and trimmed | Required except line 2 |
   | Timezone | IANA timezone selector; must resolve in the runtime timezone database | Required; configured default |
   | Locale | Supported BCP 47 locale | Required; `en-IN` default |
   | Currency | ISO 4217 uppercase code | Required; `INR` default |
   | Fiscal-year start | Month `1..12` and day valid for every year; February 29 is rejected | Required; `4/1` default |
   | Default legal entity | Name, code (`A-Z0-9-`, 2–30), and optional GSTIN override | Name defaults to legal name; code defaults to tenant code |
   | Support contact | Name, syntactically valid email, optional E.164 mobile | Name/email required |
   | Owner | Name and normalized email | Required |
   | Branding | Optional short name (2–32), primary/accent `#RRGGBB`; contrast preview warns/fails if text contrast is below WCAG AA for the chosen foreground | Short name defaults to tenant name; neutral accessible colours default |
   | Active state | Checkbox | On by default; creating inactive is permitted and creates a suspended invitation event that is not deliverable until activation |

4. Client validation runs on blur and submit; the backend repeats all validation. Submit sends a generated `Idempotency-Key`, disables duplicate submission, and displays progress without optimistic success.
5. One database transaction creates the tenant, legal entity, configuration defaults, checklist, owner membership placeholder, hashed invitation, one outbox delivery request, platform audit record, and initial report facts. Any failure rolls back all rows and returns a retryable correlation ID.
6. Success opens a detail page showing provisioning state, checklist progress, invitation expiry/delivery state, and—in local development/E2E only—the invitation URL returned once with a **Copy invitation link** action. Refresh never reveals the plaintext token again. Replaying the same idempotency key and identical body returns the original resource and does not create another invite/event; a changed body with the same key returns `409`.

### Primary flow: owner accepts invitation and enters the tenant

1. The owner opens `/accept-invitation?token=...`. The frontend exchanges the token for a redacted invitation preview (tenant display name, owner email mask, expiry).
2. The owner supplies display name, password, password confirmation, and accepts the local terms acknowledgement. Password policy is a minimum of 12 characters and checks confirmation; richer policy/MFA belongs to FND-02.
3. The backend hashes the password using the selected approved password-hashing library, marks the invitation accepted exactly once, activates the membership, creates a rotated opaque session, and appends audit events in one transaction. Token replay returns a generic invalid/used response and creates no second user, membership, or session.
4. The owner lands on `/app/setup`. The page renders tenant branding and eight checklist items: organization, users, branches, clients, vendors, commercial settings, imports, and branding. In FND-01, only branding is marked complete by the bootstrap configuration; future-feature items link to an unavailable explanatory state rather than fake implementations.
5. The header shows the active tenant but no switcher when exactly one active membership exists.

### Primary flow: switch active tenant

1. A fixture/user with two active memberships sees a labelled tenant switcher. It lists only active memberships, using tenant name/code/branding without business counts.
2. Selecting Tenant B asks the backend to switch the session to B. The backend verifies active user, active membership, and active tenant, rotates the session identifier, updates `activeTenantId`, and returns a new context version.
3. The frontend cancels in-flight tenant requests, clears tenant query/cache/form/draft/navigation state, remounts under the returned context version, and navigates to `/app/setup`.
4. Branding, settings, checklist counts, probe rows, and recent activity are fetched afresh and contain only Tenant B values. Browser back/forward cannot restore Tenant A protected data; stale responses with the former context version are discarded.

### Tenant lifecycle flow

1. Platform Admin opens a tenant detail page and selects **Deactivate**. A confirmation requires typing the tenant code and entering a 10–500 character reason.
2. The backend changes `ACTIVE → INACTIVE` with optimistic version checking, records actor/reason, revokes active sessions whose active tenant is this tenant, and makes its queued jobs/events ineligible for leasing. Records are retained.
3. Owner login/invitation acceptance/switch to that tenant returns the same generic unavailable result without exposing internal status to unauthenticated callers. Multi-tenant users can still access other active memberships.
4. **Reactivate** requires a reason and changes `INACTIVE → ACTIVE`. Existing memberships and data become usable, but revoked sessions are not resurrected; the user signs in again. A still-valid unaccepted invitation becomes deliverable once and may be accepted; expired invites remain expired.

### Tenant probe isolation flow

The tenant setup page includes a clearly labelled **Isolation test records** development/admin card. Tenant Owners can create, list, search, open, update, and export simple probe records (`label`, `note`). The UI never accepts a tenant ID. Direct API requests for another tenant's UUID return the same `404` envelope as an unknown UUID. The feature also stores one small PostgreSQL document payload and one event/report projection per probe so automated tests exercise every current tenant-owned storage path. The card can be hidden outside local/test environments without removing APIs or tests.

### Validation, loading, empty, error, retry, and stale states

- Forms preserve non-secret values after server validation errors and place an error summary before the form with links to invalid controls. Secret/token/password fields are cleared when appropriate.
- Unique code and normalized owner-email conflicts return `409` with a field-safe message. Database identifiers, SQL detail, token hashes, tenant existence, and cross-tenant record existence never appear.
- List and report pages use visible skeleton/loading labels, meaningful empty states, disabled paging during fetch, and a retry action for network/server failures.
- State-changing actions use an idempotency key and remain safe if the browser retries after an ambiguous timeout.
- Version conflicts return `409 VERSION_CONFLICT` with current safe fields; the UI offers reload and does not silently overwrite.
- A session invalidated by deactivation or expiry clears protected frontend state and returns to login with a generic message.
- A stale tenant-context response is ignored when its response context version does not match the current session context version.
- Readiness degradation is shown on the Platform report without exposing credentials, SQL, stack traces, or cross-tenant content.

### Responsive and accessibility behavior

- Primary pages work at 320 CSS-pixel width and desktop widths without horizontal page scrolling; wide tenant/report tables become labelled cards or contained horizontal regions.
- Every control has a programmatic label, errors use `aria-describedby`, the error summary receives focus, dialogs trap/restore focus, and status is not communicated by colour alone.
- All flows support keyboard-only operation with visible focus. Tenant switch announces the new active tenant through a polite live region.
- Colour inputs include text values and previews; AA contrast is enforced for the default content foreground.
- Page titles and landmarks distinguish Platform Admin and tenant areas. Copy-link success is announced without revealing the link to assistive logs after navigation.

## Data model and migration

### Entities and relationships

All IDs are UUIDs generated by PostgreSQL or the application. All mutable records carry `created_at`, `updated_at`, and integer `version`; timestamps are `timestamptz` in UTC. Email and code normalization occurs before persistence.

| Schema/table | Ownership | Key fields and relationships |
|---|---|---|
| `app.users` | Platform identity | `id`, normalized unique `email`, `display_name`, `password_hash`, `status`; no tenant business fields |
| `app.tenants` | Platform registry | `id`, globally unique `code`, name/legal/tax/address/timezone/locale/currency/fiscal fields, support fields, branding summary, `status`, lifecycle reason/actor/time, version |
| `app.tenant_memberships` | Tenant-owned | `tenant_id`, `user_id` nullable until invite accepted, normalized invited email, bootstrap role `TENANT_OWNER`, status; unique tenant/email and tenant/user |
| `app.owner_invitations` | Tenant-owned | membership/tenant, normalized email, `token_hash`, UTC `expires_at`, accepted/revoked timestamps, delivery state; never stores plaintext token |
| `app.sessions` | Platform identity with active context | `token_hash`, user, nullable `active_tenant_id`, CSRF hash/nonce, context version, expiry, revoked timestamp/reason, last seen; opaque token only in cookie |
| `app.legal_entities` | Tenant-owned | tenant, tenant-unique code, name, tax identifier, `is_default`, active status |
| `app.tenant_configuration` | Tenant-owned | tenant, `namespace`, schema version, JSONB value, version; unique tenant/namespace; namespaces `roles`, `reasons`, `thresholds`, `branding`, `modules` |
| `app.setup_checklist_items` | Tenant-owned | tenant, stable key, label/order, state (`NOT_STARTED`, `COMPLETE`, `NOT_AVAILABLE`), completed metadata; unique tenant/key |
| `app.tenant_probe_records` | Tenant-owned isolation harness | tenant, label, note, version; label searchable but not globally unique |
| `app.stored_documents` | Tenant-owned storage harness | tenant, probe owner ID, media type, byte length, SHA-256, `bytea` content; bounded to 32 KiB for FND-01 probes |
| `app.idempotency_records` | Tenant or platform operation | scope (`PLATFORM`/`TENANT`), nullable tenant, actor, operation, key hash, request hash, resource/result reference, state; unique actor/operation/key hash |
| `app.outbox_events` | Tenant or platform event | nullable tenant, aggregate, event type/version, JSONB payload without secrets, deduplication key, state, available/leased/processed/failure fields; unique deduplication key |
| `app.job_runs` | Tenant or platform work | nullable tenant, job type/key, state, lease/attempt/error class/next-at fields; unique job key |
| `app.platform_alerts` | Platform metadata only | type, severity, nullable tenant reference, deduplication key, first/last seen, occurrence count, state/resolution, safe summary; no tenant business payload |
| `audit.audit_events` | Append-only; tenant nullable for platform action | actor, effective tenant, action, target type/ID, source, before/after safe JSON, reason, request/correlation ID, session/impersonation context, UTC event time |
| `reporting.tenant_activity_projection` | Tenant-owned projection | tenant, last activity, user/probe/config/event counts, refreshed timestamp; unique tenant |
| `reporting.platform_tenant_health` | Platform read model/view | joins platform-safe tenant status, active user count, setup progress, last activity, pending/failed event/job counts; contains no probe note/document/event payload |

`app.tenants`, `app.users`, and `app.sessions` are platform/control-plane records. Every other row representing tenant behavior has a non-null `tenant_id`, except platform-level idempotency/events/jobs/audit/alerts where a `scope`/type check requires `tenant_id IS NULL`. Tenant-owned outbox/job/audit rows require a non-null tenant.

### Invariants, indexes, and tenant isolation

1. All tenant-owned tables declare `tenant_id UUID NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT`; no cascade deletion is allowed.
2. Tenant natural-key indexes lead with `tenant_id`. Foreign keys between tenant-owned records include the tenant key (composite unique/foreign-key pattern) so a child cannot reference a parent in another tenant even if an application bug supplies its UUID.
3. PostgreSQL row-level security is enabled and forced on tenant-owned base tables. Policies compare `tenant_id` to a transaction-local context set by the tenant repository unit of work. Platform-only repositories are separate and explicitly reviewed; “no tenant” never grants tenant-row access.
4. A request transaction derives the tenant from `sessions.active_tenant_id` and an active membership/tenant join, then sets the database context. Request body/query/path tenant IDs are ignored for context and rejected where supplied unexpectedly.
5. Repository interfaces require `TenantContext`; raw Prisma access is private to the database package. Escape-hatch unscoped methods have `platform` in their name, require `PlatformContext`, and cannot return tenant business payloads.
6. A migration-policy test queries PostgreSQL catalogues and fails for any table outside an approved control-plane allow-list that lacks a non-null tenant column, forced RLS, a matching policy, and a tenant-leading index. A second reflection test discovers every registered tenant-owned repository/resource and executes A/B negative access.
7. Cross-tenant known UUID and unknown UUID produce the same status, error code, and response shape. Search counts, pagination totals, exports, report projections, document metadata/content, alerts, outbox payloads, and job leases are scoped before aggregation.
8. `tenants.code` is globally unique and immutable. Tenant status transitions allow only `ACTIVE ↔ INACTIVE`; delete is absent.
9. At most one default legal entity exists per tenant (partial unique index), and exactly one is created during provisioning.
10. At most one current owner invitation exists for a tenant/normalized email; provisioning creates exactly one invitation and one delivery event. Acceptance is conditional on unaccepted, unrevoked, unexpired invitation and active tenant.
11. Idempotency stores a hash of the key and request. Matching retry returns the original response; mismatched request returns conflict; secrets and plaintext tokens are excluded from replay storage. The local one-time URL is therefore returned only on the initial successful request, not an idempotent replay.
12. Audit rows are append-only. Database permissions/triggers reject update/delete by the application role where feasible and tests verify the repository exposes no mutation.
13. Session, invitation, CSRF, and idempotency keys are compared by cryptographic hash; plaintext values exist only in process memory/secure cookie/one-time response.
14. All JSON configuration is validated against a versioned schema on write and read. Invalid bootstrap templates fail startup/provisioning before partial tenant creation.

### Migration/backfill and reversal plan

- The initial committed Prisma migration creates extensions required for UUID generation, schemas, enum/check constraints, tables, composite keys, indexes, forced RLS policies, audit protections, and reporting views in dependency order.
- Migration verification runs once against a newly provisioned empty `logistics_test` database and once against an already migrated database to prove idempotent deployment. It verifies migration history and required schema/database connectivity.
- Seed commands are explicit and idempotent; normal application startup does not silently seed tenants. E2E reset truncates only this project's test schemas using an allow-listed script and never touches `logistics`, another database, the central container, or volume.
- Because this is the first application migration, no production backfill is required. A forward reversal is a new reviewed migration that disables feature entry points and removes only unreferenced bootstrap objects; deployment scripts never auto-drop schemas/data. The initial migration is not rolled back by deleting the shared database.

## Domain rules and calculations

### Tenant provisioning state and transaction

- API status is derived from the atomic transaction: there is no partially provisioned tenant visible after a failed transaction.
- Defaults are copied from application configuration at provisioning time with a template/schema version so later code-default changes do not silently mutate existing tenants.
- Default role configuration includes only `TENANT_OWNER` as a bootstrap role. The richer baseline role catalogue is introduced and migrated by FND-02.
- Default reason lists include tenant lifecycle and setup categories; default threshold configuration uses product defaults but remains tenant data. No customer name/code/value is embedded.
- Setup progress is `COMPLETE items / total applicable items × 100`, represented as integer numerator/denominator plus display percentage rounded to the nearest whole percent. `NOT_AVAILABLE` remains applicable until its feature exists and is not counted complete.

### Invitation and session states

- Invitation states are derived in order: `ACCEPTED`, `REVOKED`, `EXPIRED` (`now >= expires_at`), `DELIVERY_FAILED`, `PENDING_DELIVERY`, `DELIVERED`. Equality at expiry is expired.
- Delivery uses an outbox deduplication key based on invitation ID and event version. The dispatcher leases with PostgreSQL `FOR UPDATE SKIP LOCKED`, records attempts, and never processes tenant work while tenant is inactive. Repeated processing cannot create a second logical delivery.
- Acceptance and user creation are transactional and concurrency-safe. Two concurrent acceptance attempts yield one success and one generic invalid/used result.
- Sessions have an idle and absolute UTC expiry configured by environment. Each authenticated request checks active user; tenant routes additionally check active tenant and membership. Switching rotates the cookie token and increments context version.
- A user with zero active memberships has no active tenant and cannot access tenant routes. One active membership is selected automatically. Multiple memberships require the most recently valid selection or an explicit selection.

### Tenant lifecycle and jobs

- Deactivation uses optimistic concurrency and records a mandatory reason. It revokes sessions currently active in the tenant and prevents new tenant sessions, invitation acceptance, tenant repository operations, outbox leasing, and job leasing.
- Rows already leased when deactivation commits must re-check tenant status immediately before side effect/acknowledgement; if inactive, they release/defer without delivery. There is no deletion.
- Reactivation does not reset configuration, memberships, versions, audit, or data. It does not unexpire invitations or un-revoke sessions.

### Time, concurrency, and historical behavior

- Persist instants as UTC `timestamptz`; return RFC 3339 UTC strings. Render calendar/date labels in the tenant IANA timezone. The Platform report uses the Platform Admin's configured timezone or UTC when absent.
- Fiscal-year month/day is a business calendar value, not converted to an instant. February 29 is excluded so every year has a start date.
- Every mutable update includes expected `version`; success increments by one. Stale writes fail with no partial mutation.
- Historical audit/config snapshots remain unchanged when current tenant profile or default templates change.

## API, events, and jobs

All APIs are under `/api/v1`, return JSON except CSV/document content, use a stable error envelope (`code`, safe `message`, `correlationId`, optional field errors), enforce bounded pagination, and set `X-Correlation-Id` plus `X-Tenant-Context-Version` on protected responses. State changes require same-site cookie credentials and CSRF token; provisioning/probe create and lifecycle changes additionally require `Idempotency-Key`.

| Interface/event/job | Input | Output/effect | Auth/idempotency/failure behavior |
|---|---|---|---|
| `GET /health/live` | None | Process liveness | Public; no dependency/secret detail |
| `GET /health/ready` | None | DB connectivity, migration readiness, application status | Public summary; `503` on failure, no credentials/SQL |
| `POST /auth/login` | Email, password, optional selected tenant code | Opaque session cookie, CSRF token, safe identity/context | Rate-limited with PostgreSQL counter if enabled; generic `401`; inactive target indistinguishable from unavailable membership |
| `POST /auth/logout` | CSRF | Revokes current session and clears cookie | Authenticated; repeat is harmless |
| `GET /auth/me` | Session cookie | Safe identity, active tenant summary, active membership summaries, CSRF/context version | Never returns another user's membership or sensitive token data |
| `GET /auth/invitations/:token/preview` | Opaque token | Masked email, tenant display/branding, expiry | Generic `404/410` for invalid/used/expired/inactive; no token logging |
| `POST /auth/invitations/:token/accept` | Name, password, terms acknowledgement | User/membership activation and session | Transactional one-time acceptance; concurrent/replay safe |
| `POST /session/active-tenant` | Tenant ID from switcher, expected context version, CSRF | Rotated session and selected safe context | ID is a selection only; server proves membership/status; idempotent for already-active selection |
| `GET /platform/tenants` | Search/status/page/sort allow-list | Platform-safe tenant rows and total | Platform Admin only; no tenant business payload |
| `POST /platform/tenants` | Full create DTO | Provisioned tenant detail and initial-only local invite URL | Platform Admin, CSRF, required idempotency; single transaction and conflict semantics |
| `GET /platform/tenants/:id` | Tenant UUID | Safe profile, provisioning/invite/setup/health summary | Platform Admin; no probe note/document payload |
| `POST /platform/tenants/:id/deactivate` | Expected version, reason | Updated lifecycle state | Platform Admin, CSRF/idempotency; no delete; `409` stale/already-state mismatch |
| `POST /platform/tenants/:id/reactivate` | Expected version, reason | Updated lifecycle state | Same rules; does not revive sessions/expired invitations |
| `GET /platform/report` | Page/filter | Reconciled platform metrics and per-tenant safe details | Platform Admin only; DB size is project-level, tenant storage is labelled estimate or omitted |
| `GET /platform/alerts` | State/severity/type/page | Safe operational alert list | Platform Admin only; tenant business payload prohibited |
| `POST /platform/alerts/:id/resolve` | Expected version, resolution reason | Resolved alert and audit | Platform Admin, CSRF/idempotency/versioned |
| `GET /tenant/context` | Active session | Tenant branding/profile/configuration/checklist summary | Active TenantContext only |
| `PATCH /tenant/setup/:key` | Expected version and permitted state | Updated bootstrap checklist item | Tenant Owner; FND-01 only permits `branding`; future keys return `FEATURE_NOT_AVAILABLE` |
| `GET/POST /tenant/probes` | Search/page or label/note | Scoped list/count or created probe | Tenant Owner, server-derived tenant; POST idempotent/CSRF |
| `GET/PATCH /tenant/probes/:id` | UUID; expected version/update | Scoped record/read/update | Cross-tenant and unknown UUID both `404`; version conflict safe |
| `GET /tenant/probes/export` | Search/filter | Permission-scoped UTF-8 CSV | Tenant Owner; current tenant only; formula-leading cells escaped; bounded/streamed |
| `GET /tenant/probes/:id/document` | Probe UUID | Bounded stored payload and safe headers | Same scoped lookup; no cross-tenant metadata leak |
| `owner_invitation.requested.v1` | Invitation/tenant IDs, masked destination metadata | One durable delivery request | Unique dedup key; no plaintext token in payload/audit/logs |
| `tenant.probe.changed.v1` | Tenant/probe ID, action, occurred at | Audit/event projection update | Same transaction as mutation; dispatcher restores tenant context |
| Invitation dispatcher | Pending outbox lease | Delivery attempt/state | In-process, PostgreSQL lease; checks tenant active; retry capped/configured; final failure alerts |
| Projection dispatcher | Probe/change events | Upsert tenant activity projection | Idempotent by event ID; tenant-scoped transaction |
| Job/event failure monitor | Failed rows/attempt thresholds | Creates/updates deduplicated platform alert | PostgreSQL query/lease; safe metadata only |
| Isolation/storage invariant check | Schema catalogue and registered resources | Creates/resolves platform alert | Runs at readiness/test and configurable in-process schedule; readiness fails for structural invariant breach |

No websocket endpoint is registered in FND-01. Future transports must consume the same server-derived TenantContext and outbox contract before becoming available.

## Reports and alerts

### Platform health report

The Platform Admin report contains no tenant probe labels/notes, documents, event payloads, or future business aggregates. It shows:

- tenant counts: total, active, inactive;
- per tenant: code/name/status, active accepted membership count, pending/expired owner invitation state, setup complete/applicable counts and derived percentage, last tenant activity UTC/display time, pending/failed outbox count, pending/failed job count, last projection refresh;
- project PostgreSQL database size from `pg_database_size(current_database())`, labelled as shared-container project database usage, not tenant business storage;
- backend readiness and migration state;
- integration health as `Not configured` in FND-01 rather than a false success;
- latest safe failure class/time/correlation ID for jobs/events, never raw payload/error/SQL;
- freshness timestamp from the reporting view/projection.

Every displayed count drills down to a permission-safe filtered detail list or is clearly marked non-drillable. SQL reconciliation tests compare per-tenant report counts to canonical tenant-scoped base rows. Aggregate totals equal the sum of visible per-tenant rows for the selected filter; project database bytes are not allocated or summed by tenant.

### Operational alerts

| Alert | Trigger | Recipient/severity | Deduplication and resolution |
|---|---|---|---|
| `TENANT_PROVISIONING_FAILED` | Provisioning transaction/application failure after request validation | Platform Admin / error | Keyed by idempotency request hash; occurrence count increments; resolves after successful matching retry or manual reason |
| `TENANT_SCOPE_INVARIANT_FAILED` | Catalogue/resource isolation check detects missing tenant key/RLS/policy/index or cross-tenant access test failure | Platform Admin / critical | Keyed by invariant/table/resource; remains open until a successful check records resolution; readiness becomes degraded/failed as defined by check class |
| `STORAGE_BOUNDARY_FAILED` | Tenant document/probe storage lookup returns a mismatched tenant or checksum/ownership invariant fails | Platform Admin / critical | Keyed by resource/invariant without payload; resolves after successful recheck |
| `JOB_REPEATEDLY_FAILED` | Configured attempt threshold reached for a tenant/platform job/event | Platform Admin / error | Keyed by job/event logical key; occurrence increments; resolves on successful processing or explicit resolution |

Provisioning failure before a tenant exists produces a platform-scoped alert. Alerts associated with a tenant expose only tenant registry metadata to Platform Admin and are never sent to another tenant. No external notification channel is implemented; the Platform Admin console is the delivery surface.

## Audit, observability, and security

- Append audit events for login success/failure class (never password), logout, invitation preview/acceptance outcome, tenant provision/lifecycle change, tenant switch, checklist change, probe mutation/export/document access denial, platform report access, alert resolution, job/delivery state transition, and authorization denial.
- Audit before/after JSON is field-allow-listed. Passwords, tokens, token hashes, session/CSRF values, document bytes, and raw PostgreSQL errors are prohibited. Tax/support data is included only when necessary and masked in non-detail events.
- Structured logs include timestamp, level, service, correlation ID, safe actor ID, effective tenant ID, route/event type, outcome, duration, and error class. They exclude request bodies for auth/provisioning and never log secrets.
- Passwords use a memory-hard approved hash with per-password salt and bounded verification parameters. Opaque session/invitation/CSRF tokens use cryptographically secure randomness and one-way hashing at rest.
- Cookies are `HttpOnly`, `SameSite=Lax` or stricter, path-limited where practical, and `Secure` outside explicit local HTTP mode. State changes validate Origin and CSRF token. CORS permits only configured frontend origins with credentials.
- Apply CSP, frame-ancestors, referrer, MIME-sniffing, and permissions headers at frontend/backend boundaries. Escape all rendered configuration and CSV formula-leading content.
- Login and invitation acceptance have bounded PostgreSQL-backed attempt counters and generic errors. FND-02 can expand adaptive policies; no in-memory-only limiter is relied on for security.
- Error responses never reveal tenant existence, membership, other-tenant record existence, schema/table names, SQL, stack traces, credential state, or token validity beyond the minimum invitation UI state.
- `/health/ready` verifies database connection and migration state; tenant invariant checks expose only pass/fail. Platform alerts preserve actionable safe evidence.
- Metrics include request count/latency/status by normalized route, authorization denials, active sessions, provisioning outcomes, outbox/job states, tenant-switch outcomes, and projection freshness. Tenant IDs are bounded labels only in local/debug output; customer names, emails, tax IDs, and tokens are never metric labels.
- Secrets come only from validated environment configuration. Startup rejects missing/placeholder secrets outside local/test. `.env`, logs, traces, screenshots, and generated reports remain uncommitted.

## Acceptance traceability

Test IDs are coordinated with `specs/FND-01/test-plan.md`; the primary agent reconciles names before approval.

| Acceptance criterion | Design section | Planned test IDs |
|---|---|---|
| Creating Tenant A provisions defaults and sends exactly one expiring owner invitation. | Primary provisioning flow; data invariants 9–11; invitation states; API/outbox | `FND01-U-002`, `FND01-I-001`, `FND01-I-002`, `FND01-C-001`, `FND01-C-002`, `E2E-FND01-01`, `E2E-FND01-02` |
| Tenant A cannot retrieve, search, mutate, export, guess an ID for, or receive another tenant's data through every current UI/API/event/job/document/report/export path. No websocket path exists. | Actors; probe flow; invariants 1–7; API/events/jobs; security | `FND01-A-001`, `FND01-A-002`, `FND01-A-003`, `FND01-A-005`, `E2E-FND01-03` |
| Multi-tenant user switches A to B and sees only B branding, settings, counts, and recent records. | Switch flow; session rules; stale-state handling | `FND01-U-003`, `E2E-FND01-05` |
| Tenant deactivation blocks tenant login and jobs without deleting records; reactivation restores access. | Lifecycle flow; lifecycle/job rules; lifecycle APIs | `FND01-U-004`, `FND01-I-004`, `E2E-FND01-04` |
| Automated isolation tests run for every tenant-owned table/resource. | Data catalogue/reflection invariants; migration plan | `FND01-M-002`, `FND01-A-002`, `FND01-A-003`, `FND01-A-005` |
| Platform report/alerts are safe and reconcile to canonical metadata. | Reports and alerts | `FND01-U-005`, `FND01-R-001`, `FND01-R-003`, `E2E-FND01-05` |
| Bootstrap is deployable, accessible, responsive, and observable against shared PostgreSQL only. | In scope; responsive/accessibility; migration; security | `FND01-M-001`, `FND01-X-001`, `FND01-X-002` |

## Open decisions

No unresolved blocking product decision remains. The following decisions are intentionally configurable or delegated to named later features and do not block FND-01.

| Decision | Safe default | Owner/impact |
|---|---|---|
| External invitation provider | Durable PostgreSQL outbox plus local one-time copy link; no external send adapter | INT-01 may add email/SMS providers without changing invitation idempotency |
| Full role and authentication policy | Fixed centralized Platform Admin/Tenant Owner capabilities, 12-character password, opaque sessions | FND-02 adds roles, scopes, MFA, access review, and user administration |
| Uploaded tenant logo | Accessible initials mark and validated colours | CFG-01/GOV-01 add governed logo/document storage UI |
| Per-tenant storage accounting | Project DB size plus exact tenant row counts; omit or clearly label any estimate | Control-tower/configuration work may add a reviewed allocation method |
| Future websocket delivery | No websocket route in FND-01 | A future feature must reuse TenantContext/outbox isolation and add explicit tests |

## Approval

- [x] Spec analyst complete
- [x] Test designer cross-check complete
- [x] Primary agent approved for implementation
