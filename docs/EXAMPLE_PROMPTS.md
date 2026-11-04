# Example prompts

What to ask the factory's agent, in plain words. The first part is five whole apps you can copy and ship; the second
is smaller requests that each worked end to end.

## Shippable apps

Each example is a folder under [`examples/`](../examples/): the **prompt** a person writes, the **spec** the agent
produced from it (for comparison; you do not write it), the app's **pack**, a **logo** and a README with the exact
commands. Paste the prompt to your agent, or mint the spec directly:
`python3 .claude/scripts/mint.py new <app> --spec examples/<mold>/<example>/spec.json`, then `mint.py <app> run`.

| Example | Mold | Kind | What it shows | Folder |
|---|---|---|---|---|
| Wrenchline, a field-service maintenance tracker | mold_v0 | tool | Typed record areas with lifecycles; priority-driven respond and fix-by clocks that remind, pause and escalate; emailed requests becoming work orders; a visit-report agent and a scheduled preventive plan; the data trail | [field-service](../examples/mold_v0/field-service/) |
| Panelwise, a hiring pipeline | mold_v0 | tool | Candidates with documents and encrypted contact details; working-day clocks; three agents (CV screen, panel summary, weekly digest); both audit trails; sign-in only for AI apps | [hiring-pipeline](../examples/mold_v0/hiring-pipeline/) |
| Flagwell, feature flags and experiments | mold_v0 | embedded | Append-only, hash-chained rollouts and overrides with signed checkpoints; one yes/no check that falls back from the user's override to the rollout and buckets users by a stable hash; the developer surface (API, keys, client sessions, webhooks out and in, SDKs); an experiment-readout agent | [feature-flags](../examples/mold_v0/feature-flags/) |
| Inkboard, a newsroom calendar | mold_v1 | tool | Desks, assignments and daily editions mapped onto the record areas by structure; a briefing specialist built as a full workspace; scheduled briefings as starter apps | [newsroom-calendar](../examples/mold_v1/newsroom-calendar/) |
| Keyward, a property maintenance desk | mold_v1 | tool | Buildings, tickets, quarterly inspection rounds and vendors' contracts on all four record areas; an inspection-reading specialist; scheduled lists | [property-desk](../examples/mold_v1/property-desk/) |

Each was proven the way a user would run it: the prompt went through the agent's natural-language path (the agent
writes the brief and the pack from it, `mint.py new`, intake) with **no question asked**, the spec it produced passes
`factory.py spec check`, and a fresh mint from that spec reaches the keys station (mold_v1) or the first deploy
(mold_v0) with nothing to clarify. The mold_v0 packs also pass `packs.py check`, `apply` and `verify` and a lane-copy
smoke; the mold_v1 packs pass `packs.py verify` (the mold's own subagent checks) and the eve build.

## How to write a one-shot prompt

The agent asks a question only for what your words leave open. Say these, in plain sentences, and it asks nothing:

- **The mold and the name.** "Make me a new app from mold_v0, called Wrenchline." The mold decides everything else:
  mold_v0 is records, agent runs and an MCP connector; mold_v1 is a chat workspace with specialists and a data room.
- **Who it is for and how they use it.** For mold_v0, say whether people use the app themselves (a **tool**) or
  developers build it into their own products (**embedded**), and why.
- **Every kind of record, with every field and its kind of value.** "Each work order has a site, the equipment, a
  priority (P1 urgent to P4 planned; required), the day it was reported..." Name the choices of every list, which
  fields are required, number ranges, files, and people.
- **The states a record moves through and who may move it.** "Close (from completed, owners only)." Say who may read,
  create, change and delete.
- **Every deadline as a rule.** When it starts, how long (by a field's value if it varies), whether it counts working
  days, what stops or pauses it, who is reminded when, and what happens when it is missed.
- **Each screen and its main button.** The Overview's headline numbers and charts, each list's columns and its button
  ("New work order"), and a list with no button and why.
- **Each agent: what starts it, what it reads, what it writes, what it may spend.** For mold_v0 also where its code is
  (a repository and a commit), the command, the check of its output, and its time limit. For mold_v1, the specialist's
  job, every way its input arrives, and the rules your people follow, word for word, with the open points and what to
  do meanwhile.
- **Schedules.** "Every Monday at 05:00 UTC."
- **Security choices.** Which trails are on (data access, platform requests, signed checkpoints), encrypted fields and
  who may reveal them, personal API keys, runners inside a customer's network.
- **The brand.** Name, colour as #RRGGBB, tagline, and the logo file's path in the repository.
- **Who runs it and where.** mold_v0: the platform administrators and the sender address; mold_v1: the first
  workspace's name, owner and members. Vercel or a server of its own, and the web address. Use real addresses only for
  real people; the examples use example.com.
- **Money.** The most one run may spend, the most one kind of run may spend a month, how many at once.
- **The legal company** (mold_v0): its name, contact address and effective date, for the terms and privacy pages.
- **For mold_v1:** web search and browser on or off, which inference provider, the dictation model, and whether new
  workspaces get starter workflows.

Describe things in your own words without worrying about trigger words: a sentence of description never changes a
setting by itself. If one sounds like a setting ("an on-premises runner later", "one workspace each"), the agent asks
you about it instead (docs/INTAKE.md "What sets state").

Two habits help: write words people read ("a run is a draft") and give every choice its label, and keep one thought
per bullet so nothing is ambiguous. Compare your prompt with an example's and its spec.

## Smaller requests

Things worth asking once an app exists. Each one is a request that worked end to end: the agent turns it into a ticket,
builds it in the mold (never in one app), proves it on a lane copy with screenshots, merges it and redeploys the apps
whose settings allow it. Replace `<app>` with one of your apps and the example addresses with your own.

The rule behind all of them: **an app asks, the mold learns.** A request made while shaping one app becomes a mold
capability with an on/off flag (see [APP_SPEC.md](APP_SPEC.md)), switched on in that app's brief.

### Start or reshape an app

- "Mint a new app from mold_v0 for <one-paragraph description>. You choose the name, colour and logo."
- "What else do you need to mint a new app from mold_v0?"
- "Give me a JSON schema for each mold that I can point VS Code at, so my spec is always mold complete."
- "Is <app> at visual and functional parity with <reference app>? Run the parity check and show me only what differs."
- "Which features are switched on for each app? Show me the flags."

### Screens and layout

- "Every list should read: four sparkline cards, then the search row, then the table. No title or description above it."
- "Every table needs a primary create button in the search row. Where nothing can be created, record why."
- "Clicking a table's primary button should open a full card with a summary of what will happen, not a dialog."
- "Remove all count badges and quick-filter chips from list toolbars; filtering stays in the Filter menu."
- "Keep the Overview a flat grid only: no floating cards, shadows or sticky columns."
- "Put the journey selector in the 'Get set up' heading as a dropdown."
- "Replace the Journeys card with a 'Due soon' card of the records coming due."
- "Move <page> into <other page> as its fourth tab, and break the old link."
- "Remove <page> from the mold and every app; it serves no real purpose."
- "The active sidebar entry must always be highlighted, including on record pages and in-page tabs."
- "Merge <page A> and <page B> into one Settings entry below Overview with two tabs, each a full-page table."
- "Add an Export button to <list> too."

### Data and records

- "Every record should be able to hold documents with an inline preview and download: PDFs, images, emails."
- "There is no way to add data to <shared record page> from the screen. Add New, Import (CSV/JSON) and Override."
- "Give <record area> a deadline clock: due N days after <field>, with reminders and escalation to owners."
- "Mark <field> as encrypted: masked everywhere, revealed only to owners, every reveal logged."
- "Add a yes/no check that answers '<question>' from the records, with the reason."
- "Remove the board and timeline views from <list>; keep the table."

### Audits, health and operations

- "Run a fresh audit on <app> to test it live, then show me the report."
- "Health should have tabs: Errors, Runs, Scheduled work, Email Delivery, Webhook Delivery, Status."
- "Make Health › Status a grid of graphs over 24h / 7d / 30d."
- "Track live API cost per app on /factory while I build."
- "Audit trails for data usage and for platform usage should be separate on/off flags."
- "On-premises runners should be an on/off flag."

### Developer products

- "Is this a tool developers use themselves, or something they build into their own apps? Set `kind` accordingly."
- "For embedded apps: generate the API description, JS and Python libraries, scoped keys, short-lived client
  sessions and signed webhooks from the app's settings."
- "Give webhooks their own Health tab."

### The factory itself

- "How many tickets are still open, and which builder is stuck?"
- "Keep the factory moving: run the sweep every 30 minutes."
- "Check the public repository for anything that identifies my organization, then clean it."
- "Merge this and take it live." / "Update <live app> too." (A live app with users always needs your yes.)
