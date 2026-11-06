# Records: the record contract of a mold_v0 app

A mold_v0 app keeps its data in **record areas**: lists of records a pack declares in its `pack.json` (`record_areas`),
with no code. This page is the whole contract of one area: what its fields can be, whose rows it holds, where they come
from, who may do what to them, how its list looks, and what else the shell does with them (clocks, chains, documents,
Settings). It describes what the mold does **today** (`molds/mold_v0/codebase`, as of mold_v0-238), names the file that
does each part, and lists at the end what it does not do yet.

The schema is the mold's own: `molds/mold_v0/codebase/packs/pack.schema.json` (generated from `src/pack-api.ts`), embedded
whole in the app spec's schema (`schemas/mold_v0.app.schema.json`, `app_spec.py generate`), so an editor checks an inline
pack's areas as you type. `factory.py spec check` adds the completeness rules below.

## 1. An area

```json
{ "name": "work_orders", "label": "Work orders", "role": "check", "scope": "workspace", "fields": [ ... ] }
```

| Key | What it says |
|---|---|
| `name` | Unique in the build: the area's address (`/app/records/<name>`, `/api/data/<name>`) and the MCP tools' last word. `areas` is reserved. |
| `label`, `description`, `rows`, `version` | People's words. `rows` (what one row is and how it is keyed) and `version` (where a shared row's version comes from) are read by no code. |
| `icon` | Its icon wherever it shows (mold_v0-242): one of the console's tab icons (`src/pack-api.ts` `TAB_ICONS`). Section 5 says what an area without one gets. |
| `role` | `source`, `check` or `asset`: what a run's results may name (src/runs.ts). An `asset` area is always sealed and always workspace scope. |
| `scope` | `workspace` (each workspace's own rows, `workspace_records` under row-level security) or `platform`: **shared** by every workspace (`platform_records`; the tenant role may only read it). |
| `fields` | 1 to 60 (section 2). |
| `list_columns` | Up to 8 fields the list shows (default: the first four). |
| `links` | `{field, area}`: a field whose value is another area's key (a `reference` field makes its own). |
| `lifecycle` | States (one single-choice enum field), the initial state and the moves between them, each with the roles that may (workspace areas). |
| `permissions` | `read`, `create`, `update`, `move`, `delete`: lists of roles (section 4). |
| `repository` | Where rows come from when not the shell's own tables (section 3). |
| `sealed` | Title and data encrypted at rest with the workspace's key (workspace areas). |
| `append_only`, `chain` | Section 6. |
| `due`, `clocks` | Section 6. |
| `settings` | Section 7. |
| `action`, `action_reason` | The primary action of the area's own lists, its Settings tab and its Records page: absent, the shell's default; `false` with `action_reason`, none (section 5). |
| `samples` | Up to 20 example rows of a shared area, written only by the test lanes' throwaway database. |
| `contract` | The area's contract in one place (section 8). |

## 2. Field types

Every field has a `name` (lowercase, 2 to 63 characters), a `label`, a `type` (default `text`), and optionally `help` and
`required` (a write that leaves it empty is refused). Checked on every write by the record store (`src/record-areas.ts`).

| Type | Holds | Options |
|---|---|---|
| `text` | a string | `max_length` (1 to 20000) |
| `number` | a finite number | `min`, `max` |
| `date` | a date | |
| `boolean` | true or false | |
| `json` | any JSON value | |
| `enum` | one of `options` (values, or `{value, label}`) | `multiple`: a list of them |
| `person` | a person of the workspace, by sign-in id | `multiple` |
| `reference` | the key of a record of area `to`, checked on write as the writer sees it | `multiple`; a shared area refers only to shared areas |
| `link` | the older form of a reference (a key or list of keys, through the area's `links`) | |
| `file` | a file: a path in the workspace store, or a **stored file** `{object, name, size, content_type, sha256}` kept sealed for the record (mold_v0-220, `src/record-files.ts`); the console's create form uploads them (section 6) | `multiple`: **files** |
| `url` | an absolute `http` or `https` address of up to 2048 characters, with a host and no user name or password (mold_v0-238, `src/pack-api.ts` `isFieldUrl`); the console takes it in an address input and shows it as a link | `preview: "document"` |

Four markers on top of the type:

- **URL with a document preview**: a `url` field (or a `text` field holding a URL, the form before mold_v0-238) with
  `"preview": "document"`; the record's card fetches the document (only from the pack's `documents.hosts`, over HTTPS,
  private addresses refused), keeps a copy in the object store and previews it (PDF, images, plain text, sanitised
  HTML), with Download (`src/document-fetch.ts`). A `url` field is checked as an address on every write; a `text` one
  is not.
- **Encrypted**: `"encrypted": true` seals the value with the workspace's data key; every read shows `[encrypted]`, and
  only an explicit reveal returns it, to the field's `reveal_roles` (default: the roles that may update the area), each
  reveal in the data trail (mold_v0-194, `src/encrypted-fields.ts`). Workspace areas of the shell's tables; text,
  number, date, boolean, json or a single enum; never a field the lifecycle, a due date, a link or a clock uses.
- **Searchable**: `"searchable": "equality"` on an encrypted field keeps a keyed blind index beside it, so a filter
  `{field: value}` finds it. No other operator and no sort.
- **Copyable** (mold_v0-253): `"copyable": true` puts a copy button beside the value on the record's laid-out page
  (section 6, "The record's page"), in its sections and facts. Never on an encrypted, `file` or `json` field.

## 3. Scope and provenance

**Scope** says whose rows they are: a workspace's own, or shared by every workspace (written by platform staff, read
only to workspaces). **Provenance** says how rows get there. Five sources:

| Provenance | Who writes | Where it applies | How the shell does it |
|---|---|---|---|
| `staff` | platform staff, by hand | a shared area (a workspace area only through a write tool the pack made `admin_only`) | the staff record pages' New, Edit, Override and Import, `/api/admin/data`, the admin MCP (mold_v0-212, mold_v0-221) |
| `people` | the workspace's own people and their AI clients, by hand | a workspace area whose writes the pack does not withhold | the create form of its list tab, Settings tab or Records page (with its files uploaded), the data API (`/api/data`), the generated create, update and move tools |
| `repository` | the area's `repository` | any area naming one | `workspace_files` (rows indexed from the workspace's files, read only), `http_api` (read live, read only), `upstream_catalog` (a pinned upstream catalog that staff index), `shell_tables` (`src/data-repositories.ts`) |
| `intake` | the company email's intake | the area the pack's `email.intake.area` names | one record per message, with its body and attachments as files (mold_v0-192, mold_v0-220) |
| `run` | the pack's own code | a workspace area of the shell's tables, in a pack with code (`entry`) | `ctx.records`: a run's `onWorkspaceCommit` hook (mold_v0-064), the pack's own tools and routes |

The runtime keeps a **shared** row's provenance: `staff` (written by hand, no `source`) or `repository`, with a staff
override standing over a repository's row until removed (`platform_records.source`, `upstream`; `src/record-areas.ts`
`platformProvenance`; the staff pages mark each row).

It keeps a **workspace** row's too (mold_v0-236, `sql/migrations/0042_workspace_record_provenance.sql`,
`src/record-areas.ts` `RecordWriter`): every write through the record store names its writer, and the row keeps

| Column | Holds |
|---|---|
| `provenance` | where the row came from: the kind of its first writer, one of the five above. A repository's index taking a row over makes it `repository`; a later write by anyone else keeps it. Empty for rows written before 0042 (what wrote them is not known) |
| `written_by` | `<kind>:<who>` of that first writer: a person's sign-in id (`people`; `people:key` for an account key, `people:inbound:<id>` for an inbound source), a staff pseudonym (`staff`), the intake's message (`intake:message:<id>`), a run (`run:run:<id>`), the pack's tool or route (`run:tool:<name>`, `run:route:...`), the repository's name |
| `updated_by` | `<kind>:<who>` of the latest write, a move included (`shell:clock` for a clock's escalation step) |

Which door is which: the data API, the console's forms and import, and the generated create, update and move tools are
`people` (`src/data-api.ts`); an `admin_only` tool staff call for a workspace is `staff` (`src/mcp-tools.ts`); the
email intake is `intake` (`src/email-intake.ts`); a run's commit hook and the pack's own tools and routes are `run`
(`src/runs.ts`, `src/packs.ts` `runPackTool`, `src/pack-routes.ts`); a repository's index is `repository`. A record's
page shows **Added by**, and its detail (`GET /api/data/<area>/<key>`, `/api/records/<area>/<key>`) carries
`provenance: {by, written_by, updated_by}`. Never a value of the record.

So `run` is **worked out**, not only declared: `GET /api/admin/records/_provenance` (staff, `read`) gives, for every
workspace area, how many rows each provenance wrote across the workspaces (counts only: no key, value or workspace) and
the provenances its rows show that its declared contract leaves out (`undeclared`).

## 4. Actions and who may do them

Eight actions. The roles are the account roles `viewer`, `member`, `billing`, `owner`; a write never includes `viewer`
(read only in the platform). Staff permissions are the platform roles' (`src/admin-roles.ts`: Operator and Owner hold
`library`, Owner `delete`).

| Action | Workspace area | Shared area | Enforced in |
|---|---|---|---|
| `read` | `permissions.read`, default every role | the same (every workspace reads it) | `src/record-areas.ts` `allowedRoles`, every door |
| `create` | `permissions.create`, default member, billing, owner | staff with `library` | the record store; a shared area's tenant grants |
| `update` | `permissions.update`, same default | staff with `library` (on a repository's row: an override) | the record store |
| `move` | `permissions.move`, same default, and each transition's `roles`; only with a lifecycle | none | the record store |
| `delete` | `permissions.delete`, default as update, or the owner alone on an area with a lifecycle | staff with `delete` (a staff row, or an override, which puts the repository's row back) | the record store |
| `reveal` | the area's (mold_v0-235): the contract's `reveal` roles, each encrypted field's `reveal_roles` narrowing them; without a contract, each field's `reveal_roles`, default the update roles. A contract's `{none}` reveals nothing to anyone (an account key included) | none (no workspace key) | `src/record-areas.ts` `revealRoles`, the `reveal` routes and tool |
| `export` | its own permission (mold_v0-235): the contract's `export` roles that may read; without a contract, as `read`. `{none}`: nobody | the same | `src/record-areas.ts` `exportRoles`: the list routes with `?audit=export` (the console's **Export CSV**, shown only to those roles), the `export_<area>` tool (offered only to them) and `src/record-export.ts` |
| `import` | the contract's `import` roles that may both create and update (mold_v0-234); without a contract (or `{none}`), nobody. **Import** beside the list's Export reads a CSV or JSON file, previews each row and writes the valid ones as the person's records in one transaction (`src/record-import.ts` `importWorkspaceRecords`) | staff with `library`: **Import** reads a CSV or JSON file, previews each row and writes the valid ones as staff rows (mold_v0-221, `src/record-import.ts`) | `POST /api/data/<area>/_import` (a workspace), `POST /api/admin/records/_console/<area>/import` (staff) |

What turns an action off:

- An area read from the workspace's files or an API (`workspace_files`, `http_api`) takes no write through any door.
- `append_only`: update, move and delete are refused (section 6).
- A workspace's import: an area read only, with an encrypted field (its values never come from a file), or whose
  create or update the pack withholds; a lifecycle's state never comes from a file (a new record starts in the initial
  state, an existing one keeps its own; a row naming another state is invalid); an append-only area's existing keys.
  Each row is still checked for the person's create or update permission, its fields and its references.
- The pack's `mcp` settings: a generated tool it `exclude`s (or leaves out of `include`) or marks `admin_only` is withheld,
  and with it the same operation's routes (`src/mcp-withheld.ts`): `create_<area>` withholds `POST /api/data/<area>`;
  a workspace area's delete is withheld when every write of it is; `list_` and `export_` withhold the console's Export
  CSV; `admin_create_`/`admin_update_`/`admin_delete_` withhold the staff routes.

## 5. Lists

Where an area's list is drawn, and what it has:

- **A tab** (`tabs`, kind `area`: `area`, or `areas` to merge several by key): `views` (`table`, `board` by the
  lifecycle's field or `board_by`, `timeline` by a date or `timeline_by`, `detail`), `columns` (default the area's
  `list_columns`), `filter` (a server-side narrowing), `charts` above it, `empty` (the empty state's text and call to
  action), and **four sparkline cards** below the toolbar: `sparklines` names exactly four of the pack's metrics, or the
  shell gives its four for the kind (mold_v0-181, `src/sparklines.ts`).
- **The primary action** (mold_v0-208, mold_v0-213): one button at the right end of the search row. A tab's `action`
  (`create_record` of its area, `start_run` of a job kind or a picker of several, `link`), else the shell's default
  (`src/metric-spec.ts` `tabAction`: `create_record` for a workspace area of the shell's tables a workspace may add to),
  else none. **No action is said with its reason**: `"action": false, "reason": "..."` (shown nowhere; the build lists
  an undeclared none as a warning). Its form opens as a full card in the list's place (`?new=1`, `?start=1`), never a
  dialog or a side sheet.
- **Export CSV** sits just left of it on every list (mold_v0-217), the narrowed rows when filtered; on a workspace's
  list only for the roles that may export (mold_v0-235). **Import** sits beside it, its own button, where the area's
  contract grants the person's role import (mold_v0-234): a full card in the list's place (`?import=1`, Back to the
  list) to choose the file, map its columns, preview each row and import; then what was written.
- **A Settings tab** (section 7) and **the Records page** (`/app/records/<name>`) are the same list (mold_v0-237): the
  area's four cards (`GET /api/records/_console/<area>/sparklines`, the defaults an area tab over it would have), the
  search row with Export CSV and the area's own primary action, then the table. Its action is the area's: `"action":
  false` with `"action_reason": "..."` is none; else the shell's default (`src/metric-spec.ts` `areaListAction`: Add
  <its singular>, a new record, for a workspace area of the shell's tables a workspace may add to; the server's
  `GET /api/tab-actions/_areas/<area>` says who may use it), else none, said by what the area is (shared, read from a
  repository, its create withheld; the registry's `no_action`). A tab over the area keeps its own `action`.
- **Its icon** (mold_v0-242, `src/record-icons.ts`) is one and the same in every place the area shows: its entry in the
  staff console's Records group (a shared area), its entry in the customer console's Records group and its spec
  (`recordAreas` in `web/src/config/pack-nav.generated.ts`). The area's own `icon`; unset, the icon of the customer tab
  that shows it (the sidebar entry of the first tab over it: that tab, or the sections tab it is an in-page tab of), if
  that entry declares one no other area has taken; else one the build picks from the area's name out of a short list
  (`RECORD_FALLBACK_ICONS`), so that no two Records entries share an icon and none repeats another staff sidebar entry's.
  Shared areas choose before the workspace's own. Two areas that declare the same icon keep it, and the build warns
  (`gen-packs: warning: ... icon(s) declared by more than one record area`). The icon is not part of the contract.
- **Staff** see a shared area at `/admin/records/<name>`: the four cards, **New <noun>** and **Import** for a role with
  `library`, Edit or Override on a row, Remove for `delete`, each row's provenance (mold_v0-212, mold_v0-221).

## 6. Time, history and documents

- **Due dates** (`due`, mold_v0-035): a check area's date field; once a day a notice and an email for records due within
  `within_days`.
- **Clocks** (`clocks`, mold_v0-191, `src/record-clocks.ts`): up to five deadlines per workspace area, started by a date
  field, the record's creation or entering a state; lengths by an enum field; calendar or business time; stop and
  pause conditions; reminders before and escalation steps after (notify, reassign, raise). Gated by the
  `record_clocks` and `scheduled_alerts` flags.
- **Append-only and chain** (mold_v0-195): `append_only: true` makes the record store refuse every change and delete
  (409); `chain: true` makes the database refuse them too and hash-chains the area's records per workspace, signed in
  checkpoints when `audit.sign` is on. Workspace areas of the shell's tables only; no lifecycle, no repository.
- **Documents** (mold_v0-220): each `file` field's stored files and each `preview: "document"` URL become cards on the
  record (preview, Download, signed links bound to the person; previews and downloads in the data trail). Files come
  from the email intake, the pack's own code and the console (mold_v0-238): a create form's file field takes files from
  the person's device (Choose files; each file's name, size and progress, then Uploaded), uploaded when the form is
  sent to `POST /api/data/<area>/<key>/files/<field>` (the bytes as `application/octet-stream`), kept as the intake
  keeps them (sealed with the workspace's data key, bound to the record's key) and written into the field by the
  record's create. A person who may create or update the area's records uploads; a workspace area of the shell's tables
  only; 25 MB a file (4 MB where the API runs on Vercel's functions). A file kept but never written (a cancelled form, a
  refused create) is removed (`DELETE` on the same address, only for that key and never one the record holds). An
  upload is a `create` of target `file` in the data trail, a removal a `delete`. Gated by the `document_preview` flag
  (off: no upload, no card).

- **Credentials on the record's page** (mold_v0-239): an asset area's record page carries a Credentials card when a
  pack's credential is bound to that area: first the credentials of the record itself (`bound_to: asset`), then one
  group per environment the record has (`bound_to: environment`; the environments are the field's fixed
  `environments`, or read from the record by `environments_from: {field, key}`). Each is shown in the customer's
  words (`purpose`, `steps`, `without`), with its status (set, missing or optional), when it was set and when it was
  last used; Set, Replace and Clear open a full card in the page's place, the environment picked from the record's own.
  Settings › Credentials lists the workspace's own credentials, then one row per record that has credentials (its name,
  its status in words, when one last changed; it opens the record's page at its Credentials card). Fields that share a `group` (a key id and its
  secret) are one credential. None of this changes an area's contract: a credential is not a field of the record and is
  never read, exported or imported with it.

- **The record's page, laid out** (mold_v0-253, flag `record_pages`, off by default): an area's `detail` lays out its
  records' page. Absent, or with the flag off, the page is the one details card it always was (every field, then
  documents, deadlines, links and the Credentials card). With it:

  ```json
  "detail": {
    "header": {
      "title": "name", "subtitle": "summary",
      "badges": [{"field": "status", "colors": {"passed": "success", "failed": "danger", "running": "info"}}],
      "creator": true,
      "facts": [{"field": "project"}, {"field": "started"}, {"field": "duration", "unit": "s"}, {"field": "artifact"}]
    },
    "notices": [{"when": {"field": "status", "equals": "failed"}, "tone": "danger", "title": "This build failed", "text": "..."}],
    "tabs": [
      {"label": "Overview", "sections": [
        {"title": "Source", "columns": 3, "fields": ["project", "branch", "commit"]},
        {"title": "Results", "columns": 3, "groups": [{"title": "Tests", "fields": ["passed", "failed"]}, {"title": "Timing", "fields": ["started"]}]},
        {"title": "Approval", "fields": ["approver"], "empty": "No one has approved this build yet."}]},
      {"label": "Logs", "sections": [{"title": "Log excerpt", "columns": 1, "fields": ["log"]}]}],
    "unplaced": "show"
  }
  ```

  - **header**: `title` (a field shown as the title; default the record's title), `subtitle` (a summary line),
    `badges` (up to 3 single-choice enum fields; each value's colour a theme token, `neutral`, `info`, `success`,
    `warning`, `danger` or a chart colour `viz-1` to `viz-8`; a value left out is neutral), `creator` (false hides
    "Added by", the record's provenance), and up to **8 facts** (a field, an optional `label`, a number's `unit`), each
    formatted by its type: a date relative ("in 3 days") with the exact date on hover, a number grouped with its unit, a
    reference, link or address as a link, an enum as its badge. The header also carries **Copy ID** and **Copy link**
    and a line with the record's id, version and when it changed.
  - **notices**: banners above the tabs while their condition holds on the record: one test of one field, `equals`,
    `in`, `not_in` or `empty` (true or false); tone `info`, `warning` or `danger`; an optional `title` and the `text`.
  - **tabs**: each a `label` (its address `?tab=<label in lowercase, words joined by ->`; one tab draws no strip) and at
    least one section. A **section** is a full-width card: its `title`, its `fields` (one group) or `groups` (several,
    each with an optional `title`), laid out in `columns` 1, 2 (the default) or 3 on a desktop and one on a phone, and
    its own `empty` words, shown when every field of it is empty on the record (default "Nothing here yet.").
  - **unplaced**: the fields no part of the layout names are an "Other details" section at the end of the first tab
    (`show`, the default; only those with a value) or left out (`hide`). The first tab also ends with the record's
    documents, deadlines, linked records and Credentials card, as the page without a layout shows them.

  The build refuses a layout that names a field the area lacks, more than 8 facts, a tab without sections, a section
  without fields, a badge on anything but a single-choice enum field or with a colour outside the token set, an
  option value the field does not have (a badge's colours, a notice's test), a unit on a field that is not a number,
  a fact, title or badge on an encrypted or file field, and two tabs with one address (`src/pack-api.ts`
  `RecordDetailSchema`, `detailProblems`).

## 7. Settings placement

`"settings": {"group": "access" | "connections" | "automation" | "data_trust", "label": "..."}` (mold_v0-219) shows a
workspace area as a tab of the customer console's Settings, in that group, instead of in Records; never also a sidebar
tab. Settings groups its tabs as described in `molds/mold_v0/MOLD.md` "Features registry".

## 8. The contract block and the completeness rules

Every area has a contract. A pack may write it down, in one block, so the area's promise is read in one place:

```json
"contract": {
  "provenance": ["people", "intake"],
  "actions": {
    "read": ["viewer", "member", "billing", "owner"], "export": ["viewer", "member", "billing", "owner"],
    "create": ["member", "owner"], "update": ["member", "owner"], "move": ["member", "owner"], "delete": ["owner"],
    "reveal": { "none": "No encrypted field" },
    "import": { "none": "Work orders arrive one by one, by email (the intake) or New work order, never from a file" }
  },
  "primary_action": "create_record"
}
```

- `provenance`: one or more of `staff`, `people`, `repository`, `intake`, `run`.
- `actions`: every one of the eight, each a list of roles, `{"staff": "library" | "delete"}` (a shared area), or
  `{"none": "<why>"}`.
- `primary_action`: `create_record`, `start_run` or `link`, or `{"none": "<why>"}`: the primary action of **every**
  list that shows the area (mold_v0-237): each tab whose own area it is, its Settings tab, and its Records page when no
  tab shows it.

**The runtime reads three of its actions** (each with today's behaviour when the area declares no contract):
`import` (who may import a file into a workspace's own records: mold_v0-234), `export` (its own permission, within
read's: mold_v0-235) and `reveal` (the area's, a field's `reveal_roles` narrowing it: mold_v0-235). The rest is a
declaration, held to what the shell does with the rest of the area:

- **The build** (`src/pack-api.ts` `contractProblems`) refuses what the area alone shows to be untrue: provenance
  `repository` without a repository (or a repository it leaves out), people, intake or run on a shared area, a viewer
  that writes, a workspace role writing a shared area, `{staff}` on a workspace area, move without a lifecycle, reveal
  without an encrypted field, update, move or delete on an append-only area; export naming a role read leaves out; a
  field's `reveal_roles` naming a role the area's reveal leaves out, or any when it is `{none}`; a workspace import on an
  area with an encrypted field, or naming a role its create or update leaves out (or with either `{none}`).
- **`factory.py spec check`** (`.claude/scripts/lib/records.py`) derives every area's contract from its declaration, its
  pack's `mcp` settings, tabs and email intake (section 4's rules, the shell's defaults) and holds a declared one to it:
  each action must be what the build gives (roles compared as sets; `none` matches `none` whatever the reason; for
  import, export and reveal, what the runtime makes of the contract's own grant: the roles narrowed by read, create and
  update, `none` where the area cannot take it); the provenance must include everything the build gives and nothing it
  cannot (`run` only in a pack with code); the primary action must be the one every list of the area resolves to (each
  tab over it, its Settings tab, its Records page), each that differs named.

**Completeness rules** (`spec check`, on every mold_v0 pack, inline, by path or by id):

1. A declared contract says every action (with its roles or its reason), its provenance and its primary action, and
   each is what the build does.
2. An area that declares none takes the derived contract, which is complete unless the derivation cannot decide:
   - **nothing writes its rows** (no repository, no write a workspace or staff may make, no email intake): declare
     `contract.provenance` (`run`, when the pack's code writes them), or open a way in;
   - **a list tab of it has no primary action and no reason** (a shared area, a repository's area, an area a workspace
     may not add to, with no `action` on the tab): declare the tab's `action`, or `action: false` with its `reason`, or
     the contract's `primary_action: {"none": "<why>"}`. Its Settings tab and its Records page always have one or say
     why (the area's `action: false` and `action_reason`, or what the area is).

So every area of a complete spec has its actions or their reasons, its permissions and its provenance: said by the
pack, or derived and printed. `spec check <file> --records` prints each area's contract on one line (declared or
derived) with its list, clocks, chain, documents and Settings placement; `--json` carries them as `records`.

## 9. Worked example

[`examples/mold_v0/field-service`](../examples/mold_v0/field-service/) (Wrenchline) declares every area's contract.
Its work orders:

- **Fields**: a site and equipment (`reference`), priority, source and state (`enum`), technician and supervisor
  (`person`), the requester's email (`text`), reported on (`date`), description (`text`), attachments (`json`).
- **Scope** workspace, **role** check: each service team's own work orders.
- **Provenance** `people` (New work order on its tab, the data API, the create tool) and `intake` (the pack's
  `email.intake.area` is `work_orders`: each email to the connected mailbox becomes one).
- **Permissions**: everyone reads and exports; members and owners create, change and move them along the seven-state
  lifecycle (`permissions` names member and owner); only an owner deletes one (the default on an area with a
  lifecycle); nothing to reveal (no encrypted field); no import (work orders arrive one by one). Its sites and
  equipment do take an import (members, billing managers and owners load them from a spreadsheet).
- **List**: tab `work-orders` (table and detail views, its four default cards), primary action `create_record`
  labelled New work order, Export CSV beside it.
- **Clocks**: respond by and fix by, their lengths chosen by priority, the fix-by clock pausing while awaiting parts.

```
$ python3 .claude/scripts/factory.py spec check examples/mold_v0/field-service/spec.json --records
examples/mold_v0/field-service/spec.json: complete for mold_v0
  flags: vault, email, alerts, clocks, audit.data, health, documents
  records: 4 area(s), 4 with a declared contract
    wrenchline.sites (workspace, declared): from people; primary create_record at tab sites; read viewer, member, billing, owner; ...; import member, billing, owner
    wrenchline.work_orders (workspace, declared): from people, intake; primary create_record at tab work-orders; read viewer, member, billing, owner; create member, owner; update member, owner; move member, owner; delete owner; reveal none; export viewer, member, billing, owner; import none; clocks respond, resolve
    ...
```

Change the contract's `delete` to `["member", "owner"]` and the check says
`contract.actions.delete says member, owner but the build gives owner`; drop `intake` from its provenance and it says
`contract.provenance leaves out intake, which the build gives it (people, intake)`. The other examples declare the
contract of the area that shows something new: Panelwise's candidates (`examples/mold_v0/hiring-pipeline`: read without
viewers, export for owners alone, reveal for members and owners, its phone and salary fields for owners) and Flagwell's
rollouts (`examples/mold_v0/feature-flags`:
append-only and chained, so update, move and delete are none). Their other areas take the derived contract.

## 10. Not built yet (follow-ups)

What the contract can name only as `none`, or cannot name, because the runtime does not do it:

- **Import through MCP.** A workspace imports through the data API and the console; there is no `import_<area>` tool
  (an AI client writes several records with the data API's batch).
- **Import of encrypted fields, and into an append-only area.** A file never carries an encrypted value, and an import
  needs both create and update, so neither takes one.
- **`run` in `spec check`.** The factory's check reads the declaration, not the app's rows: it knows only that a pack
  has code. The app works it out (`GET /api/admin/records/_provenance`), for rows written since mold_v0-236.
- **The build checking the whole contract.** `gen-packs` runs the area-local rules (`contractProblems`); the derived
  comparison (permissions' defaults, `mcp`, tabs, intake) runs in `factory.py spec check` only, so a pack applied
  without a spec check is held to the first alone.
- **A different primary action per list.** The contract's `primary_action` is one value for every list of the area; an
  area whose tabs offer different actions cannot declare a contract until they agree (its derived contract prints
  each). An area's own lists (Settings, Records page) offer `create_record` or none, never a run or a link.
- **The rest of the record's page** (mold_v0-253 is part 1): related lists, a record's runs and a run's own page, logs,
  history, code views and page actions are later parts; until then a layout's sections show the record's own fields.
- **Updating a record's files from the console.** The console creates records with their files; changing a record's
  files afterwards is the data API's (`PUT /api/data/<area>/<key>` with a reference an upload answered), not a form's,
  and the MCP tools take a workspace store path, not an upload.
