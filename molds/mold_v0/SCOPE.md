# mold_v0 scope: the agent-run shell

**Status:** work in progress. The codebase at `molds/mold_v0/codebase` started as a verbatim snapshot of the operator's
own MCP product, Octillion ([MOLD.md](MOLD.md)), and is authored in this repository since that snapshot (fork point
`e8d836532cb7`, mold_v0-040, a recorded exception to "never edit a mold in place"). It becomes the general shell
described here step by step.
**Product:** `mcp_product_shell` in `state/products.json`. **Backlog:** `state/tasks/mold_v0.jsonl` (the generalisation
is mold_v0-038 to 050, with the older tickets that survived re-scoped to it).

## What mold_v0 is

mold_v0 is an **agent-run shell with an MCP front door**. A product built on it lets a workspace (a customer account)
connect from any MCP client, ask for work, and get that work done by coding agents running headless in sandboxes,
with every model call metered through the shell's own gateway and every result stored against the workspace.

Every product on it has the same shape:

1. a person signs in, belongs to a workspace and connects an MCP client with a key or OAuth;
2. the client calls a tool; the tool reads or writes the product's records, or queues a **run**;
3. a sandboxed harness (Claude Code, Codex, OpenCode, Pi and others) does the run, reaching models only through the
   inference gateway with a short-lived token of its own, and reaching only the hosts its run allows;
4. the run's events, transcript, cost and results are stored for that workspace and shown in the console and in the
   client.

What the product does is a **pack**: its tools, routes, run kinds, record areas, credentials, schedules, onboarding
steps, console pages and migrations. The shell with **zero packs** is a neutral, working product with sign-in,
workspaces, keys, the console, the vaults and the run engine and no domain at all. With `["octillion"]` it must be
today's product, unchanged (see [MOLD.md](MOLD.md), "Pack and record-area contract").

An earlier version of this file described a metering proxy in front of someone else's MCP server. That is not what
the pinned product is, and the tickets written for it (mold_v0-002, 003, 005, 006, 009, 012, 015, 016, 017, 025) are
dropped or merged into the ones below.

## Capabilities

Paths are relative to `molds/mold_v0/codebase`. "Today" is the codebase as forked (the product with mold_v0-031's
hardening); "generalised by" is the ticket that
turns it into shell, or builds it where nothing exists yet.

### Tenancy and the sign-in adapter

- **Today.** Workspaces are `organizations` (`sql/schema.sql`), and every customer query takes the calling org first
  (`src/auth.ts`, and the product's queries, now its host pack's); `scripts/check-tenant-sql.ts` (with `scripts/tenant-sql-baseline.json`) refuses
  an unscoped query. People, memberships, roles and invites live in Clerk (`src/clerk.ts`, `src/session.ts`,
  `web/src/proxy.ts`); account roles are `src/account-roles.ts`, platform admins `src/admin-auth.ts` and
  `src/admin-roles.ts`. Deleting a workspace across every store is `src/tenancy.ts`; `scripts/create-org.ts` and
  `scripts/delete-org.ts` drive it from the command line. Isolation is by query scoping and, since mold_v0-031, by
  Postgres row-level security on every tenant table for a per-database tenant role that fails closed with no
  organisation set (`sql/migrations/0003_row_level_security.sql`, `src/tenant-scope.ts`, `src/rls.ts`), proven by
  `npm run check:rls` (the factory runs it on every deploy against the deployed database and in the context lane,
  mold_v0-051). The schema is versioned migrations (`sql/migrations/`, `src/migrate.ts`, `npm run test:migrations`).
- **Generalised by.** mold_v0-031 (done: row-level security proven on every deploy, no static admin token, versioned
  migrations), mold_v0-004 (sign-in behind an adapter: Clerk at launch, a built-in emailed code plus Google later).

### MCP front door with a pack-filled tool registry

- **Today.** `/mcp` and `/mcp/:key` in `src/http.ts` (stateless Streamable HTTP, OAuth protected-resource metadata
  under `/.well-known`); the tool registry is `src/server.ts` (the host packs' tools, then every pack's); a stdio
  entry for local hosts is `src/stdio.ts`; the inline dashboard widget is `src/ui/widget.html`. Hashed per-org keys are
  `api_keys` (`sql/schema.sql`). Per-call activity (method, tool, outcome, latency, never arguments or results) is
  `src/analytics.ts` (`mcp_events`). A second MCP server for platform staff is `src/admin-mcp.ts`. Per-client install
  guides come from `src/connect-catalog.ts`.
- **Generalised by.** mold_v0-038 (done: pack tools register after the shell's from the registry `gen-packs.mjs`
  generates, `src/packs.ts`; the server name comes from the profile), mold_v0-039 (done: the product's 31 tools are its
  host pack's, registered through `src/host.ts`; with zero packs `/mcp` lists none), mold_v0-007, **built** (per-member keys header-only, named, revocable, expiring, with the member's
  current role; `src/member-keys.ts`, `/app/keys`), mold_v0-013 (a built-in MCP OAuth server when
  Clerk is off), mold_v0-010, **built** (install guides from the profile, a tool reference from the registry at
  `/install/tools`), mold_v0-067, **built** (excluded and admin_only tools withhold their routes and tabs; the build
  knows the shell's tool names, `src/shell-tools.ts`, empty for the customer MCP since mold_v0-039; staff calls in the
  workspace's log; staff runs under the account's launch rules), mold_v0-018, **built** (MCP rate
  limits per key, member, workspace and address with a 429 and Retry-After, request and answer size caps, requests in
  flight per workspace, the sign-up, invitation and key endpoints; `src/rate-limits.ts`, numbers from the profile's
  `limits`, per plan, under the server's environment), mold_v0-060, **built** (MCP as a core offering: tools generated from every pack's declarations
  over the data API and the run engine, shaped by pack.json `mcp`, admin-only tools on the admin MCP, the server's
  name, version and instructions from the profile, public install pages per client at `/install`;
  `src/mcp-catalog.ts`, `src/mcp-tools.ts`, `src/install-pages.ts`).

### Run engine with sandboxed harness runs

- **Today.** `agent_sessions` rows are the job queue (`src/worker.ts`: claim with `FOR UPDATE SKIP LOCKED`, events,
  heartbeat, complete, retry on infrastructure failure, sweep of stale rows), served at `/api/worker` in `src/http.ts`
  and authenticated by `src/workerauth.ts`. `src/autoscaler.ts` (with `src/autoscaler-ticks.ts`, `src/fleet.ts`)
  launches one orchestrator sandbox per job through `orchestrator/deploy/boat-lib.ts`. The orchestrator side is
  `orchestrator/core/` (`session.ts`, `runners.ts`, `pool.ts`, `sink.ts`, `host-guard.ts`, `egress.ts` for the egress
  allowlist, opt-in today: private runs on the sandbox runner only), and `orchestrator/worker.ts` is the deterministic worker. Harnesses are pinned in
  `harnesses/registry.json`, adapted by `orchestrator/harnesses/adapters.ts`, built by `orchestrator/images/`. The
  admin Compute page reads `src/compute*.ts`; failure classes are `src/error-classes.ts`.
- **Generalised by.** mold_v0-041, **built** (a generic `runs` and `run_results` model beside the session queue, a
  workspace-harness runner, per-kind token lifetime and budget, cost per run from gateway usage, the per-run egress
  allowlist under test; `src/runs.ts`, `src/run-harness.ts`, `/api/worker/runs`), mold_v0-061, **built** (the agent-workspace
  runner: an agent repository at a pinned commit, a declared command, validation and write-back; `src/agent-workspace.ts`),
  mold_v0-055, **built** (runs carried out in sandboxes the autoscaler launches, one per run, in the provider the
  product already uses, or a container per run from the compose runner service; direct egress firewalled by the run
  user's uid; a token bound to each run; `src/run-sandboxes.ts`, `src/run-sandbox-runner.ts`),
  mold_v0-064, **built** (a pack's hook after a workspace commit, before results are checked), mold_v0-065, **built** (a
  finding fingerprint in a result's identity; drop or downgrade an unresolved reference per kind), mold_v0-018, **built** (concurrency per workspace and kind at claim, the kind's month budget per workspace at
  start and in the gateway, a run's budget, all clamped to the platform's ceilings; `src/run-limits.ts`). Run kinds come from
  packs (mold_v0-038).

### Inference gateway and metering

- **Today.** `/gw/:provider` in `src/http.ts`, handled by `src/gateway.ts`: per-session and per-orchestrator tokens
  (`gateway_tokens`), the credential broker, session and org budgets. Providers include `src/vertex.ts`. Each request
  is priced by `src/usage.ts` from `model_prices` into `gateway_usage` and `gateway_model_usage`; model spend for
  admins is `src/spend.ts` and `src/spend-usage.ts`; per-account budgets and throughput are `src/limits.ts`.
- **Generalised by.** mold_v0-041, **built** (token lifetime per run kind, so a long run's token does not expire
  mid-run; cost per run; a run's budget across its attempts), mold_v0-053, **built** (run spend in the account's month figures, budgets and spend pages; `src/run-spend.ts`),
  mold_v0-008, **built** (usage pages per run, member and workspace, in neutral words: `src/usage-report.ts`,
  `/api/usage`, `/app/activity`, `/admin/activity`).

### Vaults, including per-workspace credentials

- **Today.** The platform key vault (`src/keyvault.ts`, `vault_providers` and `vault_credentials`, AES-256-GCM with a
  versioned master key, rekey) holds provider keys; `src/keyvault-env.ts` imports old environment keys once.
  Per-org data keys (`src/orgcrypto.ts`, `org_keys`) seal an org's private text at rest.
- **Generalised by.** mold_v0-034, **built** (the workspace credential vault: fields a pack declares, bound to a
  workspace, an asset or an environment, sealed with the workspace data key, written in the console with only the
  last 4 characters shown, injected into a run by name only for its target; a canary test finds no value in events,
  results, logs, the database, the store or MCP output; `src/credentials.ts`, `workspace_credentials`),
  mold_v0-014 (repository access by a GitHub App per workspace, later).

### Storage and the workspace store

- **Today.** Object storage is one private bucket through `src/storage.ts` (layout in `docs/storage.md`);
  `src/archive.ts` copies finished traces and research there. Raw transcripts are `src/transcripts.ts` (ClickHouse,
  or `transcript_events` in Postgres for local runs). `src/db.ts` is the query interface over Postgres or an embedded
  one for tests. A run's working files live and die with its sandbox.
- **Generalised by.** mold_v0-033, **built** (a workspace store: versioned per-workspace snapshots with a sha256
  manifest, sealed with the workspace data key, checked out before a run, written back only when the run's validation
  passes, one writer per workspace under a lease; `src/workspace-store.ts`, `src/storage.ts` `objectStore()`).

### Record areas

A record area is a kind of record a pack declares, with a **role** and a **scope**:

| Role | What it is | Typical scope |
|---|---|---|
| `source` | where requirements come from; read, versioned, not edited by customers | `platform` (shared, read-only to customers) |
| `check` | a unit checked again and again, traced to a source | library at `platform`, its state (applicability, status, due date) per `workspace` |
| `asset` | the thing being checked, holding the workspace's private data | `workspace` only, sealed with the workspace key |

A run takes a scope (sources, checks) and targets (assets) and yields `run_results` rows (run, workspace, check, asset,
status, finding fingerprint, evidence reference).

- **Today.** The product has two record areas, built by hand: **personas** (`developer_profiles`, `product_personas`)
  and **tasks** (`library_tasks`, `scenarios`, `org_task_sets`), each a shared library (rows with no org) plus an org's
  private rows (since mold_v0-039 the host pack's `server/library.ts`, `server/private.ts`, sealed by the shell's
  `src/orgcrypto.ts`), seeded from the pack's `vault/` by its `server/vault.ts`. The console already has a generic table and side peek (`web/src/components/layout/record-view.tsx`,
  `record-filters.tsx`).
- **Generalised by.** mold_v0-047, **built** (the shell's record areas: a pack declares one and gets a list page, a
  detail page and MCP list/get with no extra code; workspace scope under row-level security; platform scope read-only
  to customers; `src/record-areas.ts`, `platform_records`, `workspace_records`), mold_v0-039 (personas and tasks leave the shell for the `octillion` pack), mold_v0-048 (the second app's areas, on
  this contract), mold_v0-066 and 059, **built** (sealed areas, keys with ( and ), batch writes; the generic data API
  and data repositories: `src/data-api.ts`, `src/data-repositories.ts`).

### Schedules and notifications

- **Today.** Background loops started in `src/http.ts` on a server (the autoscaler, the archiver), and on Vercel one
  cron in `vercel.json` (`/api/cron/autoscale`, guarded by `CRON_SECRET`). Transactional email is `src/email.ts`
  through one provider (`email_log`); daily spend alerts use `usage_alerts`; in-client tips come from
  the product's journeys (its host pack's `server/journeys.ts` since mold_v0-039). There were no per-workspace schedules before mold_v0-035.
- **Generalised by.** mold_v0-035 (built): per-workspace schedules with defaults from the pack, editable by owners in
  the console, a missed tick run at most once, ticked from the existing cron entry on Vercel and a one-minute loop on a
  server (`src/schedules.ts`, `src/cron.ts`, `src/schedule-routes.ts`, `sql/migrations/0008_schedules.sql`); due-date
  alerts for check records in-app (`/app/notices`) and by email (`due_soon` in `email_log`), once a day.

### Console framework

- **Today.** `web/` is a server-rendered Next.js app: `/admin` (platform staff, `web/src/app/admin/`) and `/app` (an
  account's people, `web/src/app/app/`), with the sidebar from `web/src/config/nav-config.ts`, layout and shared
  components under `web/src/components/layout/` and `web/src/components/ui/`, and pages under `web/src/features/`. The
  API side is `src/app.ts` (`/api/app`) and `src/admin.ts` (`/api/admin`). Observability is `src/otel.ts`; product
  analytics `src/telemetry.ts`.
- **Generalised by.** mold_v0-038 (done: pack pages in the sidebar and on a generic page, `web/src/app/{app,admin}/packs/`,
  pack routes at `/api/packs/<id>` and `/api/admin/packs/<id>`, the console title from the profile),
  mold_v0-063, **built** (metrics and charts from pack.json, computed per workspace under row-level security:
  `src/metrics.ts`, `/api/metrics`, `web/src/features/tabs/charts.tsx`), mold_v0-058, **built** (the /app sidebar and
  tabs from pack.json: overview, a record area's table, board, timeline and detail, runs, reports and the shell's own
  pages; zero packs or no tabs leave the sidebar as it was), mold_v0-020 (the server target serves the console: the `Dockerfile` copies a `/web/out` the console's build never
  writes).

### Onboarding

- **Today.** The `/app` setup checklist with a live connection test (`src/app.ts`, `web/src/features/portal/setup.tsx`),
  the product's playbooks and journeys (its host pack's since mold_v0-039), and the access-request funnel on `/admin`
  (`src/admin.ts`, `web/src/features/admin/requests.tsx`). Its steps are the product's own.
- **Generalised by.** mold_v0-011, **built** (an onboarding checklist from pack-declared steps, each read per
  workspace from its own events and rows, shown on the Setup page; zero packs leave the page unchanged;
  `src/onboarding.ts`).

### Billing and email (optional)

- **Today.** Stripe is the system of record (`src/billing.ts`, `src/plan-config.ts`, `src/experiments.ts`,
  `src/revenue.ts`), off unless its keys are set; email is `src/email.ts`, off without its key.
- **Generalised by.** mold_v0-019 (a billing usage event per finished run, off by default). Both stay optional: a
  shell with neither still signs in (through the sign-in adapter) and runs.

### Profile and brand

- **Today.** None: the product's name is in code (the MCP server name in `src/server.ts`, the email sender default in
  `src/settings.ts`, the console title in `web/src/app/layout.tsx`, `web/src/app/manifest.ts`, the icons under
  `web/src/app/`, the theme in `web/src/components/themes/`), and many environment names carry it.
- **Generalised by.** mold_v0-038 (done: server name, email sender and console title from `profile.json` over a neutral
  default, `src/profile.ts`; pack profile words, such as "workspace" shown as "company", are declared and validated, and
  applied with mold_v0-045), mold_v0-024 (the factory's mold_v0 brand rules: name, colour and logo, the
  three-input brand every app gets before its first deploy), mold_v0-045 (neutral words and environment names, old
  names still accepted, with a vocabulary check).

### How the profile maps to app state

| Profile | Application state |
|---|---|
| product name, colour, logo | `surface.branding` (filled by `branding.py`) |
| packs | `packs` in `application.json` |
| sign-in adapter, optional billing and email | the deploy's environment names, checked by name by `provision.py`; a state field for the adapter comes with mold_v0-024 |
| pack profile words | the pack's own profile file, applied by `packs.py` |

## What is product surface (pack), not shell

**Moved by mold_v0-039** into the factory's host pack `octillion` (`packs/octillion/` at the factory root, git-ignored
like every pack; MOLD.md "Host packs"). A build with no packs has none of it; a build with `["octillion"]` has all of it,
at the same paths and with the same MCP surface. Paths below are where each now lives in a build copy.

- **Tools.** The 31 tools (`get_started`, `onboard_product`, `run_simulation`, `get_visibility_report`,
  `search_transcripts`, `save_personas`, `browse_task_library`, `save_to_memory` and the rest), their slash commands, the
  dashboard widget and the server's instructions: `packs/octillion/server/tools.ts`, `server/ui/widget.html`; their
  queries `server/queries.ts`; the admin MCP's `library_stats`: `server/admin-tools.ts`.
- **Domain code.** Scoring and its hooks (`server/scoring.ts`, `server/sessions.ts`, `server/reasons.ts`,
  `server/visibility.ts`), product research and prospects (`server/research.ts`, `server/prospect.ts`,
  `server/websearch.ts`, `server/registry-meta.ts`), task adaptation and platforms (`server/adapt.ts`,
  `server/platform.ts`), developer populations and the agent mix weighted by real-world use (`server/populations.ts`; the
  harness registry itself, `harnesses/registry.json` with `src/agents.ts`, stays in the shell, and with no host pack the
  engine schedules by it: `src/agent-mix.ts`), context and memory (`server/context.ts`), library contributions
  (`server/contributions.ts`), playbooks and journeys (`server/playbooks.ts`, `server/journeys.ts`), the product's
  settings (pack.json `settings` since mold_v0-140), its portal, admin, worker and public routes (`server/portal.ts`,
  `server/http-routes.ts`), all wired by `packs/octillion/host.ts`. The generic one-model call it used moved to the shell
  (`src/ask-model.ts`), as did the model keys and sandbox provider pages' API (`src/platform-keys.ts`).
- **Orchestrator extension.** The Pi orchestrator that answers as a simulated developer:
  `orchestrator/packs/octillion/` (run by `orchestrator/main.ts`), with its tests. The starter projects in
  `orchestrator/workspaces/` stay with the session engine: neutral framework starters it seeds sandboxes from.
- **Record areas.** Personas and tasks (`server/library.ts`, `server/private.ts`, `server/vault.ts`, the curated vault
  `packs/octillion/vault/`) and their pages, over the product's own tables (not the shell's record store): declaring them
  as record areas would add MCP tools and empty pages, so the surface would not be the product's.
- **Tables** (mold_v0-049). The product's 24 tables (`products`, `scenarios`, `simulations`, `agent_sessions` with their
  verdicts, `transcript_events`, `product_research`, `developer_profiles`, `library_tasks`, `product_personas`,
  `developer_populations` and their agents, `library_submissions`, `visibility_reports`, context and memory, journeys,
  nudges, task sets and private harnesses) are the pack's own migrations (`packs/octillion/migrations/`), under the names
  they had, by the host-pack schema allowance (MOLD.md "Host packs": `host.schema`); a database built before keeps
  them and its rows (the pack adopts what the earlier base schema made). The admin MCP's job tools named for them
  (`list_simulations`, `get_simulation`, `cancel_simulation`) are the pack's (`server/admin-tools.ts`).
- **Console pages.** Pick rate (with its report), context (company, users, products), journeys, developer personas and
  programming tasks on /app; personas, tasks, journeys and the harness mix on /admin (agent configuration, every
  global setting, stays the shell's page):
  `web/src/packs/octillion/` (pages, features, `routes.json`), at their old URLs; its sidebar entries, redirects, Setup
  page (steps, workflow, error hints), admin MCP words and account-stage words are pack.json config since mold_v0-140
  and mold_v0-121 (`console`, `setup`, `mcp.error_hints`, `admin_mcp`, `account_stages`).
- **Landing.** The landing page, its layout and early access (`web/src/packs/octillion/pages/site/`, `features/site/`),
  and the API host's `index.html` and `connect.html` (`packs/octillion/public/`).
- **Docs.** The customer guide and the product's internal docs and case studies, as config since mold_v0-139 (its
  pack.json `guide` and `staff_docs`), the README.
- **Other.** The client skill (`packs/octillion/integrations/claude-skill/octillion/`, the download in
  `packs/octillion/public/downloads/`), the operator scripts and the product's own smoke test and connector check
  (`packs/octillion/scripts/`: `npm run pack:run -- <script>`).
- **Still in the shell.** The session engine that reads the product's tables in a build that has them (the job queue's
  claim, the autoscaler's simulation and research jobs, the Compute, Accounts, Usage and Billing pages' figures over
  sessions; dormant with no host pack, `src/host-tables.ts`), the library submission emails and credits (`src/email.ts`,
  `src/billing.ts`), and the product's name in some console text, environment names and the default icons (mold_v0-045).

The second app, an audit-agent pack, is built on the same contract and changes nothing above (mold_v0-044, 048): its
runner, run kinds, tools, pages and record areas are its own pack.

## Security requirements

- **Workspace isolation.** Every workspace-owned row is scoped to its workspace, under row-level security that fails
  closed when no workspace is set, with the app connecting as a non-owner role (mold_v0-031). A workspace never reads
  another's rows, snapshots, credentials, transcripts or results; the context lane proves it with two workspaces.
- **Credentials.** Platform keys and workspace credentials are sealed at rest under versioned keys, write-only from
  the browser (only the last four characters shown), injected into a run by name only and never into a harness that
  can print them; a harness reaches models only with its gateway token. The factory handles secret names only.
- **Runs.** A run's sandbox reaches only its allowlisted hosts; customer text in prompts is data, never instructions
  (`orchestrator/core/text-guard.ts`); a run writes back to the workspace store only when its validation passes.
- **Keys and tokens.** Keys never in URLs, hashed, named, revocable, expiring; OAuth tokens checked for audience and
  expiry; `Origin` validated on `/mcp` (mold_v0-031, 007, 013).
- **Admin surface.** Platform staff only, every change audit-logged (`admin_access_log`).

## Out of scope

- Running a client's local process, or another company's MCP server (this is not a proxy).
- Vendoring or patching a pack's upstream: a pack pins it and runs it at a process boundary.
- A built-in payment provider: billing stays optional.
- An on-premises runner for private networks (later, mold_v0-036).
