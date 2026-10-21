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
  (`src/auth.ts`, `src/queries.ts`); `scripts/check-tenant-sql.ts` (with `scripts/tenant-sql-baseline.json`) refuses
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
  under `/.well-known`); the tool registry is `src/server.ts`, which registers the product's 31 tools by hand; a stdio
  entry for local hosts is `src/stdio.ts`; the inline dashboard widget is `src/ui/widget.html`. Hashed per-org keys are
  `api_keys` (`sql/schema.sql`). Per-call activity (method, tool, outcome, latency, never arguments or results) is
  `src/analytics.ts` (`mcp_events`). A second MCP server for platform staff is `src/admin-mcp.ts`. Per-client install
  guides come from `src/connect-catalog.ts`.
- **Generalised by.** mold_v0-038 (done: pack tools register after the shell's from the registry `gen-packs.mjs`
  generates, `src/packs.ts`; the server name comes from the profile; the shell's own 31 tools stay in `src/server.ts`
  until mold_v0-039), mold_v0-007 (keys header-only, named, revocable, expiring), mold_v0-013 (a built-in MCP OAuth server when
  Clerk is off), mold_v0-010 (install guides from the profile, tool docs from the registry), mold_v0-018 (MCP rate
  limits).

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
  allowlist under test; `src/runs.ts`, `src/run-harness.ts`, `/api/worker/runs`), mold_v0-018 (concurrency per workspace and run budget per run kind). Run kinds come from
  packs (mold_v0-038).

### Inference gateway and metering

- **Today.** `/gw/:provider` in `src/http.ts`, handled by `src/gateway.ts`: per-session and per-orchestrator tokens
  (`gateway_tokens`), the credential broker, session and org budgets. Providers include `src/vertex.ts`. Each request
  is priced by `src/usage.ts` from `model_prices` into `gateway_usage` and `gateway_model_usage`; model spend for
  admins is `src/spend.ts` and `src/spend-usage.ts`; per-account budgets and throughput are `src/limits.ts`.
- **Generalised by.** mold_v0-041, **built** (token lifetime per run kind, so a long run's token does not expire
  mid-run; cost per run; a run's budget across its attempts), mold_v0-008 (usage pages per run, member and workspace, in neutral words).

### Vaults, including per-workspace credentials

- **Today.** The platform key vault (`src/keyvault.ts`, `vault_providers` and `vault_credentials`, AES-256-GCM with a
  versioned master key, rekey) holds provider keys; `src/keyvault-env.ts` imports old environment keys once.
  Per-org data keys (`src/orgcrypto.ts`, `org_keys`) seal an org's private text at rest. There is no store yet for a
  workspace's own credentials (keys it gives the product to reach its systems).
- **Generalised by.** mold_v0-034 (a workspace credential vault: fields a pack declares, bound to a workspace, an
  asset or an environment, sealed with the workspace data key, injected into a run by name only, a canary test that
  finds no value in transcripts, logs or MCP output), mold_v0-014 (repository access by a GitHub App per workspace,
  later).

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
  private rows (`src/library.ts`, `src/private.ts`, sealed by `src/orgcrypto.ts`), seeded from `vault/` by
  `src/vault.ts`. The console already has a generic table and side peek (`web/src/components/layout/record-view.tsx`,
  `record-filters.tsx`).
- **Generalised by.** mold_v0-047, **built** (the shell's record areas: a pack declares one and gets a list page, a
  detail page and MCP list/get with no extra code; workspace scope under row-level security; platform scope read-only
  to customers; `src/record-areas.ts`, `platform_records`, `workspace_records`), mold_v0-039 (personas and tasks leave the shell for the `octillion` pack), mold_v0-048 (the second app's areas, on
  this contract).

### Schedules and notifications

- **Today.** Background loops started in `src/http.ts` on a server (the autoscaler, the archiver), and on Vercel one
  cron in `vercel.json` (`/api/cron/autoscale`, guarded by `CRON_SECRET`). Transactional email is `src/email.ts`
  through one provider (`email_log`); daily spend alerts use `usage_alerts`; in-client tips come from
  `src/journeys.ts`. There are no per-workspace schedules.
- **Generalised by.** mold_v0-035 (per-workspace schedules with defaults from the pack, editable in the console, a
  missed tick run at most once; due-date alerts in-app and by email).

### Console framework

- **Today.** `web/` is a server-rendered Next.js app: `/admin` (platform staff, `web/src/app/admin/`) and `/app` (an
  account's people, `web/src/app/app/`), with the sidebar from `web/src/config/nav-config.ts`, layout and shared
  components under `web/src/components/layout/` and `web/src/components/ui/`, and pages under `web/src/features/`. The
  API side is `src/app.ts` (`/api/app`) and `src/admin.ts` (`/api/admin`). Observability is `src/otel.ts`; product
  analytics `src/telemetry.ts`.
- **Generalised by.** mold_v0-038 (done: pack pages in the sidebar and on a generic page, `web/src/app/{app,admin}/packs/`,
  pack routes at `/api/packs/<id>` and `/api/admin/packs/<id>`, the console title from the profile),
  mold_v0-020 (the server target serves the console: the `Dockerfile` copies a `/web/out` the console's build never
  writes).

### Onboarding

- **Today.** The `/app` setup checklist with a live connection test (`src/app.ts`, `web/src/features/portal/setup.tsx`),
  playbooks (`src/playbooks.ts`), journeys (`src/journeys.ts`), and the access-request funnel on `/admin`
  (`src/admin.ts`, `web/src/features/admin/requests.tsx`). Its steps are the product's own.
- **Generalised by.** mold_v0-011 (an onboarding checklist from pack-declared steps, ticking itself off from real
  events).

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

These leave the shell for `packs/octillion` (mold_v0-039, tables by mold_v0-049). After that, a build with no packs
has none of them, and a build with `["octillion"]` has all of them, proved by an empty surface diff.

- **Tools.** The 31 tools registered in `src/server.ts` (`get_started`, `onboard_product`, `run_simulation`,
  `get_visibility_report`, `search_transcripts`, `save_personas`, `browse_task_library`, `save_to_memory` and the rest),
  their queries (`src/queries.ts`) and the widget (`src/ui/widget.html`).
- **Domain code.** Scoring and its hooks (`src/scoring.ts`, `src/reasons.ts`, `src/visibility.ts`), product research and
  prospects (`src/research.ts`, `src/prospect.ts`, `src/websearch.ts`, `src/registry-meta.ts`), task adaptation and
  platforms (`src/adapt.ts`, `src/platform.ts`), developer populations and the agent mix weighted by real-world use (`src/populations.ts`;
  the harness registry itself, `harnesses/registry.json` with `src/agents.ts`, stays in the shell), context and memory (`src/context.ts`), library contributions
  (`src/contributions.ts`), the product's playbooks in `src/playbooks.ts`.
- **Orchestrator extension.** `orchestrator/pi-octillion/` (the Pi orchestrator that answers as a simulated developer)
  and the starter projects in `orchestrator/workspaces/`.
- **Record areas.** Personas and tasks (`src/library.ts`, `src/private.ts`, `vault/`, `src/vault.ts`) and their pages
  (`web/src/app/admin/personas/`, `web/src/app/admin/tasks/`, `web/src/app/app/personas/`, `web/src/app/app/tasks/`).
- **Console pages.** Pick rate (`web/src/app/app/pick-rate/`, `web/src/features/portal/pick-rate.tsx`,
  `visibility.tsx`, `adoption.tsx`), context (`web/src/app/app/context/`), and the admin pages for the agent mix
  (`web/src/app/admin/agents/`).
- **Landing.** `public/index.html`, `public/connect.html`, `web/src/app/(site)/` and `web/src/features/site/`.
- **Tables.** `products`, `scenarios`, `simulations`, the verdict columns of `agent_sessions`, `product_research`,
  `developer_profiles`, `library_tasks`, `product_personas`, `developer_populations`, `library_submissions`,
  `visibility_reports` and the other product-only tables in `sql/schema.sql` (mold_v0-049).
- **Other.** The client skill (`integrations/claude-skill/octillion/`, `public/downloads/octillion-skill.zip`) and the
  case studies under `docs/case-studies/`.

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
