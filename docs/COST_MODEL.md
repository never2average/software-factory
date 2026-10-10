# Per-workspace inference cost model (mold_v1 on Cloudflare Workers AI)

This costs the default provider only. An app stamped with `inference_provider: vercel_ai_gateway` runs
`anthropic/claude-sonnet-5` through the Vercel AI Gateway on `AI_GATEWAY_API_KEY` (`docs/INTAKE.md`, Inference
providers) and its per-turn price is `PLACEHOLDER` — nothing below applies to it, and no gateway turn has been measured.

A parametrised model. Every number is one of three kinds and is labelled: **measured** (from the mold's
code or a run on this factory), **fetched** (from a vendor page, with URL and date), or **PLACEHOLDER** (not
measured; fill it in from the app's own telemetry before quoting a price to anyone). Nothing here is
invented; if a value is a placeholder the formula still works, the result is just not a fact yet.

## 1. Prices (fetched)

Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ — fetched 2026-10-08 (first read 2026-09-09;
the GLM 5.2 row is unchanged). The mold's default is `@cf/zai-org/glm-5.2` (`agent/lib/model.ts`); an application
may name a model per role in `application.model.roles`, which the deploy writes as `CLOUDFLARE_MODEL_ORCHESTRATOR` /
`CLOUDFLARE_MODEL_SPECIALIST`, and the `read_image` tool uses `CLOUDFLARE_MODEL_VISION` (default
`@cf/zai-org/glm-5.3-flash`). Section 2b names what each app of `onfinance_hfc_research` runs.

| Model | `P_in` per M input | `P_cached` per M cached input | `P_out` per M output | Neurons per M (in / cached / out) | Kind |
|---|---|---|---|---|---|
| `@cf/zai-org/glm-5.2` | $1.400 | $0.260 | $4.400 | 127,273 / 23,636 / 400,000 | fetched 2026-10-08 |
| `@cf/zai-org/glm-5.3` | $1.400 | $0.260 | $4.400 | 127,273 / 23,636 / 400,000 | fetched 2026-10-08 |
| `@cf/zai-org/glm-5.3-flash` | $0.150 | $0.030 | $0.500 | 13,636 / 2,727 / 45,455 | fetched 2026-10-08 |
| `@cf/moonshotai/kimi-k2.6` | $0.950 | $0.160 | $4.000 | 86,364 / 14,545 / 363,636 | fetched 2026-10-08 |

Neuron price: $0.011 per 1,000 neurons, 10,000 neurons per day free on the account (same page, 2026-10-08). On
2026-09-09 the same page said GLM 5.2 requires a paid billing method. The app's own price table
(`lib/inference-pricing.ts`, which `GET /api/ops/usage` applies) carries the same four rows; it counts cached input
as part of input, priced at `P_cached`.

Re-fetch before quoting: vendor pages change and this file records one reading.

## 2. Shape of a turn (measured in the mold, plus placeholders)

A **turn** is one user message to the agent and everything the model does until it answers. GLM 5.2 is a
thinking model: it streams `reasoning_content`, and reasoning tokens are **output** tokens at `P_out`.

| Symbol | Meaning | Value | Kind |
|---|---|---|---|
| `C_stable + C_dyn` | everything the model reads on a FIRST turn with no history: system prompt, tools, policy, dynamic context | **32,400 tokens** — two one-step turns on claudecode_web_replica (a one-word prompt, no tools, no history) each billed exactly 32,400 input tokens; Cloudflare `aiInferenceAdaptiveGroups`, 2026-09-14T16:30Z and 16:32Z | measured |
| `C_dyn_max` | the dynamic context caps in `agent/lib/prompt-context.ts` `CONTEXT_BUDGETS`: memory 1,200 + schedules 900 + rooms 500 + roster 700 + operator override 500 + agent configuration 600 + profile 500 + workflow definitions 1,400 | **6,300 tokens max** (each block is truncated at 4 chars/token) | measured (upper bound) |
| `W` | context window eve compacts against | 262,144 tokens (`CLOUDFLARE_CONTEXT_WINDOW` default) | measured |
| `S` | model calls (steps) per turn — one per tool round-trip | 1 on the one-word turn. **The app now records this itself**: since upstream PR #12 (2026-09-14) every chat turn writes `chat_turn_usage` (steps, tokens, model) and `GET /api/ops/usage?days=N` sums it per workspace with the price applied; the first recorded turn matched Cloudflare's meter exactly (32,400 in, 4 out, $0.0454). Read `steps / turns` from that endpoint once people have used the workspace | measured (trivial); measured by the app going forward |
| `H` | conversation history re-sent per step (grows through a thread until compaction) | read `input_tokens / steps − 32,400` from `GET /api/ops/usage` once the workspace has real turns; until then the account-wide mean of 41,800 input tokens per GLM 5.3 call (Sep 5-14) against the 32,400 first-turn floor suggests ~9,400 per step | measured by the app going forward (bounded until then) |
| `O_step` | output tokens per step, reasoning included | **4 tokens** on the one-word turn (no reasoning streamed); across every GLM 5.2 call on this account 2026-08-15..09-14 the mean is 56 output per call, and on GLM 5.3 (not this mold's model, but the same app shape) 2,028 | measured (one-word) / observed (account means) |
| `r_cache` | fraction of input served as cached input (Workers AI prices it separately) | the endpoint does report cache hits: **37.5% on GLM 5.3 (`onfinance_hfc`), 81.4% on Kimi K2.6 (`onfinance_hfc_vm`)**, main-agent turns over 30 days to 2026-10-08 (section 2b). For another app or model, use 0 for a conservative bound until its own `GET /api/ops/usage` reads it | measured (these two apps) |

Input tokens per turn:

```
I_turn = S * (C_stable + C_dyn + H)
O_turn = S * O_step
cost_turn = (I_turn * (1 - r_cache) * P_in + I_turn * r_cache * P_cached + O_turn * P_out) / 1e6
```

## 2a. What one turn actually cost (measured 2026-09-14)

A one-word turn ("Reply with exactly one word: PONG") on the deployed replica, signed in, one model call,
no tools, no history — the floor under every turn this mold makes:

| | value | source |
|---|---|---|
| input tokens | 32,400 | Cloudflare analytics, `aiInferenceAdaptiveGroups` filtered to `@cf/zai-org/glm-5.2`, two samples identical |
| output tokens | 4 | same |
| neurons | 4,125.24 | same |
| **price** | **$0.0454 per turn** (4,125 neurons × $0.011 / 1,000; cross-checks with 32,400 × $1.40/M = $0.0454) | computed |
| inference time | 2.9 s and 3.9 s | same |

So the stable prompt alone is 4.5 cents per model call at list price. A turn that takes S tool steps
costs at least S × $0.045 before any history or output: ten steps is 45 cents, and that is the number
to watch when a workspace is quoted.

Account-wide observation over the same window (all workloads on this Cloudflare account, not only this
mold; refresh before quoting): GLM 5.2, 2026-08-15..09-14: 2,364 calls, 4.12M input, 133K output,
285,107 neurons ≈ **$3.14 for the month**. GLM 5.3 (a different, pricier model that something on this
account runs; 2026-09-05..09-14): 1,810 calls, 75.6M input, 3.67M output, 4.32M neurons ≈ **$47.5 in ten
days**, 41,800 input tokens per call. If the live app was moved to GLM 5.3, that is where the money goes.

To refresh: the Cloudflare connector's `execute` tool, `POST /graphql`, dataset `aiInferenceAdaptiveGroups`
with `sum { totalInputTokens totalOutputTokens totalNeurons }` and `dimensions { date modelId }`.

## 2b. Measured on `onfinance_hfc_research` (2026-10-08)

What the two apps run (from `application.model.roles` and the env names on each deployment, never values):
`onfinance_hfc` (Vercel) runs `@cf/zai-org/glm-5.3` as orchestrator and specialist; `onfinance_hfc_vm` (its own
server) runs `@cf/moonshotai/kimi-k2.6` as orchestrator and `@cf/zai-org/glm-5.3` as specialist. Neither sets
`CLOUDFLARE_MODEL` or `CLOUDFLARE_MODEL_VISION`, so image reading is `@cf/zai-org/glm-5.3-flash` on both.

Main-agent chat turns, workspace `onfinance-ai`, 30 days to 2026-10-08T13:25Z, read from each app's
`GET /api/ops/usage?days=30` (the `chat_turn_usage` table, priced with the section 1 rows):

| App | Model | Turns | Steps | Steps / turn | Input / step | Output / step | Cached share of input | Cost | Cost / turn | Kind |
|---|---|---|---|---|---|---|---|---|---|---|
| onfinance_hfc | all | 158 | 332 | 2.10 | 44,300 | 572 | 44.8% | $13.46 | $0.085 | measured |
| onfinance_hfc | glm-5.3 | 115 | 225 | 1.96 | 42,207 | 549 | 37.5% | $9.78 | $0.085 | measured |
| onfinance_hfc | kimi-k2.6 | 31 | 44 | 1.42 | 42,298 | 424 | 59.3% | $0.97 | $0.031 | measured |
| onfinance_hfc | glm-5.2 | 12 | 63 | 5.25 | 53,174 | 756 | 57.3% | $2.71 | $0.226 | measured |
| onfinance_hfc_vm | kimi-k2.6 | 345 | 567 | 1.64 | 21,540 | 201 | 81.4% | $4.20 | $0.012 | measured |

Read these with three cautions:

- **Most of this traffic is the factory's own testing**, not people: lane runs, the hand-back rig and the
  sandbox load checks all sign in to `onfinance-ai` (194 of the server's 345 turns fell on 2026-10-06, the day of
  the load checks). They measure what a turn costs, not how many turns a customer makes. `U` and `T_user` stay
  placeholders until real people use a workspace.
- **Specialist calls are not in these numbers.** `chat_turn_usage` holds the main agent only
  (`agent/hooks/chat-usage.ts`); specialists record into `automation_runs` through their own
  `agent/subagents/<id>/hooks/usage.ts`. `GET /api/ops/orgs/onfinance-ai/usage` returned **0 runs** in the same
  30 days on both apps, although specialists ran in that workspace in that window (mold_v1-199's evidence names one).
  Whether nothing was recorded or that route does not see what was recorded is not established, so the
  specialist share of the bill is `PLACEHOLDER`. On the server copy that is every GLM 5.3 call.
- The model mix on `onfinance_hfc` changed during the window (GLM 5.2, then Kimi K2.6, then GLM 5.3), so the
  per-model rows, not the total, describe the app as it runs now.

From these, for the main agent on the models deployed today: **about $0.085 per turn on `onfinance_hfc` and
$0.012 per turn on `onfinance_hfc_vm`** (measured), plus the specialists' calls (`PLACEHOLDER`). The cached share
is what separates them: Kimi on the server reused 81% of its input from cache, GLM 5.3 on Vercel 38%.

## 3. Volume per workspace (placeholders)

| Symbol | Meaning | Value | Kind |
|---|---|---|---|
| `U` | active people per workspace | **5 members in the main workspace (org-onfinance-ai), 2 of whom touched a chat in the last 30 days**; the other three workspaces have 2, 1 and 1 members and no chats. Replica database (a copy of live), `org_members` × `chat_sessions`, read 2026-09-14 | measured |
| `T_user` | agent turns per active person per working day | **≈ 0 recorded**: the database holds 5 chats in total, all created 2026-08-09..13, none in the last 30 days; mean 6.0 messages per chat (p50 5, p90 10.4), i.e. about 3 user turns per chat. Live usage is either not persisted here (chats sync from the browser) or genuinely this low — the Cloudflare side shows far more inference than this table explains, so treat the table as a floor, not the truth | measured (floor) |
| `T_auto` | automated turns per workspace per day: six crons in `vercel.json`, schedules, connector-driven workflows (`automation_runs.automation_type`) | **0.17 per day** (5 `schedule` runs in the last 30 days, 7 all time since 2026-08-12); `automation_runs` token columns are NULL on every run (workflow subagents fill them only for workflow turns); chat turns are in `chat_turn_usage` since PR #12 | measured |
| `D` | working days per month | 22 | assumption, edit |

```
turns_day  = U * T_user + T_auto
cost_day   = turns_day * cost_turn
cost_month = cost_day * D
```

## 4. Worked example — placeholders, not a quote

With `C_stable` = 4,000, `C_dyn` = 3,000, `H` = 6,000, `S` = 4, `O_step` = 800, `r_cache` = 0:

```
I_turn = 4 * 13,000 = 52,000 input tokens     -> 52,000 * 1.40 / 1e6 = $0.0728
O_turn = 4 * 800   =  3,200 output tokens     ->  3,200 * 4.40 / 1e6 = $0.0141
cost_turn ≈ $0.087
```

At `U` = 5, `T_user` = 20, `T_auto` = 50: 150 turns/day → $13.0/day → **≈ $287/month per workspace**. Every
input to that figure except the prices and `C_dyn_max` is a placeholder; the point of the example is that
**input tokens dominate** (history re-sent on every step), so `S` and `H` — how many tool steps a turn takes and
how long threads run before compaction — move the bill far more than output does.

## 5. Where to measure the placeholders (in the mold, no code change)

- `automation_runs` (`agent/lib/workflow-usage.ts`): per workflow turn, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, added step by step. Query per `org_id` per day for
  `T_auto`, `I_turn`, `O_turn`, `r_cache`.
- `deployments.input_tokens_30d`, `output_tokens_30d`, `llm_request_count_30d`, `cost_30d_usd`
  (`agent/lib/db/schema.ts`): the 30-day rollups the ops centre shows.
- Cloudflare dashboard → AI → Workers AI: the authoritative neuron count per day; divide by turns.
- `orgs.limits.monthlyTokenCap` / `monthlyCostUsdCap` exist on the org row and are editable in the ops centre
  (`PATCH /api/ops/orgs/<id>`), but mold_v1 does not **enforce** them — budget management is mold_v2 scope.

## 6. What this model does not cover

Vercel (function invocations, Blob storage and egress, the free-tier Neon database), Resend (sign-in codes and
invites), Exa (web search, if on), Browserbase (the browser subagent, if on). None of these is inference and
none is priced here.

## 7. The server, for an app on `target: vm_remote`

An app deployed to a server of its own (`docs/RUNBOOK.md` §9) pays for that server instead of for Vercel, Neon and
Blob. Inference is unchanged: sections 1-5 apply as they are.

| Line | Value | Kind |
|---|---|---|
| **the server: 8 GB / 4 vCPU with KVM, Ubuntu 24.04** | **$48.00 per month** ($0.07143 per hour): DigitalOcean Basic Droplet `s-4vcpu-8gb`, 8 GiB / 4 vCPUs / 160 GiB SSD / 5,000 GiB transfer. Source: https://www.digitalocean.com/api/static-content/v1/products?product_name=droplets, fetched 2026-10-08 (also 2026-10-06, `.claude/scripts/lib/vm_capacity.py` `PRICES_CHECKED`; and https://www.digitalocean.com/pricing/droplets, 2026-10-02). This is the plan `onfinance_hfc_vm` runs on: `infrastructure.vm_remote.health.box.plan` = `s-4vcpu-8gb` | fetched |
| why that size | the host check refuses anything under 8 GB / 4 vCPU / 20 GB free or without `/dev/kvm` (`.claude/scripts/lib/vm_remote.py` `HOST_MIN`). The eve build peaks at 2.9 GB, the prewarm at 2.5 GB, the three services rest at about 0.7 GB plus Postgres, and each agent sandbox is capped at 2 vCPU / 1024 MiB (`reports/vm-spike-mold_v1-072.md`, Memory and CPU) | measured (spike, stub model) |
| KVM on that plan | the factory's own VM is this plan and exposes `/dev/kvm` (nested). Whether a NEW droplet of the same plan does is checked per server by `provision.py <app> --qualify-remote` before anything is installed; many small VPS plans elsewhere do not | measured on one host; checked per server |
| concurrent sandboxes the server can hold, `N_sbx` | **2 running at once** on `onfinance_hfc_vm` (`infrastructure.vm_remote.health.box.sandbox_max_running`, derived from the box by `provision.py --capacity`, mold_v1-195: 2 vCPU / 1024 MiB each, 2048 MiB kept for the host); further sandboxes wait in line. The sandbox load checks of 2026-10-07 (`infrastructure.vm_remote.load_checks`) ran against that cap | measured |
| disk growth | stopped session sandboxes stay on disk until the nightly prune (mold_v1-153) removes them: 0.76 GB with nine templates, 2.3 GB after five sessions in the spike; on 2026-10-07 the server read 58% of its disk used, 81,778 MB of it sandbox store (`infrastructure.vm_remote.health`) | measured |
| database, file storage, TLS certificate | $0: Postgres and the files are on the server's own disk, the certificate is Let's Encrypt through Caddy | by construction |
| backups | PLACEHOLDER: DigitalOcean's backup add-on is priced as a percentage of the Droplet on the same page; nothing in this factory takes a backup of a vm_remote server yet | placeholder |
| the domain | whatever the operator already pays their registrar; one A record, no extra service | not priced |
| what a redeploy costs in downtime | **at most about 6 minutes**: the three redeploys of `onfinance_hfc_vm` on 2026-10-07 each ran 5 min 53 s to 6 min 4 s from start (`deployed_at`, stamped as the run starts) to the last line of the run's log, and the services are down only from the `[build]` step (services stopped, build in place) to `[units]`, so the outage is shorter than the run. Not timed step by step. Since mold_v1-222 a deploy builds, migrates and prewarms the new release beside the serving one and the outage is each service's own restart at the switch (seconds; the API's prestart only clears locks), with an automatic switch back on a failed start or health check | measured (upper bound, before mold_v1-222) |

```
cost_month(vm_remote) = server_month + cost_month(inference, sections 1-5)
                      = $48.00 + turns_day * cost_turn * D
```

Re-fetch the price before quoting it, and price the plan the server was actually created on (`infrastructure.vm_remote.provider`).

