# Harness registry

`registry.json` lists every coding agent the fleet can run, as a harness (CLI) plus a model, with a pinned
harness version, a worker image and a **weight**. The weight is that agent's share of real-world developer
usage, renormalized over the agents we can actually run. A default ("representative") simulation samples
agents in proportion to these weights, so a customer's adoption numbers reflect the mix of agents developers
really use, not an equal-weight mix.

As of **2026-10-10**. Next review: **2027-01-10**.

## Current weights

| agent | weight | usage share | runnable? | key evidence |
|---|---:|---:|---|---|
| claude-code/opus (claude-opus-5-5) | 0.2993 | 27.4% | yes | JetBrains 2026 (39% work use), SO 2026, Amplifying model mix |
| claude-code/sonnet (claude-sonnet-5-5) | 0.1046 | 9.6% | yes | same |
| codex/default (gpt-6.1-sol) | 0.1965 | 18% | yes | JetBrains 2026 (16%, up from 3% in Jan), >5M WAU, npm |
| copilot/auto | 0.1419 | 13% | proxy (Copilot CLI) | JetBrains 2026 (21%), SO 2026 (59% of agent users) |
| cursor/auto | 0.1092 | 10% | proxy (cursor-agent) | JetBrains 2026 (12%), Pragmatic Engineer 2026 |
| opencode/sonnet | 0.0546 | 5% | yes | JetBrains 2026 (7%), npm 3M/wk |
| antigravity/default | 0.0327 | 3% | proxy (agy CLI) | JetBrains 2026 (6%) |
| gemini-cli/auto | 0.0164 | 1.5% | yes | Pragmatic Engineer (~10% of agent users, Feb), npm falling |
| pi/opus | 0.0164 | 1.5% | yes | npm 0.6M/wk, no survey data |
| cline/sonnet | 0.0109 | 1.0% | proxy (Cline CLI) | SO 2025 (Cline+Roo 2.2%) |
| kilo/sonnet | 0.0054 | 0.5% | proxy (Kilo CLI) | SO 2025 bucket, npm |
| amp/default | 0.0044 | 0.4% | yes | npm 20k/wk (long tail) |
| droid/default (gpt-6.1-sol) | 0.0044 | 0.4% | yes | long tail |
| qwen-code/default | 0.0033 | 0.3% | yes | npm 80k/wk (long tail) |
| **not runnable** (Junie 2.5, Windsurf/Devin 1.5, Kiro 1.0, Jules 0.8, Roo 0.5, Augment, Warp, Aider, Trae 0.4 each, Zed 0.3, Continue 0.2) | 0 | **8.4%** | no | `unrepresented_share` |

The "usage share" column is the estimate of share of *all* agentic-coding usage. The weights are those shares
divided by 0.916, the runnable total. **27.5%** of usage (Copilot, Cursor, Antigravity, Cline, Kilo) is
`proxy_represented_share`. For these tools most usage happens in an IDE, so we run the vendor's own headless CLI
as a stand-in. The vendor, models and much of the agent loop are the same, but the IDE system prompt and tools
are not.

## How the weights were derived

The target quantity is **share of developers' agentic-coding usage by harness, October 2026**. No source
measures this directly, so we triangulated:

1. **Anchor: JetBrains Developer Ecosystem 2026** (`jb2026`). It has >15k professional developers, May–Jul 2026,
   reweighted by region, employment, language and JetBrains familiarity. Its work-use figures are Claude Code
   39%, Copilot 21%, Codex 16%, Cursor 12%, JetBrains AI ~9%, OpenCode 7% and Antigravity 6%. This is the
   largest recent weighted sample with per-tool numbers, and we normalized it to 100.
2. **Intensity adjustments.** Adoption is not usage. Using the sources below, we moved Claude Code and Codex up
   and Copilot and Cursor down, since Copilot and Cursor have breadth but lighter agent use.
   - SO 2026 (`so2026`): Claude Code 66% vs Copilot 59% of coding-agent users.
   - Pragmatic Engineer 2026 (`pe2026`): Claude Code 71%, Copilot 46%, Cursor 39% among regular agent users,
     with Claude Code "most loved".
   - Vendor numbers: Codex >5M WAU (`codex-wau-2026`) and Cursor >$4B ARR (`cursor-arr-2026`).
   - Public-GitHub attribution (`amplifying-index`, `semianalysis2026`).
3. **Long tail.** Pi, Amp, droid, Qwen Code, Aider, Augment, Continue, Warp and Trae have no survey numbers. They
   share about 3–5%, ranked by npm/PyPI downloads (`npm-2026-10`, `pypi-aider`). These are **±100%**.
4. **Ranges → midpoints** (percent of agentic usage):

   | tool | range | midpoint |
   |---|---|---|
   | Claude Code | 30–44 | 37 |
   | Codex | 13–24 | 18 |
   | Copilot | 9–18 | 13 |
   | Cursor | 7–14 | 10 |
   | OpenCode | 3–7 | 5 |
   | Antigravity + Gemini CLI | 2.5–7 | 4.5 (Antigravity 3, Gemini CLI 1.5) |
   | Junie | 1.5–4 | 2.5 |
   | Cline / Roo / Kilo | 1–3 | 2 |
   | Pi | 0.5–3 | 1.5 |
   | Windsurf / Devin | 0.5–3 | 1.5 |
   | Kiro | 0.3–2 | 1 |
   | Jules | 0.3–1.5 | 0.8 |
   | long tail | 2–5 | 3.2 |

   The midpoints sum to 100.
5. **Runnable filter.** A harness counts as runnable if it meets all of the following:
   - installs on Linux;
   - runs non-interactively with tool auto-approval;
   - authenticates with an API key or token passed through the environment;
   - emits a **JSON event stream**, which the scorer needs to see tool calls and edits.

   Runnable harnesses get `enabled: true`. Their usage share is renormalized to weights that sum to 1 (4 dp,
   largest remainder). The rest is `unrepresented_share` (0.084), with a per-tool breakdown in
   `unrepresented_breakdown`.
6. **Model splits.** We split a harness by model only where there is data. For Claude Code, the
   Amplifying.ai model mix of Claude-attributed public commits (Aug 10–Oct 4 2026) gives Opus 74.1% and
   Sonnet 25.3%; Haiku's 0.5% is folded into Sonnet. Every other harness runs its default model.

### Splitting a harness by model

The fleet runs one pod group per registry agent, so each popular model inside a harness should be its own agent. A
harness is split only when both of these hold:

- A cited source shows a **second model with at least 20%** of that harness's usage.
- That source covers a **representative slice** of the harness's users, not just one gateway's traffic.

When a harness is split:

- Its agents are named `<harness>/<model-slug>`.
- Their weights sum to the harness's previous weight.
- Each split carries its own `weight_source`.
- All splits share `image`, `requires_env`, `event_format` and `worker_adapter`.
- Each model id must be confirmed selectable in the pinned CLI before `model_verified` is set.

Review on 2026-10-10 (each agent's `model_mix` field holds the details):

| harness | decision | why |
|---|---|---|
| claude-code | **split** Opus 0.2993 / Sonnet 0.1046 | Amplifying.ai commit model mix: 74.1% / 25.9% |
| opencode | not split (best candidate) | OpenCode's own stats show hosted Zen/Go traffic led by DeepSeek V4.1 Flash, a stealth model and Muse Spark (~25% each). BYOK usage such as Anthropic is invisible there, so the hosted/BYOK ratio is unknown. A hosted-model split would also need the adapter to pass an OpenCode or DeepSeek key |
| codex | not split | Only the OpenRouter-routed slice is visible (gpt-6-luna 20.4%, gpt-6-astra 18.6%, gpt-6.1-sol 6%). That slice excludes ChatGPT-login usage, which is most of Codex |
| pi, cline, kilo | not split | OpenRouter slices only. They are led by DeepSeek or a stealth model, with no stable second model at or above 20% |
| cursor, copilot, gemini-cli, amp, droid, qwen-code, antigravity | not split | No published per-model shares. Gemini's Auto and Cursor's Auto already route between models server-side |

Selectability was checked in the pinned images:

| harness | command | ids confirmed |
|---|---|---|
| copilot | `copilot help config` | claude-sonnet-5.5, gpt-6.1-sol, gemini-3.8-flash, … |
| opencode, kilo | `opencode models`, `kilo models` | anthropic/claude-*-5-5, openai/gpt-6.1-sol |
| pi | `pi --list-models` | claude-opus-5-5, gpt-6.1-sol |
| codex | bundled catalog | gpt-6.1-sol, gpt-6-astra, gpt-6-luna |
| gemini-cli | bundle constants | gemini-3.1-pro-preview, gemini-3.x-flash |

Any future split can use these ids directly. Cursor's model slugs come from its server and could not be checked
offline.

The usual sources of model-mix evidence are below. Recheck them each quarter:

- **OpenRouter app pages** (`openrouter.ai/apps/<app>`). These show only traffic routed through OpenRouter, and they skew
  toward free and cheap models.
- **opencode.ai/stats**. This counts hosted models only.
- **Amplifying.ai** commit trailers. These exist for Claude Code only.
- Vendor announcements.

**What we did not use.** The Amplifying.ai "picks" studies and the Armature study (`armature2026`) measure what
agents *choose*, not how much they are used. They are relevant to a product that measures agents' choices, but not to weights.
Menlo's enterprise LLM-API share (`menlo2025`) is model-vendor share and is used only as a cross-check.

### Uncertainty (read before quoting numbers)

- **Survey bias.** Surveys over-sample engaged developers. JetBrains carries JetBrains-user bias even after
  reweighting. Pragmatic Engineer skews senior and small-company. SO 2026 does not report a respondent base for
  its agent percentages.
- **Copilot is the biggest swing factor.** It dominates large enterprises and seat counts (4.7M paid), but much
  of that is completions, not agent use. Plausible range 9–18%.
- **npm is a poor user proxy.** Codex's 21M weekly downloads are inflated by CI and SDK pulls, and Claude Code
  moved to a native installer, so its npm number is a floor. We only use npm to rank the long tail.
- **Asia is under-covered.** Usage in China and wider Asia (Trae, Qwen Code, Kimi) is under-captured by every
  Western survey.
- **Model ids.** `model_verified: true` only where we read the id from the pinned binary or its `--help`:
  `claude-opus-5-5`, `claude-sonnet-5-5`, and droid's default `gpt-6-sol`. Codex's `gpt-6.1-sol` is priority 1 in
  the model catalog bundled with codex 0.162.1, but the server can override it. All other models are plausible
  defaults and are flagged.
- Ranges are roughly ±30–50% relative for anything under 5%.

## Schema

Top level fields:

- `version`, `as_of`, `next_review`, `methodology`
- `unrepresented_share`, `proxy_represented_share`, `unrepresented_breakdown`
- `sources[]`, as `{id, title, url, note}`; every number cited in the registry or this README is in a note
- `agents[]`

Per agent:

| field | meaning |
|---|---|
| `id` | `<harness>/<model-slot>`; stable, used in results |
| `harness` | harness id; must match `orchestrator/images/Dockerfile.<harness>` and `boat-setup/<harness>.sh` |
| `cli` | binary the worker execs (`docker exec -u agent <pod> <cli> ...`) |
| `model`, `model_verified` | model passed to the CLI. `auto` or `default` means the harness's own default (omit the flag) |
| `harness_version` | pinned CLI version; the image tag and snapshot name derive from it |
| `weight` | sampling weight; sums to 1 over enabled agents |
| `usage_share` | estimated share of all agentic usage, before renormalization |
| `weight_source` | ids into `sources` |
| `headless` | verified non-interactive command line (`<model>`, `<prompt>`, `<workdir>` are placeholders) |
| `event_format` | id of the JSONL dialect the event parser needs |
| `image.docker` | `app/agent-<harness>:<harness_version>`, the tag `orchestrator/images/build.sh` produces (a host whose images were built before mold_v0-097, under their old name, keeps running those until they are rebuilt: `orchestrator/core/runners.ts` `localImage`) |
| `image.boat_snapshot` | boat named snapshot `app-<harness>-<version with . → ->`. Boat names must match `^[a-z0-9][a-z0-9-]{0,62}$` |
| `requires_env` | API key / token env names passed at exec time; never baked into images |
| `boat_preinstalled` | whether boat VMs ship this CLI (we still pin our own copy) |
| `worker_adapter` | `supported` if `orchestrator/harnesses/adapters.ts` can drive it; `todo` if image and command are ready but no adapter exists |
| `resume` | whether the adapter can resume the conversation headlessly (needed for simulated-developer replies) |
| `adapter_evidence` | `production`, `captured-fixture` or `synthesized-fixture` (see `orchestrator/harnesses/fixtures/README.md`) |
| `enabled` | `false` for harnesses we cannot run faithfully (weight 0; reason in `notes`) |

## How the server samples from it

Sampling lives in `src/agents.ts`:

- `enabledAgents()` keeps `enabled !== false && weight > 0` and renormalizes.
- `apportion()` is a **largest-remainder** allocation. Each agent gets `floor(weight × n)` slots, and the leftover
  slots go to the largest fractional remainders, with ties to the larger weight. It is deterministic.
- `representativePlan()` apportions over all of a run's slots (scenario × profile × sample) and then deals agents
  out in a strided order. Each scenario therefore gets a mix close to the overall weights, rather than one
  scenario getting all the Codex runs.

Example: 20 slots gives claude-code/opus 6, codex 4, copilot 3, cursor 2, claude-code/sonnet 2, opencode 1,
antigravity 1 and gemini-cli 1. Agents below about 1/n weight show up only when n is large enough.

Warm pods follow the same weights summed per harness (`orchestrator/fleet/plan.ts`).

**Adapters.** The server samples only agents with `worker_adapter: "supported"`. Since 2026-10-10 that covers every
enabled harness: all 13 have an adapter in `orchestrator/harnesses/adapters.ts`.

- **`resume: false` (Cline only):** the harness cannot continue a conversation headlessly, so its sessions get no
  simulated-developer replies.
- **`adapter_evidence`** records how each adapter was proven:
  - `production`: Claude Code and Codex.
  - `captured-fixture`: real CLI runs against a mock LLM, replayed in `scripts/smoke.ts`.
  - `synthesized-fixture`: Cursor and Amp, whose fixtures were built from vendor docs and CLI source because their
    backends can't be mocked. Watch these two most closely in the first real runs.

## Versions are pinned, and why

Agent behaviour drifts with harness releases: system prompts, tool sets, default models, web-search behaviour
and auto-approval rules all change. Claude Code ships several releases a week, and Codex changed its default
model three times in 2026. A customer's adoption rate measured on `claude 2.1.296` is not comparable to one
measured on next month's build unless we know which version ran.

So each agent pins `harness_version`. The Docker image and boat snapshot are named after it, and the worker
records the version with every session. Bump versions deliberately (below), never via auto-update. The images set
`DISABLE_AUTOUPDATER=1`, `COPILOT_AUTO_UPDATE=false` and `OPENCODE_DISABLE_AUTOUPDATE=true`, and the Cursor and
Antigravity binaries are pinned by build id.

## Quarterly update checklist

Run this every quarter (Jan, Apr, Jul, Oct), or when a major survey lands. SO publishes around Jul–Oct, JetBrains
around Aug–Oct, and Pragmatic Engineer around Feb–Mar.

1. **Evidence.** Pull the newest of each source in `sources` and add new ones (Octoverse, Menlo, vendor
   announcements). Record every number you use in a source `note`, with its URL and date.
2. **Downloads.** Fetch `https://api.npmjs.org/downloads/point/last-week/<pkg>` for each CLI package, plus
   pypistats for aider. Note package renames, as with Pi and Amp this quarter.
3. **Shares.** Re-derive ranges and midpoints with the method above. Keep the midpoints summing to 100. Write a
   one-line justification for every change of more than 2 points.
4. **Runnable check.** For each `enabled: false` tool, re-check whether it now has a headless JSON mode and
   API-key auth (Junie, Kiro and Augment are the closest). For each enabled tool, check that it still works.
5. **Versions.** For each harness, take the latest stable release that is at least one week old:
   - npm packages: `npm view <pkg> version`
   - Cursor: `curl -fsSL https://cursor.com/install | grep DOWNLOAD_URL`
   - Antigravity: the manifest URL in `Dockerfile.antigravity`, which holds both build id and sha512

   Update `harness_version` and the `ARG HARNESS_VERSION` default in `orchestrator/images/Dockerfile.<harness>`.
   Update the defaults in `boat-setup/<harness>.sh` too. `image.docker` and `image.boat_snapshot` follow from the
   version.
6. **Models.** Check each harness's default model in its `--help`, bundled catalog or docs. Re-split Claude Code
   Opus/Sonnet from the latest Amplifying.ai model mix. Set `model_verified` honestly.
7. **Recompute weights.** Divide each share by the runnable total and round to 4 dp, with the sum exactly 1 by
   largest remainder. Set `unrepresented_share`, `proxy_represented_share`, `unrepresented_breakdown`, `as_of`
   and `next_review`.
8. **Build and verify.**
   - Run `orchestrator/images/build.sh`. It builds every image and runs a warm-pod exec smoke test.
   - Run `orchestrator/images/boat-snapshot.sh` to re-bake the boat snapshots.
   - Run `npx tsx orchestrator/fleet/plan.ts 10` to check the pod split.
9. **Calibration run.** Run a few scenarios on both old and new versions and note any adoption-rate shift in the
   changelog. Version bumps are a known source of drift.
10. **Validate.** Enabled weights sum to 1 (±1e-6). Every `weight_source` id exists in `sources`. Every enabled
    harness has a Dockerfile and a boat-setup script. Snapshot names match the boat pattern.

## Verification

Done on 2026-10-10:

- All 13 enabled images built locally from `orchestrator/images` with Docker 29.
- Each was started as a warm pod (`sleep infinity`). `docker exec -u agent <pod> <cli> --version` returned the
  pinned version. The healthcheck reported `healthy`, `/home/agent/work` is owned by `agent`, and no key-like env
  is baked in.
- Headless flags were checked against each pinned CLI's own `--help` (all but amp's `-x`, which came from docs).
- The boat-setup scripts for claude-code, cursor, antigravity, opencode and pi ran in an Ubuntu 24.04 container
  that approximates a boat VM. They have not yet run against a real boat VM.
- No agent was run end-to-end with real API keys.
