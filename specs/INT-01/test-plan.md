# INT-01 — AWS SES Owner Invitation Test Plan

**Plan status:** Lightweight
**Overall test status:** Implemented / Not Run
**Related spec:** `specs/INT-01/spec.md`

## Risks

Token disclosure, duplicate/false-success delivery, inactive-tenant sends, cross-tenant metadata access, unescaped tenant HTML, SES sandbox rejection, lost leases, and misconfigured IAM/region/sender.

## Fixtures and environments

Use two tenants, platform and tenant-scoped actors, deterministic invitation/lease clocks, active/inactive/expired/revoked/accepted invitations, and a legacy attempt without token material. Provider contract tests use real SES only in the protected AWS release environment. The sandbox success simulator proves SES acceptance but cannot expose a clickable inbox message; real Gmail receipt remains a manual smoke test.

## Acceptance-to-test matrix

| Test ID | Acceptance/risk | Layer | Preconditions | Action | Expected result | Status | Evidence |
| ------- | --------------- | ----- | ------------- | ------ | --------------- | ------ | -------- |
| `INT01-SES-U-001` | Authenticated token envelope | Unit | Pending invite | Seal/open token | Plain token absent from envelope; correct context opens | Implemented / Not Run | `apps/backend/test/invitation-email.unit.test.ts` |
| `INT01-SES-U-002` | Envelope isolation | Unit | Sealed token | Change tenant/key | Authentication fails closed | Implemented / Not Run | `apps/backend/test/invitation-email.unit.test.ts` |
| `INT01-SES-U-003` | Safe template | Unit | Malicious tenant text | Render text/HTML | Activation link present; user markup escaped; header control removed | Implemented / Not Run | `apps/backend/test/invitation-email.unit.test.ts` |
| `INT01-SES-U-004` | Inactive-tenant deferral | Unit/source contract | Valid pending invite | Deactivate tenant | Envelope remains queued and can resume after reactivation | Implemented / Not Run | `apps/backend/test/invitation-email.unit.test.ts` |
| `INT01-SES-U-005` | Retry classification | Unit | Representative SES errors | Classify failures | Known pre-acceptance errors retry; ambiguous/terminal errors fail closed | Implemented / Not Run | `apps/backend/test/invitation-email.unit.test.ts` |
| `INT01-SES-I-001` | Atomic provisioning | PostgreSQL integration | Platform Admin | Provision/replay tenant | One invitation, attempt, and outbox event; rollback/replay safe | Planned | Not run |
| `INT01-SES-I-002` | Success reconciliation | Integration | Eligible attempt | SES accepts | Attempt/invitation/outbox/message evidence agree | Planned | Not run |
| `INT01-SES-I-003` | Token secrecy | Security integration | Created/reissued invite | Search DB/log/audit/replay | Raw token and full destination are absent | Planned | Not run |
| `INT01-SES-I-004` | Concurrency/idempotency | Integration | Parallel leases/replay | Run dispatchers | One logical request; conditional acknowledgement | Planned | Not run |
| `INT01-SES-I-005` | Failure recovery | Integration | Reject/timeout/throttle | Dispatch | Safe failure and bounded retry; never false delivered | Planned | Not run |
| `INT01-SES-I-006` | Lifecycle boundaries | Integration | Invalid lifecycle states | Dispatch/reactivate | Invalid invitations never send; valid pending resumes truthfully | Planned | Not run |
| `INT01-SES-A-001` | Role authorization | API/security | Non-platform actors | Invoke admin/worker paths | Denied without side effect | Planned | Not run |
| `INT01-SES-A-002` | Tenant isolation | API/security | Tenant A/B | Read delivery status directly | Cross-tenant evidence remains hidden | Planned | Not run |
| `INT01-SES-C-001` | Real SES acceptance | AWS contract | Verified sender; sandbox | Send to SES success simulator | SES message ID accepted and reconciled | Planned | Not run |
| `INT01-SES-C-002` | Real sandbox rejection | AWS contract | Unverified recipient | Submit email | Application records normalized failure truthfully | Planned | Not run |
| `INT01-SES-M-001` | Forward migration | Migration | Clean and legacy DB | Apply/reapply migration | Nullable legacy rows preserved; reapply no-op | Planned | Not run |
| `INT01-SES-R-001` | Audit reconciliation | Audit/report | Success/failure | Inspect safe projections | State and counts reconcile without secrets | Planned | Not run |
| `E2E-INT01-SES-01` | Primary path | Playwright + real mailbox | Protected release env | Create → receive → activate | No API token; one email link activates owner | Planned | Not run |
| `E2E-INT01-SES-02` | Reissue | Playwright + real mailbox | Pending owner | Reissue | One new email; former link invalid; no third send | Planned | Not run |
| `E2E-INT01-SES-03` | Inactive lifecycle | Playwright + real SES | Inactive tenant | Wait/reactivate | No false send; one valid send after activation | Planned | Not run |
| `E2E-INT01-SES-04` | Authorization/isolation | Playwright | Multiple actors/tenants | Inspect/operate delivery | UI and direct API deny identically | Planned | Not run |
| `SES-SMOKE-001` | Gmail receipt | Manual release smoke | Verified Gmail inbox | Send and inspect | Message arrives from expected identity; link is correct | Planned | Not run |

## Commands for an explicit batch/release test phase only

```bash
make check
make deploy-local
make health
make e2e
make verify
```

The real-provider suite is opt-in and serial. It must disable traces/screenshots/video because the email URL contains a bearer token. No Mailpit, LocalStack, request interception, direct test database writes, or test-only delivery endpoints are permitted.

## Coverage readiness

- [x] Every acceptance criterion has at least one test ID
- [x] Boundary and negative cases are explicit
- [x] Required fixtures are deterministic and tenant-isolated
- [x] Unexecuted coverage is marked Implemented / Not Run or Planned

## Execution synchronization (only after an explicit test phase)

- [ ] Every test ID has a final status and evidence
- [ ] No unexplained skipped/only/quarantined test remains
- [ ] Test file names and IDs match this plan
- [ ] `FEATURES.md`, `README.md`, `TODO.md`, and `completion.md` show the same result
