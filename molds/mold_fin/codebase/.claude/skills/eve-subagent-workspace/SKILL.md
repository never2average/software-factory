---
name: eve-subagent-workspace
description: Add a new specialist subagent to this eve codebase as a full workspace — operator rulebook, routing description, instructions contract, skills for every format variation, sandbox scripts, schemas, validators, registration and proof — not as a single instructions file. Use when someone says "add a subagent", "build a specialist for X", "the agent needs to read Y documents", when an existing subagent is only agent.ts plus instructions.md, or when `npm run check:subagents` fails and you need to know what the standard is. This is the entry point; it links to eve-subagent-skills, eve-sandbox-workspace, eve-subagent-tools, eve-subagent-wiring and eve-subagent-verify for each part.
---

# Build a subagent as a full workspace

A subagent that is only `agent.ts` plus `instructions.md` is a prompt, not a specialist. It
fails the first time a source document is laid out differently from the one its author
pictured. The standard in this codebase is the workspace below. `npm run check:subagents`
(`scripts/check-subagents.py`) enforces it, and a subagent that does not pass is not done.

Read eve's own docs before writing code: `node_modules/eve/docs/subagents.mdx`,
`skills.mdx`, `sandbox.mdx`, `instructions.mdx`, `reference/project-layout.md`. The one
fact that shapes everything here is eve's isolation boundary: *"A declared subagent inherits
nothing from the root's authored slots."* It has only the instructions, tools, skills,
sandbox and hooks authored under `agent/subagents/<key>/`. Anything the child needs is
duplicated into its directory or imported from `agent/lib/` (`#lib/*`).

The fullest live examples are `agent/subagents/hfc-kpi-extraction/`, `lodr-filings/`,
`investor-presentations/` and `annual-report-format/`. `agent/subagents/research/` is the
fullest *legacy* subagent (top-level `sandbox.ts`, no skills): copy its three small files
(step 4), not its shape.

## 1. Get the operator's rulebook first

Before writing anything, ask the operator for the rules their people already follow:

- the definitions and formulas they use
- which source wins when two disagree
- units
- what to do when data is missing
- what to leave out

Keep the rules **verbatim** in `agent/subagents/<key>/schemas/<name>-spec.md`. The
instructions restate them. If the two disagree, the spec wins and the instructions are the
defect. Anything the rulebook leaves open goes under an `## Open points` heading in the
spec, together with the behaviour chosen in the meantime. Never resolve an open point
silently.

When several subagents are bound by one rulebook, keep it once and have the others name it
by path in their `instructions.md` (the three filing subagents point at
`hfc-kpi-extraction/schemas/kpi-spec.md`). The checker accepts either.

## 2. The directory

```
agent/subagents/<key>/
  agent.ts                           description written as a routing hint (step 3)
  instructions.md                    the contract (step 5)
  instructions/00-mode.ts            copied verbatim from a sibling (step 4)
  instructions/operator-override.ts  copied, re-keyed to "<key>" (step 4)
  hooks/usage.ts                     copied, WORKFLOW = "<key>" (step 4)
  tools/*.ts                         the narrowest set               -> eve-subagent-tools
  skills/<skill>/SKILL.md            one per format variation        -> eve-subagent-skills
  skills/<skill>/references/*        label tables, regex tables, worked examples
  sandbox/sandbox.ts                 folder layout, installs parsers -> eve-sandbox-workspace
  sandbox/workspace/scripts/*.py     lands at /workspace/scripts/
  sandbox/workspace/schemas/*.json   lands at /workspace/schemas/
  schemas/<name>-spec.md             the operator's rulebook, verbatim
  schemas/README.md, scripts/README.md   one line each, pointing at sandbox/workspace/
```

`<key>` is the directory name. eve derives identity from the path (*"You never write a
`name` or `id` field on a `define*` call"*), and the directory name becomes the tool the
root agent calls, so it must not collide with any file in `agent/tools/`. Use lowercase
words joined by hyphens; the same string is used in every registration site.

There must be **no** `agent/subagents/<key>/sandbox.ts`. eve seeds `sandbox/workspace/**`
only with the folder layout. Do not add `schedules/` or `channels/`: both are root-only.

## 3. `agent.ts`: the description is the routing hint

```ts
import { defineAgent } from "eve";
import { agentModel, modelContextWindowTokens } from "#lib/model.js";

export default defineAgent({
  description: "<what it does>. Delegate here to <the requests that belong to it>. <what it needs to already exist, and what it will not do>.",
  model: agentModel("orchestrator"),
  modelContextWindowTokens: modelContextWindowTokens(),
});
```

`description` is required (*"the compiler rejects any subagent whose `agent.ts` leaves it
out"*), and *"the parent reads it to decide whether to delegate"*. Write the requests an
analyst would actually type, name the neighbouring subagent when the boundary is close
("hand annual reports to `annual-report-format`"), and say what must already be in the data
room. Never hardcode a model id: `agentModel()` in `agent/lib/model.ts` is how a deployment
chooses its provider (see eve-customize-existing-agent).

The parent passes only `{ message, outputSchema? }`; the child *"never sees the parent's
history"*. So the instructions must say what to do when the message lacks a company or a
period: ask, do not assume.

## 4. Copy and re-key three files

Copy these from `agent/subagents/research/` and change only what is listed.
[`references/rekey-files.md`](references/rekey-files.md) has the full text.

| File | Change |
|---|---|
| `instructions/00-mode.ts` | nothing |
| `instructions/operator-override.ts` | `loadWorkflowOverride("<key>", orgId)` and the comment |
| `hooks/usage.ts` | `const WORKFLOW = "<key>";` and the comment |

If either keyed file still says `"research"`, the new subagent silently applies research's
operator override and books its tokens to research's run history. The checker fails on it.

## 5. `instructions.md`: the contract

Always-on, so keep it to what holds on every turn; procedures go in skills (eve: *"Keep
instructions short and stable. Long or situational procedures belong in skills"*).
[`references/instructions-template.md`](references/instructions-template.md) is a skeleton.
Required parts, in this order:

1. **Identity and scope.** What it is, the vocabulary of this workspace (here a "customer"
   record is a covered company), and what it hands to a sibling.
2. **Sources.** Which documents it reads and where they live in the data room (exact
   `dm.md` paths).
3. **Precedence.** Which source wins for which fact, restating the spec, and the rule for
   conflicts.
4. **Output contract.** Every file it writes, its path, its schema, and the status
   vocabulary for a value it could not establish (`not_found`, `needs_review`,
   `carried_forward`, ...). Every figure carries document plus page or slide.
5. **Skills table**: `| Skill | Load it when |`, one row per skill directory. A skill that
   is not named here is never loaded at the right moment.
6. **Scripts table**: `| Script | Purpose |`, one row per file in
   `sandbox/workspace/scripts/`.
7. **Validate before write.** Validation is the last step before any
   `dataroom_append_jsonl`, `dataroom_write` or `publish_artifact`. A failing validation is
   reported to the analyst, never bypassed, and never "fixed" by editing the value.
8. **What it never does.** No number from memory or a news article, no guessing a unit, no
   writing outside its paths.

The checker treats a `<name>.jsonl` mentioned here as a file the subagent writes and wants a
`validate_*.py` that names it. For a log it only reads, put `read-only` on every line that
mentions it.

## 6. Order of work

1. Rulebook into `schemas/<name>-spec.md`, with Open points.
2. List the format variations (the checklist in eve-subagent-skills) before writing any skill.
3. Schemas for every file it writes, then validators, then detectors and calculators, each
   with `--self-test` (eve-sandbox-workspace).
4. `sandbox/sandbox.ts`, then `npm run sync:fin-workspace` if it uses `finlib`.
5. Tools (eve-subagent-tools).
6. Skills, each naming the exact script command (eve-subagent-skills).
7. `agent.ts`, the three copied files, then `instructions.md` last, so its tables list what
   actually exists.
8. Register the key everywhere (eve-subagent-wiring).
9. Prove it (eve-subagent-verify).

Building several at once: shared helpers and the rulebook first, then one engineer per
subagent with a write scope of exactly `agent/subagents/<key>/`, then the checker over all.

## Definition of done

- [ ] `npm run check:subagents -- <key>` prints `PASS` with no failures.
- [ ] `npm run check:fin-workspace` passes (if it uses `finlib`).
- [ ] `npm run typecheck`, `npm run build` (web) and `npm run build:eve` (agent) pass.
- [ ] `npm run build:subagent-meta` was run and `npm run check:generated` is clean after commit.
- [ ] The spec has an `## Open points` heading, even if it says "none".
- [ ] A smoke turn delegated to it left an `automation_runs` row (eve-subagent-verify).
- [ ] The mold's `MOLD.md` delta table and the factory-side `agent_key` enum are updated or
      reported as outside this codebase (eve-subagent-wiring).

## Never

- Never invent a rule the operator did not give. Put it under Open points.
- Never let the model do arithmetic, unit conversion or period parsing. That is a script.
- Never write a skill about one named company's filings. Skills describe shapes.
- Never hand-edit `sandbox/workspace/scripts/finlib/`. It is a synced copy.
