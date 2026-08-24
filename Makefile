SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

.PHONY: help bootstrap infra-up infra-down infra-reset dev check policy-check deploy-local health e2e verify status

help:
	@echo "bootstrap      Validate tools, configure hooks, and install dependencies"
	@echo "infra-up       Start local PostgreSQL, Redis, MinIO, and Mailpit"
	@echo "infra-down     Stop local infrastructure and keep volumes"
	@echo "infra-reset    Delete local infrastructure volumes with explicit confirmation"
	@echo "dev            Start application development processes"
	@echo "check          Run application static checks and non-browser tests"
	@echo "deploy-local   Build and start a production-style local application"
	@echo "health         Verify local infrastructure and application readiness"
	@echo "e2e            Run Playwright end-to-end tests"
	@echo "verify         Run all final non-destructive quality gates"
	@echo "status         Show feature and Git status"

bootstrap:
	@bash scripts/bootstrap.sh

infra-up:
	@bash scripts/infra-up.sh

infra-down:
	@docker compose down --remove-orphans

infra-reset:
	@bash scripts/infra-reset.sh

dev:
	@pnpm run dev

check:
	@pnpm run check

policy-check:
	@pnpm run policy:check

deploy-local:
	@bash scripts/deploy-local.sh

health:
	@bash scripts/health.sh

e2e:
	@pnpm run test:e2e

verify:
	@pnpm run verify

status:
	@bash scripts/sdlc-status.sh

