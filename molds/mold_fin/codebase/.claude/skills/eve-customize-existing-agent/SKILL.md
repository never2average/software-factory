---
name: eve-customize-existing-agent
description: Change an existing subagent or the root agent of this eve codebase safely, by picking the right lever — instructions.md, a skill, a script, the per-workspace agent_configs row, the operator workflow override, the agent profile, the model selection in agent/lib/model.ts, or a capability flag. Use when someone says "make the X agent also do Y", "change how it handles Z", "this customer wants different wording / a different rule", "pause the agent", "switch the model", "turn off web search", or before editing any instructions.md. Explains which change is code shipped with the mold and which is per-workspace data that must never be baked in, how pausing works, and what to re-run afterwards.
---

# Customise an existing agent

First decide **who the change is for**. That, not the size of the change, picks the lever.

- It is true for every deployment of this mold (the analysts' rulebook, a format the agent
  misreads, a missing capability): it is **code**. Edit the mold, prove it, commit.
- It is true for one workspace (one team's wording, a company they do not cover, a
  temporary instruction): it is **data**. It goes in that workspace's database rows through
  the Ops Center. It never goes into `instructions.md`, a skill or a seed script.

Baking one workspace's preference into the mold changes every other deployment at the next
release, and hides the preference from the operator who owns it.

## Which lever

| You want to | Lever | Where | Takes effect |
|---|---|---|---|
| change a standing rule, the identity, the output contract, the skill or script tables | `instructions.md` | `agent/subagents/<key>/instructions.md` (root: `agent/instructions.md`) | next deploy |
| handle a new shape of input, or fix a misread layout | a **skill** (new, or a section of an existing one) | `agent/subagents/<key>/skills/<skill>/` → eve-subagent-skills | next deploy |
| change a computation, a conversion, a check | a **script** and its `--self-test` | `agent/subagents/<key>/sandbox/workspace/scripts/` → eve-sandbox-workspace | next deploy; the sandbox template rebuilds |
| change a definition or precedence the analysts own | the **rulebook** first, then the instructions that restate it | `agent/subagents/<key>/schemas/<name>-spec.md` | next deploy |
| add or remove a capability | a **tool** file | `agent/subagents/<key>/tools/` → eve-subagent-tools | next deploy |
| change when the root delegates to it | `agent.ts` `description`, and the root's "What you own" entry | → eve-subagent-wiring | next deploy; re-run `npm run build:subagent-meta` |
| tell the root how to brief a subagent, for one workspace | `agent_configs.instructions` | Workspace "Agents" tab, or `PUT /api/ops/agent-configs` | next turn |
| stop the root delegating to it, for one workspace | `agent_configs.paused` | same | next turn |
| give the subagent itself a standing instruction, for one workspace | the **workflow override** | Ops Center workflows panel, the workflow named `<key>` | the subagent's next turn |
| change the persona or tone of the root for a workspace or a person | the **agent profile** | Workspace "Agent" tab | next turn |
| change the model | environment, read by `agent/lib/model.ts` | per deployment | next deploy |
| remove web search or the browser | `ENABLE_WEB_SEARCH`, `ENABLE_BROWSER` | per deployment | **rebuild** and redeploy |

### Instructions or a skill?

eve: `instructions.md` is *"Always on, every turn"*; a skill is loaded *"On demand, when
the model calls `load_skill`"*. *"Keep instructions short and stable. Long or situational
procedures belong in skills."* If the new text starts with "when the document ..." it is a
skill. If it starts with "always" or "never" it is an instruction. A rule with a number in
it (a threshold, a formula) belongs in the rulebook and a script, and is only *named* in
the instructions.

Instructions are static text captured at build time. The two dynamic entries every subagent
has under `instructions/` (`00-mode.ts`, `operator-override.ts`) are resolved on
`turn.started`. eve combines the root file first, then the directory entries in
alphabetical order, so the operator override always comes after the authored contract.

### `agent_configs` or the workflow override?

They look alike in the UI and reach different models.

| | `agent_configs` row | `workflows` row named `<key>` |
|---|---|---|
| Written in | Workspace "Agents" tab | Ops Center workflows panel |
| Injected into | the **root** agent's context, each turn (`agent/instructions/agent-configs.ts`) | the **subagent's** own context, each turn (`instructions/operator-override.ts`) |
| Effect | "PAUSED: do not delegate"; "when delegating to <label>, apply these workspace instructions: ..." | appended after `instructions.md` as a delimited block |
| Reaches the subagent | only through the message the root writes | directly |
| Switch | `paused`; clear the text | `enabled`, and `instructions_enabled` to park the text without deleting it |
| Limits | 4000 characters; admin or owner only; history kept | per workspace; most recently updated row of that name wins |

Use `agent_configs` for *how to brief it* ("always include the consolidated figures"). Use
the workflow override for *how it should behave* ("report amounts in Rs lakh in the reply
text"). Both are rendered to the model as **untrusted preference data** that must not
override workspace scope, safety controls, approvals or the user's request, so neither can
be used to lift a rule. An override that contradicts the rulebook is a sign the rulebook
needs changing, in code, with the operator's agreement recorded under Open points.

## Pausing

Pausing is a per-workspace switch: `agent_configs.paused = true` for `(org_id, agent_key)`.
The root is then told, every turn, not to delegate to that subagent and to do the work
itself or with an active one. It is an instruction to the root, not the removal of a tool.
To make a capability truly absent, use a capability flag (`disableTool()`), or delete the
subagent from the mold (eve-subagent-wiring, "Removing"). Scheduled and scripted workflows
that name a paused subagent still go through the root and meet the same instruction.

## Model selection

Every `agent.ts` takes its model from `agent/lib/model.ts`:

```ts
model: agentModel("orchestrator"),            // or agentModel("specialist")
modelContextWindowTokens: modelContextWindowTokens(),
```

- `MODEL_PROVIDER` is `cloudflare` (default; one model for the whole fleet,
  `CLOUDFLARE_MODEL`, default `@cf/zai-org/glm-5.2`) or `gateway` (explicit opt-in; Claude
  through the Vercel AI Gateway).
- The role matters only in gateway mode: `GATEWAY_MODEL_ORCHESTRATOR` and
  `GATEWAY_MODEL_SPECIALIST`. The four research subagents use `"orchestrator"` because
  reading filings is the hard part of this product; a cheap routing-only subagent can use
  `"specialist"`.
- `modelContextWindowTokens()` is required for the Cloudflare provider: eve cannot look up
  the window of a custom OpenAI-compatible model, and needs it to know when to compact.
- Never write a model id into an `agent.ts`. A hardcoded id bypasses the provider switch
  and is how a fleet ends up billing the wrong provider. Values come from the environment,
  by name; trailing newlines in a value are trimmed by `model.ts` for that reason.
- eve also supports per-session selection with `defineDynamic({ fallback, events })` on
  `model` (`node_modules/eve/docs/agent-config.md`). Not used here. If you need it, put it
  in `model.ts` so every agent gets it, and prefer `session.started`: *"prompt caches are
  per model, so every switch re-ingests the conversation at uncached prices."*

Write skills and instructions for the weaker of the models the mold targets: explicit
steps, exact commands, no reliance on the model inferring a format.

## Mold defaults and per-workspace data

| Ships with the mold (code, reviewed, versioned) | Belongs to a workspace (database, owned by its admins) |
|---|---|
| `agent/**`, including every `instructions.md`, skill, script, schema, rulebook | `agent_configs` rows |
| `scripts/seed-ops.mjs` `WORKFLOWS`: one row per subagent with name and description only | `workflows.instructions` overrides and their on/off switch |
| `DATAROOM_PATH_TEMPLATES`, `dm.md` | agent profiles, memories |
| the registration lists | the data room's contents: filings, logs, KPI tables |

Never seed an override or a custom instruction from `seed-ops.mjs`; never commit a real
company's figures, a workspace id or an email address into a skill, a fixture or a
self-test. Secrets are referenced by name only.

## Changing the root agent

The root (`agent/`) follows the same levers with two differences. Its skills, tools and
sandbox are its own and are **not** inherited by any declared subagent, so a fix made at
the root does not reach a specialist. And its dynamic instruction files
(`agent/instructions/*.ts`: mode, runtime context, agent configs, agent profile, memory,
workflow definitions) are shared machinery: change the data they read, not the files,
unless the mechanism itself is wrong. `.claude/settings.json` denies edits to
`agent/lib/email.ts`; respect it.

## Safe-change procedure

1. Read the subagent's `schemas/*-spec.md` and `instructions.md`. If the request contradicts
   the rulebook, stop and take it to the operator; record the outcome in the spec.
2. Make the change with the lever above. One concern per commit.
3. If a script changed: update its `--self-test` cases first, then the code.
4. If `finlib` changed: edit `scripts/fin-workspace/finlib/`, then `npm run sync:fin-workspace`.
5. Keep the tables in `instructions.md` in step with `skills/` and `sandbox/workspace/scripts/`.
6. `npm run check:subagents -- <key>`, `npm run typecheck`, `npm run build:subagent-meta`,
   then the rest of eve-subagent-verify.
7. Editing a seeded script or `sandbox/sandbox.ts` rebuilds the sandbox template, and open
   sessions start their next turn from the new one. Expect the first turn after deploy to be
   slower.

## Never

- Never fix one workspace's complaint by editing the mold's instructions.
- Never weaken "validate before write" or a status vocabulary to make a run pass.
- Never edit `*.generated.ts` or a synced `finlib/` copy by hand.
- Never rename a subagent key casually: it is also the `workflows` row name and the
  `agent_configs.agent_key` in every workspace.
