# UI-02 — Responsive workbench components and Control Tower remediation

**Status:** Implemented locally
**Feature source:** User-reported screenshot audit on 1 September 2026
**Owner:** Primary agent

## Problem and outcome

Repeated feature-local form, modal, detail, tab, metric, and report patterns fail at compact widths: labels collapse to individual characters, sticky action areas cover inputs, raw JSON leaks into details, dense tabs overflow, and Control Tower data-contract drift renders `undefined` or throws during formatting. Deliver shared app-native Material-like components and migrate the reported surfaces without changing domain workflows or authorization.

## In scope

- Shared tabs, bottom-sheet/dialog structure, form grid/action footer, detail list, metric cards, filter chips, and responsive data presentation.
- Operations and Finance action sheets; User directory list-first invitation; canonical/module reconciliation and details.
- Control Tower card hierarchy, vendor summary normalization, long drill context, and Collection formatting resilience.
- Responsive, keyboard, focus, zoom, error, empty, and masked-value behavior.

## Out of scope

- Workflow, accounting, allocation, permission, or tenant-isolation changes.
- Adding Material UI or another component framework; the existing React/CSS system implements Material 3 principles.
- Schema changes or new infrastructure.

## Dependencies and assumptions

| Item           | State/decision                                                       | Evidence                         |
| -------------- | -------------------------------------------------------------------- | -------------------------------- |
| Runtime        | Existing Next.js, NestJS, and shared PostgreSQL only                 | Repository architecture contract |
| Design system  | Extend app-native semantic tokens and React primitives               | UI-01 and ADR 0001               |
| Control data   | Required response fields are normalized; optional values display `—` | Screenshot and source audit      |
| Test execution | Author automated coverage but do not run it during implementation    | Current feature-SDLC policy      |

## Actors, permissions, and scopes

| Actor/capability          | Allowed scope                                                     | Sensitive fields/actions                               | Denied behavior                                   |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Tenant owner/access admin | Existing tenant directory and invitation capabilities             | Existing reset, role, scope, and contact rules         | Responsive views never add capabilities           |
| Operations user           | Existing scoped indent/allocation/trip actions                    | Assignment and transition rules remain server-enforced | No foreign tenant/client/vendor records           |
| Finance user              | Existing scoped billing, collection, payable, and payment actions | Masking and maker/checker rules remain unchanged       | No responsive disclosure of hidden money/PII      |
| Control user              | Existing permitted lenses, fields, drills, and exports            | Masked money remains masked                            | Missing data cannot expand scope or reveal totals |

## UX flow

### Primary flow

1. Lists and registers render first. Primary create actions open a labelled desktop dialog or compact bottom sheet.
2. Sheets have fixed chrome, one independently scrolling body, safe-area-aware actions, nearby feedback, and focus trap/return.
3. Compact forms use one column; medium/desktop columns are allowed only when labels and controls retain usable width.
4. Reconciliation states and KPI cards are selectable filters with pressed state, result count, and an All/reset control.
5. Details use human labels, localized dates, semantic statuses, Yes/No booleans, secondary identifiers, and structured nested sections—never raw JSON.
6. Dense tabs use a shared contained/pill treatment with owned horizontal scrolling and keyboard tab semantics.
7. Control Tower follows hero/freshness, lens tabs, metrics, filters, drill context, then responsive portfolios/locations/records.

### Validation, loading, empty, error, retry, and stale states

Errors remain within the active sheet or panel with field/correlation context. Corrective input is retained. Successful create resets and closes the form once and refreshes its list. Required malformed Control payloads produce a contained retryable panel; optional invalid, null, masked, or absent values display safely.

### Responsive and accessibility behavior

Required viewports are 320, 390, 768, and 1440 CSS px plus 200% text resize. There is no document-level horizontal scrolling. Controls are at least 44 CSS px, labels break only at word boundaries, dialogs support Escape/backdrop dismissal and focus restoration, tabs implement roving keyboard focus, and status/filter changes are announced.

## Data model and migration

No persistence or migration change. UI state remains ephemeral or existing URL query state.

## Domain rules and calculations

Money remains exact integer minor-unit text from the API. UI formatting must not coerce masked or invalid values through `BigInt`. Percentages guard zero denominators. Dates are formatted in tenant timezone. Vendor allocation totals use the server DTO and never infer missing required values.

## API, events, and jobs

| Interface/event/job    | Input                                 | Output/effect                                     | Auth/idempotency/failure behavior                                   |
| ---------------------- | ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Control workbench read | Existing lens/filter/page query       | Typed summaries, vendor allocation and paged rows | Existing server-derived tenant/scope; invalid contract is contained |
| Canonical list/report  | Existing search/state/report requests | Queue plus state counts                           | Existing authorization; selected state filters the queue            |
| Existing mutations     | Existing form payload/idempotency key | One authoritative record/change                   | Pending state prevents duplicate submit; server rules unchanged     |

## Reports and alerts

Reconciliation count controls filter the queue below and display selected/all totals. Control metrics and vendor summaries continue to reconcile with the same scoped rows and `asOf`; this feature changes presentation and boundary validation only.

## Audit, observability, and security

No new sensitive logging. Client boundaries must not stringify arbitrary payloads. All responsive alternatives preserve server-derived tenant, role, scope, and field masking.

## Lightweight acceptance notes

| Acceptance criterion                            | Design section                | Planned test IDs                                            |
| ----------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Shared primitives and readable responsive forms | UX flow                       | UI02-OPS-001, UI02-FIN-002, UI02-SHEET-003, UI02-SHARED-012 |
| Interactive reconciliation                      | Reports                       | UI02-REC-004, UI02-REC-018                                  |
| Structured details without raw JSON             | UX flow                       | UI02-DETAIL-005                                             |
| Accessible contained tabs                       | Responsive behavior           | UI02-TABS-006, UI02-A11Y-014                                |
| User directory is list-first                    | Primary flow                  | UI02-USERS-007                                              |
| Stable, readable Control Tower                  | Primary flow and calculations | UI02-CTL-008 through UI02-CTL-011                           |
| Authorization, validation, idempotency          | Security/error states         | UI02-AUTH-015 through UI02-IDEM-017                         |

## Open decisions

| Decision | Safe default | Owner/impact |
| -------- | ------------ | ------------ |
| None     | —            | —            |

## Readiness

- [x] Intended outcome and material rules are clear
- [x] Dependencies and affected interfaces are identified
- [x] Planned automated coverage is listed
