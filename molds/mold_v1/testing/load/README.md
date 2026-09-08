# Load

Existing: `codebase/tests/task-workflow-stress/workflow.stress.spec.ts` (`npm run test:task-workflow:stress`), `codebase/docs/TASK_WORKFLOW_STRESS.md`, `scripts/fde/thread-open-perf.mjs`.
To add: concurrent multi-workspace chat load, sandbox prewarm saturation, GLM 5.2 throughput/latency budget.

## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane load

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`), which is also
where you add one. The runner writes `testing.load` into the application and the report into
`reports/<app_id>-<date>.md`. A check whose precondition is unmet is `skipped` with the sentence
saying what would make it run — the lane can then never be `pass`, only `skipped`.
