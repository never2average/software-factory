# Context lane — claudecode_web_replica (2026-09-14T105717Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-14T10:57:17+00:00. Lane status: **pass** (5 of 5 checks passed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/context/reports/claudecode_web_replica-2026-09-14T105717Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

Primary context assembly, memory persistence, the quality/hardening bundle, cross-org isolation of multiplayer context, and — for a clone — the regression verdict against the deployment it replicates.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:prompt-context` | pass | exit 0 | rning scripts/test-prompt-context.mjs test-prompt-context: all prompt, budget, audience, filtering, fallback, and telemetry contracts passed |
| `test:memory` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-memory.mjs test-memory: all assertions passed (fallback path, no Postgres). |
| `test:qm-hardening` | pass | exit 0 | g Browser use, which was never in the old list ok no directives leaves the text untouched chat attachments + directives: 24/24 checks passed |
| `test:org-isolation` | pass | exit 0 |  one workspace, only its own rows come back. ✓ Write: a cross-tenant insert is refused by the database (42501). ✓ Org isolation test PASSED. |
| `clone.regression` | pass | exit 0 | at": "2026-09-13T10:45:12+00:00", "report": "molds/mold_v1/testing/context/reports/claudecode_web_replica-regression-2026-09-13T104512Z.md"} |

## Not covered by this lane

- Model quality: these checks prove what reaches the model, not what the model then says.
- Live cross-org traffic — test:org-isolation measures a database, the functional lane's rls rows measure the deployed one.
