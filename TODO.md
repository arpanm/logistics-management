# Project TODO

This is the active execution queue. It is synchronized at the end of every feature with `FEATURES.md`, `README.md`, the feature spec/test plan/completion evidence, and executable tests.

## Active

Canonical backend coverage exists for all feature areas, but the following product-facing remediation is still required. Implement and test these in dependency order; do not mark the corresponding product UX complete from API-only evidence.

| Area                 | Work item                                                                                                                                                 | State                  | Evidence or unblock condition                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| FND-02               | Enrich the structured directory with profile editing, server-paginated filters, invitation expiry/destination summary, and session/MFA/history panels     | Planned follow-up      | Core raw-JSON removal, activation copy, permission tester, and Activity & audit journeys pass in `E2E-FND02-07..09` |
| FND-01/MST-01/MST-02 | Add central PostgreSQL postal-code directory/lookup and reusable pincode-first address fields that derive locality/city/state                             | Pending implementation | Required for tenant, organization, client-location, vendor, and driver address forms                                |
| MST-01/02/03/CFG-01  | Add a Masters landing hub/sub-navigation and configured truck/body/cargo reference masters                                                                | Pending implementation | Existing master routes are implemented but poorly discoverable; type inputs remain free text                        |
| OPS-01               | Build the Operations dashboard with searchable open indents and create/update/allocate CTAs                                                               | Pending implementation | Current landing page is link cards only                                                                             |
| OPS-02               | Build allocation workbench, eligible-vendor preview, manual allocation, auto-allocation rule CRUD/preview/execute, and allocations queue                  | Pending implementation | Existing record APIs/CTAs are fragmented and no auto-allocation rule model exists                                   |
| OPS-03               | Add trip creation and actionable accept/start/load/transit/unload/end queue CTAs                                                                          | Pending implementation | Existing transitions are available only after opening seeded records                                                |
| FIN-01/02/03         | Build invoice, collection, vendor-payable and payment-run dashboards/queues; fix invoice-line selector contract                                           | Pending implementation | Current finance landing is link cards and work queues are not productized                                           |
| CTL-01               | Rebuild control tower to match `backup/dashboard.html` UX using canonical PostgreSQL metrics, filters, three-level drill, ageing, export, and record CTAs | Pending implementation | Current board has flat drill, missing filters/tables and mismatched KPI/freshness contracts                         |
| AWS                  | Provision the documented EC2/RDS production environment, DNS/TLS, budgets, alarms, backups, and GitHub OIDC/SSM deployment                                | Planned                | Complete the README AWS runbook in the target account                                                               |
| INT-01               | Connect approved email, SMS, WhatsApp, GPS, and accounting providers                                                                                      | Pending decision       | Provider, credentials, mapping, retry, privacy, and reconciliation owner approved                                   |
| GOV-01               | Connect a production malware scanner                                                                                                                      | Pending decision       | Scanner/provider and failure/retention policy approved                                                              |
| CFG-01               | Confirm commercial, tax, approval, retention, consent, and geography-specific configuration decisions                                                     | Pending decision       | Product owner/legal sign-off                                                                                        |
| ALL                  | Establish production capacity thresholds and an ADR trigger for scaling beyond one EC2 instance                                                           | Planned                | Load/availability measurements justify topology change                                                              |

## Blocked

None.

## Rules

- Remove an item when it is fully completed and reflected in feature completion evidence.
- Keep partial or deferred work with a feature ID, explicit state, owner/reason, and evidence/unblock condition.
- Do not use this file as a substitute for acceptance criteria or the test plan.
- Never leave completed checkboxes, stale test failures, or unowned TODO/FIXME markers after the final feature synchronization gate.
