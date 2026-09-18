# Subagent packs

A **subagent pack** adds a vertical (a set of specialist subagents for one line of work:
invoice processing, contract review, research in some industry) to this app **without
forking it and without editing a single base file**.

A pack is a directory tree that mirrors the codebase root and only **adds** files:

| Path in the pack | What it is | Required |
|---|---|---|
| `agent/subagents/<key>/**` | one directory per subagent: `agent.ts`, optional `subagent.json`, instructions, skills, tools, sandbox, rulebook | at least one |
| `agent/instructions/NN-pack-<name>.md` | the root agent's delegation text for the pack: which specialist to use when, in what order, what to put in the message | recommended |
| `scripts/subagent-shared/<family>/**` | Python helper code several of the pack's subagents share, plus `targets.json` | if they share code |
| `agent/lib/<pack>-tools.ts` | a new typed tool the pack needs (a **new** file, re-exported from the subagents' `tools/`) | rarely |
| `docs/<PACK>.md` | the pack's own documentation | optional |

## The one rule

**A pack never modifies an existing file.** Not `agent/instructions.md`, not
`agent/lib/dataroom-store.ts`, not `dm.md`, not a list in `app/_components/`, not
`package.json`, not `AGENTS.md`. Everything the base app needs to know about a pack's
subagents it discovers:

| The base app needs | It gets it from | Mechanism |
|---|---|---|
| the subagent as a delegation target | `agent/subagents/<key>/agent.ts` | eve discovers the directory and gives the root a tool named `<key>` |
| its key, display name and summary in every UI list, label and provisioned row | the directory, plus optional `subagent.json` | `scripts/gen-subagent-meta.mjs` writes `app/_components/subagent-meta.generated.ts` and `agent/lib/subagent-registry.generated.ts`; every consumer reads those |
| permission to write its data-room folders | `subagent.json` `"dataroomPaths"` | the generator appends them to `DATAROOM_PATH_TEMPLATES` |
| when the root should delegate to it | `agent/instructions/NN-pack-<name>.md` | eve loads `agent/instructions.md` first, then every `.md`/`.ts` in `agent/instructions/` in filename order |
| shared sandbox helpers | `scripts/subagent-shared/<family>/` with `targets.json` | `npm run sync:subagent-shared` copies the family into each target's sandbox seed |

The two `*.generated.ts` files and the synced copies under
`agent/subagents/<key>/sandbox/workspace/scripts/<family>/` are **outputs**. They change
when a pack is applied; nobody edits them. If applying a pack seems to require editing a
base file, that is a gap in the base app's extension points: fix it in the base app, for
every pack, rather than in the pack.

`git status --short` after applying a pack should show only `??` (added) entries, plus
` M` on exactly those two generated files.

## Apply a pack

```bash
cp -R <pack>/. .                 # copy over the codebase root; a pack only adds, so nothing is overwritten
npm run sync:subagent-shared     # copy shared helper families into the subagents that use them
npm run build:generated          # regenerate the subagent registry (and the other generated files)
npm run check:subagents          # the registry is current; every pack subagent meets the workspace standard
npm run typecheck
npm run build:eve                # the agent bundle: this is what compiles the new subagents
```

As one line:

```bash
npm run sync:subagent-shared && npm run build:generated && npm run check:subagents && npm run typecheck && npm run build:eve
```

To make sure the copy overwrote nothing, check before copying:

```bash
(cd <pack> && find . -type f) | while read -r f; do [ -e "$f" ] && echo "EXISTS: $f"; done   # must print nothing
```

Then commit the pack's files together with the regenerated files and the synced copies
(`npm run check:generated` and `npm run check:subagent-shared` fail in CI otherwise), and
deploy. The sandbox templates of the new subagents are built on first use.

**Existing workspaces** need one thing a deploy cannot do: a `workflows` row per new
subagent, named exactly `<key>`. Workspaces created after the pack is applied get it
automatically (`provisionWorkspace`). For older ones, run this once per workspace:

```
npm run fde:seed-subagent-rows -- --org <org_id>
```

The command is idempotent and touches nothing else. The alternatives are in "The `workflows` row" in
`.claude/skills/eve-subagent-wiring/SKILL.md`. Without the row the subagent still works,
but its runs and tokens are not recorded and it has no operator override.

## Declaring names, summaries and data-room paths

`agent/subagents/<key>/subagent.json`, next to `agent.ts`. Optional, as is every field:

```json
{
  "name": "Invoice Extraction",
  "summary": "Reads supplier invoices already in the data room and tabulates their line items with citations.",
  "dataroomPaths": ["Customers/{customer_id}/invoices/**"]
}
```

- `name`: the display name. Default: the key, title-cased. Set it when that is wrong
  (`kyc-review` would become "Kyc Review").
- `summary`: one line for lists, the Agents tab and the provisioned `workflows` row.
  Default: the first sentence of the `agent.ts` `description`.
- `dataroomPaths`: path templates the subagent may read and write, beyond the built-in
  ones in `dm.md`. A template is `Domain/segment/.../last`:
  - the first segment is an existing data-room domain (`Customers`, `Platform`,
    `Deployments`, `Solutions`, `Implementation`, `Tickets`, `People`, `Uploads`); a pack
    cannot add a domain;
  - a segment is a literal (`invoices`), a `{token}`, or a mix (`{date}_summary.md`);
  - tokens are the ones the store knows: `{customer_id}`, `{platform_version_id}`,
    `{platform_id}`, `{person_id}`, `{agent_id}`, `{pipeline_id}`, `{migration_id}`,
    `{run_id}`, `{id}`, `{date}`, and the enum tokens `{ticket_folder}`, `{component}`,
    `{signoff_role}`, `{design_doc}`;
  - `**` is allowed only as the last segment and admits any file subtree.

  Prefer one `**` template per folder the pack owns, under an existing entity:
  `Customers/{customer_id}/<pack-folder>/**`. Unknown fields, an unknown domain or token,
  and a malformed template all fail `npm run check:subagents`. The full grammar, with file
  and line, is in `.claude/skills/eve-subagent-wiring/SKILL.md`.

The key itself is the directory name: lowercase letters, digits and hyphens. It must not
collide with a built-in subagent, with a file in `agent/tools/`, or with another pack, so
prefix it when in doubt (`inv-extraction`, `inv-matching`).

## Web search and other gated capabilities

`ENABLE_WEB_SEARCH=false` is a promise to a customer's security review that the agent has
no outbound search. Each subagent declares its own tools, so **a pack subagent that declares
`web_search` must use the same gated re-export as the base app**, never the plain one-line
re-export:

```ts
// agent/subagents/<key>/tools/web_search.ts
import { disableTool } from "eve/tools";
import { webSearchTool } from "#lib/tools.js";
import { WEB_SEARCH_ENABLED } from "#lib/feature-flags.js";

export default WEB_SEARCH_ENABLED ? webSearchTool : disableTool();
```

`npm run check:subagents` fails any `agent/**/tools/web_search.ts` without the gate. A
subagent that may lose the tool must say in its `instructions.md` what it does without it.
A pack that reaches outside the deployment in some other way (its own HTTP tool) documents
that in its `docs/<PACK>.md` and gives it a flag a deployment can turn off; the flag is
read at build time, like the others.

## The workspace standard

Every subagent in a pack is a full workspace, not a prompt: the operator's rulebook
verbatim in `schemas/<name>-spec.md` with an `## Open points` section, at least six skills
(one per way the input varies), a sandbox in the folder layout with seeded scripts and
schemas, every script with `--self-test`, a validator for every file it writes that runs
before any write, the narrowest tool set. `npm run check:subagents` enforces it for every
subagent that has `sandbox/workspace/`. Seven skills under `.claude/skills/` walk through
building one; start with `eve-subagent-workspace` (see "Customising the eve agents" in
`AGENTS.md`).

## Remove a pack

```bash
rm -rf agent/subagents/<key> ...                 # every subagent directory the pack added
rm agent/instructions/NN-pack-<name>.md
rm -rf scripts/subagent-shared/<family> ...      # every family the pack added
rm -f agent/lib/<pack>-tools.ts docs/<PACK>.md   # if the pack had them
npm run build:generated && npm run check:subagents && npm run check:subagent-shared && npm run typecheck && npm run build:eve
```

If a family is also used by a subagent that stays, keep the family and remove only the
departing keys from its `targets.json`.

The regenerated files drop the keys, the labels and the data-room templates. What is left
is data, per workspace, and removing it is a decision for that workspace's owner:

- files under the pack's data-room folders stay in storage but can no longer be read or
  written through the data-room tools once their template is gone;
- the `workflows` rows named after the subagents, their run history, and any
  `agent_configs` rows keep existing and do nothing.

## A minimal worked example

A pack named `invoices` with one subagent and one shared helper family:

```
invoices-pack/
  agent/
    instructions/
      50-pack-invoices.md                      root delegation text
    subagents/
      invoice-extraction/
        agent.ts                               description = routing hint
        subagent.json                          name, summary, dataroomPaths
        instructions.md                        the contract: sources, precedence, output, skills table, scripts table
        instructions/00-mode.ts                copied verbatim from agent/subagents/research/
        instructions/operator-override.ts      copied, keyed "invoice-extraction"
        hooks/usage.ts                         copied, WORKFLOW = "invoice-extraction"
        schemas/invoice-spec.md                the operator's rulebook, verbatim, with "## Open points"
        schemas/README.md  scripts/README.md   one-line pointers to sandbox/workspace/
        tools/
          dataroom_list.ts  dataroom_read.ts  dataroom_fetch_to_sandbox.ts
          dataroom_append_jsonl.ts  get_customer.ts
        skills/
          table-split-across-pages/SKILL.md
          scanned-pdf/SKILL.md
          regional-number-format/SKILL.md
          credit-note/SKILL.md
          multi-currency/SKILL.md
          value-not-stated/SKILL.md
        sandbox/
          sandbox.ts                           installs pdfplumber + pypdf, fails loudly
          workspace/
            schemas/line_items.schema.json
            scripts/detect_pdf.py              --self-test
            scripts/sum_line_items.py          --self-test
            scripts/validate_line_items.py     --self-test; names line_items.jsonl
            scripts/doclib/                    written by sync:subagent-shared, committed, never edited
  scripts/
    subagent-shared/
      doclib/
        targets.json                           { "subagents": ["invoice-extraction"] }
        __init__.py  numbers.py  schema.py  pdfdoc.py  selftest.py
  docs/
    INVOICES_PACK.md
```

`agent/instructions/50-pack-invoices.md`:

```md
## Invoices

- **invoice-extraction** — tabulates supplier invoices that are already in the data room:
  - Use for "pull the line items from ...", "what did <supplier> bill us in March".
  - Works only from files under `Customers/{customer_id}/invoices/`. It does not fetch.
  - It sees only your message: name the customer, the period and the file paths.
```

After `cp -R invoices-pack/. .` and the apply commands, `git status --short` shows the
files above as added, plus:

```
 M agent/lib/subagent-registry.generated.ts      "invoice-extraction" in SUBAGENT_KEYS / LABELS / SUMMARIES,
                                                 "Customers/{customer_id}/invoices/**" in EXTRA_DATAROOM_PATH_TEMPLATES
 M app/_components/subagent-meta.generated.ts    its name, summary, description, six skill names, five tools
```

and the subagent appears, with no further edit, in the Workspace "Agents" tab, in
delegation cards and the Control Panel under its display name, in the workflow author's
list of subagents, and as a provisioned `workflows` row in every workspace created from
then on.
