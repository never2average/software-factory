# software-factory

Read `docs/HOW_IT_WORKS.md` first. Questions the intake asks: `docs/INTAKE.md`.

Factory 1: an operator (Fable + sol) services molds through a fixed surface and stamps applications from them. Failed applications revert to the operator.

```
Fable + sol --service--> [dm.md, browser(o/o), web search(o/o), primary_context,
    ^                     multiplayer_context, custom workflow builder] --> mold 1 (active)
    |                                                                  --> mold 2 (WIP)
    +------------------------- revert ------------------------------+  --> mold 3 (WIP)
```

## Layout

- `state/` — `factory.schema.json` + `factory.json` (Factory 1 instance); per-application schemas under `state/application/<app_id>/`
- `molds/` — `mold_v1` (active, snapshot of fde-agent), `mold_v2`, `mold_v3` (WIP). Each has a `MOLD.md`; `mold_v1/testing/` holds the five test lanes
- `infra/` — deployment targets: `vercel/` (app + eve functions), `vm/` (DigitalOcean droplet)
- `.claude/`, `.agents/` — agents, skills, scripts, workflows, sandboxes for Claude Code and other agent runtimes

## Describe → deploy

```
python3 .claude/scripts/intake.py briefs/<app>.md --app <app> [--ask]   # brief -> state, asks only unresolved questions
python3 .claude/scripts/provision.py <app>                              # check secrets by name, scaffold target
python3 .claude/scripts/provision.py <app> --deploy                     # deploy to vercel or the VM
```

Subagents `intake` and `provisioner` run the same two scripts and ask the user through the harness. Questions and their resolution rules: `docs/INTAKE.md`.

## Tasking

Every mold has a product (`state/products.json`) and a backlog (`state/tasks/<mold_id>.jsonl`). The operator works the backlog; closing tasks advances the product through defined → stamped → lanes_passing → deployed → released.

```
python3 .claude/scripts/factory.py status        # products, stages, task counts
python3 .claude/scripts/factory.py next mold_v1  # what to do now
python3 .claude/scripts/factory.py validate      # all state files
```

Skills: `task`, `stamp`, `run-lanes`, `productize`. Agents: `mold-engineer`, `lane-tester`, `product-packager`. Workflows: `stamp-and-test`, `mold-fork`.

## Molds

| Mold | Product | Status | Definition |
|---|---|---|---|
| mold_v1 | claudecode_web | active | multi-workspace multi-agent Claude Code web at feature parity, vanilla, GLM 5.2 |
| mold_v2 | claudecode_web_governed | wip | + agent governance, pipeline-level data isolation, budget management, performance governor |
| mold_v3 | claudecode_web_research | wip | + autoresearch and SAI, multi-context + multi-role isolation per workflow |

## Working here

All commands run on the DigitalOcean VM (`ssh digitalocean`), repo at `/root/software-factory`. Refresh the mold snapshot per `molds/mold_v1/MOLD.md`.
