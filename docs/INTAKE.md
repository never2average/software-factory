# Intake questions

What the factory needs to know before it can stamp an application, and where each answer comes from. Resolution order: explicit answer > brief hint > confirmed factory default > built-in suggestion > ask.

| Id | Written to | Asked when | Options |
|---|---|---|---|
| deploy_target | infrastructure.target | brief silent and defaults unconfirmed | vercel, vm |
| postgres_provider | datastores.postgres.provider | defaults unconfirmed | supabase, neon, rds, self_hosted |
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
| workspace_name | application.surface.primary_context.workspace.name | brief silent and no factory default | free text |
| fde_email | application.surface.multiplayer_context.fde_self.email | brief silent and no factory default | email |
| library | application.surface.custom_workflow_builder.library.install | never (brief hint, default all) | all, none |

Brief hints recognised: "vercel" / "vm, droplet, self-host"; "no web search"; "no browser"; "single workspace"; "fresh database" / "shared database"; "customer: <id>"; "domain: <host>"; "workspace: <name>"; "fde: <email>"; "members: a@x, b@x"; "accounts are called patients"; "clone of live"; "workflows: all|none"; "mold_v2". Field-by-field mapping to the mold: `docs/STATE.md`.

Steady state after the first confirmed intake: zero questions for a five-line brief; everything comes from the brief or defaults. Secrets are always by name; `provision.py` checks presence in the store and lists what the user still has to set.
