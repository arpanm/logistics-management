# Playwright E2E Tests

Feature browser tests live here and use the feature/test identifier in filenames, for example `fnd-01-tenant-isolation.spec.ts`.

`FND-01` must add the first executable readiness and tenant bootstrap fixtures. Do not add placeholder tests that pass without exercising the application.

Run against the local deployed application:

```bash
make deploy-local
make e2e
```

