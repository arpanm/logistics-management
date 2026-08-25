# API Baseline

FND-01 exposes a versioned JSON API under `/api/v1`. The Next.js frontend uses the same origin through its backend rewrite; direct local backend access is available at `http://127.0.0.1:4000/api/v1`.

## Authentication and request rules

- Authentication uses an opaque `HttpOnly` session cookie and a double-submit CSRF cookie/header for state changes.
- Tenant context is derived from the authenticated session and an active membership. Tenant identifiers supplied in headers, query strings, or bodies never broaden scope.
- Mutating provisioning, lifecycle, and probe-create operations require `Idempotency-Key`; replay with a different request returns a conflict.
- Errors use `code`, safe `message`, `correlationId`, and optional field-error arrays. Cross-tenant resource guesses use non-leaking denial/not-found responses.
- Local/test-only fixture controls require Platform Admin authentication and CSRF, and startup rejects enabled hooks when `APP_ENV=production`.

## Route groups

| Group               | Main routes                                                                            | Access                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Health              | `GET /health/live`, `GET /health/ready`                                                | Public safe summaries; readiness verifies PostgreSQL and applied Prisma migrations |
| Authentication      | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, invitation preview/acceptance | Public entry points plus authenticated session operations                          |
| Tenant session      | `POST /session/active-tenant`                                                          | Authenticated user with an active membership in the selected tenant                |
| Platform tenancy    | tenant list/create/detail, deactivate/reactivate                                       | Platform Admin only                                                                |
| Platform operations | `GET /platform/report`, `GET /platform/alerts`                                         | Platform Admin only; aggregate metadata excludes tenant business payloads          |
| Tenant setup        | `GET /tenant/context`, `PATCH /tenant/setup/:key`                                      | Active Tenant Owner context                                                        |
| Isolation probes    | probe list/create/detail/update, document, CSV export, report                          | Active Tenant Owner context; server-derived tenant scope                           |

The complete field, response, idempotency, lifecycle, and failure semantics are defined in `specs/FND-01/spec.md`. Executable contract and isolation evidence is in the backend integration suite and `tests/e2e/fnd-01-tenant-foundation.spec.ts`.
