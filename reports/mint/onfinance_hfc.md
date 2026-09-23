# What it took to mint `onfinance_hfc`

Generated 2026-09-23T09:38Z · status **stamped** · https://onfinance-hfc.vercel.app · packs: hfc-research

Every figure is *measured* from a record written when the thing happened, unless the row says otherwise.

## Time

| | |
|---|---|
| First message about this app | 2026-09-18T12:04Z |
| First live deploy | 2026-09-19T09:49Z — **21h 45m** of calendar time after the first message |
| Deploys so far | 18 (latest 2026-09-23T08:43Z) |
| Agent working: model time | 5h 12m |
| Agent working: running commands, builds, deploys, tests | 1h 42m |
| Session active time (idle gaps over 5 min removed) | 8h 33m |
| Operator messages | 56 |
| Agent messages / tool calls / subagents | 2021 / 996 / 38 |
| Test-lane reports written | 109 (functional 24, context 21, load 20, accessibility 20, responsiveness 24) |
| Commits touching the app, its brief and its packs | 40 |
| Pull requests merged upstream in the same window | 35 (+30073 / −3604 lines) in never2average/fde-agent |

## Money

| Item | Amount | How it is known |
|---|---|---|
| Agent (Claude) work | **$274.39** | measured: the sessions' own cost counters, at API list prices, subagents included. On a Claude subscription this is the *equivalent value used*, not an invoice. |
| Agent work the counter has not seen yet | about $381 | **estimated**: the measured cost scaled by the tokens the main session used after its last cost record (subagents since then are not included). Replaced by a measured figure at the next cost record. Total so far: about **$656**. |
| · claude-fable-5-1 | $264.57 | 354.5M tokens read, 1.57M written |
| · claude-opus-5[1m] | $9.27 | 8.9M tokens read, 0.07M written |
| · claude-haiku-4-5-20251001 | $0.56 | 0.2M tokens read, 0.01M written |
| Inference the live app has spent | $0.00 | measured: the app's own run table, 4 run(s) across 2 workspace(s). Runs that recorded no cost count as $0. |
| Hosting (Vercel: three projects, builds, functions) | not measured | vercel.com → the team → Usage. No per-project invoice is readable from this machine. |
| Database and file store (Neon, Vercel Blob) | not measured | the Vercel team's Storage tab; both start on free allowances |
| Model provider account (Cloudflare Workers AI) | not measured | dash.cloudflare.com → AI → Workers AI → usage; the row above is the app's own count of the same spend |
| Email (Resend), web search (Exa) | not measured | each provider's usage page; both keys are shared with the operator's other apps |

## Reading it

- The agent figure is for **everything done in those sessions**, not only this app's own files: it includes building factory features the next app reuses (packs, the mint line, the per-app package, the domain step) and the upstream pull requests. The next app's report is the marginal cost; this one is the cost of the first.
- Calendar time includes every wait for the operator (keys, decisions, sign-in codes) and overnight gaps. Agent working time does not.
- The cost and working-time counters are as of the session's last cost record; 1138 of its 2021 agent messages came after it and are not yet counted, so the true figures are higher; the Money table carries an estimate for that part.
