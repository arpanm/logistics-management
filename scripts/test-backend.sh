#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -f .env ]]; then set -a; source .env; set +a; else set -a; source .env.example; set +a; fi
export DATABASE_URL="$TEST_DATABASE_URL"
export POSTAL_IMPORT_DATABASE_URL="${TEST_POSTAL_IMPORT_DATABASE_URL:?TEST_POSTAL_IMPORT_DATABASE_URL is required}"
export POSTAL_IMPORT_EXPECTED_DATABASE="${POSTGRES_TEST_DB:-logistics_test}"
export APP_ENV=test
export NODE_ENV=test
export ENABLE_TEST_HOOKS=true

bash scripts/test-fnd02-populated-upgrade.sh
bash scripts/test-mst01-populated-upgrade.sh
bash scripts/prepare-clean-test-database.sh
pnpm --filter @logistics/db exec prisma migrate deploy
bash scripts/postgres-postal-handoff.sh "${POSTGRES_TEST_DB:-logistics_test}"
pnpm --filter @logistics/db postal:verify-ownership
# A second deploy is an explicit idempotency proof: it must report no pending
# migration and must leave the unrelated sentinel schema untouched.
pnpm --filter @logistics/db exec prisma migrate deploy
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm -r --filter './packages/*' --if-present run build
pnpm --filter @logistics/backend exec vitest run test/fnd01.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/fnd02.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/mst01.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/bug-e2e-canonical.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/backend exec vitest run test/all-feature-gaps.contract.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/access-master-remediation.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/operations-workbench.contract.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/finance-workbench.contract.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/control-governance-workbench.contract.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @logistics/db run db:reset:test
pnpm --filter @logistics/db run db:seed
pnpm --filter @logistics/backend exec vitest run test/control-workbench.integration.test.ts --maxWorkers=1 --no-file-parallelism
