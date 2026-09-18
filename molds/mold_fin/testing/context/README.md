# Context

Existing: `npm run test:prompt-context`, `npm run test:memory`, `npm run test:org-isolation`, `npm run test:qm-hardening`.
Covers: primary_context assembly, multiplayer_context isolation across orgs/workspaces, memory persistence, data-room (dm.md) read/write paths.

## How this lane runs

    python3 .claude/scripts/lanes.py <app_id> --lane context

The checks are declared in [`lane.json`](lane.json) (schema: `../lane.schema.json`), which is also
where you add one. The runner writes `testing.context` into the application and the report into
`reports/<app_id>-<date>.md`. A check whose precondition is unmet is `skipped` with the sentence
saying what would make it run — the lane can then never be `pass`, only `skipped`.

## Running as the application

`test:org-isolation` is meaningless as a BYPASSRLS role, so its check declares `app_env: ["DATABASE_URL"]`: the runner reads this app's own `DATABASE_URL` (the `app_rw` role) by name from where the app's state says it lives — the Vercel project's env for a deployed app, `infra/vm/apps/<app>/.env` for a vm fixture — and places it in the check's environment. The value is never printed or stored; the report shows the name. Nothing has to be copied into `.env.local`. If the app is not deployed yet the check is `skipped` with the deploy command, never failed.
