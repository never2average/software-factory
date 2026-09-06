# Intake questions

What the factory needs to know before it can stamp an application, and where each answer comes from. Resolution order: explicit answer > brief hint > confirmed factory default > built-in suggestion > ask.

| Id | Written to | Asked when | Options |
|---|---|---|---|
| deploy_target | infrastructure.target | brief silent and defaults unconfirmed | vercel, vm |
| postgres_provider | datastores.postgres.provider | defaults unconfirmed | supabase, neon, rds, self_hosted |
| postgres_ref | datastores.postgres.url_ref | never (DATABASE_URL) | name only |
| postgres_scope | datastores.postgres.scope | always, per app | fresh, shared_with_live |
| blob_provider | datastores.blob.provider | defaults unconfirmed | vercel_blob, s3, gcs, azure_blob |
| inference_provider | infrastructure.inference.provider | defaults unconfirmed | cloudflare_workers_ai, vercel_ai_gateway |
| inference_account | infrastructure.inference.account_ref | provider is not cloudflare | name only |
| secret_store | infrastructure.secret_store | defaults unconfirmed | vercel_env, vm_env_file |
| web_search | application.capabilities.web_search | never (brief hint, default on) | true, false |
| browser | application.capabilities.browser | never (brief hint, default on) | true, false |
| customer_id | application.customer_id | never (brief hint, blank ok) | free text |
| custom_domain | infrastructure.vercel.custom_domain | never (brief hint, blank ok) | free text |

Brief hints recognised: "vercel" / "vm, droplet, self-host"; "no web search"; "no browser"; "customer: <id>"; "domain: <host>"; "mold_v2".

Steady state after the first confirmed intake: one question per app (postgres_scope), everything else from the brief or defaults. Secrets are always by name; `provision.py` checks presence in the store and lists what the user still has to set.
