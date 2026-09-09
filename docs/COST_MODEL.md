# Per-workspace inference cost model (mold_v1, GLM 5.2 on Cloudflare Workers AI)

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
| `C_stable` | the stable system prompt (identity, tools, policy) sent every call | PLACEHOLDER (tokens) — read it off `automation_runs.input_tokens` for a one-step turn | placeholder |
| `C_dyn_max` | the dynamic context caps in `agent/lib/prompt-context.ts` `CONTEXT_BUDGETS`: memory 1,200 + schedules 900 + rooms 500 + roster 700 + operator override 500 + agent configuration 600 + profile 500 + workflow definitions 1,400 | **6,300 tokens max** (each block is truncated at 4 chars/token) | measured (upper bound) |
| `W` | context window eve compacts against | 262,144 tokens (`CLOUDFLARE_CONTEXT_WINDOW` default) | measured |
| `S` | model calls (steps) per turn — one per tool round-trip | PLACEHOLDER | placeholder |
| `H` | conversation history re-sent per step (grows through a thread until compaction) | PLACEHOLDER | placeholder |
| `O_step` | output tokens per step, reasoning included | PLACEHOLDER | placeholder |
| `r_cache` | fraction of input served as cached input (Workers AI prices it separately; whether the OpenAI-compatible endpoint the mold uses reports cache hits is not measured) | PLACEHOLDER, use 0 for a conservative bound | placeholder |

Input tokens per turn:

```
I_turn = S * (C_stable + C_dyn + H)
O_turn = S * O_step
cost_turn = (I_turn * (1 - r_cache) * P_in + I_turn * r_cache * P_cached + O_turn * P_out) / 1e6
```

## 3. Volume per workspace (placeholders)

| Symbol | Meaning | Value | Kind |
|---|---|---|---|
| `U` | active people per workspace | PLACEHOLDER | placeholder |
| `T_user` | agent turns per active person per working day | PLACEHOLDER | placeholder |
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
