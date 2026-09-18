# Registration sites: what to add, and what breaks without it

`<key>` is the directory name under `agent/subagents/`. `<Label>` is the human name.
Line numbers read 2026-09-18; find the constant by name if they have moved.

## Required (checked by `npm run check:subagents`)

### 1. `agent/lib/agent-configs.ts:34` — `AGENT_LABELS`

```ts
  "<key>": "<Label>",
```

Without it: the orchestrator is told "the following subagents are PAUSED: <key>" with the
raw key instead of a label. Works, reads badly.

### 2. `app/_components/tool-display.ts:37` — `SUBAGENT_NAMES`, and `:54` — `SUBAGENT_DESCRIPTIONS`

```ts
  "<key>": "<Label In Title Case>",
```
```ts
  "<key>":
    "<Two sentences on what it does, for the rail's info modal.>",
```

Without it: the name falls back to title-casing the key (acronyms come out wrong, "Hfc Kpi
Extraction") and the modal shows the generic "A delegated specialist agent ..." copy.

### 3. `app/_components/ops/workspace-panel.tsx:543` — `SUBAGENTS`

```ts
  { key: "<key>", name: "<Label>", description: "<One sentence.>" },
```

Without it: no row in the Workspace "Agents" tab, so an admin cannot pause it or give it
per-workspace instructions from the UI. Put product specialists first; the order is the
display order.

### 4. `app/_components/ops/workflows-panel.tsx:179` — `SUBAGENT_IDS`

```ts
  "<key>",
```

Without it: the workflow editor treats the `<key>` workflow as an ordinary workflow, labels
its override file `<key>.override.md`, and tells the operator the override does not reach a
subagent, although it does.

### 5. `app/_components/insights.ts:326` — `SUBAGENT_NAMES`

```ts
  "<key>",
```

Without it: a delegation that arrives as a bare tool name (rather than
`eve:subagent:<key>`) is filed as an ordinary tool result and the run never appears in the
Control Panel.

### 6. `scripts/seed-ops.mjs:34` — `WORKFLOWS`

```js
  { name: "<key>", description: "<One line.>", trigger: "on delegation" },
```

Without a `workflows` row named `<key>`: no `automation_runs` rows (no run history, no
token usage) and nowhere for an operator to write an override. The seed inserts only into
an empty table; existing deployments add the row in the Ops Center.

### 7. `agent/instructions.md:39` — `## What you own`

The `- **<key>** — ...` entry (see the wiring skill, section 2). The checker looks for
`**<key>**` or `` `<key>` ``.

Without it: the root still has the tool, but has no guidance on ordering and boundaries
between siblings, and delegates to the wrong one for close requests.

## Advisory

### `setup/fde-mcp.mjs:352` — `SUBAGENT_IDS`

```js
  "evals", "workflow-author", "app-author", "follow-ups", "browser", "<key>",
```

Without it: the fde MCP's per-agent configuration tool throws `Unknown subagent "<key>"`
(`setup/fde-mcp.mjs:682`). As of 2026-09-18 the finance keys `hfc-kpi-extraction`,
`lodr-filings`, `investor-presentations` and `annual-report-format` are missing here.

### `agent/subagents/workflow-author/instructions.md:28-29`

The sentence "The subagents `agent()` may name: ..." Add `` `<key>` `` if operator workflow
scripts should be able to target it. Only the seven original keys are listed today.

### `scripts/sync-fin-workspace.mjs:11` — `FIN_SUBAGENTS`

Add `"<key>"` if its scripts import `finlib`, then `npm run sync:fin-workspace`.

### `agent/lib/customer-schema.ts:30` — `TICKET_CATEGORY_ROUTING`

Maps a ticket category to the subagent that triages it. Touch only if a category should
route to the new subagent.

## Comment-only mentions

`agent/lib/workflow-override.ts:6-7` and `agent/lib/db/schema.ts:1059-1060` list the
original seven ids in prose. They do not affect behaviour.

## Generated (never hand-edit)

- `app/_components/subagent-meta.generated.ts` from `npm run build:subagent-meta`
- `agent/lib/workflow-library.generated.ts` from `npm run build:workflow-library`
  (source: `scripts/fde/workflows/*.workflow.js`)
