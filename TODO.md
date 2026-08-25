# Project TODO

This is the active execution queue. Related items are implemented in dependency-compatible batches and synchronized once per batch with `FEATURES.md`, `README.md`, affected acceptance notes, and executable test-case status. New or changed tests remain `Implemented / Not Run` until an explicit batch/release test phase.

## Active

The product-facing remediation batch is implemented. Its newly authored tests are intentionally `Implemented / Not Run`; only external deployment and product/provider decisions remain.

| Area          | Work item                                                                                                                                                 | State                    | Evidence or unblock condition                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| MST-02/MST-03 | Define an audited unknown-PIN exception policy if operations require one; keep free-text city/state blocked until approved                                | Pending product decision | Tenant and organization flows provide retry/stale recovery without inconsistent manual addresses                    |
| AWS           | Provision the documented EC2/RDS production environment, DNS/TLS, budgets, alarms, backups, and GitHub OIDC/SSM deployment                                | Planned                  | Complete the README AWS runbook in the target account                                                               |
| INT-01        | Connect approved email, SMS, WhatsApp, GPS, and accounting providers                                                                                      | Pending decision         | Provider, credentials, mapping, retry, privacy, and reconciliation owner approved                                   |
| GOV-01        | Connect a production malware scanner                                                                                                                      | Pending decision         | Scanner/provider and failure/retention policy approved                                                              |
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
