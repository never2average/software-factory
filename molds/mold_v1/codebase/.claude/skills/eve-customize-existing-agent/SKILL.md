---
name: eve-customize-existing-agent
description: "Change an existing subagent or the root agent of this eve codebase safely, by picking the right lever: instructions.md, a skill, a script, subagent.json, an added agent/instructions/NN-*.md file, the per-workspace agent_configs row, the operator workflow override, the agent profile, the model selection in agent/lib/model.ts, or a capability flag. Use when someone says \"make the X agent also do Y\", \"change how it handles Z\", \"this customer wants different wording / a different rule\", \"rename how it shows in the UI\", \"pause the agent\", \"switch the model\", \"turn off web search\", or before editing any instructions.md. Explains which change is code shipped with the codebase (or a pack) and which is per-workspace data that must never be baked in, how pausing works, and what to re-run afterwards."
---

# Customise an existing agent

First decide **who the change is for**. That, not the size of the change, picks the lever.

- It is true for every deployment (the operators' rulebook, a format the agent misreads, a
  missing capability): it is **code**. Edit the codebase, or the pack that owns the
  subagent, prove it, commit.
- It is true for one workspace (one team's wording, a record they do not cover, a temporary
  instruction): it is **data**. It goes in that workspace's database rows through the Ops
  Center. It never goes into `instructions.md`, a skill or a seed script.

Baking one workspace's preference into code changes every other deployment at the next
release, and hides the preference from the operator who owns it.

A second question for code changes: **whose file is it?** A subagent that came from a pack
(`docs/SUBAGENT_PACKS.md`) is changed in the pack and re-applied. A vertical never edits a
base file: it adds files. If you find yourself editing `agent/prompt-*.md` (the root prompt),
`agent/lib/dataroom-store.ts` or a list in `app/_components/` to serve one vertical, stop
and use the additive lever in the table.

## Which lever

| You want to | Lever | Where | Takes effect |
|---|---|---|---|
| change a standing rule, the identity, the output contract, the skill or script tables | `instructions.md` | `agent/subagents/<key>/instructions.md` (root: `agent/instructions.md`) | next deploy |
| handle a new shape of input, or fix a misread layout | a **skill** (new, or a section of an existing one) | `agent/subagents/<key>/skills/<skill>/` → eve-subagent-skills | next deploy |
| change a computation, a conversion, a check | a **script** and its `--self-test` | `agent/subagents/<key>/sandbox/workspace/scripts/` → eve-sandbox-workspace | next deploy; the sandbox template rebuilds |
| change a helper several subagents share | the **shared family** source, then sync | `scripts/subagent-shared/<family>/`, `npm run sync:subagent-shared` | next deploy |
| change a definition or precedence the operators own | the **rulebook** first, then the instructions that restate it | `agent/subagents/<key>/schemas/<name>-spec.md` | next deploy |
| add or remove a capability | a **tool** file | `agent/subagents/<key>/tools/` → eve-subagent-tools | next deploy |
| change how it is named or summarised in the UI, or let it write a new data-room folder | `subagent.json` (`name`, `summary`, `dataroomPaths`) | `agent/subagents/<key>/subagent.json` → eve-subagent-wiring | next deploy; re-run `npm run build:subagent-meta` |
| change when the root delegates to it | `agent.ts` `description`; ordering and boundaries between siblings in an **added** `agent/instructions/NN-<topic>.md` | → eve-subagent-wiring | next deploy; re-run `npm run build:subagent-meta` |
| tell the root how to brief a subagent, for one workspace | `agent_configs.instructions` | Workspace "Agents" tab, or `PUT /api/ops/agent-configs` | next turn |
| stop the root delegating to it, for one workspace | `agent_configs.paused` | same | next turn |
| give the subagent itself a standing instruction, for one workspace | the **workflow override** | the `workflows` row named `<key>` (eve-subagent-wiring, section 3) | the subagent's next turn |
| change the persona or tone of the root for a workspace or a person | the **agent profile** | Workspace "Agents" tab | next turn |
| change the model | environment, read by `agent/lib/model.ts` | per deployment | next deploy |
| remove web search or the browser | `ENABLE_WEB_SEARCH`, `ENABLE_BROWSER` | per deployment | **rebuild** and redeploy |

The ten built-in subagents also have curated display copy in a few UI files
(`SUBAGENT_NAMES` and `SUBAGENT_DESCRIPTIONS` in `app/_components/tool-display.ts`,
`CURATED_SUBAGENTS` in `app/_components/ops/workspace-panel.tsx`, `AGENT_LABELS` in
`agent/lib/agent-configs.ts`). Those win over the generated data for the keys they list.
For any other subagent, `subagent.json` is the only place its name and summary are written.

### Instructions or a skill?

eve: `instructions.md` is *"Always on, every turn"*; a skill is loaded *"On demand, when
the model calls `load_skill`"*. *"Keep instructions short and stable. Long or situational
procedures belong in skills."* If the new text starts with "when the document ..." it is a
skill. If it starts with "always" or "never" it is an instruction. A rule with a number in
it (a threshold, a formula) belongs in the rulebook and a script, and is only *named* in
the instructions.

Instructions are static text captured at build time. The two dynamic entries a
workspace-standard subagent has under `instructions/` (`00-mode.ts`,
`operator-override.ts`) are resolved on `turn.started`. eve combines the root file first,
then the directory entries in alphabetical order, so the operator override always comes
after the authored contract. The same ordering is what lets a pack add root delegation text
as `agent/instructions/NN-pack-<name>.md` without touching `agent/instructions.md`.

### `agent_configs` or the workflow override?

They look alike and reach different models.

| | `agent_configs` row | `workflows` row named `<key>` |
|---|---|---|
| Written in | Workspace "Agents" tab | the workflows API or MCP; an `on delegation` row is hidden from the Workflows list |
| Injected into | the **root** agent's context, each turn (`agent/instructions/agent-configs.ts`) | the **subagent's** own context, each turn (`instructions/operator-override.ts`) |
| Effect | "PAUSED: do not delegate"; "when delegating to <label>, apply these workspace instructions: ..." | appended after `instructions.md` as a delimited block |
| Reaches the subagent | only through the message the root writes | directly |
| Switch | `paused`; clear the text | `enabled`, and `instructions_enabled` to park the text without deleting it |
| Limits | 4000 characters; admin or owner only; history kept | per workspace; most recently updated row of that name wins |

Use `agent_configs` for *how to brief it* ("always include the tax breakdown"). Use the
workflow override for *how it should behave* ("state amounts in thousands in the reply
text"). Both are rendered to the model as **untrusted preference data** that must not
override workspace scope, safety controls, approvals or the user's request, so neither can
be used to lift a rule. An override that contradicts the rulebook is a sign the rulebook
needs changing, in code, with the operator's agreement recorded under Open points.

## Pausing

Pausing is a per-workspace switch: `agent_configs.paused = true` for `(org_id, agent_key)`.
The root is then told, every turn, not to delegate to that subagent and to do the work
itself or with an active one. It is an instruction to the root, not the removal of a tool.
To make a capability truly absent, use a capability flag, or delete the subagent's
directory and regenerate (eve-subagent-wiring, "Renaming or removing"). Scheduled and
scripted workflows that name a paused subagent still go through the root and meet the same
instruction.

## Model selection

Every `agent.ts` takes its model from `agent/lib/model.ts`:

```ts
model: agentModel("orchestrator"),            // or agentModel("specialist")
modelContextWindowTokens: modelContextWindowTokens(),
```

- `MODEL_PROVIDER` is `cloudflare` (default; one model for the whole fleet,
  `CLOUDFLARE_MODEL`) or `gateway` (explicit opt-in; the Vercel AI Gateway).
- The role matters only in gateway mode: `GATEWAY_MODEL_ORCHESTRATOR` and
  `GATEWAY_MODEL_SPECIALIST`. Use `"orchestrator"` for a subagent whose hard part is
  reading and judging documents; a cheap routing-only subagent can use `"specialist"`.
- A third role, `"vision"`, is not an agent: it is the model behind the `read_image` tool
  (`CLOUDFLARE_MODEL_VISION`, default `@cf/zai-org/glm-5.3-flash`, asked for reasoning
  `MODEL_REASONING_VISION`, default `low`). It never falls back to the fleet model, which
  is text-only. Never pass it to an `agent.ts`.
- `modelContextWindowTokens()` is required for the Cloudflare provider: eve cannot look up
  the window of a custom OpenAI-compatible model, and needs it to know when to compact.
- Never write a model id into an `agent.ts`. A hardcoded id bypasses the provider switch
  and is how a fleet ends up billing the wrong provider. Values come from the environment,
  by name; trailing newlines in a value are trimmed by `model.ts` for that reason.
- eve also supports per-session selection with `defineDynamic({ fallback, events })` on
  `model` (`node_modules/eve/docs/agent-config.md`). Not used here. If you need it, put it
  in `model.ts` so every agent gets it, and prefer `session.started`: *"prompt caches are
  per model, so every switch re-ingests the conversation at uncached prices."*

Write skills and instructions for the weaker of the models a deployment may choose:
explicit steps, exact commands, no reliance on the model inferring a format.

## Code defaults and per-workspace data

| Ships as code (reviewed, versioned; base or pack) | Belongs to a workspace (database, owned by its admins) |
|---|---|
| `agent/**`, including every `instructions.md`, skill, script, schema, rulebook, `subagent.json` | `agent_configs` rows |
| the `workflows` row per subagent that `provisionWorkspace` seeds: name and description only | `workflows.instructions` overrides and their on/off switch |
| `DATAROOM_PATH_TEMPLATES`, `dm.md`, and the templates subagents declare | agent profiles, memories |
| the generated registry (`*.generated.ts`) | the data room's contents |

Never seed an override or a custom instruction from a provisioning script; never commit a
real organisation's figures, a workspace id or an email address into a skill, a fixture or
a self-test. Secrets are referenced by name only.

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
4. If a shared family changed: edit `scripts/subagent-shared/<family>/`, then
   `npm run sync:subagent-shared`.
5. Keep the tables in `instructions.md` in step with `skills/` and `sandbox/workspace/scripts/`.
6. `npm run build:subagent-meta`, `npm run check:subagents -- <key>`, `npm run typecheck`,
   then the rest of eve-subagent-verify.
7. Editing a seeded script or `sandbox/sandbox.ts` rebuilds the sandbox template, and open
   sessions start their next turn from the new one. Expect the first turn after deploy to be
   slower.

## Never

- Never fix one workspace's complaint by editing shipped instructions.
- Never weaken "validate before write" or a status vocabulary to make a run pass.
- Never edit `*.generated.ts` or a synced shared-family copy by hand.
- Never add a subagent key to a list to make it appear somewhere. Regenerate.
- Never rename a subagent key casually: it is also the `workflows` row name and the
  `agent_configs.agent_key` in every workspace.
