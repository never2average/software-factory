---
name: run-lanes
description: Run the five testing lanes (load, context, functional, accessibility, responsiveness) on a stamped application and record results. Use before any deploy or stage advance.
---
# run-lanes

Each lane's README under `molds/<mold_id>/testing/<lane>/` says which commands to run. Run all five, in this order: functional, context, load, accessibility, responsiveness.

For each lane write `testing.<lane> = {status, run_at, report}` into `state/application/<app_id>/application.json`, with the report saved under `molds/<mold_id>/testing/<lane>/reports/<app_id>-<date>.md`.

A lane without a harness yet is `skipped`, never `pass`. Any `fail` sets the application `status` to `reverted` with a `revert` record naming the lane, and control returns to the operator: file a task with the `task` skill and stop.
