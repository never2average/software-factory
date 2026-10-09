---
name: backfill-integration-history
description: Reconstruct a customer's pipeline and integration (Integromat) history into the canonical {folder:projects}/ layout and the implementation row. Use when an existing customer's data pipelines or integrations aren't yet recorded, when someone says "backfill the integrations", "record the pipeline history", "their Integromat scenarios aren't tracked", or before an eval/go-live review that needs the integration surface captured. Requires the customer to exist (onboard-customer). Materialises pipeline_config.json per pipeline plus the account integromat.json, and upserts the implementation row with integration-readiness state.
---

# Backfill integration history

> `{folder:<id>}` below is the data-room folder this deployment stores that domain under: its profile's
> `dataroom.domains.<id>.folder` (`uploads_folder` for `{folder:uploads}`). Read the real name with
> `node --experimental-strip-types -e 'import("./agent/lib/dataroom-folders.ts").then((m) => console.log(m.FOLDER))'`.

Reconstruct a customer's data pipelines and integrations into the canonical
`{folder:projects}/{id}/…` layout and the `implementation` system-of-record row. This
is **stage 5** — see [`docs/OPERATOR_WORKFLOW.md`](../../../docs/OPERATOR_WORKFLOW.md).

Use it when pipelines/integrations exist operationally but were never recorded, or
before an eval / go-live review that needs the integration surface captured.

## Working style

Gather the real pipelines (from `{folder:deliveries}/syncs`, the Integromat account, the
owning engineer's knowledge) before writing. Each `pipeline_config.json` starts as a skeleton —
its `steps` are the owning engineer's to fill; don't invent them.

## The steps

**1. Pick the customer.** Confirm the customer id exists.

**2. Inventory the pipelines.** For each: a `pipelineId` (e.g. `pl-collections`), a
`summary`, and — if you have it — the `config` object.

**3. Backfill.** Single pipeline via flags:
```bash
npm run operator:backfill-integrations -- --customer contoso-bank --org <workspace id> \
  --pipeline pl-collections --summary "Collections ETL via Integromat"
```
Many via a JSON file (`[{ "pipelineId", "summary", "config" }, …]`):
```bash
npm run operator:backfill-integrations -- --customer contoso-bank --org <workspace id> \
  --from-file integrations.json
```
This upserts the `implementation` row (stage `integration`, the pipeline ids as its
launch scope), writes `{folder:projects}/{id}/pipelines/{pid}/pipeline_config.json` per
pipeline and the account `{folder:projects}/{id}/integromat.json`, and logs an
`integration_backfilled` interaction.

**4. Fill and validate.** Complete each pipeline's `steps` and config, then run
`evals` before go-live (the `evals` subagent).

## Where this reads / writes

READ: the `customers` row (must exist); your gathered pipeline inventory.

WRITE:
- `implementation` row (upsert by customer; stage, owner, launch scope, connector
  provisioning status)
- `{folder:projects}/{id}/pipelines/{pid}/pipeline_config.json` per pipeline
- `{folder:projects}/{id}/integromat.json` — the account's pipeline manifest
- `{folder:accounts}/{id}/interactions.jsonl` — an `integration_backfilled` event

## Never

- Never fabricate pipeline steps or Integromat scenarios — leave them empty/`TODO`.
- Never write pipeline private credentials into `pipeline_config.json` — those
  belong in the `private.integromat.json` sibling (out of scope for this backfill).
- Never claim go-live readiness without evals.

## Quick reference

```bash
npm run operator:backfill-integrations -- --customer <id> --org <workspace id> \
  [--pipeline <pid>] [--summary "…"] [--from-file integrations.json]
```
