# Project TODO

This is the active execution queue. It is synchronized at the end of every feature with `FEATURES.md`, `README.md`, the feature spec/test plan/completion evidence, and executable tests.

## Active

All 18 implemented feature areas and the 50-ID acceptance matrix are complete and passing. Remaining work is production adoption/configuration rather than missing feature implementation.

| Area   | Work item                                                                                                                  | State            | Evidence or unblock condition                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| AWS    | Provision the documented EC2/RDS production environment, DNS/TLS, budgets, alarms, backups, and GitHub OIDC/SSM deployment | Planned          | Complete the README AWS runbook in the target account                             |
| INT-01 | Connect approved email, SMS, WhatsApp, GPS, and accounting providers                                                       | Pending decision | Provider, credentials, mapping, retry, privacy, and reconciliation owner approved |
| GOV-01 | Connect a production malware scanner                                                                                       | Pending decision | Scanner/provider and failure/retention policy approved                            |
| CFG-01 | Confirm commercial, tax, approval, retention, consent, and geography-specific configuration decisions                      | Pending decision | Product owner/legal sign-off                                                      |
| ALL    | Establish production capacity thresholds and an ADR trigger for scaling beyond one EC2 instance                            | Planned          | Load/availability measurements justify topology change                            |

## Blocked

None.

## Rules

- Remove an item when it is fully completed and reflected in feature completion evidence.
- Keep partial or deferred work with a feature ID, explicit state, owner/reason, and evidence/unblock condition.
- Do not use this file as a substitute for acceptance criteria or the test plan.
- Never leave completed checkboxes, stale test failures, or unowned TODO/FIXME markers after the final feature synchronization gate.
