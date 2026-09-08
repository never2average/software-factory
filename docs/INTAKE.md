# Intake questions

What the factory needs to know before it can stamp an application, and where each answer comes from. Resolution order: explicit answer > brief hint > confirmed factory default > built-in suggestion > ask.

| Id | Written to | Asked when | Options |
|---|---|---|---|
| deploy_target | infrastructure.target | brief silent and defaults unconfirmed | vercel, vm |
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
| fde_email | application.workspace.fde_self.email | brief silent and no factory default | email |
| library | application.surface.custom_workflow_builder.library.install | never (brief hint, default all) | all, none |

Brief hints recognised: "vercel" / "vm, droplet, self-host"; "neon" / "supabase" / "self-host the postgres, database on the vm, local postgres"; "no web search"; "no browser"; "single workspace"; "fresh database" / "shared database"; "customer: <id>"; "domain: <host>"; "workspace: <name>"; "fde: <email>"; "members: a@x, b@x"; "primary context: a, b, c" (corpus kinds, unknown ones become custom); "multiplayer: x, y, z" (processes, unknown ones become custom gaps); "accounts are called patients"; "clone of live"; "workflows: all|none"; "mold_v2". Field-by-field mapping to the mold: `docs/STATE.md`.

Steady state after the first confirmed intake: zero questions for a five-line brief; everything comes from the brief or defaults. Secrets are always by name; `provision.py` checks presence in the store and lists what the user still has to set.

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

## What intake decides without asking

| Field | Rule |
| --- | --- |
| `datastores.postgres.rls` | follows tenancy, it is not a constant: `fail_closed` for a multi-workspace app, `on` for a single-workspace one. It used to be the literal `fail_closed` in every app — a claim nothing measured, beside a deployment that ran as a BYPASSRLS superuser. `provision.py` now has to prove it before the deploy finishes, and the proof is recorded in `datastores.postgres.rls_verified`. |
| `datastores.postgres.admin_url_ref` | the provider's own DDL endpoint name (`DATABASE_URL_UNPOOLED`, `SUPABASE_POSTGRES_URL_NON_POOLING`, `POSTGRES_ADMIN_URL`). Never `DATABASE_URL`: after the bootstrap that is `app_rw`, which owns nothing. |
| `datastores.postgres.pooling` | `transaction` for neon (the pooled endpoint at runtime, the direct one for migrations). |
| `network` / `host` / `port` / `database` / `exposure` | filled for `self_hosted` only: the app's own `sf-<app_id>` docker network, alias `db`, port 6543 inside the container, `private_docker_network`. |

## After intake

```
python3 .claude/scripts/provision.py <app>                  # secrets by name, local artifact, nothing deployed
python3 .claude/scripts/provision.py <app> --deploy         # vercel; proves app_rw + RLS before DATABASE_URL is written
python3 .claude/scripts/provision.py <app> --verify-db      # self_hosted / local: bring the private Postgres up and run the whole chain
python3 .claude/scripts/provision.py <app> --verify-rls     # re-prove isolation on whatever is running now
python3 .claude/scripts/lanes.py <app>                      # the five lanes; a failure reverts the app and files a task
```

`--verify-db` is the local path for `self_hosted`: `.claude/scripts/lib/localpg.py` runs `postgres:17` on the
app's own docker network with TLS and **no published host port**, so nothing this factory builds ever opens
Postgres to the internet. It is a verification target, not a deploy target — pairing `self_hosted` with
`target: vercel` is refused with one sentence naming `postgres_provider=neon` as the fix.
