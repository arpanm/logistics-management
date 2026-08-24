# All-feature Playwright acceptance status

**Execution model:** Real locally deployed frontend and backend with the shared PostgreSQL container. No mocks, request interception, direct database fixtures, or production-code changes.

**Result:** All 90 unique feature test cases have passing real-browser evidence. The 12 previously failing cases were remediated and pass in both desktop and mobile Chromium; the remaining operations/finance mobile breadth is tracked separately and does not change the 90-case logical status.

## Test cases

| Test ID            | Feature | End-to-end behavior                                                              | Status |
| ------------------ | ------- | -------------------------------------------------------------------------------- | ------ |
| E2E-FOUND-FND01-01 | FND-01  | Platform UI provisions a tenant and persisted detail is readable                 | Passed |
| E2E-FOUND-FND01-02 | FND-01  | Invalid tenant form creates no partial tenant                                    | Passed |
| E2E-FOUND-FND01-03 | FND-01  | Tenant owner cannot access another tenant or platform APIs                       | Passed |
| E2E-FOUND-FND01-04 | FND-01  | Stale lifecycle update fails and current-version deactivate/reactivate recovers  | Passed |
| E2E-FOUND-FND01-05 | FND-01  | Platform report totals reconcile with tenant rows during concurrent provisioning | Passed |
| E2E-FOUND-FND02-01 | FND-02  | Permitted owner creates authorization proof through UI and API persistence       | Passed |
| E2E-FOUND-FND02-02 | FND-02  | Required UI validation creates no authorization proof                            | Passed |
| E2E-FOUND-FND02-03 | FND-02  | Scoped actor cannot read another tenant resource                                 | Passed |
| E2E-FOUND-FND02-04 | FND-02  | Stale proof update fails and current-version retry recovers                      | Passed |
| E2E-FOUND-FND02-05 | FND-02  | Access report and alert totals reconcile with seeded evidence                    | Passed |
| E2E-FOUND-MST01-01 | MST-01  | Permitted UI creates and persists an organization/location record                | Passed |
| E2E-FOUND-MST01-02 | MST-01  | Invalid organization/location form creates no partial record                     | Passed |
| E2E-FOUND-MST01-03 | MST-01  | Cross-tenant organization/location detail is hidden                              | Passed |
| E2E-FOUND-MST01-04 | MST-01  | Stale organization/location version fails and state transition recovers          | Passed |
| E2E-FOUND-MST01-05 | MST-01  | Organization/location report reconciles list status totals                       | Passed |
| E2E-FOUND-MST02-01 | MST-02  | Permitted UI creates and persists a client/vendor party record                   | Passed |
| E2E-FOUND-MST02-02 | MST-02  | Invalid client/vendor form creates no partial record                             | Passed |
| E2E-FOUND-MST02-03 | MST-02  | Cross-tenant client/vendor detail is hidden                                      | Passed |
| E2E-FOUND-MST02-04 | MST-02  | Stale client/vendor version fails and state transition recovers                  | Passed |
| E2E-FOUND-MST02-05 | MST-02  | Client/vendor report reconciles list status totals                               | Passed |
| E2E-FOUND-MST03-01 | MST-03  | Permitted UI creates and persists a fleet/driver record                          | Passed |
| E2E-FOUND-MST03-02 | MST-03  | Invalid fleet/driver form creates no partial record                              | Passed |
| E2E-FOUND-MST03-03 | MST-03  | Cross-tenant fleet/driver detail is hidden                                       | Passed |
| E2E-FOUND-MST03-04 | MST-03  | Stale fleet/driver version fails and state transition recovers                   | Passed |
| E2E-FOUND-MST03-05 | MST-03  | Fleet/driver report reconciles list status totals                                | Passed |
| OPS01-UI-001       | OPS-01  | UI creates an indent and API detail preserves exact values                       | Passed |
| OPS01-VAL-002      | OPS-01  | Required validation prevents partial indent mutation                             | Passed |
| OPS01-AUTH-003     | OPS-01  | Cross-tenant indent UUID access returns a safe denial                            | Passed |
| OPS01-STATE-004    | OPS-01  | Stale indent transition is rejected atomically                                   | Passed |
| OPS01-RPT-005      | OPS-01  | Indent report, list, detail, snapshots, and events reconcile                     | Passed |
| OPS02-UI-001       | OPS-02  | UI creates a vendor allocation and persists exact values                         | Passed |
| OPS02-VAL-002      | OPS-02  | Required validation prevents partial allocation mutation                         | Passed |
| OPS02-AUTH-003     | OPS-02  | Cross-tenant allocation UUID access returns a safe denial                        | Passed |
| OPS02-STATE-004    | OPS-02  | Stale allocation transition is rejected atomically                               | Passed |
| OPS02-RPT-005      | OPS-02  | Allocation report, list, detail, snapshots, and events reconcile                 | Passed |
| OPS03-UI-001       | OPS-03  | UI creates a trip and persists exact milestone values                            | Passed |
| OPS03-VAL-002      | OPS-03  | Required validation prevents partial trip mutation                               | Passed |
| OPS03-AUTH-003     | OPS-03  | Cross-tenant trip UUID access returns a safe denial                              | Passed |
| OPS03-STATE-004    | OPS-03  | Stale trip transition is rejected atomically                                     | Passed |
| OPS03-RPT-005      | OPS-03  | Trip report, list, detail, snapshots, and events reconcile                       | Passed |
| DOC01-UI-001       | DOC-01  | UI creates a POD record and persists exact delivery-document values              | Passed |
| DOC01-VAL-002      | DOC-01  | Required validation prevents partial POD mutation                                | Passed |
| DOC01-AUTH-003     | DOC-01  | Cross-tenant POD UUID access returns a safe denial                               | Passed |
| DOC01-STATE-004    | DOC-01  | Stale POD transition is rejected atomically                                      | Passed |
| DOC01-RPT-005      | DOC-01  | POD report, list, detail, snapshots, and events reconcile                        | Passed |
| FIN01-UI-001       | FIN-01  | UI creates a client invoice and persists exact amounts                           | Passed |
| FIN01-VAL-002      | FIN-01  | Required validation prevents partial invoice mutation                            | Passed |
| FIN01-AUTH-003     | FIN-01  | Cross-tenant invoice UUID access returns a safe denial                           | Passed |
| FIN01-STATE-004    | FIN-01  | Stale invoice transition is rejected atomically                                  | Passed |
| FIN01-RPT-005      | FIN-01  | Invoice report, list, detail, snapshots, and events reconcile                    | Passed |
| FIN02-UI-001       | FIN-02  | UI creates a receipt and persists exact collection values                        | Passed |
| FIN02-VAL-002      | FIN-02  | Required validation prevents partial receipt mutation                            | Passed |
| FIN02-AUTH-003     | FIN-02  | Cross-tenant receipt UUID access returns a safe denial                           | Passed |
| FIN02-STATE-004    | FIN-02  | Stale receipt transition is rejected atomically                                  | Passed |
| FIN02-RPT-005      | FIN-02  | Receipt report, list, detail, snapshots, and events reconcile                    | Passed |
| FIN03-UI-001       | FIN-03  | UI creates a vendor bill and persists exact payable values                       | Passed |
| FIN03-VAL-002      | FIN-03  | Required validation prevents partial vendor-bill mutation                        | Passed |
| FIN03-AUTH-003     | FIN-03  | Cross-tenant vendor-bill UUID access returns a safe denial                       | Passed |
| FIN03-STATE-004    | FIN-03  | Stale vendor-bill transition is rejected atomically                              | Passed |
| FIN03-RPT-005      | FIN-03  | Vendor-bill report, list, detail, snapshots, and events reconcile                | Passed |
| E2E-CTL01-01       | CTL-01  | Saved control view persists and the placement dashboard loads canonical data     | Passed |
| E2E-CTL01-02       | CTL-01  | Invalid lens is rejected without canonical mutation                              | Passed |
| E2E-CTL01-03       | CTL-01  | Anonymous and cross-tenant control access is denied                              | Passed |
| E2E-CTL01-04       | CTL-01  | Pause/resume and lens-switch recovery refresh the dashboard                      | Passed |
| E2E-CTL01-05       | CTL-01  | Dashboard totals reconcile with canonical drill rows                             | Passed |
| E2E-ALT01-01       | ALT-01  | Created alert appears in operational queue and UI acknowledgement persists       | Passed |
| E2E-ALT01-02       | ALT-01  | Invalid resolution is rejected without changing the alert record                 | Passed |
| E2E-ALT01-03       | ALT-01  | Cross-tenant alert action and queue access are isolated                          | Passed |
| E2E-ALT01-04       | ALT-01  | Stale alert action fails and current-version resolution recovers                 | Passed |
| E2E-ALT01-05       | ALT-01  | Resolved alert queue totals reconcile with returned rows                         | Passed |
| E2E-DAT01-01       | DAT-01  | Real CSV is validated and committed through the UI                               | Passed |
| E2E-DAT01-02       | DAT-01  | Invalid import records row errors without target mutation                        | Passed |
| E2E-DAT01-03       | DAT-01  | Import errors are tenant-isolated and anonymous status is denied                 | Passed |
| E2E-DAT01-04       | DAT-01  | Stale import commit fails and current-version retry succeeds                     | Passed |
| E2E-DAT01-05       | DAT-01  | Import summary reconciles with committed target records                          | Passed |
| E2E-GOV01-01       | GOV-01  | UI creates a governance policy and API persistence is verified                   | Passed |
| E2E-GOV01-02       | GOV-01  | Invalid governance policy creates no partial record                              | Passed |
| E2E-GOV01-03       | GOV-01  | Cross-tenant governance policy UUID access is denied                             | Passed |
| E2E-GOV01-04       | GOV-01  | Stale policy update fails and current-version retry succeeds                     | Passed |
| E2E-GOV01-05       | GOV-01  | Governance status report reconciles with policy records                          | Passed |
| E2E-INT01-01       | INT-01  | UI creates an integration and health view displays it                            | Passed |
| E2E-INT01-02       | INT-01  | Invalid integration payload creates no endpoint                                  | Passed |
| E2E-INT01-03       | INT-01  | Integration registry is tenant-isolated and anonymous access is denied           | Passed |
| E2E-INT01-04       | INT-01  | Failed delivery supports validated dead-letter replay and recovery               | Passed |
| E2E-INT01-05       | INT-01  | Integration health totals reconcile with delivery log                            | Passed |
| E2E-CFG01-01       | CFG-01  | Effective-dated configuration persists and renders in UI                         | Passed |
| E2E-CFG01-02       | CFG-01  | Invalid configuration creates no partial setting                                 | Passed |
| E2E-CFG01-03       | CFG-01  | Cross-tenant configuration UUID access is denied                                 | Passed |
| E2E-CFG01-04       | CFG-01  | Stale configuration update fails and safe retry creates a snapshot               | Passed |
| E2E-CFG01-05       | CFG-01  | Configuration report totals and snapshots reconcile                              | Passed |

## Remediation evidence

| Test ID(s)                                             | Resolution                                                                                                 | Evidence                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| E2E-FOUND-FND01-05                                     | Platform report rows and aggregates use one PostgreSQL snapshot                                            | Desktop and mobile pass under concurrent provisioning; totals and status counts reconcile                   |
| OPS02-UI-001, OPS03-UI-001, DOC01-UI-001, FIN02-UI-001 | Semantic combobox selection replaces brittle exact wrapping-label lookup                                   | Desktop and mobile each receive one HTTP 201 and verify exact queue/detail persistence                      |
| FIN01-UI-001, FIN03-UI-001                             | Exact success-message assertion replaces the ambiguous status-role locator                                 | Desktop and mobile pass while retaining queue and API detail checks                                         |
| E2E-ALT01-01, E2E-ALT01-04, E2E-ALT01-05               | Alert ingestion, actions, queue, and report use one canonical operational store with versioned idempotency | Desktop and mobile prove create, acknowledge, stale 409, current resolve, and resolved-queue reconciliation |
| E2E-INT01-01                                           | Integration form retains its DOM reference across the asynchronous request and reloads canonical state     | Desktop and mobile display the persisted endpoint without navigation or reload                              |
| E2E-INT01-04                                           | Delivery and dead-letter APIs use canonical tables with versioned, idempotent transitions                  | Desktop and mobile prove fail→replay twice on one delivery, ending at version 5 and replay count 2          |

## Execution evidence

- `all-features-foundation-masters.spec.ts`: all 25 logical IDs pass; the remediated concurrent-report case passes in desktop and mobile Chromium.
- `all-features-operations-finance.spec.ts`: all 35 logical IDs pass; all six remediated UI cases pass in desktop and mobile Chromium. Remaining mobile breadth is tracked in `TODO.md`.
- `all-features-intelligence-governance.spec.ts`: all 30 logical IDs pass; all five remediated alert/integration cases pass in desktop and mobile Chromium.
- Focused remediation matrix: all 12 affected IDs pass in both projects, 24/24 ID-project results with no rerun or flake.
- Playwright discovery: 122 configured project executions across the three files.

Generated Playwright reports, traces, and screenshots remain ignored and are not committed.

Detailed root-cause analysis and resolution evidence for all 12 remediated cases are maintained in `BUGS.md`.
