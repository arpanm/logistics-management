# UI-01 — Responsive Material application shell, Control Tower UX, and showcase demo data

**Status:** Implemented locally; focused tests Implemented / Not Run
**Feature source:** User-requested cross-feature UI modernization and richer `DEMO-DATA` batch
**Owner:** Primary agent
**Evidence reviewed:** `FEATURES.md`, `TODO.md`, ADR 0001, `docs/ARCHITECTURE.md`, current global shell/styles and Operations/Finance/Governance/Control components, `specs/CTL-01/spec.md`, `specs/DEMO-DATA/spec.md`, current demo seed, and `backup/dashboard.html`. The prototype is visual/behavioral evidence, not production architecture. Production code and focused tests were authored in this batch; no test was run.

## Problem and outcome

The application has individually styled pages, a wrapping top navigation, dense fixed-width tables, and inconsistent tabs/cards/forms. Long labels, references, money, statuses, and actions can escape or overlap their containers, especially in Control Tower reports and narrow viewports. The deterministic demo tenant is coherent but too sparse to demonstrate portfolio drill-downs, risk distributions, ageing, operational variety, or realistic client/vendor breadth.

Deliver one token-driven, Material 3-aligned application shell and component language across platform, tenant, portal, authentication, setup, master, operations, POD, finance, Control Tower, alerts, data, integrations, governance, and configuration routes. Preserve domain behavior and authorization while making every route usable from 320 CSS px through large desktop widths. Upgrade the existing opt-in demo bootstrap to a deterministic, reconciled, client-presentation dataset that visibly exercises all five Control Tower lenses and major workbenches.

### UI-01 remediation acceptance — Control APIs and responsive detail surfaces

- All five `/api/v1/control-workbench/:lens` reads must return bounded, stable pages from the real tenant database. Summary SQL must aggregate from independent CTEs/aliases and must never correlate an ungrouped outer row into portfolio, location, ageing or vendor summaries.
- At 320, 375, 390, 768 and 1024 CSS px, Operations and Finance landing/register/tab content must not create document-level horizontal scrolling. Dense comparisons may scroll only inside a labelled, width-bounded owner; compact record cards must retain identity, state, critical amount/time and permitted primary actions.
- Operations and Finance action dialogs become labelled modal sheets on compact screens: contained by `100dvw`/`100dvh`, one-column fields, internally scrolling content, visible title and final actions, background interaction blocked, Escape/backdrop close, and trigger-focus restoration.
- User, POD, canonical, module, master and Platform tenant details opened from a row/card must appear immediately as a labelled modal/detail sheet in the current viewport. Focus moves into it, remains trapped, and returns to the exact initiating control on close; selected detail is never silently appended at the end of a long page.
- Shared table and detail primitives apply the same containment, long-text wrapping, authorization and accessibility behavior across equivalent routes. No unscoped global table minimum may widen the document.

## In scope

- Shared design tokens and primitives for typography, spacing, colour, elevation, radius, focus, buttons, fields, dialogs/drawers, navigation, tabs, cards, KPI tiles, status chips, filters, tables, pagination, skeletons, empty/error states, and feedback.
- Responsive application shell: grouped capability-aware navigation, current-route state, tenant switcher, account/sign-out actions, skip link, and compact/mobile drawer behavior.
- Cross-app overflow remediation and responsive layouts, including forms, cards, toolbars, dialogs, feedback, tables, reports, identifiers, money, dates, and action groups.
- Control Tower information hierarchy and mobile/desktop behavior without changing CTL-01 formulas, scope, canonical sources, drill paths, or export semantics.
- Versioned expansion of the existing `DEMO` bootstrap and demo story; no automatic production reseed.
- Focused component/Playwright/accessibility/reconciliation cases to be authored by implementation ownership and recorded `Implemented / Not Run` until an explicit test phase.

## Out of scope

- Changing workflows, KPI formulas, accounting rules, permissions, tenant isolation, or canonical status ownership.
- A customer-specific theme, copied prototype CSS, heavy animation, charting without reconciled canonical data, or a second frontend framework.
- Real customer/PII/tax/bank/contact data, external messages/provider calls, performance-load fixtures, or demo bootstrap during migration/normal deployment.
- Replacing Next.js, NestJS, PostgreSQL, or adding runtime infrastructure; any third-party UI dependency must fit the existing frontend and be approved through normal dependency review.

## Dependencies and assumptions

| Item                 | State/decision                                                                                                                                                                     | Evidence                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Visual language      | Use Material 3 interaction/layout principles and semantic design tokens; implementation may use the existing CSS/React stack rather than requiring a component-library rewrite     | User request plus ADR 0001                               |
| Theme                | Light is the required first theme; tenant primary/accent colours are mapped to contrast-safe semantic tokens. Dark mode is deferred, not simulated                                 | Existing tenant branding and current light workbenches   |
| Responsive range     | Required at 320, 375, 768, 1024, and 1440 CSS px; layout transitions are content-driven near compact (`<768`), medium (`768–1199`), and expanded (`>=1200`) widths                 | Existing 320 px baseline and observed wide-table layouts |
| Existing domain APIs | UI modernization consumes the existing typed APIs. Backend changes are limited to presentation metadata/pagination needed to avoid client regrouping or unbounded mobile payloads  | Architecture reporting/API boundaries                    |
| Demo version         | Dataset `2026.09.2` is additive with one persisted anchor instant; rerunning that version is a no-op except an explicitly authorized password rotation                             | Existing `DEMO-DATA` contract                            |
| Production safety    | The AWS demo remains opt-in, uses protected credentials, is inactive outside planned demonstrations, suppresses outbound notifications, and is never reseeded by normal deployment | `TODO.md` and `specs/DEMO-DATA/spec.md`                  |

## Actors, permissions, and scopes

| Actor/capability                    | Allowed scope                                                                                                               | Sensitive fields/actions                                                                                                           | Denied behavior                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Platform Admin                      | Existing platform routes and safe tenant summaries                                                                          | Existing reveal/reset/tenant lifecycle rules remain unchanged                                                                      | New navigation never grants tenant business access or exposes cross-tenant KPIs                                                    |
| Tenant Owner / scoped internal user | Only routes, lenses, rows, columns, actions, exports, and alerts permitted by effective capability and server-derived scope | Commercial, payment, bank, tax, contact, and audit fields keep current masking/reveal rules                                        | Hidden navigation is convenience only; direct route/API/export remains denied safely                                               |
| Client/Vendor/Driver portal actor   | Existing own-client, own-vendor, or assigned-trip surface                                                                   | Only current portal-safe actions/data                                                                                              | No internal margin, other counterparty, tenant administration, or unassigned-trip disclosure                                       |
| Demonstration operator              | Explicit bootstrap command and documented demo lifecycle                                                                    | Supplies production confirmation/password outside Git; can activate/deactivate the marked demo tenant through supported operations | Cannot seed another tenant, overwrite user-added demo rows, print secrets, send real notifications, or enable demo data implicitly |

Navigation items, KPI totals, table counts, responsive summaries, drawers, URL state, exports, and autocomplete options must all derive from the same effective capability, tenant, field-permission, and scope contract. Responsive transformation may not reveal a field or action that the desktop representation masks or omits.

## UX flow

### Shared application shell and design system

1. The shell has a compact top app bar for brand, current tenant/context, page-level utilities, and account actions. At expanded widths, grouped primary navigation is a persistent navigation rail/drawer; at compact/medium widths it is opened by a labelled menu button in a modal drawer that traps focus, closes on Escape/backdrop/route change, and restores focus to the trigger.
2. Navigation groups are **Home & Control**, **Operations**, **Finance**, **Masters & Data**, and **Administration**. A group/item is absent when no child route is permitted. Current page and expanded group are programmatically exposed; direct route authorization remains server-enforced.
3. Page structure is consistent: breadcrumb (when useful), title/description, primary action, optional secondary overflow menu, scoped status/freshness, filters, summary, and main content. At most one visually dominant primary action exists per region.
4. Tokens define semantic surface levels, text, border, primary/secondary, success/warning/error/info, focus, spacing, type scale, radius, elevation, control height, and content widths. Components consume tokens rather than feature-local colour/spacing copies. Tenant colours are contrast-adjusted; status semantics never inherit arbitrary branding.
5. Body text remains at least 14 px, primary body/controls normally 16 px on compact screens, touch targets are at least 44 by 44 CSS px, and focus indicators are visible in all themes. Motion is subtle and disabled under `prefers-reduced-motion`.

### Overflow prevention and responsive content

1. No route has document-level horizontal scrolling at the required widths. Every flex/grid child that may shrink has a bounded minimum; user content uses wrapping or controlled truncation. Long tenant/client/vendor/location names, email, UUID/reference, status, currency, translated label, and error/correlation values remain inside their owner box.
2. Human labels wrap without clipping. References may use middle/end truncation only when the same control exposes the full value by keyboard/touch (expand/copy/detail), not hover alone. Money/date/status stay unambiguous; numeric columns use tabular alignment and never overlap adjacent actions.
3. Toolbars put the primary search/filter controls first. Compact layouts use a **Filters** button and bottom sheet/drawer with applied-filter count, Apply, Reset, and Cancel; applying retains URL/shareable state where already supported. Desktop filter rows wrap into aligned grids without compressed unreadable controls.
4. Action clusters collapse to one primary row action plus an accessible overflow menu on compact screens. Destructive actions remain labelled, confirmed, and visually distinct. Fixed/sticky UI accounts for safe-area insets and never covers form actions, feedback, pagination, or the final row.
5. Dialogs become near-full-screen sheets on compact screens, keep title and final actions visible, scroll only their content region, prevent background interaction, and preserve validation input. Toast/feedback stacks stay within the viewport and never cover the active field/action.

### Tabs, tables, cards, and reports

1. Tabs implement the complete tab keyboard pattern: active tab, roving focus, Left/Right/Home/End, associated `tabpanel`, URL/deep-link state when applicable, and focus preservation after refresh. At compact widths tabs are a single-line horizontal scroller with active-tab auto-reveal and visible overflow affordance; tab text never overlaps or compresses below readability.
2. Desktop data tables are inside labelled, bounded scroll regions with a sticky header, clear sort state, stable key column where useful, row hover/focus, empty/error/loading treatment, and pagination/result count. Scrolling a table never scrolls the page sideways.
3. At compact widths, each feature declares essential fields. Small datasets transform to semantic record cards (`article`/list) with labelled term/value pairs and the same permitted actions; comparison-heavy tables retain contained horizontal scrolling plus a visible “Swipe/scroll for more columns” hint and a row-detail sheet. Essential identity, state, risk, amount/due time, and primary action are never hidden.
4. KPI cards have consistent label/value/supporting text, sufficient min/max sizing, semantic pressed/drill state, and a non-colour explanation. Labels wrap above values; values use responsive type and cannot escape the card. Skeletons match final geometry to avoid layout jumps.
5. Report sections state title, purpose, scope/filter summary, `asOf`/freshness, result count, and export availability. Partial/stale/failed sources are explicit; stale values never appear as live. Chart-like encodings include text/table equivalents and reconcile to the visible scoped details.

### Control Tower information architecture

1. `/app/control` renders: page command header; lens tabs; compact freshness/as-of bar; KPI summary; primary filter/search bar; active-filter chips; breadcrumbs/drill context; portfolio/location/record results; and contextual vendor/ageing summaries. Advanced save/export/live controls move to a secondary action area without competing with the current lens and drill task.
2. Placement, POD vs Invoice, Collection, Trips, and Vendor Payable use consistent lens anatomy while keeping CTL-01-specific KPIs, guidance, ageing and fields. The currently selected KPI/risk/bucket is visibly pressed and described in the result heading; Clear removes it predictably.
3. Portfolio and location cards present identity, worst textual risk, G/Y/R counts, principal measure (fill/open balance/etc.), and record/location counts in a stable hierarchy. Long names wrap; the risk strip is supplemental and has an accessible textual equivalent.
4. Record results use server-projected rows and pagination. On mobile they default to cards with reference, client/location or vendor, textual state/risk, the lens-critical date/age/amount, freshness when relevant, and **Open source record**; secondary permitted fields open in a labelled detail sheet. Desktop retains the dense reconciled table.
5. Lens changes preserve compatible global search/scope/date/as-of filters and discard only incompatible lens-specific filters with an announced explanation. Auto-refresh preserves lens, drill, scroll, focus, filter, sort, pagination and open row detail; updates are announced without stealing focus.

### Validation, loading, empty, error, retry, and stale states

- Initial loading reserves shell, header, tabs, filters, cards, and table/card geometry; only affected regions become busy on refresh/mutation.
- Empty states distinguish no source records, no permission, and no filter matches, with one safe relevant action. Forbidden routes do not render a misleading empty dashboard.
- Validation appears beside the field and in a focusable summary for multi-field forms. Server failures show a safe message and correlation ID; Retry repeats reads only. A committed mutation is never repeated by a generic retry.
- Offline/network loss preserves non-sensitive input and filter/drill state. Recovery reloads authoritative state and surfaces version/idempotency conflicts without silent overwrite.
- Partial/stale report sources retain the last permitted result only with visible source, timestamp, impact, and retry. Loading/error text and status changes use polite/assertive live regions as appropriate.

## Demo data model, invariants, and migration

### Showcase manifest

The new demo manifest materializes exactly one neutral tenant across at least 2 regions and 3 branches, with a presentation baseline of:

| Area                           | Minimum deterministic graph                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access/organization            | At least 6 representative memberships linked to 6 internal employees, plus distinct client/vendor/driver personas and whole-tenant, region, client, vendor, and assigned-trip scopes                                                                                                              |
| Commercial masters             | 4 clients, 10 client locations, 4 active vendors plus 1 ineligible/expired vendor, 12 vehicles, 10 drivers, 6 lanes, and published/expired/upcoming contract/rate/SLA/compliance examples                                                                                                         |
| Operations/POD                 | 36 indents, 24 allocations, 18 trips, and 14 POD tasks spanning every supported actionable/historical state, split allocation, replacement/NTP, on-time/late, detention, GPS-silent, exception, POD current/prior and G/Y/R boundary examples                                                     |
| Client finance                 | 18 invoices across draft/approval/posted/submitted/part-paid/paid/hold/reversed and all collection ageing buckets; at least 8 receipts with exact allocation, deduction, unallocated and reversal examples; follow-up/promise outcomes                                                            |
| Vendor finance                 | 14 vendor bills across verification/approval/due/overdue/blocked/disputed/part-paid/paid/reversed and at least 5 payment runs including failed and reversed outcomes                                                                                                                              |
| Control/alerts/data/governance | Every lens has at least 3 visible portfolio groups and 10 drill records for the owner; at least 12 alerts across severity/lifecycle, committed and rejected import evidence, governed documents/approvals/audit evidence, and fresh/delayed source examples where the current model supports them |

Exact row IDs, natural keys, dates, amounts, quantity units, relationships, expected role-visible counts, KPI totals, ledger balances, and CSV-safe labels live in a checked-in typed manifest. All examples are synthetic and prominently marked `DEMO`; names remain tenant-neutral and avoid Juri Gari hard-coding.

### Invariants, idempotency, and migration/recovery

- All demo business rows remain tenant-scoped and use existing canonical constraints, workflows, append-only ledgers/events/audit, exact minor/milli units, UTC timestamps, and tenant-timezone display. Dashboard/report rows are derived from canonical records, not directly seeded summaries that can drift.
- One persisted anchor instant produces stable risk/ageing boundaries. If a live presentation needs “today-relative” freshness, an explicit `demo:refresh-clock` operation advances only designated temporal fixtures in one audited transaction and is independently idempotent by target anchor; normal `demo:seed` never drifts dates on rerun.
- The bootstrap increments its dataset/manifest version and uses stable IDs/natural keys. Same-version replay changes no canonical count, amount, auth version, password hash, posted record, ledger entry, audit event, or user-added row. A failed/concurrent run rolls back completely or exits retryably under the existing advisory lock.
- No business schema change is expected. Any required index/manifest metadata change must be forward-safe, tenant-leading where applicable, preserve existing data, and have a documented rollback-by-forward-fix; posted/paid data is never deleted or rewritten. Existing older demo rows are upgraded additively and remain valid.
- A preflight validates schema version, production confirmation, protected non-default password, synthetic destinations, notification suppression, target tenant marker, and manifest graph/reconciliation before writes. A postflight verifies counts, foreign keys, role-visible totals, ledgers, KPI drills, and absence of secrets; failure prevents a successful bootstrap-run record.

## API, events, jobs, reports, and alerts

| Interface/event/job                   | Input                                                                     | Output/effect                                                                                    | Auth/idempotency/failure behavior                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Existing page/workbench APIs          | Existing filters, scope, sort, cursor/page and `asOf`                     | Typed bounded rows plus permitted display metadata, total/freshness and stable ordering          | Existing tenant/capability/field policy; unknown/foreign filters deny or return caller-safe results; reads retry safely |
| Control Tower lens/export APIs        | CTL-01 lens/drill/filter/sort/page/`asOf` contract                        | Same scoped KPI, portfolio, record and export result regardless of desktop/mobile representation | Server aggregation/pagination; exact visible export; saved-view/export idempotency and audit remain CTL-01-owned        |
| `demo:seed`                           | Existing opt-in/production confirmation/password plus manifest version    | Additive canonical graph, safe count/actor summary, bootstrap-run provenance                     | Demonstration operator only; advisory lock + transaction; no secrets; failure rolls back                                |
| `demo:refresh-clock` (if implemented) | Explicit marked tenant, target anchor/version and production confirmation | Advances only allow-listed temporal demo fixtures and rebuilds derived projections               | Separate opt-in; target-anchor idempotency; transaction/lock; cannot touch non-demo/user-added rows                     |

All five Control Tower lenses, Operations/Finance landing KPIs, POD ageing, alert queues, import/audit/governance reports, and CSV exports must contain meaningful multi-row demo results and reconcile to permission-scoped canonical detail at one `asOf`. No new competing alert type is required: fixtures use existing rule/status semantics, stable deduplication keys, owners/due dates, linked source evidence, and acknowledged/snoozed/escalated/resolved examples. Demo seeding/clock refresh emits no external notification; any queued delivery is marked suppressed for the non-deliverable demo domain.

## Audit, observability, and security

- UI telemetry records route/component category, compact/medium/expanded class, loading/error/retry, table/card mode, client-side render failure, and bounded performance timings without labels, row payloads, search terms, PII, financial values, credentials, or cross-tenant identifiers. Existing correlation IDs connect frontend failures to backend logs.
- Accessibility regressions are observable through automated Axe/semantic tests; supported pages target WCAG 2.2 AA with zero serious/critical Axe findings. Contrast, focus, names, roles, status text, reading order, zoom/reflow, keyboard and touch behavior are part of acceptance, not decorative review.
- Demo bootstrap/run audit records actor/operator source, target tenant, manifest version/checksum, anchor, safe before/after counts, result and correlation ID. It never records passwords/hashes, connection strings, tokens, bank ciphertext, full synthetic sensitive values, or SQL payloads.
- Presentation code never trusts client tenant/scope, recomputes financial/quantity totals in binary floating point, or exposes raw transport JSON. Content Security Policy and existing masking/reveal rules remain intact.

## Lightweight acceptance notes

| Acceptance criterion                                    | Explicit behavior                                                                                                                                                                                                                                            | Planned test IDs                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **UI01-AC01 — Modern consistency**                      | Every in-scope route uses the shared Material-aligned tokens/shell/primitives; typography, controls, cards, status, elevation, spacing and feedback have one coherent hierarchy without feature-local visual drift                                           | `UI01-VIS-001`, `UI01-COMP-001`                                                      |
| **UI01-AC02 — Responsive shell/navigation**             | At 320/375/768/1024/1440 px, capability-aware grouped navigation, tenant/account controls, content and primary actions are reachable without page-level horizontal scroll or covered content; drawer focus/Escape/route-close behavior is correct            | `UI01-E2E-002`, `UI01-A11Y-002`, `UI01-AUTH-002`                                     |
| **UI01-AC03 — Overflow prevention**                     | Long labels, names, references, money, dates, statuses, errors and action groups remain inside cards/forms/dialogs/tables at 200% zoom and required widths; full truncated values have non-hover access                                                      | `UI01-COMP-003`, `UI01-E2E-003`                                                      |
| **UI01-AC04 — Mobile tables and actions**               | Each dense register/report supplies declared essential fields and either equivalent record cards or a contained comparison table/detail sheet; primary/overflow actions preserve permission and no essential data disappears                                 | `UI01-COMP-004`, `UI01-E2E-004`, `UI01-AUTH-004`                                     |
| **UI01-AC05 — Accessible tabs/cards/reports**           | Tabs implement full keyboard/tabpanel semantics; KPI/portfolio/status/chart encodings have text equivalents; touch/focus/contrast/live-region/reflow requirements meet WCAG 2.2 AA with zero serious/critical Axe findings                                   | `UI01-A11Y-005`, `UI01-E2E-005`                                                      |
| **UI01-AC06 — Complete UX states**                      | Loading, no-data, no-match, no-permission, validation, partial, stale, failure, retry, offline and conflict states preserve safe context, never overlap, and never retry a committed mutation                                                                | `UI01-COMP-006`, `UI01-E2E-006`, `UI01-INT-006`                                      |
| **UI01-AC07 — Control Tower hierarchy**                 | All five lenses follow the specified command-header → tabs → freshness → KPI → filter → drill → results → contextual-summary hierarchy; selected KPI/filter/drill is explicit and refresh/lens changes preserve compatible state/focus                       | `UI01-CTL-E2E-007`, `UI01-CTL-COMP-007`                                              |
| **UI01-AC08 — Control Tower responsive reconciliation** | Desktop tables and mobile cards/detail sheets expose equivalent permitted critical fields/actions; each KPI/risk/bucket/count/amount/export reconciles to canonical scoped drill rows at displayed `asOf`                                                    | `UI01-CTL-E2E-008`, `UI01-CTL-REC-008`, `UI01-CTL-AUTH-008`                          |
| **UI01-AC09 — Client-worthy demo breadth**              | The versioned showcase manifest meets every stated minimum and state/boundary matrix, produces at least 3 portfolios and 10 records in each owner-visible lens, and populates major workbenches/reports with a coherent cross-module story                   | `UI01-DEMO-U-009`, `UI01-DEMO-INT-009`, `UI01-DEMO-E2E-009`                          |
| **UI01-AC10 — Demo integrity and safety**               | Seed/optional clock refresh is opt-in, transaction-safe, same-version/anchor idempotent, additive, tenant-isolated, reconciled, notification-suppressed and secret-free; production needs existing explicit safeguards and normal deployment does not run it | `UI01-DEMO-IDEM-010`, `UI01-DEMO-AUTH-010`, `UI01-DEMO-REC-010`, `UI01-DEMO-SEC-010` |
| **UI01-AC11 — No domain regression**                    | Responsive representation does not change authorization, workflow transitions, exact amounts/quantities, timezone boundaries, canonical statuses, saved views, audits, alerts, or exports                                                                    | `UI01-CONTRACT-011`, `UI01-REG-011`                                                  |
| **UI01-AC12 — Observable recovery**                     | Frontend/API/bootstrap failures expose safe correlation/provenance and bounded metrics; partial/stale sources and failed bootstrap runs recover without false-live UI, partial writes, duplicated events, or leaked payloads                                 | `UI01-OBS-012`, `UI01-FAIL-012`                                                      |

## Open decisions

| Decision                      | Safe default                                                                                                                                                                | Owner/impact                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dark theme                    | Defer; deliver a polished contrast-safe light theme first                                                                                                                   | Product may add a token-level dark theme later without changing component behavior |
| Third-party component library | Prefer shared repository-native React/CSS primitives; adopt a library only if implementation review shows lower lifecycle/accessibility risk and no duplicate design system | Engineering dependency decision; does not block behavior                           |
| Demo presentation clock       | Use the persisted fixed anchor; add explicit `demo:refresh-clock` only if fixed dates make production presentations misleading                                              | Demo operator/product; configurable and isolated from normal seed/deploy           |

No unresolved decision changes required product behavior; the defaults above are safe and configurable.

## Readiness

- [x] Intended outcome, actors, responsive behavior, UX states, accessibility and overflow rules are explicit
- [x] Control Tower information architecture, reconciliation, authorization, exports, alerts and failure recovery are defined
- [x] Demo graph, canonical invariants, migration/idempotency, production safety, audit and observability are defined
- [x] Acceptance criteria map to automated coverage; focused shell, Control Tower and demo-manifest checks are Implemented / Not Run, while the remaining matrix stays Planned
