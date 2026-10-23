# mold_v0: an agent-run shell with an MCP front door

A product built on this shell lets a workspace (a customer account) connect from any MCP client, ask for work, and get
it done by coding agents running headless in sandboxes, with every model call metered through the shell's own gateway
and every result stored against the workspace. What the product does is its **packs**; the shell with zero packs is a
neutral, working product: sign-in, workspaces, keys, the console, the vaults, the run engine, the inference gateway,
storage, record areas, schedules, billing and email (both optional). See `../MOLD.md` and `../SCOPE.md` in the factory.

## Quick start

```bash
npm install && npm run orchestrator:install   # server + orchestrator deps
npm run typecheck      # server, orchestrator and console
npm run smoke          # end-to-end test (embedded Postgres, no Docker needed), then each host pack's own

cp .env.example .env
npm run stack:up       # Postgres + ClickHouse
npm run dev            # http://127.0.0.1:3333
npm run org:create -- "Acme"   # a workspace and its API key
```

## Packs

A pack is a directory `packs/<id>/` (the factory's `packs.py apply` copies an app's packs into its build copy):

- **Declarative packs** (`pack.json` alone): record areas with typed fields, lifecycles and permissions, job kinds,
  credentials, schedules, onboarding steps, metrics, charts, console tabs, repositories; MCP tools are generated from
  them (`src/mcp-catalog.ts`). Code (`definePack`, `src/pack-api.ts`) adds tools and routes.
- **Host packs** (`pack.json` `host`, only when `profile.json` lists the id in `host_packs`): a product's whole surface
  at the shell's fixed points (`src/host.ts`): its MCP tools and prompts, routes at its own paths, hooks into the session
  engine, settings, console pages (`web/src/packs/<id>/`), an orchestrator extension (`orchestrator/packs/<id>/`) and
  operator scripts (`npm run pack:run -- <script>`). Its server code reaches the shell only through `src/pack-host.ts`.

`npm run gen:packs` writes the registries the server, console and orchestrator import; `npm run check:packs` refuses a
pack whose code or SQL gets past the seam.

A pack's `upstream` pin with a copyleft licence is offered to the people who use the build (the MCP server's
instructions, the root, landing and install pages' footer: `src/source-offer.ts`); `profile.json`
`source_offer` says where the build's own source is, or that its licensor's exception applies, and
`source_offer.upstreams` names the packs whose upstream is the licensor's own (not offered). `profile.json`
`member_keys: false` turns per-member API keys off (clients sign in). `npm run gen:data-map`
writes `DATA-MAP.md`, the data-flow and residency statement (`src/data-map.ts`), from the packs and the factory's
`deploy-facts.json`. The console has no About page.

## Layout

```
src/http.ts          the server: /mcp, /install, /api/app, /api/admin, /api/worker, /gw, the cron, the host packs' routes
src/server.ts        the customer MCP server: the host packs' tools, then every pack's (src/packs.ts)
src/admin-mcp.ts     the admin MCP server for platform staff
src/host.ts          the host-pack seam; src/pack-host.ts the shell services a host pack may use; src/hosts.ts loads them
src/pack-api.ts      definePack and the declarative pack contract (src/pack-manifest.ts)
src/runs.ts          the generic run engine (src/run-harness.ts, src/agent-workspace.ts, src/run-sandboxes.ts)
src/worker.ts        the session engine's queue: claim, append, complete (a host pack scores), stale sweep
src/gateway.ts       the inference gateway: per-run and per-session tokens, metering, budgets
src/keyvault.ts      the platform key vault; src/orgcrypto.ts per-workspace data keys; src/credentials.ts the workspace vault
src/record-areas.ts  record areas and the data API (src/data-api.ts, src/data-routes.ts)
src/app.ts           the customer portal's API; src/admin.ts the admin console's
web/                 the console (Next.js): /admin and /app
orchestrator/        the orchestrator: core, harness adapters, sandboxes; orchestrator/main.ts runs a host pack's or the worker
harnesses/           the coding-agent registry
sql/migrations/      the versioned schema (row-level security on every tenant table)
scripts/             smoke, gen-packs, the tests (npm run test:*), org:create, admin:token, pack:run
```
