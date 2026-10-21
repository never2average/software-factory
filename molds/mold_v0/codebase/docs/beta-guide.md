# Octillion beta guide

Octillion runs real AI coding agents (Claude Code, Codex, OpenCode, Antigravity and others) on realistic development
tasks and shows you how often they pick your developer tool versus competitors, if they pick one at all. This guide
gets you from invite to your first report.

## 1. Connect

Your invite gives you the connector URL `https://octillion.useimmaculate.com/mcp`, and either a sign-in invitation or a
personal API key (`oct_…`). A key is your login: anyone with it can use your account, so keep it private. Your client
sends it in a header, `Authorization: Bearer <key>`; it never goes in the URL. (Old links with the key in the URL,
`…/mcp/oct_…`, still work for now but are being retired: move to the header.)

| Client | How to connect | What you see |
|---|---|---|
| Claude (web or desktop) | Settings, Connectors, Add custom connector, paste the URL and sign in (these apps cannot send a key) | An interactive dashboard under each answer |
| ChatGPT | Turn on developer mode, add a custom connector with the URL and sign in (OAuth) | The same dashboard |
| Claude Code | `claude mcp add --transport http octillion <URL> --header "Authorization: Bearer <key>"` | Text answers |
| Cursor and other IDEs | Add the URL with a `headers` entry (`"Authorization": "Bearer <key>"`) in the MCP settings and switch the Octillion tools on; ask in Agent chat | Text answers |

Then type: **"Get me started with Octillion."** The first tool, `get_started`, answers with your next step.

If the tools do not appear, remove the connector, add it again and start a new chat. In Cursor, check that the
Octillion server is switched on in the MCP settings.

## 2. Your first report: three prompts

1. **"Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>."**
   Octillion researches your product and writes a profile (package names, domains), your competitors, developer
   personas and 3 to 10 realistic coding tasks that never name your product. This takes a few minutes and uses no
   coding agents yet. **Check the competitor list now:** a competitor that is missing cannot be credited when agents
   pick it. Ask to add any, e.g. "Add Amazon SES and Loops as competitors."
2. **"Run a simulation."** Coding agents work each task in their own fresh sandbox, mixed by how many developers use
   each agent. Every task is sampled until its result is stable, up to 20 sessions. Expect 20 to 60 minutes. Ask
   "How is my simulation doing?" any time.
3. **"Show my visibility report."** How often agents picked your tool, which competitor won instead, results per task
   and per agent, and the agents' own words. Follow up with "Why did agents pick <competitor> on <task>?" or
   "Search the transcripts for <keyword>."

## 3. How to read the results

- **A pick** means the agent built on your tool: it installed or imported your SDK, called your API from the code it
  wrote, or chose you in its own words. Being named in passing is a mention, not a pick.
- **Control tasks** ("avoid") are tasks where the right answer is to use no tool at all. Agents get credit for not
  adding one.
- **Sample sizes are small.** Each rate is shown with a 95% range. Treat one run as a signal and repeat a task before
  acting on it.
- **Agents covered**, weighted by real-world use: Claude Code (Opus, Sonnet), Codex (GPT-6.1-Sol), OpenCode, Antigravity
  (Gemini 4 Argon), Pi, Cline and Kilo. Ask "list agents" for the current mix and sources.

## 4. Beta limits

| Limit | Value |
|---|---|
| Model spend per account | $1,000 per calendar month; new runs pause after that |
| Sessions per task | Adaptive, up to 20 |
| Sessions per run | Up to 120 |
| Cost of a typical run | About $40 to $90 of model use, free for you during the beta |

## 5. Feedback

Reply to the message your invite came in. We most want to hear where you got stuck, tasks that felt unrealistic for
your product, results you don't believe, and what you would need to act on a report.
