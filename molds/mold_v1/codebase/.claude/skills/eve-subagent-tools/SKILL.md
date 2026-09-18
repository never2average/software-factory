---
name: eve-subagent-tools
description: "Choose and declare the tools of a subagent in this eve codebase (the narrowest set, re-exported from agent/lib, with web_search only through the ENABLE_WEB_SEARCH gate). Use when adding or removing a tool on a subagent, when someone says \"give the X subagent web search / memory / data-room access\", \"why can't the subagent read the PDF\", \"should this be a tool or a script\", or when `npm run check:subagents` reports an ungated web_search. Covers the one-line re-export pattern, the gate in agent/lib/feature-flags.ts and why every declaring site (pack subagents included) needs it, the data-room tools including dataroom_fetch_to_sandbox for binaries, the memory tools, approvals, and when a new typed tool is justified."
---

# Tools for a subagent

Read `node_modules/eve/docs/tools/overview.mdx` and `subagents.mdx` first. The mechanics
that matter:

- *"The filename is the tool name the model sees."* `tools/dataroom_read.ts` is the tool
  `dataroom_read`. Use snake_case.
- A declared subagent has *"Own `tools/`"* and inherits none of the root's. Every tool the
  child needs has a file in `agent/subagents/<key>/tools/`.
- Tools *"run in your app runtime with full access to `process.env`, not in the sandbox"*.
  That is the dividing line with scripts: a tool can reach the database, blob storage and
  secrets; a script can only see `/workspace`.
- The built-in `bash`, `read_file`, `write_file`, `glob`, `grep` and `load_skill` come from
  the framework. You do not declare them.
- A subagent's directory name shares the tool namespace. A subagent called `publish_artifact`
  would collide with the tool and eve *"rejects the build rather than picking a winner"*.

## Choose the narrowest set

Every tool costs context on every step (its description and schema are always visible) and
is one more thing the model can be talked into calling. Start from the output contract in
`instructions.md` and add only what a step in it needs. Ask of each tool: which sentence of
the instructions uses it? If none, leave it out.

| The subagent needs to | Declare | From |
|---|---|---|
| know which customer record it is working on | `get_customer`, `list_customers` | `#lib/tools.js` |
| create or correct a customer record | `upsert_customer` | `#lib/tools.js` |
| see what is filed | `dataroom_list` | `#lib/dataroom-tools.js` |
| read a text file or a `.jsonl` log | `dataroom_read` | `#lib/dataroom-tools.js` |
| parse a PDF, XLSX, PPTX or image | `dataroom_fetch_to_sandbox` | `#lib/dataroom-tools.js` |
| write a text artifact (`.md`, `.json`) | `dataroom_write` | `#lib/dataroom-tools.js` |
| append rows to a log | `dataroom_append_jsonl` | `#lib/dataroom-tools.js` |
| rewrite many files as one revertible batch | `backfill_start`, `backfill_finish` | `#lib/dataroom-tools.js` |
| hand the user a file (xlsx, html, csv) | `publish_artifact` | `#lib/tools.js` |
| build a formatted workbook from rows | `build_workbook_spec` | `#lib/artifact-render-tools.js` |
| recall or save a standing fact | `list_memories`, `remember` | `#lib/memory-tools.js` |
| look on the open web | `web_search`, gated (below) | `#lib/tools.js` |

A reader that never writes gets no write tools. A subagent that works "only from documents
already in the data room" gets no `web_search`; one whose job is fetching does. Tools
outside the subagent's job (tickets, email, paging, schedules, signoffs) stay out.

## The re-export pattern

Tool implementations live once in `agent/lib/*-tools.ts` / `agent/lib/tools.ts` as named
`defineTool` exports. A tool file is one line:

```ts
// agent/subagents/<key>/tools/dataroom_read.ts
export { dataroomReadTool as default } from "#lib/dataroom-tools.js";
```

`#lib/*` is the `imports` map in `package.json` (`"#*": "./agent/*"`); the specifier ends
in `.js` even though the source is `.ts`. `scripts/gen-subagent-meta.mjs` resolves exactly
this `export { X as default }` form to show the tool's description in the Control Panel,
and searches `agent/lib/tools.ts`, `dataroom-tools.ts`, `artifact-render-tools.ts`,
`sync-tools.ts` and `signoff-tools.ts`. Tools re-exported from another lib file (for
example `memory-tools.ts`) show with no description there; that is cosmetic.

Do not copy a tool's implementation into a subagent. Two copies drift, and the org-scoping
and approval rules inside the shared ones are the security boundary.

## `web_search`: only through the gate

```ts
// agent/subagents/<key>/tools/web_search.ts
import { disableTool } from "eve/tools";
import { webSearchTool } from "#lib/tools.js";
import { WEB_SEARCH_ENABLED } from "#lib/feature-flags.js";

export default WEB_SEARCH_ENABLED ? webSearchTool : disableTool();
```

Never the plain one-line re-export for this tool. `agent/lib/feature-flags.ts` reads
`ENABLE_WEB_SEARCH` (default on; `false`, `0`, `off` or `no` turns it off) and the tool
file exports eve's `disableTool()` sentinel so the tool is never registered and *"the model
never sees it"*. That is stronger than refusing inside `execute()`: a tool the model cannot
see is not one it can be talked into calling.

Why every declaring site must gate: the flag is a promise to a customer's security review
that the agent has no outbound search. Each subagent declares its own tools, so gating only
the root leaves every subagent that declares `web_search` with full web access while the
flag reads "off". A flag that covers some callers is worse than none, because it reports a
guarantee it does not provide. **This applies to subagents a pack adds exactly as it does
to built-in ones**: a pack cannot edit `AGENTS.md`, so the code is the guarantee. List the
sites before relying on it, and do not trust a count written in a comment:

```bash
grep -rl "webSearchTool" agent --include='*.ts' | grep -v '^agent/lib/'                # every declaring site
find agent -name 'web_search.ts' | xargs grep -L WEB_SEARCH_ENABLED                    # must print nothing
```

In the base app that is four sites: the root `agent/tools/web_search.ts` plus the
`research`, `app-author` and `customer-context` subagents. `npm run check:subagents` fails
any `agent/**/tools/web_search.ts` without the gate, whether or not the subagent follows
the workspace standard. The flag is read at **build** time: flipping it needs a rebuild and
redeploy.

`disableTool()` is for eve's own built-in tool slots, of which `web_search` is one. A
capability made of **authored** tools is gated differently: see
`agent/subagents/browser/tools/browser.ts`, which resolves its tool set with `defineDynamic`
on `ENABLE_BROWSER`, because the Vercel-target build refuses `disableTool()` on a tool name
that is not a framework slot. A new capability that reaches outside the deployment gets its
own flag in `feature-flags.ts` and the matching treatment at every site.

Because the tool may be absent, the instructions of a subagent that declares it must say
what to do without it ("When web search is not available, work from what is in the data
room and say what you could not fetch").

## Data-room tools

- All paths are validated against `DATAROOM_PATH_TEMPLATES` in
  `agent/lib/dataroom-store.ts`; an invalid path comes back as an error message the model
  can correct. A new path family is declared in the subagent's `subagent.json`
  (`dataroomPaths`), never by editing that file (eve-subagent-wiring).
- `dataroom_read` decodes as text, and parses `.jsonl` into `records`. It returns mangled
  bytes for a PDF or a workbook.
- `dataroom_fetch_to_sandbox` is the bridge for binaries: it returns a short-lived download
  URL plus the exact `curl` command, the model runs it with `bash`, then parses the local
  file with a script. On a local-filesystem data room it returns an `error` saying there is
  nothing to bridge. Any subagent whose skills parse documents needs this tool, and its
  sandbox must allow that download (eve-sandbox-workspace).
- `dataroom_append_jsonl` is gated with `approval: once()`. It validates records against a
  zod contract chosen **by file-name pattern** (`schemaForJsonlPath` in
  `agent/lib/dataroom-tools.ts`): `interactions.jsonl`, `personas.jsonl`,
  `tickets_*.jsonl`, `evals/dataset.jsonl`, `evals/benchmark.jsonl`, and anything ending in
  `output.jsonl` or `trace.jsonl`. Name a new log so it does not end in one of those, or
  its rows are rejected against the wrong contract. Other paths append unvalidated, which
  is why the subagent's own `validate_*.py` runs first.
- `dataroom_write` overwrites in place. For a batch, `backfill_start` opens a changeset
  whose id goes on every write, and `backfill_finish` closes it so it can be reverted as one.
- `publish_artifact` returns a private, time-limited signed link. Binary artifacts are
  built in the sandbox first.

## Memory tools

`remember`, `list_memories` and `forget` write to the team's **shared** long-term memory,
scoped `team`, `customer:{id}` or `person:{id}`. For a document-reading subagent the use is
narrow: standing facts about how one source behaves ("this supplier states amounts net of
tax", "dates are day-first"), scoped `customer:{customer_id}`. Never an extracted value:
values live in the data room with a citation, and a value in memory gets quoted without
one. Give a subagent `list_memories` and `remember`; leave `forget` (approval-gated,
deletes for everyone) to the root.

Only the root has the `turn.started` resolver that injects memories into context
(`agent/instructions/memory.ts`). A subagent reads them by calling `list_memories`, so its
instructions must say when.

## A new typed tool, or a script?

| Write a **script** (`sandbox/workspace/scripts/`) when | Write a **tool** (`agent/lib/` + re-export) when |
|---|---|
| it is pure computation on files in `/workspace` | it needs the database, blob storage, a secret or `process.env` |
| it needs a Python parser | it must be scoped to the caller's workspace (`orgForSession(ctx)`) |
| it should be testable offline with `--self-test` | it needs human approval (`approval: once()` / `always()`) |
| the output is JSON the model reads | the model's view should be trimmed with `toModelOutput` |

If a tool is needed: put the `defineTool` in a **new** `agent/lib/<area>-tools.ts` as a
named export (a pack adds a file; it never edits an existing lib file), with a zod
`inputSchema` whose fields have `.describe()`, return an `{ error }` message for bad input
rather than throwing, scope every query by workspace, return JSON-serialisable data with no
secrets, and make side effects idempotent (eve re-runs a step interrupted mid-execution).
Re-export it from each subagent that needs it. A tool defined inline in the subagent's own
`tools/<name>.ts` also gets its description picked up by the generator. Run
`npm run check:tenancy` if it touches the database.

## Check

```bash
npm run typecheck
npm run check:subagents -- <key>      # fails an ungated tools/web_search.ts
npm run build:subagent-meta           # the Control Panel tool roster
```
