# FND-02 — Identity, roles, and scoped access

**Status:** Approved
**Feature source:** `FEATURES.md` — FND-02
**Owner:** Primary agent

## Problem and outcome

FND-01 proves tenant isolation and provides a secure password/session kernel, but a tenant currently has only one bootstrap `TENANT_OWNER` role and all tenant actions are effectively owner-only. Logistics operations need internal and external users who can hold multiple roles while seeing only assigned legal entities, regions, branches, clients, locations, vendors, or trips. Authorization must be identical in UI, API, reports, exports, and direct-ID access, and changes must take effect immediately.

FND-02 delivers tenant-owned identity administration, configurable role/capability assignments, hierarchical typed scope grants, a centralized deny-by-default evaluator, access review, session control, MFA policy hooks, sensitive-field masking, security reports/alerts, and constrained external-portal shells. It extends the FND-01 identity/session model without weakening server-derived tenant context, forced PostgreSQL RLS, CSRF, generic denials, or the shared-PostgreSQL-only boundary.

## In scope

1. A tenant user directory with invitation, resend/revoke, acceptance, suspension/reactivation, role/scope editing, session reset, and effective-access preview.
2. Invitations addressed to at least one normalized email or E.164 mobile number, with employee code, display name, authentication method, role assignments, scoped actions, expiry, and single-use verification.
3. Local-password authentication by normalized email or mobile; safe linking to an existing identity requires that identity's current password. Existing FND-01 owner invitations remain valid and are represented in the directory.
4. Tenant-configurable roles built from a versioned central capability catalogue. Baseline role templates are seeded for Tenant Owner, MIS Executive, Regional Manager, Key Account Manager, Traffic/Placement Executive, Finance Executive, Collection Executive, Loading Executive, Unloading Executive, Vendor Owner, Driver, Client Viewer, and Auditor. A user may hold multiple roles.
5. Hierarchical grants for `TENANT`, `LEGAL_ENTITY`, `REGION`, `BRANCH`, `CLIENT`, `LOCATION`, `VENDOR`, and `ASSIGNED_TRIP`, with actions `READ`, `CREATE`, `UPDATE`, `APPROVE`, `EXPORT`, and `ADMIN`.
6. A pure reusable policy evaluator and backend resource resolvers/query predicates. UI navigation and controls consume the server-returned effective capability model and never contain role-name checks.
7. Neutral authorization scope nodes and access-probe records sufficient to prove Regional Manager, KAM, Vendor, Driver, multi-role, masking, report, export, and ID-guessing behavior without implementing organization, client, vendor, or trip domains.
8. Membership and global session versioning; immediate revocation after suspension, role/scope changes, explicit reset, identity suspension, password change, or MFA reset.
9. Tenant MFA policy `OFF`, `PRIVILEGED`, or `ALL`; local TOTP enrolment/challenge/recovery-code hooks stored securely in PostgreSQL. No email/SMS provider is required.
10. Role-appropriate internal, vendor, driver, and client portal shells with permission-scoped work-queue summaries and neutral authorization fixtures only.
11. Server-side sensitive-field classification and masking for tax identifiers, bank details, mobile numbers, commercial rates, and payment data.
12. User/session/security reports, permission-change audit history, and in-app security alerts with detail reconciliation.
13. Forward-only migrations, forced RLS and tenant-leading indexes for every new tenant-bearing table; unit, integration, contract, security, migration, and Playwright coverage.

## Out of scope

- Employee/organization/geography master maintenance and authoritative hierarchy (MST-01). FND-02 scope nodes are an authorization contract and deterministic proof fixture, not those business masters.
- Client/location, vendor/driver/vehicle, allocation, trip, invoice, or payment workflows. Portal shells expose neutral work items only; later features register canonical resource resolvers.
- Custom no-code role designer beyond role name/description/capability selection and active state; broader module/template configuration belongs to CFG-01.
- SSO/OIDC/SAML, passkeys, social login, SCIM, identity-provider synchronization, and external identity verification.
- Email/SMS delivery providers. Invitation/MFA delivery requests use the existing PostgreSQL outbox boundary; local testing obtains one-time values through protected fixtures.
- IP geolocation or a new telemetry service. Unexpected-geography evaluation runs only when trusted deployment metadata supplies a normalized country/region.
- Redis, external queues, object storage, Mailpit, a separate worker, or a feature-specific PostgreSQL container.
- Full delegated administration, impersonation, approval workflow configuration, and document/file authorization, which belong to later governance/configuration features.

## Dependencies and assumptions

| Item | State/decision | Evidence |
|---|---|---|
| FND-01 | Complete and Passing; opaque sessions, CSRF, tenant switching, audit, idempotency, outbox, RLS helpers, local deployment, and shared PostgreSQL are reused | `specs/FND-01/completion.md` |
| Identity key | A person has one platform identity and one membership per tenant. Identity has at least one normalized email or E.164 mobile. Current email-only users backfill unchanged | FND-01 schema plus FND-02 email-and/or-mobile requirement |
| Authentication methods | `LOCAL_PASSWORD` is implemented. `EXTERNAL_SSO` may appear only as disabled capability metadata and cannot be selected until a provider exists | Current infrastructure boundary |
| Invitation delivery | Store only token hashes; plaintext link/OTP is returned solely by a production-disabled, Platform Admin/CSRF-protected fixture endpoint. Normal delivery is a deduplicated PostgreSQL outbox request | FND-01 invitation contract and INT-01 boundary |
| MFA | TOTP and one-time recovery codes provide a real local policy seam without network infrastructure. Secrets are application-encrypted using an environment key; recovery codes are Argon2id-hashed and displayed once | Security baseline; no external delivery dependency |
| Scope hierarchy | FND-02 owns generic `authorization_scope_nodes`; later master modules attach canonical records through tenant-scoped stable IDs and resource resolvers, preserving grant IDs | Avoid downstream-domain implementation |
| Scope combination | Capability and matching scope must come from the same active role assignment. Different roles do not cross-combine capability and scope | Safe least-privilege default |
| Deny semantics | There are no user-authored negative grants in this slice. Deny by default plus system policy blocks; blocks override all grants | Avoid ambiguous grant conflict while meeting deny-by-default rule |
| Tenant Owner | The protected baseline owner role grants tenant-wide identity administration and cannot be deleted or stripped below its protected capability floor. A tenant must retain at least one active owner | Prevent tenant lockout |
| Sensitive values | Neutral fixtures prove all masking classes. Later domains classify canonical fields and use the same serializer; raw values never enter unauthorized responses, reports, exports, audit, or logs | Product-wide sensitive-field rule |
| Geography alert | Disabled by default. If enabled, only trusted reverse-proxy/server metadata may identify geography; a client header is never trusted directly | No external geolocation infrastructure |

The runtime remains Next.js frontend, NestJS backend, and the shared central PostgreSQL container only.

## Actors, permissions, and scopes

Capabilities use stable lower-case names such as `identity.user.read`, `identity.user.admin`, `identity.role.read`, `identity.role.admin`, `identity.session.admin`, `identity.report.read`, `identity.audit.read`, `probe.read`, `probe.create`, `probe.update`, `probe.approve`, `probe.export`, and `sensitive.<class>.read`. Actions are normalized to the six scope actions. The catalogue is code-versioned; tenant roles select capabilities but cannot invent capability strings.

| Actor/capability | Allowed scope | Sensitive fields/actions | Denied behavior |
|---|---|---|---|
| Platform Admin | Explicit platform operations; tenant data only through an audited support boundary not added here | Tenant registry/health only | Does not automatically inherit tenant roles or view tenant identity detail |
| Tenant Owner | Current active tenant; protected `TENANT` grant | Invite/administer users and roles, reset sessions, review security reports, explicit sensitive capabilities configurable above protected floor | Cannot cross tenant, remove final active owner, reveal MFA secrets, or bypass server policy |
| Identity Admin (role capability, not a hard-coded role name) | Assigned tenant/scope | User/role/session administration as capabilities allow | Cannot assign a capability or scope they do not possess with `ADMIN`; cannot self-elevate or edit protected role floor |
| Internal scoped user | Union of successful individual role assignments | Only explicitly granted capability/action/scope; sensitive fields need separate class capability | Missing capability, inactive assignment, unmatched scope, or policy block denies |
| Regional Manager fixture | Assigned `REGION` node and descendants | Representative read/create/update/export per configured role | Other regions and unrelated direct IDs/counts are non-leaking |
| Key Account Manager fixture | Assigned `CLIENT` node and descendant locations/linked probe resources | Representative client-scoped operations | Other clients remain denied even in same branch/region |
| Vendor Owner | Assigned `VENDOR` node, portal audience `VENDOR` | Own neutral allocation/trip/payment summaries; separately granted masked payment fields | No internal margins, other vendors, tenant-wide search, or unrestricted export |
| Driver | `ASSIGNED_TRIP` grant resolved against current user assignment, portal audience `DRIVER` | Only neutral assigned-trip actions and allowed contact fields | No other driver/vendor/trip or broad list/export |
| Client Viewer | Assigned `CLIENT`/`LOCATION`, portal audience `CLIENT` | Client-facing neutral status view; export only when explicit | No vendor commercial/payment/internal margin data |
| Auditor | Assigned scope, read/audit/report capabilities | Immutable audit and permitted masked record views | No write/approve/admin unless separately granted |
| Suspended/invited/expired user | None | Invitation preview is redacted | Cannot authenticate or use an existing session |

### Central authorization algorithm

The backend derives `tenantId`, membership, membership `authorizationVersion`, and authenticated `userId` from the session. A resource resolver loads a tenant-owned descriptor from PostgreSQL before policy evaluation:

```text
allow when:
  identity, tenant, membership, role assignment, role, and session are active
  AND session.userAuthVersion == user.authVersion
  AND session.membershipAuthVersion == membership.authorizationVersion
  AND one role assignment grants the requested capability
  AND that same role assignment has one active grant whose action includes the request
  AND the server-resolved resource is equal to or descends from that grant's scope node
  AND every system policy block passes (MFA, portal audience, sensitive class, record state)
```

`ADMIN` implies the other five actions only for the same capability family and matched scope. `APPROVE` never follows from `UPDATE`. `EXPORT` never follows from `READ`. `TENANT` is the hierarchy root. `ASSIGNED_TRIP` is direct-only and additionally requires a current server-side assignment from the trip resolver to the authenticated user; it has no descendants. For create operations, the server resolves the proposed parent/container before accepting content. List/report/export queries compile the same active assignments into parameterized `EXISTS` predicates before pagination or aggregation. Post-filtering an unscoped result is forbidden.

Known foreign, known out-of-scope, inactive, and unknown resource IDs return the same `404 RESOURCE_NOT_FOUND` shape for record reads/writes. Capability-only action denial where no resource identifier is involved returns generic `403 FORBIDDEN`. Every denial records a sanitized security audit event without the foreign tenant, target label, sensitive values, or existence signal.

## UX flow

### Primary flow

#### Invite and acceptance

1. An authorized administrator opens **Access → Users**. The directory has server-side search, status/role/portal filters, sortable columns, page size, active filter summary, empty/loading/error/retry states, and permission-aware CSV export.
2. **Invite user** is a step form:
   - Identity: display name (2–100), employee code (tenant-unique, 2–30 uppercase letters/numbers/hyphen), email (optional normalized RFC-compatible address), mobile (optional E.164), at least one destination required.
   - Access: authentication method (`LOCAL_PASSWORD` enabled), portal audience (`INTERNAL`, `VENDOR`, `DRIVER`, `CLIENT`), one or more active roles.
   - Scope per role assignment: scope type and searchable node, then one or more actions `READ`, `CREATE`, `UPDATE`, `APPROVE`, `EXPORT`, `ADMIN`. Duplicate/subsumed grants are summarized; impossible type/action combinations are disabled with explanation.
   - Expiry: configured default with an allowed bounded override; destination and expiry are shown in local tenant timezone and UTC is persisted.
   - Review: effective capabilities, matched scope tree, masked sensitive access, home destination, MFA requirement, and warnings for privileged grants.
3. Saving requires CSRF, `Idempotency-Key`, the current directory version, and a mandatory reason for a privileged role/capability. The server verifies the administrator can delegate every proposed capability and scope, commits membership/invitation/assignments/grants/audit/outbox atomically, and shows a redacted delivery state. Concurrent/replayed input cannot create a second active invitation.
4. Recipient opens the token link. Preview returns tenant branding, masked destination, authentication method, expiry, MFA requirement, and whether an existing identity must authenticate; role/scope details are not public.
5. New identity verifies possession using the invitation token, supplies display name if needed, creates and confirms a password of 12–256 characters, and accepts terms. Existing identity supplies its current password; invitation possession alone can never relink or replace credentials.
6. When MFA is required, the activation session is restricted to `/auth/mfa/*`: display a TOTP provisioning URI/QR locally, require two sequential valid TOTP codes to confirm setup, show ten recovery codes exactly once, require acknowledgement, and then rotate to a full session. Secrets/tokens never appear after enrolment.
7. The user lands on the server-selected home (`/app`, `/portal/vendor`, `/portal/driver`, or `/portal/client`) with work-queue cards derived from effective capabilities. No role-name branching exists in components.

#### Access review and lifecycle

1. Administrator opens a user detail drawer/page showing identity status, memberships, portal audience, role assignments, hierarchical grants, effective capability table, last login, active sessions, MFA state, permission-change history, and alerts. Sensitive identity values are masked unless allowed.
2. **Edit access** uses a draft model. The client posts the complete desired assignment/grant set plus expected membership version, preview fingerprint, and reason. The server recomputes the preview; a mismatch or concurrent change returns `409` with reload/review guidance.
3. Preview lists each representative action with `Allowed/Denied`, contributing role assignment, matched grant, policy blocks, mask state, and destination home. It never reveals records outside the administrator's own delegable scope.
4. On save, the server atomically replaces the membership's active assignment/grant set, increments `authorization_version`, revokes all active sessions for that user/tenant, writes before/after IDs and safe labels to immutable audit, emits an outbox event, and creates/deduplicates privileged-change alerts. The edited user must sign in again; other tenants remain unaffected unless global identity state changed.
5. **Suspend** requires expected version, reason, and confirmation. It suspends the tenant membership, increments authorization version, and revokes that tenant's sessions. **Reactivate** restores membership only; roles/scopes remain, but a new login is required. The last active Tenant Owner cannot be suspended or stripped of owner access.
6. **Reset sessions** revokes all sessions for the membership. **Reset all sessions** is available only with explicit global identity administration and revokes every tenant/session by incrementing user auth version. **Reset MFA** requires reason, revokes all sessions, disables factors, and forces re-enrolment when policy requires it. Password change likewise rotates auth version.

#### Roles and access probe

1. **Access → Roles** lists baseline/custom roles, capability count, user count, privilege level, active state, version, and protected status.
2. Role create/edit captures name, code, description, portal audience compatibility, and capabilities selected from grouped catalogue. Preview shows affected active users. Optimistic concurrency and reason are required; changing a role increments affected membership authorization versions and revokes affected sessions in the same transaction.
3. A role cannot be deleted while assigned. Deactivation is blocked for the protected owner role and requires impact confirmation otherwise.
4. **Access proof** exposes deterministic neutral records tagged with server-resolved region/client/vendor/trip scope and all sensitive classes. It is explicitly labelled test/proof data. Create/read/update/approve/export actions use the central evaluator and provide acceptance evidence until downstream modules register their own resolvers.

### Validation, loading, empty, error, retry, and stale states

- Validate on blur and submit; associate field errors with controls and focus an error summary after failure. Reject duplicate employee code/destination, invalid email/mobile, missing destination, disabled role, empty role list, empty action list, cross-tenant/invalid scope node, self-elevation, final-owner removal, unsupported auth method, invalid/expired/revoked token, weak password, wrong existing password, and invalid/reused TOTP or recovery code.
- Disable submit while pending and use operation-specific status text. Retries reuse the same idempotency key. A replay returns the original result; same key/different canonical request returns `409 IDEMPOTENCY_CONFLICT`.
- Empty directory/report/role/work-queue states explain which filter or permission controls the result and offer only authorized next actions.
- API errors preserve entered non-secret values; passwords, TOTP codes, recovery codes, and tokens are cleared. Retry is explicit for transient errors.
- A stale membership/role/preview version returns `409 VERSION_CONFLICT`; the UI retains a safe draft, presents a before/latest comparison, and requires a new preview before save. No silent last-write-wins.
- Expired/revoked/used/unknown invitation tokens share a generic invalid-invitation page. Login and MFA failures share generic responses and bounded PostgreSQL-backed throttling.
- If session invalidation occurs while a page is open, the next API call returns `401 SESSION_STALE`; the UI clears tenant state and redirects to login with a non-sensitive explanation.

### Responsive and accessibility behavior

- Desktop uses directory table plus detail panel; narrow screens use cards and a full-page detail route. Scope tree becomes nested disclosure controls and selected-grant chips without horizontal-only interaction.
- Every field has a visible label/instruction, required state is textual, errors are linked with `aria-describedby`, progress uses `aria-live`, and confirmations use focus-trapped accessible dialogs with cancel as initial safe action.
- Role/capability/scope selectors support keyboard search, arrow navigation, Enter/Space selection, Escape close, visible focus, and a textual path such as `Legal entity / West / Mumbai`; color is never the only status signal.
- Effective-access tables provide captions, row/column headers, plain-text Allowed/Denied/Masked badges, and an equivalent stacked mobile view.
- TOTP QR has the secret key and issuer/account text alternative; recovery codes can be copied/downloaded once and are readable without QR perception.
- Portal shells have skip links, semantic landmarks, 44px touch targets, responsive navigation, reduced-motion support, and WCAG AA contrast under tenant branding fallback rules.

## Data model and migration

### Entities and relationships

| Entity | Scope | Key fields and relationships |
|---|---|---|
| `app.users` (extend) | Platform identity | nullable unique normalized `email`, nullable unique normalized `mobile_e164`, `display_name`, password hash, status, `auth_version`, last login/credential timestamps; check at least one identifier |
| `app.tenant_memberships` (extend) | Tenant | employee code, portal audience, `authorization_version`, last activity, dormant threshold override; legacy `role` retained temporarily as compatibility snapshot, not authorization source |
| `app.capability_catalog` | Platform catalogue | stable code PK, group, action, sensitivity/privileged flags, description, introduced version, active; migration-managed, application role read-only |
| `app.roles` | Tenant | code/name/description, protected flag, privilege level, compatible audiences, active, version; unique tenant/code |
| `app.role_capabilities` | Tenant | role + catalogue capability; unique tenant/role/capability |
| `app.membership_role_assignments` | Tenant | membership + role, active dates/state/version; unique active tenant/membership/role |
| `app.authorization_scope_nodes` | Tenant | type, code, name, parent node, optional canonical resource UUID, active/version; unique tenant/type/code and tenant/id; cycle-safe hierarchy |
| `app.scope_grants` | Tenant | role assignment, scope node, action; unique tenant/assignment/node/action |
| `app.access_invitations` | Tenant | membership, auth method, destination hashes/redacted destination, token hash, expiry/use/revoke/delivery state, attempts/version |
| `app.mfa_factors` | Platform identity | user, type `TOTP`, encrypted secret envelope/key version, verified/disabled timestamps, version; one active TOTP factor |
| `app.mfa_recovery_codes` | Platform identity | factor, code hash, used timestamp; never stores plaintext |
| `app.security_events` | Tenant or platform-classified | identity/membership/session, safe event type/outcome, request/geography metadata allow-list, correlation and occurred time; append-only, no credentials |
| `app.security_alerts` | Tenant | type/severity/dedup key, membership/user, state/count/first/last/resolution, version |
| `app.authorization_probe_records` | Tenant | neutral label plus legal entity/region/branch/client/location/vendor scope node IDs, assigned user, status/version, sensitive proof values stored using type-appropriate exact/encrypted representation |
| `reporting.identity_activity_projection` | Tenant | membership, last login/activity/failure, active session count, role count, privilege state, refreshed timestamp |

`sessions` adds `user_auth_version`, nullable `membership_id`, and `membership_auth_version` snapshots plus `mfa_satisfied_at` and assurance level. A platform session has no membership snapshot. Tenant sessions must reference an active membership matching `active_tenant_id`.

### Invariants, indexes, and tenant isolation

1. Every tenant-owned table has non-null `tenant_id`, composite tenant foreign keys, `ENABLE/FORCE ROW LEVEL SECURITY`, an exact tenant policy using transaction context, and tenant-leading indexes for lookup/pagination/join paths.
2. All grant references must share tenant. Trigger/constraint functions reject cross-tenant parent, role, membership, invitation, and probe links. Scope parent belongs to the same tenant; recursive trigger rejects self-parent/cycles and a bounded evaluator rejects depth above 12.
3. `TENANT` has exactly one active root node per tenant and no parent. `LEGAL_ENTITY`, `REGION`, `BRANCH`, `CLIENT`, `LOCATION`, and `VENDOR` use an allowed-parent matrix; `ASSIGNED_TRIP` is a leaf and cannot be used as a parent. Neutral fixtures use valid paths.
4. A membership has at least one active role assignment before invitation activation. Each active assignment has at least one grant unless the protected role migration supplies tenant-admin root. Duplicate/subsumed grants are rejected or canonicalized deterministically.
5. The protected Tenant Owner role and its capability floor cannot be deleted/deactivated. A deferred constraint/transaction lock preserves at least one active owner membership per active tenant.
6. Capability catalogue changes occur only through migrations. Role capabilities reference active catalogue codes; an inactive catalogue capability never authorizes.
7. Destination uniqueness is case-insensitive for email and canonical for mobile. At most one live invitation exists per tenant/membership; token hashes are globally unique. Token use/revoke is single-winner under row lock.
8. Sensitive proof fields use encrypted text or exact integer minor units. Masked forms are computed server-side and cannot be reversed from API output. Audit before/after values contain identifiers/classification and safe masks, not secrets/raw values.
9. Session validity is checked on every request against current user/membership versions and states. Version increment and revocation commit in the same transaction as the authorization change.
10. Security/audit rows are append-only. Security alerts and reporting projections are RLS protected and reconcile only within current tenant/delegable scope.

Required indexes include tenant/status/name directory search, tenant/employee code, tenant/membership and tenant/role assignments, tenant/parent/type scope traversal, tenant/assignment/action grants, live-invitation partial uniqueness, active-session user/tenant lookup, tenant/security-event time/type, and tenant/open-alert type. Migration tests enumerate every tenant-bearing table and require forced RLS, a policy, and a tenant-leading index as in FND-01.

### Migration/backfill and reversal plan

1. Forward migration creates catalogue/role/scope/assignment/grant/invitation/MFA/security/probe/projection structures, constraints, functions, RLS, indexes, and immutable triggers without dropping FND-01 columns/tables.
2. Add nullable/new fields first. Backfill each tenant's root node and baseline role catalogue from configurable defaults. Convert each existing active/invited `TENANT_OWNER` membership into a protected Tenant Owner role assignment with `TENANT/ADMIN`; backfill employee code deterministically as `OWNER-<stable suffix>` and authorization version `1`.
3. Backfill existing users' auth version and sessions' version snapshots/membership reference. Existing active sessions remain valid only when a unique active membership matches; ambiguous/stale sessions are safely revoked.
4. Existing `owner_invitations` remain accepted by compatibility code and create the new assignment model on acceptance. New non-owner invitations use `access_invitations`. No token hash is copied into audit/outbox.
5. Replace the tenant configuration `roles` namespace with a versioned reference to seeded role rows while retaining prior JSON for historical audit. The old `tenant_memberships.role` column remains a non-authoritative compatibility value until a later cleanup migration.
6. Build reporting projection from canonical security/session/assignment rows inside the migration or an idempotent in-process rebuild. Re-running deploy is a no-op.
7. Verify on a clean `logistics_test` database and an upgraded FND-01 database. Existing tenant probes, users, owner access, documents, events, and audit remain usable. An unrelated schema in the shared container remains untouched.
8. Reversal is application rollback, not destructive down migration: new code can stop writing FND-02 tables while FND-01 compatibility columns remain. Data removal requires a separately reviewed migration; applied production-like migrations are never rolled back by dropping identity/security data.

## Domain rules and calculations

- Normalize email with trim/lowercase and mobile to validated E.164 before uniqueness, lookup, hashing, or comparison. Login accepts one `identifier` and never reveals which identity exists.
- Invitation default lifetime and maximum lifetime are tenant configuration with safe defaults; store UTC, display tenant timezone. Expiry comparison is `expires_at <= now()` means expired. Resend revokes the prior token and emits one new deduplicated delivery request.
- Role/grant effective intervals are half-open `[effective_from, effective_to)` in UTC. Null end is unbounded. Access at exactly `effective_to` is denied.
- Hierarchy matching is inclusive: a grant matches its own node and permitted descendants. Sibling or ancestor records do not match. A resource may expose multiple orthogonal paths (for example region and client); a grant matches when the resource resolver declares the path relevant to that capability. The relation is server-owned, not selected by the caller.
- Multiple roles form a union of independently successful assignments. A capability on one assignment cannot borrow a scope grant from another. System blocks (suspended state, stale session, MFA, audience, sensitive classification) override the union.
- Delegation requires `identity.user.admin` plus `ADMIN` on every assigned scope and possession/delegability of every assigned capability. Protected/security administration capabilities are explicitly marked non-delegable except to a protected owner.
- A permission preview is advisory but generated by the exact evaluator. It includes a SHA-256 fingerprint over tenant, target membership version, actor authorization version, sorted proposed assignment/grant IDs, and capability catalogue version. Save recomputes it in the transaction and rejects mismatch.
- Every access-changing mutation uses expected record version and `Idempotency-Key`. Advisory transaction locks serialize by tenant/target membership or tenant/role. Exact replay returns the original representation; different input under the same key is `409`.
- Suspension, access edits, role edits, password/MFA reset, and session reset are all-or-nothing with audit/event/alert/revocation. A failure leaves both authorization and sessions unchanged.
- Dormant means no successful login/activity at or after `tenant-local now - configured dormant days`; the default is configurable. Accounts never logged in are reported separately from dormant. Calendar presentation uses tenant timezone; persisted instants remain UTC.
- Login failures use the existing PostgreSQL windowed limiter, extended for identifier and safe network fingerprint. Threshold and window are configurable within safe bounds. Repeated failures emit one deduplicated alert per tenant/user/window without confirming an identity to the caller.
- TOTP uses tenant-configured issuer, 30-second steps, six digits, SHA-1 compatibility default, and at most ±1 step clock skew. A timestep may succeed once. Recovery codes are single-use under row lock. Setup requires two sequential codes before verified state. MFA policy is checked at login and privileged action boundaries.
- Sensitive serialization classes:
  - tax identifiers: show only configured safe suffix (default last 4);
  - mobile: show country code plus last 2 digits;
  - bank details: show last 4 only;
  - commercial rates/payment data: return `null` plus `masked: true` unless explicit class read capability;
  - export omits unauthorized columns entirely and records the emitted column set.
- Approval is represented on neutral probe records as an append-only action event; `APPROVE` does not modify financial or downstream transaction data.

## API, events, and jobs

All routes remain under `/api/v1`, use the FND-01 error envelope/cookies/CSRF rules, and derive tenant/member context server-side.

| Interface/event/job | Input | Output/effect | Auth/idempotency/failure behavior |
|---|---|---|---|
| `POST /auth/login` (extend) | normalized `identifier`, password, optional tenant code | tenant selection, MFA challenge, or session | Generic failure; throttled; stale/suspended denied; only full session after required MFA |
| `POST /auth/mfa/totp/setup`, `/confirm`, `/challenge`, `/recovery` | restricted challenge/session, TOTP or recovery code | encrypted factor/recovery codes once, then rotated full session | CSRF where session exists; one-time challenge/code; throttled; never returns stored secret after setup |
| `GET/POST /tenant/access/users` | paginated filters or invitation form | scoped directory or atomic invitation | `identity.user.read/admin`; POST idempotent, version/delegation checked |
| `GET/PATCH /tenant/access/users/:membershipId` | detail or complete desired access set, expected version/fingerprint/reason | masked detail or new authorization version | Same evaluator; non-leaking ID; idempotent PATCH; atomic session invalidation |
| `POST .../:id/suspend`, `/reactivate`, `/sessions/reset`, `/mfa/reset` | expected version, reason, confirmation | lifecycle change and revocations | Explicit capabilities; final-owner protection; idempotent; audited |
| `POST .../:id/preview` | proposed role assignments/grants and representative operations | decisions, reasons, masks, fingerprint | Actor sees only delegable scopes; exact production evaluator; no write |
| `POST .../:id/invitations/resend|revoke` | expected invitation version/reason | one new delivery request or revoked invite | Admin; single live token; idempotent and row-locked |
| `GET/POST /tenant/access/roles` | filters or role definition | role directory/new role | `identity.role.read/admin`; catalogue validation; idempotent create |
| `GET/PATCH/POST /tenant/access/roles/:id[/deactivate]` | expected version, capabilities, reason | updated role and affected-session count | Protected floor; atomic affected membership version/revocation; non-leaking |
| `GET /tenant/access/capabilities` | optional group/audience | active versioned catalogue | Authenticated tenant member; returns metadata, not role-name decisions |
| `GET /tenant/access/scopes` | type/parent/search/page | only delegable nodes and paths | Tenant/scope bounded before search/count |
| `GET /tenant/access/effective` | optional representative operation set | current user decisions/navigation/home | Exact evaluator; safe explanation omits inaccessible object names |
| `GET /tenant/access/probes`, `POST/PATCH .../:id`, `POST .../:id/approve` | list filters or neutral proof input/version | scope-safe records/actions with masking | Central capability/scope resolver; create idempotent; known foreign equals unknown |
| `GET /tenant/access/probes/export` | exact visible filters/sort/columns | bounded UTF-8 CSV | Explicit `probe.export`; scope before rows/count; unauthorized sensitive columns omitted; audited |
| `GET /tenant/access/reports/{users|roles|dormant|failed-logins|sessions|privileged-actions|permission-changes}` | pagination/filter/time range | reconciled summary/detail with `asOf` | `identity.report.read`; tenant/scoped and masked; export separate capability |
| `GET /tenant/access/alerts` | state/type/severity/page | reconciled in-app security work queue | `identity.report.read`; tenant-only; no external delivery |
| `identity.invitation.requested.v1` | IDs, auth method, masked destination, expiry | durable delivery request | Unique invitation/version dedup key; no token in event/audit/log |
| `identity.access.changed.v1` | tenant/membership/version, safe role/scope IDs | downstream cache/projection signal | Commits with mutation; idempotent consumer; no sensitive values |
| `identity.session.revoked.v1` | safe reason and affected count | observability/projection update | No session/token IDs outside protected storage |
| In-process identity projection dispatcher | outbox/security events | upsert tenant identity activity projection | PostgreSQL lease/lock; idempotent; inactive tenant not processed |

No WebSocket, provider adapter, queue deployment, or separate worker is added. Internal processes use existing PostgreSQL outbox/job leasing and the backend deployment.

## Reports and alerts

Every report returns `asOf`, filter summary, server-side page/count, mask metadata, and a drill-down/detail route governed by the same predicates. Export requires explicit export capability and uses the exact visible scope and filters. Report totals must equal canonical detail under the same transaction snapshot.

| Report | Canonical measures and reconciliation |
|---|---|
| User directory | one row per visible membership; status, masked identifier, portal audience, role count, last successful login, MFA state, active-session count |
| Role assignments | active assignment/grant counts by role and scope type; drill to memberships visible to actor; no duplicate user count across roles |
| Dormant accounts | active memberships with last activity before configured cutoff; `neverLoggedIn` separate; excludes invited/suspended |
| Failed logins | safe buckets by outcome/window and visible membership when resolvable; unknown identities remain aggregate-only |
| Active sessions | non-revoked, non-expired, version-current sessions; last seen and assurance level; raw token/network fingerprint absent |
| Privileged actions | audit/security events whose capability catalogue flag is privileged; actor/action/safe target/time/reason |
| Permission changes | immutable before/after role/grant ID sets, actor/reason/version/correlation; drill to authorized user detail |

In-app tenant security alerts:

- `REPEATED_LOGIN_FAILURES`: threshold reached in a configured window; dedup tenant + safe identity hash + window.
- `MFA_POLICY_GAP`: active privileged/all-policy membership lacks verified MFA; opens on policy/role/factor change and resolves on verified factor or access removal.
- `PRIVILEGED_ACCESS_GRANTED`: privileged capability/role newly effective; one alert per membership authorization version.
- `UNEXPECTED_GEOGRAPHY`: only when feature enabled and trusted server metadata is outside configured locations; dedup membership + geography + window.
- `SUSPENDED_SESSION_ATTEMPT`: revoked/stale/suspended identity presents a former session; dedup session hash prefix (non-reversible) + window.

Alerts expose severity, first/last occurrence, count, safe user label, reason, owner role, and resolution. They are delivered only in the current tenant UI in FND-02. Recipients are active memberships holding the report/alert capability in matching tenant scope. Acknowledgement/resolution requires expected version and reason and is audited. No cross-tenant alert, target identifier, total, or recipient is observable.

## Audit, observability, and security

- Immutable audit/security events cover invitation create/resend/revoke/accept/failure, login success/failure/throttle/MFA, role/capability/grant changes, previews for privileged changes, suspension/reactivation, session/MFA resets, sensitive reveal/export, direct-ID denial, report/export, and alert acknowledgement/resolution.
- Each event records UTC time, tenant when safely known, actor, source, action/outcome, safe target ID, reason, correlation/request ID, authorization version, impersonation context (always null until supported), and allow-listed before/after IDs. It prohibits passwords, tokens/hashes, TOTP secrets/codes, recovery codes, full mobile/email/bank/tax values, raw request bodies, and foreign resource metadata.
- Logs contain correlation ID, route template, safe error code, latency, decision outcome, capability code, and scope type only. Unknown/foreign/out-of-scope paths have indistinguishable response status/body/timing class within practical tolerance.
- Invitation, login, MFA, and recovery endpoints are PostgreSQL-rate-limited. Token hashes use SHA-256 over high-entropy tokens; passwords/recovery codes use Argon2id. Compare authentication material in constant-time library primitives.
- TOTP secrets are AES-256-GCM envelope encrypted using a required environment key and random nonce; startup fails closed if MFA can be enabled without a valid key. Key version supports rotation. Secrets are never logged or returned after initial setup.
- Browser cookies remain opaque, `HttpOnly`/Secure in production, SameSite, bounded TTL; CSRF double submit/origin checks cover changes. Restricted MFA sessions cannot call tenant APIs.
- CSP, frame protections, cache-control `no-store` for identity pages, safe referrer policy, and autocomplete attributes are enforced. Invitation tokens stay in URL only until exchanged, then are removed with history replacement.
- Health/readiness verifies the FND-02 migration and required encryption configuration without exposing secrets. Metrics include safe counts/rates for login outcomes, policy denials, stale sessions, invitations, MFA challenges, projection lag, open alerts, and authorization evaluation latency.
- No client-supplied tenant, role, capability, grant, scope ancestry, assigned-user relation, mask flag, or portal type is trusted. All are reloaded/resolved server-side in a tenant-context transaction.

## Acceptance traceability

| Acceptance criterion | Design section | Planned test IDs |
|---|---|---|
| Regional Manager sees only assigned regions; KAM only assigned clients; Vendor only own neutral allocation/trip/payment records; Driver only assigned trip actions | Actors; authorization algorithm; role/probe UX; data invariants | `FND02-U-003`, `FND02-U-004`, `FND02-I-005`, `FND02-A-001..006`, `E2E-FND02-03`, `E2E-FND02-05` |
| Direct API calls outside scope return non-leaking denial and create a security audit event | Authorization algorithm; API; audit/security | `FND02-A-007..009`, `FND02-C-003..004`, `E2E-FND02-04` |
| Removing scope invalidates active sessions or permission caches immediately | Access lifecycle; invariants; concurrency rules | `FND02-I-003`, `FND02-A-010`, `E2E-FND02-02` |
| Effective-permission preview matches server authorization for representative create/read/update/export/approve operations | Authorization algorithm; preview UX; fingerprint rule | `FND02-U-006`, `FND02-C-003`, `FND02-A-001..006`, `E2E-FND02-03` |
| Sensitive fields are masked unless explicit permission allows them | Sensitive calculation; probe API; reports/security | `FND02-U-005`, `FND02-A-003..005`, `FND02-A-009`, `FND02-R-005`, `E2E-FND02-05` |
| Invitations support email and/or mobile, existing identity proof, expiry/single-use, MFA policy, multi-role scoped activation, and correct portal landing | Invite UX; invitation/MFA rules; API | `FND02-U-007..008`, `FND02-I-001..004`, `FND02-C-001..002`, `E2E-FND02-01` |
| Admin can safely suspend/reactivate users, reset sessions/MFA, edit roles/scopes, and cannot remove the final owner or self-elevate | Lifecycle UX; invariants; delegation rules | `FND02-I-003`, `FND02-I-006..007`, `FND02-A-010`, `FND02-C-003`, `E2E-FND02-02` |
| Reports/alerts reconcile, remain scoped/masked, and security changes are fully audited | Reports/alerts; audit/security | `FND02-R-001..005`, `FND02-A-008..009`, `E2E-FND02-06` |
| Forward migration preserves FND-01, covers RLS/indexes, and local UI is accessible/responsive/deployable with PostgreSQL only | Migration; responsive/accessibility; infrastructure boundary | `FND02-M-001..002`, `FND02-X-001..002`, `E2E-FND02-01..06` |

The test designer owns final executable IDs and may split these ranges without weakening any traceability row. The final approved spec and test plan must use identical IDs.

## Open decisions

| Decision | Safe default | Owner/impact |
|---|---|---|
| Real invitation delivery channel | PostgreSQL outbox plus protected local fixture; no external sender | INT-01/provider choice; does not block FND-02 |
| SSO authentication | Disabled catalogue metadata; `LOCAL_PASSWORD` only | Future integration/configuration feature |
| Trusted geography source | Policy disabled; evaluate only server-trusted normalized metadata when configured | Deployment/INT-01; prevents spoofed alerts |
| Authoritative organization/client/vendor/trip hierarchy | Generic stable scope nodes and resource-resolver contract with neutral fixtures | MST/OPS features attach canonical resources later |
| Custom role-template depth | Tenant Owner can create/edit roles from central capabilities; advanced module packs/delegation remain out of scope | CFG-01 may extend without replacing evaluator |

No unresolved decision blocks implementation; all choices above are configurable or extension seams.

## Approval

- [x] Spec analyst complete
- [x] Test designer cross-check complete
- [x] Primary agent approved for implementation
