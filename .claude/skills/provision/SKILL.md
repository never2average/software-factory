---
name: provision
description: Check and deploy a stamped application to its target. Use after intake, or when asked whether an app can deploy, or to deploy it.
---
# provision

```
python3 .claude/scripts/provision.py <app_id>                     # check AND provision: counts secrets by name, creates what is missing
python3 .claude/scripts/provision.py <app_id> --set-secret NAME   # type one credential at a hidden prompt (human terminal only)
python3 .claude/scripts/provision.py <app_id> --deploy            # vercel: schema, app_rw + RLS proof, three deploys, health
python3 .claude/scripts/provision.py <app_id> --verify-db         # the database half only (vercel: on Neon; vm: on a private local Postgres)
python3 .claude/scripts/provision.py <app_id> --verify-rls [--no-repair]   # re-prove isolation on what runs now; writes rls_verified
```

Launch the `provisioner` subagent for the check; a human runs `--set-secret` and `--deploy` (the agent runtime
may not handle secret values). Missing secrets are the user's to set; report names, never collect values.

## `provision.py <app>` is NOT read-only on a Vercel app (mold_v1-041, open)

The bare command (`--check`) builds and deploys nothing, but on `target: vercel` it creates before it counts:

1. the three Vercel projects `<proj>`, `<proj>-api`, `<proj>-workflow` if absent (`ensure_projects`);
2. the datastores the state names — a fresh `neon` database (adopts an unattached, proven-empty resource on the
   team, else `vercel integration add neon`) and a Blob store inside the app's own project;
3. the app-internal secrets `CRON_SECRET`, `OPS_SECRETS_KEY`, `AUTH_JWT_PRIVATE_KEY`/`AUTH_JWT_PUBLIC_KEY`.

A `--check` of an app whose datastores are not provisioned yet therefore creates real, team-visible, potentially
billable resources. Do not run it on a vercel app to "just look"; `factory.py validate` and `lanes.py <app> --list`
are the read-only views. A `target: vm` app is safe: `--check` regenerates `infra/vm/apps/<app_id>/` and
`--verify-db` creates only a local docker container (`localpg.py down <app>` removes it).

## What it deletes, and when

Only ever Vercel projects named `sf-neon-inspect-<8 hex>` — the exact pattern `^sf-neon-inspect-[0-9a-f]{8}$`
(`SCRATCH_RE` in `provision.py`), which is the only name this file mints. Never the app's projects, never a Neon
resource or Blob store, never the live `fde-agent*` projects.

- **When:** during a `--check`, `--deploy` or `--verify-db` of a **vercel** app with `postgres.scope: fresh`,
  `provider: neon`, and no `DATABASE_URL_UNPOOLED` on its project yet (i.e. the database is not provisioned).
- **Per probe:** to see whether a candidate Neon resource is empty it is connected (`development` env only) to a
  throwaway `sf-neon-inspect-*` project the run just created; the table count is read, the resource is
  disconnected, and that project is deleted with `vercel api /v9/projects/<id> -X DELETE
  --dangerously-skip-permissions`. That flag is Vercel's name for "the confirmation was deliberate"; it is the
  one project deletion that works unattended on CLI 59.11.7 (`project rm` has no `--yes`). A newly created
  resource is created into such a project and read the same way.
- **The sweep:** before creating one, every team project matching `SCRATCH_RE` whose `createdAt` is older than
  **30 minutes** (`SCRATCH_STALE_S`) is deleted the same way — a leftover from an interrupted run holds a database
  URL. Younger matches are left alone and named on stdout; a match whose age cannot be read is left alone silently (unknown is not stale).
- **Honesty:** a project counts as deleted only after Vercel answers `Project not found. (404)` for it; any other
  lookup failure prints a NOTE with the dashboard path (`Projects -> <name> -> Settings -> Delete`).

## Other refusals worth knowing

`self_hosted` + `target: vercel` is refused (a Vercel function cannot reach a private docker network). A second
app on a Vercel project another active app uses is refused (one project is one env namespace and one `app_rw`
password). A project reconnected to git is refused before any deploy. `--deploy` on a vm app refuses and points at
`--verify-db`. Every refusal is one sentence with the file or command to fix it.

## Branding

When the app carries `surface.branding`, `--deploy` first builds a branded copy of the mold under `build/<app_id>/`
(`branding.py <app> prepare`) and deploys that: the mold snapshot is never edited. `branding.py <app> show` prints
the resolved brand and palette; `check` verifies a prepared copy. `molds/<mold_id>/branding/rules.json` says which
files carry the product name, tagline, icon and palette, and every rule must match or the deploy is refused.
