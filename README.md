# Logistics Operations Control Tower

A configurable, multi-tenant B2B logistics platform for managing client contracts, truck indents, vendor placement, trips, POD, client billing and collections, vendor payables, alerts, and control-tower reporting.

The product requirements and per-feature implementation/test status are maintained in [FEATURES.md](FEATURES.md). The active execution queue is [TODO.md](TODO.md), and failed-acceptance RCA is maintained in [BUGS.md](BUGS.md). Supplied Juri Gari prototypes and the workbook are preserved in `backup/` as read-only reference material and intentionally excluded from Git.

## Current project status

| Item                              | Status                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentic SDLC scaffold             | Complete                                                                                                                                                       |
| Application bootstrap             | Complete — `FND-01` concurrent report reconciliation is fixed and verified                                                                                     |
| Automated feature tests           | Implemented / Not Run for the final MST-01 tree — focused backend/browser evidence exists; repeated full regression was stopped and deferred by user direction |
| Local frontend/backend deployment | Healthy on ports 3000/4000 against shared PostgreSQL                                                                                                           |
| Feature implementation            | Canonical backend baseline complete; product-UX gap remediation is active and tracked in `TODO.md`                                                             |

Agents synchronize this summary, `FEATURES.md`, `TODO.md`, affected specs, and executable test-case status once per implementation batch. New or changed tests remain `Implemented / Not Run` until an explicitly requested batch/release test phase executes them.

The implementation includes normalized canonical stores and workflows for masters, operations, POD, finance, governance, configuration, control-tower, alerts, imports, and integrations. A product-UX audit found that several of those backend-complete areas still expose scaffolding or incomplete workbenches; the dependency-ordered remediation queue is recorded in `TODO.md`.

## Implemented feature surface

| Feature | Implemented user surface                                                                                | Canonical behavior                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FND-01  | `/platform/tenants`, `/platform/report`, `/app/setup`                                                   | PIN-first tenant provisioning with derived city/state, lifecycle, branding, setup, isolation, health, reports, and alerts                                                           |
| FND-02  | `/app/access/users`, `/app/access/roles`, `/app/access/reports`, `/mfa`                                 | Structured access administration, secure activation links, permission review, Activity & audit, alerts, MFA, and sessions                                                           |
| MST-01  | `/app/masters`, `/app/masters/locations`, `/app/masters/employees`                                      | Discoverable Masters hub, PIN-derived organization geography, structured geofences, employees, scoped ownership, impact/reassignment, reports, export, alerts, and cycle-safe moves |
| MST-02  | `/app/masters/parties`, `/app/masters/client-locations`, `/app/masters/contracts`, `/app/masters/lanes` | Clients, locations, versioned contracts, lanes, SLA rules, and effective rate cards                                                                                                 |
| MST-03  | `/app/masters/vendors`, `/app/masters/fleet`, `/app/masters/drivers`                                    | Vendors, encrypted bank versions, vehicles, drivers, compliance, eligibility, and overrides                                                                                         |
| OPS-01  | `/app/operations/indents`                                                                               | Idempotent indents, commercial/SLA snapshots, partial cancellation, lifecycle, reports, and alerts                                                                                  |
| OPS-02  | `/app/operations/allocations`                                                                           | Split allocation, offer response/expiry, eligibility, vehicle/driver assignment, replacement, and placement                                                                         |
| OPS-03  | `/app/operations/trips`, `/portal/driver`                                                               | Assigned trip execution, immutable milestones, offline/GPS ordering evidence, delivery, and POD handoff                                                                             |
| DOC-01  | `/app/pod`, governed evidence panels                                                                    | POD tasks, review/submission, secure versioned documents, scoped downloads, ageing, and value-at-risk                                                                               |
| FIN-01  | `/app/finance/invoices`                                                                                 | Exact minor-unit invoice lines, acknowledgement, notes, posting controls, service links, and reversals                                                                              |
| FIN-02  | `/app/finance/receipts`                                                                                 | Receipt allocation ledger, reconciliation, reversal, follow-up promises, balances, and collections                                                                                  |
| FIN-03  | `/app/finance/vendor-bills`                                                                             | Vendor-bill validation, maker/checker decisions, verified-bank payment batches, deductions, and reversals                                                                           |
| CTL-01  | `/app/control`                                                                                          | Canonical placement, POD, collection, trip, and payable KPIs with saved views, drill-down, and freshness                                                                            |
| ALT-01  | `/app/alerts`                                                                                           | Scoped rules, deduplicated evaluation, work queues, acknowledgement, escalation, snooze, resolution, and delivery attempts                                                          |
| DAT-01  | `/app/data`                                                                                             | Real CSV/XLSX parsing, header/row validation, seven canonical adapters, preview, commit, correction, and reconciliation                                                             |
| GOV-01  | `/app/governance/policies` and record evidence panels                                                   | Documents, visibility-aware comments, approval definitions/decisions, immutable audit, and segregation                                                                              |
| INT-01  | `/app/integrations`                                                                                     | API clients, credential rotation, signed webhooks, mapping versions, delivery attempts, dead letters, and replay                                                                    |
| CFG-01  | `/app/configuration/settings`                                                                           | Typed tenant configuration, semantic validation, versioned publish/rollback, branding, codes, and thresholds                                                                        |

The detailed fields, calculations, reports, alerts, acceptance criteria, and cross-feature journeys remain in [FEATURES.md](FEATURES.md).

### Pending production-adoption TODOs

PIN-first derived addressing is complete for tenant provisioning and organization/geography masters. Client-location, vendor, and driver adoption remains queued with MST-02/MST-03. The Masters hub is live; configured truck/body/cargo catalogs, operations/allocation/trip workbenches, finance queues, and control-tower prototype parity remain in [TODO.md](TODO.md). Production adoption requires the AWS environment below, a pinned official India postal dataset, DNS/TLS, monitoring/backups/restore drills, secret rotation, and selection of real messaging, malware-scanning, GPS, and accounting providers.

## Engineering baseline

- TypeScript monorepo managed with `pnpm`
- Next.js frontend in `apps/frontend`
- NestJS backend in `apps/backend`
- PostgreSQL with Prisma migrations
- Vitest for unit/integration tests
- Playwright for browser end-to-end tests
- One central Docker PostgreSQL container shared by this and other local projects

Redis, queues, object storage, Mailpit, and other supporting containers are intentionally excluded. PostgreSQL is the only local infrastructure dependency for now. The decision is documented in [ADR 0001](docs/decisions/0001-application-baseline.md).

## Central PostgreSQL

The project reuses one container named `shared-postgres` and one shared volume. It provisions project-specific roles, databases, and schemas inside that container. Project scripts never stop, reset, or delete the shared container or volume.

```bash
cp .env.example .env
make bootstrap
make postgres-up
```

Default project resources:

- Databases: `logistics`, `logistics_test`
- Schemas in each database: `app`, `audit`, `reporting`
- Application role: `logistics_app`

Other projects may use the same container with their own database/schema names.

Local and E2E bootstrap uses a small deterministic India postal fixture, including `500016`, `560043`, `700001`, and an ambiguous `110001`. It is test data, not the production directory. Production readiness rejects that fixture and requires the checksum-verified offline import described in the AWS section.

## Application commands

```bash
make dev
make check
make deploy-local
make e2e
make verify
```

The rapid implementation workflow does not invoke these test/deployment commands after every feature. Use `make check`, `make deploy-local`, `make e2e`, and `make verify` only for an explicitly requested batch/release test phase; run the selected scope once and record pass/fail without automatic retry.

See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) for setup and [docs/SDLC.md](docs/SDLC.md) for the feature workflow.

## Local setup and feature testing

### Prerequisites and first start

Install Git, Docker Desktop/Engine, Node.js 22 LTS, pnpm 11, GNU Make, and `screen`. Homebrew's latest Node release may not bundle Corepack, so install pnpm explicitly:

```bash
brew install node@22 pnpm
brew unlink node 2>/dev/null || true
brew link --overwrite node@22
```

Node.js 22 is the recommended runtime (Node.js 24 is also accepted). Node.js 25+ is not supported by the current Playwright toolchain and can leave full E2E workers waiting after their tests finish. `make bootstrap` checks the runtime version before installing dependencies.

Alternatively, with a Node.js distribution that includes Corepack:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
```

Installing pnpm only installs the package manager; it does **not** install this repository's dependencies or configure its Git hooks. Run the following sequence once after cloning, and run `make bootstrap` again whenever `package.json` or `pnpm-lock.yaml` changes:

```bash
cp .env.example .env
# Replace AUTH_SECRET, PLATFORM_ADMIN_PASSWORD, and MFA_ENCRYPTION_KEY in .env.
make bootstrap
make postgres-up
make deploy-local
make health
```

Do not skip `make bootstrap`: it installs locked dependencies and configures the Git hook. The hook runs the lightweight batch gate (policy/status, formatting, lint, and type checking), not database, browser, or full regression tests.

### Administrator login

Local `make deploy-local` applies migrations and runs the deterministic seed. Unless overridden in `.env`, sign in at <http://127.0.0.1:3000/login> with:

| Field    | Local development value |
| -------- | ----------------------- |
| Email    | `admin@local.test`      |
| Password | `LocalAdmin!234`        |

This is the **Platform Admin** account used to provision and manage tenants. It is not a Tenant Owner account. Each tenant's first Tenant Owner sets their own credentials through the invitation created during tenant provisioning; Vendor, Driver, Client, and employee users likewise use their individual invitation credentials.

Local and default self-hosted adapters do not send real email. If the initial owner link is missed, open Platform Admin → Tenants → the tenant → **Generate replacement activation link**, enter an audit reason, and copy the one-time link to the owner through a trusted channel. Creating a replacement invalidates the previous link. After activation, the Tenant Owner manages users, roles, scopes, invitation resend/revoke, suspension, MFA, and session resets at `/app/access/users`; Platform Admin does not impersonate tenant administrators.

`make deploy-local` reseeds the Platform Admin and therefore resets its password to the current `PLATFORM_ADMIN_PASSWORD` value in `.env`. Never use the committed local default in AWS or any shared environment.

In local/test environments, `http://localhost:3000` and `http://127.0.0.1:3000` are treated as equivalent loopback origins on the configured port. Production accepts only the exact HTTPS origin configured in `FRONTEND_URL`.

Tenant primary and accent colors may use any valid six-digit hex value. Tenant-branded surfaces automatically select black or white foreground text for WCAG AA contrast; administrators do not need to alter a valid brand color merely to match a fixed text color.

Mobile fields accept common spaces, hyphens, dots, and parentheses and normalize them to E.164 for storage. Include the leading country code and `+`; for example, `+91 7766974950` is stored as `+917766974950`.

If a commit reports `rg: command not found`, pull the current scripts: the policy check no longer depends on ripgrep. If it reports `pnpm: command not found` or missing packages, install pnpm and run `make bootstrap`. A later PostgreSQL `42P01 relation "app.users" does not exist` in the attached log was a concurrent test-database reset, not a pnpm installation failure; wait for the other test/commit process to finish and rerun the commit once.

### Recommended manual flow

1. Sign in as Platform Admin, open `/platform/tenants`, provision a tenant, and use the local invitation link to activate its Tenant Owner.
2. As Tenant Owner, complete branding at `/app/setup`; create scoped users and roles under `/app/access/users` and `/app/access/roles`.
3. Build master data in dependency order: organization/employees → client/location/contract/lane/rate → vendor/vehicle/driver/compliance.
4. Run the operating chain: indent → allocation/offer → vehicle/driver assignment → trip events/delivery → POD review.
5. Run finance: invoice/acknowledgement → receipt allocation/reversal → vendor bill approval → payment batch.
6. Reconcile the same records in `/app/control`, `/app/alerts`, `/app/data`, `/app/governance/policies`, and `/app/integrations`.
7. Invite Vendor, Driver, and Client users and verify their restricted `/portal/vendor`, `/portal/driver`, and `/portal/client` views.

Use unique codes and idempotency keys when repeating mutations. The UI creates these keys automatically; API clients must send `Idempotency-Key` where required.

The setup checklist derives completion from live tenant records and links directly to Organization, Users, Branches, Clients, Vendors, Commercial settings, Imports, and Branding. Its isolation-record panel provides both a sample CSV showing the export columns and a current-tenant-only CSV export.

### Explicit batch/release test flows

These commands are not automatic per-feature gates. Run the smallest scope explicitly requested, once:

```bash
# Non-browser batch test suite
make check

# Full desktop/mobile Playwright regression (release request only)
make e2e

# One feature or cross-feature journey
pnpm exec playwright test tests/e2e/all-feature-gaps.spec.ts \
  --project=chromium --grep "E2E-GAP-MST02-01"

# Foundation and access journeys
pnpm exec playwright test tests/e2e/fnd-01-tenant-foundation.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/fnd-02-identity-access.spec.ts --project=chromium
```

Playwright uses the deployed frontend/backend and PostgreSQL. It does not mock business APIs or write directly to business tables. Generated reports remain ignored under `playwright-report/` and `test-results/`.

Record failures in `BUGS.md`/`TODO.md`; do not automatically fix, retry, or rerun unless asked.

## AWS EC2 + RDS deployment and GitHub CI/CD

This is a low-cost single-instance starting topology: Nginx, Next.js, and NestJS on one EC2 instance; PostgreSQL on private Single-AZ RDS; GitHub Actions deploys through AWS Systems Manager. It intentionally adds no Redis, queue, object-storage, NAT Gateway, load balancer, or separate worker.

### 1. Understand the current Free Tier

AWS accounts created on or after July 15, 2025 use the credit-based Free Tier: new customers receive initial credits, and the Free account plan ends after six months or when credits are exhausted. It is not an unlimited free production environment. Check the live [AWS Free Tier guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html), [EC2 eligibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html), and [RDS eligibility](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html) before creating resources.

- Start with one Free-Tier-marked `t3.micro` Ubuntu 24.04 EC2 instance, 20 GiB `gp3`, and a 2 GiB swap file. A `t3.small` is more comfortable for builds but can consume credits faster.
- Use PostgreSQL on Single-AZ `db.t4g.micro` or `db.t3.micro` with 20 GiB `gp3`, no provisioned IOPS, and storage autoscaling disabled initially.
- RDS, snapshots beyond the included allowance, DNS registration, data transfer, and public IPv4 can consume credits or incur charges. Create AWS Budgets alerts before deploying.

### 2. Secure the account and budget

1. Enable MFA for the root user, create an administrative IAM identity, and stop using root for daily work.
2. In Billing → Budgets, create a small monthly cost budget plus actual and forecast email alerts. Also enable Free Tier usage alerts.
3. Choose one Region close to users and keep EC2, RDS, Systems Manager, and the deployment IAM role there.

### 3. Create networking and security groups

The default VPC is adequate for this first deployment. Create:

- `logistics-ec2-sg`: inbound TCP 80 and 443 from the internet; no inbound 22 is required because administration and deployment use Session Manager.
- `logistics-rds-sg`: inbound TCP 5432 only from `logistics-ec2-sg`; never from `0.0.0.0/0`.
- Keep RDS `Public access` set to `No`. EC2 and RDS must be in the same VPC; AWS can configure the EC2-to-RDS security-group relationship from the RDS console.

### 4. Create PostgreSQL RDS

1. RDS → Create database → Standard create → PostgreSQL.
2. Choose the Free-Tier-marked template/class, Single-AZ, 20 GiB `gp3`, database name `logistics`, and a generated master password.
3. Place it in the same VPC, attach `logistics-rds-sg`, disable public access, enable deletion protection, automated backups, and encryption at rest.
4. Record the private RDS endpoint. Application connections use TLS (`sslmode=require`; use `verify-full` with the RDS CA bundle for stricter certificate verification).

After EC2 exists, connect through Session Manager and create separate non-master runtime and postal-import roles. Use different generated passwords; the backend never receives the importer credential:

```sql
CREATE ROLE logistics_postal_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE logistics_app LOGIN PASSWORD 'GENERATE_A_LONG_UNIQUE_PASSWORD';
CREATE ROLE logistics_postal_importer LOGIN PASSWORD 'GENERATE_A_DIFFERENT_LONG_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE logistics TO logistics_app;
GRANT CONNECT ON DATABASE logistics TO logistics_postal_importer;
```

### 5. Create and bootstrap EC2

1. In IAM, create an EC2 role with `AmazonSSMManagedInstanceCore`; attach it to the instance.
2. Launch an Ubuntu Server 24.04 LTS `t3.micro` in the same VPC with `logistics-ec2-sg`, the IAM role, encrypted 20 GiB `gp3`, and tags `Application=logistics-management`, `Environment=production`.
3. Connect using EC2 → Connect → Session Manager. Ubuntu AWS AMIs normally include SSM Agent; verify it with `systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service` or `systemctl status amazon-ssm-agent`.
4. Install the runtime and add swap. EC2 uses RDS and therefore does not need Docker:

```bash
sudo apt-get update
sudo apt-get install -y git nginx postgresql-client curl build-essential jq
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo useradd --system --create-home --shell /bin/bash logistics
sudo mkdir -p /opt/logistics-management
sudo chown logistics:logistics /opt/logistics-management
```

Clone the repository into `/opt/logistics-management`. For a private repository, add a read-only GitHub deploy key to the EC2 `logistics` user; do not place a personal access token in Git configuration.

```bash
sudo -u logistics git clone git@github.com:GITHUB_OWNER/GITHUB_REPOSITORY.git /opt/logistics-management
sudo -u logistics bash -lc 'cd /opt/logistics-management && make bootstrap-production'
```

`make bootstrap-production` installs the locked workspace dependencies and performs repository policy checks without requiring the local Docker/PostgreSQL stack. The recurring GitHub deployment also installs the exact lockfile before migration and build.

### 6. Configure application secrets and services

```bash
cd /opt/logistics-management
sudo cp deploy/aws/app.env.example /etc/logistics-management.env
sudo chown root:logistics /etc/logistics-management.env
sudo chmod 640 /etc/logistics-management.env

# Generate values before editing the file:
openssl rand -hex 32
openssl rand -base64 32
sudoedit /etc/logistics-management.env

sudo cp deploy/aws/logistics-backend.service /etc/systemd/system/
sudo cp deploy/aws/logistics-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable logistics-backend.service logistics-frontend.service
```

Set `FRONTEND_URL` to the final HTTPS origin, keep `BACKEND_URL=http://127.0.0.1:4000`, set `APP_ENV=production`, keep `ENABLE_TEST_HOOKS=false`, URL-encode both database passwords, and use the private RDS endpoint in `DATABASE_URL` and `POSTAL_IMPORT_DATABASE_URL`. The two URLs must use `logistics_app` and `logistics_postal_importer` respectively.

Download the current authorized **All India Pincode Directory** CSV from the Department of Posts/Open Government Data catalog on an administrator workstation, review its license/source metadata, compute SHA-256, and copy the exact file to the protected path configured by `POSTAL_DIRECTORY_FILE` (the example uses `/opt/logistics-secrets/india-post-pincode-directory.csv`). Do not commit it and do not let the application download it at runtime.

```bash
sha256sum india-post-pincode-directory.csv
sudo install -o logistics -g logistics -m 0400 \
  india-post-pincode-directory.csv \
  /opt/logistics-secrets/india-post-pincode-directory.csv
```

Set the resulting digest and source release metadata in `/etc/logistics-management.env`: `POSTAL_DIRECTORY_SHA256`, `POSTAL_DIRECTORY_VERSION`, `POSTAL_DIRECTORY_SOURCE_NAME`, `POSTAL_DIRECTORY_SOURCE_URI`, and `POSTAL_DIRECTORY_IMPORTED_BY`. The importer validates the checksum, expected `logistics` database, separate PostgreSQL identity, minimum production row count, and source metadata before atomically activating a version. The official catalog is <https://www.data.gov.in/catalog/all-india-pincode-directory-through-webservice>.

Allow only the deployment account to restart these two services:

```bash
sudo visudo -f /etc/sudoers.d/logistics-deploy
```

Add this single line:

```text
logistics ALL=(root) NOPASSWD: /usr/bin/systemctl restart logistics-backend.service logistics-frontend.service, /usr/bin/systemctl is-active --quiet logistics-backend.service, /usr/bin/systemctl is-active --quiet logistics-frontend.service
```

Before the first seed, replace `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` in `/etc/logistics-management.env`. Use a real operations mailbox and a unique password of at least 12 characters; production startup rejects the committed local password. Then apply migrations as the application role. Using a temporary RDS-master connection that is never written to the application environment, perform the one-time idempotent ownership handoff; this moves the reference tables and guard into `postal_reference`, owned by the NOLOGIN role, so the runtime cannot disable the immutability controls.

```bash
sudo -u logistics bash -lc 'cd /opt/logistics-management && set -a && source /etc/logistics-management.env && set +a && pnpm run db:migrate'

# Run interactively from the Session Manager shell. Do not save the master URL.
read -rsp 'RDS master PostgreSQL URL: ' RDS_MASTER_URL; echo
psql "$RDS_MASTER_URL" -v ON_ERROR_STOP=1 \
  -f /opt/logistics-management/scripts/sql/postal-ownership-handoff.sql
unset RDS_MASTER_URL

sudo -u logistics bash -lc 'cd /opt/logistics-management && set -a && source /etc/logistics-management.env && set +a && pnpm --filter @logistics/db postal:verify-ownership && pnpm --filter @logistics/db postal:import -- --file "$POSTAL_DIRECTORY_FILE" --version "$POSTAL_DIRECTORY_VERSION" --sha256 "$POSTAL_DIRECTORY_SHA256" --source-name "$POSTAL_DIRECTORY_SOURCE_NAME" --source-uri "$POSTAL_DIRECTORY_SOURCE_URI" --imported-by "$POSTAL_DIRECTORY_IMPORTED_BY" --activate true && pnpm run build && pnpm run db:seed'
sudo systemctl start logistics-backend.service logistics-frontend.service
```

The handoff is required once for a blank RDS database and is safe to repeat. Recurring GitHub deployments verify ownership and stop before import/restart if it is missing; they do not require or store the RDS master password.

After Nginx and TLS are configured, sign in at `https://YOUR_DOMAIN/login` using the exact production `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` that were present for this seed. There is no universal production password and the local `admin@local.test` account is not created unless you explicitly configure it—which you must not do.

The seed upserts the Platform Admin by email and rewrites its password hash. To rotate that bootstrap password, update `PLATFORM_ADMIN_PASSWORD` in the protected environment file and run `pnpm run db:seed` once from a Session Manager shell. Do not run the seed on every deployment. Tenant users continue to authenticate with their invitation-created credentials and MFA policy, independently of this Platform Admin.

### 7. Configure Nginx, DNS, and TLS

1. Point the desired DNS `A` record at the EC2 public address. A static Elastic IP prevents address changes but may consume credits/incur charges.
2. Replace `example.com` in `deploy/aws/nginx.conf`, copy it to `/etc/nginx/sites-available/logistics-management`, enable it, test with `nginx -t`, and reload Nginx.
3. Install Certbot's Nginx integration and issue a certificate for the domain. Keep ports 3000 and 4000 bound to loopback; expose only Nginx 80/443.

```bash
sudo cp deploy/aws/nginx.conf /etc/nginx/sites-available/logistics-management
sudo ln -s /etc/nginx/sites-available/logistics-management /etc/nginx/sites-enabled/logistics-management
sudo nginx -t
sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d logistics.example.com
```

### 8. Configure GitHub OIDC and deployment permissions

The committed `Quality` workflow runs `make check`. After a successful `main` run, `.github/workflows/deploy-aws.yml` deploys that exact verified commit through SSM. The deployment validates the protected pinned CSV configuration, applies migrations, performs the idempotent postal activation, builds, restarts, and checks readiness. It uses GitHub OIDC, so no long-lived AWS access key is stored in GitHub.

1. IAM → Identity providers → Add provider: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Replace placeholders in `deploy/aws/github-oidc-trust-policy.json`. Create an IAM role (for example `LogisticsGitHubDeploy`) with that trust policy.
3. Replace placeholders in `deploy/aws/github-ssm-policy.json` and attach it to the role. It limits deployment to `AWS-RunShellScript` and the one EC2 instance.
4. GitHub → Settings → Environments → create `production`, allow only `main`, and optionally require approval.
5. Add these GitHub environment variables (not secrets): `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, and `AWS_EC2_INSTANCE_ID`.
6. Push to `main`. After `Quality` succeeds, `Deploy AWS` starts automatically for that verified SHA. Inspect its SSM output and then verify `/api/v1/health/ready` and `/login`.

### 9. Production operations checklist

- Keep RDS private, require TLS, rotate the bootstrap admin password, `AUTH_SECRET`, MFA key, database password, API credentials, and GitHub deploy key under an approved rotation procedure.
- Review automated RDS backups and perform a restore drill. Deletion protection is not a backup.
- Configure CloudWatch alarms for EC2 CPU/status, RDS CPU/connections/storage, disk usage, service restarts, and application readiness.
- Patch Ubuntu, Node.js, PostgreSQL minor versions, SSM Agent, and dependencies regularly.
- For rollback, redeploy a known-good Git SHA only after checking migration compatibility. Forward-only database migrations are not automatically reversed.
- Before meaningful traffic, move builds off the smallest EC2 size or build an artifact in CI; the swap-backed `t3.micro` path prioritizes cost over deployment speed.

AWS references: [RDS PostgreSQL setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_GettingStarted.CreatingConnecting.PostgreSQL.html), [EC2/RDS private connectivity](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/ec2-rds-connect.html), [Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-systems-manager-session-manager.html), [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), and [Run Command permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command-setting-up.html).

## Run a feature

Open the repository as a trusted Codex project and invoke:

```text
$feature-sdlc Implement FND-02.
```

The skill implements dependency-compatible features/TODOs in rapid batches using implementation workers with non-overlapping ownership and one integrated reviewer. It keeps acceptance notes lightweight, authors tests as `Implemented / Not Run`, synchronizes trackers once per batch, and supports one related local commit. Specialist spec/test/E2E agents and deployment/regression execution are used only for material risk or an explicit request.

## Commands

| Command                   | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `make bootstrap`          | Validate prerequisites, configure hooks, and install dependencies when present. |
| `make postgres-up`        | Create/start central PostgreSQL and provision this project's databases/schemas. |
| `make postgres-provision` | Add or repair only this project's role, databases, and schemas.                 |
| `make postgres-status`    | Verify the shared container and project database.                               |
| `make dev`                | Start frontend and backend in development mode.                                 |
| `make check`              | Lightweight batch gate: formatting, linting, and type checks only.              |
| `make test`               | Explicit test phase: run non-browser test suites.                               |
| `make deploy-local`       | Explicit deploy/test phase: migrate, build, and start local services.           |
| `make e2e`                | Explicit test phase: full Playwright regression against local services.         |
| `make verify`             | Explicit release phase: full repository and application verification.           |
| `make status`             | Show feature, test, TODO, and Git status.                                       |

## Documentation map

- [AGENTS.md](AGENTS.md) — binding instructions for Codex and subagents
- `.agents/skills/feature-sdlc/SKILL.md` — reusable feature execution workflow
- [FEATURES.md](FEATURES.md) — scope, implementation status, test status, acceptance criteria, and prompts
- [TODO.md](TODO.md) — active execution queue and unresolved work
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — boundaries and engineering invariants
- [docs/SDLC.md](docs/SDLC.md) — specification-to-commit lifecycle
- [docs/TESTING.md](docs/TESTING.md) — test strategy and status conventions
- [docs/API.md](docs/API.md) — current HTTP authentication, tenancy, and route contract
- [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) — shared PostgreSQL and local deployment
- [CONTRIBUTING.md](CONTRIBUTING.md) — commit and review conventions
- [specs/README.md](specs/README.md) — per-feature artifact layout
