---
name: eve-subagent-wiring
description: "Make a subagent known to the whole product without editing any list by hand: create agent/subagents/<key>/ (plus an optional subagent.json) and run `npm run build:subagent-meta`. Use after creating or renaming or removing a subagent, when someone says \"the new agent doesn't show up in the Agents tab / Control Panel / workflows\", \"its runs are missing\", \"the data room rejected the path\", \"where do I register it\", or when `npm run check:subagents` reports a key missing from a generated file or a bad subagent.json. Covers the subagent.json fields, the dataroomPaths template grammar, the additive agent/instructions/NN-*.md file for root delegation text, the workflows row (run accounting and operator override) on new and existing workspaces, per-workspace agent_configs, what consumes the generated registry, and the few curated overrides that remain."
---

# Wire a subagent into the product

Registering a subagent is **creating its directory and regenerating**. There is no list of
subagent keys to edit anywhere in this codebase.

```bash
mkdir -p agent/subagents/<key>          # with at least agent.ts (eve-subagent-workspace)
$EDITOR agent/subagents/<key>/subagent.json   # optional: name, summary, data-room paths
npm run build:subagent-meta             # node scripts/gen-subagent-meta.mjs
```

Two mechanisms do the work:

1. **eve** discovers `agent/subagents/<key>/agent.ts` and lowers it into a tool named
   `<key>` on the root agent. That is delegation.
2. **`scripts/gen-subagent-meta.mjs`** discovers the same directories (a folder is a
   subagent only if it has `agent.ts`) and writes two files that everything else reads:

| Generated file | Exports | Read by |
|---|---|---|
| `app/_components/subagent-meta.generated.ts` | `SUBAGENT_META` (name, summary, description, skill names, tool roster), `SUBAGENT_KEYS` | the web UI |
| `agent/lib/subagent-registry.generated.ts` | `SUBAGENT_KEYS`, `SUBAGENT_LABELS`, `SUBAGENT_SUMMARIES`, `EXTRA_DATAROOM_PATH_TEMPLATES` | the agent, the provisioner, scripts (plain data, no imports) |

[`references/generated-registry-consumers.md`](references/generated-registry-consumers.md)
lists every consumer with file and line, what each one drives, and the curated overrides
that are left. Read it before "fixing" a list by hand: if a new subagent is missing
somewhere, the cause is a stale generated file, not a missing list entry.

`<key>` is the directory name: lowercase letters, digits and hyphens, starting with a
letter, at most 80 characters (`setup/workspace-mcp.mjs` and the checker both enforce
`^[a-z][a-z0-9-]{0,79}$`). It is also the tool name the root calls, the `workflows` row
name and `agent_configs.agent_key`, so choose it once.

## 1. `subagent.json` (optional)

Next to `agent.ts`. Every field is optional; the file itself is optional.

```json
{
  "name": "Invoice Extraction",
  "summary": "Reads supplier invoices already in the data room and tabulates their line items with citations.",
  "dataroomPaths": ["{folder:accounts}/{customer_id}/invoices/**"]
}
```

| Field | Type | Default when absent | Shows up as |
|---|---|---|---|
| `name` | non-empty string | the key, title-cased (`invoice-extraction` becomes "Invoice Extraction") | the Agents tab row, delegation cards, the label in the root's pause/instructions block |
| `summary` | non-empty string, one line | the first sentence of the `agent.ts` `description` | the Agents tab description, the info-modal fallback, the `workflows` row description, the workflow-author's list |
| `dataroomPaths` | list of path templates | none | extra entries appended to `DATAROOM_PATH_TEMPLATES` |

Write a `name` when title-casing gets it wrong (acronyms: `kyc-review` becomes "Kyc
Review"). Write a `summary` when the description's first sentence is long: it is shown in
lists. Any other field fails `npm run check:subagents` (the generator ignores it, so a typo
such as `"sumary"` would otherwise pass silently).

### `dataroomPaths` template grammar

Every data-room tool validates paths against `DATAROOM_PATH_TEMPLATES`
(`agent/lib/dataroom-store.ts:112`); a path no template admits is refused. A subagent that
keeps its own files declares their templates here and the generator appends them
(`agent/lib/dataroom-store.ts:198`). `dm.md` stays the canonical core and is not edited.

A template is `/`-separated segments. The generator accepts it when it matches
`TEMPLATE_OK` (`scripts/gen-subagent-meta.mjs:59`) and contains no `..`:

```
^[A-Za-z0-9][A-Za-z0-9._-]*(/(\{[a-z_]+\}|[A-Za-z0-9_.{}-]+))*/(\*\*|[A-Za-z0-9_.{}-]+)$
```

In words:

- **At least two segments.** The first must be one of the data room's top-level **folders**,
  which are the deployment profile's (`dataroom.domains.<id>.folder`, `dataroom.uploads_folder`;
  `agent/lib/dataroom-folders.ts`). Write it as `{folder:<id>}` (`{folder:accounts}`,
  `{folder:platform}`, `{folder:deliveries}`, `{folder:solutions}`, `{folder:projects}`,
  `{folder:tickets}`, `{folder:people}`, `{folder:uploads}`) and the template is right under
  every profile; the generator writes the stored name into the registry. A pack that ships
  its own profile may write the stored name that profile gives instead, but `{folder:<id>}`
  is the safe choice: a deployment that already held files keeps its former folder names
  (docs/DEPLOYMENT_PROFILE.md, "Stored folder names"), so a name copied from the default
  profile is refused at build there. A pack cannot add a folder.
- **Middle segments** are a `{token}`, a literal (`invoices`), or a mix
  (`{date}_summary.md`). Literal characters are letters, digits, `_`, `.`, `-`. No spaces.
- **The last segment** is a file name (literal, token or mix) or `**`. `**` is allowed
  **only** as the last segment and matches any non-empty subtree of files, so
  `{folder:accounts}/{customer_id}/invoices/**` admits `.../invoices/2026/03/INV-0001.pdf`.
- **Tokens** are `{lower_snake}` and must be one the store knows (`TOKEN_PATTERNS`,
  `agent/lib/dataroom-store.ts:78`): `customer_id`, `platform_version_id`, `platform_id`,
  `person_id`, `agent_id`, `pipeline_id`, `migration_id`, `run_id`, `id` (slugs), `date`
  (`YYYY-MM-DD`), and the enum tokens `ticket_folder`, `component`, `signoff_role`,
  `design_doc`. For your own identifier use `{id}`.

The generator checks only the regex. The **domain and the tokens are checked when
`dataroom-store.ts` is imported**: `compileTemplate` (`agent/lib/dataroom-store.ts:207`)
throws on an unknown domain or token, and because templates compile at module load, one bad
template takes every data-room tool down. `npm run check:subagents` checks both offline, so
run it before building. `npm run test:dataroom` imports the store and fails loudly too.

Concrete paths must still pass the per-segment safety rule (`SAFE_SEGMENT`,
`agent/lib/dataroom-store.ts:234`): each segment starts with a letter or digit and holds
only letters, digits, `.`, `_`, space and `-`.

Prefer one `**` template per folder the subagent owns over many file templates, and keep
it under an existing entity (`{folder:accounts}/{customer_id}/<your-folder>/**`). Name a new
`.jsonl` so it does not end in `interactions.jsonl`, `personas.jsonl`, `output.jsonl`,
`trace.jsonl`, or match `tickets_*.jsonl`, `evals/dataset.jsonl`, `evals/benchmark.jsonl`:
`dataroom_append_jsonl` would validate it against that built-in contract
(`schemaForJsonlPath`, `agent/lib/dataroom-tools.ts:212`). State the exact paths in the
subagent's `instructions.md` output contract.

## 2. Root delegation text is an added file

The root agent sees each subagent's `agent.ts` description as a tool description. What a
description cannot carry is order and boundaries between siblings. Do **not** edit
the root prompt (`agent/prompt-*.md`, rendered by `agent/instructions.ts`) for that. eve combines
the root `agent/instructions.{md,ts}` first, then every
`.md` and `.ts` entry of `agent/instructions/` *"in alphabetical order by filename"*
(`node_modules/eve/docs/instructions.mdx`, "Split instructions across a directory"). So add
a file:

```md
<!-- agent/instructions/50-pack-invoices.md -->
## Invoices

- **invoice-extraction** — tabulates supplier invoices that are already in the data room:
  - Use for "pull the line items from ...", "what did <supplier> bill us in March".
  - Works only from files under `{folder:accounts}/{customer_id}/invoices/`. It does not fetch.
  - It sees only your message: name the customer, the period and the file paths.
```

Rules for this file:

- Name it `NN-<topic>.md`; a pack uses `NN-pack-<pack>.md`. Digits sort before the
  existing entries (`00-mode.ts`, then `agent-configs.ts`, `agent-profile.ts`, ...), so use
  10 to 89 and leave `00-` to the mode frame.
- One file per pack or product area, not per subagent, so the ordering between siblings
  ("fetch, then read, then tabulate") is written in one place.
- Keep rules out of it. The rulebook lives with the specialist; the root is told what to
  send and when, not how the specialist decides.
- It is static text captured at build time. Per-workspace wording belongs in
  `agent_configs` (section 4), never here.

## 3. The `workflows` row: run accounting and the operator override

In the Ops Center a workflow named after a subagent **is** that subagent. One row, two jobs:

1. **Run and token accounting.** `hooks/usage.ts` calls `recordWorkflowStep("<key>", …,
   ctx.session.id, <the session's workspace>)` and `agent/lib/workflow-usage.ts` finds the
   workflow **by name in that workspace only**. No row named `<key>` in the caller's
   workspace (or no workspace passed): no `automation_runs` row, no tokens in the Ops Center,
   and no error, because the recorder never throws.
2. **Operator override.** `instructions/operator-override.ts` calls
   `loadWorkflowOverride("<key>", orgId)` on every `turn.started`. When the row is enabled,
   has `instructions` text and `instructions_enabled` is true, the text is appended after
   `instructions.md` as a delimited block marked untrusted preference data. An operator's
   edit takes effect on the subagent's next turn, with no deploy.

Rows are per workspace (`workflows.org_id` is NOT NULL and row-level security keys on it).

**New workspaces get the row automatically.** `provisionWorkspace`
(`agent/lib/provision-workspace.ts:152`) inserts one `trigger: "on delegation"` row per key
in `SUBAGENT_KEYS`, with `SUBAGENT_SUMMARIES[key]` as the description. It runs from both
doors: the self-serve wizard (`POST /api/ops/orgs`, `app/api/ops/orgs/route.ts:228`) and
`npm run operator:new-org` (`scripts/operator/new-org.mjs:85`). It is idempotent by
`(name, org_id)`.

**An existing workspace does not**, until someone adds it. `npm run operator:seed-workflows`
does **not** do this: it installs only the scripted library from
`scripts/operator/workflows/*.workflow.js` and never calls `provisionWorkspace`. The real options
(the first is the supported one):

| How | Command or clicks | Notes |
|---|---|---|
| **Backfill (use this)** | `npm run operator:seed-subagent-rows -- --org <org_id>` | `scripts/operator/seed-subagent-rows.mjs` calls `seedSubagentWorkflowRows` (`agent/lib/provision-workspace.ts`), the same function `provisionWorkspace` uses. Idempotent; inserts the missing rows and touches nothing else. Needs `DATABASE_URL` in `.env.local`. |
| Ops Center | Workflows panel, the new-workflow wizard: trigger "On delegation" (the preselected choice), name exactly `<key>` | no terminal; the right choice for an operator |
| API | `POST /api/ops/workflows` with `{"name":"<key>","description":"<summary>","trigger":"on delegation"}` as a signed-in member of that workspace | schema: `app/api/ops/workflows/route.ts:12` |
| MCP | `workflow_create` (name and description; its trigger defaults to `on delegation`) | `setup/workspace-mcp.mjs:1447`, for an engineer already connected |
| Re-provision (avoid) | `npm run operator:new-org -- --name "<existing display name>" --id <org_id> --domain <existing domain> --owner <owner email> --force` | re-runs `provisionWorkspace` (adds every missing row, skips present ones). It also **rewrites the `orgs` row** from the flags: omit `--domain` and the Google hosted domain is set to null. Pass every value as it is today. Needs `DATABASE_URL` in `.env.local`. |

Rows whose trigger is `on delegation` are deliberately **left out of the Workflows list**
(`app/_components/ops/workflows-panel.tsx:1392`: they are delegation targets, not runnable
scripts), so the row does its accounting job without appearing there. Its override text is
set with `PATCH /api/ops/workflows/<id>` (`instructions`, `instructionsEnabled`). A row
named `<key>` with any other trigger is listed, and the editor then labels its override as
reaching `agent/subagents/<key>/instructions.md` (`workflows-panel.tsx:203`, `:373`); the
override loader matches by name only, whatever the trigger.

The id lookup is cached for the life of the process, so a row added after the subagent's
first turn starts counting on the next cold start.

`scripts/seed-ops.mjs` also derives its rows from the registry, but it is a legacy
single-tenant seed (no npm script, no `org_id`); do not rely on it.

## 4. Per-workspace configuration (`agent_configs`)

Table `agent_configs` (`org_id`, `agent_key`, `paused`, `instructions`), written by the
Workspace "Agents" tab through `PUT /api/ops/agent-configs` (admin or owner only; the key
is a free string and `instructions` is capped at 4000 characters). The tab lists every key
in `SUBAGENT_META`, so a new subagent has its row in the UI after the rebuild.
`agent/instructions/agent-configs.ts` injects the table into the **root** agent each turn:
paused subagents are listed as "do not delegate", and custom text is rendered as "When
delegating to the <label> subagent, apply these workspace instructions: ...". The label
comes from `AGENT_LABELS`, then `SUBAGENT_LABELS` (`agent/lib/agent-configs.ts:53`).

So this text reaches the subagent only through the message the root writes; the
`workflows` override reaches the subagent's own context. The codebase ships **no**
`agent_configs` rows: they are per-workspace data. Engineers can set them over MCP
(`agent_list` and `agent_configure` in `setup/workspace-mcp.mjs`), which accepts any
well-formed key. See eve-customize-existing-agent for which lever to use.

## 5. Things that are still yours to consider

None of these is required for a subagent to work, show up and be accounted for.

| File:line | What | When to touch it |
|---|---|---|
| `agent/lib/customer-schema.ts:30` | `TICKET_CATEGORY_ROUTING` | only if a ticket category should triage to the new subagent (the categories are a closed enum) |
| `scripts/operator/workflows/*.workflow.js` | library workflows naming `{ subagent: "..." }` | when shipping a scripted workflow that uses it; then `npm run build:workflow-library` |
| `scripts/gen-subagent-meta.mjs:37-43` | lib files searched for a re-exported tool's description | when a tool comes from a new `agent/lib/*-tools.ts`; cosmetic (the Control Panel shows the tool with no description) |
| `scripts/subagent-shared/<family>/targets.json` | which subagents carry a shared helper family | if its scripts import one (eve-sandbox-workspace) |
| `AGENTS.md` "Capability flags" | the named `web_search` sites | if a subagent shipped **in the base app** declares `web_search`; a pack documents its own |
| `.env.example` | a new environment variable | a new capability flag or secret, by name only |

`agent/subagents/workflow-author/prompt.md:28` names seven built-in subagents in
prose. Leave it: `instructions/10-declared-subagents.ts` appends the full discovered list
after it and says it supersedes the shorter one (and a profile's `specialists.exclude` drops an
excluded name from both).

## Renaming or removing a subagent

Remove: delete `agent/subagents/<key>/`, remove the key from any
`scripts/subagent-shared/*/targets.json`, delete or edit the
`agent/instructions/NN-*.md` paragraph that names it, then `npm run build:generated`. The
generated files drop the key and its data-room templates. Existing data-room files stay
where they are but become unwritable through the tools once their template is gone.

A rename is a remove plus an add, **plus data**: the key is the `workflows` row name and
`agent_configs.agent_key` in every workspace, and the literal in
`instructions/operator-override.ts` and `hooks/usage.ts`. Rows left under the old name
detach silently: the override stops applying, the pause state is lost and run history
splits. Rename the rows in each workspace, or do not rename.

## Check

```bash
npm run build:subagent-meta
git status --short app/_components/subagent-meta.generated.ts agent/lib/subagent-registry.generated.ts
npm run check:subagents -- <key>     # key in both generated files, subagent.json well formed, templates known to the store
npm run test:dataroom                # imports the store: a bad template throws here
npm run typecheck
```

`npm run check:generated` rebuilds every generated output and fails on a diff against
`HEAD`, so commit the regenerated files with the change that caused them.
