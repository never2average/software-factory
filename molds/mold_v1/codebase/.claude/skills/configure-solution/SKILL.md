---
name: configure-solution
description: Scaffold a reusable pipeline solution as a self-describing "minified solution-manager" under {folder:solutions}/{ver}/pipelines/{id}/ — its contract (run_configs + integromat schemas), its artifact (pipeline_config.json), gated by evals not PRs. Use when authoring a new pipeline solution, when someone says "configure a solution", "create a pipeline", "add a solution", or when a customer needs a pipeline instance seeded into their deployment. Optionally registers the customer's solutions row and seeds the Deployments instance from the recipe. Its sibling for agents is the configure-agents skill.
---

# Configure solution (pipeline)

> `{folder:<id>}` below is the data-room folder this deployment stores that domain under: its profile's
> `dataroom.domains.<id>.folder` (`uploads_folder` for `{folder:uploads}`). Read the real name with
> `node --experimental-strip-types -e 'import("./agent/lib/dataroom-folders.ts").then((m) => console.log(m.FOLDER))'`.

A configured solution is a **self-contained, independently versionable, eval-gated
unit** — a *minified solution-manager*. The key idea: the "solution-manager" is the
central machine (these `operator:*` scripts); each solution is the **data** that machine
runs — a schema (contract) + a config (artifact) + evals (the gate) + migrations
(change history) + grounding. Don't fork the machine into each solution; keep it
central and make each solution self-describing.

This maps `your-org/solution-manager` onto your data model:
`pipeline.schema.json` → `run_configs.schema.json`; `solution.json` →
`pipeline_config.json`; the PR gate → **eval acceptance + the deployment signoff**,
not git. See [`docs/OPERATOR_WORKFLOW.md`](../../../docs/OPERATOR_WORKFLOW.md).

## Steps

**1. Scaffold the instance.**
```bash
npm run operator:configure-solution -- --version v2.4.0 --id pl-collections \
  --use-case "Collections triage"
```
Writes the contract (`run_configs.schema.json`, `integromat.schema.json`) and the
artifact (`pipeline_config.json`) under `{folder:solutions}/v2.4.0/pipelines/pl-collections/`
(never clobbers authored files).

**2. Author it.** Define `run_configs.schema.json` (the contract, bound to the
platform version's `pipeline_config` design decision), then fill
`pipeline_config.json`'s `steps`. Ground the design in
`background_research/{person_id}/` and record changes as
`migrations/{migration_id}/`. Evals live under `evals/{run_id}/`.

**3. Register + seed a customer (optional).**
```bash
npm run operator:configure-solution -- --version v2.4.0 --id pl-collections \
  --use-case "Collections triage" --customer contoso-bank
```
Upserts the `solutions` row and seeds
`{folder:deliveries}/{customer}/{ver}/platform/pipelines/{id}/pipeline_config.json` (the
dm.md recipe seam — the deployment instance).

**4. Gate it.**
```bash
npm run operator:validate-solution -- --version v2.4.0 --id pl-collections --strict
```

## Where this reads / writes

WRITE:
- `{folder:solutions}/{ver}/pipelines/{id}/{run_configs.schema.json, integromat.schema.json, pipeline_config.json}`
- `solutions` row + `{folder:deliveries}/{customer}/{ver}/platform/pipelines/{id}/pipeline_config.json` (with `--customer`)

## Never

- Never fork validate/eval logic into the solution — the solution is data; the
  machine (`operator:*`) stays central.
- Never fabricate pipeline steps — leave them empty until grounded.
- Never claim a solution done without passing `validate-solution` + eval acceptance.

## Quick reference

```bash
npm run operator:configure-solution -- --version <ver> --id <pid> --use-case "…" [--customer <id> --org <workspace id>]
npm run operator:validate-solution  -- --version <ver> --id <pid> [--strict]
```
