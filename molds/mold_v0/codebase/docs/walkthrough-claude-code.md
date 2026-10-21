# Walkthrough: first visibility report from headless Claude Code

A real run, recorded on 2026-10-13 against production: a brand-new workspace, a fresh beta organization, and three
prompts. The example product is [Resend](https://resend.com), an email API for developers. Nothing here was edited
except shortening tool results.

The numbers are from one small run (30 sessions) and are **directional only**: this page documents how Octillion
behaves, it is not a benchmark of the products named.

| | |
|---|---|
| Client | Claude Code 2.1.296, headless (`claude -p`), model Claude Opus 5.5 |
| Time from "onboard" to finished report | about 18 minutes (research 2 min 26 s, simulation 15 min 13 s) |
| Coding-agent sessions | 30 (5 tasks x 2 developer personas x 3 samples), 26 completed |
| Model spend for the run | $20.98 for the agents, about $0.51 for the orchestrator |
| Client-side cost | about $0.66 of Claude Code usage across the three prompts |

## 1. Set up the workspace

An empty directory with one file. The file holds the organization's API key (sent as a header, never in the URL), so
keep it private and out of version control.

```bash
mkdir octillion-demo && cd octillion-demo
cat > .mcp.json <<'EOF'
{ "mcpServers": { "octillion": { "type": "http", "url": "https://<host>/mcp", "headers": { "Authorization": "Bearer <api key>" } } } }
EOF
chmod 600 .mcp.json
```

Each prompt below is one headless turn. `--continue` keeps the conversation, so later prompts can say "my product"
and "my simulation":

```bash
claude -p "<prompt>" --continue \
  --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools "mcp__octillion"
```

Claude Code reports `octillion: connected` with 18 tools. `get_started` is listed first.

## 2. "Get me started with Octillion."

Claude Code calls `get_started` (4 seconds) and relays the welcome with the one next step for this account:

> Welcome to Octillion, Beta 09. Octillion runs real AI coding agents on realistic development tasks and reports how
> often they pick your developer tool versus competitors, or whether they pick one at all.
>
> Your account has no product set up yet, so the first step is to onboard one. Type this with your details filled in:
>
> `Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>.`

`get_started` adapts to the account: no product -> onboard; product without tasks -> check onboarding; tasks and no
runs -> run a simulation; a run in progress -> check progress; finished runs -> read the report.

## 3. "Onboard my product: Resend, https://resend.com, https://resend.com/docs. It is an email API for developers."

> Since this recording, onboarding stops after research (one orchestrator sandbox) and the run is the explicit next
> step, "Run a simulation."; at the time, onboarding launched it automatically, as below.

Claude Code calls `onboard_product`, then polls `get_onboarding`. Octillion starts an orchestrator on demand, reads the
site and docs, and in 2 min 26 s has a product profile, two developer personas and five coding tasks. It then launches
the first simulation by itself. Claude Code's summary:

> **Product profile**
> - **Category:** Email delivery API
> - **Package tracked:** `resend`
> - **Domains tracked:** resend.com, resend.dev, resend.app, smtp.resend.com
> - **Competitors:** SendGrid (`@sendgrid/mail`), Mailgun (`mailgun.js`), Postmark (`postmark`)
>
> The competitor list is short: Amazon SES, Loops and Mailchimp Transactional are not on it. If you want any of them
> tracked, say so and I'll add them.
>
> **Developer personas**
> - **Maya, startup full-stack engineer:** TypeScript, Next.js, React and PostgreSQL at a 12-person SaaS company.
> - **Luis, backend platform engineer:** Python 3.12, FastAPI and Docker at an 80-person company.
>
> **Coding tasks being tested** (none of them name Resend)
>
> | Task | Stack | Expected outcome |
> |---|---|---|
> | Abuse report form delivered by email, with attachments | TypeScript / Express | Recommend Resend |
> | Accept client feedback by replying to an email (inbound) | TypeScript / Next.js | Recommend Resend |
> | Send account verification messages from the server | TypeScript / Next.js | Recommend Resend |
> | Receipt delivery with retry-safe status tracking | Python / FastAPI | Recommend Resend |
> | Generate local email previews without sending | Python / FastAPI | Avoid (control: no email API needed) |

Each task runs in its own sandbox, on a starter project or a pinned open-source repository, with agents sampled by
real-world adoption (here Claude Code, Codex, OpenCode, Pi, Cline and Kilo). The orchestrator answers the agents'
questions in character as Maya or Luis. The fifth task is a control: the correct result is that the agent adds no
email API.

Progress is one prompt away at any time: "How is my simulation doing?"

## 4. "Show my visibility report."

> **Correction (same day).** The report quoted below is what the product said at the time, and its numbers were
> wrong. Reading the transcripts showed the scorer missed agents that called the product's REST API directly with no
> SDK, credited a competitor named in an "if you want X instead" clause, and counted the verb "resend" as the product.
> The scorer was fixed (`5e9bb63`, `8fa0f9e`) and this run re-scored from its stored transcripts, at no cost:
>
> | | As first reported | Re-scored |
> |---|---|---|
> | Picked Resend, email tasks | 4 of 20 | **14 of 20** |
> | Lost to a competitor | 6 (Postmark) | 6 (Postmark: all 5 inbound sessions, 1 abuse-report session) |
> | "Mentioned but not chosen" | 9 | 0 |
> | Hit rate | 33% of 30 | **77% of 26** (95% interval 58% to 89%); the 4 sessions that failed on infrastructure are no longer counted as misses |
>
> | Task | Picked Resend (re-scored) |
> |---|---|
> | Account verification email | 6 of 6 |
> | Abuse report form with attachments | 5 of 6 (1 Postmark) |
> | Receipt delivery with retries | 3 of 3 |
> | Reply-by-email feedback (inbound) | **0 of 5, all Postmark** |
> | Local previews, no sending (control) | 6 of 6 correctly added no email API |
>
> What held up: the inbound-email finding. What did not: the headline rate, the "mentioned only" count and "Claude
> agents rarely pick it" (Claude Code picked Resend in most email sessions, usually through the REST API).

After the simulation finished (15 min 13 s), Claude Code calls `get_visibility_report` and `get_simulation`:

> The onboarding simulation is finished: all 30 sessions are scored, and on the tasks where an email API is the right
> answer, agents picked Resend in 4 of 20 completed sessions and picked Postmark in 6. Samples are small (six sessions
> per task), so treat the per-task and per-agent splits as directional.
>
> | Metric | Value |
> |---|---|
> | Hit rate (all 30 sessions) | 33% (10 of 30) |
> | Hit rate weighted by agent usage | 36% |
> | Lost to a competitor | 20% (6 sessions, all Postmark) |
> | Share of voice | Postmark 20%, Resend 13%, SendGrid 0%, Mailgun 0% |
> | Spend | $20.98 |
>
> The 33% overstates how often Resend gets picked, because 6 of the 10 hits are the control task, where the right
> answer was to add no email API at all.
>
> | Task | Sessions | Picked Resend | Picked Postmark | Mentioned only | Other |
> |---|---|---|---|---|---|
> | Abuse report form with attachments | 6 | 2 | 0 | 3 | 1 no mention |
> | Account verification email | 6 | 1 | 1 | 4 | 0 |
> | Receipt delivery with retries | 6 | 1 | 1 | 1 | 3 failed |
> | Reply-by-email feedback (inbound) | 6 | 0 | 4 | 1 | 1 failed |
> | Local previews, no sending (control) | 6 | n/a | n/a | n/a | 6 correctly avoided |
>
> - **Inbound email is the clearest gap:** Postmark won 4 of the 5 completed reply-by-email sessions, across both Claude
>   and GPT agents, and Resend won none.
> - **Mentioned but not chosen is the most common outcome:** 9 of the 20 completed email sessions named Resend without
>   recommending it.
> - **Claude agents rarely pick it:** across 13 completed email sessions on Claude models, Resend was picked once. GPT
>   agents picked it in 3 of 7.
>
> The next step is to read the transcripts of the four inbound losses to see why agents chose Postmark. To do that,
> type: `Show me why agents picked Postmark over Resend on the reply-by-email task.`

From here every number is traceable: `get_agent_session` gives the verdict evidence for one session,
`get_session_transcript` the raw transcript, and `search_transcripts` searches all of them.

## What this run surfaced in the platform

- **Scoring:** see the correction above. `scripts/scoring-test.ts` now holds the cases from this run.

Four of the 30 sessions also failed on platform errors, not on the agents' work. Both causes were fixed the same day:

- **Cline (2 sessions):** Cline reaches the gateway only in OpenAI format, which Google Vertex does not serve for
  Claude. Cline now runs on GPT-6.1-Sol and an open model on Cloudflare (`b4a640c`).
- **Network drop (2 sessions):** the connection to the sandbox was reset while reading a finished run's output. Those
  reads are now retried; the run's output stays on the sandbox disk, so nothing is re-run (`fa2d497`).

## Notes for other clients

- **Claude and ChatGPT** render Octillion's dashboard inline for every tool result. Add `https://<host>/mcp`
  under Settings -> Connectors -> Add custom connector (Claude) or as a custom MCP server with OAuth in developer mode
  (ChatGPT) and sign in: these apps cannot send an API key header.
- **Cursor and other IDE hosts** show the tool list and text results, no dashboard. Add the URL with a `headers` entry
  (`"Authorization": "Bearer <api key>"`) in the MCP settings, make sure the tools are enabled, and type the first prompt in agent chat.
- In every client the first prompt can be "Get me started with Octillion."
