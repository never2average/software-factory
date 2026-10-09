# Load

What an operator feels when several people drive the same workspace at once: how long a task
transition takes, how many go through per second, whether any of them errors, and whether the
transition journal that the multiplayer UI reads back is still complete afterwards.

## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane load

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`). The runner
writes `testing.load` into the application and the report into `reports/<app_id>-<stamp>.md`. A
check whose precondition is unmet is `skipped` with the sentence saying what would make it run —
the lane can then never be `pass`, only `skipped`.

One check, one harness: [`stress.py`](stress.py). By hand, with no state written and no lane report:

    python3 molds/mold_v1/testing/load/stress.py <app_id>
    python3 molds/mold_v1/testing/load/stress.py <app_id> --iterations 48 --concurrency 16
    python3 molds/mold_v1/testing/load/stress.py <app_id> --p95-ms 1     # see a budget fail

It takes about two minutes and prints a markdown table. Exit 0 = every row passed.

## What it actually does

The scenario is the mold's own: `codebase/tests/task-workflow-stress/workflow.stress.spec.ts`
(`npm run test:task-workflow:stress`, documented in `codebase/docs/TASK_WORKFLOW_STRESS.md`). It
drives 24 task lifecycles at concurrency 8 — create, `backlog → open → in_progress → done`, with
`blocked` on every third task — replays an idempotency key, reads each transition journal, lists,
and deletes everything it made. It is run exactly as the mold wrote it, not re-implemented.

`stress.py` supplies what the spec cannot: a service to run against, and a verdict.

1. Copies the mold snapshot to a temporary directory (the snapshot is immutable; this run writes
   `.env.local`, a service `node_modules`, a `.next` build and playwright's `test-results/`) and
   bind-mounts the mold's own `node_modules` read-only.
2. Brings up a **throwaway** Postgres, `<app_id>__loadlane` — never the app's own `<app_id>`
   database — through `.claude/scripts/lib/localpg.py`: private docker network, no host port, TLS
   required.
3. Runs the mold's real chain against it, in the mold's documented order: `drizzle-kit push`, then
   `.bootstrap-supabase.mjs` (row-level security + the `app_rw` NOBYPASSRLS role), then
   `.migrate-task-workflow-service.mjs`. The service therefore talks to the same schema, the same
   policies and the same role as the deployed app, so the latency includes the cost of RLS.
4. `npm ci` and `next build` for `services/task-workflow`, then starts it. Nothing is published:
   there is no `-p` anywhere in this lane.
5. Runs the spec, up to three times, and prints the table.

### Why the test runner joins the service's network namespace

The spec has its own guard, `assertSafeTarget`, that refuses to mutate any target that is not
`localhost`/`127.0.0.1`/`::1` unless `TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION=1`. Reaching the
service by a docker hostname would have meant setting that variable — teaching the lane to say yes
to production in order to run a purely local test. Instead the runner container joins the service
container's own network namespace (`--network container:<svc>`), so the target genuinely *is* a
loopback address, the guard stays armed, and that variable is never set here.

### Why one literal `127.0.0.1`, and why the health row uses the scenario's own HTTP client

The first cut of this harness sent the spec to `http://localhost:3000` and probed health at
`http://127.0.0.1:3000` with node's `fetch`. Two addresses, two clients, and a gate that reverts an
application failing about one run in eight on its own plumbing:

    $ docker exec <svc> node -e "dns.lookup('localhost',{all:true},...); connect ::1; connect 127.0.0.1"
    lookup all      : [{"address":"::1","family":6},{"address":"127.0.0.1","family":4}]
    lookup default  : ::1 family 6
    connect ::1        -> ECONNREFUSED
    connect 127.0.0.1  -> ok

`localhost` resolves `::1` first inside `node:24-bookworm-slim`, and `next start -H 0.0.0.0` listens
on IPv4 only. Node's own `fetch` survives that by Happy Eyeballs; Playwright's request transport
does not, and died on `connect ECONNREFUSED ::1:3000` against a service the health row had just
graded `pass` — because the health row was asking a different address.

Two changes, no check weakened:

* `BASE_URL` is one literal `http://127.0.0.1:3000`, used by the readiness probe, by the
  `service.health` row and by the spec. There is no name to resolve, so there is nothing to resolve
  differently. `assertSafeTarget` accepts `127.0.0.1` exactly as it accepts `localhost`, so the
  guard is still armed and `TASK_WORKFLOW_STRESS_ALLOW_PRODUCTION` is still never set. *Not* a
  dual-stack `-H ::` instead: binding `::` fails outright wherever IPv6 is disabled in the
  container's network namespace, which would trade an intermittent failure for a permanent one.
* `service.health` is confirmed with **@playwright/test's own request context**, at that same URL,
  from a container in the service's network namespace — the identical transport, address and
  network position the scenario will use. A row claiming "the service is reachable" has to be
  measured with the client whose reachability it is claiming.

### When a run produces no numbers, the report says which of three things happened

A lane failure reverts the application, so "the spec did not produce a summary" is not an
acceptable answer: the spec throws before its summary line for *any* failure, so a workflow defect
and a broken network looked identical. They are now told apart, each in one sentence with no stack
trace and no call log, by re-probing health the moment the scenario fails:

| what happened | what the operator is told | verdict |
|---|---|---|
| the service answered and the scenario's own assertions or an HTTP status stopped it | "the stress scenario reached the service and failed one of the mold's own workflow assertions. That is an application defect: *&lt;the one error line&gt;*" | `stress.invariants` **fail** — a real defect, revert |
| the service stopped answering during the run | "the task-workflow service stopped answering DURING the run — it did not survive the load. That is an application defect" | rows stay `unmeasured` — lane fails |
| the scenario could not connect, and the service still answers its health check over the scenario's own client | "…could not reach the task-workflow service … Nothing about the application was measured, so no row can pass; this is a problem with this machine, not with the application" | retried; if it never connects, rows stay `unmeasured` — lane fails, and the report says why it is not the app's fault |

The third case still fails the lane. Nothing measured cannot become a pass, and this lane will not
invent a verdict for a run that produced none — but the operator gets one instruction (run the
lane again on this machine) instead of a Playwright call log.

Secret values (the generated `app_rw` URL, the per-run service token) reach the containers through
a 0600 `--env-file` inside a 0700 scratch directory — never on a `docker run` argv, where `ps`
could read them — and are never printed. Every container, volume, network, the scratch tree and the
`infra/vm/apps/<app_id>__loadlane/` directory `localpg` creates are removed in a `finally`.

## The rows, and the budgets

Eight rows. **Every one starts `unmeasured`.** Only a measurement that executed can move a row, and
any row still `unmeasured` when the table is printed fails the lane — the harness exits 1 and
`lane.json` additionally asserts `stdout_not: ["\\| unmeasured \\|"]`, so an exit code of 0 cannot get
a vacuous row past the runner either. This is deliberate: the sibling responsiveness lane shipped a
route that never rendered and graded `pass` on its zero violations, and only adversarial review
caught it.

| row | budget | why this number |
|---|---|---|
| `service.health` | 200, `ok=true`, `service=task-workflow` | An HTTP 200 from something else is not this service. Probed at the same URL, with the same HTTP client, from the same network position as the scenario (see above), so this row cannot pass while the scenario cannot connect. It also prints the DB role, which must read `app_rw` — a run as a BYPASSRLS superuser would be measuring a database the app never talks to. |
| `stress.executed` | ≥ 186 operations for 24 iterations | A lower bound computed from the spec's own lifecycle (1 health + 24 creates + 112 transitions incl. replays + 24 journal reads + 1 list + 24 deletes). A fast run that quietly did less work than it declared is not a pass. |
| `stress.status` | 0 responses ≥ 400 | Not a budget with headroom and never re-measured: an error is a defect, not jitter. |
| `stress.p95` | ≤ 1000 ms | Calibrated on this harness, on this VM: 19 runs (18 through `lanes.py`, one direct on a cold page cache) measured p95 between **288 and 710 ms**, median about 322 — the spread is real and it is quoted rather than tidied. 1000 ms is 1.4× the worst of them and ~3× the median, and still under the mold's own published production p95 of 1089 ms (`docs/TASK_WORKFLOW_STRESS.md`, 2026-08-01): this configuration has no internet hop and no cold start, so the lane must never pass something slower than the deployment it models. The headroom is not padded beyond that, because a single slow run is re-measured (median of up to three attempts) while a lost index, a per-request connection or an N+1 moves the median and fails immediately. |
| `stress.throughput` | ≥ 2.0 lifecycles/s | The published production figure is 1.87/s over the public internet. Those same 19 runs measured 4.35–6.85/s, so 2.0 fires on a structural collapse, not on a slow minute. |
| `stress.invariants` | the spec's assertions pass | Transition-event ordering and uniqueness, one event per idempotency key with no duplicate on replay, terminal `done` + `automationState: idle`. |
| `stress.residue` | 0 tasks, 0 workflow instances left | Counted in the database afterwards, not believed from the spec's `finally` block, which swallows its own cleanup errors. |
| `stress.journal` | 112 transition events for the run of record | The opposite measurement: `engine.ts` deletes the task and **keeps** its journal on purpose ("append-only and OUTLIVES the row it describes"), so the journal must still hold every event the run wrote. Counted as a **delta** across the attempt that becomes the run of record (rows counted before it and after it), not as a total, so a retry cannot inflate or deflate it. Grading those as residue would fail a correct service; not counting them at all would miss a journal that loses rows under concurrency. |

A **timing** row (`stress.p95`, `stress.throughput`) may be re-measured up to three times, and the
attempt that counts is the **median** p95 — on an even number of attempts, the worse of the two
middle ones. Every sample is printed under the table and the row names the attempt it used.
Reverting an application in front of a non-technical operator must not fire on VM jitter, and a
median needs a majority of attempts inside the budget; the first cut of this harness kept the *best*
p95 of three, which is shopping for a greener number and would have let one lucky run in three carry
a service that typically misses. An error status or a failed assertion stops the loop immediately —
those are not jitter, and they are not re-rolled.

## Not covered

Printed verbatim into every report from `lane.json`. The one that needs explaining:

### `operator:thread-open-perf` — not covered, and why it is not merely "skipped"

`codebase/scripts/operator/thread-open-perf.mjs` is a good script: it separates the Ops gate, the Next
rewrite hop, the eve stream and the shared-thread membership proxy, and it reports *why* a replay
stopped. This lane cannot run it, and says so rather than carrying it as a permanently skipped row.

Three facts, each verifiable in the mold:

* **It needs a human.** `lib/ops-auth.ts` admits exactly two identities — a Google ID token for an
  `@onfinance.in` Workspace account, or an ES256 token minted after a sign-in code is emailed — and
  states the rule outright: *"There is deliberately no shared service key: every caller is a real,
  named human."* Both are obtained interactively and last about an hour. No factory script can mint
  one for a stamped app, and `HOW_TO_GET_A_TOKEN` in that script tells you to open a browser console
  and `copy(localStorage.getItem("workspace-google-token"))` — not an instruction this factory gives a
  non-technical operator.
* **The precondition guarded a name the code has never heard of.** The check used to be declared
  with an `env` precondition on an ops-token variable. A `grep -rn` for that name in molds/mold_v1/codebase
  returns nothing (exit 1): the script reads `--token`, `--token-file` or `WORKSPACE_GOOGLE_TOKEN`. So
  exporting that variable would have *satisfied* the precondition and run the script with no token at all —
  which prints "No token — baseline only" and `process.exit(0)`, and the runner would have recorded
  `pass` for a check that measured no thread open whatsoever.
* **Unconfigured, it points at the live projects.** `FRONT` defaults to
  the live web project's address and `AGENT` to the live API project's. Without
  `WORKSPACE_OPS_URL` and `NEXT_PUBLIC_EVE_API_URL`, that vacuous `pass` would have been measured against
  a different application than the one under test.

The lane README's own rule settles it: *a row that could never run is `not-covered`, not `skipped`* —
`skipped` is what must stop a lane reading `pass`, and a permanent, declared gap should not borrow
that word. The check is therefore out of `checks` and written into `not_covered`, so every load
report states the gap instead of implying it was measured.

**What would make it measurable**, for whoever picks this up:

1. The stamped app needs a sign-in the factory can drive without a browser. The mold already has the
   pieces — `lib/auth-session.ts` mints an ES256 email-session token that `verifyOpsAuth` accepts —
   but nothing exposes a way to mint one for a named operator address from a script, and adding one
   is a change to `codebase/`, i.e. a mold refresh from source per `MOLD.md`, not a lane edit.
2. `stress.py`'s sibling would then set `WORKSPACE_OPS_URL` and `NEXT_PUBLIC_EVE_API_URL` to *this app's*
   `infrastructure.vercel.production_url`, pass the token as `--token-file` (never as an argv or a
   lane-stored value), and require at least one owned thread with an `eveSessionId` — the script
   measures nothing without one, and "no thread to measure" must be an `unmeasured` row, not a pass.
3. Only then does a budget make sense. Do not copy one from anywhere: the script's own output names
   the phases, and a budget must be cut from measurements of the deployment it will judge.

Until all three exist, this lane measures the task-workflow engine and states plainly that it does
not measure thread open.

## Reports

`reports/<app_id>-<stamp>.md`, written once and left read-only by the runner; `--dry-run` writes to
`reports/dry/`. The table above is inlined verbatim under "Measured rows", and every attempt's
samples come with it.
