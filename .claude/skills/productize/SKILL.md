---
name: productize
description: Advance a product through defined → stamped → lanes_passing → deployed → released. Use when asked to ship, release, package, or check what stands between a mold and a sellable product.
---
# productize

Products live in `state/products.json`. Each has `gates` per stage. To advance:

1. Read the gates for the next stage. For every gate without a matching task, `add` one with `advances_stage` set.
2. Work tasks via the `task` skill. `close` auto-advances the stage once every task marked with that `advances_stage` is done.
3. Never edit `stage` by hand.

Stage meaning: stamped = an app exists and builds. lanes_passing = five lanes pass. deployed = reachable in production with secrets by name and GLM 5.2 live. released = onboarding, docs and cost model done; a customer can be onboarded without the operator.
