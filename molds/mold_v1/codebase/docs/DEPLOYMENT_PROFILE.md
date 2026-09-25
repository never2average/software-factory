# Deployment profile

The product was written for one use: a forward-deployed engineering (FDE) team looking
after customers. A **deployment profile** is how a deployment that is for something else
(an equity-research desk, a claims team, a support desk) says so **without forking the
code or editing a component**.

A profile changes what a person or the model **reads**: the product's name, what a
"customer" and an "FDE" are called, which data-room domains are shown and under what
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

The rule for new UI copy: if a sentence names the product, a customer, an FDE, a deployment, an
implementation, a rollout or a data-room domain, it reads the profile. It never hardcodes the word.
`lib/ui-words.ts` has every one of them ready (`W.account`, `W.Accounts`, `W.owner`, `W.Deployment`,
`W.implementations`, `W.install` for "this deployment", `an(word)`, `domainLabel("Customers")`), and
`lib/ui-keys.ts` shows a stored key in the profile's words (`speakKey`, `humanizeKey`). See
[How a person sees it](#how-a-person-sees-it); `npm run check:ui-vocabulary` enforces it.

## Keys

Every key, what it means, and its default. Strings marked *slots* are passed through
`fillProfileText`.

### `product`

| Key | Meaning | Default |
|---|---|---|
| `product.name` | The display name, everywhere a person sees it: browser title and title template, application name, the sign-in wordmark and copyright line, the onboarding wizard, the invitation and sign-in-code emails (subject, body, the prompt a coding agent is given), the ops-auth "work accounts only" sentence, the roster workbook's author field, the inbox hand-off prompt, and `{product}` in any profile string. Exported as `PRODUCT_NAME`. | `"Delivered"` |
| `product.tagline` | The line under the wordmark on the sign-in screen. *slots: `{product}`* | `"The operations console for forward-deployed teams."` |
| `product.description` | The page's meta description. *slots: `{product}`* | `"{product} — the FDE operations console: an eve-powered agent that runs customer onboarding, deployments, and the data room for the forward-deployed team."` |

### `vocabulary`

| Key | Meaning | Default |
|---|---|---|
| `vocabulary.account.singular` / `.plural` | What the thing every record hangs off is called in prose ("the customer's data room", "Search customers…"). Lower-case; the UI capitalises where it needs to. | `"customer"` / `"customers"` |
| `vocabulary.member.singular` / `.plural` | What a person who works in the console is called. | `"FDE"` / `"FDEs"` |
| `vocabulary.owner` | The label for the member responsible for an account. | `"FDE owner"` |
| `vocabulary.account_context` | The name of the per-chat "which accounts is this about" control. | `"Customer context"` |

### `chat`

| Key | Meaning | Default |
|---|---|---|
| `chat.hero_lines` | The rotating lines on an empty chat. A non-empty list of non-empty strings. *slots: `{product}`* | `["{product}", "What needs doing today?", "Prep the stand-up", "Chase the follow-ups", "Keep every customer close"]` |
| `chat.empty_sections.urgent` / `.stalled` | Headings of the two suggestion groups on an empty chat. | `"Urgent tickets"` / `"Stalled customers"` |
| `chat.user_messages.collapse` | Whether a long message a person sent starts folded, with a "Show more" button. Short messages are never touched and assistant replies never fold. `true` or `false`. | `true` |
| `chat.user_messages.collapsed_lines` | How many lines of a folded message stay visible. A whole number from 2 to 40. A desk that pastes filings and tables wants it small; one that writes three-line prompts can turn `collapse` off. | `6` |
| `chat.starter_cards.owner_label` | Label for the owner on a starter card. | `"FDE owner"` |
| `chat.starter_cards.ticket_waiting` / `.tickets_waiting` | Card summary for one / several open tickets. *slots: `{count}`, `{name}`* | `"One open ticket is waiting on us."` / `"{count} open tickets are waiting on us."` |
| `chat.starter_cards.ticket_badge` / `.tickets_badge` | The card's badge for one / several open tickets. *slots: `{count}`* | `"1 open"` / `"{count} open"` |
| `chat.starter_cards.triage_title` / `.triage_prompt` | The action's title, and the prompt sent when it is clicked. *slots: `{name}`, `{count}`* | `"Triage the open tickets"` / `"Triage the open tickets for {name}: what is blocking each one, who owns it, and what should we do next?"` |
| `chat.starter_cards.quiet_summary` / `.quiet_summary_long` | Card summary for an account with no recent contact (long: over a month). *slots: `{name}`, `{days}`* | `"No contact logged in {days} days."` / `"No contact logged for over a month."` |
| `chat.starter_cards.quiet_badge` | That card's badge. *slots: `{days}`* | `"{days}d quiet"` |
| `chat.starter_cards.quiet_title` / `.quiet_prompt` | The action's title and prompt. *slots: `{name}`, `{days}`* | `"Draft a check-in"` / `"{name} has been quiet for {days} days. Summarise where we left off and draft a check-in to their main contact."` |
| `chat.account_search.title` / `.description` / `.placeholder` / `.empty` | The account picker dialog: its title, its one-line explanation, the search box's placeholder, and the no-results line. | `"Customer context"` / `"Pick the customers this conversation is about — the agent grounds itself in their record."` / `"Search customers…"` / `"No customers found."` |
| `chat.account_search.pill_empty` / `.pill_active` / `.pill_locked` | The tooltip on the context pill with nothing chosen, with a choice, and once the chat has locked it. *slots: `{context}` (= `vocabulary.account_context`), `{names}`* | `"Set the customer context for this chat"` / `"{context}: {names} — click to change"` / `"{context} is locked for this chat: {names}"` |

### `dataroom`

| Key | Meaning | Default |
|---|---|---|
| `dataroom.root_label` | The data-room browser's title (dialog title and title bar) and the tree root's name. | `"Data Room"` |
| `dataroom.domains.<Domain>.label` | What people read for that domain: its tab, its folder in the tree, the breadcrumb on a search hit, and "`<label>` Master" as the display name of its `Master.xlsx`. | the domain's own name |
| `dataroom.domains.<Domain>.visible` | `false` removes the domain from the browser: no tab, no tree node, no "jump to" affordance; live files under it are not listed; a request to open a hidden domain's tab opens the first visible one instead. | `true` |
| `dataroom.domains.<Domain>.description` | Optional. The folder's tooltip in the tree. | none |
| `dataroom.seed` | `null`: a new workspace is seeded with the built-in three-file starter tree (`README.md`, `Customers/README.md`, `People/README.md`; `lib/org-seed.ts`). A list of `{ "path", "content" }`: THOSE files are written instead, all of them, replacing the built-in tree. *slots in `content`: `{workspace}` (the workspace's name), `{org_id}`, `{product}`*. A path is relative, has no `..`, and is `README.md` or starts with a domain name or `Uploads`. The content type follows the extension (`.md`, `.json`, `.jsonl`, `.csv`, otherwise plain text). | `null` |

`<Domain>` is one of `Customers`, `Platform`, `Deployments`, `Solutions`,
`Implementation`, `Tickets`, `People`.

### `domains`

The two software-delivery record areas, **deployments** and **implementations**, can be *redefined* instead of
hidden: given another name, other field labels, other words for their enum values, and a list of fields that are
not used. The rows, columns, API routes, tool names and enum **values** stay exactly as they are; a form still
submits `releaseStatus: "deployed"`, whatever the person read. (Hiding an area is still
`dataroom.domains.<Domain>.visible: false`; a redefined area is normally made visible and given the same label there.)

`<area>` is `deployments` or `implementations`.

| Key | Meaning | Default |
|---|---|---|
| `domains.<area>.label.singular` / `.plural` | What one record and the area are called: the TODOs tab, "New …", "Loading …", "Delete …", the Control Panel's panel and its "owns 3 …" sentence, a task's container type, the sheet's tab in the data room. | `"Deployment"` / `"Deployments"`; `"Implementation"` / `"Implementations"` |
| `domains.<area>.description` | One sentence: what a record IS here. The tab's blurb, and what the model is told the area means. | `"Deployments, filtered by owner."` / `"Rollouts, filtered by owner."` |
| `domains.<area>.id_label` | The label of the record's id (`deploymentId`, `rolloutId`). | `"Deployment id"` / `"Rollout id"` |
| `domains.<area>.fields.<fieldKey>` | One entry per field you want to say something about; see below. `<fieldKey>` is a real field: a key of `deploymentSchema` / `implementationSchema` (`agent/lib/customer-schema.ts`) or a column of the table (`agent/lib/db/schema.ts`). | today's labels for the fields the UI shows |
| `domains.<area>.kind_field` + `.kinds` | A free-text column that carries one of `kinds` (a report type, a release type). Shown as a select of exactly those strings; the string itself is what is stored. An enum column cannot be used: its values are fixed by the schema. | `null` / `[]` |
| `domains.<area>.create_fields` / `.detail_fields` | Extra real columns on the "New …" form / the detail card, after the built-in ones. Typed from the schema: an enum is a select, a percentage or number a number input, anything else text. List-valued columns cannot be put on a form. | `[]` / `[]` |
| `domains.<area>.custom_fields` | The deployment's OWN fields on the area: fields the base never had. See [Custom fields](#custom-fields). | `[]` |
| `domains.implementations.group_by` | A free-text column whose value groups the rows (in practice `rolloutId`). The tab is then titled with `group_label.plural`, the list gets a header per group (name, owner, how many, average progress), "New" picks an existing group or names a new one (stored as a slug: "Affordable housing" is `affordable-housing`), and the row's id becomes the customer id because many rows now share a `rolloutId`. | `null` |
| `domains.implementations.group_label.singular` / `.plural` | What a group is called. | `"Rollout"` / `"Rollouts"` |

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
- the MCP tools `deployment_upsert` / `implementation_upsert` (`setup/fde-tools.mjs`), which go through the Ops
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

### `persona`

| Key | Meaning | Default |
|---|---|---|
| `persona.base` | Keep the base product's persona in the root prompt: the forward-deployed engineering orchestrator, its specialist roster, the customer spreadsheet, the daily stand-up (`agent/prompt-persona.md`). `false` drops it: the root prompt keeps only its neutral rules (`agent/prompt-core.md`, opened by `agent/prompt-neutral.md`), and the pack's `agent/instructions/50-pack-*.md` says who the agent is and what the work is. | `true` |

### `specialists`

| Key | Meaning | Default |
|---|---|---|
| `specialists.exclude` | Base specialists (directory names under `agent/subagents/`) the deployment does not use. They leave the model's roster (eve makes every directory under `agent/subagents/` a tool the model can delegate to, and has no switch to hide one), the persona's roster and every prompt's list of names, the subagent registry, the UI lists and the workflow author's list. Nothing is moved: the directories stay tracked, so a git checkout of a stamped build regenerates the same tree. `scripts/gen-subagent-meta.mjs` leaves them out of the registry; the provisioned workflow library drops any workflow that delegates to one (`agent/lib/workflow-library-view.ts`); and `npm run build:eve` / `dev:eve` run eve through `scripts/eve-build.mjs`, which hides their directories from eve for the length of that one command and restores them however it ends (a run killed mid-build is restored by the next run, or by `node scripts/eve-build.mjs --restore`). Run `eve build` directly and they are back in the roster. A name that is not a subagent fails the build. | `[]` |

### `account_fields`

| Key | Meaning | Default |
|---|---|---|
| `account_fields.hidden` | Fields of the account record itself (the `customerSchema` keys in `agent/lib/customer-schema.ts`: `arr`, `seats`, `aeOwner`, `renewalDate`, `contractStatus`, … and the nested parts `platform`, `solutions`, `tickets`) this deployment does not use. They are removed from what the **model** reads and writes: `upsert_customer`'s parameters, and every record `get_customer`, `list_customers` and `upsert_customer` return; a hidden nested part is also dropped from those tools' descriptions. A hidden key the model sends anyway is not written. Storage, the API, the CLI, the MCP server and the forms are unchanged. `id` and `name` cannot be hidden, nor `custom` (it holds `custom_fields`, below); an unknown key fails the build. | `[]` |
| `account_fields.custom_fields` | The deployment's OWN fields on the account record itself: a research desk's notes on a company, a field team's permit number on a site. Same spec, types and rules as [Custom fields](#custom-fields) on the areas; see [Own fields on the account record](#own-fields-on-the-account-record). | `[]` |

The two redefinable areas hide their own fields with `domains.<area>.fields.<key>.hidden` (above), and the record
tools apply those the same way: a hidden `deployments[]` / `implementation` field WITHOUT a `fixed` value is not a
parameter and is not in a returned record, and when the model rewrites a row (a patch replaces `deployments[]` and
`implementation` wholesale) the stored value of each hidden field it could not see is carried over. A hidden field
WITH a `fixed` value stays a parameter, because the briefing tells the model to write that value.

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
  that says "Customers/acme" or "deployment" is user data, and reaches the model and storage as written.
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
   build with the file and the key's path: it is a typo, not an extension. (The one
   optional key is `description` on a data-room domain.) `$comment` is ignored anywhere.
5. **Domains can be relabelled or hidden, not added.** A key under `dataroom.domains`
   that is not one of the seven domains fails the build. A new domain is a change to the
   data model (`dm.md`, the path templates, the workbook), not to a profile.
6. **`Customers` cannot be hidden.** Every record hangs off it. Relabel it instead.
7. **`domains` is checked against the source.** The generator reads the field keys and enum values out of
   `agent/lib/customer-schema.ts` and `agent/lib/db/schema.ts`, so these fail the build with the path and the
   reason: an unknown field key (`domains.deployments.fields.releaseStatuss: unknown field key`), an `options` key
   that is not a value of that enum, `options` on a field that is not an enum, two values sharing one display
   label, `hidden` on a required field without `fixed`, a `fixed` value the field would not accept, `fixed` on a
   field that is not hidden, a `kind_field` / `group_by` that is not a free-text column, a hidden or list-valued
   key in `create_fields` / `detail_fields`, and any key a field entry does not take.
8. The build also rejects: an empty `chat.hero_lines`, an empty vocabulary word, a
   malformed `dataroom.seed` entry, and an `agent.briefing` over 400 words.

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

- **Data-room folder names and path templates**: `Customers/`, `Platform/`,
  `Deployments/`, `Solutions/`, `Implementation/`, `Tickets/`, `People/`, `Uploads/`,
  `{customer_id}`, `{person_id}`, `Master.xlsx`, and every entry of
  `DATAROOM_PATH_TEMPLATES`. A domain labelled "Companies" is still `Customers/` on disk.
- **Workbook sheet names and column names**: the `Customers` sheet, `customer_id`,
  `customer_name`, `fde_owner`… They are data, and the agent reads them by name.
- **Database tables and fields**, and the JSON keys of every API payload.
- **API routes** (`/api/ops/*`, `/api/dataroom`…).
- **Tool, skill and subagent names, as code and the MCP server know them**: `list_customers`,
  `get_customer`, `onboard-customer`, `onboard-self`… (the eve agent's model is given the
  relabelled names; the base names keep working for every other caller)
- **The session issuer and audience**: `"delivered"` / `"delivered-app"`
  (`lib/auth-session.ts`; pinned by `scripts/check-gates.mjs`). Renaming the product does
  not re-issue anybody's session.
- **Package and CLI names**: `@delivery-agents/cli`, `fde-login`, `fde-mcp`,
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

Under the default profile: exactly as before this existed. The root prompt is rendered at eve build
time by `agent/instructions.ts` from `agent/prompt-core.md` and `agent/prompt-persona.md`, and is the
former `agent/instructions.md` byte for byte; every tool, parameter, description and result is the
same object; `check:agent-vocabulary` holds the whole default surface to a snapshot.

Under a profile that **relabels** (the account, the member, either record area or a data-room folder
has a word of its own), the model reads only the profile's words, everywhere
(`agent/lib/agent-vocabulary.ts`, translating at the boundary so storage never moves):

| What the model reads | Base | Relabelled (the hfc-research profile) |
|---|---|---|
| tool names | `list_customers`, `get_customer`, `upsert_customer`, `list_fdes`, `read_customer_slas` | `list_companies`, `get_company`, `upsert_company`, `list_analysts`, `read_company_slas` |
| parameters and result keys | `customerId`, `customer_id`, `fdeOwner`, `deployments[].deploymentId`, `implementation.rolloutId` | `companyId`, `company_id`, `analystOwner`, `coverageReports[].coverageReportId`, `portfolioEntry.portfolioId` |
| enum values | `Waiting on Customer`, `customer-vpc`, TODO `containerType` `deployment` | `Waiting on Company`, `company-vpc`, `coverageReport` |
| data-room paths (in and out) | `Customers/acme/…`, `Deployments/…`, `Implementation/…` | `Companies/acme/…`, `Coverage-reports/…`, `Portfolios/…` (the label as a folder name) |
| memory scopes | `customer:{id}` | `company:{id}` |
| descriptions, prompts, the per-turn block | "customer", "FDE owner", "deployment" | "company", "covering analyst", "coverage report" |

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
  `Customers/` refer to companies" taught the model a second vocabulary, and it reasoned in that one.
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

Analysts cover listed companies. "Customers" are **companies**, "FDEs" are **analysts**,
the `Customers/` domain is shown as "Companies", the five delivery domains are hidden, and
a new workspace starts with a tree that explains `filings/`, `lodr/` and `presentations/`.

`profiles/50-pack-equity-research.json`:

```json
{
  "$comment": "Equity-research deployment: analysts covering listed companies. Words and visibility only; every identifier (customer_id, list_customers, Customers/) stays as it is.",
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
      "Customers": { "label": "Companies", "description": "One folder per covered company: filings, exchange disclosures, investor presentations." },
      "Platform": { "visible": false },
      "Deployments": { "visible": false },
      "Solutions": { "visible": false },
      "Implementation": { "visible": false },
      "Tickets": { "visible": false },
      "People": { "label": "Contacts" }
    },
    "seed": [
      {
        "path": "README.md",
        "content": "# {workspace} — research room\n\nEverything {product} and the analysts know about a covered company lives here as plain files.\n\nThe folder shown as **Companies** is `Customers/` on disk, and a company's id is its `customer_id`. Those names are fixed; only the labels differ.\n\nWorkspace id: `{org_id}`\n"
      },
      {
        "path": "Customers/README.md",
        "content": "# Companies\n\nOne subtree per covered company, keyed by `customer_id` (use the exchange ticker, lower-case).\n\n    Customers/{customer_id}/context.md        the coverage note the agent reads first\n    Customers/{customer_id}/filings/          annual reports, quarterly results, offer documents\n    Customers/{customer_id}/lodr/             exchange disclosures under the listing regulations (LODR)\n    Customers/{customer_id}/presentations/    investor decks and earnings-call transcripts\n\nFile documents under the period they report on, for example `filings/FY25-Q4-results.pdf`.\n"
      },
      {
        "path": "People/README.md",
        "content": "# Contacts\n\nExternal people only: investor-relations officers, management, company secretaries. One subtree per person, keyed by `person_id`. Analysts are not recorded here.\n"
      }
    ]
  },
  "agent": {
    "briefing": "This workspace is an equity-research desk. Each company's documents sit under Customers/{customer_id}/ in three folders: filings/ (annual and quarterly reports), lodr/ (exchange disclosures), presentations/ (investor decks and call transcripts). Cite the document and page for every figure you state, and say which reporting period it belongs to. Never give investment advice or a price target."
  }
}
```

```bash
npm run build:deployment-profile
# deployment profile: 00-default.json + 50-pack-equity-research.json -> product "Delivered", companies, 2/7 data-room domains visible
```

What that changes: the data-room browser is titled "Research Room" and shows two
folders, "Companies" and "Contacts" (plus Uploads); `Customers_Master.xlsx` reads
"Companies Master"; the picker says "Search companies…"; a new workspace gets the three
files above with its own name and id filled in; and on every turn the model is told that
a customer is a company, that five domains are out of use, that `Customers/` is shown as
"Companies", followed by the briefing.

What it does not change: the folder is still `Customers/`, the id is still `customer_id`,
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

**One company, one portfolio.** `implementation.customer_id` is the table's primary key, so a company has one
row and is in one portfolio at a time; "New portfolio entry" for a company that already has a row moves it.
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
| an enum VALUE a person sees (`customer-vpc`, `customer_cloud`, blockerOwner `Customer`) | the profile's option label; without one, the value as the model is told it (`company-vpc`) |
| JSON a person views or copies (a record's Copy as JSON / Markdown export, the data-room JSON and JSONL viewers), an ops API error's field path | keys through `lib/ui-keys.ts` (`jsonForPeople`, `lib/ops-errors.ts`); values verbatim |
| a stored key a person reads (a data-room sheet's column header, a Markdown export's field) | `lib/ui-keys.ts`: `customer_id` → `company_id` (the model's spelling); the owner key humanises to `vocabulary.owner` |
| a data-room domain | its `dataroom.domains.<Domain>.label`, also in path-shaped placeholders and sheet tabs |
| specialists the profile excludes | not listed anywhere: not in the roster, not in a starter workflow, not in a connector's "without it, … lose" line |

What is NOT translated, and why, is the allow-list `scripts/fixtures/ui-vocabulary/allow.json`: keys, routes,
storage keys and stored values a person never reads, each with its reason. User data (names, notes, a
workflow a person wrote) is never translated.

## Checks

```bash
npm run build:deployment-profile   # merge + validate + write both generated files
npm run test:deployment-profile    # merge rules, domains (defaults exact, example validates, bad profiles fail), the briefing; offline
npm run check:agent-vocabulary     # the model-facing surface under a relabelling fixture has no base word; the default's is unchanged
npm run check:ui-vocabulary        # what a PERSON reads (source text, the built client bundle, prerendered pages) under the same fixture has no base word; the default's words are unchanged
npm run check:vocabulary           # its static half, in seconds (no build)
npm run test:ui-vocabulary         # keys in JSON and exports, ops API errors, library rows, unlabelled enum values, the generator during a build
npm run test:agent-vocabulary      # what the model writes in the profile's words lands in unchanged storage; specialists.exclude moves and restores
npm run test:custom-fields         # the custom-field validator, the agent's write path, the MCP inputs, the migration; offline
npx playwright test tests/domain-forms.spec.ts   # the real "New …" forms, default and example, with the API mocked
npm run check:generated            # fails if a generated file is stale
npm run typecheck
```
