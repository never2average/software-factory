# Deployment profile

The product was written for one use: a delivery team looking after customers. A **deployment profile** is how a deployment that is for something else
(an equity-research desk, a claims team, a support desk) says so **without forking the
code or editing a component**.

A profile changes what a person or the model **reads**: the product's name, what a
"customer" and a "member" are called, which data-room domains are shown and under what
label, what the two delivery record areas (deployments, implementations) mean and how their
fields read, the files a new workspace starts with, the chat's opening lines, and a short
briefing the model receives on every turn. It changes nothing a program keys on.

```
profiles/00-default.json            the defaults; reproduces the product exactly as it was before profiles
profiles/NN-<name>.json             a deployment's overrides (added, never edited in)
        |
        |  npm run build:deployment-profile      (scripts/gen-deployment-profile.mjs; part of build:generated / prebuild)
        v
lib/deployment-profile.generated.ts         web:   DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText()
agent/lib/deployment-profile.generated.ts   agent: the same file, byte for byte
```

Both generated files are **outputs**: nobody edits them, `npm run check:generated` fails
when they are stale, and with only `00-default.json` present they are what is committed.

## Using it in code

```ts
import { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } from "@/lib/deployment-profile.generated";

<h1>{PRODUCT_NAME}</h1>
<p>Search {DEPLOYMENT_PROFILE.vocabulary.account.plural}…</p>
fillProfileText("{name} has been quiet for {days} days.", { name, days });   // {product} is always available
```

`fillProfileText(text, slots)` fills `{slot}` markers. `{product}` is always the product
name; a slot nobody supplied is left as written (so `{customer_id}` inside a seeded README
survives as literal text).

The rule for new UI copy: if a sentence names the product, a customer, a member, a deployment, an
implementation, a rollout or a data-room domain, it reads the profile. It never hardcodes the word.
`lib/ui-words.ts` has every one of them ready (`W.account`, `W.Accounts`, `W.owner`, `W.Deployment`,
`W.implementations`, `W.install` for "this deployment", `an(word)`, `domainLabel("accounts")`), and
`lib/ui-keys.ts` shows a stored key in the profile's words (`speakKey`, `humanizeKey`). See
[How a person sees it](#how-a-person-sees-it); `npm run check:ui-vocabulary` enforces it.

## Keys

Every key, what it means, and its default. Strings marked *slots* are passed through
`fillProfileText`.

### `product`

| Key | Meaning | Default |
|---|---|---|
| `product.name` | The display name, everywhere a person sees it: browser title and title template, application name, the sign-in wordmark and copyright line, the onboarding wizard, the invitation and sign-in-code emails (subject, body, the prompt a coding agent is given), the ops-auth "work accounts only" sentence, the roster workbook's author field, the inbox hand-off prompt, and `{product}` in any profile string. Exported as `PRODUCT_NAME`. | `"Delivered"` |
| `product.tagline` | The line under the wordmark on the sign-in screen. *slots: `{product}`* | `"The operations console for teams that run customer work."` |
| `product.description` | The page's meta description. *slots: `{product}`* | `"{product} — an operations console: an eve-powered agent that runs account onboarding, deliveries, and the data room for your team."` |

### `vocabulary`

| Key | Meaning | Default |
|---|---|---|
| `vocabulary.account.singular` / `.plural` | What the thing every record hangs off is called in prose ("the account's data room", "Search accounts…"). Lower-case; the UI capitalises where it needs to. Base text never spells it: it writes `{account}` / `{accounts}` (see "Record placeholders" below). The identifiers keep the stored word (`customer_id`, `list_customers`). | `"account"` / `"accounts"` |
| `vocabulary.member.singular` / `.plural` | What a person who works in the console is called. Base text never spells it: it writes `{member}` / `{members}` (see "Role placeholders" below). | `"member"` / `"members"` |
| `vocabulary.owner` | The label for the member responsible for an account. Base text writes `{owner}`. | `"Account owner"` |
| `vocabulary.secondary_owner` | The label for an account's second owner: what a person reads for the `aeOwner` / `secondaryOwner` field (`ae_owner` / `secondary_owner` in the database) in an export or a table header. A deployment names its own role here ("Account executive", "Relationship manager"). | `"Secondary owner"` |
| `vocabulary.account_context` | The name of the per-chat "which accounts is this about" control. | `"Account context"` |

### `chat`

| Key | Meaning | Default |
|---|---|---|
| `chat.hero_lines` | The rotating lines on an empty chat. A non-empty list of non-empty strings. *slots: `{product}`* | `["{product}", "What needs doing today?", "Prep the stand-up", "Chase the follow-ups", "Keep every account close"]` |
| `chat.empty_sections.urgent` / `.stalled` | Headings of the two suggestion groups on an empty chat. | `"Urgent tickets"` / `"Stalled accounts"` |
| `chat.user_messages.collapse` | Whether a long message a person sent starts folded, with a "Show more" button. Short messages are never touched and assistant replies never fold. `true` or `false`. | `true` |
| `chat.user_messages.collapsed_lines` | How many lines of a folded message stay visible. A whole number from 2 to 40. A desk that pastes filings and tables wants it small; one that writes three-line prompts can turn `collapse` off. | `6` |
| `chat.sandbox_wait.line` / `.next` | Off Vercel only: the chat's line while one of its commands waits for a free sandbox under the server's running cap (docs/self-hosting/SANDBOX.md), and the line when it is next in line. `line` must hold `{place}`. *slots: `{place}` ("2nd", "3rd", …)* | `"Waiting for a free sandbox ({place} in line)…"` / `"Waiting for a free sandbox (next in line)…"` |
| `chat.specialist_sweep.frozen` / `.undelivered` / `.stopped` / `.failed` / `.waiting` | The chat's notes of what the specialist sweep did (docs/SPECIALIST_HANDBACK.md "The specialist sweep"): a frozen specialist stopped, a lost result handed back, one that stopped or failed without reporting, one waiting on the person for hours. Every one must hold `{name}`; `frozen` must hold `{minutes}`, `waiting` must hold `{waited}`. *slots: `{name}` (the specialist), `{minutes}`, `{waited}` ("5 hours")* | `"{name} showed no progress for {minutes} minutes, so it was stopped. The main agent has been told."` … `"{name} has been waiting for your answer for {waited}."` |
| `chat.starter_cards.owner_label` | Label for the owner on a starter card. | `"Account owner"` |
| `chat.starter_cards.ticket_waiting` / `.tickets_waiting` | Card summary for one / several open tickets. *slots: `{count}`, `{name}`* | `"One open ticket is waiting on us."` / `"{count} open tickets are waiting on us."` |
| `chat.starter_cards.ticket_badge` / `.tickets_badge` | The card's badge for one / several open tickets. *slots: `{count}`* | `"1 open"` / `"{count} open"` |
| `chat.starter_cards.triage_title` / `.triage_prompt` | The action's title, and the prompt sent when it is clicked. *slots: `{name}`, `{count}`* | `"Triage the open tickets"` / `"Triage the open tickets for {name}: what is blocking each one, who owns it, and what should we do next?"` |
| `chat.starter_cards.quiet_summary` / `.quiet_summary_long` | Card summary for an account with no recent contact (long: over a month). *slots: `{name}`, `{days}`* | `"No contact logged in {days} days."` / `"No contact logged for over a month."` |
| `chat.starter_cards.quiet_badge` | That card's badge. *slots: `{days}`* | `"{days}d quiet"` |
| `chat.starter_cards.quiet_title` / `.quiet_prompt` | The action's title and prompt. *slots: `{name}`, `{days}`* | `"Draft a check-in"` / `"{name} has been quiet for {days} days. Summarise where we left off and draft a check-in to their main contact."` |
| `chat.account_search.title` / `.description` / `.placeholder` / `.empty` | The account picker dialog: its title, its one-line explanation, the search box's placeholder, and the no-results line. | `"Account context"` / `"Pick the accounts this conversation is about — the agent grounds itself in their record."` / `"Search accounts…"` / `"No accounts found."` |
| `chat.account_search.pill_empty` / `.pill_active` / `.pill_locked` | The tooltip on the context pill with nothing chosen, with a choice, and once the chat has locked it. *slots: `{context}` (= `vocabulary.account_context`), `{names}`* | `"Set the customer context for this chat"` / `"{context}: {names} — click to change"` / `"{context} is locked for this chat: {names}"` |

### `dataroom`

| Key | Meaning | Default |
|---|---|---|
| `dataroom.root_label` | The data-room browser's title (dialog title and title bar) and the tree root's name. | `"Data Room"` |
| `dataroom.domains.<id>.folder` | The name the domain's files are **stored** under: the first segment of every path in it, the name of its `Master.xlsx`'s main sheet, and the domain's value wherever one is stored or sent (a sync's `domain`, a ticket's `affectedSchema`). One path segment: letters, digits, `.`, `_`, `-`. See "Stored folder names" below before changing it on a deployment that has files. | `Accounts`, `Platform`, `Deliveries`, `Solutions`, `Projects`, `Tickets`, `People` |
| `dataroom.domains.<id>.label` | What people read for that domain: its tab, its folder in the tree, the breadcrumb on a search hit, and "`<label>` Master" as the display name of its `Master.xlsx`. | the domain's `folder` |
| `dataroom.domains.<id>.visible` | `false` removes the domain from the browser: no tab, no tree node, no "jump to" affordance; live files under it are not listed; a request to open a hidden domain's tab opens the first visible one instead. | `true` |
| `dataroom.domains.<id>.description` | Optional. The folder's tooltip in the tree. | none |
| `dataroom.uploads_folder` | The folder files a person attaches in chat are stored under (`<uploads_folder>/{person_id}/…`). | `"Uploads"` |
| `dataroom.seed` | `null`: a new workspace is seeded with the built-in three-file starter tree (`README.md` and a `README.md` in the accounts and the people folders; `lib/org-seed.ts`). A list of `{ "path", "content" }`: THOSE files are written instead, all of them, replacing the built-in tree. *slots in `content`: `{workspace}` (the workspace's name), `{org_id}`, `{product}`*. A path is relative, has no `..`, and is `README.md` or starts with one of THIS profile's folders (a domain's `folder`, or `uploads_folder`). The content type follows the extension (`.md`, `.json`, `.jsonl`, `.csv`, otherwise plain text). | `null` |

`<id>` is one of `accounts`, `platform`, `deliveries`, `solutions`, `projects`, `tickets`, `people`: what code
and profiles call a domain. It is not a folder name and never changes.

#### Stored folder names

A domain has three things: its **id** (above), the **folder** its files are stored under, and the **label** people
and the model read. The folder is a setting of the deployment, not of the code: base code builds every path from
`FOLDER.<id>` (`agent/lib/dataroom-folders.ts`) and base text writes `{folder:<id>}`, so no folder name is written
anywhere but in a profile (`npm run check:neutral-names` holds that).

**A new deployment** takes the default profile's folders and needs to say nothing.

**A deployment that already holds files keeps every one of them where it is by PINNING the names it has.** The
folder names used to be part of the code (`scripts/lib/legacy-dataroom-folders.json` is the one place they are still
spelled), so every data room filled before stores its files under those. Such a deployment adds one file to its
profile, and nothing is moved, no row is rewritten, and every path in an old conversation still resolves:

```json
{
  "dataroom": {
    "domains": {
      "accounts": { "folder": "Customers" },
      "platform": { "folder": "Platform" },
      "deliveries": { "folder": "Deployments" },
      "solutions": { "folder": "Solutions" },
      "projects": { "folder": "Implementation" },
      "tickets": { "folder": "Tickets" },
      "people": { "folder": "People" }
    },
    "uploads_folder": "Uploads"
  }
}
```

(`scripts/fixtures/dataroom-folders/50-legacy-folders.json` is this file. `npm run test:dataroom-folders` builds a
copy of the checkout with it and holds every stored path, every object key every door asks the store for, the
starter tree and both seeders' trees to what they were before the names became a setting, byte for byte;
`npm run check:agent-vocabulary` does the same for everything the model reads.) With the pin and no `label`, a
domain reads under its folder's own name, exactly as before. With a `label`, people and the model read the label,
and the folder is still where the files are.

A profile written when the folders had those names calls each domain by its former name
(`"Customers": { "label": "Companies" }`). That still works: the key is read as the domain's id. Such a profile is
**refused at build** until it says where its files are, because without that the build would store the domain under
the default folder, leave the existing files behind and start a second set beside them. The message names the line
to add.

**The safety net.** A deployment whose data room holds a former folder that its profile stores nothing under is
never allowed to write into a second set of folders:

- at build, `npm run check:dataroom-folders` (run by `prebuild` and `prebuild:eve`) looks at the store the build
  is configured for (Vercel Blob with `BLOB_READ_WRITE_TOKEN`, else a local `.dataroom/`), and stops the build
  with the workspaces, the folders it found and the lines to add. A stopped build leaves the running deployment
  serving. With nothing to look at (CI, a fork, a first build) it says so and passes; a profile that pins every
  former name is not looked at at all. `DATAROOM_FOLDERS_CHECK=skip` turns it off for a build that cannot reach
  its store;
- at run time, the first write to a workspace looks once for such a folder (`agent/lib/dataroom-folder-guard.ts`,
  in the agent's store and the web app's writer) and, if there is one, writes nothing and says what to add.

It refuses rather than falling back to the names it finds, on purpose: the folder names are fixed into a build (its
path grammar, its prompts, its seeded files, the paths it shows), so a store that answered to whichever names it
found would make them a per-workspace fact, two workspaces of one deployment could disagree, and the missing line
would never be noticed. Nothing in this is a migration: no file is renamed in either direction.


### `domains`

The two software-delivery record areas, **deployments** and **implementations**, can be *redefined* instead of
hidden: given another name, other field labels, other words for their enum values, and a list of fields that are
not used. The rows, columns, API routes, tool names and enum **values** stay exactly as they are; a form still
submits `releaseStatus: "deployed"`, whatever the person read. (Hiding an area is still
`dataroom.domains.<Domain>.visible: false`; a redefined area is normally made visible and given the same label there.)

`<area>` is `deployments` or `implementations`.

| Key | Meaning | Default |
|---|---|---|
| `domains.<area>.label.singular` / `.plural` | What one record and the area are called: the TODOs tab, "New …", "Loading …", "Delete …", the Control Panel's panel and its "owns 3 …" sentence, a task's container type, the sheet's tab in the data room. | `"Delivery"` / `"Deliveries"`; `"Project"` / `"Projects"` |
| `domains.<area>.description` | One sentence: what a record IS here. The tab's blurb, and what the model is told the area means. | `"Deliveries, filtered by owner."` / `"Plans, filtered by owner."` |
| `domains.<area>.id_label` | The label of the record's id (`deploymentId`, `rolloutId`). | `"Delivery id"` / `"Plan id"` |
| `domains.<area>.fields.<fieldKey>` | One entry per field you want to say something about; see below. `<fieldKey>` is a real field: a key of `deploymentSchema` / `implementationSchema` (`agent/lib/customer-schema.ts`) or a column of the table (`agent/lib/db/schema.ts`). | today's labels for the fields the UI shows |
| `domains.<area>.kind_field` + `.kinds` | A free-text column that carries one of `kinds` (a report type, a release type). Shown as a select of exactly those strings; the string itself is what is stored. An enum column cannot be used: its values are fixed by the schema. | `null` / `[]` |
| `domains.<area>.create_fields` / `.detail_fields` | Extra real columns on the "New …" form / the detail card, after the built-in ones. Typed from the schema: an enum is a select, a percentage or number a number input, anything else text. List-valued columns cannot be put on a form. | `[]` / `[]` |
| `domains.<area>.custom_fields` | The deployment's OWN fields on the area: fields the base never had. See [Custom fields](#custom-fields). | `[]` |
| `domains.implementations.group_by` | A free-text column whose value groups the rows (in practice `rolloutId`). The tab is then titled with `group_label.plural`, the list gets a header per group (name, owner, how many, average progress), "New" picks an existing group or names a new one (stored as a slug: "Affordable housing" is `affordable-housing`), and the row's id becomes the customer id because many rows now share a `rolloutId`. | `null` |
| `domains.implementations.group_label.singular` / `.plural` | What a group is called. | `"Plan"` / `"Plans"` |

A field entry takes:

| Key | Meaning |
|---|---|
| `label` | What people read for the field, everywhere. |
| `short_label` | For a table column, a sort option or a chip, where `label` is too long. Falls back to `label`. |
| `placeholder`, `help` | The input's placeholder; a line of help under it. |
| `options` | `{ "<enum value>": "<display label>" }`. The selects, the board's columns and every badge show the label; the value is what is submitted and stored. Two values cannot share a label (the label must map back to one value). A value you leave out keeps its default label, or shows as itself. |
| `hidden` | `true`: not used in this deployment. No form field, no column, no detail row, the model is told not to ask about it, and (without a `fixed` value) it is not a parameter of the record tools nor in the records they return (see `account_fields`). |
| `fixed` | Only on a hidden field: the value the forms submit for it. **Required when the hidden field is required** (`region`, `environment`, `deployedVersion`, `releaseStatus`, `healthStatus`, `deploymentId`; `implementationStage`, `implementationProgressPct`, `implementationRiskLevel`, `blockerOwner`), and it must be a valid value: one of the enum's values, a number, or a non-empty string. |

**Defaults are exact.** The old UI used several words for one field ("Release status" on the form, "Release" as a
column, "Status" as a sort). Each of those spots keeps its own word until a profile changes the field's `label`;
from then on all of them show the profile's (`short_label` in the narrow ones). The same holds for enum values: a
table cell still shows the raw `deployed` until `options` differs from the default. So `profiles/00-default.json`
alone changes nothing a person sees.

### Custom fields

Relabelling a built-in column only goes so far: a coverage report has a rating and a target price, a site visit
has an inspection date and a permit, and no column of the base means either. `domains.<area>.custom_fields`
declares such fields. They are shown and edited like any other field, but they are **not columns**: every value
lives, by the field's `key`, in one `custom` jsonb column on the area's table (`deployments.custom`,
`implementation.custom`; migration `drizzle/0017_record_custom_fields.sql`). A profile therefore never needs a
migration, and two deployments of the same code can declare entirely different fields.

```json
"custom_fields": [
  { "key": "rating", "label": "Rating", "type": "pick_list", "options": ["Buy", "Hold", "Sell"], "required": true, "show_in_list": true },
  { "key": "target_price", "label": "Target price", "type": "number", "help": "Per share, in the listing currency." }
]
```

| Key | Meaning |
|---|---|
| `key` | What the value is stored and sent under. snake_case (lowercase letters, digits, single underscores; starts with a letter; at most 40 characters), unique in the area, and never the name of a built-in field in either spelling (`region`, `deployment_id` and `deploymentId` are all refused: relabel the built-in one under `fields` instead). **Do not rename a key once records carry it**: the values stay under the old key. |
| `label` | What people read. Unique in the area. |
| `type` | One of the types below. |
| `required` | `true`: a record cannot be CREATED without it, and it cannot be cleared afterwards. A record that predates the field can still be edited. |
| `options` | The choices of a `pick_list`: a non-empty list of distinct strings. Required for a `pick_list`, refused for any other type. The string is what is stored. |
| `help` | A line under the input. |
| `show_in_list` | `true`: also a column of the area's table view, and matched by its search. |

| `type` | Accepts | Stored as | Input |
|---|---|---|---|
| `text` | one line, up to 500 characters | string, trimmed | text |
| `long_text` | up to 20,000 characters | string | textarea |
| `number` | a finite number; `"1,250.50"` is read as 1250.5 | number | number |
| `percent` | a number from 0 to 100; `"85%"` is read as 85 | number | number, 0 to 100 |
| `date` | a real calendar date, `yyyy-mm-dd` | string | date picker |
| `email` | an email address | string | email |
| `link` | an `http://` or `https://` address, nothing else | string (normalised URL) | url |
| `pick_list` | one of `options`, matched without regard to case | the option as the profile spells it | select |

**One validator, every write path.** `agent/lib/custom-fields.ts` (`validateCustom`) takes the area, a `custom`
object and whether this is a create or an update, and returns the values to store or plain sentences
(`"Data completeness" (data_completeness) is a percentage: it must be from 0 to 100.`). It is what runs in:

- the Ops API: `POST /api/ops/deployments`, `PATCH /api/ops/deployments/:id`, `POST /api/ops/implementations`
  (an upsert: a create or an update depending on whether the row exists), `PATCH /api/ops/implementations/:id`.
  The body gains `custom: { "<key>": <value> }`; a refusal is a 400 with the sentences;
- the agent: `upsert_customer` carries `deployments[].custom` / `implementation.custom`
  (`applyCustomFields` in `agent/lib/system-of-record.ts`), and a refusal is the tool's error, written nothing;
- the MCP tools `deployment_upsert` / `implementation_upsert` (`setup/workspace-tools.mjs`), which go through the Ops
  API. The hosted endpoint (`/api/mcp`) names this deployment's fields in the `custom` input's description; the
  stdio package does not read the profile, so it describes `custom` generically, and the API's refusal of an
  unknown key lists the real ones with their types;
- the forms, before the request, so a person reads the same sentence under the field.

The rules are the same everywhere: an undeclared key is **refused**, never dropped silently; an update is a
**partial change** merged onto what is stored (send only the keys you are changing; `null` or `""` clears one);
a stored key the profile no longer declares is carried through untouched, because narrowing a profile must not
delete what people entered, but `null` / `""` for such a stored key clears it (any other value for it is still
refused). A refusal names a pick list's choices in quotes (`must be one of: "Buy", "Hold".`), so they reach the
model as written under a relabel. Reads return the values: `custom` on every item of `GET /api/ops/deployments` and
`GET /api/ops/implementations` (so `deployment_list` / `implementation_list`), and on the records
`get_customer` returns (left out when empty, so the default deployment's records read exactly as before).

**In the UI** the custom fields come after the built-in ones on the "New …" form and on the detail card, each
with the input for its type, a `*` on a required one, its help, and its error tied to the input
(`aria-describedby`, `role="alert"`). The detail card saves on blur or on pick, like its neighbours. A changed
value is a line in the record's activity feed under the field's label.

**The model** is told, in the per-turn block, where the values live and what each field accepts:
`` Own fields, by key in `deployments[].custom` (send only changed keys; null clears; other keys are refused):
`rating`="Rating" (Buy|Hold|Sell; required), `target_price`="Target price" (number) ``.

**The default profile declares none** (`"custom_fields": []` on both areas), so the default deployment shows,
stores and tells the model nothing new.

Not covered: the data-room workbook sheets (`Master.xlsx`) and the account report do not show custom fields, and
they cannot be sorted or filtered on in the list.

#### A non-research example: site visits

A field-service deployment that uses implementations as "Site visits":

```json
{
  "domains": {
    "implementations": {
      "label": { "singular": "Site visit", "plural": "Site visits" },
      "description": "One row per site: where the install stands and what the last inspection found.",
      "custom_fields": [
        { "key": "inspection_date", "label": "Inspection date", "type": "date", "required": true, "show_in_list": true },
        { "key": "inspector_email", "label": "Inspector", "type": "email" },
        { "key": "permit_link", "label": "Permit", "type": "link", "help": "The council's page for this permit." },
        { "key": "snag_clearance", "label": "Snags cleared", "type": "percent", "show_in_list": true },
        { "key": "access", "label": "Site access", "type": "pick_list", "options": ["Open", "Escorted", "Out of hours only"] },
        { "key": "findings", "label": "Findings", "type": "long_text" }
      ]
    }
  }
}
```

`POST /api/ops/implementations` with `{"customerId": "harbour-st", "custom": {"inspection_date": "2026-10-02", "snag_clearance": "80%"}}`
stores `{"inspection_date": "2026-10-02", "snag_clearance": 80}`; a later
`PATCH … {"customerId": "harbour-st", "custom": {"access": "escorted"}}` stores
`{"inspection_date": "2026-10-02", "snag_clearance": 80, "access": "Escorted"}`; and
`{"custom": {"inspection_date": null}}` is refused: *"Inspection date" (inspection_date) is required, so it
cannot be cleared.*

### `agent`

| Key | Meaning | Default |
|---|---|---|
| `agent.briefing` | Free text the model receives on every turn, inside the "This deployment" block (below; "This workspace" when the profile relabels). At most 400 words: it is paid for on every turn. Under a relabelling profile it is spoken in the profile's words like everything else the model reads, but write it in them to begin with. | `null` |
| `agent.compaction.specialist_tokens` | When a specialist's prompt is summarised, in input tokens. Every step of a specialist's run resends the run's history; past this size its older steps are summarised (tool results included) and the run goes on from the summary and its latest steps. Nothing is stopped and no step refused: this bounds what one step sends, not how many steps a run takes. A whole number from 32000 up, or `null` for eve's own (90% of the model's window, ~1.18M tokens on GLM 5.3, which a specialist never reaches). See [`SPECIALIST_CONTEXT.md`](SPECIALIST_CONTEXT.md). | `160000` |
| `agent.compaction.orchestrator_tokens` | The same for the main agent. Its steps resend the conversation and the specialists' results, not their tool steps. | `null` (eve's own) |
| `agent.compaction.specialists` | A value for one specialist, by its directory name (a pack's too), overriding `specialist_tokens`; `null` gives that one eve's own. A name that is not a subagent is refused at build. | `{}` |

Each value is held to 90% of the model's window, and read when the agent is built (eve compiles it into its
manifest). `MODEL_COMPACT_AT_TOKENS_SPECIALIST` / `MODEL_COMPACT_AT_TOKENS_ORCHESTRATOR` override the role values for
one deployment without a profile file (`off` = eve's own).

### `persona`

| Key | Meaning | Default |
|---|---|---|
| `persona.base` | Keep the base product's persona in the root prompt: the operations orchestrator, its specialist roster, the customer spreadsheet, the daily stand-up (`agent/prompt-persona.md`). `false` drops it: the root prompt keeps only its neutral rules (`agent/prompt-core.md`, opened by `agent/prompt-neutral.md`), and the pack's `agent/instructions/50-pack-*.md` says who the agent is and what the work is. | `true` |

### `specialists`

| Key | Meaning | Default |
|---|---|---|
| `specialists.exclude` | Base specialists (directory names under `agent/subagents/`) the deployment does not use. They leave the model's roster (eve makes every directory under `agent/subagents/` a tool the model can delegate to, and has no switch to hide one), the persona's roster and every prompt's list of names, the subagent registry, the UI lists and the workflow author's list. Nothing is moved: the directories stay tracked, so a git checkout of a stamped build regenerates the same tree. `scripts/gen-subagent-meta.mjs` leaves them out of the registry; the provisioned workflow library drops any workflow that delegates to one (`agent/lib/workflow-library-view.ts`); and `npm run build:eve` / `dev:eve` run eve through `scripts/eve-build.mjs`, which hides their directories from eve for the length of that one command and restores them however it ends (a run killed mid-build is restored by the next run, or by `node scripts/eve-build.mjs --restore`). Run `eve build` directly and they are back in the roster. A name that is not a subagent fails the build. | `[]` |

### `library`

What every **new** workspace of the deployment is provisioned with: workflow scripts, the
onboarding recipe catalog and starter apps. Base code ships none of them. All three are
content, in directories the profile names:

| Key | Meaning | Default |
|---|---|---|
| `library.sources` | A map of source id to a directory in the repository. Each directory holds `workflows/*.workflow.js` (scripts: `export const meta = { name, description }` plus `phase()` / `agent()`) and/or `recipes.json` (`{ "recipes": [{ slug, title, summary, satisfiesCheck }] }`, in checklist order). `npm run build:workflow-library` compiles every named source into `agent/lib/workflow-library.generated.ts`, which `provisionWorkspace` writes into a new workspace and `GET /api/ops/recipes` falls back to. Objects merge, so a later profile ADDS a source under its own id and turns one off with `null`. Two sources shipping the same workflow name or recipe slug fail the build. A directory may also hold `apps.json` (or `apps/*.json`): starter apps, below. | `{}`: no workflow, no recipe, no starter app |

The default is **empty, not "neutral"**. A starter workflow has to delegate to some specialist
and ask for some piece of work, and a checklist has to name some first step: whatever was
chosen would be one line of work's idea of a default, handed to every deployment. So the
default deployment provisions only what is derived from the build itself (one "on delegation"
row per specialist it has), and `npm run check:neutral-names` refuses a library in base code:
a workflow script outside `library/`, a recipe written as a literal, a starter app outside a
library (an `apps.json` elsewhere, or one written as a literal), a source named by the
default profile, or a new file that inserts into the `workflows`, `recipes` or `apps` table
without being listed with what decides its rows.

The workflows and recipes this product carried as built-ins before are
[`library/account-delivery/`](../library/account-delivery/README.md), unchanged. A deployment
that wants them opts in with one line, then builds:

```bash
cp library/account-delivery/profile.json profiles/40-library-account-delivery.json && npm run build:generated
```

A subagent pack ships its own library the same way: `library/<pack-id>/` beside its
specialists, named in its `profiles/NN-pack-<id>.json`
(`"library": { "sources": { "<pack-id>": "library/<pack-id>" } }`).

What the profile does to a library it names is unchanged: a workflow that delegates to a
specialist under `specialists.exclude` is not provisioned, and every other workflow's and
recipe's text is written in the profile's words.

#### Starter apps

A **starter app** is an app (a saved document a specialist or a workflow regenerates, shown in
the Apps tab) that every new workspace of the deployment is created with. A library declares
them in `apps.json`, or one per file under `apps/`:

```json
{
  "apps": [
    {
      "key": "open-follow-ups",
      "name": "Open follow-ups",
      "description": "Every open follow-up and commitment, oldest first, with who owes it.",
      "brief": "List every open follow-up across all {accounts}, oldest first. One table: …",
      "source": { "specialist": "follow-ups" },
      "refresh": "0 7 * * 1-5",
      "first_content": "on_open"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `key` | Stable, unique in its library, lower-case letters, digits and hyphens. A workspace's row carries `<library id>/<key>` (`apps.starter_key`, unique per workspace), which is what makes provisioning idempotent. **Never change it**: a changed key is a new app, and the old one becomes a leftover. |
| `name`, `description` | What a person reads in the Apps tab. The name is unique across every library the build names. |
| `brief` | What the source is asked for at every refresh. Say what the document must hold. |
| `source` | `{ "specialist": "<id>" }`: a specialist this build has (a directory under `agent/subagents/`, not under `specialists.exclude`); its reply is the document. Or `{ "workflow": "<name>" }`: a workflow the **same** library ships; its script's return value is the document. |
| `refresh` | Optional. A 5-field UTC cron expression. Without it the app is refreshed only when a person asks. |
| `first_content` | Optional. `"on_open"` (the default): the first document is written when a person first opens the app, or when its schedule first comes due. `"on_create"`: the request that creates the workspace starts it, as the person creating it. |

Text may write the placeholders the profile fills (`{account}`, `{accounts}`, `{owner}`, …),
like a library workflow; a workspace's row is stored in the deployment's words.

**The build refuses** (`npm run build:workflow-library`, part of `build:generated`) a starter
app it could not generate or should not carry, naming the file and the reason: a source that
is not a specialist of this build, one the profile excludes, a workflow that is not this
library's or that this build does not provision (it delegates to an excluded specialist), a
duplicate key or name, a schedule that is not a cron expression, a missing brief, an unknown
key, or text that looks like a credential (an API key, a token, a password, a URL with one).

**Creating a workspace runs no model.** A starter app is created as a definition with no
document, by `system`. Until it has one, the Apps tab lists it with a `starter` mark and
"written when first opened"; opening it shows "This app came with the workspace and has not
been written yet" and starts its first document, once, however many people open it
(`POST /api/ops/apps/:id/refresh?first=1`, `lib/starter-apps.ts`). Only an app whose library
says `"on_create"` is written when the workspace is created.

After that a starter app is an ordinary app: a person can rename it, change its brief, source
or schedule, pause it or delete it. **A deleted one does not come back**: the row is
soft-deleted and keeps its key, and provisioning never creates a key twice. An edited one is
never overwritten.

**Workspaces that already exist are never changed by a build.** Nothing is added or deleted
automatically:

| To | Run |
|---|---|
| give an existing workspace the library the profile names | `npm run operator:seed-workflows -- --org <id>` (inserts and updates by name; removes nothing) |
| give it the row of a specialist added since | `npm run operator:seed-subagent-rows -- --org <id>` |
| see which starter apps the library would add to an existing workspace | `npm run operator:library-apply` (a dry run: per workspace, what would be added, what would not and why) |
| add them | `npm run operator:library-apply -- --org <id> --apply` (adds only what the dry run listed; an app the workspace has, one a person deleted, and one whose name is taken are left alone; nothing is generated) |
| see what an earlier build left behind that this deployment does not use | `npm run operator:library-cleanup` (a dry run: per workspace, what would go and what stays, with why) |
| remove it | `npm run operator:library-cleanup -- --org <id> --apply` |

The cleanup offers a row for removal only when it is a leftover AND nobody touched it: a
workflow with the name and the code of one a library directory has shipped that this profile
does not provision, the scriptless row of a specialist the profile excludes, or a recipe of
such a library; never edited (no later update, no instructions, no saved version, no
recipients, no account scope), never run, and with no app, schedule or system cron built on
it. A **starter app** is a leftover when it carries the key of a library this build no longer
names (or that no longer ships it): removable while nobody has edited, opened or refreshed it
(no later change, no document, no attempt, no version in its history), kept from then on. An
app a person or the agent made has no key and is never looked at. Everything else is kept and listed with the evidence. Until it is run, a leftover that
delegates to an excluded specialist is shown as not part of the workspace and refused by every
run path (`lib/workflow-availability.ts`).

### `work_periods`

A time-boxed period that groups tasks (the `cycles` table; a task's `cycleId`). The base product had one idea of it,
a period the whole team shares, under its own word. A deployment says here which of three things a period is, what it
is called, and whether it exists at all. Everything that shows, offers or answers anything about a period reads the
mode and the words from one module, `agent/lib/work-periods.ts`.

| Key | Meaning | Default |
|---|---|---|
| `work_periods.mode` | `"team"`: one shared period with a lead, a capacity and a burndown. `"individual"`: each person has their own items within the period (their own goal and planned count, in `cycle_member_goals`); no shared lead, no team capacity; every view groups by person and shows the signed-in person first. `"off"`: the feature does not exist in this deployment. | `"team"` |
| `work_periods.label` | `{ singular, plural }`: what a period is called, wherever a person or the model reads it. | the base product's word (see `profiles/00-default.json`) |
| `work_periods.list_label` | `{ singular, plural }`: what it is called where tasks are grouped and filtered by it (the filter, the task's field, the New button). The base product has always used a second word there. A profile that states only `label` gets its label here too. | the base product's second word |
| `work_periods.item_label` | `{ singular, plural }`: what one task in a period is called under mode `individual`. | `target` / `targets` |
| `work_periods.length_days` | How long a new period runs. `null`: a new period has no dates until someone sets them. Required by mode `individual` and by `auto_rollover`. | `null` |
| `work_periods.auto_rollover` | When a period has ended, it is closed and every unfinished task is carried into the period that follows (opened, `length_days` long, when there is none), each keeping its assignee. `false`: someone rolls over by hand. | `false` |
| `work_periods.length_days_range` | `[min, max]`: the whole numbers of days a workspace admin may choose from for their own workspace's length (below). `length_days`, when set, must lie inside it. Each from 1 to 366, the smaller first. | `[1, 90]` |
| `work_periods.workspace_can_set_length` | May a workspace admin change the length for their workspace? `false`: every workspace runs `length_days`. `null`: yes, unless the mode is `off` (`true` under `off` fails the build). | `null` (yes) |

**What each mode is, everywhere.**

| | `team` | `individual` | `off` |
|---|---|---|---|
| Todos navigation | the period view, under `label` | the period view, under `label` | no period view; a link to it opens the task list |
| A period's card and panel | lead, capacity, shared goal, burndown, its tasks | one block per person, the signed-in person first: their goal, planned count, a done/planned bar, their items; no lead, capacity or burndown | none |
| Task list | filter, column and field for the period | the same, in the profile's word | none of them |
| Rolling over | by hand, to the backlog | to the next period, each item still its person's; one person's or everyone's; automatic with `auto_rollover` | none |
| The model's tools | `list_cycles`, `upsert_cycle`, `upsert_todo`'s `cycleId` | the same names: `list_cycles` also returns one person's items and progress for the current period (the signed-in person by default), `upsert_cycle` sets a person's goal and planned count, `upsert_todo` takes `cycleId: "current"` | `list_cycles` and `upsert_cycle` are not registered; `upsert_todo` has no `cycleId` |
| The coding agent's tools | the two period tools; task tools take `cycleId` | the same, in the profile's words | neither period tool; no task tool takes or names a period |
| `/api/ops/cycles/**` | as before; `…/goals` is a 404 | plus `GET`/`PUT /api/ops/cycles/:id/goals`; a period refuses a lead or a capacity | every route is a 404 |
| A task write that names a period | forwarded | checked first: see below | refused (400); a task is answered without its period |
| Exports, activity, comments | carry the period | carry it, without a lead | omit it; there is no `cycle` entity |

Under `off` nothing is deleted: `cycles` rows, every task's `cycle_id` and every goal stay exactly as stored, and are
there again if the mode changes.

**Whose an item is (mode `individual`).** A task in a period belongs to its assignee (to its creator when it has
none). Setting, changing or completing one that is, or would become, somebody else's needs the caller to be in that
person's reporting chain on the roster (`people_roster.manager_email`: their manager, that manager's manager, and so
on). The same rule holds a person's goal, and carrying one person's items forward. It is enforced at the ops routes
and at the model's tools alike (`agent/lib/work-period-store.ts`), and the answer says who does not report to whom.
A task in no period is the team's shared checklist, as it always was.

**The words.** Text the model reads writes a placeholder, filled at the same boundary as the role and record words:
`{period}`, `{periods}`, `{Period}`, `{Periods}` (the `label`) and `{period_item}`, `{period_items}`, `{Period_item}`,
`{Period_items}` (the `item_label`). Text a person reads comes from `lib/work-periods-ui.ts` (every label and sentence
about a period, per mode) and `W.period` / `W.periodList` / `W.periodItem` in `lib/ui-words.ts`. Identifiers do not
change with a profile: the `cycles` table, `cycle_id`, the `/api/ops/cycles` routes, the tool names, the `cycleId`
parameter, the coding agent's two period tools (`sprint_list`, `sprint_create`) and the view key in a shared link
(`view=sprints`) keep their names. The task service is a separate deployment with no profile of its own: the web app
and the agent tell it the word on each request (`x-period-label`), and its activity feed names a period move by it.

**A workspace's own length.** `length_days` is the deployment's default; a workspace admin (role owner or admin)
may choose another for their workspace, in the workspace settings screen, on a tab named by the profile's word
(`label.plural`, e.g. "Coverage targets"), as "{Period} length" ("Coverage target length"), with the note "Applies to
new {periods}; the current one keeps its dates." Everyone else in the workspace sees the value read-only. It is
stored on the workspace's own row (`orgs.period_length_days`, drizzle/0033; null = the default) and read and written
by `GET`/`PUT /api/ops/orgs/:id/period-length` (`{ "lengthDays": 14 }`, or `null` for the default). A value outside
`length_days_range` is refused (400), a member is refused (403), and under mode `off`, or with
`workspace_can_set_length: false`, the tab is not shown and the route refuses it (404 under `off`). Every change is a
line in the workspace's audit trail. The chosen length applies to every period the workspace opens from then on, at
every door: by hand, by the model's `upsert_cycle` (a new period given no dates), by `upsert_todo`'s
`cycleId: "current"` and by `auto_rollover`. A period that exists keeps its dates. One workspace's length never
reaches another's, and the agent reads it (`agent/lib/work-period-store.ts`, `workspacePeriodLength`) but has no way
to change it. The `settings` object of `agent/lib/work-periods.ts` (`WORK_PERIODS`) is unchanged; the choice and its
bounds are `PERIOD_LENGTH` beside it.

**Automatic rollover has no timer.** It runs when a workspace's periods are read (the list route, the model's list
tool), inside that workspace's own transaction, so it cannot reach another workspace and needs no scheduled job. A
period that ended overnight is rolled over the first time anyone, or the agent, looks.

Each person's own targets for a week:

```json
{
  "work_periods": {
    "mode": "individual",
    "label": { "singular": "week", "plural": "weeks" },
    "item_label": { "singular": "target", "plural": "targets" },
    "length_days": 7,
    "auto_rollover": true,
    "length_days_range": [7, 28]
  }
}
```

(Each workspace's admin may then choose a length from 7 to 28 days for their own workspace; a new one runs a week.)

No periods at all:

```json
{ "work_periods": { "mode": "off" } }
```

### `asr`

Dictation in the chat composer: speech to text for writing a prompt. It is **one button** and it never changes the
composer's height:

| The person | What happens |
|---|---|
| holds the microphone (mouse, finger, or Space / Enter with it focused) and speaks | press-to-talk: it listens while held and stops on release |
| double-clicks it (double-tap, double-press, or Shift+Enter) | it keeps listening hands-free, in its own colour with a solid ring (`aria-pressed`) |
| clicks it again, or presses Escape | it stops |
| clicks it once, quickly | nothing is recorded; a tooltip says "Hold to talk · double-click to keep listening" |

While it listens the button beats: a ring that follows the voice's level (a still ring under
`prefers-reduced-motion`), with the elapsed time as a small badge on the button. What is said arrives in the message
box **section by section**, at each natural pause, while the person is still talking, **at the cursor** and in the
order spoken; a small marker in the box shows where the next words will land. The box stays the person's to type in
meanwhile: their edits move the landing place and are never overwritten. It never sends a message on its own and
there are no spoken replies. Both composers carry it (the main chat and a specialist's steer box), after their own
tools.

| Key | Meaning | Default |
|---|---|---|
| `asr.enabled` | `true`: the button shows whenever the provider's credentials are set on the server; without them it stays hidden (the composer asks `GET /api/ops/dictation` once per tab). `false`: no dictation in this deployment, and `POST /api/ops/dictation` answers 404. | `true` |
| `asr.provider` | `"cloudflare"`: Workers AI, with the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` the chat's models already use. No new secret. | `"cloudflare"` |
| `asr.model` | The speech-to-text model: one of the models in `lib/dictation-models.ts`, each priced per audio minute in `lib/inference-pricing.ts` (`AUDIO_PRICES`). Any other id does not build. Today: `@cf/openai/whisper-large-v3-turbo` ($0.000513/min), `@cf/openai/whisper` ($0.000453/min; takes no language), `@cf/deepgram/nova-3` ($0.0052/min; en, es, fr, de, hi, ru, pt, ja, it, nl). | `"@cf/openai/whisper-large-v3-turbo"` |
| `asr.language` | An ISO 639-1 code (`"en"`, `"hi"`) to transcribe in, or `null` for the model to detect it. It must be one the model takes. | `null` |
| `asr.max_seconds` | The longest single clip (one section), 5 to 600. The button never sends a section longer than 10 seconds, or than this if it is shorter. | `120` |
| `asr.max_bytes` | The largest upload, 64 KB to 10 MB (the most the proxy in front of every `/api/ops` route passes on). The default stays under the 4.5 MB request body a Vercel function accepts; a ten-second section is about 320 KB. | `4194304` (4 MB) |
| `asr.max_session_seconds` | The most one stretch of listening may run (a hold, or hands-free from the double-click to its stop), 10 to 3600. The button stops itself there and says so ("that was the limit of 10 minutes in one go"); the server refuses a stretch's sections once that much of its audio has been transcribed (`429 session_limit`). | `600` |
| `asr.idle_stop_seconds` | How long hands-free listening waits in silence before it stops itself, 5 to 120. | `20` |

A deployment may choose its own model and language over the profile's, in its environment, the way it chooses the
chat's models per role: `ASR_MODEL` (a model from `lib/dictation-models.ts`), `ASR_LANGUAGE` (a two-letter code, or
`auto` for the model to detect it) and `ASR_ENABLED` (`true` or `false`); unset or empty means the profile's. A model
the app cannot call or price, or a language the model cannot take, **fails closed**: the microphone is hidden and the
dictation route logs `[dictation] dictation is off: <why> (set by ASR_MODEL)`. Usage is recorded under the model that
transcribed it, so the usage report prices whichever was chosen.

How it works (`lib/dictation.ts`, `lib/dictation-segmenter.ts`, `lib/dictation-order.ts`, `lib/dictation-models.ts`,
`app/api/ops/dictation/route.ts`, `app/_components/dictation-button.tsx`, `app/_components/dictation-engine.ts`):

- **Sections.** The browser takes the microphone's raw samples through the Web Audio graph (an `AudioWorklet`,
  `public/dictation-capture.worklet.js`; a `ScriptProcessorNode` where there is none), brings them down to 16 kHz mono
  and cuts them where the person pauses: 600 ms of quiet closes a section, a section past 8 seconds closes at the
  first short breath, and one at 10 seconds closes whatever is being said. Quiet between sections is never sent. Each
  section is posted as it closes, as a complete 16-bit WAV file of its own, and the server transcribes it with the
  deployment's model, so it works the same on Vercel and on a self-hosted server, and in Chromium, Firefox and Safari
  alike. No browser speech service is used.
- **Why not `MediaRecorder`, restarted at each pause:** stopping and starting a recorder loses the audio in between
  (mid-word, at a length cut), it cannot reach back before the voice was noticed (a section here starts 240 ms
  earlier, so the first consonant is kept), and it gives a different container per browser (WebM or Ogg Opus, or
  Safari's fragmented MP4). Samples cut by index lose nothing and are the same bytes everywhere.
- **Order.** Each section carries the stretch of listening it belongs to (`session_id`, the browser's random id) and
  its place in it (`seq`). Up to three are in flight at once and their answers return in any order; the browser holds
  an answer until every earlier section has been answered or given up on, so the text always reads as spoken.
- **Loaded on use.** The button loads only once the server says dictation is on, and the engine (microphone, level,
  cut) only on the first press: neither is in the chat's first load.
- The route is signed in and workspace-scoped like every `/api/ops` route: the workspace is the sign-in's (a named
  one only for a member), never anything in the form.
- The limits are checked on the server before the paid call (the upload's size, the length the browser states, and,
  for a section, what its stretch has already used: `max_session_seconds` of audio, and 40 sections in any minute,
  `429 rate_limited`) and after it (the length the model measured: a longer clip is recorded as used, since it was
  paid for, and its text refused). A stretch's use is read from its usage rows, in the caller's workspace, so the limit
  holds across server instances. A client that posts a single recording with no `session_id` is served as before.
- No audio is kept: the clip is held in memory for the request and sent to the provider, nothing else.
- Usage: one `chat_turn_usage` row per clip (each section is one), of kind `dictation`, under the workspace and person
  who recorded it, with the audio's length in milliseconds (`audio_ms`; migration `drizzle/0039_dictation_usage.sql`).
  A section's row is keyed by workspace, stretch and place (`dictation:<workspace>:<session_id>`, `section-<seq>`; no
  new column), so a stretch's sections group and a section sent twice adds to its one row. `GET /api/ops/usage`
  reports `dictations` and `audio_seconds` beside the chat's `turns`, the model as its own line in `by_model`, and
  prices it per audio minute in `est_cost_usd`.
- Errors are said in plain words in a popover anchored to the button, never a new row: a blocked microphone (how to
  allow it), no microphone, a browser that cannot record, nothing heard, and the server's own refusal (too long, too
  large, the session limit).
- Accessibility: each change is announced once (`role=status`: listening, hands-free, stopped and why);
  `aria-pressed` is the hands-free state; hold Space or Enter to talk, double-press or Shift+Enter for hands-free,
  Escape to stop; a click with no press behind it (an assistive tool's "activate", which cannot hold) turns hands-free
  on and off; on a phone a long press is a hold, never the browser's text selection or menu.

Turning it off:

```json
{ "asr": { "enabled": false } }
```

### `account_fields`

| Key | Meaning | Default |
|---|---|---|
| `account_fields.hidden` | Fields of the account record itself (the `customerSchema` keys in `agent/lib/customer-schema.ts`: `arr`, `seats`, `aeOwner`, `renewalDate`, `contractStatus`, … and the nested parts `platform`, `solutions`, `tickets`) this deployment does not use. They are removed from what the **model** reads and writes: `upsert_customer`'s parameters, and every record `get_customer`, `list_customers` and `upsert_customer` return; a hidden nested part is also dropped from those tools' descriptions. A hidden key the model sends anyway is not written. Storage, the API, the CLI, the MCP server and the forms are unchanged. `id` and `name` cannot be hidden, nor `custom` (it holds `custom_fields`, below); an unknown key fails the build. The two owner fields may be named by either of their keys: `accountOwner` or `accountOwner`, `aeOwner` or `secondaryOwner`. Either hides the one field under both keys; naming both keys of a pair is naming it twice. | `[]` |
| `account_fields.custom_fields` | The deployment's OWN fields on the account record itself: a research desk's notes on a company, a field team's permit number on a site. Same spec, types and rules as [Custom fields](#custom-fields) on the areas; see [Own fields on the account record](#own-fields-on-the-account-record). | `[]` |

The two redefinable areas hide their own fields with `domains.<area>.fields.<key>.hidden` (above), and the record
tools apply those the same way: a hidden `deployments[]` / `implementation` field WITHOUT a `fixed` value is not a
parameter and is not in a returned record, and a write never blanks it: a patch changes only the `deployments[]`
rows and `implementation` fields it names (null clears one, `remove: true` deletes a row, and a row or field it
leaves out keeps its stored value), each written in SQL onto what is stored at write time. A hidden field WITH a
`fixed` value stays a parameter, because the briefing tells the model to write that value.

### Own fields on the account record

`account_fields.custom_fields` declares fields the account record never had, exactly as `domains.<area>.custom_fields`
does for the areas: the same entry (`key`, `label`, `type`, `required`, `options`, `help`, `show_in_list`), the
same eight types (`long_text` is the multi-line one: up to 20,000 characters, line breaks kept, shown as a
textarea; `text` is one line of at most 500), the same generator rules and the same validator. The values live, by
key, in one `custom` jsonb column on the `customers` table (migration `drizzle/0019_account_custom_fields.sql`),
so declaring or changing fields never needs a migration.

A pack that wants company notes on the company record puts this in its `profiles/NN-pack-<id>.json`:

```json
{
  "account_fields": {
    "custom_fields": [
      { "key": "notes", "label": "Notes", "type": "long_text", "help": "What we know about the company: filings read, calls held, open questions." }
    ]
  }
}
```

(An overlay states only what it changes: `account_fields.hidden` keeps whatever the pack's profile already says.)

What differs from the areas:

- **The key** may not be any account field or `customers` column in any spelling (`health_reason`, `arr`,
  `customer_name`, `org_id`, `deployments`, `custom`…), hidden or not: a hidden built-in field is still a real one.
- **The column is NULLABLE** (the areas' is `NOT NULL DEFAULT '{}'`): NULL is "no own values", so the migration
  rewrote no existing row, and an account whose values are all cleared goes back to NULL.
- **The model** gets `custom` as an `upsert_customer` parameter **only when the profile declares account fields**;
  with none declared the tool's schema is exactly what it was before (the default surface is held byte-identical
  by `check:agent-vocabulary`). `get_customer` and `upsert_customer` return every value (left out when there are
  none); `list_customers` carries only the fields marked `show_in_list`, so a long note on each account does not
  make one list call cost what reading every account does. The per-turn block names them:
  `` - Own fields of each customer, by key in its `custom` (read with `get_customer`, write with `upsert_customer`;
  send only changed keys; null clears; other keys are refused; add to a long text with `custom_append` instead of resending it (replace one: null in `custom` plus the new text in `custom_append`); `list_customers` carries none of them): `notes`="Notes" (long_text). ``
- **Under a relabel** the keys, labels, choices and every stored value pass through verbatim, both ways: a note
  that names a stored path or says "deployment" is user data, and reaches the model and storage as written.
- **With `account_fields.hidden`**: hiding built-in fields and declaring own ones combine as expected. A hidden key
  the model sends is dropped while its `custom` is written, and a stored hidden value survives either write.
- **Long notes** (`long_text`) are never resent whole just to add to them. `upsert_customer` takes
  `custom_append: { "<key>": "<text>" }` (offered to the model only when the account declares a long-text field):
  the text is trimmed and added after the stored text and a blank line, and the total must still fit 20,000
  characters, checked when the text is read and again at write time, on the value the database is about to commit
  (so two appends at once cannot push it past the limit; the later one is refused with a sentence and nothing is
  written). To REPLACE a long note in one call, send `null` for its key in `custom` together with the new text in
  `custom_append`: one SQL write, so there is no moment (and no second approval) at which the old text is gone and
  the new one not there. Any other combination of one key in both is refused. And the model may not cut a
  long-text value of 500 characters or more to under half its length by rewriting it in `custom`: that is refused
  with a sentence naming the one-call replacement. The guard compares with the stored value only, so a model can
  still step a note down in several approved writes (1,000 → 500 → 250 …); each is a separate write the person
  approves, which is the point of the guard (a note cut short without anyone deciding to), so that is accepted.
  The guard is on the model's path only (the account's fields and the areas', where the replacement is clear
  first, then write); the API and the forms, which people drive, are not guarded.
- **Text values** may not contain a NUL character (`\u0000`): Postgres cannot store one, so it is refused with a
  sentence rather than failing in the database.
- **Concurrent writes do not lose values.** An existing account's `custom` is changed only by the keys a write
  names, merged in SQL onto what is stored at write time
  (`custom = (coalesce(custom, '{}') || set, appends concatenated) - cleared keys`, NULL when that leaves nothing;
  `agent/lib/custom-merge-sql.ts`); a write that does not name `custom` leaves the column out of its update. Before
  this, the agent's upsert wrote back the whole value it had read, and a note saved in between was lost.
- **The Ops API**: `POST /api/ops/customers` (the MCP tool `customer_create`) takes `custom`: validated, merged onto
  what is stored on an update (in SQL, as above), a 400 with the sentences when refused. It does not take
  `custom_append`. `GET /api/ops/customers` (`customer_list`)
  returns the `show_in_list` values under `custom`. The hosted MCP endpoint names the declared fields in
  `customer_create`'s `custom` input; the stdio package describes it generically.
- **The UI**: the base has no account form or account detail card (accounts are created by the agent, the API or
  the MCP tool, and appear in pickers), so the fields are not shown in the web app yet. Not covered either: the
  data-room workbook (`Master.xlsx`) and the account report.

### `people`

**Who is who in a workspace**: what the workspace's owner (or an admin) records about each person on its roster,
beside the name and team it already had. The workflow engine (docs/WORKFLOW_ENGINE.md, phase 4) routes a step by these:
"whoever is in the north desk", "one level up from the submitter", "someone with grade g2". The catalogue (which
departments exist, which attributes, their types) is the **deployment's**, declared here; a workspace fills in values,
never keys, so a workflow step that names a department or an attribute value finds the same key in every workspace.
That is why departments are profile-declared rather than managed per workspace: a per-workspace list would let a
step's department exist in one workspace and not the next, and the engine's directory query would then quietly match
nobody.

| Key | Meaning | Default |
|---|---|---|
| `people.department_label` | What a department is called, `{ singular, plural }`: the field's label, the column's header, the sentences. | `{ "singular": "department", "plural": "departments" }` |
| `people.supervisor_label` | The label of the reporting line (who the person reports to: `people_roster.manager_email`, their supervisor) in the person drawer. | `"Reports to"` |
| `people.multiple_departments` | May a person be in more than one department. | `false` |
| `people.departments` | `[{ "key", "label" }]`: the departments a person may be in. `key`: lower-case letters, digits and `_`, stored; `label`: what a person and the model read. Empty: no department field anywhere. | `[]` |
| `people.attributes` | `[{ "key", "label", "type", "options"?, "help"? }]`: typed attributes recorded about each person. `type` is one of the workflow engine's four: `choice` (one of `options`), `multi_choice` (some of them), `boolean`, `text` (one line, at most 500 characters). `options` are `[{ "value", "label" }]`, only for the two choice types. A key may not be a field every person already carries in the engine's directory (`id`, `email`, `name`, `role`, `team`, `department(s)`, `business_unit(s)`, `supervisor`, `manager`, `reporting_managers`, `employment_status_active` and any key ending in `_ids`). Empty: no attribute anywhere. | `[]` |

```json
{
  "people": {
    "department_label": { "singular": "desk", "plural": "desks" },
    "supervisor_label": "Supervisor",
    "multiple_departments": true,
    "departments": [{ "key": "north", "label": "North desk" }, { "key": "south", "label": "South desk" }],
    "attributes": [
      { "key": "grade", "label": "Grade", "type": "choice", "options": [{ "value": "g1", "label": "Grade 1" }, { "value": "g2", "label": "Grade 2" }] },
      { "key": "on_call", "label": "On call", "type": "boolean" }
    ]
  }
}
```

Where the values live and who touches them (`agent/lib/people-data.ts`, the pure half `agent/lib/people-catalogue.ts`):

- **Storage**: `people_roster.departments` (jsonb list of keys, `[]` by default) and `people_roster.attributes` (jsonb
  object by key, `{}` by default), `drizzle/0046_people_directory.sql`. The supervisor is the roster's existing reporting
  line, `people_roster.manager_email`. All three sit under the roster's row-level security: another workspace reads
  none of them. The roster is keyed by `(org_id, email)` (`drizzle/0049`): the same person on two workspaces' rosters
  is two rows, each with its own team, line, departments and attributes.
- **Who sets them**: the workspace's owner or an admin, in the Control Panel's person drawer (People tab) or through
  `POST /api/ops/roster` (`managerEmail`, `departments`, `attributes`; attributes merge per key, `null` clears one).
  Anyone else gets a 403 and nothing is written; a member still sets a team and escalation contacts as before. The
  supervisor must be someone of the same workspace (on its roster or one of its signed-in people), never the person
  themself, and must not close a reporting loop, checked under a per-workspace lock in the write's transaction. The
  bulk and workbook roster imports hold the same reporting-line rules over the whole sheet and are applied whole or not
  at all; the model's `upsert_roster_member` changes a reporting line only for a caller who is the workspace's owner or
  an admin.
- **Who reads them**: everyone in the workspace reads each person's departments (as the team and reporting line
  before them); a person's attributes are read by that person and by the workspace's owner and admins
  (`GET /api/ops/roster`, `GET /api/ops/people/:email`). With nothing declared, both answer exactly what they did.
- **The model**: `list_roster` adds each person's `departments`, by the profile's labels, only when departments are
  declared; with none declared its description and results are what they were (the default surface is unchanged).
- **The engine's directory**: `identitySnapshot()` in `agent/lib/people-directory.ts` builds the engine's identity
  snapshot (directory people, role boundaries, reporting rows) from one workspace's roster and signed-in people.
  The record write path calls it for an area whose lifecycle runs a workflow (phase 5, docs/WORKFLOW_ENGINE.md
  "Runtime").

### `records`

**Record areas**: the one model behind the four kinds of record a deployment shapes. Each area is bound to the table
it already has, and a profile may only REDEFINE these four, only here, at build time (a workspace's own settings keep
what they had: the period length and the task pipelines):

| Area | Table | Legacy form (still accepted) |
|---|---|---|
| `deployments` | `deployments` | `domains.deployments` |
| `implementations` | `implementation` | `domains.implementations` |
| `tasks` | `todos` (stored by the task-workflow service) | none: `00-default.json`'s `records.areas.tasks` is today's |
| `periods` | `cycles` | `work_periods` |

Which area a domain concept belongs in is decided by the area's structure, not its id: see "Choosing the area for a
domain concept" below.

```jsonc
"records": { "areas": { "tasks": {
  "label": { "singular": "obligation", "plural": "obligations" },
  "fields": {
    "dueAt":     { "label": "Due", "required": true },                       // a column of the table: relabelled, typed
    "state":     { "type": "pick_list", "label": "Status",                    // the area's OWN field, stored in `custom`
                   "options": [ { "value": "not_started", "label": "Not started", "tone": "slate" }, … ] },
    "frequency": { "type": "pick_list", "label": "Frequency", "options": [ { "value": "Monthly" }, … ] }
  },
  "lifecycle": { "field": "state", "initial": "not_started", "enforce": "warn",
                 "categories": { "not_started": "open", "in_progress": "active", "closed": "done", … },
                 "transitions": [ { "from": ["under_review"], "to": "closed", "roles": ["owner", "admin"], "not_by": "assignee" } ] },
  "views": { "board": { "by": "state" }, "create": { "fields": ["title", "dueAt", "frequency"], "submit_label": "Add obligation" } }
} } }
```

- **Fields** are a map keyed by field key, so a later file changes one without restating the list. A key that names a
  column of the area's table is that column (its type must fit it: a column with a fixed list of values is a
  `pick_list` of exactly those values, relabelled with `label`); any other key is the area's own field, stored by key
  in the table's `custom` jsonb column (snake_case, never a column's name in any spelling). Types: text, long_text,
  integer, number, percent, money, date, datetime, boolean, email, link, pick_list, multi_pick, person, record, file,
  tags. A field may carry `required` (`true` or `"on_create"`), `default` (a value, `{today}`, `{today+7d}`, `{me}`),
  `min`/`max`, `max_length`, `pattern`, `hidden` with `fixed`, `computed`, `legacy_values`, `renamed_from`, `index`.
  `columns: "listed"` hides every column the area does not name (a hidden required column still needs `fixed`).
- **A renamed own field** (`renamed_from: "<old key>"`, or a list `["<previous key>", "<the one before>"]`, newest
  first, for a field renamed more than once) is read under its key, else under each earlier key in order, the first
  key a row holds winning (`agent/lib/own-keys.ts`, used by `agent/lib/record-areas.ts` `get` and so by every screen,
  the tools, the lifecycle and the workbook). The server reads it the same way: a list's filters (equality as
  containment under a key only when no newer key is held, the GIN index still serving it), sorts, `set`, search,
  computed fields and metrics read `coalesce(custom -> new, custom -> previous, …)` (`agent/lib/record-query.ts`), so a
  row stored under any earlier key is neither skipped nor counted twice. A move starts from the state the row holds
  under whichever key (and a stored legacy spelling is read as its state, `legacy_values`, in filters and counts too).
  A write stores the new key; clearing the field clears every earlier key, so an older value does not come back.
  Rows are never migrated. An earlier key may not be the field's own key, listed twice, a field of the area or an
  earlier key of another field. Only a renamed field reads more than one key; every other own field's SQL is unchanged.
- **How many implementations an account holds** (`records.areas.implementations.per_account`, the implementations
  area only): `"one"` (the default, and what a profile that says nothing gets) keeps one record per account, keyed by
  it, as it always was. `"many"` (a regulator's several compliance frameworks) gives each record its own
  `implementationId` (`implementation.implementation_id`, the table's key with the workspace since `drizzle/0044`;
  `agent/lib/implementation-ids.ts`): the screens, `POST`/`PATCH`/`DELETE /api/ops/implementations[/:id]` (a `POST`
  naming an `implementationId` changes that record, one without creates a new one with a generated id; an id another
  account's record holds is a 409), `upsert_customer`'s `implementations[]` (each row by its `implementationId`, as
  `deployments[]`; `implementation` is refused), `upsert_implementation` / `list_implementations`, the MCP
  `implementation_upsert` / `implementation_list`, the metrics, the workbook (an `implementations` list, a sheet row
  per record headed `implementation_id`) and the tasks filed under one all address a record by its id. Under `"one"`
  every record's id is its account id, so nothing a person or the model reads changes and `implementations[]` is
  refused. Existing rows were given their account id by `drizzle/0044`, so a deployment that switches to `"many"`
  keeps them and adds more.
- **Choices** are ordered `{ value, label?, tone?, attention?, retired? }`: the value is what is stored, the label what
  a person reads, the tone its colour (slate, sky, blue, green, amber, orange, red, violet, muted).
- **A lifecycle** names a `pick_list` field whose choices are the states, and maps every state to one of six
  CATEGORIES: backlog, open, active, blocked, done, cancelled. Base code branches on the category, never on a pack's
  value. `transitions` list the moves (with `roles`, `requires`, `requires_comment`, `not_by`, `set`); `enforce` says
  what a move outside them does: `"off"` (the default: it goes through), `"warn"` (it goes through and is noted), or
  `"strict"` (refused). A pack's first lifecycle should be `"warn"`. A lifecycle on another field replaces the one
  before it whole. The tasks area's lifecycle is the `status` column (its six values are the contract with the
  task-workflow service, so each keeps its meaning) or an own `pick_list`; then the status follows the state's
  category on every write (open→`open`, active→`in_progress`, done→`done`, …) and nobody sets it directly. A lifecycle
  may name a workflow it runs (`workflow`, each move's `step`, `workflow_states`): see `records.workflows` below.
- **Lifecycle rules, enforced** (`agent/lib/record-lifecycle.ts`, the one rule book every door applies through
  `validateRecordWrite`: the ops API, the agent's upsert tools, MCP through the API). A move is allowed by a
  transition whose `from` holds the stored state (`"*"`: any) and whose `to` is the new one, when the caller's role is
  in its `roles`, every field in `requires` is set once the move (and its stamps) are applied, a comment is given when
  `requires_comment` (a task's `reason`), and the caller is not `not_by`: a person field (its stored or new value), or
  `"{entered_by}"`, whoever moved the record into the state it leaves, so a second person signs off. It is read from
  the activity feed's move line; with none (a record moved before its lifecycle was enforced), it falls back, failing
  closed, to the last person the feed shows changing the record, else to its creator. Only a record with neither (no
  person in its feed, no creator's email) refuses nobody. The state asked about is the one the move starts from: the
  stored state under whichever key the record holds it (`renamed_from`), a legacy spelling read as the state it stands
  for (`legacy_values`), and a move line naming either spelling counts. A stored record whose entrant was never looked
  up is refused, never let through. `set` stamps values with the move:
  `{me}`, `{today}`, `{today+Nd}`, `{now}` or a value. A record created in a state other than `initial` is a move from
  nothing, allowed only by a `"*"` transition. With no transitions every move is allowed.
  - `"off"` (the default): nothing is read, stamped or written; a write is what it was before lifecycles were enforced.
  - `"warn"`: the move goes through with its stamps; the activity feed gets the move (`State moved "A" → "B" (label):
    comment [field: a → b]`) and a line naming the broken rule (`Lifecycle rule not followed (roles): …`).
    Before moving a deployment from `"warn"` to `"strict"`, read those lines back with
    `npm run operator:lifecycle-warnings -- --since <ISO date> [--until <ISO date>] [--org <id>] [--json]`
    (`agent/lib/lifecycle-warnings.ts`): per workspace, each warned move (time, record, from → to, rule, actor,
    comment), counted by rule, area and actor, beside every lifecycle move of the window and the share that warned.
    Read-only: each transaction is `READ ONLY` before its first read; it runs as the application role, each workspace
    in its own row-level-security scope, and refuses a role that bypasses it.
  - `"strict"`: refused. The ops API answers **409** with `{ error, errors, code: "lifecycle_refused", field, from, to,
    broken: [{ rule, message, transition }], allowed: [{ to, label, action, roles, requires, requires_comment }] }`;
    the agent's tool throws the same sentence (`… From "Under review" you can move to: "Complied" (Mark complied),
    "In progress" (Ask for more evidence; needs a comment).`), and MCP reads it from the 409. Allowed moves are noted
    in the feed as under warn.
  Definitions change only through the build. A workspace's task **stage pipelines** keep working under any lifecycle:
  a stage stores the status of its CATEGORY (its own `category`, else the state its label names, else today's six
  status names), and a move to a stage is checked as the move to that state. **Periods** keep the same rules on
  `PATCH /api/ops/cycles/:id` (a comment as `reason`, only when the lifecycle is enforced); an enforced periods
  lifecycle also starts a new period in its `initial` state and files it under the signed-in person (four eyes may
  fall back to the creator). Other areas' routes call
  `lib/record-lifecycle-server.ts` (`lifecycleContext`, `lifecycleConflictResponse`, `recordLifecycleOutcome`).
  A task write's answer is `{ item, warnings?, next? }` (`WriteExtras` in `agent/lib/record-lifecycle.ts`): `warnings`
  (`WriteWarning[]`: code `lifecycle_rule_broken`, the sentence as `message`, the rules and moves) only for a move that
  broke a rule under `"warn"`, for the UI to show; `next` when the write created a next occurrence. The model reads the
  lifecycle as its moves (`describeMoves`: from each state, where it may go and what each move needs), never as one
  line of states.
- **Recurrence** (tasks): a task whose definition has `recurrence` (`field`, `every` per value, `anchor`, `copy`;
  `on: "done"`) that moves into a state of the done category gets its next occurrence, server-side in the write path
  (the ops API and the agent's `upsert_todo`): the `copy` fields, the initial state, due one interval after the anchor
  (a month end stays in its month), linked back by `custom.recurs_from`. Once per task, at the database: a unique
  index on `(org_id, recurs_from)`, a column Postgres generates from `custom->>'recurs_from'` (`drizzle/0042`; no
  area's own field may be called `recurs_from`), lets one in, so a repeated move or two completions at the same
  moment make one; the loser's 409 is taken as done. A value with no interval does not recur. No email.
- **Permissions** (every area; `agent/lib/record-permissions.ts`): `create`, `update`, `delete` are `"*"` (anyone in
  the workspace) or a list of roles (`owner`, `admin`, `engineer`, `member`); `own: { field, may }` lets the person a
  person field names also `update`, `delete` or `transition` (move the lifecycle's state alone; a task's `done` and
  pipeline stage are moves) THAT record ("own row": a member changes only their own); `fields: { key: { update } }`
  says who may set one field, on create as on change (a lifecycle move's own stamps are not the caller's change).
  `read` is only `"*"` for now (the build refuses a list: nothing would hide the row). Enforced on every write and
  delete path: the ops routes (deployments, implementations, todos, cycles and a cycle's rollover, which is an
  update), `upsert_customer`'s nested rows (a `remove: true` is a delete), the agent's `upsert_<area>`, `upsert_todo`,
  `hide_todo` (an archive is a delete) and `upsert_cycle`, and MCP through the routes. A refusal is a **403** with one
  sentence as `error` (`Only an owner or an admin can delete a regulatory filing.`, `You can change a programme only
  when you are its owner; an owner or an admin can change any.`) and changes nothing; the agent's tools throw it. A
  role the caller has none of fails closed; `"*"` still allows. The screens offer only what the role may do (no
  "Add", no delete in the "…" menu, read-only fields and disabled moves), reading the role from
  `/api/ops/me/workspaces` only when the area declares permissions. An area that declares none (every default)
  reads nothing more and answers byte for byte as before.
- **Metrics** (deployments, implementations; `agent/lib/record-metrics.ts`): `count: { where }`, `ratio: { num, den }`
  (the share of `den` that also meets `num`, as a percent) and `sum: { field, where }`, each condition the list
  query's own (`?where=`: fields, operators, `category`, computed fields, `{today±Nd}`), counted in one SELECT in the
  caller's workspace by `GET /api/ops/record-metrics?area=` and shown above the area's list with `attention`
  flagged when not zero. A condition that cannot be counted shows a dash and says why. Tasks keep counting theirs on
  the Tasks view.
- **Relations, views, reminders, recurrence, agent, io, period, targets** are declared and
  checked here at build; the surfaces that act on them (forms and boards per area, reminders)
  arrive one area at a time, and until then a declaration changes nothing at runtime. Email reminders are refused
  (off in this release).

**The legacy forms** (`domains.<area>`, `work_periods`) are lowered into the areas at build: `label`, `description`,
`id_label` → `label`, `description`, `id`; `fields.<k>` → that column's field; `options` → its choices; `kind_field` +
`kinds` → that column as a `pick_list`; `custom_fields[]` → own fields in their order (`show_in_list` kept);
`create_fields` / `detail_fields` → `views.create` / `views.detail` with `append: true`; `group_by` / `group_label` →
`relations.group`; `work_periods` → `label` + `period`. A profile may state an area in either form, **never both** (in
one file or across files). An area written in the record-area form is raised back to the legacy form for every
reader that still takes it, so `DEPLOYMENT_PROFILE.domains` and `.work_periods` stay complete; an own field of a type
the legacy form lacks (file, multi_pick, …) is on the area's own screens, routes and tools (below) but not yet in the
readers that take the legacy form (the workbook, the export), and the build says so.

**Deployments and implementations drawn from their definition.** When a profile file states `deployments` or
`implementations` in the record-area form, the compiled area carries `declared: true`, and that area's surfaces are
drawn from it; any other profile (the default, a legacy `domains.<area>`) keeps today's screens, routes and model
surface byte for byte (`npm run test:record-area-panels` holds the default's and both live packs' surfaces to
upstream main's):

- **The screen** (`app/_components/ops/record-area-panel.tsx`, from `lib/record-area-ui.ts`): the nav word, the
  table's `views.table.columns` (`account`, `title` and any field key), the board on `views.board.by` (its choices in
  order, with their tones) and its card (`title`, `meta`, `badge`), the timeline or calendar date, `views.available` /
  `views.default`, the sorts, the filters (a choice field's choices; a date's `presets`; `scope: "people"` as mine /
  unassigned), `views.group_by`, the detail's `sections`, the lifecycle's moves as buttons, and the create form
  (`views.create.fields`, else every field a new record must carry), checked by the API's own validator before it is
  sent. Own fields of every type are on the forms and the detail; a computed field is shown, never edited.
- **The ops routes** (`lib/record-area-routes.ts`): every write is checked by the one validator
  (`agent/lib/record-area-write.ts`; aliases and choice labels are taken, hidden `fixed` values, defaults, `{me}` (the
  signed-in person) and the lifecycle's `initial` are filled; a refusal is a 400 with every sentence in `errors`), own
  fields are merged per key in SQL, and each change goes to the activity feed in the definition's labels. A list row
  carries `title` (the `title` template) and `values` (every visible field by key, computed ones evaluated).
- **The list query**, on any profile: `GET /api/ops/<area>?where=<json>&sort=<field>|-<field>&q=<words>&limit=&cursor=`
  is filtered, sorted and paged in the database (`agent/lib/record-query.ts`). `where` maps a field key (or `account`)
  to a value or to `{ eq, ne, in, not_in, lt, lte, gt, gte, set, contains, category }`; only the definition's visible,
  keys are taken, every value is bound; own fields are matched with `custom @> …` (a GIN index on each area's `custom`,
  drizzle/0043) and compared as text or as numbers. A **computed** field is filtered and sorted too, compiled to one SQL
  `CASE` that means what the screen shows: numbers compare as numbers, date fields by their day, `{today}` /
  `{today±Nd}` is the day the query runs, `{field}` another field, `category` the lifecycle's states. One that reads a
  list field (multi-pick, tags, several people or files) is refused in a sentence naming that field. Without any of
  these parameters the list is today's.
- **The agent** (`agent/lib/record-area-tools.ts`): `upsert_customer`'s nested rows go through the same validator (a
  list own field takes a list) and, under an enforced lifecycle, read the writer's workspace role and who entered the
  stored state and write each move to the activity feed, as the routes do (`agent/lib/record-area-store.ts`), and `agent.tools.read` / `agent.tools.write` turn on `list_<area>` / `upsert_<area>`,
  named in the area's words at the vocabulary boundary (`list_coverage_reports`) and described from the definition.
  Both are off unless the definition says so.

A legacy route still puts every write it accepts through the same validator (`checkOnly`), with today's column types
and today's sentences for own fields, so nothing it accepted before is refused.

**Periods drawn from their definition** (`agent/lib/period-area.ts`). When a profile file states `periods` in the
record-area form (`records.areas.periods`, never beside `work_periods`), the compiled area carries `declared: true` and
a period becomes a full record area, for a bounded container such as a "Regulatory filing" (the obligations due
together for one regulator and one period). Any other profile (the default, a legacy `work_periods`, both live packs'
fixtures) keeps today's periods byte for byte (`npm run test:period-area`):

- **Own fields**, stored in `cycles.custom` (jsonb, `drizzle/0045_cycles_custom.sql`, a GIN index over the column as
  0043's), checked by the one validator and merged per key in SQL at write time, so a key someone else wrote in
  between, or the profile no longer declares, is kept.
- **Its own states.** The lifecycle is on the `state` column (the build refuses another field); its choices replace
  today's three and each has a category. Stored values are never rewritten: keep `planning`, `active`, `closed` for
  the rows you have and add your own. What the system does is read by **category**: a new period starts in the
  `initial` state; auto rollover closes an ended period (one whose state is not done or cancelled) in the done state
  a declared transition out of its state leads to, else the first done one; the period that has begun moves from a
  not-started (open, backlog) state into the first active one; under an enforced lifecycle the system's moves are lines
  in the feed by `system`.
- **The routes** (`app/api/ops/cycles`): `POST` and `PATCH` take any of the period's fields (columns by key, own fields
  under `custom`) and a move to any declared state, through `agent/lib/period-area-store.ts` (`writeDeclaredPeriod`):
  who may (permissions), types and choices, required fields, the lifecycle (warn / strict, four eyes, a comment as
  `reason` when the lifecycle is enforced), 400 / 403 / 404 / 409 with the sentences, every changed field a line in
  the feed by its label. Items carry `custom`; under any other profile they carry none, as before.
- **The model's tools.** `upsert_cycle` takes `state` (the declared states), the period's other columns (`goal`,
  `lead`, `capacity`, by their labels) and its own fields under `custom` (their choices as enums), and `reason` when a
  move needs a comment; `list_cycles` returns each period's state, fields and `custom` (with `contains` when the
  period contains tasks) and filters by `state`. Their descriptions carry the area's card (its states and moves, its own
  fields, its `agent.describe` and rules) in the profile's words. Mode `individual` keeps its tools and gains `state`,
  `custom` and `reason`.
- **The screen** (`app/_components/ops/period-area-panel.tsx`, from `app/_components/ops/period-area-model.ts`; mode
  team): the nav word, `views.available` (table, board on `views.board.by`, timeline, and a month **calendar** on
  `views.calendar.date`), the table's columns, the board's columns and tones, the card, sorts, filters (a choice's
  choices, a date's presets, `scope: "people"` as mine / unassigned), the metrics, the detail's `sections` (fields, and
  `related: "tasks" | "activity" | "comments"`), the lifecycle's moves as buttons (a comment asked for where a
  transition needs one), and the create form checked by the API's own validator first. The tasks a period contains
  (`relations.contains`) are listed under it with how many are done, by their own states' categories.

**Compiled** into `agent/lib/record-areas.generated.ts` (`RECORD_AREAS`, its own module: `DEPLOYMENT_PROFILE` is
byte for byte what it was for any profile that does not use the record-area form). Each area carries
`redefined`: whether this deployment says anything about it the default does not. Read it through
`agent/lib/record-areas.ts` (`areaView(id)`: words, ordered fields, `get(row, key)`, choices and how a value is shown,
the lifecycle's categories and moves, the board, table, sorts and create form; `describeArea(id)`: a short card for the
model, null for an area that is not redefined). Every write goes through `agent/lib/record-validate.ts`
(`validateRecordWrite`): types, choices, limits, required and defaults, computed and system fields never written, own
fields as a per-key delta, the lifecycle's category, status and move.

**Build-time checks** (`scripts/schemas/record-area.schema.json`, then `scripts/lib/record-areas.mjs`), each failing
the build with `profiles/<file>: records.areas.<area>.<path>: <reason>`: an area other than the four; both forms for
one area; an unknown key or a wrong type; an own key that is not snake_case or shadows a column; a type a column
cannot hold; a column's choices outside its stored values; a choice listed twice or two choices with one label; two
fields with one label; a hidden required field without `fixed`; a `fixed` or `default` the field would not take; a
file folder that is not `{folder:<domain>}/…`; a computed field that reads itself; more than 60 own fields or 6
indexed ones; a lifecycle on a field that is not a pick_list, a state without a category, no `done` state, an
`initial` or transition state that does not exist, `requires`/`set`/`not_by` naming a field the area lacks or of the
wrong type (`not_by` may also be `"{entered_by}"`), a `"strict"` lifecycle with a state nothing reaches, the task status given another meaning; a view, sort,
filter, group, detail or create field that does not exist or is hidden; a sort on a type that cannot sort; a create
form that leaves out a required field with no default; a container that cannot hold tasks; `relations.contains` on
an area other than periods or naming an area a period cannot contain; a target `scope` its period cannot count; a
`structure` (fixed by the table); an email reminder; `agent.describe` over 1200 characters; a lifecycle's `workflow`,
`step` or `workflow_states` that does not fit the workflow it names (`records.workflows` below).

### `records.workflows`

**Workflows** (phase 2 of the workflow engine, `docs/WORKFLOW_ENGINE.md`): a profile or a pack supplies workflow
documents in the vendored engine's DSL (its `init` + `diff` shape, `lib/workflow-engine/dsl/spec.json`) and binds a
record area's lifecycle to one. The build checks them (below); the documents a lifecycle names are emitted on their own
(`lib/record-workflows.generated.ts`) and run on the record's moves under an enforced lifecycle (`warn` or `strict`;
phase 5, docs/WORKFLOW_ENGINE.md "Runtime"): a move's `step` goes through the step's own rules (who holds it, whether it
is open, the workflow's step transitions, its comment and evidence), refused under `strict` like any lifecycle rule,
noted and made as an administrative change under `warn`, never run under `off`. A profile that declares none builds and
writes byte for byte as before.

```jsonc
"records": {
  "workflows": {
    "two-person-review": { "init": { "start_id": "prepare", "steps": [ { "id": "prepare", … }, { "id": "review", … } ], … },
                           "diff": [ … ] }                        // the engine's DSL, as scripts/fixtures/workflows/ holds it
  },
  "areas": { "deployments": {
    "fields": { "review_state": { "type": "pick_list", "label": "Review state",
                                  "options": [ { "value": "drafting" }, { "value": "in_review" }, { "value": "approved" }, { "value": "sent_back" } ] } },
    "lifecycle": {
      "field": "review_state", "initial": "drafting", "enforce": "warn",
      "categories": { "drafting": "open", "in_review": "active", "approved": "done", "sent_back": "open" },
      "workflow": "two-person-review",                                       // the workflow this lifecycle runs
      "transitions": [
        { "from": ["drafting", "sent_back"], "to": "in_review", "step": { "id": "prepare", "state": "completed" } },
        { "from": ["in_review"], "to": "approved", "not_by": "{entered_by}", "step": { "id": "review", "state": "completed" } },
        { "from": ["in_review"], "to": "sent_back", "requires_comment": true, "step": { "id": "review", "state": "rejected" } }
      ],
      "workflow_states": {                                                   // where a record already mid-lifecycle stands
        "drafting":  { "prepare": "open" },
        "in_review": { "prepare": "completed", "review": "open" },
        "approved":  { "prepare": "completed", "review": "completed" },
        "sent_back": { "prepare": "open", "review": "rejected" }
      }
    }
  } }
}
```

| Key | What it is |
|---|---|
| `records.workflows.<id>` | A workflow document. The id is lowercase letters and digits, words joined by `-` or `_`, starting with a letter, at most 64 characters. A later file's document with the same id replaces the earlier one **whole** (a workflow is one document; its steps and rules never merge). A workflow no area runs is still checked. |
| `lifecycle.workflow` | The id of the workflow this area's lifecycle runs. |
| `lifecycle.transitions[i].step` | `{ "id": "<step id>", "state": "<step state>" }`: making this move changes that step of the workflow to that state (one of the engine's step states: `open`, `completed`, `rejected`, `escalated`). A move without `step` changes no step. |
| `lifecycle.workflow_states` | `{ "<record state>": { "<step id>": "<step state>" } }`: for a record that is already mid-lifecycle when its workflow is attached (lazily, the first time it moves), the state of each step for each record state. Keyed by the lifecycle's states as the field's choices spell them, never by a stored legacy spelling (`legacy_values`). A state or step left out is not set. The same map brings the steps along when the record moves by a move that names no step (a board drag, a done toggle, a move outside the transitions under `warn`), or without the engine. |
| `lifecycle.workflow_due` | `{ "<step id>": { "field": "<date field>", "days": <whole days> } }`: the step's due date anchored to a date of the record (a `date` or `datetime` field of the area; `days` after it, before it when negative, 0 by default, at most 3650 either way). A `date` field's day ends at 23:59:59.999 UTC, so a step due on the record's date is not overdue during that day. The date is set when the instance is attached and again whenever the record's date changes (an edit that moves nothing included); in between, the step's own date stands (a rule's date on re-entry, a holder's extension, an administrator's correction). A finished step keeps its date. A record with no such date leaves the step's date as the workflow sets it. Adding the key (or changing `days`) realigns every open step it names once, on its next read, over any earlier correction. A period's rollover does not move an anchored date by itself; the next read does. |

**Build-time checks** (`scripts/lib/record-workflows.mjs`, called by `scripts/gen-deployment-profile.mjs` before any
area is checked), each failing the build with `profiles/<file>: records.workflows.<id>.<path>: <reason>` (the file that
last states the workflow) or `profiles/<file>: records.areas.<area>.lifecycle….: <reason>`:

- the id, and a document that is not an object;
- **the engine's `spec.json`** (Draft 2020-12, through Ajv, a devDependency loaded only when a profile declares a
  workflow): `records.workflows.w.init.steps[0]: must have required property 'title'`;
- **the engine's validator** (`validateWorkflow`, `dsl/validate.ts`): cross-step references, rule priorities, supported
  query operators, guards (`records.workflows.w.init.start_id: start_id "nope" is not a step id`);
- **what the app cannot run**: a `prompt` branch (`$or.prompt` choosing a holder or deciding whether evidence or a
  comment is needed, a rule's `applicability_query.prompt`, an `internal.set.<property>.prompt`, an email's
  `recipients.$or.prompt`, `subject.prompt` or `body.prompt`: `….prompt: a "prompt" branch is resolved by a model, which
  this app does not run; give the deterministic branch instead ("query", or "value")`), even beside a `query` or a
  `value` the engine would prefer; and an email's `attachments` (generated or searched for). **Email and agent actions
  themselves run** (docs/WORKFLOW_ENGINE.md "Step actions"): an email becomes the app's own notification to the step's
  holders and the people its `recipients` query names, in the action's own `subject` and `body`; an agent run becomes a
  task for the assistant (its `name`, its `prompt` as the instructions). Nothing sends an email;
- **the binding**: `lifecycle.workflow` naming a workflow the profile does not declare (the declared ones are listed);
  a transition's `step` or `workflow_states` on a lifecycle with no `workflow`; a step id that is not one of the
  workflow's steps (they are listed); a step state that is not one of the engine's; a `workflow_states` key that is not
  a state of the lifecycle's field, or is a legacy spelling of one (`"draft" is a stored legacy spelling of
  "drafting"; key workflow_states by the state itself, "drafting"`). A step's `id` and `state` are both required
  (the schema, `scripts/schemas/record-area.schema.json`). A `workflow_due` on a lifecycle with no `workflow`, naming a
  step the workflow does not have, anchored to a field that is not a date of the area (`"review_state" is a pick_list
  field; a due date is anchored to a date or datetime field ("target_date")`), or `days` that are not whole or further
  than 3650.

The compiled area carries the binding as written (`RecordLifecycle.workflow`, `.workflow_states`, `.workflow_due`,
`RecordTransition.step` in `agent/lib/record-areas.generated.ts`), read by the write path (lib/record-workflow-moves.ts).
A bound area's ops routes take the move's `evidence` beside its `reason`. Held by `npm run test:record-areas-workflows`,
`npm run test:record-workflow-runtime` and `npm run test:record-workflow-runtime-db`.

### `records.hub`

**The record hub**: the one screen that holds the record areas (the Ops Center's `todos` section, with its tasks,
periods and the two account areas' views). Its name is its own, separate from the tasks area's word: the default
calls the screen "TODOs" and a task "task"; a compliance deployment may call the screen "Obligations Register" and a
task "obligation".

```jsonc
"records": { "hub": { "label": "Obligations Register", "icon": "scale" } }
```

| Key | What it is |
|---|---|
| `label` | The screen's name as a person reads it: the sidebar's Ops Center item, the screen's title (the dialog's name), the Control Panel's ownership section in a person's dossier. One line, at most 40 characters, no `{` `}` `<` `>`. Default `"TODOs"`. |
| `icon` | One of `circle-check`, `list-todo`, `list-checks`, `clipboard-list`, `clipboard-check`, `scale`, `shield-check`, `landmark`, `book-open`, `folder-kanban`, `calendar-check`, `file-check`: the nav item's and the Control Panel section's glyph. `null` (the default) keeps today's: a circle-check on the nav, a list on the section. |

- **Counts of its entries** ("Owns 2 TODOs on this account", the dossier's summary line, a ticket's "Related todos",
  the account briefing's totals) keep today's "TODO" while neither the hub nor the tasks area is renamed, and take the
  tasks area's word otherwise ("2 tasks", "2 obligations").
- **What stays**: the deep-link key (`/?ops=todos`, `&view=<tab>`), the section key `todos`, every route, tool and
  stored name. They are contracts.
- **The model**: under a renamed hub the per-turn briefing says what people call the screen and that its entries are
  what `list_todos` reads and `upsert_todo` writes (verbatim under a relabelling profile); the roster tools'
  descriptions name its scope filters by the hub's name. Under the default nothing the model reads changes.
- **Build-time checks** (`agent/lib/record-hub.ts`), each failing the build with `profiles/<file>: records.hub.<key>:
  <reason>`: an unknown key, an empty, multi-line, padded or over-long name, a name holding `{ } < >`, a glyph outside
  the list.
- Compiled into `RECORD_HUB` in `lib/deployment-profile.generated.ts` (`DEPLOYMENT_PROFILE` itself is unchanged);
  the UI reads it through `useRecordHub()` (`app/_components/ops/record-hub.tsx`). Held by `npm run test:record-hub`
  and `tests/record-hub.spec.ts`.

### Choosing the area for a domain concept

The four area ids are the base product's software words. What decides where a domain concept goes is the area's
**structure**: what one record of it is, what it holds or points at, how it behaves in time, and which built-in
columns carry which role. The structure is fixed by the table (`STRUCTURE` in `scripts/lib/record-areas.mjs`, compiled
into `RECORD_AREA_STRUCTURE` in `agent/lib/record-areas.generated.ts`); a profile names the area and declares the
relations it uses, and a profile that states `structure` is refused.

| Area | Role | One record is | Holds / points at | Time | Columns by role |
|---|---|---|---|---|---|
| `tasks` | unit | a unit of work: one thing a person owns, does and finishes | sits in a period (`cycleId`), may be filed under a deployment or an implementation (`containerType` + `containerId`) | instant: falls due on a day | state `status` (or an own pick list), owner `assignee`, due `dueAt` |
| `periods` | container | a bounded container: a window holding units of work due together, measured by them | **contains** tasks (`relations.contains`) | window: starts and ends | state `state`, owner `lead`, start `startsAt`, due `endsAt`, `goal`, `capacity` |
| `deployments` | change | a change rolled out to a target (an account, or a place within it), with a release state and health | **targets** an account; groups the tasks filed under it | instant: rolled out at a moment, then watched | target the account, state `releaseStatus`, health `healthStatus`, owner `deployOwnerEmail`, when `lastDeployAt` |
| `implementations` | programme | a long-running programme or framework run for one account | **targets** an account; **groups** tasks filed under it | ongoing: moves through stages for months | target the account, state `implementationStage`, owner `implementationOwnerEmail`, due `targetGoLiveDate`, health `implementationRiskLevel`, `implementationProgressPct` |

Ask, in this order, of the concept:

1. **Is it one piece of work someone owns and closes, with its own due date?** It is a task.
2. **Is it a set of such pieces that fall due together, complete when they are?** It is a period that contains them
   (`relations.contains: { "area": "tasks" }`), even when people call it a document: a regulatory filing is the set of
   obligations due in it.
3. **Is it a change put into effect for one account, whose release and health are watched afterwards?** It is a
   deployment.
4. **Is it a standing programme or framework one account adopts and works through in stages, for months, with work
   filed under it?** It is an implementation.

A record that **falls due** is never a deployment: a deployment happens, it is not due. A concept with no owner of its
own and no states, only a name the others share, is usually a field (a pick list) and not an area at all.

**Worked mappings.**

| Domain | `tasks` | `periods` | `deployments` | `implementations` |
|---|---|---|---|---|
| Compliance (ComplianceOS) | obligation | regulatory filing (contains its obligations) | change-management initiative | compliance framework |
| Equity research | research task (a model update, a channel check) | results season (contains the updates due in it) | report published on a company | coverage of a company (grouped into portfolios) |
| Software delivery | ticket | iteration (contains the tickets planned into it) | release to a customer environment | customer implementation |
| Sales | follow-up (a call, a proposal to send) | quarter (contains the commitments due in it) | order put into effect for an account | account plan |

ComplianceOS in full is [`scripts/fixtures/record-areas/examples/compliance-os.json`](../scripts/fixtures/record-areas/examples/compliance-os.json).
Its period, the part a mapping most often gets wrong:

```jsonc
"periods": {
  "label": { "singular": "regulatory filing", "plural": "regulatory filings" },
  "fields": { "name": { "label": "Filing" }, "endsAt": { "label": "Filing due" }, "lead": { "label": "Signatory" } },
  "relations": { "contains": { "area": "tasks" } },              // a filing IS its obligations, and they complete it
  "targets": [ { "key": "obligations_closed", "label": "Obligations closed",
                 "measure": { "area": "tasks", "where": { "state": { "category": "done" } } } } ]   // scope "contained"
}
```

**`relations.contains`** (periods only): `area` is `tasks` (the records that carry a period's id), `completion`
(default `true`) says the period is complete when every one of them (cancelled ones aside) is done. A target that
measures the contained area with no `date` counts the records filed into the period (`measure.scope: "contained"`,
compiled); one with a `date` counts those dated inside the window (`"window"`). Refused: `contains` on another area,
an area other than tasks, tasks switched off or never filed into a period (`relations.periods: false`), periods off,
`scope: "contained"` on an area the period does not contain, `scope: "window"` without a `date`.

**What each reader sees.**

- **The build** prints, whenever a profile redefines any area, each area's role beside the label the profile gives it,
  so a wrong mapping is visible before anything ships:

  ```
  gen-deployment-profile: note: the record areas, by what each IS:
    deployments [change], shown as "Change-management initiatives": a change rolled out to a target (…)
    implementations [programme], shown as "Compliance frameworks": a long-running programme or framework (…)
    tasks [unit], shown as "obligations": a unit of work: one thing a person owns, does and finishes, (…)
    periods [container], shown as "regulatory filings": a bounded container: (…); contains "obligations", measured by them
  ```

  and warns, conservatively, only where the definition's own shape contradicts the area: a deployments area with an
  own date it falls due on (a key or label saying "due"), or one that hides both its release state and its health.
  A warning never fails the build.
- **The model** reads one sentence per area, in the profile's words, on the area's card in its briefing and in its
  tools' descriptions (`describeStructure` in `agent/lib/record-areas.ts`): "Regulatory filings: each groups
  obligations due together in one window ("Period from", `startsAt` to "Filing due", `endsAt`) and is complete when they
  are all done; …". `list_cycles` then returns, per period, `contains: { total, done }`.
- **A coding agent** over MCP reads the same sentence on that area's tools (`task_list`, `task_create`, `sprint_list`,
  `sprint_create`, `deployment_*`, `implementation_*`), passed by `app/api/mcp/route.ts` as `structure`.

Only an area the profile defines in the record-area form says it: a redefined task, a period that declares
`contains`, a deployments or implementations area stated under `records.areas`. The default profile and a legacy
form read byte for byte what they did (`npm run test:record-structure`).

## Merge rules

1. **Filename order.** Every `profiles/NN-<name>.json` (two digits, then lower-case
   letters, digits and hyphens) is read in filename order. `00-default.json` must exist
   and is first; later files win.
2. **Objects merge deeply.** A file states only what it changes:
   `{ "vocabulary": { "account": { "singular": "company", "plural": "companies" } } }`
   leaves `vocabulary.member` alone.
3. **Arrays and scalars replace.** `chat.hero_lines` and `dataroom.seed` are taken whole
   from the last file that sets them; lists are never concatenated.
4. **Unknown keys are rejected.** A key that `00-default.json` does not have fails the
   build with the file and the key's path: it is a typo, not an extension. (The
   optional keys are `label` and `description` on a data-room domain.) `$comment` is ignored anywhere.
5. **Domains can be relabelled or hidden, not added.** A key under `dataroom.domains`
   that is not one of the seven domains fails the build. A new domain is a change to the
   data model (`dm.md`, the path templates, the workbook), not to a profile.
6. **The `accounts` domain cannot be hidden.** Every record hangs off it. Relabel it instead.
7. **`domains` is checked against the source.** The generator reads the field keys and enum values out of
   `agent/lib/customer-schema.ts` and `agent/lib/db/schema.ts`, so these fail the build with the path and the
   reason: an unknown field key (`domains.deployments.fields.releaseStatuss: unknown field key`), an `options` key
   that is not a value of that enum, `options` on a field that is not an enum, two values sharing one display
   label, `hidden` on a required field without `fixed`, a `fixed` value the field would not accept, `fixed` on a
   field that is not hidden, a `kind_field` / `group_by` that is not a free-text column, a hidden or list-valued
   key in `create_fields` / `detail_fields`, and any key a field entry does not take.
8. The build also rejects: an empty `chat.hero_lines`, an empty vocabulary word, a
   malformed `dataroom.seed` entry, and an `agent.briefing` over 400 words.
9. **`records.areas` takes the four built-in areas only**, each in one form (record-area or legacy) across every
   file. Inside an area, what may be said is the record-area schema's (not the default's keys): `fields` is a map,
   so a later file adds or changes one field; a `lifecycle` naming another `field` replaces the one before it whole.
10. **`records.workflows` is a map of workflow ids**, each a whole document: a later file's workflow with the same id
   replaces the earlier one, never merged into it.

A bad profile **fails the build, never the page**: the generator exits non-zero with
`profiles/<file>: <path>: <what is wrong>`.

Conventional numbering:

| File | Who writes it |
|---|---|
| `00-default.json` | the base app. Never edited by a deployment. |
| `NN-pack-<id>.json` (10 to 79) | a subagent pack, for its vertical |
| `90-brand.json` | a branding step: the product's name and tagline |

## What a profile deliberately does NOT change

Identifiers **in storage and on the wire to other programs**. Code, stored data, the API, the MCP
server and the coding-agent CLI key on these, and a deployment that renamed them would stop being able
to read its own data or take an upstream update. (What the eve agent's MODEL reads is translated at the
tool boundary instead: see "How the agent sees it" below.)

- **The data-room tree below each folder, and the path tokens**: `{customer_id}`, `{person_id}`, `Master.xlsx`,
  and every entry of `DATAROOM_PATH_TEMPLATES` after its first segment. (The first segment, the folder's own name,
  IS the profile's: `dataroom.domains.<id>.folder`. A label never moves it: a domain labelled "Companies" is still
  stored under its `folder`.)
- **Workbook column names**: `customer_id`, `customer_name`, `account_owner`… They are data, and the agent reads them
  by name. (A domain's main sheet carries the domain's stored folder name.)
- **Database tables and fields**, and the JSON keys of every API payload.
- **API routes** (`/api/ops/*`, `/api/dataroom`…).
- **Tool, skill and subagent names, as code and the MCP server know them**: `list_customers`,
  `get_customer`, `onboard-customer`, `onboard-self`… (the eve agent's model is given the
  relabelled names; the base names keep working for every other caller)
- **The session issuer and audience**: `"delivered"` / `"delivered-app"`
  (`lib/auth-session.ts`; pinned by `scripts/check-gates.mjs`). Renaming the product does
  not re-issue anybody's session.
- **Package and CLI names**: `@delivery-agents/cli`, `workspace-login`, `workspace-mcp` (and the old names they replaced, still accepted),
  invite tokens' `dlv_inv_` prefix, the `delivered-setup` skill. (The name a coding agent
  files the server under is NOT fixed any more: the instructions people see say
  `claude mcp add --transport http <slug of product.name> <this deployment>/api/mcp`, built
  by `lib/mcp-connect.ts` — see `docs/MCP.md`.)
- **Icon and colours**: `app/icon.svg` and `app/globals.css` are a branding step's
  concern, not the profile's.
- **Memory scopes in storage**: a relabelled deployment's model writes `company:{id}`; it is
  stored as the `customer` kind (the `memory_scope` column is a Postgres enum) and read back
  as `company:{id}`, and older `customer:{id}` rows read as the same scope.

## How the agent sees it

Under the default profile: the root prompt is rendered at eve build time by `agent/instructions.ts` from
`agent/prompt-core.md` and `agent/prompt-persona.md`, with its role and record placeholders filled with the
default profile's neutral words; every tool is the same object, with the same name, parameters and results (only
its description's placeholders are filled, in place); `check:agent-vocabulary` holds the whole default surface to
a snapshot.

Under a profile that **relabels** (the account, the member, either record area or a data-room folder
has a word of its own), the model reads only the profile's words, everywhere
(`agent/lib/agent-vocabulary.ts`, translating at the boundary so storage never moves):

| What the model reads | Base | Relabelled (the research-desk profile) |
|---|---|---|
| tool names | `list_customers`, `get_customer`, `upsert_customer`, `list_members`, `read_customer_slas` | `list_companies`, `get_company`, `upsert_company`, `list_analysts`, `read_company_slas` |
| parameters and result keys | `customerId`, `customer_id`, `deployments[].deploymentId`, `implementation.rolloutId` (`accountOwner` is neutral and stays as it is) | `companyId`, `company_id`, `coverageReports[].coverageReportId`, `portfolioEntry.portfolioId` |
| enum values | `Waiting on Customer`, `customer-vpc`, TODO `containerType` `deployment` | `Waiting on Company`, `company-vpc`, `coverageReport` |
| data-room paths (in and out) | the stored folders: `Accounts/acme/…`, `Deliveries/…`, `Projects/…` (or the names a deployment pins) | `Companies/acme/…`, `Coverage-reports/…`, `Portfolios/…` (the label as a folder name) |
| memory scopes | `customer:{id}` | `company:{id}` |
| descriptions, prompts, the per-turn block | "{account}" (filled: "account"), "{owner}" (filled: "account owner"), "{deployment}" (filled: "delivery") | "company", "covering analyst", "coverage report" |

**Record placeholders.** The RECORD words are written the same way. Base text never spells the account, the two
record areas or the group of the second: it writes `{account}`, `{deployment}`, `{implementation}` and `{rollout}`,
each with its plural (`{accounts}`) and its capitalised forms (`{Account}`, `{Accounts}`), and the same boundaries
fill them from the profile under every profile:

| Placeholder | Filled from | Default profile | The research-desk profile |
|---|---|---|---|
| `{account}` / `{accounts}` | `vocabulary.account` | account / accounts | company / companies |
| `{deployment}` / `{deployments}` | `domains.deployments.label` | delivery / deliveries | coverage report / coverage reports |
| `{implementation}` / `{implementations}` | `domains.implementations.label` | project / projects | portfolio entry / portfolio entries |
| `{rollout}` / `{rollouts}` | `domains.implementations.group_label` | plan / plans | portfolio / portfolios |

**Folder placeholders.** A data-room folder is written the same way, because its name is the profile's too:

| Placeholder | Filled with | Default profile | A profile that pins `Customers` and labels it "Companies" |
|---|---|---|---|
| `{folder:accounts}` (and `platform`, `deliveries`, `solutions`, `projects`, `tickets`, `people`, `uploads`) | the folder its reader addresses, at the head of a path: `{folder:accounts}/{customer_id}/context.md` | `Accounts/…` | the model reads `Companies/…` (and what it sends back is stored under `Customers/…`); a script, a seeded file and `dm.md` get the stored `Customers/…` |
| `{domain:accounts}` (…) | the domain in a sentence: its label | Accounts | Companies |

In code, a path is `` `${FOLDER.accounts}/${id}/context.md` `` and a pattern is `pathPattern("accounts", "[^/]+/context\\.md")`
(`agent/lib/dataroom-folders.ts`); a JSON fixture writes the placeholder and is read through
`scripts/lib/read-fixture.mjs`; a subagent's `dataroomPaths` template may start with `{folder:<id>}`.

In a prompt, a tool description, a library workflow's step or the base skill, write the placeholder; `speak()` /
`fill()` fill it (`modelFacing` fills a tool's description in place; a parameter description is written
`.describe(fill("…"))`; a message a tool builds takes one word with `wordFor("account")`). In the UI, take the
word from `W` in `lib/ui-words.ts` (`W.account`, `W.Deployments`, …), which has every key above. In the operator
tooling, `W` from `scripts/operator/lib/words.mjs`. The base skill (`skills/*/SKILL.md`) is filled when it is
mirrored into a package: from `profiles/00-default.json` for the generic one, from the deployment's profiles for
its own (`scripts/lib/profile-words.mjs`).

The default profile's words are neutral ones, and the identifiers are not: `customer_id`, `list_customers`,
`deploymentId`, `implementation`, `rolloutId` are contracts and never move with a profile. Under the
default profile they reach the model exactly as stored, and the per-turn block ties the two together in four short
lines ("A **delivery** is a `deployment` in the identifiers: …"). A profile whose words ARE the identifiers' own
(`scripts/fixtures/legacy-record-words/50-legacy-record-words.json`, the words the default carried before) gets no
such lines and is not "relabelled". Any other word relabels: the identifiers, paths and stored text that carry the
stored word are translated to the profile's at the boundary, as before.

Two gates hold it. `check:agent-vocabulary` fails when the default deployment's model reads a record word as prose
anywhere (prompts, tools, roster, briefing, the workflow library, tool results), when a placeholder reaches a model
unfilled, or when a relabelling profile's own words are missing from what its model reads. `check:neutral-names`
counts every record word written as prose in base text (string literals, template and JSX text, Markdown, the
default profile's values; never an identifier, a path, a code span or a quoted value) and holds each file to a
ceiling in `scripts/neutral-names.allow.json` (`record_words`): a file with no ceiling may carry none, and
`node scripts/check-neutral-names.mjs --records --lines` lists what is left.

**Role placeholders.** The ROLE words, the member and the account owner, are not translated: base text never spells
them. It writes a placeholder (`{member}`, `{members}`, `{Member}`, `{Members}`, `{owner}`, `{Owner}`), and every
boundary that hands base text to the model or a person fills it from the profile, under every profile, the default
included: `speak()` / `fill()` in `agent/lib/agent-vocabulary.ts` (tool descriptions in `modelFacing`, prompts,
the provisioned workflow library, a workflow step's prompt, the generated subagent roster) and `W.member` /
`W.owner` in `lib/ui-words.ts` for the UI. `a {member}` becomes "a member" or "an analyst": the article follows the
word. `check:agent-vocabulary` fails when a placeholder reaches the model unfilled, or when the default deployment's
model reads the member's legacy word as a word.

**The member's legacy word.** Before the default profile spoke neutrally it called the member by an acronym. No
file spells it any more (`check:neutral-names`); `agent/lib/legacy-member.ts` builds it from its letters, once,
for the code that still READS data written under it: the owner keys a workbook, an export or an older client may
still carry (`accountOwner` and `solutionOwner` replaced them, drizzle/0028 and 0037), the old roster tool name in a
stored transcript or workflow, stored enum values a data room may still hold (a ticket's `ownerTeam`, an account's
`valueEvidenceStatus`; drizzle/0037 rewrote the database's to "Member" and "Member Verified") and text older
checkouts wrote. A person reads such a value in the profile's member word (`storedValueLabel` in
`lib/ui-words.ts`; an owner key reads the owner label everywhere, `humanizeKey`), and a relabelling profile
translates the legacy spelling for the model like any base word.

**The rule: the product's words are translated, user data never is — in either direction.** Product words are
tool names, parameter and result keys, the value of a field whose schema declares it an enum, the folder at the
head of a path in a data-room path field, a memory scope's prefix, and the text a tool itself writes to the
model (a top-level `error` / `next`, spoken so that every id, name and quoted value in it stays as it is). Every
other string — record names, notes, reasons, ids, memory values, file contents, a workflow's args values and
its return value, a profile's own custom-field keys and choices, the profile's own labels and briefing — passes
through exactly as written or stored. A sandbox path (publish_artifact's `path`, read_image's `sandboxPath`) is
the model's own scratch space and is never translated: under a relabel the model lays sandbox files out in the
words it was taught (`/workspace/dataroom/Companies/…`), and only a data-room path field is mapped to storage.

How each surface gets there:

- **Tools.** Every tool is exported as `modelFacing("<file slug>", defineTool({...}))`
  (`agent/lib/model-facing/tools/model-facing.ts`). By default that returns the tool itself. Relabelled,
  it returns a tool whose description and JSON Schema are spoken in the profile's words, whose input is
  translated back (parameter names, enum values, a display folder at the head of a path) and validated by
  the base zod schema before the base tool runs, and whose result is translated out (keys, stored enum
  values, paths, memory scopes, the tool's own messages; file content and external pages are left as
  stored). A tool whose name changes is a `defineDynamic` resolver, the only kind eve names by its own key,
  so the base name is never offered to the model. It resolves on every turn (`turn.started`), so a session begun
  before the relabel was deployed still gets it. A free-form `args` object (trigger_workflow) has its keys mapped
  back to the product keys the model was taught (`companyId` → `customerId`), so a library workflow reading
  `args.customerId` runs, and its refusal names keys the way the model wrote them. The CLI, the API and the MCP server never go through
  these objects and keep the base names.
- **The root prompt.** `persona.base: false` replaces the persona with a neutral opening; everything left is
  spoken in the profile's words; excluded specialists leave the roster.
- **Each base specialist's prompt** is its `prompt.md`, spoken by its `instructions.ts`
  (`speakPrompt`), and its `agent.ts` description is wrapped in `speak(...)`. The prompts are compiled into
  `agent/lib/prompts.generated.ts` by `npm run build:prompts` (part of `build:generated`).
- **The per-turn block** (`agent/lib/deployment-briefing.ts`, appended by
  `agent/instructions/runtime-context.ts`) states the deployment's words and fields, written with the base
  identifiers and spoken through the same translation the tools use, so the two cannot disagree. It never
  names a base identifier: the old "the identifiers do not change: `list_customers`, `customer_id`,
  the stored folder refer to companies" taught the model a second vocabulary, and it reasoned in that one.
- **Context blocks** (memory recall, schedules, roster) are translated like tool results: keys and memory scope
  prefixes, never the saved values.
- **The workflow library** a workspace is provisioned with (`agent/lib/workflow-library-view.ts`): workflows that
  delegate to an excluded specialist are not provisioned; the others' descriptions, steps and prompt literals
  are spoken, their code (`args.customerId`, specialist names) is not.
- **The web app** reads a transcript by base names (`baseNameAmong`, `fieldOf`), so the Insights rail and the
  tool labels work with either vocabulary.

The block, for a relabelling profile:

- the account's word and the tools, field and folder that carry it (`list_companies`, `company_id`,
  `Companies/`);
- who the model works for, and the owner's label;
- hidden domains: this workspace does not use them; do not offer, plan or write work under them unless a
  person explicitly asks;
- the data-room folders by name;
- a redefined area (`domains`): what it means here, where it is read and written (`get_company`
  (`coverageReports[]`), `upsert_company`, `Coverage-reports/`, TODO `containerType` `coverageReport`), what a
  group is, which field carries the kinds, the relabelled fields, the enum display words with the values the
  model's tools use ("Published" is `deployed`), its own fields, and the unused fields (up to eight
  named, then the rule);
- then `agent.briefing`.

A profile that only hides domains or redefines fields without renaming anything keeps the base identifiers,
and its block still says so ("Identifiers stay: read with `get_customer` …"). For the default profile the
function returns **`null`** and nothing is appended.

What the translation does not reach, by design: the contents of stored files (a `.jsonl` row keeps the keys
it was written with; `dataroom_read` returns it as stored), pages from the web, remote MCP tools' answers, and
a kept specialist's NAME (the model delegates by directory name: exclude a base specialist whose name carries
a relabelled word; the generator warns about one). A pack's own prompts, skills and sandbox files are the
pack's words: write them in the profile's (see [`SUBAGENT_PACKS.md`](SUBAGENT_PACKS.md)).

## How a subagent pack ships one

A pack ([`SUBAGENT_PACKS.md`](SUBAGENT_PACKS.md)) only adds files, and a profile is one
more added file: **`profiles/NN-pack-<id>.json`**. Applying the pack and running
`npm run build:generated` regenerates the two `deployment-profile.generated.ts` files;
removing the pack deletes its profile and regenerates them back. The pack never touches
`profiles/00-default.json`.

Keep a pack's profile about its *vertical* (vocabulary, domains, seed, hero lines,
briefing) and leave `product.name` to the branding step, so one pack can be sold under
several names.

## How a branding step sets the product name

Write one file, `profiles/90-brand.json`, and regenerate:

```json
{ "product": { "name": "Meridian", "tagline": "The research desk for listed-company coverage." } }
```

```bash
npm run build:deployment-profile
```

`90-` sorts after any pack's profile, so the brand wins. Because the default description,
the first hero line and every other string use `{product}`, setting `product.name` alone
renames the product everywhere a person reads it. No source file contains the display
name any more, so a rebrand is never a search-and-replace over `app/` and `lib/`. (The
icon and the colour tokens are still files: `app/icon.svg`, `app/globals.css`.)

## Worked example: an equity-research deployment

Analysts cover listed companies. Accounts are **companies**, members are **analysts**,
the accounts domain is shown as "Companies", the five delivery domains are hidden, and
a new workspace starts with a tree that explains `filings/`, `lodr/` and `presentations/`.

`profiles/50-pack-equity-research.json`:

```json
{
  "$comment": "Equity-research deployment: analysts covering listed companies. Words and visibility only; every identifier (customer_id, list_customers, Accounts/) stays as it is.",
  "product": {
    "tagline": "The research desk for listed-company coverage.",
    "description": "{product} — the research workspace: an agent that reads filings, exchange disclosures and investor presentations for the companies your analysts cover."
  },
  "vocabulary": {
    "account": { "singular": "company", "plural": "companies" },
    "member": { "singular": "analyst", "plural": "analysts" },
    "owner": "Lead analyst",
    "account_context": "Company context"
  },
  "chat": {
    "hero_lines": ["{product}", "Which company are we reading today?", "Summarise the latest filing", "Compare this quarter's deck with the last", "Keep every company's file current"],
    "empty_sections": { "urgent": "Open questions", "stalled": "Companies gone quiet" },
    "account_search": {
      "title": "Company context",
      "description": "Pick the companies this conversation is about — the agent grounds itself in their filings and notes.",
      "placeholder": "Search companies…",
      "empty": "No companies found.",
      "pill_empty": "Set the company context for this chat"
    }
  },
  "dataroom": {
    "root_label": "Research Room",
    "domains": {
      "accounts": { "label": "Companies", "description": "One folder per covered company: filings, exchange disclosures, investor presentations." },
      "platform": { "visible": false },
      "deliveries": { "visible": false },
      "solutions": { "visible": false },
      "projects": { "visible": false },
      "tickets": { "visible": false },
      "people": { "label": "Contacts" }
    },
    "seed": [
      {
        "path": "README.md",
        "content": "# {workspace} — research room\n\nEverything {product} and the analysts know about a covered company lives here as plain files.\n\nThe folder shown as **Companies** is `Accounts/` on disk, and a company's id is its `customer_id`. Those names are fixed; only the labels differ.\n\nWorkspace id: `{org_id}`\n"
      },
      {
        "path": "Accounts/README.md",
        "content": "# Companies\n\nOne subtree per covered company, keyed by `customer_id` (use the exchange ticker, lower-case).\n\n    Accounts/{customer_id}/context.md        the coverage note the agent reads first\n    Accounts/{customer_id}/filings/          annual reports, quarterly results, offer documents\n    Accounts/{customer_id}/lodr/             exchange disclosures under the listing regulations (LODR)\n    Accounts/{customer_id}/presentations/    investor decks and earnings-call transcripts\n\nFile documents under the period they report on, for example `filings/FY25-Q4-results.pdf`.\n"
      },
      {
        "path": "People/README.md",
        "content": "# Contacts\n\nExternal people only: investor-relations officers, management, company secretaries. One subtree per person, keyed by `person_id`. Analysts are not recorded here.\n"
      }
    ]
  },
  "agent": {
    "briefing": "This workspace is an equity-research desk. Each company's documents sit under Accounts/{customer_id}/ in three folders: filings/ (annual and quarterly reports), lodr/ (exchange disclosures), presentations/ (investor decks and call transcripts). Cite the document and page for every figure you state, and say which reporting period it belongs to. Never give investment advice or a price target."
  }
}
```

```bash
npm run build:deployment-profile
# deployment profile: 00-default.json + 50-pack-equity-research.json -> product "Delivered", companies, 2/7 data-room domains visible
```

What that changes: the data-room browser is titled "Research Room" and shows two
folders, "Companies" and "Contacts" (plus Uploads); `Accounts_Master.xlsx` reads
"Companies Master"; the picker says "Search companies…"; a new workspace gets the three
files above with its own name and id filled in; and on every turn the model is told that
a customer is a company, that five domains are out of use, that `Accounts/` is shown as
"Companies", followed by the briefing.

What it does not change: the folder is still `Accounts/`, the id is still `customer_id`,
the tool is still `list_customers`, and the product is still called "Delivered" until a
`90-brand.json` says otherwise.

## Worked example: redefining the two delivery areas (equity research)

The example above *hides* the delivery domains. A research desk can instead **reuse** them, because the shape
fits: a named set of covered companies with a build-out per company is an implementation, and a report published
for a company for a period is a deployment. The ready file is
[`docs/examples/profile-equity-research.json`](examples/profile-equity-research.json) (it is an example: the base
app ships only `profiles/00-default.json`; a pack copies it to `profiles/NN-pack-<id>.json`).

**Implementations become "Portfolios".** The table stays `implementation`, one row per company. A portfolio is the
set of rows sharing a `rolloutId` slug (`affordable-housing`, `large-hfcs`): `group_by: "rolloutId"`,
`group_label: Portfolio / Portfolios`, and a row is a "Portfolio entry".

| Field | Shown as | Values shown as |
|---|---|---|
| `rolloutId` | Portfolio | the slug, title-cased |
| `implementationOwnerEmail` | Analyst | |
| `implementationStage` | Build-out stage | Kickoff="Not started", Discovery="Sources identified", Configuration="Filings ingested", Integration="Presentations ingested", UAT="KPI table built", Pilot="Under review", Go-Live="Published", Stabilization="First update done", Steady State="Steady coverage", On Hold="On hold" |
| `implementationProgressPct` | Progress % | |
| `implementationRiskLevel` | Risk | Green / Yellow / Red (the schema's values; the default form's low/medium/high/critical list is replaced) |
| `dataReadinessPct` | Filings completeness | |
| `integrationReadinessPct` | Presentations & concalls completeness | |
| `dataQualityStatus` | Validation | |
| `evalAcceptanceStatus` | Reviewer sign-off | |
| `uatStatus` | Analyst check | |
| `currentMilestone`, `currentMilestoneDueDate` | Current milestone, Milestone due | |
| `blocker`, `blockerOwner` | Blocker, Blocker owner | Provider="Us", Customer="Company", Third-Party Vendor="Exchange / third party" |
| `targetGoLiveDate`, `actualGoLiveDate` | Coverage initiation (target), (actual) | |

Hidden: security and privacy review, billing readiness and start, entitlements, runbook, support hand-off,
launch window, connector provisioning, integration tests, training, launch decision, governance and the two
approvers, and the launch-scope solutions (the Solutions domain is hidden).

**Deployments become "Coverage reports".** One row per company per report.

| Field | Shown as | Values shown as |
|---|---|---|
| `deploymentId` | Report id (`Q2FY26-results`) | |
| `runtime` | Report type | `kind_field`: Initiation, Quarterly results update, Annual report review, Event / rating update, Sector note |
| `deployedVersion` | Period / basis ("Q2 FY26 · standalone · unaudited") | |
| `releaseStatus` | Status | deployed="Published", in-progress="In progress", pending-approval="Awaiting review", rolled-back="Restated", failed="Failed" |
| `healthStatus` | Data quality | healthy="Complete", degraded="Partial (values carried forward)", down="Missing", unknown="Unknown" |
| `lastDeployAt` | Results date | |
| `approvedByEmail` | Reviewer | |
| `deployOwnerEmail` | Analyst | |
| `notes` | What changed / needs review | |
| `liveUrl` | Published report link | |

Hidden, with the value the forms submit: `region` = `"ap-south-1"`, `environment` = `"prod"` (both are required
enums). Hidden: cloud provider, deployment strategy, build sha, model routing, the uptime / error / latency /
token / cost / capacity metrics, the rollback fields, incidents, dashboard and runbook links.

**Why `runtime` carries the report type.** No migration was wanted, so the type needs an existing free-text
column. `releaseChannel` is the nearest in meaning but is an enum, so it cannot hold new values. `releaseId` and
`configVersion` are identifiers/versions: one value repeated across forty rows reads as "the same release" to
anything that joins or de-duplicates on them. `notes` is wanted for prose. `runtime` is the one free-text column
whose meaning is already "what kind of thing this is" (a category that repeats across rows by design), nothing in
the code keys on it, and the research desk has no other use for it. It is therefore relabelled, not hidden.

**Fields the base never had.** The example also declares `custom_fields` (see [Custom fields](#custom-fields)).
A coverage report gets `rating` (a required pick list: Buy / Add / Hold / Reduce / Sell), `target_price` (number),
`data_completeness` (percent), `publish_date` (date), `source_link` (link) and `thesis` (long text); the first
three are columns of the list. A portfolio entry gets `benchmark` (text, a column) and `next_rebalance` (date).
None of them is a column of the base, and none needed a migration beyond the one `custom` column. The report's
*period* stays on `deployedVersion` ("Period / basis"): it is required, every report has one, and the built-in
column already sorts and composes the row's title.

**One company, one portfolio.** (`org_id`, `customer_id`) is the table's primary key, so a company has one
row per workspace and is in one portfolio at a time; "New portfolio entry" for a company that already has a row moves it.
A company in two portfolios needs a composite key, which is a change to the data model, not to a profile.

**Two companies, one report id.** A deployment's key is (customer, id), so `Q2FY26-results` can exist for every
company. The list keys such rows on customer + id and sends the real id to the API.

## How a person sees it

The same words the model reads, in everything the web UI and the ops API show a person. Under the default
profile every one of them is the base word it replaced, so the default deployment reads byte for byte what it
did before (`check:ui-vocabulary` pins each word).

| Where | How it takes the profile's words |
|---|---|
| sentences, labels, placeholders, table headers, empty states, toasts, ops API errors | `W.*` from `lib/ui-words.ts`: `` `${W.Deployment} not found` ``, `` `Pick ${an(W.account)} ${W.account}.` ``, `` `not configured on this ${W.install}` `` |
| the subagent roster (cockpit rail, workspace Agents tab): names, summaries, descriptions, tool names and descriptions | spoken at generation (`scripts/gen-subagent-meta.mjs` → `scripts/lib/speak-subagent-meta.mjs`) with the same `speak()` / `speakIdentifier()` the model's copy goes through, so the panel shows `list_analysts` and "List the analyst roster…", exactly what the model is given |
| the workflow library | never shipped to the browser: `GET /api/ops/workflows` says in one sentence why the library is smaller (`libraryNote`); a stored base library row that needs an excluded specialist is listed as "not in this workspace", its text in the profile's words, and can be opened and adopted (edit it to use this workspace's specialists) |
| a workflow a person edited that still delegates to an excluded specialist | a count ("needs 2 specialists"), never the directory names |
| an enum VALUE a person sees (`customer-vpc`, `customer_cloud`, blockerOwner `Customer`) | the profile's option label; without one, the value with the record word in the profile's word, under every profile (`account-vpc`, `Account` under the default profile; `company-vpc` as the model is told it under a relabelling one). The stored value is what is submitted |
| JSON a person views or copies (a record's Copy as JSON / Markdown export, the data-room JSON and JSONL viewers), an ops API error's field path | keys through `lib/ui-keys.ts` (`jsonForPeople`, `lib/ops-errors.ts`); values verbatim |
| a stored key a person reads (a data-room sheet's column header, a Markdown export's field) | `lib/ui-keys.ts`: `customer_id` → `company_id` (the model's spelling); the owner key humanises to `vocabulary.owner` |
| a data-room domain | its `dataroom.domains.<Domain>.label`, also in path-shaped placeholders and sheet tabs |
| specialists the profile excludes | not listed anywhere: not in the roster, not in a starter workflow, not in a connector's "without it, … lose" line |
| a product key made into a LABEL (a Markdown export's `**Account Id:**`, a table preview's column header) | `keyLabel` / `headerLabel` in `lib/ui-keys.ts`: the record word in the label is the profile's under every profile, the default included. A key shown as a key keeps its stored name unless the profile relabels it; a header that is not key-shaped is the file's own text |
| a record kind a person copies (`containerType`, `linkType`, an export's `type`) | the profile's word for the record, under every profile (`speakValue`) |
| a specialist's display name in the roster, when its `subagent.json` gives none | the title-cased directory name, a record's stored name in it written as that record's placeholder (`customer-context` → "{Account} Context" → "Account Context"; `scripts/gen-subagent-meta.mjs`) |
| the published account report's title and sub line | the profile's account word (`reportWords`): "Account report", "Company report" |
| what the seeders write (the sample data room, the connector and workflow rows, their console reports) | `W.*` and `domainLabel(...)`, as the UI; `npm run seed:dataroom-blob -- --print` and `node scripts/seed-ops.mjs --print` show it without a store or a database |

What is NOT translated, and why, is the allow-list `scripts/fixtures/ui-vocabulary/allow.json`: keys, routes,
storage keys and stored values a person never reads, each with its reason. User data (names, notes, a
workflow a person wrote) is never translated.

**No sentence spells a record word, stored or default.** `customer`, `deployment`, `implementation` and `rollout`
are what storage calls the records (columns, API keys, routes, folders, enum values); `account`, `delivery`,
`project` and `plan` are what the DEFAULT profile calls them, and a pack calls them something else. A sentence
takes the word from the profile either way. The record-word audit (`scripts/lib/record-literals.mjs`, run by
`npm run test:ui-vocabulary`) reads every string literal, template piece and JSX text of `app/`, `components/`,
`lib/`, the report renderer and the seeders, whatever its shape and wherever it goes (an audit event, a prompt
handed to `speak()`, a console line):

- a stored name as prose fails unless `scripts/fixtures/ui-vocabulary/record-literals.allow.json` says why (SQL, a
  specialist's directory name), and a bare token must be a listed contract;
- a default-profile word in a sentence, or alone as a label ("Accounts"), fails unless that list says why it is
  ordinary English there: a person's sign-in account, plan mode, a code project, a message's delivery, a third
  party's own noun.

`node scripts/lib/record-literals.mjs --list` prints them all. What a person still reads in a stored name under
the default profile is two kinds of identifier, on purpose: a key shown as a key (a sheet's `customer_id` column),
and the identifiers inside a tool's description in the roster. A data-room domain is no longer one of them: its
folder, its `Master.xlsx` and its sheet take their name from the profile (`FOLDER.<id>`), the default profile's are
neutral, and a deployment that pins a former name shows it only where it gives no label of its own.

## Checks

```bash
npm run build:deployment-profile   # merge + validate + write both generated files
npm run test:deployment-profile    # merge rules, domains (defaults exact, example validates, bad profiles fail), the briefing; offline
npm run check:agent-vocabulary     # the model-facing surface under a relabelling fixture has no base word and carries the profile's; the default's is unchanged and reads no record word as prose; under the folder pin it is byte for byte what it was before folder names were a setting
npm run check:neutral-names        # the role word only as a listed contract; the record words as prose only under a per-file ceiling; no data-room folder name spelled in base code; no workflow or recipe library in base code; a work period's default word only in the default profile, one legacy definition and the listed contracts
npm run test:workflow-library      # the default profile provisions no library; the opt-in builds exactly the former built-ins; bad sources are refused; the cleanup's rules; offline
npm run test:dataroom-folders      # the folder names are the profile's; a pinned deployment's stored paths, object keys, starter tree and seeders are byte for byte what they were; an unpinned one is refused
npm run check:dataroom-folders     # the store this build is configured for holds no former folder its profile does not use (run by prebuild and prebuild:eve)
npm run check:ui-vocabulary        # what a PERSON reads (source text, the built client bundle, prerendered pages) under the same fixture has no base word; the default's words are unchanged
npm run check:vocabulary           # its static half, in seconds (no build)
npm run test:ui-vocabulary         # keys in JSON and exports, ops API errors, library rows, unlabelled enum values, the generator during a build; the record words (labels, kinds, the README, the seeders) under the default, the relabelled and a neutral-records profile; the record-word audit
npm run test:agent-vocabulary      # what the model writes in the profile's words lands in unchanged storage; specialists.exclude moves and restores
npm run test:custom-fields         # the custom-field validator, the agent's write path, the MCP inputs, the migration; offline
npm run test:record-hub            # records.hub: the default compiles to today's hub and the model's words are unchanged; a named hub and a redefined tasks area each keep their own word; every bad hub fails with its path; offline
npx playwright test tests/record-hub.spec.ts     # the nav, the screen's title and the Control Panel's section under "Obligations Register", and the default unchanged
npm run test:record-areas          # records.areas: an old profile emits exactly what it did (goldens from before record areas), the legacy forms lowered, the worked examples compile, every bad-profile class fails with its path, the view model and the write validator; offline
npm run test:record-areas-workflows # records.workflows: no binding without one, the phase-1 fixtures this phase runs compile, a bound lifecycle compiles, every refusal (spec.json, the engine's validator, email/agent actions and prompt branches, the binding) with its exact sentence; offline
npx playwright test tests/domain-forms.spec.ts   # the real "New …" forms, default and example, with the API mocked
npm run test:work-periods          # work_periods: the generator's rules, each mode's views, words, tools and routes (three builds rendered), the default to the letter; offline
npm run test:work-periods-db       # the same three modes against a real Postgres: two workspaces, the routes and the model's tools, rollover, whose an item is
npm run test:dictation             # asr: the route's rules with a fake provider (sign-in, workspace, limits, sections and the session limit, usage, price), the cut into sections, the order, the generator's rules; offline
npm run test:dictation-usage-db    # dictation usage written and reported as app_rw, two workspaces, against a fail-closed Postgres
npx playwright test tests/dictation.spec.ts      # the real button with a fake microphone: hold and release, hands-free, sections in order, typing meanwhile, an unchanged composer height, nothing sent
npm run check:generated            # fails if a generated file is stale
npm run typecheck
```
