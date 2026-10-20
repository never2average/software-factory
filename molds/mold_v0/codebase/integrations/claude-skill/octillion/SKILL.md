---
name: octillion
description: APO (Agentic Preference Optimization) for developer tools. Measure and improve whether AI coding agents (Claude Code, Codex, Cursor, OpenCode and others) pick a developer tool. Use when the user asks whether coding agents recommend or adopt their dev tool, wants to onboard a product into Octillion, run agent simulations, read an Octillion visibility report, understand why an agent chose a competitor, or compare how different agents and models treat their product. Requires the Octillion MCP connector.
---

# Octillion

Octillion runs real, sandboxed coding agents on realistic programming tasks and records whether they **adopt** (install/import), **recommend**, merely **mention**, or skip the user's developer tool in favour of a **competitor**. This is APO, **Agentic Preference Optimization**: measuring and improving how often coding agents choose a product while they do real work. The agents are blind: tasks never name the product. This skill explains how to drive the Octillion connector and how to read its results honestly.

## When to use the tools

| User intent | Tool(s) |
|---|---|
| "Set up / onboard my product", gives a description, website or docs | `onboard_product`, then `get_onboarding` until it completes |
| "How are we doing?", "do agents pick us?", "visibility report" | `get_visibility_report` (optionally `days`, `model`, `population`) |
| "Run a test / simulation" | `run_simulation` (default: representative mix of coding agents), then `get_simulation` |
| "Why did we lose here?", "show me the evidence" | `get_agent_session`, then `get_session_transcript` around the evidence |
| "Which agents / models do you test?" | `list_agents` (shows the developer population's mix in sandboxes of 20) |
| Edit product context or tasks by hand | `save_product`, `save_scenarios`, `browse_task_library`, `list_developer_profiles` |
| Find something across transcripts | `search_transcripts` |

## Standard workflow

1. **Onboard**: call `onboard_product` with a one-paragraph `prompt` (what it is, who it is for) plus `website_url` and `docs_url`. Research takes a few minutes; orchestrators start automatically. Poll `get_onboarding` every ~30-60 s and tell the user what stage it is in (reading → profiling → personas → problems → done) instead of going silent.
2. **Review** the generated profile with the user before trusting results: package names (these drive "adopted" detection), competitors, personas and the problems. If something is wrong, fix it with `save_product` / `save_scenarios` (problems must stay neutral, see below).
3. **Run**: onboarding launches a representative run automatically unless `run: false`. Otherwise call `run_simulation`. Runs execute in sandboxes and take minutes; poll `get_simulation`.
4. **Report**: `get_visibility_report`, then drill into losses with `get_agent_session` and the transcript.

## Reading results honestly

- **Hit rate** = sessions where the agent adopted or recommended the product (for `avoid` problems: where it did *not*). Always quote it **with its 95% confidence interval and n** ("48% (35-61%, n=40)"). With small n, say the result is directional.
- **Adoption-weighted hit rate** reweights per-agent rates by real developer usage. Use it for "what would a typical developer's agent do"; use per-agent rates for "which agent is the problem".
- **Verdicts**: `adopted` > `recommended` > `mentioned` > `competitor` / `none`. `none` often means the agent built it itself or used a built-in (e.g. `padStart`), which is a real finding, not an error.
- **Share of voice** compares how often each tool was recommended or adopted; it is only as good as the competitor list in the profile.
- Never claim causation from one run. Agents are nondeterministic; compare runs with overlapping confidence intervals as "no clear change".
- Always ground explanations in transcript evidence (quote the line, cite `session_id#seq`).

See `reference/metrics.md` for definitions and worked examples.

## Rules that keep results valid

- **Never name the product, its packages, domains or competitors in a problem prompt.** The server rejects such prompts; rephrase as a neutral developer task with a concrete stack and goal.
- Personas describe developers, not the product; they answer the agent's questions in character and never steer.
- Do not invent package names; they must come from the product's docs and registry.
- Runs cost money (models plus sandboxes). Before launching anything large, state the size (problems × personas × samples) and let the user confirm; the server caps each run.

## Tone

Be direct and quantitative. Lead with the number and its interval, then the biggest lever (the weakest problem, the agent that most often picks a competitor), then the evidence.
