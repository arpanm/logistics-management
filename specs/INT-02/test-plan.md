# INT-02 — Conversational operations test plan

**Status:** Implemented / Not Run; no automated case or real-provider smoke was run in this implementation batch

| ID | Level | Scenario | Expected result | Status |
| --- | --- | --- | --- | --- |
| INT02-UNIT-001 | Unit | English intent, unknown fields, prompt-injection text, confidence and normalization | Only a strict registered proposal or clarification is returned | Implemented / Not Run |
| INT02-UNIT-002 | Unit | Strict attachment metadata, closed intent values and unsupported/injection-like text | Invalid/unknown input is rejected or clarified without dispatch | Implemented / Not Run |
| INT02-API-003 | Contract | Authenticated conversation create/list/message/confirm/cancel and CSRF | Session actor is server-derived; CSRF and proposal version are enforced | Implemented / Not Run |
| INT02-AUTH-004A | PostgreSQL/API | Two tenants, foreign reference and revoked membership | No cross-tenant row/label/count leaks; execution fails closed | Implemented / Not Run |
| INT02-AUTH-004B | PostgreSQL/API | Scoped roles and the same user with multiple tenant memberships | Scope and tenant are never guessed or widened | Implemented / Not Run |
| INT02-IDEM-005 | PostgreSQL/API | Duplicate signed webhook, message, confirmation and processing retry | One proposal, execution and business effect | Implemented / Not Run |
| INT02-WA-006A | Contract/PostgreSQL | Valid/invalid signature, atomic duplicate claim, unbound/ambiguous sender, consent, quiet hours, retry/dead-letter and disabled polling | Only verified active binding processes content; failures do not enumerate or leak secrets | Implemented / Not Run |
| INT02-WA-006B | Contract/PostgreSQL | Link challenge, revoked binding and crash/reply recovery | Link/recovery is single-use, recoverable and non-enumerating | Implemented / Not Run |
| INT02-FILE-007 | Integration | Real CSV/XLSX/PDF/PNG plus BOM, corrupt, oversized and checksum-mismatch files | Imports preview/commit through DAT-01; documents remain quarantined | Implemented / Not Run |
| INT02-APPROVAL-008 | Contract | Approval decision, wrong role, maker-as-checker, stale version and expiry | Only an eligible different approver can decide once | Implemented / Not Run |
| INT02-E2E-009 | Playwright | Chat clarification, create/confirm and responsive mobile workspace | Responsive accessible UI mirrors canonical result and safe errors | Implemented / Not Run |
| INT02-E2E-010 | Real provider | Linked WhatsApp test number sends text/media, confirmation, consent, alert and repeated delivery | Signed inbound/outbound flows work once without secret leakage | Blocked — provider not configured |

The explicit batch test phase runs these once against real PostgreSQL and, for `INT02-E2E-010`, an approved provider test number. No mock may be used as evidence of provider delivery.
