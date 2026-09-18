# QM gap-closure matrix

This implementation review uses `yc-software/qm` at commit
`7f2c916360f1797a8ff2a77ce2ce40c5fabab087` as the reference architecture.
The goal is to adopt its useful runtime invariants without replacing Eve's
durable sessions, streams, compaction, schedules, or agent runtime.

All 15 gaps identified in the review are closed below. “Closed” means there is
an implementation, a repository test or an explicit architectural disposition,
and an operational path in this change set.

| # | Gap | Resolution | Verification |
|---|---|---|---|
| 1 | Prompt modes could overlap | Root and every subagent now receive exactly one of `direct`, `autonomous`, or `delegated`; the stable contract is assembled before volatile context. | `scripts/test-prompt-context.mjs` |
| 2 | Dynamic context had no independent budgets | Memory, schedules, rooms, roster, profile, configuration, workflow, and operator overrides have separate item/token ceilings. | `scripts/test-prompt-context.mjs` |
| 3 | Recalled data could act like trusted instructions | Context blocks carry source, org, audience, timestamp, provenance, and untrusted-data envelopes. Security-tainted, cross-org, secret-like, and unauthorized-audience records are excluded. | `scripts/test-prompt-context.mjs`, `scripts/test-memory.mjs` |
| 4 | App history could contain dangling tool results or empty interruptions | App-owned history is normalized into valid tool-call/result pairs with deterministic interrupted/empty fallback text. Eve remains the owner of durable compaction and replay. | `scripts/test-prompt-context.mjs` |
| 5 | Prompt assembly lacked measurable boundaries | Instrumentation records mode, stable/volatile token estimates, and compaction reason. | `agent/instrumentation.ts` |
| 6 | Browser records were not strictly tenant/principal scoped | Open, reattach, get, list, close, page, allowlist, credential, and sweep paths require org and principal scope. Persistent contexts are principal-private unless an audited `team` scope is explicit. | `scripts/test-browser-security.mjs` |
| 7 | Browser capability URLs were stored in plaintext | CDP and live-view capabilities are AES-256-GCM sealed with an org-derived, versioned `OPS_SECRETS_KEY`; legacy ephemeral rows are invalidated by the migration. | `agent/lib/browser-capability-crypto.ts`, `scripts/test-browser-security.mjs` |
| 8 | Browser release was database-first and could leak provider sessions | Release is provider-first and idempotent, with `closing`, `release_failed`, retry count/error, and terminal `closed` states. | `agent/lib/browser.ts`, `docs/BROWSER_SESSION_SECURITY.md` |
| 9 | Browser cleanup ran in the wrong service | Cleanup is an Eve schedule in the service that owns Browserbase credentials; the dashboard cron was removed. | `agent/schedules/sweep-browser-sessions.ts` |
| 10 | Browser reattach/output semantics were ambiguous | Provider session IDs are durable; reattach is explicit and never returns a live bearer capability. Cursor output is intentionally not applicable because each browser tool is a bounded request/response operation, not a long-running process stream. | `docs/BROWSER_SESSION_SECURITY.md` |
| 11 | Concurrent workflow resumptions could double-own a run | New/manual and stalled claims are atomic; stalled scans use `FOR UPDATE SKIP LOCKED`; a 75-second lease is renewed by a 20-second heartbeat. | `scripts/test-workflow-leases.mjs` |
| 12 | Journal entries could be overwritten across retries | The journal key is `(run_id, attempt, call_index)` and writes are guarded by the active lease token. Completed prior-attempt calls are replayable. | `scripts/test-workflow-leases.mjs` |
| 13 | Cancellation was not durable or propagated | Runs persist requester, reason, request time, and terminal cancel time. Active QuickJS work receives an `AbortSignal`; parent and child Eve sessions are cancelled together. | `scripts/test-workflow-leases.mjs` |
| 14 | Stream continuation depended on process memory | Reconnect uses Eve's durable `startIndex` cursor rather than an in-memory stream position. | `lib/workflow-delegate.ts`, `scripts/test-workflow-leases.mjs` |
| 15 | Operators could not see or control ownership | Run APIs and UI expose org, worker, lease expiry, heartbeat, attempt, and cancellation state, with a guarded cancel action. | `app/_components/ops/run-timeline.tsx`, `app/_components/ops/workflows-panel.tsx` |

## Task-workflow functionality delivered with the hardening

The task workflow is a separately deployed durable service under
`services/task-workflow`. Definitions are immutable-versioned, every task pins
its workflow version and stage, transitions are idempotent and append-only, and
transition-specific stage automation cannot race an unrelated transition.
Dashboard routes are thin authenticated adapters to that service.

The Playwright stress suite drives concurrent task creation, transition,
idempotency, automation, and cleanup through public HTTP boundaries. See
`docs/TASK_WORKFLOW_STRESS.md`. The Makefile serializes workflow, Eve API, and
dashboard production deployments and then checks all three health endpoints.

## Reference patterns adapted

- [QM orchestrator and stable prompt assembly](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/core/orchestrator.ts)
- [QM bounded prompt blocks](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/core/orchestrator/prompt-blocks.ts)
- [QM context filtering](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/resolution/context-filter.ts)
- [QM context compaction invariants](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/harness/context-compaction.ts)
- [QM browser session store](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/connectors/browser-session-store.ts)
- [QM process-session lifecycle](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/sandbox/exec-process-session.ts)
- [QM Postgres run leases and ledgers](https://github.com/yc-software/qm/blob/7f2c916360f1797a8ff2a77ce2ce40c5fabab087/src/runs/postgres-run-store.ts)
