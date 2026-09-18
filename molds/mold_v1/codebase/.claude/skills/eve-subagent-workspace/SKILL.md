---
name: eve-subagent-workspace
description: "Add a new specialist subagent to this eve codebase as a full workspace (operator rulebook, routing description, instructions contract, skills for every format variation, sandbox scripts, schemas, validators, registration and proof), not as a single instructions file. Use when someone says \"add a subagent\", \"build a specialist for X\", \"the agent needs to read Y documents\", when an existing subagent is only agent.ts plus instructions.md, or when `npm run check:subagents` fails and you need to know what the standard is. This is the entry point; it links to eve-subagent-skills, eve-sandbox-workspace, eve-subagent-tools, eve-subagent-wiring and eve-subagent-verify for each part, and to docs/SUBAGENT_PACKS.md for shipping subagents as a pack."
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

The ten built-in subagents under `agent/subagents/` predate this standard (top-level
`sandbox.ts` or none, no skill packages). `agent/subagents/research/` is the fullest of
them: copy its three small files (step 4), not its shape. The checker leaves legacy
subagents alone unless you name one. The running example in these skills is a hypothetical
`invoice-extraction` subagent that reads supplier invoices from the data room.

A vertical (a set of subagents for one line of work) is shipped as a **subagent pack**:
files dropped in, no edits to base files. Everything below applies unchanged inside a
pack; see `docs/SUBAGENT_PACKS.md`.

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
by path in their `instructions.md` (`invoice-extraction/schemas/invoice-spec.md`). The
checker accepts either, as long as the referenced file exists.

## 2. The directory

```
agent/subagents/<key>/
  agent.ts                           description written as a routing hint (step 3)
  subagent.json                      optional: display name, summary, data-room paths -> eve-subagent-wiring
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
words joined by hyphens (`^[a-z][a-z0-9-]{0,79}$`). The same string is the `workflows` row
name and `agent_configs.agent_key`.

`npm run build:eve` prints `Warning [discover/unsupported-directory]` for the `schemas/` and
`scripts/` folders in a subagent root (the built-in subagents have them too). That is
expected: eve ignores them, which is the point, since they hold the rulebook and pointers
for people. `subagent.json` is ignored by eve silently. Only `Error:` lines matter.

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
out"*), and *"the parent reads it to decide whether to delegate"*. Write the requests a
user would actually type, name the neighbouring subagent when the boundary is close ("hand
purchase orders to `po-matching`"), and say what must already be in the data room. Its
**first sentence** is the default one-line summary shown in the UI (override it with
`subagent.json` `"summary"`), so make that sentence stand alone. Never hardcode a model id:
`agentModel()` in `agent/lib/model.ts` is how a deployment chooses its provider (see
eve-customize-existing-agent).

The parent passes only `{ message, outputSchema? }`; the child *"never sees the parent's
history"*. So the instructions must say what to do when the message lacks the customer or
the period: ask, do not assume.

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

1. **Identity and scope.** What it is, the vocabulary of its work, and what it hands to a
   sibling.
2. **Sources.** Which documents it reads and where they live in the data room (exact paths;
   the ones it owns are declared in `subagent.json` `dataroomPaths`).
3. **Precedence.** Which source wins for which fact, restating the spec, and the rule for
   conflicts.
4. **Output contract.** Every file it writes, its path, its schema, and the status
   vocabulary for a value it could not establish (`not_found`, `needs_review`, ...). Every
   value carries document plus page.
5. **Skills table**: `| Skill | Load it when |`, one row per skill directory. A skill that
   is not named here is never loaded at the right moment.
6. **Scripts table**: `| Script | Purpose |`, one row per file in
   `sandbox/workspace/scripts/`.
7. **Validate before write.** Validation is the last step before any
   `dataroom_append_jsonl`, `dataroom_write` or `publish_artifact`. A failing validation is
   reported to the user, never bypassed, and never "fixed" by editing the value.
8. **What it never does.** No value from memory or a web snippet, no guessing a unit, no
   writing outside its paths.

The checker treats a `<name>.jsonl` mentioned here as a file the subagent writes and wants a
`validate_*.py` that names it. For a log it only reads, put `read-only` on every line that
mentions it.

## 6. Order of work

1. Rulebook into `schemas/<name>-spec.md`, with Open points.
2. List the format variations (the checklist in eve-subagent-skills) before writing any skill.
3. Schemas for every file it writes, then validators, then detectors and calculators, each
   with `--self-test` (eve-sandbox-workspace).
4. `sandbox/sandbox.ts`; if it uses a shared helper family, add the key to that family's
   `targets.json` and run `npm run sync:subagent-shared`.
5. Tools (eve-subagent-tools).
6. Skills, each naming the exact script command (eve-subagent-skills).
7. `agent.ts`, the three copied files, then `instructions.md` last, so its tables list what
   actually exists.
8. `subagent.json` if needed, the root delegation file, then `npm run build:subagent-meta`
   (eve-subagent-wiring). No list is edited by hand.
9. Prove it (eve-subagent-verify).

Building several at once: shared helpers and the rulebook first, then one engineer per
subagent with a write scope of exactly `agent/subagents/<key>/`, then the checker over all.

## Definition of done

- [ ] `npm run check:subagents -- <key>` prints `PASS` for the registry and for `<key>`.
- [ ] `npm run check:subagent-shared` passes.
- [ ] `npm run typecheck`, `npm run build` (web) and `npm run build:eve` (agent) pass.
- [ ] `npm run build:generated` was run and `npm run check:generated` is clean after commit.
- [ ] The spec has an `## Open points` heading, even if it says "none".
- [ ] No existing file was edited to add it (`git status --short` shows only added files
      plus the two `*.generated.ts` files).
- [ ] A smoke turn delegated to it left an `automation_runs` row (eve-subagent-verify).

## Never

- Never invent a rule the operator did not give. Put it under Open points.
- Never let the model do arithmetic, unit conversion or date parsing. That is a script.
- Never write a skill about one named organisation's documents. Skills describe shapes.
- Never hand-edit a shared family copy under `sandbox/workspace/scripts/<family>/`. It is a
  synced copy.
- Never add the key to a list in `app/` or `agent/lib/`. If it is missing somewhere, the
  generated files are stale.
