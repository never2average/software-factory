# Per-workspace inference cost model (mold_v1 on Cloudflare Workers AI)

This costs the default provider only. An app stamped with `inference_provider: vercel_ai_gateway` runs
`anthropic/claude-sonnet-5` through the Vercel AI Gateway on `AI_GATEWAY_API_KEY` (`docs/INTAKE.md`, Inference
providers) and its per-turn price is `PLACEHOLDER` — nothing below applies to it, and no gateway turn has been measured.

A parametrised model. Every number is one of three kinds and is labelled: **measured** (from the mold's
code or a run on this factory), **fetched** (from a vendor page, with URL and date), or **PLACEHOLDER** (not
measured; fill it in from the app's own telemetry before quoting a price to anyone). Nothing here is
invented; if a value is a placeholder the formula still works, the result is just not a fact yet.

## 1. Prices (fetched)

Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ — fetched 2026-10-10 (also 2026-10-08; first read
2026-09-09; all four rows below unchanged since they were first read). The mold's default is `@cf/zai-org/glm-5.2` (`agent/lib/model.ts`); an application
may name a model per role in `application.model.roles`, which the deploy writes as `CLOUDFLARE_MODEL_ORCHESTRATOR` /
`CLOUDFLARE_MODEL_SPECIALIST`, and the `read_image` tool uses `CLOUDFLARE_MODEL_VISION` (default
`@cf/zai-org/glm-5.3-flash`). Section 2b names what each app of `onfinance_hfc_research` runs.

| Model | `P_in` per M input | `P_cached` per M cached input | `P_out` per M output | Neurons per M (in / cached / out) | Kind |
|---|---|---|---|---|---|
| `@cf/zai-org/glm-5.2` | $1.400 | $0.260 | $4.400 | 127,273 / 23,636 / 400,000 | fetched 2026-10-08 |
| `@cf/zai-org/glm-5.3` | $1.400 | $0.260 | $4.400 | 127,273 / 23,636 / 400,000 | fetched 2026-10-08 |
| `@cf/zai-org/glm-5.3-flash` | $0.150 | $0.030 | $0.500 | 13,636 / 2,727 / 45,455 | fetched 2026-10-08 |
| `@cf/moonshotai/kimi-k2.6` | $0.950 | $0.160 | $4.000 | 86,364 / 14,545 / 363,636 | fetched 2026-10-08 |

Neuron price: $0.011 per 1,000 neurons, 10,000 neurons per day free on the account (same page, 2026-10-10). On
2026-10-10 the same page says all four models require a paid billing method (Workers Paid or prepaid AI Gateway credits). The app's own price table
(`lib/inference-pricing.ts`, which `GET /api/ops/usage` applies) carries the same four rows (its own sources: the
pricing page read 2026-09-09 for GLM 5.2; the account's Workers AI model catalogue read 2026-09-19 for the other three;
every row equal to the pricing page on 2026-10-10); it counts cached input as part of input, priced at `P_cached`.
`app_usage.py` prices with the same table.

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
  Whether nothing was recorded or that route does not see what was recorded was not established on 2026-10-08.
  **Superseded 2026-10-10:** `python3 .claude/scripts/app_usage.py --all --json` reads `automation_runs` directly (as
  the app role, under row-level security) and finds the specialist runs; section 2c prices them.
- The model mix on `onfinance_hfc` changed during the window (GLM 5.2, then Kimi K2.6, then GLM 5.3), so the
  per-model rows, not the total, describe the app as it runs now.

From these, for the main agent on the models deployed today: **about $0.085 per turn on `onfinance_hfc` and
$0.012 per turn on `onfinance_hfc_vm`** (measured), plus the specialists' calls (section 2c). The cached share
is what separates them: Kimi on the server reused 81% of its input from cache, GLM 5.3 on Vercel 38%.

## 2c. Inference budget per workspace for `onfinance_hfc_research` (2026-10-10)

The released-stage budget (mold_v1-212). Every figure is labelled **measured** (read from the app's own tables),
**fetched** (section 1) or **estimated** (a scenario or a model, with the arithmetic shown). The customer's
workspace is called "the customer workspace"; workspaces are never named by company here.

**Source of every measured figure:** `python3 .claude/scripts/app_usage.py --all --json`, run 2026-10-10T20:24Z, window
30 days (2026-09-11..10-10). It reads each app's own database as the app role under row-level security:
`chat_turn_usage` for the main agent (cost **recorded**: the model each turn recorded, priced with the app's price
table) and `automation_runs` of type workflow for the specialists (cost **recorded** since upstream #141, which writes
cost and model per step; runs before #141 recorded tokens only and are **estimated** at the specialist's configured
model, `@cf/zai-org/glm-5.3`, with the same table; app_usage labels each figure `recorded`, `estimated` or `mixed`).
Prices: section 1 (`lib/inference-pricing.ts`, equal to the Cloudflare pricing page fetched 2026-10-10).

### Per chat turn (main agent)

| App (orchestrator model) | Turns | Input / turn | Output / turn | Cost / turn | Kind |
|---|---|---|---|---|---|
| `onfinance_hfc` (GLM 5.3) | 182 | 87,069 | 1,071 | **$0.080** ($14.59 / 182) | measured, recorded |
| `onfinance_hfc_vm` (Kimi K2.6) | 379 | 35,058 | 315 | **$0.012** ($4.58 / 379) | measured, recorded |

Both windows are almost all before prompt-cache affinity went live (upstream #142, 2026-10-09). The before/after
measurement on mold_v1-220 (five chats per app, same shape, read from the same tables) moved the main agent's cached
share from 28.6% to 61.4% on `onfinance_hfc` ($0.550 -> $0.342 for the five, -38%) and from 83.9% to 88.7% on
`onfinance_hfc_vm` ($0.1015 -> $0.0903, -11%). So the same turn now costs less than these 30-day means by about
those percentages; the means are kept as the budget figure because they are the larger sample (measured).

### Per specialist run (all specialists run `@cf/zai-org/glm-5.3`)

What a run costs is set by how much it reads, which varies by two orders of magnitude between a quick lookup and a
research run over whole filings. Three sizes, each measured:

| Run size | Input per run | Where it was measured | Cost per run |
|---|---|---|---|
| **small** (a lookup: six shell commands) | ~97,000 | mold_v1-220, 5 `lodr-filings` runs per app after #142, 2026-10-09 | **$0.036** on `onfinance_hfc` ($0.1781 / 5; 91.5% cached), **$0.040** on `onfinance_hfc_vm` ($0.1984 / 5; 88.2% cached) — measured, recorded |
| **typical** (the operator's own research runs) | 0.85M-6.91M for the six research runs named on mold_v1-220 (median 3.3M); the 47 also hold smoke runs of 10-27k | mean of the 47 runs in the operator's workspace on `onfinance_hfc` | **$0.50 mean** ($23.33 / 47, `mixed`: most runs before #141 are estimated) |
| **heavy** (full-document research in the customer workspace) | 0.07M-18.25M, seven of the nine over 3.5M (mold_v1-220) | mean of the 9 runs in the customer workspace on `onfinance_hfc` | **$6.43 mean** ($57.87 / 9, estimated: all 9 ran before #141); 39.6% of their input was cache reads (mold_v1-220) |

The 238 runs on `onfinance_hfc_vm` average $0.029 ($6.94 / 238, `mixed`), but most are the factory's own smoke and
load checks, so they are not used as a size.

How the price of a run scales (estimated; output taken as 1.4% of input, the ratio measured over the
customer workspace's `lodr-filings` runs and the operator's on `onfinance_hfc`: 293,276 / 20,912,169 and
183,049 / 13,040,477):

```
cost_run = I_run * ((1 - r) * $1.40 + r * $0.26 + 0.014 * $4.40) / 1e6
         = $1.46 per M input with no cache, $1.01 at r = 39.6% (measured, big runs before #142), $0.46 at r = 88% (measured, small runs after #142)
```

Cache affinity has been measured only on small runs. Whether a heavy run now reaches 88% is **not measured**; if it
does, a $6.43 heavy run would cost about $2.92 (estimated). Caching lowers the price, not the tokens: the step and
size caps that would shrink heavy runs are still open on mold_v1-220.

### Specialist runs per chat turn

**0.26** (measured): 47 specialist runs per 182 chat turns in the operator's workspace on `onfinance_hfc`. The
server copy's 0.63 (238 / 379) is inflated by the load checks of 2026-10-06 and is not used.

### Scheduled starter apps (a workspace that has them)

`operator:new-org` gives a NEW workspace the build's starter library (on these apps the `hfc-research` library: four
apps, measured 2026-10-10 on `onfinance_hfc_vm`), and each refreshes on a schedule whether anyone opens it or not:
"New LODR filings this week" every weekday 02:30 (`30 2 * * 1-5`, about 22 a month), "Latest quarter KPI table" and
"Guidance tracker" weekly, "Annual report extract status" monthly (`packs/hfc-research/files/library/hfc-research/apps.json`):
about 31.6 refreshes a month.

| Line | Value | Kind |
|---|---|---|
| one "New LODR filings this week" refresh | 3.51M and 5.63M input (the customer workspace, 2026-10-06 and 10-07) -> **$4.62** each at r = 39.6% | measured tokens, estimated price |
| the other three, per refresh | no refresh measured; priced as a typical research run, 3.3M -> $3.37 | estimated |
| **starter apps, per workspace per month** | 22 x $4.62 + 9.6 x $3.37 = **about $134** at r = 39.6%, **about $61** at r = 88% | estimated |

A refresh that stops at an approval nobody answers keeps its row `running` (mold_v1-220), so it does not repeat the
spend, but it does not finish either.

### Per active user per month

```
user_month = D * T_user * (cost_turn + 0.26 * cost_run)          D = 22 working days (assumption)
```

`T_user`, chat turns per person per working day, is a **scenario**: only one person has used either app (the operator;
`people_active` = 1 on both). The one measured rate: 99 turns over 15 active days on `onfinance_hfc` (6.6 per active
day), leaving out 2026-10-06, whose 83 turns were the factory's lane and rig runs. "Typical" uses that rate, rounded.

| Scenario | `T_user` | Run size | `onfinance_hfc` (Vercel) | `onfinance_hfc_vm` (own server) |
|---|---|---|---|---|
| light | 3 a day (66 a month) | small, $0.036 | **$5.90** ($5.29 chat + 17 runs $0.61) | **$1.41** ($0.80 chat + $0.61) |
| typical | 7 a day (154 a month) | typical, $0.50 | **$32** ($12.34 chat + 40 runs $19.74) | **$22** ($1.86 chat + $19.74) |
| heavy | 20 a day (440 a month) | heavy, $6.43 | **$766** ($35.27 chat + 114 runs $730.58); about $367 if heavy runs cache at 88% | **$736**; about $337 at 88% |

All rows are **estimated** (scenario volumes times measured unit costs). The point they make is measured: **the
specialists' research runs, not chat, are the bill**. At typical use specialists are 60-90% of the cost, at heavy use
over 95%, and one heavy research run costs as much as 80 chat turns on Vercel or 530 on the server.

### Per workspace per month

```
workspace_month = U * user_month + starter_apps (if the workspace has them) + server (vm_remote only, section 7)
```

Example (estimated): five people at typical use with the starter apps, on the server: 5 x $22 + $134 = **about $244**
in inference, plus the $48 server; on Vercel 5 x $32 + $134 = **about $294**. At light use without the starter apps:
5 x $1.41 = about $7 on the server, 5 x $5.90 = about $30 on Vercel.

**What would make these figures facts rather than scenarios:** a month of a customer's real people in a workspace
(`app_usage.py <app_id>` reads `T_user` and runs per turn per workspace), and one heavy run measured after #142 for
its cached share. Neither cap nor budget is enforced by mold_v1 (section 5), so a heavy month is not stopped by the
app; `app_usage.py` is how the operator sees it coming.

## 3. Volume per workspace (placeholders)

The general model, read on 2026-09-14 from a replica of another product's database. For `onfinance_hfc_research` the
measured volumes (turns, specialist runs per turn, starter-app refreshes) and the budget built from them are in section 2c.

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
| **the server: 8 GB / 4 vCPU with KVM, Ubuntu 24.04** | **$48.00 per month** ($0.07143 per hour): DigitalOcean Basic Droplet `s-4vcpu-8gb`, 8 GiB / 4 vCPUs / 160 GiB SSD / 5,000 GiB transfer. Source: https://www.digitalocean.com/api/static-content/v1/products?product_name=droplets, fetched 2026-10-10, monthly "48" and hourly "0.07143" (also 2026-10-08, 2026-10-06, `.claude/scripts/lib/vm_capacity.py` `PRICES_CHECKED`; and https://www.digitalocean.com/pricing/droplets, 2026-10-02). This is the plan `onfinance_hfc_vm` runs on: `infrastructure.vm_remote.health.box.plan` = `s-4vcpu-8gb` | fetched |
| why that size | the host check refuses anything under 8 GB / 4 vCPU / 20 GB free or without `/dev/kvm` (`.claude/scripts/lib/vm_remote.py` `HOST_MIN`). The eve build peaks at 2.9 GB, the prewarm at 2.5 GB, the three services rest at about 0.7 GB plus Postgres, and each agent sandbox is capped at 2 vCPU / 1024 MiB (`reports/vm-spike-mold_v1-072.md`, Memory and CPU) | measured (spike, stub model) |
| KVM on that plan | the factory's own VM is this plan and exposes `/dev/kvm` (nested). Whether a NEW droplet of the same plan does is checked per server by `provision.py <app> --qualify-remote` before anything is installed; many small VPS plans elsewhere do not | measured on one host; checked per server |
| concurrent sandboxes the server can hold, `N_sbx` | **2 running at once** on `onfinance_hfc_vm` (`infrastructure.vm_remote.health.box.sandbox_max_running`, derived from the box by `provision.py --capacity`, mold_v1-195: 2 vCPU / 1024 MiB each, 2048 MiB kept for the host); further sandboxes wait in line. The sandbox load checks of 2026-10-07 (`infrastructure.vm_remote.load_checks`) ran against that cap | measured |
| disk growth | stopped session sandboxes stay on disk until the nightly prune (mold_v1-153) removes them: 0.76 GB with nine templates, 2.3 GB after five sessions in the spike; on 2026-10-07 the server read 58% of its disk used, 81,778 MB of it sandbox store (`infrastructure.vm_remote.health`) | measured |
| database, file storage, TLS certificate | $0: Postgres and the files are on the server's own disk, the certificate is Let's Encrypt through Caddy | by construction |
| backups | PLACEHOLDER: DigitalOcean's backup add-on is priced as a percentage of the Droplet on the same page; nothing in this factory takes a backup of a vm_remote server yet | placeholder |
| the domain | whatever the operator already pays their registrar; one A record, no extra service | not priced |
| what a redeploy costs in downtime | **Since 2026-10-10 (mold_v1-222, -223): about 1-2 s for the web app and 5-15 s for chat, once per deploy.** The new release is built, migrated and its sandboxes prewarmed beside the serving one; only the switch interrupts, by restarting the three services. Measured at the switch of 2026-10-10T19:54:52Z (`journalctl` of the three units, read-only): web app stopped to ready in 0.55 s, task-workflow 0.48 s, the agent API stopped to listening in 2.66 s; a chat in progress also has to reconnect, which is where the 5-15 s comes from (the factory's figure, not timed per chat). If the new release does not start or fails its health check, the server switches back to the previous one by itself (`release-switch-<id>.log` on the server records `HEALTH=` and `SWITCHED=`), and `provision.py <app> --rollback-remote` does the same by hand. Before 2026-10-10 a redeploy built in place and was down for up to about 6 minutes (three redeploys on 2026-10-07 ran 5 min 53 s to 6 min 4 s). What to tell customers: `docs/customer-notes/updates.md` | measured (one switch) + the factory's stated envelope |

```
cost_month(vm_remote) = server_month + cost_month(inference, sections 1-5)
                      = $48.00 + turns_day * cost_turn * D
```

Re-fetch the price before quoting it, and price the plan the server was actually created on (`infrastructure.vm_remote.provider`).


## 8. mold_v0 apps (the MCP product shell): ceilings known, cost not measured yet

This model prices mold_v1 on Cloudflare. A mold_v0 app's model spend is per **run** (an audit, on `maxwell`), metered
by the shell's own inference gateway for every call a run makes, and shown per run on the console's **Overview**
(Audit cost) and **FinOps**. What is known on 2026-10-29:

| Figure | Value | Source |
|---|---|---|
| ceiling on one audit's model spend (`maxwell`) | US$40 | `state/application/maxwell/application.json` `profile.limits.runs.budget_usd_max`; the operator's brief, `## Budgets`, 2026-10-22 |
| ceiling per audit kind, per company, per month (`maxwell`) | US$500 | the same file, `profile.limits.runs.kind_month_budget_usd` |
| the shell's defaults for the same two ceilings | US$25 and US$200 | `molds/mold_v0/codebase/src/rate-limits.ts` `DEFAULTS.runs` |
| model `maxwell`'s audits run | Claude Opus 5.5 (`claude-opus-5-5`, every alias) | `packs/maxwell` `job_kinds[].agent.env` |
| what one audit actually costs, by kind | PLACEHOLDER | measured by the first end-to-end audit (ticket mold_v0-030), from the gateway's metered usage |
| audits per company per month | PLACEHOLDER | no customer usage yet |

Until the two placeholders are measured, the ceilings are the only figures: a company's worst case is at most US$500
per audit kind per month, and the staff-set monthly allowance (`docs/PRODUCTS.md`, "mold_v0: packaging and pricing")
caps the whole account below that.
