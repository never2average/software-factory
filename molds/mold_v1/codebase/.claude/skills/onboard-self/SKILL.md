---
name: onboard-self
description: Onboard yourself as a Forward-Deployed Engineer (FDE) on this eve platform before doing any customer work. Use on a fresh checkout / new machine, when the fde MCP tools return 401 or "not signed in", when `connector_list` fails, when the platform health is unknown, or whenever someone says "onboard me", "set me up as an FDE", "get me wired in", or "I'm new here". Walks the engineer step by step through: verifying platform health, signing in with their @onfinance.in Google account, getting the local env the MCP needs, wiring the fde MCP into their coding agent, recording their FDE profile so the system knows them, and a smoke test — then points them at their first customer.
---

# Onboard yourself as an FDE

This gets a new Forward-Deployed Engineer from a fresh checkout to fully
operational: signed in, MCP wired, recorded in the system, and verified against the
live platform. **Do this before any customer work** — the customer skills assume
you're already onboarded.

Read [`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md) once for the big
picture; this skill is the hands-on setup.

## Working style

Walk the engineer through **one step at a time** and pause after each — do not dump
all seven at once. Confirm each step succeeded before moving on. Everything here
writes to the **live** platform (there is no sandbox), so be deliberate. Never ask
for, echo, or store a token, secret, or one-time code — refer to them by name and
let the engineer paste them into their own env.

## The steps

Run these in order. Most are one command; pause and read the output together.

**1. Platform health.** Confirm the platform is up before touching anything:
```bash
curl -s https://fde-agent.vercel.app/api/ops/health | python3 -m json.tool
```
Want `db`, `blob`, and `inference` all green. If any is red, stop and tell on-call.

**2. Sign in (Google).** Establish your @onfinance.in identity — this is the *only*
way into the Ops API:
```bash
node setup/fde-login.mjs
```
Browser opens → pick your `@onfinance.in` account. Stores a refresh token at
`~/.config/fde-mcp/credentials.json` (mode 600). No secret to hunt for — the OAuth
client is baked in (see `setup/fde-login.mjs`).

**3. Local env.** The MCP's Data Room tools need the private blob token; the agent
needs the model key. Pull the blob token from Vercel and set the OpenCode key:
```bash
vercel env pull .env.local --environment production   # writes BLOB_READ_WRITE_TOKEN
```
Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env.local` — Cloudflare
Workers AI is the only inference provider (GLM 5.2). The token needs the
*Account > AI > Workers AI (read/run)* permission. Without both, model calls fail
rather than silently falling through to another provider.

**4. Wire the fde MCP.** Add the `fde` server to your Claude Code MCP config as in
[`setup/TEAM-SETUP.md` §3](../../../setup/TEAM-SETUP.md). Restart your agent.

**5. Record your FDE profile.** Make the system know you — there is no internal
people table, so this writes a team-scoped memory every agent can see:
```bash
npm run fde:onboard-self -- --name "Your Name" --title "Forward-Deployed Engineer" \
  --focus "what you own" [--timezone Asia/Kolkata]
```
It resolves your identity from step 2, checks health + local env, and upserts
`fde-profile:<you>` (idempotent — re-run any time to update). Green checks = you're
recorded.

**6. Smoke test.** From your coding agent, ask it to run the MCP's `connector_list`.
You should get the six connectors (System of record, Slack, GitHub, Granola, Gmail,
Vercel). A 401 / "not signed in" means step 2 didn't take — re-run `fde-login`.

**7. Orient.** You're operational. Read `docs/FDE_WORKFLOW.md` for the lifecycle and
where work lands, skim `dm.md` for the data-room tree, and know your seven
subagents (`research`, `configuration`, `deployment`, `data-migration`,
`customer-context`, `evals`, `follow-ups`). Then use the `onboard-customer` skill.

## Where this reads / writes

READ:
- `~/.config/fde-mcp/credentials.json` — your stored identity (email only)
- `/api/ops/health` — live platform status
- `.env.local` — presence of `BLOB_READ_WRITE_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`

WRITE (only this):
- `memories` table, `scope=team`, key `fde-profile:<email>` ← your FDE profile

## Never

- Never write your profile anywhere under `People/` — that tree is **external
  people only**. FDEs live in team memory.
- Never record a non-`@onfinance.in` identity — the script refuses it, and the Ops
  API rejects it.
- Never print, store, or commit the blob token, OpenCode key, or Google tokens.

## Quick reference

```bash
curl -s .../api/ops/health | python3 -m json.tool   # 1. platform up?
node setup/fde-login.mjs                              # 2. sign in (Google)
vercel env pull .env.local --environment production  # 3. blob token
npm run fde:onboard-self -- --name "…" --focus "…"   # 5. record profile (idempotent)
```
