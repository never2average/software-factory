---
name: productize
description: Advance a product through defined → stamped → lanes_passing → deployed → released. Use when asked to ship, release, package, or check what stands between a mold and a sellable product.
---
# productize

Products live in `state/products.json` (what a product is: `docs/PRODUCTS.md`). Each has `gates` per stage. To advance:

1. Read the gates for the next stage. For every gate without a matching task, `add` one with `advances_stage` set.
2. Work tasks via the `task` skill. `close` auto-advances the stage once every task marked with that `advances_stage` is done.
3. Never edit `stage` by hand. Never edit a gate to make it pass; edit it only when it names something that is no longer true, and say so in the commit.

Stage meaning: stamped = an app exists and builds. lanes_passing = five lanes pass. deployed = reachable in production with secrets by name and GLM 5.2 live. released = onboarding, docs and cost model done; a customer can be onboarded without the operator.

## The `released` deliverables (mold_v1-012)

Documentation, not mold code. Each file must match the scripts as they are — a runbook that names a flag that does not exist is worse than none, so read `.claude/scripts/*.py` docstrings before touching them.

| Deliverable | File | Test |
|---|---|---|
| Onboarding runbook | `docs/RUNBOOK.md` | every command in it exists; the four credentials it asks for are the ones `intake.py` puts in `secrets_user` |
| Packaging | `docs/PRODUCTS.md` | matches `state/products.json` and `products.schema.json`; stage-gate text in the JSON is currently true |
| Cost model | `docs/COST_MODEL.md` | every number is measured, fetched with a URL and date, or marked `PLACEHOLDER`; nothing invented |

The `product-packager` agent owns these; `WebFetch` is for prices, never for secrets.
