SHELL := /bin/sh
.DEFAULT_GOAL := help
.NOTPARALLEL: deploy migrate-production deploy-workflow deploy-api deploy-web verify-production

VERCEL ?= vercel
VERCEL_SCOPE ?= f20170061g-3183s-projects
WEB_PROJECT ?= fde-agent
API_PROJECT ?= fde-agent-api
WORKFLOW_PROJECT ?= fde-task-workflow

WEB_URL ?= https://fde-agent.vercel.app
API_URL ?= https://fde-agent-api.vercel.app
WORKFLOW_URL ?= https://fde-task-workflow.vercel.app

.PHONY: help deploy migrate-production deploy-workflow deploy-api deploy-web verify-production restore-web-link stress-task-workflow test-qm-hardening

help: ## Show the deployment targets.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "%-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deploy: migrate-production deploy-workflow deploy-api deploy-web verify-production ## Migrate, deploy every production service, and verify it.

migrate-production: ## Atomically apply pending Drizzle migrations and seed task workflow versions.
	npm run db:migrate:production
	npm run db:migrate:task-workflows

deploy-workflow: ## Deploy the durable task-workflow microservice.
	$(VERCEL) deploy services/task-workflow --prod --yes --project $(WORKFLOW_PROJECT) --scope $(VERCEL_SCOPE)

deploy-api: ## Build and deploy the standalone Eve API without framework auto-detection.
	@set -eu; \
	trap 'mkdir -p .vercel && cp scripts/vercel-projects/fde-agent.json .vercel/project.json' EXIT; \
	VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 $(VERCEL) build --prod --yes --project $(API_PROJECT) --scope $(VERCEL_SCOPE) --local-config vercel.eve.json; \
	$(VERCEL) deploy --prebuilt --prod --yes --project $(API_PROJECT) --scope $(VERCEL_SCOPE)

deploy-web: restore-web-link ## Deploy the Next.js dashboard.
	$(VERCEL) deploy . --prod --yes --project $(WEB_PROJECT) --scope $(VERCEL_SCOPE)

restore-web-link: ## Restore the repository's default Vercel link to the dashboard.
	@mkdir -p .vercel
	@cp scripts/vercel-projects/fde-agent.json .vercel/project.json

verify-production: ## Check the dashboard, Eve API, and workflow-service health endpoints.
	curl --fail --silent --show-error $(WORKFLOW_URL)/api/health
	@printf '\n'
	curl --fail --silent --show-error $(API_URL)/eve/v1/health
	@printf '\n'
	curl --fail --silent --show-error $(WEB_URL)/api/ops/health
	@printf '\n'

stress-task-workflow: ## Run the guarded Playwright task-workflow stress test (configure with TASK_WORKFLOW_STRESS_*).
	npm run test:task-workflow:stress

test-qm-hardening: ## Verify prompt/context, browser isolation, and workflow-run ownership contracts.
	npm run test:qm-hardening
