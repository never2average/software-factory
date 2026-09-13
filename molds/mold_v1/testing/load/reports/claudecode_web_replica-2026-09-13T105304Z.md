# Load lane — claudecode_web_replica (2026-09-13T105304Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-13T10:53:04+00:00. Lane status: **fail** (0 of 1 checks passed, 1 failed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/load/reports/claudecode_web_replica-2026-09-13T105304Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

Task-workflow throughput, latency and journal integrity under concurrency, measured against a service built from this mold snapshot on a private, throwaway Postgres.

**The run stopped here.** accessibility, responsiveness did not run: this lane failed, which reverts claudecode_web_replica, and the suite is a gate. `testing.{accessibility, responsiveness}` was therefore reset to `pending` in `state/application/claudecode_web_replica/application.json` — an earlier run's verdict for a lane this run never reached is not a result, and must not read as one.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:task-workflow:stress` | fail | exit 1, expected 0; output never matched /\/ stress\.executed \/ pass \//; output matched the forbidden /\/ unmeasured \// |  not a pass. Run this one command again on this machine to reproduce it: python3 molds/mold_v1/testing/load/stress.py claudecode_web_replica |

## Failures

### `test:task-workflow:stress` — exit 1, expected 0; output never matched /\| stress\.executed \| pass \|/; output matched the forbidden /\| unmeasured \|/
The task-workflow service is the multiplayer engine; p95 latency, throughput, HTTP errors and an intact transition journal under concurrency are what an operator feels.

`python3 /root/software-factory/molds/mold_v1/testing/load/stress.py claudecode_web_replica`

```
| row | result | budget | measured |
|---|---|---|---|
| service.health | unmeasured | 200, ok=true, service=task-workflow | not measured: the step that produces this row did not run |
| stress.executed | unmeasured | >= 186 operations | not measured: the step that produces this row did not run |
| stress.status | unmeasured | 0 responses >= 400 | not measured: the step that produces this row did not run |
| stress.p95 | unmeasured | p95 <= 1000 ms | not measured: the step that produces this row did not run |
| stress.throughput | unmeasured | >= 2.0 lifecycles/s | not measured: the step that produces this row did not run |
| stress.invariants | unmeasured | the spec's own assertions pass | not measured: the step that produces this row did not run |
| stress.residue | unmeasured | 0 tasks and 0 workflow instances left | not measured: the step that produces this row did not run |
| stress.journal | unmeasured | 112 transition events for the run of record | not measured: the step that produces this row did not run |

rls + app_rw failed:

[load] scratch /tmp/mold_v1-load-6c3b4p39
pg-claudecode-web-replica--loadlane up on sf-claudecode-web-replica--loadlane as db:6543 (no host port; TLS on)  [no compose artifact yet: run provision.py claudecode_web_replica__loadlane --check]
  schema push: ok
  rls + app_rw: FAILED
[load] tearing down
claudecode_web_replica__loadlane: removed container pg-claudecode-web-replica--loadlane, volume pg-claudecode-web-replica--loadlane-data, network sf-claudecode-web-replica--loadlane

rls + app_rw failed:
policies         : 14
tables app_rw cannot SELECT: 0  (must be 0)
node:fs:484
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^
Error: ENOENT: no such file or directory, open '.env.local'
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '.env.local'
}
Node.js v24.20.0

load lane FAILED on: service.health, stress.executed, stress.status, stress.p95, stress.throughput, stress.invariants, stress.residue, stress.journal
Read the table above: an `unmeasured` row means that step never ran, which is a failure, not a pass.
Run this one command again on this machine to reproduce it:
  python3 molds/mold_v1/testing/load/stress.py claudecode_web_replica
```


## Measured rows

### `test:task-workflow:stress`

| row | result | budget | measured |
|---|---|---|---|
| service.health | unmeasured | 200, ok=true, service=task-workflow | not measured: the step that produces this row did not run |
| stress.executed | unmeasured | >= 186 operations | not measured: the step that produces this row did not run |
| stress.status | unmeasured | 0 responses >= 400 | not measured: the step that produces this row did not run |
| stress.p95 | unmeasured | p95 <= 1000 ms | not measured: the step that produces this row did not run |
| stress.throughput | unmeasured | >= 2.0 lifecycles/s | not measured: the step that produces this row did not run |
| stress.invariants | unmeasured | the spec's own assertions pass | not measured: the step that produces this row did not run |
| stress.residue | unmeasured | 0 tasks and 0 workflow instances left | not measured: the step that produces this row did not run |
| stress.journal | unmeasured | 112 transition events for the run of record | not measured: the step that produces this row did not run |

rls + app_rw failed:

[load] scratch /tmp/mold_v1-load-6c3b4p39
pg-claudecode-web-replica--loadlane up on sf-claudecode-web-replica--loadlane as db:6543 (no host port; TLS on)  [no compose artifact yet: run provision.py claudecode_web_replica__loadlane --check]
  schema push: ok
  rls + app_rw: FAILED
[load] tearing down
claudecode_web_replica__loadlane: removed container pg-claudecode-web-replica--loadlane, volume pg-claudecode-web-replica--loadlane-data, network sf-claudecode-web-replica--loadlane

rls + app_rw failed:
policies         : 14
tables app_rw cannot SELECT: 0  (must be 0)
node:fs:484
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^
Error: ENOENT: no such file or directory, open '.env.local'
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '.env.local'
}
Node.js v24.20.0

load lane FAILED on: service.health, stress.executed, stress.status, stress.p95, stress.throughput, stress.invariants, stress.residue, stress.journal
Read the table above: an `unmeasured` row means that step never ran, which is a failure, not a pass.
Run this one command again on this machine to reproduce it:
  python3 molds/mold_v1/testing/load/stress.py claudecode_web_replica


## Not covered by this lane

- Thread-open latency for a signed-in operator. NOT COVERED, permanently, and not merely skipped. `scripts/fde/thread-open-perf.mjs` needs a Google ID token copied out of a signed-in browser's localStorage (or an emailed sign-in code): lib/ops-auth.ts admits exactly those two human identities and says so — "There is deliberately no shared service key: every caller is a real, named human" — and such a token lives about an hour. No factory script can mint one for a stamped app, and asking a non-technical operator to open a browser console is not an instruction this factory gives. The check used to sit in `checks` guarded by FDE_OPS_TOKEN, which is a name that appears NOWHERE in the mold (the script reads --token, --token-file or FDE_GOOGLE_TOKEN), so setting it would have run an unauthenticated baseline that exits 0 having measured no thread open at all — a `pass` with nothing behind it — and, with FDE_OPS_URL unset, against the LIVE fde-agent projects rather than this app. See README.md for what would have to change for it to become measurable.
- The DEPLOYED application. This lane builds services/task-workflow from the mold snapshot and runs it on this machine against a local Postgres; it does not touch the app's Vercel deployment or its database, so it measures the mold's engine, not the hosting.
- GLM 5.2 inference throughput and the sandbox prewarm saturation budget — neither has a harness yet (mold_v1 backlog).
- Concurrent multi-workspace chat load: the scenario drives one org's task workflow, not many workspaces at once (mold_v1 backlog).
- Sustained soak. The spec is a burst of about four seconds, not an hour, so connection-pool exhaustion, leaks and autovacuum pressure are outside what any row here can claim.
