SHELL := /bin/sh
.DEFAULT_GOAL := help
.NOTPARALLEL: deploy migrate-production deploy-workflow deploy-api deploy-web verify-production

# Your deployment's names. These defaults are placeholders: put your own in deploy.local.mk (git-ignored), e.g.
#   VERCEL_SCOPE = my-team
#   WEB_PROJECT = my-dashboard
# or pass them on the command line (make deploy VERCEL_SCOPE=my-team ...).
-include deploy.local.mk

VERCEL ?= vercel
VERCEL_SCOPE ?= your-vercel-team
WEB_PROJECT ?= agent-workspace
API_PROJECT ?= agent-workspace-api
WORKFLOW_PROJECT ?= agent-workspace-task-workflow

WEB_URL ?= https://agent-workspace.vercel.app
API_URL ?= https://agent-workspace-api.vercel.app
WORKFLOW_URL ?= https://agent-workspace-task-workflow.vercel.app

# The dashboard's Vercel link (projectId, orgId, projectName), restored after the API build re-links the checkout.
WEB_LINK ?= scripts/vercel-projects/web.local.json
RESTORE_WEB_LINK = if [ -f $(WEB_LINK) ]; then mkdir -p .vercel && cp $(WEB_LINK) .vercel/project.json; else echo "no $(WEB_LINK): copy scripts/vercel-projects/web.example.json there with your ids; Vercel link left as it is"; fi

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
	trap '$(RESTORE_WEB_LINK)' EXIT; \
	VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 $(VERCEL) build --prod --yes --project $(API_PROJECT) --scope $(VERCEL_SCOPE) --local-config vercel.eve.json; \
	$(VERCEL) deploy --prebuilt --prod --yes --project $(API_PROJECT) --scope $(VERCEL_SCOPE)

deploy-web: restore-web-link ## Deploy the Next.js dashboard.
	$(VERCEL) deploy . --prod --yes --project $(WEB_PROJECT) --scope $(VERCEL_SCOPE)

restore-web-link: ## Restore the repository's Vercel link to the dashboard (from $(WEB_LINK), when present).
	@$(RESTORE_WEB_LINK)

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
