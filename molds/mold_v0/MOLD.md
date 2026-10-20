# mold_v0

**Status:** work in progress. Pinned as a verbatim snapshot of the operator's existing MCP product, by the operator's decision (2026-10-20): *clone first, generalise after*.

**Pinned:** see `state/factory.json` (`molds[mold_v0].pinned_commit`). The source's address is the machine's own, in `state/factory.local.json` (`mold_sources.mold_v0`). Refresh with `python3 .claude/scripts/mold.py refresh mold_v0`; verify with `mold.py check mold_v0`.

## A recorded exception

Molds are general-purpose: no product or customer words, apps declared through a profile and packs. mold_v0 starts as the opposite, a working product copied as it is, so the factory can reproduce it straight away (ticket mold_v0-029) and mint a second product from it (mold_v0-030). It becomes general step by step: each capability in [SCOPE.md](SCOPE.md) (tickets mold_v0-001 to 021) is extracted into a neutral shell, with the product's own words, data and integrations moving into its pack. Until then, an app minted from mold_v0 inherits the product's code.

## What is in it today

- A TypeScript server (Express) with a stateless MCP endpoint, per-organisation API keys (hashed), an admin console, client install pages, onboarding, usage analytics, a key vault, billing and email.
- Postgres (schema applied on boot), plus optional analytics and archive stores.
- Two ways to run: its own server (Docker Compose with HTTPS) and Vercel.

## Before anything built on it is sold (ticket mold_v0-031)

API keys out of URLs, OAuth token audience checked, Origin validated on the MCP endpoint, no static admin token, database row-level security proven on every deploy, and versioned migrations.

## Decisions

- Default sign-in for apps from the generalised shell: a built-in emailed code plus Google; Clerk optional.
- The source has no licence constraints (a hackathon project).
- The operator's live copy moves to a factory-managed app through a new subdomain, two weeks side by side, then a public address switch only with the operator's yes (mold_v0-032).
