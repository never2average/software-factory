# Per-workspace inference cost model (mold_v1, GLM 5.2 on Cloudflare Workers AI)

This costs the default provider only. An app stamped with `inference_provider: vercel_ai_gateway` runs
`anthropic/claude-sonnet-5` through the Vercel AI Gateway on `AI_GATEWAY_API_KEY` (`docs/INTAKE.md`, Inference
providers) and its per-turn price is `PLACEHOLDER` — nothing below applies to it, and no gateway turn has been measured.

A parametrised model. Every number is one of three kinds and is labelled: **measured** (from the mold's
code or a run on this factory), **fetched** (from a vendor page, with URL and date), or **PLACEHOLDER** (not
measured; fill it in from the app's own telemetry before quoting a price to anyone). Nothing here is
invented; if a value is a placeholder the formula still works, the result is just not a fact yet.

## 1. Prices (fetched)

Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ — fetched 2026-09-09. The model the
mold uses is `@cf/zai-org/glm-5.2` (`agent/lib/model.ts`, overridable with `CLOUDFLARE_MODEL`).

| Symbol | Value | Kind |
|---|---|---|
| `P_in` | $1.400 per M input tokens (127,273 neurons / M) | fetched |
| `P_cached` | $0.260 per M cached input tokens (23,636 neurons / M) | fetched |
| `P_out` | $4.400 per M output tokens (400,000 neurons / M) | fetched |
| neuron price | $0.011 per 1,000 neurons; 10,000 neurons/day free on the account | fetched |
| billing | GLM 5.2 requires a paid billing method (same page) | fetched |

Re-fetch before quoting: vendor pages change and this file records one reading.

## 2. Shape of a turn (measured in the mold, plus placeholders)

A **turn** is one user message to the agent and everything the model does until it answers. GLM 5.2 is a
thinking model: it streams `reasoning_content`, and reasoning tokens are **output** tokens at `P_out`.

| Symbol | Meaning | Value | Kind |
|---|---|---|---|
| `C_stable + C_dyn` | everything the model reads on a FIRST turn with no history: system prompt, tools, policy, dynamic context | **32,400 tokens** — two one-step turns on claudecode_web_replica (a one-word prompt, no tools, no history) each billed exactly 32,400 input tokens; Cloudflare `aiInferenceAdaptiveGroups`, 2026-09-14T16:30Z and 16:32Z | measured |
| `C_dyn_max` | the dynamic context caps in `agent/lib/prompt-context.ts` `CONTEXT_BUDGETS`: memory 1,200 + schedules 900 + rooms 500 + roster 700 + operator override 500 + agent configuration 600 + profile 500 + workflow definitions 1,400 | **6,300 tokens max** (each block is truncated at 4 chars/token) | measured (upper bound) |
| `W` | context window eve compacts against | 262,144 tokens (`CLOUDFLARE_CONTEXT_WINDOW` default) | measured |
| `S` | model calls (steps) per turn — one per tool round-trip | 1 on the one-word turn; for real work PLACEHOLDER — read `automation_runs` (steps per run) on the replica database, a read the factory session was not permitted to make on 2026-09-14 | measured (trivial) / placeholder (real work) |
| `H` | conversation history re-sent per step (grows through a thread until compaction) | PLACEHOLDER; the account-wide mean of 41,800 input tokens per GLM 5.3 call (Sep 5-14) against the 32,400 first-turn floor suggests H+tool results average ~9,400 per step in live use | placeholder (bounded) |
| `O_step` | output tokens per step, reasoning included | **4 tokens** on the one-word turn (no reasoning streamed); across every GLM 5.2 call on this account 2026-08-15..09-14 the mean is 56 output per call, and on GLM 5.3 (not this mold's model, but the same app shape) 2,028 | measured (one-word) / observed (account means) |
| `r_cache` | fraction of input served as cached input (Workers AI prices it separately; whether the OpenAI-compatible endpoint the mold uses reports cache hits is not measured) | PLACEHOLDER, use 0 for a conservative bound | placeholder |

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

## 3. Volume per workspace (placeholders)

| Symbol | Meaning | Value | Kind |
|---|---|---|---|
| `U` | active people per workspace | PLACEHOLDER — `select count(distinct email) from org_members` per org on the replica database (a copy of live), a read the factory session was not permitted to make on 2026-09-14; allow it or run it yourself | placeholder |
| `T_user` | agent turns per active person per working day | PLACEHOLDER — `chat_sessions` / `automation_runs` per day per email on the replica database, same permission | placeholder |
| `T_auto` | automated turns per workspace per day: four crons in `vercel.json`, schedules, connector-driven workflows (`automation_runs.automation_type`) | PLACEHOLDER | placeholder |
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
