---
name: configure-solution
description: Scaffold a reusable pipeline solution as a self-describing "minified solution-manager" under Solutions/{ver}/pipelines/{id}/ — its contract (run_configs + integromat schemas), its artifact (pipeline_config.json), gated by evals not PRs. Use when authoring a new pipeline solution, when someone says "configure a solution", "create a pipeline", "add a solution", or when a customer needs a pipeline instance seeded into their deployment. Optionally registers the customer's solutions row and seeds the Deployments instance from the recipe. Its sibling for agents is the configure-agents skill.
---

# Configure solution (pipeline)

A configured solution is a **self-contained, independently versionable, eval-gated
unit** — a *minified solution-manager*. The key idea: the "solution-manager" is the
central machine (these `fde:*` scripts); each solution is the **data** that machine
runs — a schema (contract) + a config (artifact) + evals (the gate) + migrations
(change history) + grounding. Don't fork the machine into each solution; keep it
central and make each solution self-describing.

This maps `OnFinance/solution-manager` onto your data model:
`pipeline.schema.json` → `run_configs.schema.json`; `solution.json` →
`pipeline_config.json`; the PR gate → **eval acceptance + the deployment signoff**,
not git. See [`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md).

## Steps

**1. Scaffold the instance.**
```bash
npm run fde:configure-solution -- --version v2.4.0 --id pl-collections \
  --use-case "Collections triage"
```
Writes the contract (`run_configs.schema.json`, `integromat.schema.json`) and the
artifact (`pipeline_config.json`) under `Solutions/v2.4.0/pipelines/pl-collections/`
(never clobbers authored files).

**2. Author it.** Define `run_configs.schema.json` (the contract, bound to the
platform version's `pipeline_config` design decision), then fill
`pipeline_config.json`'s `steps`. Ground the design in
`background_research/{person_id}/` and record changes as
`migrations/{migration_id}/`. Evals live under `evals/{run_id}/`.

**3. Register + seed a customer (optional).**
```bash
npm run fde:configure-solution -- --version v2.4.0 --id pl-collections \
  --use-case "Collections triage" --customer contoso-bank
```
Upserts the `solutions` row and seeds
`Deployments/{customer}/{ver}/platform/pipelines/{id}/pipeline_config.json` (the
dm.md recipe seam — the deployment instance).

**4. Gate it.**
```bash
npm run fde:validate-solution -- --version v2.4.0 --id pl-collections --strict
```

## Where this reads / writes

WRITE:
- `Solutions/{ver}/pipelines/{id}/{run_configs.schema.json, integromat.schema.json, pipeline_config.json}`
- `solutions` row + `Deployments/{customer}/{ver}/platform/pipelines/{id}/pipeline_config.json` (with `--customer`)

## Never

- Never fork validate/eval logic into the solution — the solution is data; the
  machine (`fde:*`) stays central.
- Never fabricate pipeline steps — leave them empty until grounded.
- Never claim a solution done without passing `validate-solution` + eval acceptance.

## Quick reference

```bash
npm run fde:configure-solution -- --version <ver> --id <pid> --use-case "…" [--customer <id>]
npm run fde:validate-solution  -- --version <ver> --id <pid> [--strict]
```
