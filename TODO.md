# Project TODO

This is the active execution queue. Related items are implemented in dependency-compatible batches and synchronized once per batch with `FEATURES.md`, `README.md`, affected acceptance notes, and executable test-case status. New or changed tests remain `Implemented / Not Run` until an explicit batch/release test phase.

## Active

Canonical backend coverage exists for all feature areas, but the following product-facing remediation is still required. Implement and test these in dependency order; do not mark the corresponding product UX complete from API-only evidence.

| Area          | Work item                                                                                                                                                 | State                    | Evidence or unblock condition                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| FND-02        | Enrich the structured directory with profile editing, server-paginated filters, invitation expiry/destination summary, and session/MFA/history panels     | Planned follow-up        | Core raw-JSON removal, activation copy, permission tester, and Activity & audit journeys pass in `E2E-FND02-07..09` |
| MST-02/MST-03 | Adopt PostgreSQL PIN-derived addressing in client-location, vendor, and driver forms; do not ask for city/state separately                                | Pending implementation   | Tenant and organization flows pass `E2E-FND01-PIN-01` and `E2E-MST01-01/02/04`                                      |
| MST-02/MST-03 | Define an audited unknown-PIN exception policy if operations require one; keep free-text city/state blocked until approved                                | Pending product decision | Tenant and organization flows provide retry/stale recovery without inconsistent manual addresses                    |
| MST-03/CFG-01 | Add configured truck/body/cargo reference masters to the completed Masters hub                                                                            | Pending implementation   | `/app/masters` hub/subnavigation is complete; transport type inputs remain free text                                |
| OPS-01        | Build the Operations dashboard with searchable open indents and create/update/allocate CTAs                                                               | Pending implementation   | Current landing page is link cards only                                                                             |
| OPS-02        | Build allocation workbench, eligible-vendor preview, manual allocation, auto-allocation rule CRUD/preview/execute, and allocations queue                  | Pending implementation   | Existing record APIs/CTAs are fragmented and no auto-allocation rule model exists                                   |
| OPS-03        | Add trip creation and actionable accept/start/load/transit/unload/end queue CTAs                                                                          | Pending implementation   | Existing transitions are available only after opening seeded records                                                |
| FIN-01/02/03  | Build invoice, collection, vendor-payable and payment-run dashboards/queues; fix invoice-line selector contract                                           | Pending implementation   | Current finance landing is link cards and work queues are not productized                                           |
| CTL-01        | Rebuild control tower to match `backup/dashboard.html` UX using canonical PostgreSQL metrics, filters, three-level drill, ageing, export, and record CTAs | Pending implementation   | Current board has flat drill, missing filters/tables and mismatched KPI/freshness contracts                         |
| AWS           | Provision the documented EC2/RDS production environment, DNS/TLS, budgets, alarms, backups, and GitHub OIDC/SSM deployment                                | Planned                  | Complete the README AWS runbook in the target account                                                               |
| INT-01        | Connect approved email, SMS, WhatsApp, GPS, and accounting providers                                                                                      | Pending decision         | Provider, credentials, mapping, retry, privacy, and reconciliation owner approved                                   |
| GOV-01        | Connect a production malware scanner                                                                                                                      | Pending decision         | Scanner/provider and failure/retention policy approved                                                              |
| GOV-01        | Restore the policy create/edit form at `/app/governance/policies` or move it to an explicit route and update navigation/tests                             | Product bug              | Focused `E2E-GOV01-01` cannot find `Code`; route renders `Governed evidence`; `BUG-GAP-018`                         |
| CFG-01        | Confirm commercial, tax, approval, retention, consent, and geography-specific configuration decisions                                                     | Pending decision         | Product owner/legal sign-off                                                                                        |
| ALL           | Establish production capacity thresholds and an ADR trigger for scaling beyond one EC2 instance                                                           | Planned                  | Load/availability measurements justify topology change                                                              |

## Blocked

None.

## Rules

- Remove an item when implementation is complete and reflected in the synchronized batch trackers; test execution may remain separately `Implemented / Not Run`.
- Keep partial or deferred work with a feature ID, explicit state, owner/reason, and evidence/unblock condition.
- Do not use this file as a substitute for acceptance notes or executable test cases.
- During an explicit test phase, record failures once and do not automatically fix/retry/rerun unless requested.
- Never leave completed work or unowned TODO/FIXME markers after batch synchronization.
