# Functional lane — onfinance_hfc_vm (2026-10-04T155707Z)

Mold: mold_v1 (commit 1f43117a5eb687b52fdf3b7a1d0352d3761f03b3).
Run at 2026-10-04T15:57:07+00:00. Lane status: **fail** (26 of 27 checks passed, 1 failed).
Command: `python3 .claude/scripts/lanes.py onfinance_hfc_vm`
This file: `molds/mold_v1/testing/functional/reports/onfinance_hfc_vm-2026-10-04T155707Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

Feature-parity of the mold's own surface: data room, syncs, alerts, schedules, rendering, system of record, chat persistence, gates, and the tenant-isolation rows that cannot be satisfied by a status code.

**The run stopped here.** context, load, accessibility, responsiveness did not run: this lane failed, which reverts onfinance_hfc_vm, and the suite is a gate. `testing.{context, load, accessibility, responsiveness}` was therefore reset to `pending` in `state/application/onfinance_hfc_vm/application.json` — an earlier run's verdict for a lane this run never reached is not a result, and must not read as one.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:dataroom` | pass | exit 0 | iles) verify ok (jsonl lines durable across separate process invocations) dataroom-store round-trip ok (local backend, 3 separate processes) |
| `test:syncs` | pass | exit 0 | ble across process exit; second ingest appended to 4) syncs ingestion round-trip ok (local backend, JSON-fallback SoR, 2 separate processes) |
| `test:alerts` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-alerts.mjs test-alerts: all assertions passed (fallback path, no Postgres). |
| `test:schedules` | pass | exit 0 | p-types --disable-warning=ExperimentalWarning scripts/test-schedules.mjs test-schedules: all assertions passed (fallback path, no Postgres). |
| `test:cron-match` | pass | exit 0 | p-types --disable-warning=ExperimentalWarning scripts/test-cron-match.mjs test-cron-match: all assertions passed (offline, no dependencies). |
| `test:workbook-spec` | pass | exit 0 | --disable-warning=ExperimentalWarning scripts/test-workbook-spec.mjs test-workbook-spec: all assertions passed (fallback path, no Postgres). |
| `test:render` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-render.mjs test-render: all assertions passed (fallback path, no Postgres). |
| `test:sor` | pass | exit 0 | > node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-system-of-record.mjs system-of-record fallback tests ok |
| `test:custom-fields` | pass | exit 0 |  > node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-custom-fields.mjs custom-fields: all assertions passed |
| `test:browser-security` | pass | exit 0 | rity > node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-browser-security.mjs browser security tests passed |
| `test:workflow-leases` | pass | exit 0 | > fde-agent@0.0.0 test:workflow-leases > node scripts/test-workflow-leases.mjs workflow lease contract: 18/18 checks passed |
| `test:workflow-args` | pass | exit 0 | > fde-agent@0.0.0 test:workflow-args > node --experimental-strip-types scripts/test-workflow-args.mjs workflow args: 14/14 checks passed |
| `test:chat-persistence` | pass | exit 0 | ad — and refuses (503) rather than failing open ok the gate's ceiling is not the narrowest on the path chat reliability: 47/47 checks passed |
| `test:chat-turn-state` | pass | exit 0 | pty id is ignored ok it is the inverse of withRequestIds ok the original is never mutated chat turn state: 104/104 behavioural checks passed |
| `test:chat-attachments` | pass | exit 0 | the reader still sees exactly their own words ok …and still no path leaks into the bubble chat attachments + directives: 42/42 checks passed |
| `test:email-signin` | pass | exit 0 | in > node --conditions=react-server --experimental-strip-types scripts/test-email-signin.mjs email sign-in + membership: 40/40 checks passed |
| `test:step-context` | pass | exit 0 | est:step-context > node --conditions=react-server --experimental-strip-types scripts/test-step-context.mjs step context: 28/28 checks passed |
| `check:gates` | pass | exit 0 | ater sync ok the local chat cache is keyed by workspace gate lockstep: 19/19 source checks passed (run with --live to also probe production) |
| `check-subagents.self-test` | pass | exit 0 | amed legacy subagent is held to the standard ok an empty scope still fails on a stale registry check-subagents self-test: 50/50 cases passed |
| `check:subagent-shared` | pass | exit 0 | > fde-agent@0.0.0 check:subagent-shared > node scripts/sync-subagent-shared.mjs --check subagent-shared: 1 family, every copy matches |
| `check:subagents` | pass | exit 0 | ecks passed, 0 failed, 0 warnings) PASS lodr-filings (180 checks passed, 0 failed, 0 warnings) 4 subagent(s) checked, 0 failing; registry ok |
| `check:tenancy` | pass | exit 0 | in scope: 30 · pending: 0 service files : 6 · in scope: 6 · pending: 0 ✓ all three projects read tenant data only inside a workspace's scope |
| `test:cards` | fail | exit 1, expected 0 | .spec.ts:9:1 › streaming content does not blow React update depth [2m──[22m[39m [33m 1 skipped[39m [32m 10 passed[39m[2m (1.8m)[22m |
| `rls` | pass | exit 0 | obe_table":"account_summaries"," / / rls.health / pass / {"ok": true, "detail": "SELECT 1 ok \u00b7 role app_rw (RLS enforced)", "ms": 16} / |
| `signin.google` | pass | exit 0 | signin.google: pass — the served bundle carries a Google web client id (22 chunk(s) scanned) |
| `chat.turn` | pass | exit 0 | d it; reasoning events: yes MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins) |
| `tool.python` | pass | exit 0 | d the computed line, in 24s MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins) |

## Failures

### `test:cards` — exit 1, expected 0
The card and stickloop Playwright specs are the only browser-level functional coverage in the mold. Its Playwright webServer is `next dev`, which rewrites next-env.d.ts to point at .next/dev/ and writes .next/ into the snapshot; the wrapper puts the file back and removes .next/ (a clean clone has none at all) and Playwright's test-results/, with the test's own exit status, so the snapshot stays byte-identical to its source commit (MOLD.md). The test itself runs under `timeout -k 30 840`, below this check's timeout_s: lanes.py kills the whole shell on timeout_s, so the cleanup tail would otherwise never run; the inner timeout exits 124 (a fail) and leaves the shell alive. That inner timeout kills npm and Playwright but not the `next dev` webServer Playwright spawns detached in its own session, which would otherwise stay on 127.0.0.1:3000, re-create .next/ seconds after the rm, and be adopted by the next run (playwright.config.ts has reuseExistingServer: true), so before cleaning up the wrapper kills it explicitly: by argv keyed on this snapshot's own node_modules/.bin/next path (the unexpanded `$PWD` in the wrapper's argv means pkill cannot match the wrapper itself; a bare `pkill -f 'next dev'` would), then by the loopback port as a backstop, TERM then KILL. The port backstop is NOT unconditional: it kills a 3000/tcp listener only when that process's cwd (/proc/<pid>/cwd) is this snapshot directory, which is where Playwright starts its webServer; an operator's own dev server on the same port, started elsewhere, would be adopted by that run (reuseExistingServer: true) and its result is then not the mold's — but it is left running, never killed by this wrapper. On a clean pass Playwright has already stopped the server and all kills are no-ops. The inner timeout also leaves chromium's /tmp/playwright_chromiumdev_profile-* behind (a killed browser never removes its profile), so the wrapper removes the ones created after its own start (-newer the mktemp file), and none from any other run.

`t=$(mktemp) && cp next-env.d.ts "$t" && timeout -k 30 840 npm run test:cards; s=$?; pkill -TERM -f "$PWD/node_modules/.bin/next dev" 2>/dev/null; for p in $(fuser 3000/tcp 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$PWD" ] && kill -TERM $p 2>/dev/null; done; sleep 2; pkill -KILL -f "$PWD/node_modules/.bin/next dev" 2>/dev/null; for p in $(fuser 3000/tcp 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$PWD" ] && kill -KILL $p 2>/dev/null; done; find /tmp -maxdepth 1 -type d -name "playwright_chromiumdev_profile-*" -newer "$t" -exec rm -rf {} + 2>/dev/null; cp "$t" next-env.d.ts; rm -f "$t"; rm -rf .next test-results; exit $s`

```
> playwright test


[2mRunning [22m12[2m tests using [22m2[2m workers[22m

  [32m-[39m  [2m 1 [22m[36m[chromium] › tests/domain-forms.spec.ts:40:1 › default profile: the forms are today's, and nothing fixed is submitted[39m
  [32m✓[39m  [2m 2 [22m[chromium] › tests/cards.spec.ts:8:1 › workspace cards render and select[2m (6.4s)[22m
  [32m✓[39m  [2m 3 [22m[chromium] › tests/domain-forms.spec.ts:59:1 › equity-research example: relabelled fields, hidden ones gone, real values and the fixed region submitted[2m (8.7s)[22m
  [32m✓[39m  [2m 4 [22m[chromium] › tests/event-order.spec.ts:54:1 › live: the orchestrator's next thinking streams BELOW the specialist card[2m (41.9s)[22m
  [32m✓[39m  [2m 6 [22m[chromium] › tests/event-order.spec.ts:70:1 › reopened: every part renders in the order it happened[2m (2.8s)[22m
  [31m✘[39m  [2m 5 [22m[31m[chromium] › tests/stickloop.spec.ts:9:1 › streaming content does not blow React update depth[39m[2m (45.1s)[22m
  [32m✓[39m  [2m 7 [22m[chromium] › tests/user-message.spec.ts:14:5 › light scheme › long sent messages fold; short ones and assistant replies do not[2m (20.9s)[22m
  [32m✓[39m  [2m 8 [22m[chromium] › tests/user-message.spec.ts:34:5 › light scheme › expands from the keyboard WHILE the reply streams, per message, and folds again[2m (2.6s)[22m
  [32m✓[39m  [2m 9 [22m[chromium] › tests/user-message.spec.ts:57:5 › light scheme › the fade is the bubble's colour, not the page's[2m (2.9s)[22m
  [32m✓[39m  [2m10 [22m[chromium] › tests/user-message.spec.ts:14:5 › dark scheme › long sent messages fold; short ones and assistant replies do not[2m (2.9s)[22m
  [32m✓[39m  [2m11 [22m[chromium] › tests/user-message.spec.ts:34:5 › dark scheme › expands from the keyboard WHILE the reply streams, per message, and folds again[2m (2.8s)[22m
  [32m✓[39m  [2m12 [22m[chromium] › tests/user-message.spec.ts:57:5 › dark scheme › the fade is the bubble's colour, not the page's[2m (3.2s)[22m


[31m  1) [chromium] › tests/stickloop.spec.ts:9:1 › streaming content does not blow React update depth [2m─[22m[39m

    [31mTest timeout of 45000ms exceeded.[39m

    Error: page.waitForTimeout: Test timeout of 45000ms exceeded.

    [0m [90m 16 |[39m   [36mawait[39m page[33m.[39mgoto([32m"/preview/stickloop"[39m)[33m;[39m
     [90m 17 |[39m   [90m// Let the content grow for the full streaming window.[39m
    [31m[1m>[22m[39m[90m 18 |[39m   [36mawait[39m page[33m.[39mwaitForTimeout([35m7000[39m)[33m;[39m
     [90m    |[39m              [31m[1m^[22m[39m
     [90m 19 |[39m
     [90m 20 |[39m   [36mconst[39m depthErrors [33m=[39m errors[33m.[39mfilter(
     [90m 21 |[39m     (e) [33m=>[39m [35m/maximum update depth/i[39m[33m.[39mtest(e) [33m||[39m [35m/react error #?185/i[39m[33m.[39mtest(e) [33m||[39m [35m/error #185/i[39m[33m.[39mtest(e)[33m,[39m[0m
    [2m    at /root/software-factory/build/onfinance_hfc_vm.lane/tests/stickloop.spec.ts:18:14[22m

[2m    Error Context: test-results/stickloop-streaming-content-does-not-blow-React-update-depth-chromium/error-context.md[22m

[31m  1 failed[39m
[31m    [chromium] › tests/stickloop.spec.ts:9:1 › streaming content does not blow React update depth [2m──[22m[39m
[33m  1 skipped[39m
[32m  10 passed[39m[2m (1.8m)[22m
```


## Measured rows

### `rls`

| check | result | detail |
|---|---|---|
| rls.isolation | pass | {"mode":"fail_closed","role":"app_rw","superuser":false,"bypassrls":false,"sslmode":"require","pg_stat_ssl":true,"plaintext":"refused (server requires TLS)","guc_roundtrip":true,"tables_org_scoped":58,"protected":58,"unprotected":[],"open_policies":[],"leaking_policies":[],"policies_executed":58,"policies_unverified":[],"other_role_policies":[],"probe_tables":45,"probe_table":"account_summaries"," |
| rls.health    | pass | {"ok": true, "detail": "SELECT 1 ok \u00b7 role app_rw (RLS enforced)", "ms": 16} |

### `tool.python`

| check | result | detail |
|---|---|---|
| events | info | action.resultx1, actions.requestedx1, message.appendedx19, message.completedx1, message.receivedx1, reasoning.appendedx80, reasoning.completedx2, session.startedx1, step.completedx2, step.startedx2, turn.completedx1, turn.startedx1 |
| python in the sandbox | pass | tool `bash` ran python3 in the sandbox and returned the computed line |
tool.python: pass — tool `bash` ran python3 in the sandbox and returned the computed line, in 24s
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)


## Not covered by this lane

- The mold's own offline tests (the rows with cwd `default_profile`) run on the DEFAULT deployment profile: build/<app_id>.lane-default/ for an app with packs (mold + the packs' code, not their profiles/), else the mold. They pin the default profile's words and fields, so they cannot say whether this app's relabelled wording reads right; the context lane's `vocabulary` row grades what this app's model reads, and the accessibility and responsiveness lanes the pages it renders.
- The Playwright card/stickloop specs — the /preview routes they drive are absent from this snapshot (see the `test:cards` row).
- Anything behind a signed-in session: these scripts run offline against the mold's own fixtures.
- Performance, accessibility and viewport behaviour — the load, accessibility and responsiveness lanes own those.
