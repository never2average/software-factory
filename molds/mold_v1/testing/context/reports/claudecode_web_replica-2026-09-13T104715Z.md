# Context lane — claudecode_web_replica (2026-09-13T104715Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-13T10:47:15+00:00. Lane status: **fail** (4 of 5 checks passed, 1 failed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/context/reports/claudecode_web_replica-2026-09-13T104715Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

Primary context assembly, memory persistence, the quality/hardening bundle, cross-org isolation of multiplayer context, and — for a clone — the regression verdict against the deployment it replicates.

**The run stopped here.** load, accessibility, responsiveness did not run: this lane failed, which reverts claudecode_web_replica, and the suite is a gate. `testing.{load, accessibility, responsiveness}` was therefore reset to `pending` in `state/application/claudecode_web_replica/application.json` — an earlier run's verdict for a lane this run never reached is not a result, and must not read as one.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:prompt-context` | pass | exit 0 | rning scripts/test-prompt-context.mjs test-prompt-context: all prompt, budget, audience, filtering, fallback, and telemetry contracts passed |
| `test:memory` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-memory.mjs test-memory: all assertions passed (fallback path, no Postgres). |
| `test:qm-hardening` | pass | exit 0 | g Browser use, which was never in the old list ok no directives leaves the text untouched chat attachments + directives: 24/24 checks passed |
| `test:org-isolation` | fail | exit 9, expected 0 | erimental-strip-types --disable-warning=ExperimentalWarning --env-file=.env.local scripts/test-org-isolation.mjs node: .env.local: not found |
| `clone.regression` | pass | exit 0 | at": "2026-09-13T10:45:12+00:00", "report": "molds/mold_v1/testing/context/reports/claudecode_web_replica-regression-2026-09-13T104512Z.md"} |

## Failures

### `test:org-isolation` — exit 9, expected 0
Multiplayer context is shared processes across one workspace; a leak here hands one customer another customer's work. Runs AS the deployed application: the runner places the app's own DATABASE_URL (app_rw) in the environment by name.

`npm run test:org-isolation`

```

> fde-agent@0.0.0 test:org-isolation
> node --experimental-strip-types --disable-warning=ExperimentalWarning --env-file=.env.local scripts/test-org-isolation.mjs

node: .env.local: not found
```


## Not covered by this lane

- Model quality: these checks prove what reaches the model, not what the model then says.
- Live cross-org traffic — test:org-isolation measures a database, the functional lane's rls rows measure the deployed one.
