# Functional lane — claudecode_web_replica — fail

Run 2026-09-06 by the `validate-replica` workflow (14 lane agents, 4 reviewers with 2 refuters per finding, 1 smoke agent). Mold: mold_v1 @ dc98cb6. Lane scripts run in `molds/mold_v1/codebase`; no file under `molds/` was edited.

## Lane scripts

| Script | Status | Note |
|---|---|---|
| typecheck | pass | tsc --noEmit clean |
| validate:schema | pass | schema validation ok |
| validate:dataroom | pass | all seven fixtures valid |
| test:dataroom | pass | round trip across 3 processes, local backend |
| test:cron-match | pass | offline assertions |
| test:workbook-spec | pass | fallback path, no Postgres |
| test:render | pass | fallback path |
| test:sor | pass | system-of-record fallback |
| test:memory | pass | fallback path |
| test:prompt-context | pass | prompt, budget, audience, filtering, fallback, telemetry contracts |
| test:browser-security | pass | browser security tests passed |
| test:syncs | **fail** | `manual_entry should normalize 2 interactions, got 0` (scripts/test-syncs.mjs:87, offline ingest phase; no secret involved) |
| test:alerts | **fail** | `both seed customers counted: 0 !== 2` — `data/customers.json` in the snapshot is `{"customers": []}`; the seed data the test expects is not in the mold |
| test:schedules | **fail** | ZodError: `orgId` missing — `agent/lib/schedule-store.ts:172` `fallbackToRecord` omits `orgId` when parsing `scheduleRuleSchema` |

Eleven pass, three fail. All three failures are in the mold codebase on paths that need no database, blob token or API key, so none is an environment skip.

## Smoke checks (production URL)

| Check | Status | Note |
|---|---|---|
| URL capture | fail (fixed since) | `production_url`, `api_url`, `workflow_url` were all recorded as `}`; provision.py took the last CLI line. Now extracted by pattern |
| GET / | pass | 200, Next.js shell |
| GET /onboard | pass | 200 |
| GET /api/ops/health | fail | 503: inference and taskWorkflow unreachable (both traced to the `}` URLs); db and blob ok |

The team alias redirects to Vercel SSO; the project alias `claudecode-web-opal.vercel.app` serves the app.

## Pipeline defects confirmed by review

Reviewers found defects in `clone.py`, `provision.py`, `intake.py` and `lib/surface.mjs`; the refuters ran out of model credits mid-pass, so only the finding below completed verification. It is fixed.

- `clone.py` stamped `infrastructure.configured_at` before checking whether `surface.mjs apply` reported errors, so a failed configure was recorded as configured.

## Gaps

- Three mold test failures above: filed as tasks mold_v1-017, 018, 019.
- Accessibility and responsiveness lanes still have no harness (mold_v1-007, 008).
- Re-run this lane after the current deploy so the health check is re-measured.
