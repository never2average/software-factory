# factory-board

A Claude Code plugin that ships with the software factory. One pane, four tabs, covering every app the factory has built:

- **Products & apps:** where each product stands, with its apps underneath: whether each is up right now, and where and when it was deployed.
- **Molds:** the base codebases and their tickets.
- **Tickets:** every open ticket, filterable, each one clickable.
- **Analytics:** each app's rough usage, and the tickets people raised inside it.

Type `/factory` in a Claude Code session started in the factory.

![The factory board open beside a Claude Code session](docs/board-full.png)

## Tabs

The tab buttons sit at the top of the pane. You can also jump straight to a tab:

| Type | Opens |
|---|---|
| `/factory products` | Products & apps (the board opens here) |
| `/factory molds` | Molds |
| `/factory tickets` | Tickets |
| `/factory analytics onfinance_hfc_vm` | Analytics, with that app picked |
| `/factory mold_v1-215` | that ticket's details |
| `/factory refresh` | the board, after a fresh health check |

### Products & apps

![Products & apps tab](docs/tab-products.png)

Each product in `state/products.json` gets:

- **Its stage path:** `defined → built → tested → deployed → released`. Done stages are ticked and the current one is green. A product of a coming-soon mold shows **coming soon** instead.
- **Each of its apps:**
  - **Health:** live health (`healthy`, `down`, `pending`, or `n/a` for a retired app), shown only when it isn't plain `stamped`. Its record status shows beside it, as `reverted` or `retired`. Where it runs: `vercel`, or `own server`.
  - **Checks:** the answer from each health page the board loads itself (web, api, and on Vercel the workflow service). Also the workspace-isolation proof from the last deploy: `RLS 62/62` means all 62 workspace tables are locked to their workspace.
  - **Deploy:** when it was last deployed, and the base-code (mold) version it runs. `current` is the factory's latest snapshot; `behind` means a redeploy would update it.
  - **Address:** its web address.
  - **Built:** what it took to make the app, for example `built: $1,299 (shared) + ~$37.62 est. · agent 16h 55m · active 12h 39m · first message → live 21h 33m · 70 deploys`:
    - **built:** the AI (Claude) the factory spent making it, at list prices, read from the agent sessions' own cost counters. On a Claude subscription it is the value used, not an invoice.
    - **(shared):** most of the work happened in long sessions that built several apps. Such a session is split: each piece of work (from one message to the agent to the next) goes to the apps it names, in proportion to how often it names each, and a piece that names no app stays factory work, charged to no app. So two apps that share a session never both count all of it. A shared figure is dimmed.
    - **~ est.:** work done after a session's last cost record, which the counter hasn't seen yet. It is estimated from the counted part, dimmed, and never added into the measured figure.
    - **agent:** the time the model spent working; **active:** session time with idle gaps over 5 minutes taken out. Both are shared the same way, and dimmed when they are.
    - **first message → live:** calendar time from the first message that named the app to its first deploy, waits included.
    - **deploys:** how many times it has been deployed, from git history.
    - A figure that can't be worked out says **not measured**, never `0`.
- **The product's total**, under its name: the sum of its apps' lines, marked **(shared)** when any part is.

The build figures come from `.claude/scripts/mint_report.py --all --json`, which the board runs every hour and on **Recompute build costs** (at the bottom of this tab). It reads the agent sessions and git on this machine, goes nowhere online, and writes `reports/mint/<app>.json` and `.md` for each app that isn't retired. `reports/mint/<app>.md` explains each figure in full, with the share taken of each session.

Apps that belong to no product are listed under **Other apps**.

### Molds

![Molds tab](docs/tab-molds.png)

Each mold with its snapshot version and its tickets (open, in progress, done). A mold marked `coming_soon` in `state/factory.json` shows **coming soon** and its number of planned tickets. Today that's mold_v2 and mold_v3.

### Tickets

![Tickets tab](docs/tab-tickets.png)

- **Filters along the top:** `All`, each priority, and each app that has tickets, with counts.
- **One line per ticket:** a coloured priority (P1 red, P2 amber, P3 grey), its short number, the app it's about if any, and the title cut to fit.
- **Clicking:** the title opens the ticket.

![A ticket](docs/ticket-detail.png)

A ticket shows:

- its priority, status, app and full id;
- the full title;
- a line with type, lane, product, which stage it moves the product to, owner and date filed;
- **What happened**, **Done when** (as checkboxes), **Waits on** (other open tickets, each clickable, and done ones ticked) and **Evidence so far**.

There are two buttons:

- **← Back** goes back to the list.
- **Work on this** puts `Work on factory ticket <id> …` into your prompt, ready to send.

### Analytics

![Analytics tab, numbered](docs/analytics-annotated.png)

1. **Tabs.**
2. **App picker:** one button per app that isn't retired.
3. **Window:** the last 30 days, and when the numbers were collected.
4. **Usage:**
   - people active, chats, chat turns;
   - tokens in and out;
   - estimated chat cost;
   - workflow (helper) runs and their cost (dimmed and marked **~ est.** when any of it is estimated).
5. **Chat turns per day:** one bar per day, scaled to the busiest day.
6. **Tickets in the app:** the tickets people raised inside the app itself (open, in progress, done). These are not the factory's tickets.
7. **By workspace:** the same numbers for each workspace in the app.
8. **By agent and By user:** the main agent's turns and each specialist's runs, with tokens and cost, and then each person's chats, turns, cost and when they were last active. People are shown by display name, never by email address. A figure that can't be worked out says **not measured**, never `$0`. A cost the app recorded is shown plainly. Some older helper runs recorded their tokens but no cost and no model, because Cloudflare Workers AI doesn't report costs and the app didn't yet record which model ran. Their cost is estimated: the tokens are priced at the model that helper is set up to use now, with the app's own price list. An estimate is shown dimmed as **~$1.23 est.**, so it never looks like a measured figure. The report names the model it used (`estimated_from`).
9. **Factory tickets for this app:** open factory tickets that name this app. Each one is clickable.
10. **Buttons:** **Refresh** checks health again. **Collect usage** pulls fresh numbers.

The numbers come from `.claude/scripts/app_usage.py`, which the board runs every 30 minutes and on **Collect usage**. It reads each app's own database as the app's own restricted role, one workspace at a time, in read-only transactions. Only counts leave the database: no messages, no names, no email addresses. The results are kept in `reports/usage/<app>.json`, which is not committed.

## The status line

A one-line summary sits in the status line, so you can see it without opening the pane:

![The summary in the status line](docs/status-line.png)

The board checks health every 5 minutes on its own.

## Installing

Inside the factory there is nothing to do: `.claude/settings.json` turns the plugin on from the factory's own marketplace (`.claude-plugin/marketplace.json`). Elsewhere, type this at a Claude Code prompt, answer `y` to add the marketplace, then pick a scope:

```
/plugin install factory-board --marketplace never2average/software-factory
```

The board reads the factory's records from the folder Claude Code was started in when that folder is the factory, and otherwise from `/root/software-factory`. It never changes a record, a ticket or an app.

## Developing it

- `hooks/register.tsx` holds the pane, its tabs, `/factory` and the timers.
- `hooks/board.ts` holds the pure readers of the state files, the usage report and the build reports.
- `types/index.d.ts` declares the values the pane keeps.

The tests are:

- `hooks/board.test.ts` for the readers, the build lines and the product totals;
- `hooks/tickets-ui.test.tsx`, which clicks through the tickets, the filters and the Products & apps tab (with its build lines and **Recompute build costs**) on the terminal and desktop surfaces against a small fake factory.

```
claude plugin validate plugins/factory-board
claude plugin test plugins/factory-board
```

The screenshots in `docs/` are real captures of the running board, taken on 2026-10-08 in a terminal 170 columns wide.
