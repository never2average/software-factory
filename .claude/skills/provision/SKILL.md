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

For an application on `target: vm_remote` (a server of the customer's own, over SSH) the commands are different; see "A server
of its own" at the end.

Launch the `provisioner` subagent for the check; a human runs `--set-secret` and `--deploy` (the agent runtime
may not handle secret values). Missing secrets are the user's to set; report names, never collect values.

## The sequence, and what each command creates (mold_v1-041)

1. **`provision.py <app>`** (same as `--check`) is **read-only on every target**. On `target: vercel` it runs exactly
   five kinds of read: `GET /v9/projects/<proj>`, `/<proj>-api`, `/<proj>-workflow`; `vercel integration list --all
   --json`; `GET /v1/storage/stores`; and `vercel env ls production --project <proj>` only if `<proj>` exists. It prints
   each project as `exists` / `does not exist`, then `a deploy will create:` — every step the deploy performs, in the order it happens, so nothing it writes or rotates is a surprise (mold_v1-056): `build/<app_id>/`, a branded copy of the mold to build from (branded apps only; local files); the projects to create; the Neon action (adopt one of N named unattached resources if one is empty, else provision `<app-id-dashed>` on the free plan, each candidate inspected through a temporary `sf-neon-inspect-*` project created and deleted in the same run); the Blob store `<app-id-dashed>` (create, or connect if the team already has one); the env it mints (`CRON_SECRET`, `OPS_SECRETS_KEY`, `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_PUBLIC_KEY`, `TASK_WORKFLOW_SERVICE_TOKEN`); the four build-time flags rewritten on `<project>` and `<project>-api` on every deploy (`MODEL_PROVIDER`, `ENABLE_WEB_SEARCH`, `ENABLE_BROWSER`, `OPS_MULTI_TENANT`); the database step — every org-scoped table held closed to `app_rw` by a temporary restrictive guard from before the schema step until coverage passes, re-applied after the journal and after the drift step so a table either creates is guarded too, with `app_rw`'s default grant on new tables withheld meanwhile (mold_v1-143; each hold and the release take a lock on every org-scoped table with a 10 s lock timeout and up to 4 attempts, so on a busy database one of them can stall the app's queries on a table for up to ~40 s in the worst case), schema (a full `drizzle-kit push --force` only on an empty database), migration journal, then on a live database any schema drift the journal did not cover, planned by a read-only dry run and applied in one transaction with nothing that drops a policy or disables RLS — a plan that would delete data (truncate, DROP TABLE/COLUMN/SCHEMA/MATERIALIZED VIEW) or drop an index other than the mold's own `workflow_definitions_one_default_idx` stops the deploy with the statements named, because that change belongs in a migration, the RLS + `app_rw` bootstrap, which ROTATES the `app_rw` password unless the `DATABASE_URL` already deployed is `app_rw`'s own — the check reads names, not values, so it cannot tell in advance (a rotation means every build made against the older password stops connecting until it is rebuilt), the task-workflow migration, the RLS coverage pass, the isolation proof, and only after that proof `DATABASE_URL` on all three projects; then the three production deployments in order — `<project>-workflow` (env copied from `<project>`, framework PATCHed to `nextjs`, i.e. the project's framework setting is changed by an API call, then `TASK_WORKFLOW_SERVICE_URL` written), `<project>-api` (API env copied, framework PATCHed to `eve`, a prebuilt deployment, then `NEXT_PUBLIC_EVE_API_URL` written) and `<project>` itself (`WEB_ORIGIN` written on web and api, rewritten if the deployment's URL differs), each git-disconnected again if the deploy re-linked it; and last, reads only (the three health endpoints) and the state files it updates. A `shared_with_live` app lists `build/<app_id>/vercel.nocron.json` (the snapshot path when unbranded) — `vercel.json` with its crons stripped — in place of the database, workflow and api steps. Then `secrets present: n/N`, one `--set-secret NAME` line per missing operator secret, `secrets a deploy will mint (not yours to set): <derived names>` (a different, shorter line: the names only), `set during --deploy: <deploy-time names>`, a `--verify-rls` reminder
   while nothing has measured isolation, and the closing line `check only, read-only: nothing was created. Set the secret(s)
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

## The application's own agent package

Every stamped application publishes its own variant of the mold's agent CLI: the package a coding agent installs
to reach this app, with the address, brand, the pack's `agent-kit/` skills and the data-room description baked in.
`infrastructure.json` `agent_cli` names it (`package`, `access`, `token_ref`).

```
python3 .claude/scripts/agent_cli.py <app_id> status     # what state names, what the registry has, who npm thinks we are
python3 .claude/scripts/agent_cli.py <app_id> build      # build/<app_id>.agent-cli/, the mold's safety gate + the factory's file allowlist
python3 .claude/scripts/agent_cli.py <app_id> publish    # only with the operator present; records agent_cli.published
```

Publishing signs in with the token NAMED by `token_ref` if the environment has it, otherwise with the machine's own
`npm login` (which prints a link the operator opens — the friendlier path). The value is never printed, written or
put on a command line. A public package never carries credentials or operator material such as a rulebook.

## The application's own web address

`python3 .claude/scripts/domain.py <app_id> status | attach <domain> | verify | switch`. `attach` adds the domain to
the Vercel project and prints the one DNS record its owner must create; nothing users see changes. `switch` runs only
once the domain serves the app: it moves `production_url` and `WEB_ORIGIN` (emailed links, the MCP origin check) and
lists what follows — a redeploy, the Google sign-in origin, and a new version of the app's agent package, which has
the address baked in. A deploy keeps a switched domain as the front door. The `*.vercel.app` address keeps working.

## A server of its own (`target: vm_remote`)

```
python3 .claude/scripts/provision.py <app_id>                              # check: OFFLINE, connects to nothing
python3 .claude/scripts/provision.py <app_id> --set-remote host=<address> domain=<name>   # the operator's two values (not secrets)
python3 .claude/scripts/provision.py <app_id> --remote-key                 # make the key pair named by ssh_key_ref; prints the PUBLIC half only
python3 .claude/scripts/provision.py <app_id> --qualify-remote             # logs in, read-only: /dev/kvm, 8 GB / 4 vCPU, disk, Ubuntu 24.04, no Docker
python3 .claude/scripts/provision.py <app_id> --deploy-remote --dry-run    # every local command, remote command and generated file; runs none
python3 .claude/scripts/provision.py <app_id> --deploy-remote              # a human, at a terminal: it asks for values at a hidden prompt
python3 .claude/scripts/provision.py <app_id> --verify-rls [--no-repair]   # measured on the server, where the database URLs live
python3 .claude/scripts/provision.py --self-test-remote                    # offline tests of all of the above
```

The agent may run the check, `--set-remote`, `--remote-key`, `--qualify-remote` and the dry run. The deploy is the operator's:
it asks for the customer credentials at a hidden prompt and sends them to the server on stdin, so no value reaches the chat,
the repo or a command line. `--deploy`, `--set-secret` and `--verify-db` answer with the vm_remote command to use instead.

The deploy qualifies the host first and refuses in plain words; then packages, firewall (the SSH port, 80, 443; fail2ban; no
Docker rule), Postgres on loopback with TLS, a master env file and one env file per service split from it (all mode 600; the
agent's never holds the sign-in private key), the SOURCE copied and built in place, the same database chain as the Vercel path
run ON the server, three systemd services (the API as a non-root user in group kvm, with the mold's `npm run sandbox:prewarm`
before start), six cron timers, Caddy, and the same `/api/ops/health` gate. It refuses outright while the mold lacks the three
off-Vercel switches (`SANDBOX_BACKEND`, `STORAGE_DRIVER`, `SERVICE_AUTH`) or the `sandbox:prewarm` script; the check and the
dry run name them. With files on the server's disk (`storage.driver: fs`) the sandbox must reach the app's public address, so
validate, `--qualify-remote` and the deploy refuse a sandbox deny list that holds it. When asking the operator for the server or the DNS record, use `docs/RUNBOOK.md` §9, one step at a time.
Details and what is still unproven on a real server: `infra/vm_remote/README.md`.
