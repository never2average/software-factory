# Task workflow stress test

The Playwright API test in `tests/task-workflow-stress/workflow.stress.spec.ts`
creates isolated tasks, drives their complete workflow concurrently, verifies the
transition journal and terminal state, and deletes every task it created.

## Coverage

- service and database health
- concurrent task creation
- `backlog -> open -> in_progress -> done`
- `in_progress -> blocked -> in_progress` on every third task
- duplicate idempotency-key replay without duplicate events
- transition-event ordering and uniqueness
- terminal `done` and `automationState: idle` invariants
- HTTP status counts, throughput, and p50/p95/p99 latency
- best-effort cleanup in a `finally` block

## Run locally

```sh
TASK_WORKFLOW_STRESS_BASE_URL=http://localhost:3001 \
TASK_WORKFLOW_SERVICE_TOKEN=local-secret \
TASK_WORKFLOW_STRESS_ORG_ID=org-onfinance-ai \
make stress-task-workflow
```

## Run against production

Non-local mutation is refused unless it is explicitly enabled:

```sh
TASK_WORKFLOW_SERVICE_URL=https://fde-task-workflow.vercel.app \
TASK_WORKFLOW_SERVICE_TOKEN='...' \
TASK_WORKFLOW_STRESS_ORG_ID=org-onfinance-ai \
TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION=1 \
TASK_WORKFLOW_STRESS_ITERATIONS=24 \
TASK_WORKFLOW_STRESS_CONCURRENCY=8 \
make stress-task-workflow
```

Optional `TASK_WORKFLOW_STRESS_P95_MS` sets the latency ceiling and defaults to
8,000 ms. Iterations are capped at 200 and concurrency at 50.

Playwright writes the machine-readable summary as the test attachment
`task-workflow-stress-summary.json` under `test-results/task-workflow-stress/`.

## Production baseline

On 2026-08-01, a 24-task, eight-worker run completed 186 API operations in 12.9
seconds. It produced zero 5xx responses, 1.87 task lifecycles/second, 346 ms p50,
1,089 ms p95, 1,992 ms p99, and 2,056 ms maximum latency. A separate post-run
query confirmed zero generated tasks remained.
