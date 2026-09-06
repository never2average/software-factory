---
name: configure-agents
description: Scaffold a reusable agent solution under Solutions/{ver}/agents/{id}/ — the agents sibling of configure-solution — with its data schema, run-config contract, recipe + recipe seed folder, and eval dataset/benchmark. Use when authoring a new agent solution, when someone says "configure an agent", "create an agent solution", "add an agent recipe", or when a customer needs an agent instance seeded into their deployment. Agents are solutions too: same validate + eval gate. Optionally registers the customer's solutions row and seeds the Deployments agent recipe folder.
---

# Configure agents

Agents are the **other kind of solution** — `Solutions/{ver}/agents/{id}/` sits
parallel to `pipelines/`, with the same "minified solution-manager" discipline but an
agent-shaped file set: a data-platform schema, a run-config contract, a `recipe.md`
(+ `recipe/` seed folder the agent instantiates before its first run), and eval
`dataset.jsonl` / `benchmark.jsonl`. Same eval gate as pipelines. See
[`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md) and the `configure-solution`
skill for the shared philosophy (central machine, self-describing instances).

## Steps

**1. Scaffold.**
```bash
npm run fde:configure-agents -- --version v2.4.0 --id collections-agent \
  --use-case "Autonomous collections triage"
```
Writes `dataplatform.schemas.json`, `run_configs.schema.json`, `recipe.md`,
`recipe/README.md`, and empty `evals/{dataset,benchmark}.jsonl` under
`Solutions/v2.4.0/agents/collections-agent/` (never clobbers authored files).

**2. Author.** Fill `recipe.md` (role, tools, guardrails), define
`run_configs.schema.json` (the contract), put the seed files the agent needs in
`recipe/`, and seed `evals/dataset.jsonl` (cases) + `evals/benchmark.jsonl`
(targets). Eval runs land under `evals/{run_id}/`.

**3. Register + seed a customer (optional).**
```bash
npm run fde:configure-agents -- --version v2.4.0 --id collections-agent \
  --use-case "…" --customer contoso-bank
```
Upserts the `solutions` row (marked as an agent) and seeds
`Deployments/{customer}/{ver}/platform/agents/{id}/recipe.md`.

**4. Gate.**
```bash
npm run fde:validate-solution -- --version v2.4.0 --id collections-agent --kind agent --strict
```

## Where this reads / writes

WRITE:
- `Solutions/{ver}/agents/{id}/{dataplatform.schemas.json, run_configs.schema.json, recipe.md, recipe/…, evals/dataset.jsonl, evals/benchmark.jsonl}`
- `solutions` row + `Deployments/{customer}/{ver}/platform/agents/{id}/recipe.md` (with `--customer`)

## Never

- Never ship an agent without seeded evals — the gate is eval-based; an ungated
  agent is not done.
- Never fabricate guardrails or tool access — leave `TODO` until decided.

## Quick reference

```bash
npm run fde:configure-agents   -- --version <ver> --id <agent> --use-case "…" [--customer <id>]
npm run fde:validate-solution  -- --version <ver> --id <agent> --kind agent [--strict]
```
