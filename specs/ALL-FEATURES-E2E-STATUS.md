# All-feature Playwright acceptance status

**Execution model:** Real locally deployed Next.js frontend and NestJS backend using the shared PostgreSQL container. No mocks, request interception, direct database business fixtures, skipped cases, or weakened assertions.

**Result:** Passing — 180/180 configured executions across Chromium and mobile Chromium.

## Active acceptance suites

| Suite                                     | Logical cases | Browser executions | Status     |
| ----------------------------------------- | ------------: | -----------------: | ---------- |
| `fnd-01-tenant-foundation.spec.ts`        |             7 |                 14 | Passed     |
| `fnd-02-identity-access.spec.ts`          |             8 |                 16 | Passed     |
| `all-features-foundation-masters.spec.ts` |            25 |                 50 | Passed     |
| `all-feature-gaps.spec.ts`                |            50 |                100 | Passed     |
| **Total**                                 |        **90** |            **180** | **Passed** |

The 50 canonical gap IDs cover masters, operations, POD, finance, control tower, alerts, imports, governance, integrations, configuration, cross-feature journeys, and isolated security/accessibility risks. Their individual status and mappings are maintained in [`ALL-FEATURE-GAPS/test-plan.md`](ALL-FEATURE-GAPS/test-plan.md).

## Final evidence

- `make check` passed formatting, lint, typecheck, unit, integration, migration, authorization, security, and canonical contract gates.
- `make e2e` passed 180/180 against the deployed application and shared PostgreSQL.
- The final regression failures were recorded as `BUG-GAP-013` through `BUG-GAP-017`, corrected, and passed in the consolidated rerun.
- Generated Playwright reports, traces, and screenshots remain ignored and are not committed.
