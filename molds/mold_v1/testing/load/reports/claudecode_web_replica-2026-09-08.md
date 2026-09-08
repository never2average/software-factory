# Load lane — claudecode_web_replica (2026-09-08)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-08T09:04:54+00:00. Lane status: **skipped** (0 of 2 checks passed, 2 skipped).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane load`

Task-workflow throughput and latency under concurrency, and thread-open latency for a signed-in operator.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:task-workflow:stress` | skipped | No harness yet. The lane needs molds/mold_v1/testing/load/stress.py to bring up a private Postgres (localpg.py up claudecode_web_replica), migrate it, build services/task-workflow in a copy of the mold, run workflow.stre |  |
| `fde:thread-open-perf` | skipped | Skipped on purpose: without a signed-in identity this script measures NOTHING and still exits 0, and unconfigured it defaults to the LIVE fde-agent projects. Give it FDE_OPS_URL and FDE_OPS_TOKEN for this app's own deplo |  |

## Skipped, and what would make them run

- `test:task-workflow:stress` — No harness yet. The lane needs molds/mold_v1/testing/load/stress.py to bring up a private Postgres (localpg.py up claudecode_web_replica), migrate it, build services/task-workflow in a copy of the mold, run workflow.stress.spec.ts against it and print the p50/p95/5xx table. Measured once by hand: 186 ops, p95 262 ms, zero 5xx.
- `fde:thread-open-perf` — Skipped on purpose: without a signed-in identity this script measures NOTHING and still exits 0, and unconfigured it defaults to the LIVE fde-agent projects. Give it FDE_OPS_URL and FDE_OPS_TOKEN for this app's own deployment (names only — the runner never reads the value).

A skipped check is why this lane cannot report `pass`: nothing measured it.

## Not covered by this lane

- GLM 5.2 inference throughput and the sandbox prewarm saturation budget — neither has a harness yet (mold_v1 backlog).
- Sustained soak: the stress spec is a burst, not an hour.
