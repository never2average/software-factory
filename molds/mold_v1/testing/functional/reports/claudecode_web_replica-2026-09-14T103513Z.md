# Functional lane — claudecode_web_replica (2026-09-14T103513Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-14T10:35:13+00:00. Lane status: **pass** (21 of 21 checks passed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/functional/reports/claudecode_web_replica-2026-09-14T103513Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

Feature-parity of the mold's own surface: data room, syncs, alerts, schedules, rendering, system of record, chat persistence, gates, and the tenant-isolation rows that cannot be satisfied by a status code.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `test:dataroom` | pass | exit 0 | iles) verify ok (jsonl lines durable across separate process invocations) dataroom-store round-trip ok (local backend, 3 separate processes) |
| `test:syncs` | pass (known defect mold_v1-017) | exit 0 | ble across process exit; second ingest appended to 4) syncs ingestion round-trip ok (local backend, JSON-fallback SoR, 2 separate processes) |
| `test:alerts` | pass (known defect mold_v1-018) | exit 0 | l-strip-types --disable-warning=ExperimentalWarning scripts/test-alerts.mjs test-alerts: all assertions passed (fallback path, no Postgres). |
| `test:schedules` | pass (known defect mold_v1-019) | exit 0 | p-types --disable-warning=ExperimentalWarning scripts/test-schedules.mjs test-schedules: all assertions passed (fallback path, no Postgres). |
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
| `test:cards` | pass | exit 0 | ); 0 update-depth ✓ 2 [chromium] › tests/stickloop.spec.ts:9:1 › streaming content does not blow React update depth (27.0s) 2 passed (44.1s) |
| `rls` | pass | exit 0 | probe_table":"account_summaries", / / rls.health / pass / {"ok": true, "detail": "SELECT 1 ok \u00b7 role app_rw (RLS enforced)", "ms": 4} / |
| `signin.google` | pass | exit 0 | signin.google: pass — the served bundle carries a Google web client id (26 chunk(s) scanned) |

## Measured rows

### `rls`

| check | result | detail |
|---|---|---|
| rls.isolation | pass | {"mode":"fail_closed","role":"app_rw","superuser":false,"bypassrls":false,"sslmode":"require","pg_stat_ssl":false,"plaintext":"refused (server requires TLS)","guc_roundtrip":true,"tables_org_scoped":52,"protected":52,"unprotected":[],"open_policies":[],"leaking_policies":[],"policies_executed":52,"policies_unverified":[],"other_role_policies":[],"probe_tables":40,"probe_table":"account_summaries", |
| rls.health    | pass | {"ok": true, "detail": "SELECT 1 ok \u00b7 role app_rw (RLS enforced)", "ms": 4} |


## Not covered by this lane

- The Playwright card/stickloop specs — the /preview routes they drive are absent from this snapshot (see the `test:cards` row).
- Anything behind a signed-in session: these scripts run offline against the mold's own fixtures.
- Performance, accessibility and viewport behaviour — the load, accessibility and responsiveness lanes own those.
