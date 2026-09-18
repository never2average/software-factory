---
name: eve-subagent-wiring
description: Register a subagent key everywhere this codebase hardcodes the list of subagents, so the orchestrator delegates to it, the Ops Center shows and configures it, its runs and tokens are recorded, and its data-room paths are writable. Use after creating agent/subagents/<key>/, when renaming or removing a subagent, when someone says "the new agent doesn't show up in the Agents tab / Control Panel / workflows", "its runs are missing", "the data room rejected the path", or when `npm run check:subagents` reports "key is not registered in ...". Lists every registration site with file and line, the root delegation paragraph, DATAROOM_PATH_TEMPLATES and dm.md, the seed-ops workflows row and the operator-override mechanism, per-org agent_configs, build:subagent-meta, and what lives outside this codebase.
---

# Wire a subagent into the product

eve discovers `agent/subagents/<key>/` on its own and lowers it into a tool named `<key>`
for the root agent. Nothing else in this codebase is automatic: the UI, the run accounting
and the operator controls each keep their own list of keys. Miss one and the subagent works
but is invisible, unconfigurable or unaccounted for.

Line numbers below were read on 2026-09-18. Confirm them before editing:

```bash
grep -rn '"follow-ups"' agent/lib app scripts setup --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v generated
grep -n 'follow-ups' agent/instructions.md agent/subagents/workflow-author/instructions.md
```

`follow-ups` and `data-migration` are good probes because the hyphen forces quoting.
[`references/registration-sites.md`](references/registration-sites.md) has the exact text
to add at each site and what breaks without it.

## 1. The seven required sites

`npm run check:subagents` fails unless the key appears in every one of these.

| # | File:line | Constant | What it drives |
|---|---|---|---|
| 1 | `agent/lib/agent-configs.ts:34` | `AGENT_LABELS` | the human label used when pause state and custom instructions are injected into the orchestrator's context |
| 2 | `app/_components/tool-display.ts:37` | `SUBAGENT_NAMES` | display name in the rail, detail headers and delegation cards |
| 2b | `app/_components/tool-display.ts:54` | `SUBAGENT_DESCRIPTIONS` | the info-modal copy (same file; add both) |
| 3 | `app/_components/ops/workspace-panel.tsx:543` | `SUBAGENTS` | the Workspace "Agents" tab: the row where an admin pauses the agent or gives it per-workspace instructions |
| 4 | `app/_components/ops/workflows-panel.tsx:179` | `SUBAGENT_IDS` | whether the workflow editor says an instructions override reaches a subagent, and shows it as `agent/subagents/<key>/instructions.md` |
| 5 | `app/_components/insights.ts:326` | `SUBAGENT_NAMES` | recognising a bare-name delegation tool call as a subagent run in the Control Panel (the `eve:subagent:<name>` prefix is recognised without the list) |
| 6 | `scripts/seed-ops.mjs:34` | `WORKFLOWS` | the `workflows` row named `<key>` (section 4) |
| 7 | `agent/instructions.md:39` | "What you own" list | the delegation paragraph (section 2) |

## 2. The root delegation paragraph

The root agent sees each subagent's `agent.ts` description as a tool description. The
paragraph in `agent/instructions.md` adds what a description cannot: order and boundaries
between siblings. Under `## What you own` add one entry in the house form:

```md
- **<key>** — <what it produces, in one line>:
  - <what it covers>
  - <the rule that makes it different from its neighbour>
  - Use for "<phrases an analyst types>".
  - <what must already exist, e.g. "Works only from filings already in the data room.">
```

If it takes part in a chain, add it to the numbered chain under
`## This workspace: housing finance research` (`agent/instructions.md:29-35`: fetch and log,
then read, then tabulate). Keep rules out of the root: the root is told the rulebook lives
with the specialist and not to restate or adjust it. Remind the root, where it matters,
that the child sees only the message, so the message must carry the company, the period and
the paths.

## 3. Data-room paths

Every data-room tool validates paths against `DATAROOM_PATH_TEMPLATES`
(`agent/lib/dataroom-store.ts:111`), transcribed from `dm.md`. A path with no template is
refused.

- Finance paths are covered by one template, `"Customers/{customer_id}/filings/**"`
  (`agent/lib/dataroom-store.ts:120`). A trailing `**` matches any non-empty file subtree,
  so a new file or folder **under `filings/`** needs no template change.
- It still needs `dm.md` (lines 8-13 today): add the folder or file with a parenthesis
  saying what it holds and its naming pattern. `dm.md` is the canonical data model that
  people and the context-graph scripts read; an undocumented file is a defect even when the
  store accepts it.
- A path **outside** `filings/` needs a new template line beside its domain, the `dm.md`
  entry, then `npm run test:dataroom` and `npm run validate:dataroom`.
- Name a new `.jsonl` so it does not end in `interactions.jsonl`, `personas.jsonl`,
  `output.jsonl`, `trace.jsonl`, or match `tickets_*.jsonl`, `evals/dataset.jsonl`,
  `evals/benchmark.jsonl`: `dataroom_append_jsonl` would validate it against that contract
  (`schemaForJsonlPath`, `agent/lib/dataroom-tools.ts`).
- State the exact paths in the subagent's `instructions.md` output contract.

## 4. The `workflows` row and the operator override

In the Ops Center a "workflow" named after a subagent **is** that subagent. One row, two jobs:

1. **Run and token accounting.** `hooks/usage.ts` calls
   `recordWorkflowStep("<key>", ...)`, and `agent/lib/workflow-usage.ts` looks the workflow
   up **by name**. No row named `<key>`: no `automation_runs` row, no tokens in the Ops
   Center, and no error either, because the recorder never throws.
2. **Operator override.** `instructions/operator-override.ts` calls
   `loadWorkflowOverride("<key>", orgId)` on every `turn.started`. When the row is enabled,
   has `instructions` text and `instructions_enabled` is true, the text is appended after
   `instructions.md` as a delimited block marked untrusted preference data. An operator's
   edit takes effect on the subagent's next turn, with no deploy.

Add to `WORKFLOWS` in `scripts/seed-ops.mjs`:

```js
{ name: "<key>", description: "<one line, shown in the Ops Center>", trigger: "on delegation" },
```

`seed-ops.mjs` inserts **only when the `workflows` table is empty**. On a deployment that
already has workflows, the row is created from the Ops Center's workflows panel (or
`POST /api/ops/workflows`) with the name exactly `<key>`. Rows are per workspace: each
workspace that uses the subagent needs its own, or that workspace's turns go unrecorded.
The id lookup is cached for the life of the process, so a row added after the first turn
starts counting on the next cold start.

## 5. Per-workspace configuration (`agent_configs`)

Table `agent_configs` (`org_id`, `agent_key`, `paused`, `instructions`), written by the
Workspace "Agents" tab through `PUT /api/ops/agent-configs` (admin or owner only; the key
is a free string, so no route change is needed). `agent/instructions/agent-configs.ts`
injects it into the **root** agent each turn: paused subagents are listed as "do not
delegate", and custom text is rendered as "When delegating to the <label> subagent, apply
these workspace instructions: ...". So this text reaches the subagent only through the
message the root writes; the `workflows` override reaches the subagent's own context. The
mold ships **no** `agent_configs` rows: they are per-workspace data. See
eve-customize-existing-agent for which lever to use.

## 6. Other sites to consider

Not checked as failures, but real:

| File:line | What | When to touch it |
|---|---|---|
| `setup/fde-mcp.mjs:352` | `SUBAGENT_IDS` for the fde MCP's agent-config tools; an unknown key is refused | always, if engineers configure the agent over MCP. **The four finance keys are not in it today** (the checker warns) |
| `agent/subagents/workflow-author/instructions.md:28-29` | the subagents a workflow script's `agent(prompt, { subagent })` may name | if operators should be able to script it |
| `scripts/sync-fin-workspace.mjs:11` | `FIN_SUBAGENTS` | if it uses `finlib` (the checker fails without it) |
| `agent/lib/customer-schema.ts:30` | `TICKET_CATEGORY_ROUTING` | only if a ticket category should triage to it |
| `scripts/fde/workflows/*.workflow.js` | library workflows naming `{ subagent: "..." }` | when shipping a library workflow that uses it; then `npm run build:workflow-library` |
| `agent/lib/workflow-override.ts:6-7`, `agent/lib/db/schema.ts:1059-1060` | comments listing subagent ids | keep truthful when convenient |
| `AGENTS.md` "Capability flags" | the count of `web_search` sites | if the subagent declares `web_search` |

Generated, never edited by hand: `app/_components/subagent-meta.generated.ts`,
`agent/lib/workflow-library.generated.ts`.

## 7. Regenerate

```bash
npm run build:subagent-meta     # node scripts/gen-subagent-meta.mjs
```

It reads every `agent/subagents/*/` (`agent.ts` description, `instructions.md`, skill
directory names, tool files and their descriptions) into
`app/_components/subagent-meta.generated.ts`, which the Control Panel's info dialog shows.
Re-run after **any** change to a subagent's description, skills or tools. `npm run
check:generated` rebuilds all three generated outputs and fails on a diff against `HEAD`,
so commit the regenerated file with the change.

## 8. Outside this codebase

Report these; do not reach for them from inside the mold.

- **Factory enum.** `state/application/app_id/application.schema.json` in the
  software-factory repository has an `agent_key` enum. A key missing from it cannot be
  named in a stamped application's per-agent configuration. Today it lists the ten base
  keys plus the four finance keys; a new key must be added there by whoever owns the
  factory repository.
- **Mold delta table.** `../MOLD.md` lists each subagent and the registration files.
- **Functional lane.** `../testing/functional/lane.json` (eve-subagent-verify).
- **Environment.** A new capability flag or secret is set per deployment in Vercel or the
  VM environment, by name only, and documented in `.env.example`.

## Removing or renaming a subagent

The same list in reverse. A rename is a remove plus an add: the key is also the `workflows`
row name and the `agent_configs.agent_key` in every workspace, so existing rows must be
renamed or the override, the pause state and the run history detach silently.

## Check

```bash
npm run check:subagents -- <key>
npm run typecheck
npm run build:subagent-meta && git status --short app/_components/subagent-meta.generated.ts
```
