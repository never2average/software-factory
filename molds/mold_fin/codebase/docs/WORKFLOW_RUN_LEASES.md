# Workflow run ownership

Workflow-script executions use a database lease so only one request may drive a
run at a time. Every execution epoch has a fresh `lease_token`, `worker_id`, and
`attempt`; heartbeats extend `lease_expires_at`. Completion, failure, release,
and journal writes are ignored unless the caller still owns that token.

The continuation cron claims eligible rows in one PostgreSQL statement using
`FOR UPDATE SKIP LOCKED`. A timed-out execution releases its lease while leaving
the run `running`; an abandoned execution becomes claimable when its lease
expires. Runs that exhaust the configured attempt cap become terminal `failed`
instead of remaining ownerless and apparently live. Completed journal calls
from prior attempts replay, but new writes land in the new
`(run_id, attempt, call_index)` epoch.

## Cancellation

Authenticated operators request cancellation with:

```http
POST /api/ops/workflow-runs/:runId/cancel
Content-Type: application/json

{"reason":"No longer needed"}
```

The request is persisted before the route signals every known Eve parent/child
session through Eve's cancel endpoint. The active lease holder sees the request
on its next heartbeat, aborts QuickJS and outstanding delegation fetches, and
records `cancelled`. A racing completion cannot win: the terminal update turns
any run with `cancel_requested_at` into `cancelled` atomically.

Eve remains the stream source of truth. Delegates reconnect to the same durable
session with `?startIndex=<consumed-event-count>` and observe
`turn.cancelled` followed by `session.waiting`; no process-local replacement
stream is used.

## Configuration

- `WORKFLOW_RUN_LEASE_MS` — lease lifetime; default 75 seconds, minimum 30.
- `WORKFLOW_RUN_HEARTBEAT_MS` — renewal/cancellation poll; default 20 seconds,
  minimum 5 and capped at half the lease lifetime.

Defaults are safe for deployment; the variables are optional.

## Migration requirements

Before adding `NOT NULL`, backfill existing `workflow_runs.org_id` and
`workflow_run_journal.org_id` to `org-onfinance`. Add the lease, heartbeat, and
cancellation columns from `agent/lib/db/schema.ts`. For the journal:

1. add `attempt integer NOT NULL DEFAULT 1` and
   `lease_token text NOT NULL DEFAULT 'legacy'`;
2. replace the primary key `(run_id, call_index)` with
   `(run_id, attempt, call_index)`;
3. add `workflow_run_journal_run_call_idx` and `workflow_runs_lease_idx`.

The application and migration must deploy together because journal upserts use
the new primary-key conflict target.
