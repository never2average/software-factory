---
name: configure-platform
description: Author a platform version's design-decision schemas and reference architecture — the contract every solution binds to — and optionally a customer's platform-governance row. Use when standing up a new platform version, when someone says "configure the platform", "set up the platform version", "define the platform schemas/contract", or when a customer needs governance (model policy, guardrails, residency, connectors) configured. The version contract is shared across customers (Platform/{ver}/, blob-only); the governance row is per-customer (the platform table).
---

# Configure platform

Two layers, one skill:

1. **The version contract** (`Platform/{ver}/`, shared) — the design-decision
   schemas (tenancy, organization, dataplatform, dataengineering, agents,
   pipeline_config, integromat) + reference architecture (helm, terraform) that
   **every solution at that version validates against**. Authored once per version.
2. **Customer governance** (the `platform` table, per customer) — deployment model,
   data residency, model policy, guardrails, connectors, feature flags.

This is the **contract layer** below `configure-solution` / `configure-agents`. See
[`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md).

## Steps

**1. The version contract.**
```bash
npm run fde:configure-platform -- --version v2.4.0
```
Scaffolds the seven `design_decisions/*.schemas.json` stubs + architecture
placeholders under `Platform/v2.4.0/` (never clobbers authored schemas). **Fill the
stubs** — they are the contract solutions bind to.

**2. Customer governance (optional).** When a customer's platform settings need
recording:
```bash
npm run fde:configure-platform -- --version v2.4.0 --customer contoso-bank \
  --deployment-model single_tenant --residency in-country \
  --primary-model claude-opus-4.8 --use-case "collections triage"
```
Upserts the `platform` governance row (requires the customer to exist).

## Where this reads / writes

WRITE:
- `Platform/{ver}/design_decisions/{tenancy,organization,dataplatform,dataengineering,agents,pipeline_config,integromat}.schemas.json`
- `Platform/{ver}/architecture/{helm/values.yaml, infrastructure/main.tf}`
- `platform` governance row (only with `--customer`)

## Never

- Never overwrite an authored schema — the scaffolder only writes absent files.
- Never put customer-specific config in the shared `Platform/{ver}/` tree — that's
  the version contract; per-customer state is the `platform` row and `Deployments/`.

## Quick reference

```bash
npm run fde:configure-platform -- --version <ver> [--customer <id> \
  --deployment-model … --residency … --primary-model … --use-case "…"]
```
