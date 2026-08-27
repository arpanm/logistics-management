SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

.PHONY: help bootstrap bootstrap-production postgres-up postgres-provision postgres-status dev check test policy-check deploy-local refresh-local health e2e verify status

help:
	@echo "bootstrap           Validate tools, configure hooks, and install dependencies"
	@echo "bootstrap-production Install dependencies on an EC2/RDS host without requiring Docker"
	@echo "postgres-up         Create/start the central shared PostgreSQL and provision this project"
	@echo "postgres-provision  Add this project's role, databases, and schemas to shared PostgreSQL"
	@echo "postgres-status     Verify shared PostgreSQL and the project database"
	@echo "dev                 Start frontend and backend development processes"
	@echo "check               Run lightweight formatting, linting, and type checks"
	@echo "test                Run non-browser tests when explicitly requested"
	@echo "deploy-local        Build and start frontend/backend against shared PostgreSQL"
	@echo "refresh-local       Migrate, rebuild all packages/apps, restart, and verify without reseeding"
	@echo "health              Verify PostgreSQL, backend, and frontend readiness"
	@echo "e2e                 Run Playwright end-to-end tests"
	@echo "verify              Run all final non-destructive quality gates"
	@echo "status              Show feature, test, TODO, and Git status"

bootstrap:
	@bash scripts/bootstrap.sh

bootstrap-production:
	@bash scripts/bootstrap.sh production

postgres-up:
	@bash scripts/postgres-up.sh

postgres-provision:
	@bash scripts/postgres-provision.sh

postgres-status:
	@bash scripts/postgres-status.sh

dev:
	@pnpm run dev

check:
	@pnpm run check

test:
	@bash scripts/run-workspace-tests.sh

policy-check:
	@pnpm run policy:check

deploy-local:
	@bash scripts/deploy-local.sh

refresh-local:
	@bash scripts/refresh-local.sh

health:
	@bash scripts/health.sh

e2e:
	@pnpm run test:e2e

verify:
	@pnpm run verify

status:
	@bash scripts/sdlc-status.sh
