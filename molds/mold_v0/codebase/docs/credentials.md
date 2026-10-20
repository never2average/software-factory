# Credentials: key vault, broker and inference gateway

**Goal.** Provider keys exist only in the encrypted vault on the server. Sub-agents in pods and sandboxes never
hold a real key. Orchestrator hosts hold only `OCTILLION_URL` and `OCTILLION_WORKER_TOKEN`.

```
operator ──vault CLI / admin API──▶ vault (Postgres, AES-256-GCM, master key OCTILLION_VAULT_KEY)
orchestrator ──POST /api/worker/orchestrator/credentials──▶ boat key + its own LLM access (gateway token)
orchestrator ──POST /api/worker/sessions/:id/credentials──▶ per-session env for the harness
sub-agent (pod / boat VM) ──ogw_ token──▶ /gw/<provider>/… ──real key from vault──▶ provider API
```

## Providers

| provider | mode | upstream | how the gateway authenticates upstream |
|---|---|---|---|
| `anthropic` | gateway | https://api.anthropic.com | `x-api-key` |
| `openai` | gateway | https://api.openai.com | `Authorization: Bearer` |
| `google` | gateway | https://generativelanguage.googleapis.com | `x-goog-api-key` |
| `dashscope` | gateway | https://dashscope-intl.aliyuncs.com | `Authorization: Bearer` |
| `github_copilot`, `cursor`, `amp`, `factory` | direct | vendor-hosted | the real key is brokered to the session (no proxy possible) |
| `boat` | direct (orchestrator only) | https://boat.dev/api/v1 | `Authorization: Bearer` |
| `vertex` | direct (orchestrator only) | Vertex AI | Google service-account JSON key (label `vertex`); Claude/Gemini on Vertex sign in with it |
| `exa`, `libraries_io`, `cloudflare` | server only | search, research quick pass | never reach a session |

**Vault only.** Every provider key is read from the vault at runtime; no code path reads a provider key from an
environment variable. On boot the server imports any provider key still set in its environment (Vercel) into the
vault once (`src/keyvault-env.ts`, label `imported from environment`, one marker per provider in `vault_env_imports`):
only when that provider has no enabled vault key, never overwriting one, and never again after the marker. The Key
vault page notes "Also set in the server environment — safe to delete there" for each such variable. Environment
variables that stay: `OCTILLION_VAULT_KEY` (the vault's own master key), infra secrets (`DATABASE_URL`,
`OCTILLION_WORKER_TOKEN`, `OCTILLION_ADMIN_TOKEN`, `CLERK_*`, `STRIPE_*`, `NEW_RELIC_*`, `POSTHOG_*`) and non-secret
config (URLs, model names, limits, `CLOUDFLARE_ACCOUNT_ID`).

`mode: gateway`: the sub-agent gets `base_url = {PUBLIC_URL}/gw/<provider>` and `api_key = ogw_…`. The gateway
accepts the token in any of `x-api-key`, `Authorization: Bearer`, `x-goog-api-key` or `?key=`. It strips it,
injects the real key, streams the request and response through, and meters usage.

`mode: direct`: the real key is returned by the broker for that one session, short-lived from Octillion's
side. Use it only for vendor-hosted agents that can't take a custom base URL.

## Worker API (Bearer `OCTILLION_WORKER_TOKEN`)

`POST /api/worker/orchestrator/credentials` `{orchestrator_id}` →
```json
{ "boat": {"api_key": "boat_…"} | null,
  "llm": {"provider": "openai", "model": "gpt-6.1-sol", "base_url": "https://host/gw/openai/v1", "api_key": "ogw_…", "expires_at": "…"} }
```
The server chooses the orchestrators' brain with `ORCHESTRATOR_PROVIDER` / `ORCHESTRATOR_MODEL` (default
`openai` / `gpt-6.1-sol`). `base_url` already includes the path SDKs expect: `/v1` for OpenAI.
The token is valid for 12h; refetch on 401 or near expiry.

`POST /api/worker/sessions/:id/credentials` (the session must be `running`) →
```json
{ "expires_at": "…",
  "providers": {
    "anthropic": {"mode": "gateway", "base_url": "https://host/gw/anthropic", "api_key": "ogw_…"},
    "openai":    {"mode": "gateway", "base_url": "https://host/gw/openai/v1", "api_key": "ogw_…"},
    "github_copilot": {"mode": "direct", "api_key": "<real token>"}
  },
  "env": { "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_API_KEY": "ogw_…", "OPENAI_BASE_URL": "…", "OPENAI_API_KEY": "ogw_…", "COPILOT_GITHUB_TOKEN": "…" } }
```
- `providers` lists those the session's agent needs, taken from the registry's `requires_env`.
- `env` is a suggested mapping for common CLIs. Harness adapters may map `providers` to their own variables
  instead, for example `GOOGLE_GEMINI_BASE_URL`.
- The token expires when the session finishes, or after `OCTILLION_LEASE_MINUTES`, whichever comes first.
- One token per session covers all of that session's gateway providers.

## Gateway limits

- **Per-session caps:** `OCTILLION_GATEWAY_MAX_COST_USD` (default $10, the main limit),
  `OCTILLION_GATEWAY_MAX_REQUESTS` (default 1000) and `OCTILLION_GATEWAY_MAX_TOKENS` (default 30M input+output, cache
  reads included; a backstop for unpriced models). Over a cap the gateway returns 429 with
  `{"error": {"type": "octillion_budget_exceeded"}}`.
- **Metering:** usage is recorded per session and provider: requests, input/output tokens parsed from JSON or SSE,
  and bytes.

## Anthropic through Google Cloud Vertex AI

The `anthropic` provider can switch from api.anthropic.com to Vertex AI without changing any harness. Agents keep
calling `/gw/anthropic/v1/messages` with their `ogw_` token. The gateway rewrites each call
(`src/vertex.ts`, from Anthropic's "Claude on Google Cloud" docs):

| Agent calls | Gateway sends |
|---|---|
| `POST /v1/messages` | `POST {host}/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:rawPredict`, or `:streamRawPredict` when `stream` is true |
| `POST /v1/messages/count_tokens` | `POST …/publishers/anthropic/models/count-tokens:rawPredict` |

What changes in the request:
- **Body:** `model` moves into the URL (it stays in the body for count-tokens), `anthropic_version: "vertex-2023-10-16"` is added, and `anthropic-beta` header values move into the body's `anthropic_beta`.
- **Model IDs:** current models use the first-party IDs (`claude-opus-5-5`, `claude-sonnet-5-5`). `backend_config.model_map` can override them.
- **Host:** `aiplatform.googleapis.com` for `global` (recommended), `aiplatform.{us|eu}.rep.googleapis.com` for multi-region, and `{region}-aiplatform.googleapis.com` for a single region. Single regions only serve Sonnet 4.6 and older models.
- **Auth:** a Google OAuth access token, minted from a service-account JSON key in the vault: the `vertex` provider's key (Key vault → Vertex AI: paste or upload the JSON; it must parse with `type: service_account`, `project_id`, `client_email` and `private_key`; the page shows only project and client email), or, for older setups, the `anthropic` credential with label `vertex`. It is cached for about an hour. Pods never see Google credentials.
- **Project and region:** the project from the service-account key, the region from the **Vertex AI region** setting (Agent configuration, `VERTEX_REGION`, default `us-east5`); `backend_config.project_id` / `region` override them per provider. The research quick pass (src/prospect.ts) also uses Claude on Vertex when the vault has no Anthropic key.
- **Other paths:** anything else (for example `/v1/models`) returns 404 on Vertex.

```bash
cd deploy && ./load-keys.sh          # answer the "vertex" prompts: project id, location, path to the key JSON
# or by hand:
npm run keyvault -- set vertex < service-account.json
npm run keyvault -- provider anthropic --backend vertex --vertex-project my-project --vertex-region global
npm run keyvault -- provider anthropic --backend direct      # switch back to api.anthropic.com
```
GCP prerequisites: a service account with `roles/aiplatform.user`, and the Claude models you run (Opus 5.5, Sonnet 5.5)
enabled for the project in Vertex AI Model Garden.
