---
name: clone
description: Replicate the live fde-agent deployment into a stamped mold_v1 application and regression-diff the two. Use when asked to clone live, replicate production, or prove the factory reproduces the live app.
---
# clone

`python3 .claude/scripts/clone.py <app_id> <step>` where the app was stamped from a brief that says "clone of live" (sets `clone_of`). Steps, in order:

1. `plan` — prints what each step touches. No secrets.
2. `extract` — reads the live surface tables and writes `application.surface` + `datainfra`. Live is only SELECTed.
3. `provision.py <app_id>` then `--deploy` — fresh Supabase + Blob, migrations, three Vercel projects.
4. `snapshot --apply` — `pg_dump` live public schema into the fresh database, copy the blob tree under the org prefix. Refuses unless `datastores.postgres.scope` is `fresh`.
5. `configure` — upserts `application.surface` into the app database (org, members, admins, roster, agent profile, agent configs, workflow definitions, extra scripts). Idempotent.
6. `regress` — row counts for every table, keyed diff of the surface tables, blob tree per top-level folder. Writes `molds/<mold>/testing/context/reports/<app>-regression-<date>.md`, sets `clone_of.regression` and the context lane; a fail reverts the app.

Every step pulls env values from Vercel at run time into a temp file in the mold dir and deletes it. The agent runtime is not allowed to handle secret values, so steps 2 to 6 run from sol's terminal; the agent prepares state, reads reports and files tasks. Never point any step at the live projects for writes: `LIVE` in clone.py is read-only by construction.
