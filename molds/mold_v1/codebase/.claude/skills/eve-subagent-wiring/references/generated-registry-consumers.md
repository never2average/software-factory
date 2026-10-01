# What consumes the generated subagent registry

Nothing in this table is edited to add a subagent. Each site reads a file written by
`scripts/gen-subagent-meta.mjs` (`npm run build:subagent-meta`). If a new subagent is
missing from one of these surfaces, regenerate; do not add the key by hand.

Line numbers were verified by `grep` on this branch. Re-verify before citing them:

```bash
grep -rn "subagent-registry.generated\|subagent-meta.generated" agent app scripts setup package.json | grep -v "^scripts/gen-subagent-meta"
```

## The generator

| File:line | What |
|---|---|
| `scripts/gen-subagent-meta.mjs:63-66` | discovery: every `agent/subagents/<name>/` that has `agent.ts` |
| `scripts/gen-subagent-meta.mjs:67-75` | reads the optional `subagent.json`; invalid JSON exits 1 |
| `scripts/gen-subagent-meta.mjs:59`, `:76-82` | `TEMPLATE_OK` and the `dataroomPaths` check (regex and no `..`); a bad entry exits 1 |
| `scripts/gen-subagent-meta.mjs:105-106` | `name` falls back to the title-cased key, `summary` to the first sentence of the description |
| `scripts/gen-subagent-meta.mjs:138` | writes `app/_components/subagent-meta.generated.ts` |
| `scripts/gen-subagent-meta.mjs:163` | writes `agent/lib/subagent-registry.generated.ts` |
| `package.json:63-65` | `build:subagent-meta`, part of `build:generated` (which `prebuild` runs), diffed by `check:generated` |

## Consumers of `agent/lib/subagent-registry.generated.ts`

| File:line | Reads | Drives | Without a rebuild |
|---|---|---|---|
| `agent/lib/agent-configs.ts:13`, `:53` | `SUBAGENT_LABELS` | the label in the root's "PAUSED" and "when delegating to the <label> subagent" block | the raw key is shown |
| `agent/lib/dataroom-store.ts:46`, `:198` | `EXTRA_DATAROOM_PATH_TEMPLATES` | appended to `DATAROOM_PATH_TEMPLATES`, compiled at import | the subagent's paths are refused by every data-room tool |
| `agent/lib/provision-workspace.ts:35`, `:152`, `:165` | `SUBAGENT_KEYS`, `SUBAGENT_SUMMARIES` | one `trigger: "on delegation"` `workflows` row per key when a workspace is provisioned | new workspaces get no row: runs unrecorded, no override |
| `agent/subagents/workflow-author/instructions/10-declared-subagents.ts:9`, `:19` | `SUBAGENT_KEYS`, `SUBAGENT_SUMMARIES` | the list of subagents a workflow script's `agent()` may name (minus `workflow-author`, `app-author`, `browser`); resolved at build time | the workflow author does not know the key |
| `scripts/seed-ops.mjs:6`, `:48-50` | `SUBAGENT_KEYS`, `SUBAGENT_SUMMARIES` | legacy single-tenant seed rows (no npm script; inserts no `org_id`) | nothing in a current deployment |

## Consumers of `app/_components/subagent-meta.generated.ts`

| File:line | Reads | Drives | Without a rebuild |
|---|---|---|---|
| `app/_components/tool-display.ts:6`, `:76`, `:85` | `SUBAGENT_META[name].summary`, `.name` | info-modal copy and display name for a subagent with no curated entry | generic "A delegated specialist agent ..." copy; the key is title-cased at render |
| `app/_components/ops/workspace-panel.tsx:77`, `:557-562` | `SUBAGENT_META` | the Workspace "Agents" tab rows (pause, per-workspace instructions): curated rows first, then every other key | no row, so no UI to pause or instruct it |
| `app/_components/ops/workflows-panel.tsx:107`, `:180` | `SUBAGENT_KEYS` | `SUBAGENT_IDS`: whether the editor says an override reaches a subagent and labels it `agent/subagents/<key>/instructions.md` (`:203`, `:373`) | the override is labelled `<key>.override.md` and described as not reaching a subagent |
| `app/_components/insights.ts:8`, `:339` | `SUBAGENT_KEYS` | recognising a bare-name delegation tool call as a subagent run in the Control Panel (the `eve:subagent:<name>` prefix needs no list) | the run is filed as an ordinary tool result |
| `app/_components/cockpit.tsx:52`, `:854`, `:3409` | `SUBAGENT_META` | the Control Panel's rail description and the info dialog (description, skills, tool roster) | the dialog has nothing to show |

## Curated overrides that remain (intentionally hand-written)

These hold nicer copy for the **ten built-in** subagents. They are overrides, not
registries: a key that is absent falls through to the generated data. Do not add pack or
product subagents to them; write a `subagent.json` instead.

| File:line | Constant | Note |
|---|---|---|
| `agent/lib/agent-configs.ts:35` | `AGENT_LABELS` | wins over `SUBAGENT_LABELS` |
| `app/_components/tool-display.ts:39` | `SUBAGENT_NAMES` | wins over `SUBAGENT_META[name].name` |
| `app/_components/tool-display.ts:52` | `SUBAGENT_DESCRIPTIONS` | wins over `SUBAGENT_META[name].summary` |
| `app/_components/ops/workspace-panel.tsx:545` | `CURATED_SUBAGENTS` | curated name, description and display order; a curated key with no directory is dropped (`:558`) |
| `app/_components/insights.ts:328` | the literal names in `SUBAGENT_NAMES` | kept so attribution survives a stale generated file; `...SUBAGENT_KEYS` follows |
| `scripts/seed-ops.mjs:35` | `CURATED_WORKFLOWS` | legacy seed copy |
| `setup/workspace-mcp.mjs:355` | `SUBAGENT_IDS` | a hint for listings and messages only. The MCP ships without the codebase, so it cannot read the registry; `SUBAGENT_KEY` (`:354`) accepts any well-formed key (`:686`) and `agent_list` adds any key the workspace has configured (`:664`) |
| `agent/subagents/workflow-author/instructions.md:28` | prose list of seven keys | superseded at build time by `instructions/10-declared-subagents.ts` |

## Not registries, but they name subagents

| File:line | What | Touch when |
|---|---|---|
| `agent/instructions.md:11` | "What you own": the root's delegation paragraphs for the built-ins | never for a new subagent; add `agent/instructions/NN-<topic>.md` instead |
| `agent/lib/customer-schema.ts:30` | `TICKET_CATEGORY_ROUTING` (closed category enum to subagent key) | a ticket category should triage to a new subagent |
| `scripts/operator/workflows/*.workflow.js` | scripted workflows that name `{ subagent }` | shipping a library workflow; then `npm run build:workflow-library` |
| `agent/lib/workflow-override.ts`, `agent/lib/db/schema.ts` | comments that list subagent ids in prose | never required; keep truthful when convenient |

## Generated, never hand-edited

- `app/_components/subagent-meta.generated.ts` and `agent/lib/subagent-registry.generated.ts` from `npm run build:subagent-meta`
- `agent/lib/workflow-library.generated.ts` from `npm run build:workflow-library` (source: `scripts/operator/workflows/*.workflow.js`)
- `setup/skills/` from `npm run build:skill-library`
- `agent/subagents/<key>/sandbox/workspace/scripts/<family>/` from `npm run sync:subagent-shared` (source: `scripts/subagent-shared/<family>/`)
