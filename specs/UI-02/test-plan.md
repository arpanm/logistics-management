# UI-02 — Test Plan

**Plan status:** Detailed
**Overall test status:** Implemented / Not Run
**Related spec:** `specs/UI-02/spec.md`

## Risks

Passing a page-width check can conceal clipped labels, peer overlap, hidden actions, sticky-footer obstruction, responsive authorization drift, malformed Control payload crashes, or displayed summaries that no longer reconcile.

## Fixtures and environments

Use the real local Next.js frontend, NestJS backend, and shared PostgreSQL database with the versioned deterministic `DEMO` bootstrap. Use owner, operations, finance, scoped client/vendor, and mirrored Tenant B actors; real records cover all material operation, finance, POD, Control, masked-money, zero/null, long-name, and invalid-value boundaries. No browser route interception or business API mocks.

## Acceptance-to-test matrix

| Test ID         | Acceptance/risk        | Layer                  | Preconditions                              | Action                                                            | Expected result                                             | Status                | Evidence                                                                                         |
| --------------- | ---------------------- | ---------------------- | ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| UI02-OPS-001    | Operations forms       | Playwright             | Demo operations states                     | Open representative create/edit/action sheets at 320/390/768/1440 | Readable columns, no page overflow                          | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-FIN-002    | Finance forms          | Playwright             | Demo finance states                        | Open invoice/receipt/payable/payment sheets                       | Same responsive contract                                    | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-SHEET-003  | Sheet footer/focus     | Playwright/a11y        | Long form                                  | Scroll/focus first through last field, close by Escape            | No obstruction; actions reachable; focus restored           | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-REC-004    | Report filter          | Playwright/API         | Multi-state report                         | Select/reset each count                                           | Queue and count match state/API                             | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-DETAIL-005 | Structured details     | Playwright             | User/POD/allocation/invoice/canonical rows | Open details                                                      | Human labels/formats; no raw JSON/UUID-only title           | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-TABS-006   | Dense tabs             | Playwright/a11y        | Finance/Operations/Control routes          | Keyboard and pointer switch tabs                                  | Correct tab semantics, selected style, owned compact scroll | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-USERS-007  | List-first users       | Playwright/auth        | Owner and read-only actors                 | Load directory; open/close Create user                            | List first; CTA only when allowed; focus restored           | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-CTL-008    | Collection stability   | Playwright/API         | Populated/masked collection data           | Open Collection directly and via tabs                             | No page error; contained data/error state                   | Implemented / Not Run | `tests/e2e/control-tower-workbench.spec.ts`                                                      |
| UI02-CTL-009    | KPI containment/filter | Playwright             | Five lenses                                | Inspect at viewports and 200% resize; select KPI                  | No broken words/overlap; results filter                     | Implemented / Not Run | `tests/e2e/control-tower-workbench.spec.ts`                                                      |
| UI02-CTL-010    | Vendor projection      | Contract/Playwright    | Allocations across vendors                 | Inspect cards and totals                                          | Real names/numbers; no undefined/NaN                        | Passing               | Chromium 1/1; backend contract 6/6; PostgreSQL file 4/4                                          |
| UI02-CTL-011    | Long drill context     | Playwright             | 80-char portfolio name                     | Drill and return                                                  | Bounded readable context; stable back action                | Implemented / Not Run | `tests/e2e/control-tower-workbench.spec.ts`                                                      |
| UI02-SHARED-012 | Shared adoption        | Playwright             | Representative routes                      | Inspect shared surfaces at four viewports                         | Common semantics and no document overflow                   | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-ZOOM-013   | Text resize            | Playwright             | Representative surfaces                    | Apply deterministic 200% text resize                              | No clipping/lost actions                                    | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-A11Y-014   | Accessibility          | Playwright/Axe         | Representative states                      | Keyboard, focus, modal, filters                                   | Named operable controls; no serious/critical findings       | Implemented / Not Run | `tests/e2e/ui-responsive-regression.spec.ts`                                                     |
| UI02-AUTH-015   | Isolation              | API/Playwright         | Scoped actors and Tenant B                 | Visit compact/desktop routes and direct APIs                      | Same permitted fields/actions; no leakage                   | Planned               | —                                                                                                |
| UI02-VAL-016    | Validation/recovery    | Playwright/API         | Representative forms                       | Submit invalid then corrected values                              | Nearby feedback, no partial write, success reset            | Planned               | —                                                                                                |
| UI02-IDEM-017   | Duplicate submit       | Integration/Playwright | Mutation form                              | Double activate/replay key                                        | One record/audit effect                                     | Planned               | —                                                                                                |
| UI02-REC-018    | Reconciliation         | Integration/API        | Fixed `asOf`                               | Compare filters/KPIs/vendor/Collection to canonical rows          | Exact counts/minor units match                              | Partially Implemented | Vendor metadata independently reconciled by `CTL-DB-026`; remaining KPI/Collection scope Planned |

## Unit tests

Plan safe formatter/normalizer boundaries for masked, null, zero, invalid, and large values plus tab/reconciliation selection reducers.

## Integration and migration tests

No migration is expected. Control response DTO and reconciliation queries use real PostgreSQL fixtures.

## API/contract and idempotency tests

Validate required/optional Control fields, stable pages, typed errors, and duplicate mutation behavior.

## Authorization and tenant-isolation tests

Responsive cards/details must expose exactly the desktop-permitted fields and actions; foreign tenant lookalikes return empty/denied without count leakage.

## Reconciliation and audit tests

Independently aggregate canonical state counts, vendor allocation quantities, Collection ageing and visible drill totals at the same `asOf`.

## Playwright journeys

Executable coverage targets `tests/e2e/ui-responsive-regression.spec.ts`, `tests/e2e/control-tower-workbench.spec.ts`, and `tests/fixtures/responsive-ui.ts`. Assertions measure element containment, peer overlap, form columns, footer obstruction, placeholder leakage, focus, and 200% resize; waits are observable, never arbitrary sleeps.

## Accessibility and responsive checks

Run 320×568, 390×844, 768×1024, and 1440×900; verify touch targets, visible focus, tab semantics, modal trap/return, status announcements, non-colour meaning, reduced motion, and no document-level overflow.

## Failure injection and recovery

Cover malformed optional Control values, missing required summary fields, rejected validation, stale/failed requests, and retry/clear-filter recovery without blanking the route.

## Commands for an explicit batch/release test phase only

```bash
make check
make deploy-local
make health
make e2e
make verify
```

## Coverage readiness

- [x] Every acceptance criterion has at least one test ID
- [x] Boundary and negative cases are explicit
- [x] Required fixtures are deterministic and tenant-isolated
- [x] Unexecuted coverage is marked Planned

## Execution synchronization (only after an explicit test phase)

- [ ] Every test ID has a final status and evidence
- [ ] No unexplained skipped/only/quarantined test remains
- [ ] Test file names and IDs match this plan
- [ ] `FEATURES.md`, `README.md`, `TODO.md`, and `completion.md` show the same result
