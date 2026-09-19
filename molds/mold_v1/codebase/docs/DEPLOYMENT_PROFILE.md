# Deployment profile

The product was written for one use: a forward-deployed engineering (FDE) team looking
after customers. A **deployment profile** is how a deployment that is for something else
(an equity-research desk, a claims team, a support desk) says so **without forking the
code or editing a component**.

A profile changes what a person or the model **reads**: the product's name, what a
"customer" and an "FDE" are called, which data-room domains are shown and under what
label, the files a new workspace starts with, the chat's opening lines, and a short
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

The rule for new UI copy: if a sentence names the product, a customer, an FDE or a
data-room domain, it reads the profile. It never hardcodes the word.

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

### `agent`

| Key | Meaning | Default |
|---|---|---|
| `agent.briefing` | Free text the model receives on every turn, inside the "This deployment" block (below). At most 400 words: it is paid for on every turn. | `null` |

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
7. The build also rejects: an empty `chat.hero_lines`, an empty vocabulary word, a
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

Identifiers. Code, stored data, other systems and the model's tools key on these, and a
deployment that renamed them would stop being able to read its own data or take an
upstream update:

- **Data-room folder names and path templates**: `Customers/`, `Platform/`,
  `Deployments/`, `Solutions/`, `Implementation/`, `Tickets/`, `People/`, `Uploads/`,
  `{customer_id}`, `{person_id}`, `Master.xlsx`, and every entry of
  `DATAROOM_PATH_TEMPLATES`. A domain labelled "Companies" is still `Customers/` on disk.
- **Workbook sheet names and column names**: the `Customers` sheet, `customer_id`,
  `customer_name`, `fde_owner`… They are data, and the agent reads them by name.
- **Database tables and fields**, and the JSON keys of every API payload.
- **API routes** (`/api/ops/*`, `/api/dataroom`…).
- **Tool, skill and subagent names**: `list_customers`, `get_customer`,
  `onboard-customer`, `onboard-self`…
- **The session issuer and audience**: `"delivered"` / `"delivered-app"`
  (`lib/auth-session.ts`; pinned by `scripts/check-gates.mjs`). Renaming the product does
  not re-issue anybody's session.
- **Package and CLI names**: `@delivery-agents/cli`, `fde-login`, `fde-mcp`,
  `claude mcp add fde`, invite tokens' `dlv_inv_` prefix, the `delivered-setup` skill.
- **Icon and colours**: `app/icon.svg` and `app/globals.css` are a branding step's
  concern, not the profile's.
- **The static system prompt** (`agent/instructions.md`, `agent/instructions/*`). It is
  cached and shared; the profile speaks to the model through the per-turn block below.

## How the agent sees it

`agent/lib/deployment-briefing.ts` renders the profile as a short **"## This
deployment"** block, and `agent/instructions/runtime-context.ts` appends it on every turn
**after** the stable prompt, so the cached prompt is identical for every deployment.

The block states vocabulary as a *reading rule*, because the identifiers do not move:

- if `vocabulary.account` is not "customer": a "customer" is called a **company**; say
  "company" to people; `list_customers`, `customer_id` and `Customers/` all refer to
  companies;
- if `vocabulary.member` is not "FDE": who the model works for, and how to read "FDE" and
  "FDE owner" in its instructions;
- hidden domains: this deployment does not use them; do not offer, plan or write work
  under them unless a person explicitly asks;
- relabelled domains: what people see each folder called, and that paths keep the real
  name;
- then `agent.briefing`, verbatim.

For the default profile the function returns **`null`** and nothing is appended: the
default deployment's prompt is exactly what it was.

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

## Checks

```bash
npm run build:deployment-profile   # merge + validate + write both generated files
npm run test:deployment-profile    # merge rules and the briefing, offline
npm run check:generated            # fails if a generated file is stale
npm run typecheck
```
