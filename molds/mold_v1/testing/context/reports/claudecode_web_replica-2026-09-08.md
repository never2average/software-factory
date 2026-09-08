# Context lane — claudecode_web_replica (2026-09-08)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-08T10:14:21+00:00. Lane status: **fail** (3 of 5 checks passed, 1 failed, 1 skipped).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane context`

Primary context assembly, memory persistence, the quality/hardening bundle, cross-org isolation of multiplayer context, and — for a clone — the regression verdict against the deployment it replicates.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:prompt-context` | pass | exit 0 | rning scripts/test-prompt-context.mjs test-prompt-context: all prompt, budget, audience, filtering, fallback, and telemetry contracts passed |
| `test:memory` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-memory.mjs test-memory: all assertions passed (fallback path, no Postgres). |
| `test:qm-hardening` | pass | exit 0 | g Browser use, which was never in the old list ok no directives leaves the text untouched chat attachments + directives: 24/24 checks passed |
| `test:org-isolation` | skipped | Needs DATABASE_URL in molds/mold_v1/codebase/.env.local, pointing at the app_rw role — as postgres the check cannot detect a leak at all, because postgres has BYPASSRLS. Bring a database up on this box and let provision. |  |
| `clone.regression` | fail | output matched the forbidden /"status": "fail"/ | ", "run_at": "2026-09-06T12:15:18+00:00", "report": "molds/mold_v1/testing/context/reports/claudecode_web_replica-regression-2026-09-06.md"} |

## Failures

### `clone.regression` — output matched the forbidden /"status": "fail"/
This app claims to replicate a live deployment. The diff clone.py measured is the context verdict; without this row the lane would overwrite it with a greener answer than the evidence supports.

`python3 -c "import json;print(json.dumps(json.load(open('state/application/claudecode_web_replica/application.json')).get('clone_of',{}).get('regression',{}) or {'status':'pending'}))"`

```
{"status": "fail", "run_at": "2026-09-06T12:15:18+00:00", "report": "molds/mold_v1/testing/context/reports/claudecode_web_replica-regression-2026-09-06.md"}
```


## Skipped, and what would make them run

- `test:org-isolation` — Needs DATABASE_URL in molds/mold_v1/codebase/.env.local, pointing at the app_rw role — as postgres the check cannot detect a leak at all, because postgres has BYPASSRLS. Bring a database up on this box and let provision.py write the file: python3 .claude/scripts/lib/localpg.py up claudecode_web_replica, then python3 .claude/scripts/provision.py claudecode_web_replica --verify-rls. The runner only ever tests for the NAME; it never reads the value.

A skipped check is why this lane cannot report `pass`: nothing measured it.

## Not covered by this lane

- Model quality: these checks prove what reaches the model, not what the model then says.
- Live cross-org traffic — test:org-isolation measures a database, the functional lane's rls rows measure the deployed one.
