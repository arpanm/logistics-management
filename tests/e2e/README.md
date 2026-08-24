# Playwright E2E Tests

Feature browser tests live here and use the feature/test identifier in filenames, for example `fnd-01-tenant-isolation.spec.ts`.

Each executable test title must include its stable test-plan ID. At the final feature gate, update the matching row in `specs/<FEATURE-ID>/test-plan.md` with Passing, Failing, Blocked, or justified N/A and evidence. Remove or explicitly record all `.skip`, `.only`, quarantine, TODO, and FIXME markers before commit.

`FND-01` must add the first executable readiness and tenant bootstrap fixtures. Do not add placeholder tests that pass without exercising the application.

Run against the local deployed application:

```bash
make deploy-local
make e2e
```
