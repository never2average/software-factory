# Intake questions

What the factory needs to know before it can stamp an application, and where each answer comes from. Resolution order: explicit answer > brief hint > confirmed factory default > built-in suggestion > ask.

| Id | Written to | Asked when | Options |
|---|---|---|---|
| deploy_target | infrastructure.target | brief silent and defaults unconfirmed | vercel, vm, vm_remote |
| postgres_provider | datastores.postgres.provider | defaults unconfirmed; brief hint (`neon` / `supabase` / `self-host the postgres`) | **neon** (default, free), supabase, rds, self_hosted |
| postgres_ref | datastores.postgres.url_ref | never (DATABASE_URL) | name only |
| postgres_scope | datastores.postgres.scope | never (brief hint, default fresh) | fresh, shared_with_live |
| blob_provider | datastores.blob.provider | defaults unconfirmed | vercel_blob, s3, gcs, azure_blob |
| inference_provider | infrastructure.inference.provider | defaults unconfirmed | cloudflare_workers_ai, vercel_ai_gateway |
| inference_account | infrastructure.inference.account_ref | provider is not cloudflare | name only |
| secret_store | infrastructure.secret_store | defaults unconfirmed | vercel_env, vm_env_file |
| web_search | application.capabilities.web_search | never (brief hint, default on) | true, false |
| browser | application.capabilities.browser | never (brief hint, default on) | true, false |
| customer_id | application.customer_id | never (brief hint, blank ok) | free text |
| custom_domain | infrastructure.vercel.custom_domain | never (brief hint, blank ok) | free text |
| multi_tenant | application.capabilities.multi_tenant | never (brief hint, default on) | true, false |
| vercel_project | infrastructure.vercel.project | never (product project for the first app, `<project>-<suffix>` after) | free text |
| workspace_name | application.workspace.org.name | brief silent and no factory default | free text |
| operator_email | application.workspace.operator_self.email | brief silent and no factory default | email |
| library | application.surface.custom_workflow_builder.library.install | never (brief hint, default none) | none, all |

Brief hints recognised: "vercel" / "vm, droplet, self-host" / "vm_remote, the customer's own server, a remote server, a dedicated server" (a server that serves the app; add "server: <address>" and "domain: <name>" if known, else the operator supplies them later); "neon" / "supabase" / "self-host the postgres, database on the vm, local postgres"; "no web search"; "no browser"; "single workspace"; "fresh database" / "shared database"; "customer: <id>"; "domain: <host>"; "workspace: <name>"; "operator: <email>" (also "owner:", and the pre-rename "fde:" for one release); "members: a@x, b@x"; "primary context: a, b, c" (corpus kinds, unknown ones become custom); "multiplayer: x, y, z" (processes, unknown ones become custom gaps); "accounts are called patients"; "clone of live"; "workflows: all|none" (the starter library; see below); "mold_v2". Field-by-field mapping to the mold: `docs/STATE.md`.

Steady state after the first confirmed intake: zero questions for a five-line brief; everything comes from the brief or defaults. Secrets are always by name; `provision.py` checks presence in the store and lists what the user still has to set.

## The starter library

A mold's base code carries no workflows or recipes of its own. The original product's (13 workflows and 5 onboarding
recipes, written for a team that delivers a platform to accounts) is kept in the mold as `library/account-delivery/`,
and an application gets it only by asking.

| the brief says | `library.install` | a new workspace starts with |
| --- | --- | --- |
| nothing, `workflows: none`, "no starter library", "without the workflow library" | `none` **(default)** | no library: only the app's own `scripts[]` and what its packs bring |
| `workflows: all`, `workflows: library`, "with the starter library", "the account-delivery library", "the original (product's) workflow library" | `all` | the account-delivery library |

With `all`, the stamp step names the library in the build's deployment profile (`build/<app_id>/profiles/40-library-account-delivery.json`,
copied from the mold; `library.py`) before the profile is generated; with `none` the file is left out and a stale copy is
removed. There is no subset by name (`listed` is refused by `factory.py validate`): write `none` and put the workflows
you want under `surface.custom_workflow_builder.scripts`.

Under `none`, intake does not write the library's workflows and recipes into a process's `implemented_by`, and leaves
`escalation.incident_workflow` out: state does not claim what no workspace has.

Changing the value later changes what NEW workspaces get. A workspace that already exists keeps its rows; see what an
earlier build left behind, and remove the untouched ones, with:

```
python3 .claude/scripts/provision.py <app_id> --library-cleanup            # a dry run: what would go, what stays and why
python3 .claude/scripts/provision.py <app_id> --library-cleanup --apply    # remove exactly what the dry run listed as removable
```

## Postgres providers

| provider | what it means | deployable to Vercel |
| --- | --- | --- |
| `neon` **(default)** | free Neon database on the Vercel Marketplace. `provision.py` first adopts an unattached free resource and proves it is EMPTY, then falls back to `vercel integration add neon` (verified: exits 0, no checkout page). `DATABASE_URL` is the pooled endpoint, `DATABASE_URL_UNPOOLED` the direct one for migrations. | yes |
| `supabase` | as before. The team's free tier is exhausted, so a new app dead-ends at a Marketplace checkout link. | yes, if you pay |
| `rds` | schema only; no provisioner. `provision.py` says so instead of failing obscurely. | no |
| `self_hosted` | a Postgres container on the app's own private docker network, **no host port ever**. Local verification only — `provision.py` exits if you pair it with `target: vercel`, because reaching it from a Vercel function would mean `hostssl ... 0.0.0.0/0`. See `infra/vm/README.md`. | no, by design |

The secret NAMES an app declares now follow its provider (`infrastructure.secrets_derived`):
`neon` adds `DATABASE_URL_UNPOOLED`, `supabase` adds `SUPABASE_URL` + `SUPABASE_POSTGRES_URL_NON_POOLING`,
`self_hosted` adds `POSTGRES_ADMIN_URL`. Before this, every app declared `SUPABASE_URL` — a name that
exists nowhere in the mold codebase, which `provision.py` then required before it would deploy, so a
non-Supabase app could never pass the gate.
`infrastructure.secrets_user` follows the inference provider the same way (next section). A name is only worth
requiring if the deploy delivers it: on `target: vercel` the process running `model.ts` is the `<project>-api`
deployment and the only list `provision.py` syncs onto it is `API_ENV`, so intake reads that list and refuses a
provider whose secret is not in it, instead of writing state that passes `--check` and runs without its key.
Both providers' names are in `API_ENV` today, so nothing is refused; the check stays in place for the next
provider. `target: vm` starts no process, so nothing is forwarded there.

## Inference providers

| `inference_provider` | `application.model` | `MODEL_PROVIDER` | `secrets_user` | forwarded to `<project>-api` (`API_ENV`) |
| --- | --- | --- | --- | --- |
| `cloudflare_workers_ai` **(default)** | `provider: cloudflare`, `model: @cf/zai-org/glm-5.2`, `context_window: 262144` (`factory.defaults.inference_model` overrides the id, for this provider only) | `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| `vercel_ai_gateway` | `provider: gateway`, `model: anthropic/claude-sonnet-5`, no `context_window` (`model.ts` returns undefined in gateway mode and eve looks it up) | `gateway` | `AI_GATEWAY_API_KEY`, `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` | `AI_GATEWAY_API_KEY`, plus the optional `GATEWAY_MODEL_ORCHESTRATOR`, `GATEWAY_MODEL_SPECIALIST`, `GATEWAY_REASONING_EFFORT` |

Plus `EXA_API_KEY` / `BROWSERBASE_API_KEY` in `secrets_user` when web search / the browser are on, for either
provider. `anthropic/claude-sonnet-5` is `agent/lib/model.ts`'s own default (lines 113-114): free-tier-safe, since the
gateway's free tier refuses Opus. The gateway branch reads no Cloudflare name, so a gateway app declares none. The
three `GATEWAY_*` names are optional and never asked for: set them on `<project>` by hand only to change the model
or the reasoning effort; absent, the mold defaults apply. Brief hints: `ai gateway` / `vercel's gateway` select the
gateway; `cloudflare workers ai` the default.

## What intake decides without asking

| Field | Rule |
| --- | --- |
| `datastores.postgres.rls` | follows tenancy, it is not a constant: `fail_closed` for a multi-workspace app, `on` for a single-workspace one. It used to be the literal `fail_closed` in every app — a claim nothing measured, beside a deployment that ran as a BYPASSRLS superuser. `provision.py` now has to prove it before the deploy finishes, and the proof is recorded in `datastores.postgres.rls_verified`. |
| `datastores.postgres.admin_url_ref` | the provider's own DDL endpoint name (`DATABASE_URL_UNPOOLED`, `SUPABASE_POSTGRES_URL_NON_POOLING`, `POSTGRES_ADMIN_URL`). Never `DATABASE_URL`: after the bootstrap that is `app_rw`, which owns nothing. |
| `datastores.postgres.pooling` | `transaction` for neon (the pooled endpoint at runtime, the direct one for migrations). |
| `network` / `host` / `port` / `database` / `exposure` | filled for `self_hosted` only: the app's own `sf-<app_id>` docker network, alias `db`, port 6543 inside the container, `private_docker_network`. |

## After intake

```
python3 .claude/scripts/provision.py <app>                  # read-only check: what exists, what a deploy will create, secrets by name (vm: regenerates the local artifact)
python3 .claude/scripts/provision.py <app> --set-secret NAME  # one credential at a hidden prompt; creates the three empty projects if absent, and says so first
python3 .claude/scripts/provision.py <app> --deploy         # vercel; prints "about to create:", refuses if a secret is missing, else creates the datastores and proves app_rw + RLS before DATABASE_URL is written
python3 .claude/scripts/provision.py <app> --verify-db      # vercel: creates projects + datastores and bootstraps the database (a writer); self_hosted / vm: bring the private Postgres up and run the whole chain
python3 .claude/scripts/provision.py <app> --verify-rls     # re-prove isolation on whatever is running now
python3 .claude/scripts/lanes.py <app>                      # the five lanes; a failure reverts the app and files a task
```

`--verify-db` is the local path for `self_hosted`: `.claude/scripts/lib/localpg.py` runs `postgres:17` on the
app's own docker network with TLS and **no published host port**, so nothing this factory builds ever opens
Postgres to the internet. It is a verification target, not a deploy target — pairing `self_hosted` with
`target: vercel` is refused with one sentence naming `postgres_provider=neon` as the fix.
