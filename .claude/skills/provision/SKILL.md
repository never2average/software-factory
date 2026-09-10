---
name: provision
description: Check and deploy a stamped application to its target. Use after intake, or when asked whether an app can deploy, or to deploy it.
---
# provision

```
python3 .claude/scripts/provision.py <app_id>                     # check, READ-ONLY: what exists, what a deploy will create, which secrets to set
python3 .claude/scripts/provision.py <app_id> --set-secret NAME   # type one credential at a hidden prompt (human terminal only); creates the three empty projects if absent
python3 .claude/scripts/provision.py <app_id> --deploy            # prints the plan, refuses before creating if a secret is missing, else creates + deploys
python3 .claude/scripts/provision.py <app_id> --verify-db         # the database half of --deploy (vercel: creates projects + datastores, bootstraps Neon; vm: a private local Postgres)
python3 .claude/scripts/provision.py <app_id> --verify-rls [--no-repair]   # re-prove isolation on what runs now; writes rls_verified
```

Launch the `provisioner` subagent for the check; a human runs `--set-secret` and `--deploy` (the agent runtime
may not handle secret values). Missing secrets are the user's to set; report names, never collect values.

## The sequence, and what each command creates (mold_v1-041)

1. **`provision.py <app>`** (same as `--check`) is **read-only on every target**. On `target: vercel` it runs exactly
   five kinds of read: `GET /v9/projects/<proj>`, `/<proj>-api`, `/<proj>-workflow`; `vercel integration list --all
   --json`; `GET /v1/storage/stores`; and `vercel env ls production --project <proj>` only if `<proj>` exists. It prints
   each project as `exists` / `does not exist`, then `a deploy will create:` followed by the projects to create, the
   Neon action (adopt one of N named unattached resources if one is empty, else provision `<app-id-dashed>` on the
   free plan — each candidate inspected through a temporary `sf-neon-inspect-*` project created and deleted in the
   same run), the Blob store `<app-id-dashed>` (create, or connect if the team already has one) and the env it mints
   (`CRON_SECRET`, `OPS_SECRETS_KEY`, `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_PUBLIC_KEY`); then `secrets present: n/N`, one
   `--set-secret NAME` line per missing operator secret, `a deploy will create: <derived names>`, `set during
   --deploy: <deploy-time names>`, and the closing line `check only, read-only: nothing was created. Set the secret(s)
   above, then run: ... --deploy` (exit 1) or `... Ready: ... --deploy` (exit 0). It never creates, deletes or writes
   anything remote, never sweeps `sf-neon-inspect-*` projects, and does not write `infrastructure.json`. On
   `target: vm` it only regenerates `infra/vm/apps/<app>/` (local files).
2. **`--set-secret NAME`** for each name listed. On a vercel app whose three projects do not exist, this command
   creates them first — three empty, free projects, no deployment, git-disconnected immediately — and prints
   `creating the Vercel project(s) ... to hold NAME` before doing so. That is the one creation `--set-secret` performs.
3. **`--deploy`** prints the same plan as `about to create:`, then, if any operator secret is missing, exits with
   `refusing to deploy: N secret(s) above are not set, so NOTHING was created` (only the five reads ran). Otherwise it
   creates the projects, database, Blob store and minted env, then runs schema, the app_rw + RLS gate, the three
   deploys and the health checks.
4. **`--verify-db`** on a vercel app is a **writer** (the database half of `--deploy`): it prints `about to create:`
   then creates projects + datastores and bootstraps the database; it does not gate on operator secrets. On vm it is
   local only (`localpg.py down <app>` removes the container).

There is no separate provision step: "deploy prints, then creates" with the refusal-before-creation gate is the
whole safety, chosen because the operator is non-technical. `factory.py validate` and `lanes.py <app> --list` are
the other read-only views.

## What it deletes, and when

Only ever Vercel projects named `sf-neon-inspect-<8 hex>` — the exact pattern `^sf-neon-inspect-[0-9a-f]{8}$`
(`SCRATCH_RE` in `provision.py`), which is the only name this file mints. Never the app's projects, never a Neon
resource or Blob store, never the live `fde-agent*` projects. A `--check` deletes nothing: it only names the
inspection in its plan.

- **When:** during a `--deploy` or `--verify-db` of a **vercel** app with `postgres.scope: fresh`, `provider: neon`,
  and no `DATABASE_URL_UNPOOLED` on its project yet (i.e. the database is not provisioned).
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
