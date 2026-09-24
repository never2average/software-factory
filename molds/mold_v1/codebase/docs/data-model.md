# FDE Data Room — sheet-packaging view (derived from `dm.md`)

> **`dm.md` at the repository root is the CANONICAL data model.** It defines
> the seven top-level domains, their folder trees, and every artifact path.
> This document is the **derived view**: it specifies how the nine flat
> tabular sheets are packaged into the seven domain workbooks, the column
> contract for each sheet, and the owner/producer for every `dm.md` path.
> Where this document and `dm.md` disagree, `dm.md` wins.

The seven canonical domains (top-level folders in `dm.md`) are:

1. `Customers`
2. `Platform`
3. `Deployments`
4. `Solutions`
5. `Implementation`
6. `Tickets`
7. `People`

Every customer-scoped sheet keys on `customer_id`, the slug from
`data/customers.json` (`id`, for example `acme-bank`).

Important boundary: customer accounts, internal OnFinance staff, and customer
stakeholders are three different schemas. Customer accounts live in
`data/customers.json` and the `Customers` sheet. Solution engineers and account
executives live in `data/people.json.internalStaffAssignments` and the
`Internal Staff` sheet. Customer users, champions, and decision makers live in
`data/people.json.customerStakeholders` and the `Customer Stakeholders` sheet.

## Workbook naming: `<Domain>/Master.xlsx`

Each of the seven domains carries exactly one workbook at its domain root,
always named **`Master.xlsx`** — i.e. `Customers/Master.xlsx`,
`Platform/Master.xlsx`, `Deployments/Master.xlsx`, `Solutions/Master.xlsx`,
`Implementation/Master.xlsx`, `Tickets/Master.xlsx`, `People/Master.xlsx`.

`dm.md` shows `Master.xlsx` explicitly under `Customers`, `Platform`, and
`People`. This packaging spec extends the same convention to the remaining
four domains (`Deployments`, `Solutions`, `Implementation`, `Tickets`): every
domain root gets a `Master.xlsx` holding that domain's sheets. The domain
folder name disambiguates; the file name is always `Master.xlsx`.

**Known deviations in current code (migration deferred — do not copy these
into new work; this section exists so the spec and the code do not silently
contradict each other):**

- `app/_components/dataroom.tsx` currently names each workbook
  `${label}.xlsx` after the tab label (e.g. `People.xlsx`, `Customers.xlsx`).
  Canonical target: `<Domain>/Master.xlsx`, with the people sheets in
  `People/Master.xlsx`.
- `agent/subagents/research/prompt.md` currently builds six
  `<customer>-<Section>.xlsx` files and packs Internal Staff / Customer
  Stakeholders into the Customers workbook. Canonical target: seven
  `Master.xlsx` workbooks with people sheets in `People/Master.xlsx`.

Neither deviation changes any sheet's columns or grain — both are packaging
drift only, scheduled to converge on this spec in a later iteration.

## Source JSON types

### `data/customers.json`

- `customers[]`: one row per customer account.
- `customers[].platform`: one row per customer platform configuration.
- `customers[].deployments[]`: one row per deployable customer runtime instance.
- `customers[].solutions[]`: one row per customer solution/workflow.
- `customers[].implementation`: one row per customer rollout plan.
- `customers[].tickets[]`: one row per actionable ticket, follow-up, or incident.
- `customers[].interactions[]`: one row per customer touchpoint/event.

### `data/people.json`

- `internalStaffAssignments[]`: one row per OnFinance staff assignment to a customer.
- `customerStakeholders[]`: one row per external stakeholder at the customer organization.

Do not include `customer_name` or fuzzy `customer` text in `data/people.json`.
Join through `customer_id`.

## The nine sheets and how they map into the seven domain workbooks

The nine canonical flat sheets, in fixed order:

1. `Customers`
2. `Platform`
3. `Deployments`
4. `Solutions`
5. `Implementation`
6. `Tickets`
7. `Interactions`
8. `Internal Staff`
9. `Customer Stakeholders`

Sheet → domain-workbook mapping (nine source sheets plus one derived sheet,
packaged into seven `Master.xlsx` workbooks):

| Domain workbook              | Sheets carried (in order)                                | `Master.xlsx` explicit in `dm.md`? |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `Customers/Master.xlsx`      | Customers                                                 | Yes                                |
| `Platform/Master.xlsx`       | Platform                                                  | Yes                                |
| `Deployments/Master.xlsx`    | Deployments                                               | Extended by this spec              |
| `Solutions/Master.xlsx`      | Solutions                                                 | Extended by this spec              |
| `Implementation/Master.xlsx` | Implementation                                            | Extended by this spec              |
| `Tickets/Master.xlsx`        | Tickets, Interactions, Interaction Digest (derived)       | Extended by this spec              |
| `People/Master.xlsx`         | Internal Staff, Customer Stakeholders                     | Yes                                |

Notes:

- The two people sheets (`Internal Staff`, `Customer Stakeholders`) live in
  `People/Master.xlsx`, matching the `People` domain in `dm.md`.
- `Interactions` is packaged with Tickets because interactions and tickets
  cross-reference each other heavily (`related_ticket_ids` both ways); its
  source of record is `Customers/{CustomerID}/interactions.jsonl`.
- **`Interaction Digest` is a derived sheet and stays in `Tickets/Master.xlsx`.**
  It is a per-customer rollup computed at packaging time (columns:
  `customer_id`, `customer_name`, `interactions`, `date_range`, `last_touch`,
  `open_next_actions`, `sentiment`, `digest`). It is never a source of record
  and never edited by hand; regenerate it from the `Interactions` rows.

Rules:

- A sheet's canonical columns and grain (below) do not change based on which
  workbook carries it. `Interactions` in `Tickets/Master.xlsx` is the same
  schema as the standalone `Interactions` sheet.
- Cross-sheet references (see "Cross-sheet rules") still resolve by
  `customer_id` / email / ID across workbooks — the split is packaging only.
- Supporting artifacts are domain-scoped per the `dm.md` tree and, where
  per-account, foldered by `{customer_id}`. They supplement the workbook;
  they never replace the sheet data.

## Ticket categories ↔ `dm.md` ticket folders

Two taxonomies exist and both are canonical at different layers:

- **`ticket_category`** — the five-value triage enum stored on every ticket
  row. Defined in code: `agent/lib/customer-schema.ts`
  (`ticketCategorySchema` + `TICKET_CATEGORY_ROUTING`). This is the column of
  record; it routes the ticket to a triage specialist.
- **`dm.md` ticket folders** — the nine storage partitions under `Tickets/`
  (`feat/`, `search/`, `bug/`, `docs/`, `evals/`, `config_changes/`,
  `data_migration/`, `backfills/`, `onboarding/`), each holding
  `{customer_id}/{platform_id}/tickets_{id}.jsonl`.

The folder is **derived** from the category (plus the ticket's subdomain —
`ticket_type`/`tags`); the category is never inferred from the folder.

Folder → category (every folder mapped; authoritative for classification):

| `dm.md` folder     | Canonical `ticket_category`                                       | Triage route (`TICKET_CATEGORY_ROUTING`) | Typically executed by       | Notes                                                        |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| `feat/`            | `Feature Request`                                                 | `follow-ups`                             | `follow-ups` subagent       | Default folder for feature requests                          |
| `search/`          | `Feature Request`                                                 | `follow-ups`                             | `follow-ups` subagent       | Search/retrieval-domain feature requests                     |
| `docs/`            | `Feature Request`                                                 | `follow-ups`                             | `follow-ups` subagent       | Documentation requests and gaps                              |
| `bug/`             | `Bug Report`                                                      | `deployment`                             | `deployment` subagent       | Defects, incidents, regressions (incl. eval regressions caused by product defects) |
| `evals/`           | `Workflow Customization Request`                                  | `configuration`                          | `evals` subagent            | Eval dataset/suite/threshold work on a customer workflow     |
| `config_changes/`  | `Configuration Change Request` (default) or `Workflow Customization Request` | `configuration`                | `configuration` subagent    | Non-eval workflow customization also files here              |
| `onboarding/`      | `Configuration Change Request`                                    | `configuration`                          | `configuration` subagent    | Initial tenant/user/connector provisioning                   |
| `data_migration/`  | `Data Migration Request`                                          | `data-migration`                         | `data-migration` subagent   | One-time migrations                                          |
| `backfills/`       | `Data Migration Request`                                          | `data-migration`                         | `data-migration` subagent   | Historical backfill jobs                                     |

Category → folder(s) (every category has a default folder):

| `ticket_category`                | Default folder     | Additional folders (by subdomain)      |
| -------------------------------- | ------------------ | -------------------------------------- |
| `Feature Request`                | `feat/`            | `search/` (search), `docs/` (docs)     |
| `Bug Report`                     | `bug/`             | —                                      |
| `Data Migration Request`         | `data_migration/`  | `backfills/` (historical backfills)    |
| `Configuration Change Request`   | `config_changes/`  | `onboarding/` (initial provisioning)   |
| `Workflow Customization Request` | `config_changes/`  | `evals/` (eval-suite work)             |

Routing vs execution: `TICKET_CATEGORY_ROUTING` names the **triage owner**
(the specialist a new ticket is handed to). The folder additionally signals
which specialist typically **executes** the work — e.g. `evals/` tickets are
triaged under `configuration` but executed with the `evals` subagent. These
are complementary, not contradictory: the enum is the canonical column, the
folder is a storage/working partition.

## `dm.md` path inventory: artifact types and producers

Every path in `dm.md`, with its owning artifact type and the agent/tool that
produces it. Agents are the orchestrator (`agent/agent.ts`) and the seven
subagents in `agent/subagents/` (`research`, `customer-context`,
`follow-ups`, `deployment`, `configuration`, `data-migration`, `evals`).
Tools are in `agent/tools/`; connections in `agent/connections/`. Connector
wiring marked *(deferred)* is specified but not yet linked.

### `Customers/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Customers/Master.xlsx` | Excel workbook (Customers sheet) | `research` subagent — openpyxl in sandbox, delivered via `publish_artifact` |
| `Customers/{CustomerID}/interactions.jsonl` | JSONL interaction log (source of `Interactions` sheet) | `record_interaction` tool (orchestrator + any subagent) |
| `Customers/{CustomerID}/context.md` | Markdown account context brief | `customer-context` subagent |
| `Customers/{CustomerID}/agreements/` | Contract binaries (PDF/DOCX) | Human upload (data room Uploads) |
| `Customers/syncs/manual_entry/` | Raw manual sync drops | Human upload (data room Uploads) |
| `Customers/syncs/email/` | Email export payloads | `email_list_inbox` tool (Gmail connection) |
| `Customers/syncs/slack/` | Slack export payloads | Slack connection/channel (`agent/connections/slack.ts`, `agent/channels/slack.ts`) |
| `Customers/syncs/meeting_notes/granola/` | Meeting-note payloads | `granola_search_notes` tool (`agent/lib/granola.ts`) |

### `Platform/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Platform/Master.xlsx` | Excel workbook (Platform sheet) | `research` subagent — openpyxl + `publish_artifact` |
| `Platform/{platform_version_id}/{YYYY-MM-DD}_changelog_manager.md` | Markdown release changelog | `deployment` subagent (from GitHub sync) |
| `Platform/{platform_version_id}/architecture/helm/` | Helm chart variants (YAML) | `deployment` subagent via GitHub connection |
| `Platform/{platform_version_id}/architecture/diagrams/` | Architecture diagrams | Miro sync *(deferred)*; human upload meanwhile |
| `Platform/{platform_version_id}/architecture/infrastructure/` | Terraform variants | `deployment` subagent via GitHub/AWS syncs |
| `Platform/{platform_version_id}/design_decisions/tenancy.schemas.json` | JSON Schema (tenancy contract) | `configuration` subagent |
| `Platform/{platform_version_id}/design_decisions/organization.schemas.json` | JSON Schema (org contract) | `configuration` subagent |
| `Platform/{platform_version_id}/design_decisions/dataplatform.schemas.json` | JSON Schema (data-platform contract) | `configuration` subagent |
| `Platform/{platform_version_id}/design_decisions/agents.schemas.json` | JSON Schema (agents contract) | `configuration` subagent |
| `Platform/{platform_version_id}/design_decisions/pipeline_config.schemas.json` | JSON Schema (pipeline config contract) | `configuration` subagent |
| `Platform/{platform_version_id}/design_decisions/integromat.schemas.json` | JSON Schema (integration contract) | `configuration` subagent |
| `Platform/{platform_version_id}/tests/` | Test suites/results | `evals` subagent (from GitHub sync) |
| `Platform/{platform_version_id}/security/` | SBOMs + security certifications | GitHub/AWS syncs; human upload for certifications |
| `Platform/{platform_version_id}/integromat/` | Integration-platform exports | `configuration` subagent |
| `Platform/syncs/manual_entry/` | Raw manual sync drops | Human upload |
| `Platform/syncs/github/` | GitHub sync payloads | GitHub connection (`agent/connections/github.ts`, read-only PAT) |
| `Platform/syncs/aws/` | AWS sync payloads | AWS sync *(deferred)* |
| `Platform/syncs/slack/` | Slack sync payloads | Slack connection |
| `Platform/syncs/miro/` | Miro board exports | Miro sync *(deferred)* |

### `Deployments/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Deployments/Master.xlsx` *(extended by this spec)* | Excel workbook (Deployments sheet) | `research` subagent — openpyxl + `publish_artifact` |
| `Deployments/{customer_id}/{platform_version_id}/infrastructure/network/` | Terraform/IaC | `deployment` subagent |
| `.../infrastructure/compute/` | Terraform/IaC | `deployment` subagent |
| `.../infrastructure/storage/` | Terraform/IaC | `deployment` subagent |
| `.../infrastructure/inference/customizations.tf` | Terraform (inference customizations) | `deployment` subagent |
| `.../infrastructure/inference/rationale.md` | Markdown decision rationale | `deployment` subagent |
| `.../infrastructure/inference/signoff/internal.md` | Signoff record (Markdown) | `deployment` subagent + internal approver |
| `.../infrastructure/inference/signoff/customer.infra.md` | Signoff record (Markdown) | Customer infra approver, solicited via `email_create_draft` |
| `.../infrastructure/inference/signoff/customer.infosec.md` | Signoff record (Markdown) | Customer infosec approver, solicited via `email_create_draft` |
| `.../infrastructure/inference/signoff/customer.cloudvendor.md` | Signoff record (Markdown) | Customer cloud-vendor approver, solicited via `email_create_draft` |
| `.../infrastructure/agents/` | Terraform/IaC (agent runtime) | `deployment` subagent |
| `.../infrastructure/database/` | Terraform/IaC (database) | `deployment` subagent (with `data-migration` subagent for migration jobs) |
| `.../infrastructure/observability/` | Terraform/IaC (observability) | `deployment` subagent |
| `.../infrastructure/autoscale/` | Terraform/IaC (autoscaling) | `deployment` subagent |
| `.../platform/organization.json` | JSON config (org) | `configuration` subagent |
| `.../platform/dataplatform.json` | JSON config (data platform) | `configuration` subagent |
| `.../platform/agents/{agent_id}/` | Recipe folder (seed workspace for the agent) | `configuration` subagent |
| `.../platform/pipelines/{pipeline_id}/pipeline_config.json` | JSON config (pipeline) | `configuration` subagent |
| `.../platform/pipelines/{pipeline_id}/private.integromat.json` | JSON config (private integration credentials) | `configuration` subagent — never published via `publish_artifact` |
| `.../platform/integromat.json` | JSON config (integrations) | `configuration` subagent |
| `Deployments/syncs/manual_input/` | Raw manual sync drops | Human upload |
| `Deployments/syncs/claude/` | Coding-agent session logs | `deployment` subagent runs (Claude Code) |
| `Deployments/syncs/codex/` | Coding-agent session logs | `deployment` subagent runs (Codex) |
| `Deployments/syncs/email/` | Email export payloads | `email_list_inbox` tool |
| `Deployments/syncs/github/` | GitHub sync payloads | GitHub connection |
| `Deployments/syncs/aws/` | AWS sync payloads | AWS sync *(deferred)* |
| `Deployments/syncs/azure/` | Azure sync payloads | Azure sync *(deferred)* |
| `Deployments/syncs/gcp/` | GCP sync payloads | GCP sync *(deferred)* |
| `Deployments/syncs/oci/` | OCI sync payloads | OCI sync *(deferred)* |
| `Deployments/syncs/bare_metal/oc/` | OpenShift cluster sync payloads | Bare-metal sync *(deferred)* |
| `Deployments/syncs/bare_metal/nkp/` | Nutanix NKP sync payloads | Bare-metal sync *(deferred)* |
| `Deployments/syncs/bare_metal/custom_k8s/` | Custom k8s sync payloads | Bare-metal sync *(deferred)* |

### `Solutions/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Solutions/Master.xlsx` *(extended by this spec)* | Excel workbook (Solutions sheet) | `research` subagent — openpyxl + `publish_artifact` |
| `Solutions/{platform_version_id}/agents/{agent_id}/dataplatform.schemas.json` | JSON Schema (agent data contract) | `configuration` subagent |
| `.../agents/{agent_id}/run_configs.schema.json` | JSON Schema (run-config contract) | `configuration` subagent |
| `.../agents/{agent_id}/recipe.md` | Markdown recipe spec | `configuration` subagent |
| `.../agents/{agent_id}/recipe/` | Recipe folder (seed files) | `configuration` subagent |
| `.../agents/{agent_id}/evals/dataset.jsonl` | JSONL eval dataset | `evals` subagent |
| `.../agents/{agent_id}/evals/benchmark.jsonl` | JSONL benchmark set | `evals` subagent |
| `.../agents/{agent_id}/evals/{run_id}/run_configs.json` | JSON eval-run config | `evals` subagent |
| `.../agents/{agent_id}/evals/{run_id}/output.jsonl` | JSONL eval outputs | `evals` subagent |
| `.../agents/{agent_id}/evals/{run_id}/trace.jsonl` | JSONL eval traces | `evals` subagent |
| `Solutions/{platform_version_id}/pipelines/{pipeline_id}/pipeline_config.json` | JSON config (pipeline) | `configuration` subagent |
| `.../pipelines/{pipeline_id}/run_configs.schema.json` | JSON Schema (run-config contract) | `configuration` subagent |
| `.../pipelines/{pipeline_id}/integromat.schema.json` | JSON Schema (integration contract) | `configuration` subagent |
| `.../pipelines/{pipeline_id}/evals/{run_id}/run_configs.json` | JSON eval-run config | `evals` subagent |
| `.../pipelines/{pipeline_id}/evals/{run_id}/output.jsonl` | JSONL eval outputs | `evals` subagent |
| `.../pipelines/{pipeline_id}/evals/{run_id}/trace.jsonl` | JSONL eval traces | `evals` subagent |
| `.../pipelines/{pipeline_id}/background_research/{person_id}/context.md` | Markdown person research brief | `research` subagent (`web_search`/Exa + `granola_search_notes`) |
| `.../pipelines/{pipeline_id}/background_research/{person_id}/interaction.jsonl` | JSONL interaction log | `record_interaction` tool |

### `Implementation/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Implementation/Master.xlsx` *(extended by this spec)* | Excel workbook (Implementation sheet) | `research` subagent — openpyxl + `publish_artifact` |
| `Implementation/{customer_id}/agents/{agent_id}/` | Recipe folder (seed workspace for the agent) | `configuration` subagent |
| `Implementation/{customer_id}/pipelines/{pipeline_id}/pipeline_config.json` | JSON config (pipeline) | `configuration` subagent |
| `Implementation/{customer_id}/pipelines/{pipeline_id}/private.integromat.json` | JSON config (private integration credentials) | `configuration` subagent — never published |
| `Implementation/{customer_id}/integromat.json` | JSON config (integrations) | `configuration` subagent |
| `Implementation/{customer_id}/evals/agents/` | Eval artifacts (agent acceptance) | `evals` subagent |
| `Implementation/{customer_id}/evals/pipelines/` | Eval artifacts (pipeline acceptance) | `evals` subagent |

### `Tickets/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `Tickets/Master.xlsx` *(extended by this spec)* | Excel workbook (Tickets, Interactions, Interaction Digest sheets) | `research` subagent — openpyxl + `publish_artifact` |
| `Tickets/{folder}/{customer_id}/{platform_id}/tickets_{id}.jsonl` for each of `feat/`, `search/`, `bug/`, `docs/`, `evals/`, `config_changes/`, `data_migration/`, `backfills/`, `onboarding/` | JSONL ticket records (rows conform to `ticketSchema`) | Orchestrator triage via `upsert_customer`; worked by the specialist per the folder table above |
| `Tickets/syncs/manual_entry/` | Raw manual sync drops | Human upload |
| `Tickets/syncs/call/` | Call recordings/transcripts | Human upload or `granola_search_notes` |
| `Tickets/syncs/email/` | Email export payloads | `email_list_inbox` tool |
| `Tickets/syncs/slack/` | Slack sync payloads | Slack connection |

### `People/`

| Path | Artifact type | Producer (agent/tool) |
| --- | --- | --- |
| `People/Master.xlsx` | Excel workbook (Internal Staff + Customer Stakeholders sheets) | `research` subagent — openpyxl + `publish_artifact` |
| `People/{person_id}/interactions.jsonl` | JSONL interaction log (external people only) | `record_interaction` tool |
| `People/{person_id}/context.md` | Markdown person research brief | `research` subagent (`web_search`/Exa + Granola) |
| `People/{person_id}/identity.json` | JSON identity record (emails, IDs, org) | `customer-context` subagent |
| `People/{person_id}/{platform_version_id}/` | Per-platform-version person artifacts (access/enablement records) | `configuration` subagent |
| `People/{person_id}/agreements/` | Agreement binaries (NDAs etc.) | Human upload |
| `People/syncs/manual_entry/` | Raw manual sync drops | Human upload |
| `People/syncs/email/` | Email export payloads | `email_list_inbox` tool |
| `People/syncs/slack/` | Slack sync payloads | Slack connection |
| `People/syncs/analytics/` | Product-analytics exports | Analytics sync *(deferred)* |
| `People/syncs/observability/` | Observability exports | Observability sync *(deferred)* |
| `People/syncs/meeting_notes/granola/` | Meeting-note payloads | `granola_search_notes` tool |

## Sheet schemas (column contracts)

### Customers

Grain: one row per customer account. This is the account spine and must not
include person/staff attributes like title, employer organization, staff role,
or stakeholder role.

Core columns:
`customer_id`, `customer_name`, `tier`, `lifecycle_stage`, `status`,
`health_score`, `fde_owner`, `ae_owner`, `arr`, `arr_currency`, `seats`,
`external_account_id`, `legal_entity_name`, `account_region`,
`contract_status`, `renewal_forecast`, `renewal_risk_reason`,
`expansion_potential_arr`, `health_reason`, `company_domain`, `vertical`,
`regulatory_profile`, `business_owner_email`, `technical_owner_email`,
`executive_sponsor_email`, `value_realization_stage`, `target_annual_value`,
`realized_annual_value`, `success_criteria`, `value_period_start`,
`value_period_end`, `value_evidence_status`, `value_evidence_url`,
`last_business_review_date`, `next_business_review_date`, `contract_start`,
`renewal_date`, `industry_segment`.

### Platform

Grain: one row per customer platform configuration. This sheet is for tenant,
security, governance, and default model policy. Runtime version, canary,
traffic split, uptime, and deployment telemetry belong in `Deployments`.

Core columns:
`customer_id`, `tenant_id`, `platform_config_status`, `deployment_model`,
`data_residency_constraint`, `auth_mode`, `data_classification`,
`pii_handling`, `audit_logging_enabled`, `retention_days`,
`ai_governance_status`, `model_policy_id`, `allowed_model_providers`,
`model_data_use_policy`, `inference_region`,
`cross_border_processing_allowed`, `guardrail_policy`,
`guardrail_policy_version`, `guardrail_enforcement_mode`,
`prompt_logging_mode`, `customer_managed_key_enabled`, `kms_key_ref`,
`scim_provisioning_enabled`, `rbac_policy`, `audit_log_sink`,
`observability_enabled`, `primary_model`, `fallback_model`,
`minimum_eval_score_pct`, `last_governance_review_at`,
`monthly_spend_limit_usd`, `enabled_connectors`, `feature_flags`,
`primary_use_case`, `last_health_check_at`.

### Deployments

Grain: one row per deployable customer runtime instance, keyed by
`customer_id + deployment_id`. `environment` and `region` are dimensions, not
the primary key by themselves.

Core columns:
`customer_id`, `deployment_id`, `environment`, `region`, `cloud_provider`,
`runtime`, `deployment_strategy`, `deployed_version`, `release_id`,
`release_channel`, `build_sha`, `runtime_version`, `config_version`,
`approved_by_email`, `approved_at`, `model_route_id`, `model_routing_mode`,
`primary_model_ref`, `primary_model_version`, `fallback_model_ref`,
`fallback_model_version`, `model_traffic_primary_pct`, `last_deploy_at`,
`release_status`, `rollback_version`, `rollback_status`,
`rollback_tested_at`, `health_status`, `uptime_30d_pct`,
`error_rate_30d_pct`, `latency_p95_ms`, `latency_slo_ms`,
`request_count_30d`, `llm_request_count_30d`, `input_tokens_30d`,
`output_tokens_30d`, `cache_hit_rate_30d_pct`,
`guardrail_block_rate_30d_pct`, `cost_30d_usd`, `cost_budget_30d_usd`,
`projected_cost_30d_usd`, `capacity_limit_rpm`, `peak_rpm_30d`,
`utilization_30d_pct`, `live_url`, `deploy_owner_email`,
`last_incident_ref`, `active_incident_refs`, `incident_count_30d`,
`dashboard_url`, `runbook_url`, `last_telemetry_at`, `notes`.

### Solutions

Grain: one row per `(customer_id, solution_id)`. `use_case` is a category,
not the key, because one customer can have multiple workflows in the same
category.

This sheet owns workflow shape, use-case value delivery, AI evals, quality and
safety metrics, human review operations, readiness, and solution-level
expansion signals. Account ARR and renewal fields stay in `Customers`.
Runtime release and cost telemetry stay in `Deployments`.

Core columns include:
`solution_id`, `customer_id`, `use_case`, `workflow_id`, `workflow_name`,
`business_process`, `business_unit`, `primary_user_role`,
`workflow_owner_email`, `risk_owner_email`, `workflow_frequency`,
`decision_impact`, `upstream_systems`, `downstream_systems`,
`output_artifacts`, `sensitive_data_types`, `value_metric`,
`value_metric_unit`, `value_metric_direction`, `measurement_source`,
`measurement_window_days`, `baseline_metric_value`, `current_metric_value`,
`target_metric_value`, period dates, `value_evidence_url`,
`annualized_value_realized_usd`, `value_realization_confidence_pct`,
`solution_value_realization_stage`, usage metrics, readiness metrics, eval
status, eval suite/run fields, quality/safety rates, human review fields,
`readiness_status`, `readiness_gate_failures`, `model_risk_approval_status`,
`runbook_url`, `solution_next_step`, expansion fields, `solution_fde_owner`,
and `last_reviewed_date`.

### Implementation

Grain: one row per customer rollout plan. This sheet owns rollout governance,
data/integration readiness, security/privacy/eval acceptance, launch criteria,
runbooks, support handoff, billing readiness, and blocker references.

Core columns:
`customer_id`, `rollout_id`, `launch_scope_solution_ids`,
`implementation_stage`, `implementation_owner_email`,
`rollout_governance_status`, `customer_launch_approver_email`,
`provider_launch_approver_email`, `launch_decision`,
`launch_decision_date`, `implementation_progress_pct`,
`implementation_risk_level`, readiness percentages and statuses,
`security_review_status`, `privacy_review_status`, `eval_acceptance_status`,
`acceptance_evidence_link`, `uat_status`, `training_status`,
`launch_criteria`, `launch_criteria_status`, `go_live_confidence_pct`,
go-live dates/windows, `runbook_status`, `runbook_link`,
`support_handoff_status`, `support_owner_email`, `support_channel_ref`,
`billing_readiness_status`, `entitlement_provisioning_status`,
`billing_start_date`, milestone fields, blocker fields,
`critical_blocker_ticket_ids`, `open_blocker_count`,
`implementation_next_step`, `implementation_last_updated_at`.

### Tickets

Grain: one row per actionable ticket, follow-up, or incident for one customer.
Rows may reference customer, solution, deployment, and person records by ID or
email only. They must not duplicate account fields or person details.

Core columns:
`ticket_id`, `customer_id`, `summary`, `description`, affected schema/solution/
deployment/workflow/connector/model/data-source fields, related ticket IDs,
external system IDs, `ticket_type`, `ticket_category`,
status/priority/severity, queue/team/reporting fields, SLA/escalation fields,
source fields, customer impact fields, AI/FDE classification fields,
root-cause/remediation fields, postmortem fields, `tags`,
`resolution_summary`, `resolved_at`, `ticket_next_step`.

**Ticket categories.** Every ticket is classified into exactly one canonical
`ticket_category` (required). This is the triage taxonomy — coarser than the
free-form `ticket_type` — and it routes the ticket to the right FDE specialist:

| `ticket_category`                 | Routes to (specialist) |
| --------------------------------- | ---------------------- |
| `Feature Request`                 | `follow-ups`           |
| `Bug Report`                      | `deployment`           |
| `Data Migration Request`          | `data-migration`       |
| `Configuration Change Request`    | `configuration`        |
| `Workflow Customization Request`  | `configuration`        |

The canonical enum lives in `agent/lib/customer-schema.ts`
(`ticketCategorySchema` + `TICKET_CATEGORY_ROUTING`). The storage folder
under `Tickets/` is derived from the category — see
"Ticket categories ↔ `dm.md` ticket folders" above.

### Interactions

Grain: one row per customer touchpoint/event. Interactions are append-mostly
activity/audit records. They do not replace tickets. Source of record:
`Customers/{CustomerID}/interactions.jsonl` (and
`People/{person_id}/interactions.jsonl` for person-scoped rows), written by
`record_interaction`.

Core columns:
`interaction_id`, `customer_id`, `interaction_at`, `interaction_type`,
`source_system`, `source_id`, `source_link`, `summary`, `note`, `outcome`,
`participant_emails`, `related_ticket_ids`, `related_solution_ids`,
`related_deployment_ids`, `next_action`, `next_action_owner_email`,
`next_action_due_date`, `sentiment`, `sensitivity`, `recorded_by_email`,
`recorded_at`.

### Internal Staff

Grain: one row per OnFinance staff assignment to a customer. Packaged in
`People/Master.xlsx`.

Columns:
`customer_id`, `staff_role`, `name`, `title`, `employer_org`, `email`,
`last_contact`.

Allowed `staff_role`: `solution_engineer`, `account_executive`.
`employer_org` should be `OnFinance`.

### Customer Stakeholders

Grain: one row per external stakeholder/customer relationship. Packaged in
`People/Master.xlsx`.

Columns:
`customer_id`, `stakeholder_role`, `name`, `title`, `employer_org`, `email`,
`last_contact`.

Allowed `stakeholder_role`: `key_user`, `decision_maker`, `champion`.

## Cross-sheet rules

- `Customers.fde_owner` must reference a same-customer `Internal Staff.email`
  row with `staff_role = solution_engineer`.
- `Customers.ae_owner` must reference a same-customer `Internal Staff.email`
  row with `staff_role = account_executive`.
- `Customers.business_owner_email`, `technical_owner_email`, and
  `executive_sponsor_email` should reference same-customer
  `Customer Stakeholders.email` rows.
- `Solutions.solution_fde_owner` must reference a same-customer solution
  engineer.
- `Solutions.workflow_owner_email` and `risk_owner_email` should reference
  same-customer customer stakeholders.
- Version, health, uptime, runtime cost, canary, rollback, model routing, and
  active deployment model refs live only on `Deployments`.
- Eval score, eval run, task quality, safety, and human review metrics live on
  `Solutions` per workflow.
- `Implementation.launch_scope_solution_ids` and
  `Tickets.affected_solution_id` reference same-customer solution IDs.
- `Deployments.last_incident_ref`, `Deployments.active_incident_refs`,
  `Implementation.critical_blocker_ticket_ids`, `Tickets.related_ticket_ids`,
  and `Interactions.related_ticket_ids` reference same-customer ticket IDs.
- `Tickets.affected_deployment_id` and `Interactions.related_deployment_ids`
  reference same-customer deployment IDs.

## Validation

The canonical Zod contract lives in `agent/lib/customer-schema.ts`. Run
`npm run validate:schema` after changing `data/customers.json`,
`data/people.json`, or workbook headers. The validator checks JSON shape plus
the cross-sheet relationships above.
