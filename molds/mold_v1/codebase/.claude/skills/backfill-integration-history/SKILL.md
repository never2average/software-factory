---
name: backfill-integration-history
description: Reconstruct a customer's pipeline and integration (Integromat) history into the canonical Implementation/ layout and the implementation row. Use when an existing customer's data pipelines or integrations aren't yet recorded, when someone says "backfill the integrations", "record the pipeline history", "their Integromat scenarios aren't tracked", or before an eval/go-live review that needs the integration surface captured. Requires the customer to exist (onboard-customer). Materialises pipeline_config.json per pipeline plus the account integromat.json, and upserts the implementation row with integration-readiness state.
---

# Backfill integration history

Reconstruct a customer's data pipelines and integrations into the canonical
`Implementation/{id}/…` layout and the `implementation` system-of-record row. This
is **stage 5** — see [`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md).

Use it when pipelines/integrations exist operationally but were never recorded, or
before an eval / go-live review that needs the integration surface captured.

## Working style

Gather the real pipelines (from `Deployments/syncs`, the Integromat account, the
FDE's knowledge) before writing. Each `pipeline_config.json` starts as a skeleton —
its `steps` are the FDE's to fill; don't invent them.

## The steps

**1. Pick the customer.** Confirm the customer id exists.

**2. Inventory the pipelines.** For each: a `pipelineId` (e.g. `pl-collections`), a
`summary`, and — if you have it — the `config` object.

**3. Backfill.** Single pipeline via flags:
```bash
npm run fde:backfill-integrations -- --customer contoso-bank --org <workspace id> \
  --pipeline pl-collections --summary "Collections ETL via Integromat"
```
Many via a JSON file (`[{ "pipelineId", "summary", "config" }, …]`):
```bash
npm run fde:backfill-integrations -- --customer contoso-bank --org <workspace id> \
  --from-file integrations.json
```
This upserts the `implementation` row (stage `integration`, the pipeline ids as its
launch scope), writes `Implementation/{id}/pipelines/{pid}/pipeline_config.json` per
pipeline and the account `Implementation/{id}/integromat.json`, and logs an
`integration_backfilled` interaction.

**4. Fill and validate.** Complete each pipeline's `steps` and config, then run
`evals` before go-live (the `evals` subagent).

## Where this reads / writes

READ: the `customers` row (must exist); your gathered pipeline inventory.

WRITE:
- `implementation` row (upsert by customer; stage, owner, launch scope, connector
  provisioning status)
- `Implementation/{id}/pipelines/{pid}/pipeline_config.json` per pipeline
- `Implementation/{id}/integromat.json` — the account's pipeline manifest
- `Customers/{id}/interactions.jsonl` — an `integration_backfilled` event

## Never

- Never fabricate pipeline steps or Integromat scenarios — leave them empty/`TODO`.
- Never write pipeline private credentials into `pipeline_config.json` — those
  belong in the `private.integromat.json` sibling (out of scope for this backfill).
- Never claim go-live readiness without evals.

## Quick reference

```bash
npm run fde:backfill-integrations -- --customer <id> --org <workspace id> \
  [--pipeline <pid>] [--summary "…"] [--from-file integrations.json]
```
