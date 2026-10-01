// Seed the Vercel Blob data room with a representative dm.md tree.
//
// dm.md at the repository root is the CANONICAL data model. This script writes
// REAL, plausible artifact bodies (context briefs, signoff records, Terraform,
// Helm values, JSON Schemas, ticket/interaction JSONL streams) for the key
// files across all 7 domains, via the DataroomStore's public API only — so
// every path is validated against DATAROOM_PATH_TEMPLATES before any I/O.
//
// Requires BLOB_READ_WRITE_TOKEN (the shared private Vercel Blob store; the
// store keys objects under the `dataroom/` prefix). Every file is written with
// write() — including .jsonl files, whose full multi-line body lands as a
// single clean Blob object (no append parts). Re-running overwrites in place,
// so the seed is idempotent-ish.
//
// Run: npm run seed:dataroom-blob -- --org <workspace id>   (node --experimental-strip-types)

import { getDataroomStore } from "../agent/lib/dataroom-store.ts";
import { DEPLOYMENT_PROFILE } from "../agent/lib/deployment-profile.generated.ts";

// The role words the seeded files use, from this deployment's profile (never a literal role word).
const MEMBER = DEPLOYMENT_PROFILE.vocabulary.member.singular;
const Owner = DEPLOYMENT_PROFILE.vocabulary.owner.charAt(0).toUpperCase() + DEPLOYMENT_PROFILE.vocabulary.owner.slice(1);
const OWNER = /^[A-Z][a-z]/.test(Owner) ? Owner.charAt(0).toLowerCase() + Owner.slice(1) : Owner;

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    "seed-dataroom-blob: BLOB_READ_WRITE_TOKEN is not set — this seed targets the Vercel Blob store.",
  );
  process.exit(1);
}

// ONE workspace's data room: `--org <id>` (or SEED_ORG). There is no default workspace to seed into — the store's
// root is no workspace's (lib/dataroom-keyspace.ts).
const orgArg = process.argv.indexOf("--org");
const SEED_ORG = (orgArg > -1 ? process.argv[orgArg + 1] : process.env.SEED_ORG ?? "").trim();
if (!SEED_ORG) {
  console.error("seed-dataroom-blob: name the workspace to seed: --org <workspace id> (or SEED_ORG).");
  process.exit(1);
}
const store = getDataroomStore(SEED_ORG);
if (store.backend.kind !== "vercel-blob") {
  console.error(
    `seed-dataroom-blob: expected the vercel-blob backend, got "${store.backend.kind}".`,
  );
  process.exit(1);
}

/** JSONL helper: one JSON record per line, newline-terminated by write(). */
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n");

// ---------------------------------------------------------------------------
// The seed tree — logical dm.md path -> file body
// ---------------------------------------------------------------------------

const FILES = {
  // --- Customers -------------------------------------------------------------
  "Customers/acme-bank/context.md": `# Acme Bank — Account Context

**Tier:** Enterprise · **Lifecycle:** Live · **Region:** us-east-1

## Current state

- Platform **v2.4.0** in production on AWS (blue/green), collections agent live
- Disputes workflow in UAT with the operations team; go/no-go review 2026-07-17
- Renewal 2026-11-30, forecast **Commit**; expansion conversation open on the disputes module

## Open threads

- **TCK-1002** — connector rate limits during the nightly core-banking sync
- Infosec re-review of the inference \`customizations.tf\` due **2026-07-18**
- SBOM for the v2.4.0 inference image requested by customer infosec

## Working notes

Champion is the VP of Operations; weekly sync every Thursday. Escalations go
through the ${OWNER} first — the account is sensitive to surprise emails.`,

  "Customers/acme-bank/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-8841",
      customer_id: "acme-bank",
      interaction_at: "2026-07-08T15:00:00Z",
      interaction_type: "meeting",
      source_system: "granola",
      summary: "Weekly sync — reviewed TCK-1002 mitigation and disputes UAT timeline",
      participant_emails: ["sam.cole@onfinance.ai", "vp.ops@acmebank.com"],
      sentiment: "positive",
      next_action: "Send revised rollout plan",
      next_action_owner_email: "sam.cole@onfinance.ai",
      next_action_due_date: "2026-07-11",
    },
    {
      interaction_id: "INT-8846",
      customer_id: "acme-bank",
      interaction_at: "2026-07-09T18:22:00Z",
      interaction_type: "email",
      source_system: "gmail",
      summary: "Infosec requested the SBOM for the v2.4.0 inference image",
      related_ticket_ids: ["TCK-1002"],
      sensitivity: "internal",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
    {
      interaction_id: "INT-8852",
      customer_id: "acme-bank",
      interaction_at: "2026-07-10T14:05:00Z",
      interaction_type: "slack",
      source_system: "slack",
      summary: "Confirmed the connector backoff patch is deployed to staging",
      sentiment: "positive",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
  ]),

  "Customers/acme-bank/agreements/msa.md": `# Master Service Agreement — Acme Bank

**Effective:** 2025-11-30 · **Term:** 36 months · **Governing law:** New York

## Commercial summary

- Platform subscription: **$480,000/yr**, invoiced quarterly in advance
- 250 named seats; overage at the then-current per-seat rate
- Uptime SLA **99.9%** monthly, service credits per Schedule B

## Key clauses

- Data residency: all customer data processed and stored in **us-east-1**
- Customer-managed KMS keys for data at rest (Schedule C)
- Model providers restricted to the approved list in the AI Addendum
- Termination for convenience: 90 days' notice, prorated refund`,

  "Customers/northwind-capital/context.md": `# Northwind Capital — Account Context

**Tier:** Growth · **Lifecycle:** Onboarding · **Region:** eu-west-1

## Current state

- Implementation kicked off 2026-06-02; research-assistant workflow scoped
- Data-access review in progress with their platform team
- **TCK-2031** (portfolio ingest dedupe bug) is the top blocker for UAT

## Open threads

- Waiting on read-only credentials for the portfolio data warehouse
- Privacy review scheduled 2026-07-21 with their DPO

## Working notes

Technical owner prefers async updates in Slack; monthly steering call with
the COO. Keep the tone metrics-first — they track everything.`,

  "Customers/northwind-capital/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-8853",
      customer_id: "northwind-capital",
      interaction_at: "2026-07-09T10:00:00Z",
      interaction_type: "meeting",
      source_system: "granola",
      summary: "UAT planning — dedupe fix sequencing with their data engineering lead",
      participant_emails: ["sam.cole@onfinance.ai", "data.eng@northwindcap.com"],
      next_action: "Deliver patched transform to UAT",
      next_action_owner_email: "sam.cole@onfinance.ai",
      next_action_due_date: "2026-07-14",
    },
    {
      interaction_id: "INT-8860",
      customer_id: "northwind-capital",
      interaction_at: "2026-07-10T09:40:00Z",
      interaction_type: "slack",
      source_system: "slack",
      summary: "Platform team confirmed read-only warehouse credentials arrive by 2026-07-15",
      sentiment: "neutral",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
  ]),

  "Customers/northwind-capital/agreements/msa.md": `# Master Service Agreement — Northwind Capital

**Effective:** 2026-05-15 · **Term:** 24 months · **Governing law:** England & Wales

## Commercial summary

- Platform subscription: **$180,000/yr**, invoiced annually in advance
- 80 named seats; growth-tier expansion pricing locked for the term
- Uptime SLA **99.5%** monthly, service credits per Schedule B

## Key clauses

- Data residency: all customer data processed and stored in **eu-west-1** (GDPR)
- Sub-processor list changes require 30 days' advance notice
- Model providers restricted to the approved list in the AI Addendum
- Termination for convenience: 60 days' notice after month 12`,

  // --- Platform ----------------------------------------------------------------
  "Platform/v2.4.0/2026-07-01_changelog_manager.md": `# Platform v2.4.0 — Release Changelog

**Cut:** 2026-07-01 · **Channel:** stable · **Build:** \`9f31c2a\`

## Highlights

- **Inference routing v2** — weighted primary/fallback traffic split with
  per-tenant overrides and automatic failover on provider 5xx
- **Guardrail policy engine** upgraded to policy-as-code (\`guardrail-policy v4\`)
- Connector framework: exponential backoff + jitter on all rate-limited pulls

## Fixes

- Fixed a race in the nightly sync scheduler that could double-enqueue jobs
- Eval runner now pins dataset versions per run for reproducibility

## Upgrade notes

- Helm chart 1.8.x required; re-render values with the new \`inference.routing\` block
- Terraform module \`onfinance/inference\` bumped to 3.2.0 — plan before apply`,

  "Platform/v2.4.0/architecture/helm/values.yaml": `# onfinance-runtime Helm values — platform v2.4.0
image:
  repository: registry.onfinance.ai/runtime
  tag: "2.4.0"
  pullPolicy: IfNotPresent

replicaCount: 3

inference:
  routing:
    mode: weighted
    primary:
      ref: claude-sonnet-4-5
      weight: 90
    fallback:
      ref: claude-haiku-4-5
      weight: 10
  region: us-east-1

guardrails:
  policy: guardrail-policy
  version: v4
  enforcement: block

resources:
  requests:
    cpu: "1"
    memory: 2Gi
  limits:
    cpu: "2"
    memory: 4Gi

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 12
  targetCPUUtilizationPercentage: 65`,

  "Platform/v2.4.0/architecture/infrastructure/main.tf": `# Platform v2.4.0 — base infrastructure
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }
}

module "network" {
  source             = "onfinance/network/aws"
  version            = "2.1.0"
  vpc_cidr           = "10.40.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_subnets    = true
}

module "runtime_cluster" {
  source          = "onfinance/eks/aws"
  version         = "3.0.1"
  cluster_name    = "onfinance-runtime"
  cluster_version = "1.30"
  node_groups = {
    general   = { instance_types = ["m6i.xlarge"], min = 3, max = 12 }
    inference = { instance_types = ["g6.2xlarge"], min = 2, max = 8 }
  }
  vpc_id = module.network.vpc_id
}

module "observability" {
  source     = "onfinance/observability/aws"
  version    = "1.4.2"
  cluster_id = module.runtime_cluster.cluster_id
  log_sink   = "s3://onfinance-audit-logs"
}`,

  "Platform/v2.4.0/design_decisions/tenancy.schemas.json": JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://onfinance.ai/schemas/v2.4.0/tenancy.json",
      title: "Tenancy contract",
      type: "object",
      required: ["tenant_id", "deployment_model", "auth_mode"],
      properties: {
        tenant_id: { type: "string", pattern: "^tnt-[a-z0-9]{8}$" },
        deployment_model: { enum: ["saas", "dedicated", "byoc"] },
        auth_mode: { enum: ["sso-saml", "sso-oidc", "api-key"] },
        data_residency_constraint: { type: "string" },
        customer_managed_key_enabled: { type: "boolean", default: false },
        retention_days: { type: "integer", minimum: 30, maximum: 3650 },
      },
    },
    null,
    2,
  ),

  "Platform/v2.4.0/design_decisions/dataengineering.schemas.json": JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://onfinance.ai/schemas/v2.4.0/dataengineering.json",
      title: "Data engineering approach contract",
      type: "object",
      required: ["migration_id", "source_system", "strategy"],
      properties: {
        migration_id: { type: "string", pattern: "^mig-[0-9]{3}$" },
        source_system: { type: "string" },
        target_dataset: { type: "string" },
        strategy: { enum: ["full_load", "incremental", "cdc", "dual_write"] },
        cutover_window: { type: "string" },
        rollback_plan: { type: "string" },
        validation: {
          type: "object",
          properties: {
            row_count_tolerance_pct: { type: "number", maximum: 5 },
            checksum_validation: { type: "boolean", default: true },
          },
        },
      },
    },
    null,
    2,
  ),

  "Platform/v2.4.0/security/sbom.json": JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        timestamp: "2026-07-01T04:12:00Z",
        component: { type: "container", name: "onfinance-runtime", version: "2.4.0" },
      },
      components: [
        { type: "library", name: "fastapi", version: "0.115.2", licenses: [{ license: { id: "MIT" } }] },
        { type: "library", name: "pydantic", version: "2.9.1", licenses: [{ license: { id: "MIT" } }] },
        { type: "library", name: "anthropic", version: "0.52.0", licenses: [{ license: { id: "MIT" } }] },
        { type: "library", name: "openssl", version: "3.3.1", licenses: [{ license: { id: "Apache-2.0" } }] },
      ],
    },
    null,
    2,
  ),

  // --- Deployments -------------------------------------------------------------
  "Deployments/acme-bank/v2.4.0/infrastructure/inference/customizations.tf": `# Acme Bank — inference customizations over the v2.4.0 base stack
# See rationale.md; changes require the four-party signoff chain.

module "inference_override" {
  source  = "onfinance/inference/aws"
  version = "3.2.0"

  tenant_id        = "tnt-acme0001"
  inference_region = "us-east-1"

  # Customer-managed KMS key for all inference-side storage
  kms_key_arn = "arn:aws:kms:us-east-1:481522891733:key/7c1e-acme-cmk"

  # Dedicated inference node group — no multi-tenant sharing
  dedicated_node_group = true
  node_instance_type   = "g6.4xlarge"
  min_nodes            = 2
  max_nodes            = 6

  # Egress locked to the approved model-provider endpoints only
  restricted_egress = true
  allowed_endpoints = [
    "api.anthropic.com",
  ]
}`,

  "Deployments/acme-bank/v2.4.0/infrastructure/inference/rationale.md": `# Inference Customization Rationale — Acme Bank / v2.4.0

## Why these overrides exist

Acme Bank's regulatory profile (OCC-supervised, MRM policy 11-7) requires
inference isolation guarantees beyond the shared v2.4.0 defaults:

- **Dedicated node group** — no co-tenancy on inference hosts, per their
  third-party risk assessment
- **Customer-managed KMS key** — all inference-side caches and logs encrypt
  under the Acme CMK (MSA Schedule C)
- **Restricted egress** — outbound traffic pinned to the approved model
  provider endpoint list; anything else is dropped at the NAT policy

## Cost impact

Dedicated \`g6.4xlarge\` capacity adds ~$3,100/mo over pooled inference at
current volumes. Approved by the account team on 2026-06-24.

## Review cadence

Re-review with customer infosec each platform minor release, next due
**2026-07-18** alongside the v2.4.0 SBOM review.`,

  "Deployments/acme-bank/v2.4.0/infrastructure/inference/signoff/internal.md": `# Signoff — Internal (OnFinance)

**Artifact:** \`customizations.tf\` @ \`b4f19d7\` · **Date:** 2026-06-25

Reviewed the dedicated node group sizing, CMK integration, and restricted
egress list against the v2.4.0 base module. Terraform plan shows no drift
outside the inference module. Cost delta approved by the account team.

**Decision: APPROVED** — Sam Cole, Solutions Engineering`,

  "Deployments/acme-bank/v2.4.0/infrastructure/inference/signoff/customer.infra.md": `# Signoff — Customer Infrastructure (Acme Bank)

**Artifact:** \`customizations.tf\` @ \`b4f19d7\` · **Date:** 2026-06-27

Platform engineering reviewed the node group placement, VPC peering
assumptions, and the NAT egress policy. Confirmed the dedicated capacity
lands in our approved subnets and tagging standard is met.

**Decision: APPROVED** — R. Iyer, Head of Platform Engineering, Acme Bank`,

  "Deployments/acme-bank/v2.4.0/infrastructure/inference/signoff/customer.infosec.md": `# Signoff — Customer Information Security (Acme Bank)

**Artifact:** \`customizations.tf\` @ \`b4f19d7\` · **Date:** 2026-06-30

Infosec reviewed CMK usage, egress restrictions, and log handling.
Approval is **conditional**: the v2.4.0 inference image SBOM must be
delivered and reviewed before the 2026-07-18 re-review; egress list changes
require a new signoff round.

**Decision: APPROVED (conditional)** — M. Delgado, CISO Office, Acme Bank`,

  "Deployments/acme-bank/v2.4.0/infrastructure/inference/signoff/customer.cloudvendor.md": `# Signoff — Cloud Vendor (AWS Enterprise Support)

**Artifact:** \`customizations.tf\` @ \`b4f19d7\` · **Date:** 2026-07-01

Reviewed capacity reservation for the dedicated \`g6.4xlarge\` node group in
us-east-1 under Acme Bank's EDP. On-demand capacity reservation confirmed;
no service-quota increases required at the stated max of 6 nodes.

**Decision: ACKNOWLEDGED** — AWS TAM, Acme Bank account`,

  "Deployments/acme-bank/v2.4.0/platform/organization.json": JSON.stringify(
    {
      org_id: "org-acme-bank",
      rbac_policy: "role-based",
      scim_provisioning_enabled: true,
      workspaces: [
        { workspace_id: "ws-collections", name: "Collections Operations", default_role: "editor" },
        { workspace_id: "ws-disputes", name: "Disputes (UAT)", default_role: "viewer" },
      ],
    },
    null,
    2,
  ),

  "Deployments/acme-bank/v2.4.0/platform/pipelines/pl-001/pipeline_config.json": JSON.stringify(
    {
      pipeline_id: "pl-001",
      source: {
        connector: "core-banking-sftp",
        dataset: "delinquency_ledger",
        incremental: true,
      },
      schedule: "0 2 * * *",
      backoff: { strategy: "exponential", max_retries: 6 },
      transforms: ["normalize_account_ids", "mask_pii", "dedupe_by_account_day"],
      destination: "dataplatform://acme-bank/collections",
    },
    null,
    2,
  ),

  "Deployments/acme-bank/v2.4.0/platform/migrations/mig-001/dataengineering.approach.json":
    JSON.stringify(
      {
        migration_id: "mig-001",
        source_system: "legacy-collections-db",
        target_dataset: "dataplatform://acme-bank/collections",
        strategy: "incremental",
        cutover_window: "2026-07-24T02:00:00Z/2026-07-24T06:00:00Z",
        rollback_plan:
          "Re-point pl-001 at the legacy extract and replay the last two nightly runs.",
        validation: { row_count_tolerance_pct: 0.5, checksum_validation: true },
      },
      null,
      2,
    ),

  "Deployments/acme-bank/v2.4.0/platform/migrations/mig-001/context.md": `# Migration mig-001 — Legacy Collections DB → Data Platform

**Customer:** acme-bank · **Platform:** v2.4.0 · **Strategy:** incremental

## Scope

Move the delinquency ledger history (7 years) off the legacy collections
database into the managed data platform feeding pipeline **pl-001**.

## Status

- Historical backfill complete through 2026-06-30; nightly deltas validated
- Cutover window agreed with the bank's platform team: **2026-07-24 02:00 ET**
- Rollback rehearsed in staging on 2026-07-15

## Open items

- Final checksum report to customer data engineering before cutover`,

  "Deployments/acme-bank/v2.4.0/platform/migrations/mig-001/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-9101",
      migration_id: "mig-001",
      customer_id: "acme-bank",
      interaction_at: "2026-07-14T16:00:00Z",
      interaction_type: "meeting",
      summary: "Cutover planning with Acme platform engineering — agreed on the 07-24 window",
      participant_emails: ["sam.cole@onfinance.ai", "r.iyer@acmebank.com"],
    },
    {
      interaction_id: "INT-9108",
      migration_id: "mig-001",
      customer_id: "acme-bank",
      interaction_at: "2026-07-15T11:30:00Z",
      interaction_type: "slack",
      summary: "Rollback rehearsal in staging passed — replayed two nightly runs clean",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
  ]),

  // --- Solutions ---------------------------------------------------------------
  "Solutions/v2.4.0/agents/collections-agent/recipe.md": `# Collections Agent — Recipe (v2.4.0)

## Purpose

Drafts compliant, personalized outreach for delinquent accounts and queues
next-best-action recommendations for the collections team.

## Inputs

- \`delinquency_ledger\` rows from pipeline **pl-001** (nightly)
- Account contact history from the CRM connector
- Hardship-program eligibility rules (\`rules/hardship.yaml\`)

## Behavior

- Segment by days-past-due bucket, then rank by promise-to-pay likelihood
- Draft outreach in the approved tone; **never** state legal consequences
  beyond the approved disclosure library
- Route accounts flagged \`hardship_eligible\` to the human review queue

## Guardrails

\`\`\`yaml
guardrails:
  policy: guardrail-policy@v4
  blocked_topics: [legal-threats, settlement-amounts]
  human_review: required_for [hardship, disputes]
\`\`\`

## Acceptance

Eval pass rate ≥ **92%** on \`evals/dataset.jsonl\` before any config change
ships to production.`,

  "Solutions/v2.4.0/agents/collections-agent/evals/dataset.jsonl": jsonl([
    {
      case_id: "ev-001",
      input: { days_past_due: 12, balance: 1840.55, hardship_eligible: false, prior_contacts: 1 },
      expected: { action: "draft_outreach", tone: "reminder", escalate: false },
    },
    {
      case_id: "ev-002",
      input: { days_past_due: 45, balance: 9210.0, hardship_eligible: true, prior_contacts: 3 },
      expected: { action: "route_human_review", queue: "hardship", escalate: false },
    },
    {
      case_id: "ev-003",
      input: { days_past_due: 95, balance: 15400.1, hardship_eligible: false, prior_contacts: 6 },
      expected: { action: "draft_outreach", tone: "final_notice", escalate: true },
    },
  ]),

  "Solutions/v2.4.0/pipelines/pl-001/migrations/mig-001/dataengineering.approach.json":
    JSON.stringify(
      {
        migration_id: "mig-001",
        source_system: "legacy-collections-db",
        target_dataset: "delinquency_ledger",
        strategy: "incremental",
        notes:
          "Solution-level reference approach for onboarding pl-001 consumers; deployment-specific overrides live under Deployments.",
        validation: { row_count_tolerance_pct: 0.5, checksum_validation: true },
      },
      null,
      2,
    ),

  "Solutions/v2.4.0/pipelines/pl-001/migrations/mig-001/context.md": `# Migration mig-001 — pl-001 Reference Approach (v2.4.0)

Solution-level playbook for migrating a customer's collections history into
the dataset behind pipeline **pl-001**.

## Approach

- Incremental loads keyed on \`(account_id, ledger_date)\`; full-history
  backfill first, then nightly deltas
- Checksum validation against the source extract after every backfill batch
- Cutover only after two consecutive clean delta runs

## Notes

Customer-specific cutover windows, credentials, and codebases live in the
matching Deployments/Implementation migration folders.`,

  "Solutions/v2.4.0/pipelines/pl-001/migrations/mig-001/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-9050",
      migration_id: "mig-001",
      pipeline_id: "pl-001",
      interaction_at: "2026-07-11T09:00:00Z",
      interaction_type: "meeting",
      summary: "Reviewed the reference migration playbook with solutions engineering",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
  ]),

  // --- Implementation ----------------------------------------------------------
  "Implementation/acme-bank/integromat.json": JSON.stringify(
    {
      customer_id: "acme-bank",
      integrations: [
        { id: "int-crm", connector: "salesforce", scopes: ["accounts.read", "contacts.read"], status: "active" },
        { id: "int-core", connector: "core-banking-sftp", scopes: ["ledger.read"], status: "active" },
        { id: "int-notify", connector: "slack", scopes: ["chat.write"], status: "active" },
      ],
      secrets_ref: "vault://acme-bank/integromat",
      last_validated_at: "2026-07-06T09:30:00Z",
    },
    null,
    2,
  ),

  "Implementation/acme-bank/pipelines/pl-001/pipeline_config.json": JSON.stringify(
    {
      pipeline_id: "pl-001",
      stage: "implementation",
      source: {
        connector: "core-banking-sftp",
        dataset: "delinquency_ledger",
        incremental: false,
      },
      schedule: "manual",
      notes:
        "Full-history backfill config used during onboarding; the production nightly variant lives under Deployments.",
      acceptance: {
        row_count_tolerance_pct: 0.5,
        checksum_validation: true,
        signed_off_by: "sam.cole@onfinance.ai",
      },
    },
    null,
    2,
  ),

  "Implementation/acme-bank/migrations/mig-001/dataengineering.approach.json": JSON.stringify(
    {
      migration_id: "mig-001",
      customer_id: "acme-bank",
      source_system: "legacy-collections-db",
      target_dataset: "delinquency_ledger",
      strategy: "full_load",
      cutover_window: "onboarding",
      notes:
        "Onboarding full-history load executed during implementation; the production incremental variant lives under Deployments.",
      validation: {
        row_count_tolerance_pct: 0.5,
        checksum_validation: true,
        signed_off_by: "sam.cole@onfinance.ai",
      },
    },
    null,
    2,
  ),

  "Implementation/acme-bank/migrations/mig-001/context.md": `# Migration mig-001 — Acme Bank Onboarding Load

**Stage:** implementation · **Strategy:** full-history load

## Summary

One-time full load of the legacy collections database into the data
platform during onboarding, ahead of the incremental production migration.

## Status

- Extract received 2026-06-10; 7 years of ledger history (41.2M rows)
- Full load completed 2026-06-14; checksum validation clean
- Signed off by the customer data engineering lead on 2026-06-16

## Follow-ups

- Production incremental cutover tracked under Deployments mig-001`,

  "Implementation/acme-bank/migrations/mig-001/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-8720",
      migration_id: "mig-001",
      customer_id: "acme-bank",
      interaction_at: "2026-06-12T15:00:00Z",
      interaction_type: "meeting",
      summary: "Backfill checkpoint — 60% loaded, checksums clean so far",
      participant_emails: ["sam.cole@onfinance.ai", "data.eng@acmebank.com"],
    },
    {
      interaction_id: "INT-8731",
      migration_id: "mig-001",
      customer_id: "acme-bank",
      interaction_at: "2026-06-16T10:00:00Z",
      interaction_type: "email",
      summary: "Customer data engineering signed off on the onboarding load",
      recorded_by_email: "sam.cole@onfinance.ai",
    },
  ]),

  // --- Tickets -----------------------------------------------------------------
  "Tickets/feat/acme-bank/v2.4.0/tickets_TCK-1002.jsonl": jsonl([
    {
      ticket_id: "TCK-1002",
      customer_id: "acme-bank",
      ticket_category: "Feature Request",
      ticket_type: "connector",
      summary: "Add adaptive rate limiting to the core-banking connector",
      description:
        "Nightly sync hits the bank's SFTP rate cap around 02:40 ET; requesting adaptive backoff with a configurable ceiling.",
      ticket_status: "In Progress",
      ticket_priority: "P1-High",
      ticket_opened_date: "2026-06-18",
      ticket_owner_email: "sam.cole@onfinance.ai",
      affected_deployment_id: "dep-acme-prod",
      affected_environment: "production",
      source_channel: "slack",
      ticket_next_step: "Ship backoff patch to production in the Thursday window",
    },
    {
      ticket_id: "TCK-1002",
      event: "comment",
      at: "2026-07-09T18:40:00Z",
      author: "sam.cole@onfinance.ai",
      body: "Backoff patch validated in staging — zero throttle errors across two synthetic runs.",
    },
    {
      ticket_id: "TCK-1002",
      event: "status_change",
      at: "2026-07-10T14:06:00Z",
      from: "Open",
      to: "In Progress",
      by: "sam.cole@onfinance.ai",
    },
  ]),

  "Tickets/bug/northwind-capital/v2.4.0/tickets_TCK-2031.jsonl": jsonl([
    {
      ticket_id: "TCK-2031",
      customer_id: "northwind-capital",
      ticket_category: "Bug Report",
      ticket_type: "data-quality",
      summary: "Portfolio ingest dedupes rows across different fund share classes",
      description:
        "The dedupe transform keys on ISIN only; share classes with the same ISIN collapse into one row, understating AUM in the research assistant.",
      ticket_status: "Open",
      ticket_priority: "P0-Critical",
      severity: "sev2",
      ticket_opened_date: "2026-07-02",
      ticket_owner_email: "sam.cole@onfinance.ai",
      affected_solution_id: "sol-nw-research",
      affected_environment: "uat",
      production_impact: false,
      ticket_next_step: "Patch dedupe key to (ISIN, share_class) and re-run the UAT backfill",
    },
    {
      ticket_id: "TCK-2031",
      event: "comment",
      at: "2026-07-08T11:15:00Z",
      author: "data.eng@northwindcap.com",
      body: "Confirmed 214 collapsed rows in the June extract. Blocking UAT signoff until resolved.",
    },
  ]),

  // --- People ------------------------------------------------------------------
  "People/sam-cole/identity.json": JSON.stringify(
    {
      person_id: "sam-cole",
      name: "Sam Cole",
      employer_org: "OnFinance",
      title: "Senior Solutions Engineer",
      emails: ["sam.cole@onfinance.ai"],
      external_ids: {
        slack: "U04SAMCOLE",
        github: "samcole-of",
        salesforce: "005Uw000003kSam",
      },
      assignments: [
        { customer_id: "acme-bank", staff_role: "solution_engineer" },
        { customer_id: "northwind-capital", staff_role: "solution_engineer" },
      ],
    },
    null,
    2,
  ),

  "People/sam-cole/context.md": `# Sam Cole — Person Context

**Role:** Senior Solutions Engineer, OnFinance · **Since:** 2024-03

## Current assignments

- **acme-bank** — ${Owner}; drove the v2.4.0 inference customization and
  owns the TCK-1002 connector work
- **northwind-capital** — ${Owner} for onboarding; running the UAT plan

## Working style

- Prefers Slack threads over email for anything operational
- Writes the weekly account digest Fridays; escalates via the AE only when
  a commercial term is in play

## Recent focus

Closing the Acme infosec conditions (SBOM review 2026-07-18) and unblocking
the Northwind dedupe bug before their UAT window closes.`,

  "People/sam-cole/interactions.jsonl": jsonl([
    {
      interaction_id: "INT-8841",
      person_id: "sam-cole",
      customer_id: "acme-bank",
      interaction_at: "2026-07-08T15:00:00Z",
      interaction_type: "meeting",
      summary: "Weekly Acme sync — TCK-1002 mitigation review",
      sentiment: "positive",
    },
    {
      interaction_id: "INT-8853",
      person_id: "sam-cole",
      customer_id: "northwind-capital",
      interaction_at: "2026-07-09T10:00:00Z",
      interaction_type: "meeting",
      summary:
        "Northwind UAT planning — dedupe fix sequencing with their data engineering lead",
      next_action: "Deliver patched transform to UAT",
      next_action_due_date: "2026-07-14",
    },
  ]),

  "People/sam-cole/roles_and_responsibilities.md": `# Sam Cole — Roles & Responsibilities

**Role:** Senior Solutions Engineer, OnFinance

## Responsibilities

- **${Owner}, acme-bank** — accountable for the v2.4.0 deployment health,
  the TCK-1002 connector work, and the infosec re-review conditions
- **${Owner}, northwind-capital** — runs the onboarding plan, UAT
  sequencing, and the dedupe-bug remediation (TCK-2031)
- Owns migration execution for assigned accounts (approach docs, cutover
  windows, rollback rehearsals)

## Decision rights

- Approves internal signoff on deployment infrastructure customizations
- Escalates commercial-term changes to the AE; never negotiates directly

## Coverage

Backup ${MEMBER} during PTO: rotation via the solutions-engineering on-call.`,
};

// ---------------------------------------------------------------------------
// Write everything through the store (path-validated), then report
// ---------------------------------------------------------------------------

const paths = Object.keys(FILES);
let written = 0;
for (const path of paths) {
  await store.write(path, FILES[path]);
  written += 1;
  console.log(`  wrote ${path}`);
}

console.log(
  `\nseed-dataroom-blob: wrote ${written}/${paths.length} files to the ${store.backend.kind} backend (dataroom/ prefix).`,
);
