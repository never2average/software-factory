# Functional lane — claudecode_web_replica (2026-09-08)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-08T10:13:19+00:00. Lane status: **fail** (15 of 20 checks passed, 4 failed, 1 skipped).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane functional`

Feature-parity of the mold's own surface: data room, syncs, alerts, schedules, rendering, system of record, chat persistence, gates, and the tenant-isolation rows that cannot be satisfied by a status code.

Not run in this run (the lane order stopped here): context, load, accessibility, responsiveness. Their recorded results are whatever a previous run left.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:dataroom` | pass | exit 0 | iles) verify ok (jsonl lines durable across separate process invocations) dataroom-store round-trip ok (local backend, 3 separate processes) |
| `test:syncs` | fail (known defect mold_v1-017) | exit 1, expected 0 | ) at async file:///root/software-factory/molds/mold_v1/codebase/scripts/test-syncs.mjs:172:3 Node.js v24.20.0 phase "ingest" failed (exit 1) |
| `test:alerts` | fail (known defect mold_v1-018) | exit 1, expected 0 | js:35:8 { generatedMessage: false, code: 'ERR_ASSERTION', actual: 0, expected: 2, operator: 'strictEqual', diff: 'simple' } Node.js v24.20.0 |
| `test:schedules` | fail (known defect mold_v1-019) | exit 1, expected 0 | lib/schedule-tools.ts:88:24) at async file:///root/software-factory/molds/mold_v1/codebase/scripts/test-schedules.mjs:47:17 Node.js v24.20.0 |
| `test:cron-match` | pass | exit 0 | p-types --disable-warning=ExperimentalWarning scripts/test-cron-match.mjs test-cron-match: all assertions passed (offline, no dependencies). |
| `test:workbook-spec` | pass | exit 0 | --disable-warning=ExperimentalWarning scripts/test-workbook-spec.mjs test-workbook-spec: all assertions passed (fallback path, no Postgres). |
| `test:render` | pass | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-render.mjs test-render: all assertions passed (fallback path, no Postgres). |
| `test:sor` | pass | exit 0 | > node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-system-of-record.mjs system-of-record fallback tests ok |
| `test:browser-security` | pass | exit 0 | rity > node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-browser-security.mjs browser security tests passed |
| `test:workflow-leases` | pass | exit 0 | > fde-agent@0.0.0 test:workflow-leases > node scripts/test-workflow-leases.mjs workflow lease contract: 18/18 checks passed |
| `test:workflow-args` | pass | exit 0 | > fde-agent@0.0.0 test:workflow-args > node --experimental-strip-types scripts/test-workflow-args.mjs workflow args: 14/14 checks passed |
| `test:chat-persistence` | pass | exit 0 | recorded ok the gate says so when it fails open ok the gate's ceiling is not the narrowest on the path chat reliability: 39/39 checks passed |
| `test:chat-turn-state` | pass | exit 0 | e storm ok …and a storm AFTER a healthy turn is still caught ok the threshold is adjustable chat turn state: 18/18 behavioural checks passed |
| `test:chat-attachments` | pass | exit 0 | g Browser use, which was never in the old list ok no directives leaves the text untouched chat attachments + directives: 24/24 checks passed |
| `test:email-signin` | pass | exit 0 | in > node --conditions=react-server --experimental-strip-types scripts/test-email-signin.mjs email sign-in + membership: 27/27 checks passed |
| `test:step-context` | pass | exit 0 | est:step-context > node --conditions=react-server --experimental-strip-types scripts/test-step-context.mjs step context: 26/26 checks passed |
| `check:gates` | pass | exit 0 | ater sync ok the local chat cache is keyed by workspace gate lockstep: 19/19 source checks passed (run with --live to also probe production) |
| `check:tenancy` | pass | exit 0 | in scope: 21 · pending: 0 service files : 6 · in scope: 6 · pending: 0 ✓ all three projects read tenant data only inside a workspace's scope |
| `test:cards` | skipped | Blocked by the snapshot, not by this app: tests/cards.spec.ts drives /preview/cards and /preview/stickloop, and app/preview does not exist in this mold. Refresh the mold from source per molds/mold_v1/MOLD.md, then re-run |  |
| `rls` | fail | exit 1, expected 0; output matched the forbidden /BYPASSRLS/; output matched the forbidden /NOT enforced/ |  "SELECT 1 ok \u00b7 role postgres \u2014 WARNING: BYPASSRLS, row-level security is NOT enforced (point DATABASE_URL at app_rw)", "ms": 8} / |

## Failures

### `test:syncs` — exit 1, expected 0 — known pre-existing mold defect, task **mold_v1-017**
Connector syncs normalize interactions; 0 instead of 2 means an ingested account looks empty.

`npm run test:syncs`

```

> fde-agent@0.0.0 test:syncs
> node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-syncs.mjs

file:///root/software-factory/molds/mold_v1/codebase/scripts/test-syncs.mjs:60
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
                        ^

Error: ASSERT FAILED: manual_entry should normalize 2 interactions, got 0
    at assert (file:///root/software-factory/molds/mold_v1/codebase/scripts/test-syncs.mjs:60:25)
    at phaseIngest (file:///root/software-factory/molds/mold_v1/codebase/scripts/test-syncs.mjs:87:3)
    at async file:///root/software-factory/molds/mold_v1/codebase/scripts/test-syncs.mjs:172:3

Node.js v24.20.0
phase "ingest" failed (exit 1)
```

### `test:alerts` — exit 1, expected 0 — known pre-existing mold defect, task **mold_v1-018**
Alerts are computed from the customer corpus; the snapshot ships data/customers.json empty.

`npm run test:alerts`

```

> fde-agent@0.0.0 test:alerts
> node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-alerts.mjs

node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: both seed customers counted

0 !== 2

    at file:///root/software-factory/molds/mold_v1/codebase/scripts/test-alerts.mjs:35:8 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 0,
  expected: 2,
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v24.20.0
```

### `test:schedules` — exit 1, expected 0 — known pre-existing mold defect, task **mold_v1-019**
A schedule that cannot be parsed cannot be run, so recurring workflows silently stop.

`npm run test:schedules`

```

> fde-agent@0.0.0 test:schedules
> node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-schedules.mjs

file:///root/software-factory/molds/mold_v1/codebase/agent/lib/schedule-store.ts:172
  return scheduleRuleSchema.parse({
                            ^

ZodError: [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      "orgId"
    ],
    "message": "Invalid input: expected string, received undefined"
  }
]
    at fallbackToRecord (file:///root/software-factory/molds/mold_v1/codebase/agent/lib/schedule-store.ts:172:29)
    at createScheduleRule (file:///root/software-factory/molds/mold_v1/codebase/agent/lib/schedule-store.ts:284:10)
    at Object.execute (file:///root/software-factory/molds/mold_v1/codebase/agent/lib/schedule-tools.ts:88:24)
    at async file:///root/software-factory/molds/mold_v1/codebase/scripts/test-schedules.mjs:47:17

Node.js v24.20.0
```

### `rls` — exit 1, expected 0; output matched the forbidden /BYPASSRLS/; output matched the forbidden /NOT enforced/
Two rows a status code cannot satisfy: the app role must not be able to read another workspace's rows, and the RUNNING build's health body must not say BYPASSRLS.

`python3 /root/software-factory/molds/mold_v1/testing/functional/tenant-isolation.py claudecode_web_replica`

```
| check | result | detail |
|---|---|---|
| rls.isolation | fail |   Run: python3 .claude/scripts/provision.py claudecode_web_replica --verify-db |
| rls.health    | fail | {"ok": true, "detail": "SELECT 1 ok \u00b7 role postgres \u2014 WARNING: BYPASSRLS, row-level security is NOT enforced (point DATABASE_URL at app_rw)", "ms": 8} |
```

Rows marked with a task id are defects of the mold snapshot itself, not of this application. Fixing them needs a mold refresh from source per `MOLD.md`; they are reported here rather than muted, and they still fail the lane.


## Measured rows

### `rls`

| check | result | detail |
|---|---|---|
| rls.isolation | fail |   Run: python3 .claude/scripts/provision.py claudecode_web_replica --verify-db |
| rls.health    | fail | {"ok": true, "detail": "SELECT 1 ok \u00b7 role postgres \u2014 WARNING: BYPASSRLS, row-level security is NOT enforced (point DATABASE_URL at app_rw)", "ms": 8} |


## Skipped, and what would make them run

- `test:cards` — Blocked by the snapshot, not by this app: tests/cards.spec.ts drives /preview/cards and /preview/stickloop, and app/preview does not exist in this mold. Refresh the mold from source per molds/mold_v1/MOLD.md, then re-run. It is deliberately NOT invoked: its Playwright webServer would start `npm run dev` on 0.0.0.0:3000 on a box with no firewall.

A skipped check is why this lane cannot report `pass`: nothing measured it.

## Not covered by this lane

- The Playwright card/stickloop specs — the /preview routes they drive are absent from this snapshot (see the `test:cards` row).
- Anything behind a signed-in session: these scripts run offline against the mold's own fixtures.
- Performance, accessibility and viewport behaviour — the load, accessibility and responsiveness lanes own those.
