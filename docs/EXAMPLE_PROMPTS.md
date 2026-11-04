# Example prompts

Things worth asking the factory's agent, in plain words. Each one is a request that worked end to end: the agent turns it
into a ticket, builds it in the mold (never in one app), proves it on a lane copy with screenshots, merges it and redeploys
the apps whose settings allow it. Replace `<app>` with one of your apps and the example addresses with your own.

The rule behind all of them: **an app asks, the mold learns.** A request made while shaping one app becomes a mold
capability with an on/off flag (see [APP_SPEC.md](APP_SPEC.md)), switched on in that app's brief.

## Start or reshape an app

- "Mint a new app from mold_v0 for <one-paragraph description>. You choose the name, colour and logo."
- "What else do you need to mint a new app from mold_v0?"
- "Give me a JSON schema for each mold that I can point VS Code at, so my spec is always mold complete."
- "Is <app> at visual and functional parity with <reference app>? Run the parity check and show me only what differs."
- "Which features are switched on for each app? Show me the flags."

## Screens and layout

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

## Data and records

- "Every record should be able to hold documents with an inline preview and download: PDFs, images, emails."
- "There is no way to add data to <shared record page> from the screen. Add New, Import (CSV/JSON) and Override."
- "Give <record area> a deadline clock: due N days after <field>, with reminders and escalation to owners."
- "Mark <field> as encrypted: masked everywhere, revealed only to owners, every reveal logged."
- "Add a yes/no check that answers '<question>' from the records, with the reason."
- "Remove the board and timeline views from <list>; keep the table."

## Audits, health and operations

- "Run a fresh audit on <app> to test it live, then show me the report."
- "Health should have tabs: Errors, Runs, Scheduled work, Email Delivery, Webhook Delivery, Status."
- "Make Health › Status a grid of graphs over 24h / 7d / 30d."
- "Track live API cost per app on /factory while I build."
- "Audit trails for data usage and for platform usage should be separate on/off flags."
- "On-premises runners should be an on/off flag."

## Developer products

- "Is this a tool developers use themselves, or something they build into their own apps? Set `kind` accordingly."
- "For embedded apps: generate the API description, JS and Python libraries, scoped keys, short-lived client
  sessions and signed webhooks from the app's settings."
- "Give webhooks their own Health tab."

## The factory itself

- "How many tickets are still open, and which builder is stuck?"
- "Keep the factory moving: run the sweep every 30 minutes."
- "Check the public repository for anything that identifies my organization, then clean it."
- "Merge this and take it live." / "Update <live app> too." (A live app with users always needs your yes.)
