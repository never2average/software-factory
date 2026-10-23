# mold_v0

**Status:** work in progress. Started as a verbatim snapshot of the operator's existing MCP product, by the operator's decision (2026-10-20): *clone first, generalise after*. **Authored in this repository since the fork point below** (operator decision D1, 2026-10-20; mold_v0-040).

**Source: in-tree.** `molds/mold_v0/codebase` is edited here, by pull request to this repository like any other file. The fork point is factory commit `e8d836532cb7` (the last refresh, which took in the product's hardening, mold_v0-031), a snapshot of the product at `7399bd4c3611` (snapshot 2026-10-21). Both are recorded in [mold.json](mold.json) (`source`: `in_tree`, `since`, `forked_from`) and in `state/factory.json` (`molds[mold_v0].source.in_tree`, `in_tree_since`). Nothing is fetched from the product's repository again: `mold.py refresh mold_v0` refuses, `mold.py fetch mold_v0` writes nothing, and `mold.py check mold_v0` reports "in-tree since e8d836532cb7", the last commit that changed the codebase and any uncommitted change under it. An app's `mold_commit` is the last commit of this repository that changed the codebase (the fork point reads as `7399bd4`, the same files), so `mint` shows a redeploy due after each merged change.

## Two recorded exceptions

**Edited in place (mold_v0-040).** AGENTS.md says a mold's codebase is never edited in place and base-code changes go to the mold's source by pull request. mold_v0 is the one exception: its source is this repository. A change to the shell is a pull request here that touches `molds/mold_v0/codebase`; the deploy gate then reads this repository's checks for the commit being deployed (below). mold_v1 keeps the rule unchanged: its snapshot is only ever written by `mold.py fetch|refresh` from its own source, and nothing in this exception reads or writes it.

**A product, being made a general shell.** Molds are general-purpose: no product or customer words, apps declared through a profile and packs. mold_v0 started as the opposite, a working product copied as it is, so the factory could reproduce it straight away (ticket mold_v0-029) and mint a second product from it (mold_v0-030). It becomes general step by step: [SCOPE.md](SCOPE.md) names each capability of the **agent-run shell**, where it lives and the ticket that generalises it (mold_v0-038 to 050, with the surviving older tickets). Since mold_v0-039 the product's own surface (its 31 MCP tools, widget and slash commands, its domain modules, its routes, console pages, landing page, docs, orchestrator extension, client skill and operator scripts) is the factory's **host pack `octillion`** (`packs/octillion/`, git-ignored like every pack: "Host packs" below), and an app minted from mold_v0 with no packs gets a neutral shell. Since mold_v0-049 its tables are the pack's own migrations too: a shell with no packs has none of them. What still carries the product in the shell: the session engine that reads those tables in a build that has them (the job queue, the autoscaler's jobs, the Compute and Accounts pages; dormant without them). Its name left the shell's words and environment names in mold_v0-045 ("Neutral words and environment names" below): what is left of it is listed, with what holds each, in the vocabulary check's allow list.

## What is in it today

- A TypeScript server (Express, `src/http.ts`) with a stateless MCP endpoint (`/mcp`: the host packs' tools, then every pack's, `src/server.ts`), per-organisation API keys (hashed) and per-member keys (header-only, expiring, with the member's role; mold_v0-007), sign-in (built-in emailed code and Google, or Clerk; mold_v0-004), client install guides, onboarding, usage analytics, billing and email.
- An agent-run engine: a job queue (`src/worker.ts`, `/api/worker`), an autoscaler that launches one sandboxed orchestrator per job (`src/autoscaler.ts`, `orchestrator/`), pinned coding-agent harnesses (`harnesses/registry.json`), an inference gateway with per-session tokens and cost metering (`src/gateway.ts`, `src/usage.ts`), a versioned key vault and per-organisation data keys (`src/keyvault.ts`, `src/orgcrypto.ts`), transcripts and an off-machine archive.
- A web console in `web/` (Next.js): `/admin` for platform staff, `/app` for an account's people.
- Postgres with versioned migrations (`sql/migrations/NNNN_*.sql`, `src/migrate.ts`, `npm run db:migrate`; proven by `npm run test:migrations`) and row-level security on every tenant table (`sql/migrations/0003_row_level_security.sql`, `src/rls.ts`; proven by `npm run check:rls`), plus optional analytics and archive stores.
- Two ways to run: its own server (Docker Compose with HTTPS) and Vercel.

## Hardening (ticket mold_v0-031, done)

API keys out of URLs, OAuth token audience checked, Origin validated on the MCP endpoint, no static admin token, database row-level security proven on every deploy, and versioned migrations: all in the codebase since the fork point. The factory's side of it is mold_v0-051 (intake, the deploy's RLS check, the lanes; below).

## Neutral words and environment names (mold_v0-045)

**Environment names.** Every variable the shell reads is `APP_` and a name (`APP_VAULT_KEY`, `APP_WORKER_TOKEN`,
`APP_PROXY_HOPS`, ...): short, the factory's own word for what it mints, and no clash with the shell's `SHELL` or a
product's name. Until mold_v0-045 they had the first product's prefix, and apps deployed before then (the re-mint
`octillion`, Maxwell) hold their values under those names on Vercel or in a server's env file: **each old name is still
read, as a fallback** (`src/env-names.ts`, the code in `orchestrator/core/env-names.ts`, which the orchestrator and the run
sandbox runner carry). The new name wins when both are set; reading an old name logs one line per name and process
(`[env] <old> is a deprecated name, read as a fallback for <new>`), and an old name set beside a different new value logs
that it is ignored. The server reads through `ENV` (a live view of `process.env`: a value set later, as tests do, is
seen), any other environment through `appEnv(source)`; writes and the environments the shell builds for its children
(the orchestrators' env file, a run sandbox's) use the new names only, and the children read both. The console's API
address is read the same way (`web/src/lib/env-names.ts`, `web/next.config.ts`). A host pack written before then may
read some names itself under the old spelling: in a build with a host pack (`src/host-env.ts`, imported first by the
generated host list) every `APP_` name is also set under its old spelling, to the same value. The image env a coding
agent's sandbox may never see is filtered on both spellings (`orchestrator/core/runners.ts`).

What is kept as written, because something outside the release holds it (the vocabulary check's allow list says what):
the session engine's four platform settings keep their stored keys (`src/settings.ts` `ENGINE_SETTINGS`: rows on live
databases and the host pack read them by name; their environment value is read under the `APP_` name first); the database's
row-level security functions, tenant role and setting (`sql/migrations` made them and every policy names them); the agent
images' tags and boat templates (built, pinned in `harnesses/registry.json`); the orchestrator sandboxes' service unit,
home and host marker (running sandboxes hold them, and the next release stops and restarts those).

**The factory's side.** `mold.json` `env_names` declares the prefix and the old one. For a **new** app the factory reads
the new names from the codebase as before (the compose file, `deploy/bootstrap.sh`, the console's `next.config.ts`,
`mold.json` settings), so intake writes `APP_VAULT_KEY`, `APP_WORKER_TOKEN`. An **existing** app is left as it is: its
state's names (`OCTILLION_VAULT_KEY`, ...) stay its secrets, a value held under the old name counts as present (never minted
again under the new one, which would win over it), a value minted for a state name in the old spelling is the bootstrap's
new one, and `--set-secret` takes the old names. On a server, the deploy's env step copies each old name's value to its new
name once, before anything is minted (`lib/single_service.py` `server_env`), and `deploy/bootstrap.sh` does the same for a
hand-made `.env`. Nothing on Vercel is renamed: the API reads the old names, and the factory writes only its own
settings (`APP_CONSOLE_URL`, `APP_PROXY_HOPS`, the console's `APP_API_URL`) beside them at the next deploy.

**Words.** The shell's text names the build by its profile (`PROFILE.name`, "Workspace" with no packs), and what it writes
into Stripe and Clerk (lookup keys, metadata keys, meter names), its telemetry names, its default ClickHouse database and
its run sandboxes' labels use the build's namespace (`src/namespace.ts`: the MCP server name, `workspace` with no packs), so
a build with the host pack `octillion` keeps every key it wrote. The admin console's CSRF header is `X-App-Admin` (the
namespace's old header is still accepted, so a console deployed before the API keeps working). The self-hosted stack's
compose project, API service, database and backups are `app` and `api`.

**The vocabulary check** (`npm run check:vocabulary`, also run by the smoke test; `npm run test:vocabulary` proves it)
fails when a product word (`scripts/vocabulary.json` `words`) is in a file of the shell, in its text or its path, outside
the allow list, where each entry is an exact spelling, the files it may be in and what holds it; an entry that covers
nothing fails too. A pack's own files are not read. It also checks the table below, which it writes
(`npm run check:vocabulary -- --write`) from every `APP_` name in the shell's code and deploy files.

<!-- env-names:begin (generated by `npm run check:vocabulary -- --write` in the codebase; do not edit) -->

140 names. The old name is read only when the new one is unset (src/env-names.ts); a family (`*`) is every name with that start.

| Old name (still read) | Name |
|---|---|
| `OCTILLION_ADMIN_TOKEN` | `APP_ADMIN_TOKEN` |
| `OCTILLION_AGENT_REPO_HOSTS` | `APP_AGENT_REPO_HOSTS` |
| `OCTILLION_ALERT_WEBHOOK_URL` | `APP_ALERT_WEBHOOK_URL` |
| `OCTILLION_ALLOW_UNSANDBOXED_RUNS` | `APP_ALLOW_UNSANDBOXED_RUNS` |
| `OCTILLION_API_KEY` | `APP_API_KEY` |
| `OCTILLION_API_URL` | `APP_API_URL` |
| `OCTILLION_ARCHIVE` | `APP_ARCHIVE` |
| `OCTILLION_ARCHIVE_BATCH` | `APP_ARCHIVE_BATCH` |
| `OCTILLION_ARCHIVE_INTERVAL_SECONDS` | `APP_ARCHIVE_INTERVAL_SECONDS` |
| `OCTILLION_AUTH_ORIGINS` | `APP_AUTH_ORIGINS` |
| `OCTILLION_AUTH_SECRET` | `APP_AUTH_SECRET` |
| `OCTILLION_AUTOSCALE` | `APP_AUTOSCALE` |
| `OCTILLION_AUTOSCALE_TICK_SECONDS` | `APP_AUTOSCALE_TICK_SECONDS` |
| `OCTILLION_BOAT_NAMESPACE` | `APP_BOAT_NAMESPACE` |
| `OCTILLION_BUILD_CACHE_KEEP` | `APP_BUILD_CACHE_KEEP` |
| `OCTILLION_CONSOLE_URL` | `APP_CONSOLE_URL` |
| `OCTILLION_DATA_ALLOW_FILE_UPSTREAM` | `APP_DATA_ALLOW_FILE_UPSTREAM` |
| `OCTILLION_DATA_ALLOW_PRIVATE` | `APP_DATA_ALLOW_PRIVATE` |
| `OCTILLION_DEFAULT_SAMPLES` | `APP_DEFAULT_SAMPLES` |
| `OCTILLION_DEV_ALLOW_LOCAL` | `APP_DEV_ALLOW_LOCAL` |
| `OCTILLION_DEV_ENV` | `APP_DEV_ENV` |
| `OCTILLION_DIRECT_KEYS` | `APP_DIRECT_KEYS` |
| `OCTILLION_DOCKER_SOCKET` | `APP_DOCKER_SOCKET` |
| `OCTILLION_DRAIN_SECONDS` | `APP_DRAIN_SECONDS` |
| `OCTILLION_EGRESS` | `APP_EGRESS` |
| `OCTILLION_EMAIL_NOTIFICATIONS` | `APP_EMAIL_NOTIFICATIONS` |
| `OCTILLION_EMAIL_PROVIDER` | `APP_EMAIL_PROVIDER` |
| `OCTILLION_FLEET_STALE_SECONDS` | `APP_FLEET_STALE_SECONDS` |
| `OCTILLION_GATEWAY_MAX_COST_USD` | `APP_GATEWAY_MAX_COST_USD` |
| `OCTILLION_GATEWAY_MAX_REQUESTS` | `APP_GATEWAY_MAX_REQUESTS` |
| `OCTILLION_GATEWAY_MAX_TOKENS` | `APP_GATEWAY_MAX_TOKENS` |
| `OCTILLION_GATEWAY_TIMEOUT_MS` | `APP_GATEWAY_TIMEOUT_MS` |
| `OCTILLION_GATEWAY_URL` | `APP_GATEWAY_URL` |
| `OCTILLION_HARNESS` | `APP_HARNESS` |
| `OCTILLION_HOST_ROLE` | `APP_HOST_ROLE` |
| `OCTILLION_INTERNAL_URL` | `APP_INTERNAL_URL` |
| `OCTILLION_JOB_POD_CAPACITY` | `APP_JOB_POD_CAPACITY` |
| `OCTILLION_JOB_TOKEN_HOURS` | `APP_JOB_TOKEN_HOURS` |
| `OCTILLION_JOURNEY_SECRET` | `APP_JOURNEY_SECRET` |
| `OCTILLION_LEASE_MINUTES` | `APP_LEASE_MINUTES` |
| `OCTILLION_LIMIT_*` | `APP_LIMIT_*` |
| `OCTILLION_LIMIT_ENDPOINTS_*` | `APP_LIMIT_ENDPOINTS_*` |
| `OCTILLION_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE` | `APP_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE` |
| `OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE` | `APP_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS` | `APP_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_MCP_*` | `APP_LIMIT_MCP_*` |
| `OCTILLION_LIMIT_MCP_PER_KEY_PER_MINUTE` | `APP_LIMIT_MCP_PER_KEY_PER_MINUTE` |
| `OCTILLION_LIMIT_MCP_PER_MEMBER_PER_MINUTE` | `APP_LIMIT_MCP_PER_MEMBER_PER_MINUTE` |
| `OCTILLION_LIMIT_RUNS_BUDGET_USD_MAX` | `APP_LIMIT_RUNS_BUDGET_USD_MAX` |
| `OCTILLION_LIMIT_RUNS_CONCURRENCY_PER_WORKSPACE` | `APP_LIMIT_RUNS_CONCURRENCY_PER_WORKSPACE` |
| `OCTILLION_LIMIT_RUNS_KIND_MONTH_BUDGET_USD` | `APP_LIMIT_RUNS_KIND_MONTH_BUDGET_USD` |
| `OCTILLION_LIMIT_RUNS_LIVE_PER_WORKSPACE` | `APP_LIMIT_RUNS_LIVE_PER_WORKSPACE` |
| `OCTILLION_MAX_JOB_ORCHESTRATORS` | `APP_MAX_JOB_ORCHESTRATORS` |
| `OCTILLION_MAX_ORCHESTRATORS` | `APP_MAX_ORCHESTRATORS` |
| `OCTILLION_MAX_RUN_SANDBOXES` | `APP_MAX_RUN_SANDBOXES` |
| `OCTILLION_MAX_SAMPLES` | `APP_MAX_SAMPLES` |
| `OCTILLION_MAX_SESSIONS_PER_RUN` | `APP_MAX_SESSIONS_PER_RUN` |
| `OCTILLION_MAX_USER_TURNS` | `APP_MAX_USER_TURNS` |
| `OCTILLION_MCP_ALLOWED_ORIGINS` | `APP_MCP_ALLOWED_ORIGINS` |
| `OCTILLION_MIGRATE_ON_BOOT` | `APP_MIGRATE_ON_BOOT` |
| `OCTILLION_MIN_ONE_SANDBOX` | `APP_MIN_ONE_SANDBOX` |
| `OCTILLION_MODELS` | `APP_MODELS` |
| `OCTILLION_MODEL_DAILY_BUDGETS` | `APP_MODEL_DAILY_BUDGETS` |
| `OCTILLION_NUDGE_INTERVAL_HOURS` | `APP_NUDGE_INTERVAL_HOURS` |
| `OCTILLION_OAUTH_ACCESS_MINUTES` | `APP_OAUTH_ACCESS_MINUTES` |
| `OCTILLION_OAUTH_AUDIENCE` | `APP_OAUTH_AUDIENCE` |
| `OCTILLION_OAUTH_REFRESH_DAYS` | `APP_OAUTH_REFRESH_DAYS` |
| `OCTILLION_ORCH_BOOT_MINUTES` | `APP_ORCH_BOOT_MINUTES` |
| `OCTILLION_ORCH_IDLE_MINUTES` | `APP_ORCH_IDLE_MINUTES` |
| `OCTILLION_ORCH_LAUNCHES_PER_TICK` | `APP_ORCH_LAUNCHES_PER_TICK` |
| `OCTILLION_ORCH_PER_JOB` | `APP_ORCH_PER_JOB` |
| `OCTILLION_ORCH_SNAPSHOT` | `APP_ORCH_SNAPSHOT` |
| `OCTILLION_ORCH_STALE_MINUTES` | `APP_ORCH_STALE_MINUTES` |
| `OCTILLION_ORG_MONTHLY_BUDGET_USD` | `APP_ORG_MONTHLY_BUDGET_USD` |
| `OCTILLION_PLATFORM_ADMINS` | `APP_PLATFORM_ADMINS` |
| `OCTILLION_PODS_PER_ORCHESTRATOR` | `APP_PODS_PER_ORCHESTRATOR` |
| `OCTILLION_POD_CAPACITY` | `APP_POD_CAPACITY` |
| `OCTILLION_PREVIEW` | `APP_PREVIEW` |
| `OCTILLION_PROXY_HOPS` | `APP_PROXY_HOPS` |
| `OCTILLION_RECYCLE_ON_DEPLOY` | `APP_RECYCLE_ON_DEPLOY` |
| `OCTILLION_REGISTRY` | `APP_REGISTRY` |
| `OCTILLION_REQUIRE_SUBSCRIPTION` | `APP_REQUIRE_SUBSCRIPTION` |
| `OCTILLION_RESEARCH_STALE_MINUTES` | `APP_RESEARCH_STALE_MINUTES` |
| `OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE` | `APP_RUNS_MAX_LIVE_PER_WORKSPACE` |
| `OCTILLION_RUN_API_URL` | `APP_RUN_API_URL` |
| `OCTILLION_RUN_BILLING` | `APP_RUN_BILLING` |
| `OCTILLION_RUN_BOOT_MINUTES` | `APP_RUN_BOOT_MINUTES` |
| `OCTILLION_RUN_CACHE_DAYS` | `APP_RUN_CACHE_DAYS` |
| `OCTILLION_RUN_CACHE_DIR` | `APP_RUN_CACHE_DIR` |
| `OCTILLION_RUN_CACHE_MAX_BYTES` | `APP_RUN_CACHE_MAX_BYTES` |
| `OCTILLION_RUN_CHARGE_GRACE_SECONDS` | `APP_RUN_CHARGE_GRACE_SECONDS` |
| `OCTILLION_RUN_CPUS` | `APP_RUN_CPUS` |
| `OCTILLION_RUN_GID` | `APP_RUN_GID` |
| `OCTILLION_RUN_ID` | `APP_RUN_ID` |
| `OCTILLION_RUN_IMAGE` | `APP_RUN_IMAGE` |
| `OCTILLION_RUN_LAUNCHES_PER_TICK` | `APP_RUN_LAUNCHES_PER_TICK` |
| `OCTILLION_RUN_LAUNCH_ATTEMPTS` | `APP_RUN_LAUNCH_ATTEMPTS` |
| `OCTILLION_RUN_LAUNCH_BACKOFF_SECONDS` | `APP_RUN_LAUNCH_BACKOFF_SECONDS` |
| `OCTILLION_RUN_LOCKDOWN` | `APP_RUN_LOCKDOWN` |
| `OCTILLION_RUN_MAX_TOKENS` | `APP_RUN_MAX_TOKENS` |
| `OCTILLION_RUN_MEMORY_MB` | `APP_RUN_MEMORY_MB` |
| `OCTILLION_RUN_NETWORK` | `APP_RUN_NETWORK` |
| `OCTILLION_RUN_PACK_DIR` | `APP_RUN_PACK_DIR` |
| `OCTILLION_RUN_PIDS` | `APP_RUN_PIDS` |
| `OCTILLION_RUN_SAME_USER` | `APP_RUN_SAME_USER` |
| `OCTILLION_RUN_SANDBOX` | `APP_RUN_SANDBOX` |
| `OCTILLION_RUN_TOOLS_DIR` | `APP_RUN_TOOLS_DIR` |
| `OCTILLION_RUN_UID` | `APP_RUN_UID` |
| `OCTILLION_RUN_UIDS` | `APP_RUN_UIDS` |
| `OCTILLION_RUN_UID_DIR` | `APP_RUN_UID_DIR` |
| `OCTILLION_RUN_USER` | `APP_RUN_USER` |
| `OCTILLION_SANDBOX_UNIT` | `APP_SANDBOX_UNIT` |
| `OCTILLION_SCHEDULER` | `APP_SCHEDULER` |
| `OCTILLION_SCHEDULES_MAX_PER_WORKSPACE` | `APP_SCHEDULES_MAX_PER_WORKSPACE` |
| `OCTILLION_SELF_SERVE_ACCOUNTS` | `APP_SELF_SERVE_ACCOUNTS` |
| `OCTILLION_SESSION_DAYS` | `APP_SESSION_DAYS` |
| `OCTILLION_SESSION_INFRA_RETRIES` | `APP_SESSION_INFRA_RETRIES` |
| `OCTILLION_SESSION_TOKEN_MINUTES` | `APP_SESSION_TOKEN_MINUTES` |
| `OCTILLION_STORAGE_DIR` | `APP_STORAGE_DIR` |
| `OCTILLION_TRACEPARENT` | `APP_TRACEPARENT` |
| `OCTILLION_URL` | `APP_URL` |
| `OCTILLION_URL_KEYS` | `APP_URL_KEYS` |
| `OCTILLION_VAULT_KEY` | `APP_VAULT_KEY` |
| `OCTILLION_VAULT_KEY_PREVIOUS` | `APP_VAULT_KEY_PREVIOUS` |
| `OCTILLION_WORKER_TOKEN` | `APP_WORKER_TOKEN` |
| `OCTILLION_WORKSPACE_DIFF_MAX_BYTES` | `APP_WORKSPACE_DIFF_MAX_BYTES` |
| `OCTILLION_WORKSPACE_DOWNLOAD_MAX_BYTES` | `APP_WORKSPACE_DOWNLOAD_MAX_BYTES` |
| `OCTILLION_WORKSPACE_HOOK_SECONDS` | `APP_WORKSPACE_HOOK_SECONDS` |
| `OCTILLION_WORKSPACE_MAX_BUNDLE_BYTES` | `APP_WORKSPACE_MAX_BUNDLE_BYTES` |
| `OCTILLION_WORKSPACE_MAX_BYTES` | `APP_WORKSPACE_MAX_BYTES` |
| `OCTILLION_WORKSPACE_MAX_FILES` | `APP_WORKSPACE_MAX_FILES` |
| `OCTILLION_WORKSPACE_RETENTION` | `APP_WORKSPACE_RETENTION` |
| `OCTILLION_WORKSPACE_RETENTION_MAX_DAYS` | `APP_WORKSPACE_RETENTION_MAX_DAYS` |
| `OCTILLION_WORKSPACE_RETENTION_MAX_VERSIONS` | `APP_WORKSPACE_RETENTION_MAX_VERSIONS` |
| `OCTILLION_WORKSPACE_VIEW_CONCURRENCY` | `APP_WORKSPACE_VIEW_CONCURRENCY` |
| `OCTILLION_WORKSPACE_VIEW_MAX_BYTES` | `APP_WORKSPACE_VIEW_MAX_BYTES` |
| `OCTILLION_ZED_ACP` | `APP_ZED_ACP` |

<!-- env-names:end -->

## Decisions

- Sign-in for apps from the generalised shell: Clerk at launch, the adapter the product already uses (operator decision, 2026-10-20, mold_v0-046); a built-in emailed code plus Google comes later, with Clerk then optional (mold_v0-004).
- Sign-in, built (mold_v0-004, operator decision 2026-10-22): the default is the shell's own (`AUTH_PROVIDER=builtin`: an
  emailed one-time code and Google, people, sessions, members, roles and invitations in Postgres, `src/builtin-auth.ts`);
  Clerk is an optional adapter (`AUTH_PROVIDER=clerk`), kept unchanged for apps already on it: with `AUTH_PROVIDER` unset
  a server with `CLERK_SECRET_KEY` (a console with `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) runs Clerk. One adapter
  (`src/people.ts`, Clerk's shapes) serves the portal's and the admin console's sessions, team management, member keys
  and the workspace emails under either. Under the built-in sign-in the server is its own OAuth 2.1 authorization
  server for `/mcp` (mold_v0-013, `src/mcp-oauth.ts`), so connectors that only sign in connect; other MCP clients may use
  keys in a header (a member's own key, or the workspace's). `npm run test:sign-in` runs one suite through both
  adapters. Details: `codebase/docs/accounts.md`, "Sign-in: built-in or Clerk".
- The source has no licence constraints (a hackathon project).
- The operator's live copy moves to a factory-managed app through a new subdomain, two weeks side by side, then a public address switch only with the operator's yes (mold_v0-032).
- Generalisation (2026-10-20): mold_v0 becomes an **agent-run shell** (tenancy, an MCP front door, a run engine with sandboxed
  harness runs, an inference gateway with metering, vaults, storage, record areas, schedules, a console), with each product's own
  surface in a pack. The shell is authored **in this repository** (operator decision D1): after one last refresh that took in the
  product's hardening (mold_v0-031, factory commit `e8d836532cb7`), `molds/mold_v0/codebase` stopped being a snapshot and is edited
  here, a recorded exception to "never edit a mold in place" (mold_v0-040; see "Two recorded exceptions"). The product's own features become the pack `octillion`; the second app's is its own
  pack. Backlog: mold_v0-038 to 050.

## Pack and record-area contract

This is the seam the generalised shell exposes (mold_v0-038, record areas mold_v0-047, host packs mold_v0-039). **The
shell side is built**; the product's own surface is the host pack `octillion` since mold_v0-039, its tables its own
migrations since mold_v0-049 ("Host packs": its schema). The factory side is built too (mold_v0-024): `packs.py` applies a mold_v0 app's packs under the rules in
[mold.json](mold.json) `packs` (see "In the factory" below). What 038 wired, in `molds/mold_v0/codebase`:

- `scripts/gen-packs.mjs` (`npm run gen:packs`, `npm run check:packs`; the smoke test fails on a stale registry) reads
  every `packs/<id>/pack.json` and `profile.json` and writes `src/packs.generated.ts`, `src/pack-migrations.generated.ts`
  (the ordered pack migration directories), `src/profile.generated.ts`, `web/src/config/pack-nav.generated.ts` and
  `web/src/config/profile.generated.ts`. It refuses a pack whose SQL creates a table without row-level security or
  outside its `<id>_` names, writes grants, policies, roles, functions or DO blocks, or whose code imports any shell
  module but `src/pack-api.ts`, a database driver, or mentions `asPlatform`, `SET`/`RESET ROLE` or `set_config`
  (run programs under the pack's `runner` directory have their own rules: the runner boundary, mold_v0-054, below).
- `definePack` (`src/pack-api.ts`): **tools** register on the customer MCP server after the shell's (`src/packs.ts`),
  each call run for the calling workspace under row-level security with its account permission; **routes** mount at
  `/api/packs/<id>` (the portal's own session check, `edit` for changes, a CSRF header on cookie writes) and
  `/api/admin/packs/<id>` (inside the admin router: platform admin, `need(permission)` on every change, the access
  log); **migrations** run on `src/migrate.ts` after the shell's, recorded in `pack_schema_migrations`, each table
  secured by `shell_pack_tenant_table` (org_id NOT NULL, ON DELETE CASCADE, the workspace policy) or
  `shell_pack_private_table`, and `check:rls` checks every pack table's policy and probes it live; **pages** (in
  pack.json) appear in the `/app` or `/admin` sidebar and render through the shell's generic page from the pack's
  data route. Profile **words** are declared and validated and listed by `packRegistry()`. **credentials** (034),
  **onboarding** (011) and **schedules** (035) are wired (below).
- **recordAreas** (mold_v0-047, built): a pack declares areas in `definePack` and writes no record code. Their rows
  live in two shell tables (`sql/migrations/0004_record_areas.sql`): `platform_records` (platform scope: the tenant
  role may only `SELECT` it, so customers cannot write it whatever the code does; staff write it at
  `/api/admin/records` with `library`, or a pack's admin route through `ctx.records`) and `workspace_records`
  (workspace scope: `org_id` under the `tenant_isolation` policy; an `asset` area's title and data are sealed with the
  workspace data key). `src/record-areas.ts` adds `list_records` and `get_record` to the customer MCP server when at
  least one area exists (none with zero packs, so the surface is unchanged); `src/record-routes.ts` serves
  `/api/records` (signed-in people of the workspace, read only) to the console's generic pages
  (`web/src/app/{app,admin}/records/[area]` and `[area]/[key]`); `gen-packs` loads each pack's definition once (through
  tsx) to write the areas and a Records sidebar group into `pack-nav.generated.ts`. Area names are unique in a build
  and links must name a declared area (both refused at build and at start). Handlers get `ctx.records`: reads of every
  platform area and the workspace's own rows; writes only to the pack's own workspace areas (admin routes: its own
  platform areas). `check:rls` probes both tables; `npm run test:record-areas` proves it with two workspaces.
- **jobKinds** (mold_v0-041, built): the generic run engine, beside the product's session queue (which it does not
  change). `sql/migrations/0005_runs.sql` adds `runs`, `run_events` and `run_results` (each `org_id` under
  `tenant_isolation`; the tenant role may only read them) and a `run` gateway token kind (`gateway_tokens.run_id`,
  `gateway_usage.run_id`). A pack's handler queues a run of its own kind for the calling workspace with
  `ctx.runs.start(kind, {scope, targets})` (also `get`, `list`, `results`, `cancel`); the kind's limits are frozen into
  the run. `src/runs.ts`: claim (`FOR UPDATE SKIP LOCKED`, a lease token stored as a hash, a deadline = now + the kind's
  `token_lifetime_seconds`), heartbeat (renews the lease; answers cancel at a cancel or the deadline), events, complete
  (results checked: each names a check-role record, optionally an asset-role record of the run's own workspace and a
  source-role record), retry on an infrastructure failure while attempts remain, a sweep of lapsed leases, cancel
  (a running run's gateway tokens are revoked at once). Every step after the claim needs the current attempt's lease
  token. `src/run-routes.ts` serves it to runners at `/api/worker/runs` (the fleet token, then `X-Run-Lease`).
  `src/run-harness.ts` is the "workspace-harness" runner contract (claim, workspace checkout, the kind's `entry` with
  node in an environment built from nothing but `RUN_*` and the gateway's variables, heartbeat, the kind's `validator`,
  write-back, complete) with an in-process and an HTTP client. The gateway (`src/gateway.ts`) gives a run one token for
  the kind's providers that lives until the attempt's deadline, refuses it once the run is not running or its cost
  (summed from `gateway_usage.run_id` across attempts) reaches the kind's `budget_usd`, and the run's cost is that sum.
  Egress: the harness starts the sandboxes' own egress proxy (`orchestrator/core/egress.ts`) with the run's list (the
  kind's `egress` plus the gateway's public host; a listed host includes its subdomains, the proxy's rule) and gives the
  program its proxy settings: **enforced** for every connection through the proxy; a program that ignores proxy settings
  is stopped by the run sandbox's uid firewall (mold_v0-055, "Runs in sandboxes" below), not by the harness.
  The harness runs a kind's programs only as **a user of the run's own** (mold_v0-078, below; a runner started as root),
  never the runner's own: the program cannot read the runner's environment through `/proc`, gets its own copy
  of the pack and a private scratch, and every process of that user is killed when the run ends. It refuses to run a
  program as its own user unless told (`allowSameUser`, the offline tests). Starting a
  run applies the account's launch rules for a signed-in person (`src/limits.ts` `checkRun`) and a per-workspace cap
  on runs queued or running (`runs.live_per_workspace`, 20; below). In a deployed app runs are carried out in run
  sandboxes the autoscaler launches (mold_v0-055, below); `drainRuns` is the loop for a runner with the fleet token.
- **The agent-workspace runner** (mold_v0-061, built; `src/agent-workspace.ts`, its configuration
  `src/agent-workspace-config.ts`, carried out by `src/run-harness.ts`): a job kind with `runner: "agent-workspace"` has no
  program of the pack's own but an `agent` object, plain JSON (the same in pack.json `job_kinds` or `definePack({
  agentJobKinds })`): `repository` (https; a `file:///` mirror only on a runner told to accept one), `commit` (the full
  id: never a branch, tag or short id), `strip`, an optional `setup` command, `command` (an argument list, never a shell
  line) with `{placeholders}` filled from declared `args` (each from `scope.*`, `targets.*` or `run.id|attempt|kind`,
  with a `default` and a `pattern`; a value never starts with `-`), `env` (names it declares, values that may hold
  `{gateway.token}`, `{gateway.<provider>.base_url}`, `{gateway.url}`: so `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`
  style names come from the run's own gateway token; the shell's own names are refused), `validate` (a command),
  `write_back` (the checkout's paths that are the workspace), `results` (a JSON list in the checkout, else
  `<RUN_OUT>/results.json`), `record` (files whose path, size, sha256 and, for small JSON, content are recorded in the
  run's events: a session summary, usage) and `timeout_seconds` (at most the kind's token lifetime). A run: the
  repository is fetched **at exactly the pin** (by commit id into a repository with no refs, the machine's git
  configuration ignored, no redirect followed, only its own protocol, objects checked on receipt, no hooks; the commit's
  tree checked out and `.git` removed; a pin the repository lacks fails the run, not retried); the `strip` paths go (the
  pinned tree's only, mold_v0-079: never the workspace's own files); the
  workspace store's latest snapshot (033) is unpacked where only the runner can read it and its files under the
  write-back paths are laid over the checkout (never through a link the checkout holds); `setup` runs with the run's
  egress and no credential or token; the credentials (034) are delivered (variable, or a 0400 file on tmpfs); the
  command runs as the run's user (054) with its time limit (past it every process of that user is killed: "timeout");
  the agent's transcript files are recorded; once every process of the run's user is gone (checked in `/proc`), the
  write-back paths are copied out (regular files with one name, opened without following a link, within the store's
  file and byte limits; a link or special file is left out and named in `workspace_skipped`), with the snapshot's files
  outside them carried over; `validate` runs, with no credential and no gateway
  token, **on a copy of the pinned tree as it stood before the agent ran** (after `setup`) with exactly those files laid
  over it, so an agent that rewrites its validator or a dependency changes nothing; only when it exits 0 is that same
  set staged; a value of a credential or the gateway token anywhere in it refuses the write-back. The runner fetches
  outside the run's proxy, so the repository's host is never an address or a local name, and only one of
  `APP_AGENT_REPO_HOSTS` when the operator lists them. Results are read from a plain file only (never a link or a
  pipe). Everything the run prints, its stderr and results are redacted of its credentials and its gateway token.
  Egress is the run's proxy allowlist (the kind's `egress`), as for every run: enforced for programs that use the proxy
  settings, and for one that connects directly by the run sandbox's firewall (mold_v0-055). `npm run test:agent-runner`
  proves it offline with a fixture agent repository (`scripts/fixtures/agent-repo`) in a local git repository: the pin
  (a branch named like it, the branch's tip, a missing commit, a redirect), validation gating, the time limit, redaction,
  links, egress, two workspaces, and what the adversarial review found (a rewritten validator, a pipe for results, a
  stripped path written into the workspace, the size limit). **Not covered:** the agent repository itself is not
  cached (each run fetches its pin; the pinned tree is copied twice per run, its dependencies included); no size limit
  on a fetch while it downloads (a checkout's size is checked once it is on disk); `setup` needs the package registry in
  the kind's `egress`.
- **What an agent run does besides its command** (mold_v0-071..074, built; `src/agent-workspace-steps.ts`,
  `src/run-tools.ts`, carried out by `src/run-harness.ts`; all plain JSON in `agent`):
  - `results_from` (071): the program's own result file under `<RUN_OUT>` (outside the checkout, never written back):
    `file`, a JSON `pointer` to its list (`/findings`), an optional `where` (only items whose field is one of the
    values), and per item `check`/`asset`/`source` (`{area, key}` with a key template: `{field.path}` of the item,
    `{$args.<name>}` of the run's arguments, `{$root.<path>}` of the file), `status` (one of the five, or `{from, map,
    default}`: the item's field looked up in the map), `fingerprint`, `evidence`, `detail` (templates). Own properties
    only (a `__proto__` key is a plain key); every value checked as the engine checks it (status, fingerprint, sizes)
    before it is sent, and the engine checks every reference against the run's own workspace again. An item that does
    not map follows the kind's `unresolved_references`: `reject` fails the run, `drop`/`downgrade` leave it out
    (`result_unmapped`, counted against `max_unresolved`). Read only from a plain file (never a link or a pipe), redacted
    as text first. Instead of `results`. **Every file the run writes under `<RUN_OUT>`** is recorded in its events
    (`agent_output`: path, size, sha256, a small JSON file's content, redacted), whatever the run's outcome.
  - `tools` (072): tools from a fixed catalogue (`src/run-tools.ts`: claude-code 2.1.295, sops 3.13.3, age 1.3.2,
    kubectl 1.37.1, aws 2.37.5, each with its release artifact's sha256 for x64 and arm64, measured when pinned; git is
    the image's distribution package). `gen-packs` writes the union across the build's kinds
    (`src/run-tools.generated.json`, `check:packs` keeps it current; an unknown tool is refused at build); the Dockerfile
    installs exactly those (`scripts/install-run-tools.ts`: each artifact's sha256 checked before it is unpacked into
    `/opt/octi-tools`, root's, with a manifest) and checks them last (`--verify`: an image that lacks a tool the build
    needs is refused at build); a boat run sandbox runs the same installer in its set-up, before its runner starts. At
    run time nothing is downloaded: the harness checks each tool the kind names (the pinned version and artifact, the
    installed program's own sha256, root's and writable by no one else, no link) and links exactly those first on the
    run's PATH; a kind whose image lacks one, or whose installed file changed, is refused before anything runs.
  - `inputs` (073): run arguments written to files of the checkout before the first step: each `from` the run's scope
    or targets (an object, a list or a value; from `scope` it must be one of the kind's `args` when it declares them),
    checked against its `schema` (a fixed JSON Schema subset: type, properties, required, additionalProperties, items,
    enum, const, pattern, min/maxLength, minimum/maximum, min/maxItems, maxProperties; any other keyword, `$ref`
    included, is refused at build), at most `max_bytes` (64 KB by default, 1 MB at most), `json` or `text`. Refused
    when it holds the value of one of the run's credentials or its gateway token. Written to a new file (never over a
    file of the pinned tree, never through a link, never under a write-back path, so never written back).
  - `steps` (074): commands run before `command`, in order, each with its own `timeout_seconds` (the steps and the
    command together within the kind's token lifetime), the run's own variables (the kind's `env`, and so a gateway
    token, only with `env: true`) and only the `credentials` it names (none by default; the command gets
    `agent.credentials`, else all of the kind's but a checkout's); their lines are `step_log` events, never events of
    the run. Per-step credentials keep honest steps apart; they are not a wall against a hostile step (all steps are one
    user in one checkout: a step can change what a later one runs). `git_credentials` (`{credential, host, username}`, the host in the kind's egress) hand a credential to
    git: a private directory on tmpfs holds the token (0400), a helper script that answers `get` for exactly
    `https://<host>` and prints that file, and a global git config naming it for that host only (GIT_CONFIG_GLOBAL; no
    system config, no prompt), repeated as command-line configuration (GIT_CONFIG_COUNT) that resets every other helper,
    so a helper a repository's own config names never sees the token. The token is never an argument, a variable or part of a URL, and the directory goes with
    the step. A `checkout` step is the runner's own: manifest files (`manifests`, a glob with `{argument}`
    placeholders; read as root, never through a link or a second name) name repositories (`url`, `commit`, `name`
    fields). By default (`source: "workspace"`) they are read from the workspace as the run restored it, before any
    program of the run could write one, so the run's programs never choose what the runner fetches with the token;
    `source: "checkout"` reads the checkout as the earlier steps left it, which gives those programs the token's read
    reach on the step's hosts. Each repository is on exactly one of the step's `hosts` (no subdomain; also in the
    kind's egress), at a full commit id, fetched at exactly that commit as the agent repository is (outside the run's
    proxy, with the step's `credential`, which no step and not the command receive, through the same helper for that
    host only; the commit's size is counted from git's objects before anything is checked out) into the **checkout cache**: outside the workspace store,
    per workspace (`<APP_RUN_CACHE_DIR or /var/cache/octi-checkouts>/ws-<id>`, root's, traversable by the run's
    user only during that workspace's run, closed again after), per repository and commit (an unguessable directory
    name), each checkout at most `max_bytes` (512 MB default) and the workspace's cache at most
    `APP_RUN_CACHE_MAX_BYTES` (2 GiB; least recently used entries go first, never one the run uses), entries unused
    for `APP_RUN_CACHE_DAYS` (7) and unfinished fetches removed; entering one workspace's cache closes every other.
    Each is linked at its `mount` (with `{name}`; never at or over a write-back path, an input or the results, and never
    over files the workspace holds) in the checkout, read-only to the run's user (root's files); the links are removed before the write-back is
    collected, so a checkout never enters the store. The write-back is still validated and gated as before.
  `npm run test:agent-steps` proves 071, 073 and 074 offline (the fixture program `scripts/fixtures/agent-repo/steps.mjs`
  writing an audit program's result object, local repositories over file:// and one behind git's own HTTP backend that
  asks for a token) and the harness side of 072 (a stand-in tool installed through the installer with its checksum);
  `npm run test:run-tools` the catalogue, the installer (each format, a mismatched artifact, a tampered or linked
  program), the build's union and `--verify`. **Not covered:** the real tools are never downloaded by a test (their
  checksums were measured once, when pinned); a run sandbox lives one run, so on boat and docker the checkout cache is
  per run unless the operator mounts `APP_RUN_CACHE_DIR` (a runner on its own server keeps it); a boat sandbox
  downloads the tools in its set-up (checked against the same checksums) rather than starting from a built image; only
  each tool's program is re-hashed per run (aws's `dist/` libraries and the rest of a tool's tree are trusted by being
  root's alone), and a tool the kind did not declare is off its PATH but still on disk; the checkout fetch runs git as
  root on the named repositories (git's own checkout safeguards, the image's git version); a cancel or the deadline stops
  a checkout step between repositories, not inside one fetch (each fetch has the step's time limit); the hosts' names
  are not resolved and checked for private addresses before the fetch (literal addresses and local names are refused);
  no cap on the cache across workspaces (per workspace only).
- **Runs in sandboxes** (mold_v0-055, built; `src/run-sandboxes.ts`, the runner `src/run-sandbox-runner.ts`, the
  compose runner service `src/run-fleet.ts`; operator decision D4: runs go to the sandbox provider the product already
  uses for its orchestrators). The autoscaler's demand counts queued runs per kind (`demand.runs`), and each tick (on a
  server its 15-second loop, on Vercel the cron and a kick when a run is queued) launches **one sandbox per run** under
  its own lease (`runs`): for each run a claim would take now (the kind's concurrency per workspace and the platform's
  ceiling, one writer per workspace store: `claimableRuns`), a `run_sandboxes` row, a worker token bound to that run and
  that sandbox (`worker_tokens.run_sandbox_id`; it expires after the run's lifetime and a margin and is revoked with the
  sandbox), and a sandbox whose runner gets only that token, the API's address, the run user and the pack directory.
  The runner (root in the sandbox) claims its run, **once** (the run's worker is `sbx-<row>`); a run token is refused
  everywhere else in the worker API (`src/http.ts`, `src/run-routes.ts`), and the fleet token may not claim as `sbx-`.
  Then the **lockdown**: the sandbox's egress proxy (`orchestrator/core/egress.ts`) with the run's allowlist from the
  claim, and the firewall for the run's user (a uid leased for this run, mold_v0-078, matched by number; strict rules): everything dropped but the proxy's three
  loopback ports (so no local resolver, over UDP or TCP, no other local daemon, not the sandbox's own address, no
  IPv6), TCP 443 and UDP DNS redirected to the proxy from a nat chain ahead of Docker's own; the local resolver's and
  the system bus's unix sockets denied to the run user where setfacl exists (boat); the run's programs started with
  no_new_privs (a setuid program or sudo gives nothing); then the probe as that user (it must reach the gateway through the transparent path and must not reach
  anything else directly). A lockdown or probe that fails fails the attempt as infrastructure (retried in a new
  sandbox), and the run never starts. Then `src/run-harness.ts` carries the run out as the run's user with egress
  `system` (that proxy). **Teardown:** completing marks the sandbox for teardown and the next tick deletes it; a tick
  also deletes a sandbox whose run ended, was taken elsewhere, was queued again after its attempt lapsed (a crashed
  runner: the sweep requeues the run, a new sandbox carries out the next attempt), that never claimed within
  `APP_RUN_BOOT_MINUTES` (10), that died, or that is past its run's deadline (a container also has its own
  `timeout` at the run's lifetime and a margin); orphans of this deployment (by name prefix, or a label per compose
  project) go too, never a sandbox of a launch in flight. A sandbox of another provider (the provider changed) is left
  alone, not reaped blind. The kill switch `APP_AUTOSCALE=off` stops run launches and deletes as well, and with
  `APP_RUN_SANDBOX=off` or no provider nothing is torn down either (tokens still expire; boat sandboxes have the
  provider's TTL, containers their own deadline). **Cost:** at most `APP_MAX_RUN_SANDBOXES` (10; 4 on a server) at once and
  `APP_RUN_LAUNCHES_PER_TICK` (4) a tick, within the provider plan's free sandboxes; the provider's TTL is the
  run's lifetime plus a margin; one live sandbox per run (a unique index); a failed start (the launch failed, or the
  sandbox died, never claimed, or claimed without starting the run) is retried with a back-off and the run fails after
  `APP_RUN_LAUNCH_ATTEMPTS` (3) of them. The kind's budget and the account's limits (mold_v0-018, 053) are
  unchanged: the gateway stops a run's spend.
  **Providers** (`APP_RUN_SANDBOX`, default `auto`): `boat` (the orchestrators' provider, its key in the vault: a
  small sandbox per run, the runner's code uploaded as the orchestrators' is, with the same `npm ci` for tsx; the runner
  imports only node's modules and its own files, walked from its entry, plus the pack's directory; git and nft are
  installed in the sandbox when missing; the run's user is leased by the runner and given an account, `octirun-<uid>`); `docker` (a server of its own: the compose project's
  `runner` service, the only container with the Docker socket, starts a container per run from the app's own image,
  which has git and nftables (its runner leases the run's user as on boat), on the project's `runs` network, which the API is on and the database
  is not; every capability dropped but NET_ADMIN, SETUID, SETGID, CHOWN, DAC_OVERRIDE, FOWNER and KILL, no new
  privileges, no mount, memory, CPU and process limits); `off`. `auto` takes boat when its key is in the vault, else
  docker when this process has the socket. **With no provider nothing runs unsandboxed:** queued runs wait, each with
  one `waiting` event that says why, and the tick says so too. `process` (the runner as a child process, no sandbox,
  no firewall) and a runner told `APP_RUN_LOCKDOWN=off` are refused unless `APP_ALLOW_UNSANDBOXED_RUNS=yes`
  (offline tests only).
  **What is enforced where.** The run's proxy allowlist: the proxy in the sandbox, for every connection through it.
  Direct egress (a program ignoring proxy settings, raw sockets to any port, DNS): the sandbox's firewall by the run
  user's uid, in the sandbox's own kernel (boat) or network namespace (docker); the run user cannot change it (no
  root, no sudo, no capabilities). The control plane: the run user cannot reach the API's internal address or the
  database (firewall; on a server the database is not on the runs network) and only reaches the API's public host
  through the proxy, which is listed as the gateway's host, with nothing but its gateway token; the run token and the
  lease are root's (the runner's environment, 0600 root, `/proc` of root unreadable to the run user). Scope of a leaked
  run token: its one run, with its lease, until the sandbox is torn down.
  **Tested offline** (`npm run test:run-sandboxes`): stand-ins for the providers (a mock of the provider's API that
  unpacks the uploaded code and starts the runner from exactly those files; a fake Docker Engine API on a unix socket)
  carry out demand, launch, claim, run and teardown; two workspaces (a token per run, claims once, never the other run
  or another worker route, results in each own workspace); a crashed runner swept and retried in a new sandbox; caps,
  failed starts (3 tries, then the run fails) and orphans; the container's security settings; no provider and the flag
  off (nothing runs). The stand-ins have no firewall: `npm run test:run-firewall` (root, two throwaway network
  namespaces) runs the same lockdown script and proves the run user's direct TCP (any port), redirected 443 and DNS
  never leave the sandbox, while root still reaches out. It found that the firewall dropped every redirected packet
  (`oifname "lo"` does not see the reroute): loopback is now also matched by destination, in the orchestrators'
  worker sandboxes too. **Not covered offline:** an allowlisted host reached through the proxy from the sandbox (the
  proxy refuses private addresses, and the test network has no public one); the real provider and a real Docker daemon
  (never contacted); a named snapshot image for run sandboxes (each launch uploads the code and runs `npm ci`, which on
  Vercel shares the function's 300 s with the rest of the launch: a launch cut short is a failed start, retried and
  bounded); the setfacl step and a real boat image (whether a provider daemon listens locally is moot under the strict
  rules, but the unix-socket denial is best effort).
- **After a workspace commit** (mold_v0-064, built; `definePack({ onWorkspaceCommit(ctx, files) })`, code packs only):
  when a run of a pack with the hook and a workspace kind succeeds, its snapshot is committed first (in its own
  transaction, the run's and the store's leases extended by the hook's time), then the hook gets every file of the
  committed snapshot (path, size, sha256, bytes) and `ctx` (the run's own workspace from the run row, its `records` and
  `db` under row-level security, the run, the snapshot's version and whether this run changed it), then the results are
  checked, so they may name what the hook indexed. It is called also when the run changed nothing, so an index can catch
  up. If it throws or passes `APP_WORKSPACE_HOOK_SECONDS` (120) the run fails (`run`), its results are not written,
  and **the snapshot stays committed** (it passed the run's validation; `workspace_hook_failed` says so); the next run's
  commit calls the hook again. Its own writes before failing are not undone; past its time its `records` and `db`
  refuse every further call. The results are checked for everything but their records' existence before the commit
  (a duplicate, a wrong area or role refuse them with nothing committed); only an unresolved reference, which the hook
  may resolve, can still refuse them after it, and then (as when the run is cancelled during the hook) the snapshot
  stays committed. `npm run test:workspace-hook`.
- **Run results' identity and unresolved references** (mold_v0-065, built; `src/runs.ts` `checkResults`,
  `sql/migrations/0010_run_results_identity.sql`): a result is check x asset x source x **finding fingerprint**, so
  several findings on one triple are separate rows; the same identity twice is still refused, by the code and the
  unique index. A kind's `unresolved_references` says what a result naming a record the run's workspace lacks does:
  `reject` (default: the run's results are refused), `drop` (left out), `downgrade` (a missing asset or source is
  cleared and kept as written in `detail.unresolved`; a missing check is dropped; two results that become the same are
  one row). Each is a `result_unresolved` event with its status, counted in the `succeeded` event (`dropped`,
  `downgraded`, `dropped_not_passing`); more than `max_unresolved` (100) refuses the results; an undeclared area or a
  wrong role is refused whatever the mode. `npm run test:run-results`.
- **Run spend in the month figures** (mold_v0-053, built; `src/run-spend.ts`): a run's cost is GREATEST(its recorded
  cost, its live gateway total), in the month and on the day it was queued, by the member who started it. It counts
  wherever session spend did: the account's month figure (`orgMonthSpendUsd`, so Billing, the usage alert email, the
  allowance check at launch and while sampling, and Budget rules), each person's spend against their limits, the
  month's pace, the portal's Usage and Billing pages and the admin Spend page (per account, day, person and run kind).
  With no runs every figure is what it was. A workspace's tenant work reads its own runs' gateway usage
  (`sql/migrations/0009_usage_and_limits.sql` widens the `gateway_usage` policy to the workspace's runs), never
  another's: `check:rls` probes it. A schedule's runs (`requested_by` `schedule:<id>`) count in the account's figures
  and show as "Schedule", never against a member's own limit. `npm run test:run-spend` proves it with two workspaces.
- **Usage pages in neutral words** (mold_v0-008, built; `src/usage-report.ts`, `src/usage-routes.ts`): each MCP call
  records its workspace, member or key id, client name and version (from its User-Agent), tool, outcome, error class,
  latency and request and answer sizes (`mcp_events`; never arguments or answers; recording is fire-and-forget and never
  fails the call). `GET /api/usage` (the workspace's members) and `GET /api/admin/onboarding/usage` (every workspace,
  platform admins) give calls per tool with errors and p50/p95, errors by class, clients, daily and weekly active people,
  week-over-week retention, per member or per workspace calls, runs and run cost, and per run its tool calls (events of
  type `tool_call` or `tool.<name>`), model requests, tokens and cost. The console's `/app/activity` and
  `/admin/activity` show them in the build's words (a pack's `words` for workspace, member, run, tool call, key), in the
  sidebar once the build has a pack; the existing Usage, Billing and Spend pages show runs only when there are any.
  Spend per person is for billing roles (owners, billing managers); everyone else sees the workspace's figures and
  their own.
  `npm run test:usage`.
- **Limits** (mold_v0-018, built; `src/rate-limits.ts`, `src/run-limits.ts`): numbers from the shell's defaults, the
  profile's `limits` (`mcp`, `endpoints`, `runs`, and `plans.<plan name>`; `gen-packs` refuses an unknown or
  non-positive one), the workspace's plan, and the server's environment (`APP_LIMIT_<SECTION>_<NAME>`), last wins.
  *MCP:* per address before sign-in, then per key, per member (all their keys) and per workspace (all its keys), counted
  in fixed one-minute windows in `rate_limit_hits` (platform rows, no tenant access) so they hold across instances; a
  refusal is HTTP 429 with `Retry-After` and a JSON-RPC error (`-32029`) naming the limit, its number and when to retry,
  recorded once (not per message) as a failed call of class `rate_limited`; each message of a JSON-RPC batch counts
  and a batch of more than 100 is refused before anything is counted; a request over `max_request_bytes` is a 413 and an answer over
  `max_response_bytes` a plain tool error; requests in flight per workspace are capped on each instance. The sign-up
  (per address), invitation and key-creation (per workspace) endpoints are limited per hour. *Runs:* a kind may declare
  `concurrency_per_workspace` and `month_budget_usd` beside `budget_usd`; each is clamped to the platform's ceiling
  (`runs.concurrency_per_workspace`, `runs.kind_month_budget_usd`, `runs.budget_usd_max`), so a pack can lower a limit,
  never raise it, and a pack's server code may not touch `process` (gen-packs refuses it), so it cannot change the
  environment the ceilings are read from. The workspace's live-run cap is counted with the insert under a lock per
  workspace (`npm run test:run-start-race` on a real Postgres: 40 concurrent starts leave exactly the cap live; the
  code before let 40 of 40 through). Concurrency holds at claim (under a non-blocking lock per workspace and kind;
  extra runs wait, other workspaces' go ahead); the kind's month budget and the account's allowance at start and on
  every gateway request, so splitting work into many runs spends no more than one could (past the limit by at most
  the requests in flight when it is reached). An account with no allowance (no plan, no override) starts no run and
  its running ones stop spending, as its own launches do. For these checks a run queued in an earlier month and still
  live counts in the current month too. The per-address count reads the client's address behind the real number of proxies (mold_v0-084,
  `src/proxy-trust.ts`): `APP_PROXY_HOPS`, which the factory sets per target (1 on a server: the stack's Caddy; 1
  on Vercel: its edge; unset, 0, or 1 on Vercel), so the address is the one the nearest proxy saw and an entry a client
  writes into `X-Forwarded-For` is never read (`npm run test:proxy-hops`). A run container on the stack's internal runs
  network reaches the API with no proxy in front and could still name an address; the key, member and workspace
  limits hold either way. `npm run test:limits` (with a load test: one
  workspace's 120 requests at once leave another's error rate at 0).
- **The email adapter** (mold_v0-083, built; `src/email.ts`): the one place that sends email. Sign-in codes and
  invitations (`src/builtin-auth.ts` asks it for both), access requests, library submissions, usage alerts (80% and
  100% of the month's allowance, after a session or a run ends), due dates (`src/schedules.ts`) and billing notices (a
  run's charge given up on, `src/run-charges.ts`) are all built and sent there; `npm run test:email` fails if any other
  file in `src/` talks to a provider or builds a message. The transport is `APP_EMAIL_PROVIDER`, else the
  profile's `email.provider`, else Resend (its key in the Key vault); `test` keeps messages in the process (never in
  production); `none` sends nothing. Sign-in codes and invitations are always on; every other group (`access_requests`,
  `library`, `usage`, `due_dates`, `billing`) only when the app's profile lists it in `email.notifications` (a host
  pack's profile may, for its product); `APP_EMAIL_NOTIFICATIONS` only narrows that list. An app built before
  this change sent every group whenever Resend was connected: before its next deploy its profile (or its host pack's)
  lists the groups it sends (the Octillion product: `access_requests`, `library`, `usage`; a pack with due dates such
  as ComplianceOS: `due_dates`), or they are logged as skipped. The factory writes the sender and the groups for an app
  whose host pack does not (mold_v0-101, `branding/rules.json` `profile.email_defaults`: `<app_id>@<notify_domain>`,
  `access_requests`, and `due_dates` when a pack declares due dates). The words are the build's (mold_v0-101,
  `emailWords`): the profile's name and sender, the packs' run word, and the landing block's hero subheadline as the
  welcome email's pitch (gen-packs writes it to `src/profile.generated.ts` `GENERATED_EMAIL_PITCH`), else the short
  description; a build with the session engine keeps that engine's words until its host pack brings its own. With no transport that
  can send, the About page and `/admin/emails` say so in one sentence. Every message is a row in `email_log` with a hash
  and the domain of its one address, never the address, a code or a key; subjects, senders and recipients lose line
  breaks; every link is on the console's address from the environment (`src/console-url.ts`: `APP_CONSOLE_URL`,
  else `PUBLIC_URL`; anything but a plain http(s) address is ignored).
- **Plan entitlements** (mold_v0-083, built; `src/entitlements.ts`): the app's own `profile.json` may declare
  `entitlements: { plans: { <plan>: { features: [...], run_charges: "charged" | "included" } }, without_plan }`
  (gen-packs checks it, and refuses it in a host pack's profile). A workspace's plan is its live subscription's when
  declared, else `without_plan`; its limits are `limits.plans.<plan>` (018's), read for the same plan. Features: `runs`
  (checked with the run limits at start) and `schedules` (making or turning on a schedule, and each firing).
  `run_charges: "included"` freezes the plan's runs with no price, so 019's billing never charges them. Absent, nothing
  is gated. `npm run test:entitlements`, and `npm run test:schedules` section 8.
- **Price per run** (mold_v0-019, built; `src/run-charges.ts`, `sql/migrations/0014_run_charges.sql`): a billing usage
  event per finished run, **off by default**. Only the app's own `profile.json` turns it on (`billing: { enabled: true,
  currency, max_fixed, max_cost_plus_percent, charge_failed_runs, charge_cancelled_runs, stripe_meter }`; gen-packs
  refuses a typo, and refuses `billing` in a host pack's profile); `APP_RUN_BILLING=off` turns it off on a server,
  never on. A job kind may declare `price: { currency, fixed, cost_plus_percent, on_failure, on_cancel }`: a fixed
  amount and/or the run's metered model cost plus a percent (usd only; the gateway's figure for the run's last attempt,
  never one the run reports, and never the attempts the platform failed).
  When a run is queued the platform freezes what it allows into `runs.price`: the app's currency only (another
  currency refuses the start), the fixed amount and the percent clamped to the profile's ceilings (defaults 1000 and
  100), and a failed or cancelled run free unless the profile allows charging it. With billing off every run's price
  is NULL and nothing below happens. *Exactly once:* a trigger on `runs` writes the charge in the same transaction as
  the run's move into an ended state, whichever code moved it (completion, the lease sweep, a cancel, a launch that
  never happened, the workspace's deletion); attempts retried after an infrastructure failure never end the run, so
  they never charge; `UNIQUE (run_id, kind)` makes any second write a no-op, and a backstop writes, run by run, a charge
  the trigger could not. A succeeded run pays fixed + cost-plus; a failed one as `on_failure` (`free`, `cost`, `full`)
  unless the platform failed it (`infrastructure`: never charged); a cancelled one as `on_cancel` (`free`, `cost`).
  *Delivery:* each charge is an outbox row, sent by the server's loop (every minute) and the cron entry once the run has
  been over for a grace period (`APP_RUN_CHARGE_GRACE_SECONDS`, default 120; model usage still streaming when it
  ended is refreshed into it first). Each row is claimed alone just before it is sent, so two deliverers never send it
  at once. With a Stripe customer and a live subscription priced on the meter (`stripe_meter`), it is one meter event
  (value in the currency's minor unit, identifier and idempotency key `run_charge:<run id>`, so a resend after a lost
  answer counts once); with no Stripe customer, or no such subscription (Stripe would never invoice it), the
  `run_charges` table is the ledger and says why; with a customer but no Stripe key on the server, or no such meter, it
  waits, saying why. Failures back off (1 minute doubling to an hour), at most 20 tries. The ledger outlives the run's
  row and the workspace (no foreign keys). *Credits:* an operator may give a charged run's charge back once
  (FinOps › Run charges, with a reason; to the customer's Stripe balance keyed `run_credit:<run id>` when the charge went
  to Stripe, else the ledger). The workspace's Billing page (a member sees their own runs, billing roles everyone's) and
  FinOps (Revenue's `run_charges`, the Run charges tab) show charges only when the app bills runs; otherwise their
  answers are exactly as before. `run_charges` is under RLS: tenant work reads its own workspace's rows and writes none,
  nor may it call the function that writes them (`check:rls` probes both). `npm run test:run-charges` (offline, the
  product's Stripe stand-in) and `npm run test:run-charges-race` (a real Postgres: every run ended by two completions,
  a failure, a cancel and the sweep at once, with deliverers racing: one charge each, one meter event each).
- **The runner boundary** (mold_v0-054, built; the import check resolves each pack's real import graph with esbuild,
  the resolver tsx uses, so spacing, comments, re-exports, extensionless or dot files cannot hide an import; a pack may
  carry only `.ts`/`.mts`/`.js`/`.mjs` code and plain data files, no `node_modules`, no links): a pack's code is of two kinds, told apart by pack.json `runner` (a
  directory inside the pack). *Server code* (everything else: the entry, tools, routes, loaded into the server) keeps
  the strict rules above and may neither import a process API nor the runner's files. *Runner code* (under `runner`:
  a job kind's programs, run by the harness with node as the run's own user) may also import `node:child_process`,
  `node:fs`, `node:os`, streams and the other node built-ins a program needs, imports only its own runner files (never
  `src/pack-api.ts`, the pack's server code or any shell module, and no package), is `.js`/`.mjs` only, and is held to
  the same text bans (`asPlatform`, `SET`/`RESET ROLE`, `set_config`, the tenant setting, `require`/`createRequire`, a
  computed import, `eval`). The entry may not sit in the runner directory, and no pack may carry a symbolic link. The
  processes a program starts run as the run's user and die with the run (`npm run test:runs`, section 12); the import
  rules keep the runner's code reviewable, while what isolates it at run time is the run user and an environment built
  from nothing. The same holds for server code: the import rules are a lint, not a sandbox (server code still runs in
  the server's process and could read its environment), so "values never reach a pack's server code" holds for the
  shell's API, which gives a handler none, not against a hostile pack. `npm run test:packs` proves both boundaries (a program with `child_process` passes under `runner` and is
  refused outside it, and 19 ways across the boundary are refused).
  `npm run test:runs` proves the lifecycle offline with fixture kinds (`scripts/fixtures/runs/`).
- **The workspace store** (mold_v0-033, built): a job kind with `workspace: true` gets versioned snapshots of its
  workspace's files that outlive a run, one store per workspace and pack (`sql/migrations/0006_workspace_store.sql`,
  `src/workspace-store.ts`, `src/workspace-bundle.ts`). Its claim takes the store's lease (`workspace_leases`, renewed
  by the heartbeat): one writer per workspace store, a second run waits in the queue. The harness checks the latest
  snapshot out before the program runs (each file checked against the sha256 manifest), and writes the directory back
  only when the program and the validator exited 0: it is staged, and becomes the next version inside the run's
  completion as succeeded; any other end discards it. Objects live in the product's storage (`src/storage.ts`
  `objectStore()`: the R2 bucket, or `APP_STORAGE_DIR` on one machine and in tests) under
  `workspaces/org-<id>/<store>/`, sealed with the workspace's data key (`src/orgcrypto.ts` `sealBytes`, refused while
  the vault is locked) and bound by AES-GCM additional data to their workspace, store, row and manifest. A runner names
  a run and its lease token, never a workspace (`GET`/`PUT /api/worker/runs/:id/workspace`); packing never follows a
  link; unpacking writes only inside an empty directory. Deleting a workspace removes its snapshots.
  `npm run test:workspace-store` proves it with two workspaces.
  **Retention and the file viewer** (mold_v0-056, built): a pack declares `workspace_store` (`src/workspace-store-policy.ts`):
  `retention` keeps the newest `keep_last` versions and/or those committed within `keep_days`, each capped by the
  platform's ceiling (`APP_WORKSPACE_RETENTION_MAX_VERSIONS`, 100; `APP_WORKSPACE_RETENTION_MAX_DAYS`, 365;
  a pack that declares nothing gets the ceiling). Whatever the rules, the latest version, every version a run's results
  or a report reference (the version the run left, as the report tool reads it) and the version a store lease checked
  out are kept. A daily sweep from the scheduler's tick (`src/workspace-retention.ts`; `scheduler_marks`
  "workspace_retention") deletes the rest per workspace and store in one transaction, then their objects, and any object
  under that store's own prefix with no live row; never a key outside it. Idempotent; refused with the vault locked
  (the day is then not marked). `APP_WORKSPACE_RETENTION=off` stops it. The console's **Files** page (`/app/files`,
  `src/workspace-files.ts` at `/api/workspace-files`, a `files` tab for a build with tabs) lists a store's versions
  (time, the run that wrote it, size), browses a version's files, shows a text file (at most 1 MiB, as text, never
  markup), downloads a file (an attachment, at most 25 MiB) and diffs two versions (files changed; a text file's lines),
  for the roles that may read every one of the pack's record areas, opening the version per request with the
  workspace's key (503 while the vault is locked). It never lists or serves a hidden path (a segment starting with
  "."), a credential-looking file, a path the pack declares secret (`workspace_store.secret_paths`) or strips (its agent
  kinds' `strip`), a file a credential is delivered as, nor a file that holds one of the workspace's credential values;
  paths are plain relative paths the version's manifest names. `npm run test:workspace-files` proves it with two
  workspaces.
- **The workspace credential vault** (mold_v0-034, built; merges the old 009): a pack declares credential fields
  (`definePack({ credentials })`: a label, help, `bound_to` the workspace, an `asset` of one of its asset areas (`area`)
  or an asset's `environment` (optionally from a list), delivered as an environment variable or a file). A workspace's
  owners set the values in the console (`/app/credentials`, `src/credential-routes.ts` at `/api/credentials`, mounted
  only when a field exists; an asset binding must name an asset record of their own workspace); no answer carries a
  value, owners see the last 4 characters and everyone else only which values are set; a file field takes a multi-line
  value (a key). Values live in `workspace_credentials` (`sql/migrations/0007_workspace_credentials.sql`),
  sealed with the workspace data key (`sealBytes`, refused while the vault is locked) and bound by additional data to
  their workspace, pack, field, asset and environment; the tenant role has no grant on the table (a pack's server code
  never sees a value; `check:rls` probes it). A job kind names the fields its runs receive (`credentials: [...]`, none
  by default); the runner fetches them with the run's lease (`GET /api/worker/runs/:id/credentials`), looked up with the
  run row's own workspace and its `targets.asset` / `targets.environment`, and gives the entry program each value as
  its declared environment variable or as a file (0400, the run user's) in a private directory on tmpfs
  (`RUN_CREDENTIALS_DIR`, `/dev/shm`; with no tmpfs the run fails rather than write one to disk), removed when the
  program ends; the validator gets none. A run's uid is handed to a later run only after the others (mold_v0-078), and
  before and after each run every file that user owns in `/tmp`, `/var/tmp`, `/dev/shm`, `/run/lock` and `/dev/mqueue`
  and its System V IPC objects are removed (a copy or hard link of a value never waits for the next run). A file field
  may also name `path_env` (mold_v0-075): the variable that holds the file's full path (`KUBECONFIG`, or a pack's own
  locator such as `PROD_RO_KUBECONFIG`), checked as any variable a field delivers (never one the shell sets, never two
  fields to one). A target
  that names an asset's area gets a value only for the field's own area. Everything a run writes (stdout lines, the
  stderr tail, results as text and as values, errors, event types) is redacted of the values (as is, JSON-escaped,
  URL-encoded, hex, base64 at any byte offset, numbers, each line of a multi-line value, longest first across values;
  `src/credential-redact.ts`) by the harness and again by the engine before it is stored (the engine refuses to store
  while it cannot open the values); a workspace holding a value in a file or a file name is not written back. `npm run test:credentials` proves it with two workspaces: same asset
  key, concurrent runs, 0 cross-workspace injections; a canary grep of every table, the database's files, the object
  store, the MCP and HTTP answers and the process's logs finds 0. **Not covered:** a program that sends a value out
  through an allowed host or the model gateway (egress is the run's allowlist; the gateway does not store prompts), or
  writes part of a value; values replaced while a run is going are redacted only by the harness (which holds what it
  delivered); no rotation reminder or expiry.
- **A run user per run** (mold_v0-078, built; `src/run-users.ts`, used by `src/run-harness.ts` and
  `src/run-sandbox-runner.ts`): every run's programs run as a uid of their own, leased for that run alone from a reserved
  range (`APP_RUN_UIDS`, default `61000-64999`: never root, nobody or 65535; a uid `/etc/passwd` names is skipped)
  and given back when it ends; the gid is the uid, with no supplementary groups. Before, every run of a host shared one
  uid (`APP_RUN_UID`, no longer read) and the end-of-run sweep (every process of that user killed, its files in
  the shared temporary directories removed) was host-wide: a concurrent run on the same host lost its steps (exit 128).
  Leases are files in a root-only directory (`APP_RUN_UID_DIR`, default `/run/octi-run-uids`) naming the holding
  process (pid and start time, so a reused pid is not mistaken for it) and its run, taken and given back under a
  host-wide lock (flock on a file of that directory, held by a child process: the kernel frees it when its holder dies,
  and no run's user can reach it), round robin (a released uid comes
  back only after every other free one). A lease whose runner died is taken over only after every process of that uid
  is killed and its files swept; a uid with processes this runner never leased is skipped and left alone; a uid whose
  processes will not die stays out of use ("quarantined") while its holder lives. A fixed `runAs` (tests, older setups)
  is leased the same way: a second run asking for it at once is refused (infrastructure, retried), never run beside the
  first. In a run sandbox (boat, docker: one run per sandbox) the runner leases the uid inside the sandbox, gives it an
  account (`octirun-<uid>`), and the lockdown firewall matches it by number (`setupScript` `uid`); the unix sockets of
  the local resolver and the system bus are denied to that uid (setfacl, best effort). Each run records its uid
  (`run_user` event; a program's own line claiming a harness or engine event type is a log line). A run's directories
  are 0700, its user's alone; the sweep also clears its user's kernel keyrings (`keyctl clear @u @us`, where keyctl
  exists). `npm run test:run-users` (root) proves it: leases (one per run, held never handed out, round robin,
  a dead runner's uid only after its leftovers are gone, foreign processes left alone, a fixed uid in use refused, eight
  runner processes at once get eight uids), and the bug: two runs at once on one host in two runner processes, one ends
  early and its sweep runs while the other keeps running; the other keeps its processes and files and finishes (on the
  code before this, with `APP_RUN_UID` set, both failed "the run exited with 128"). `test:run-firewall` locks a
  leased uid with no account down by number; `test:run-sandboxes` sees two concurrent sandbox runs as two uids.
  **Not covered:** uids are per PID namespace and host: two docker run containers lease independently, so two of them
  may hold the same uid (their processes and files are apart, their per-uid kernel limits and keyrings are not); files
  the run user leaves outside the swept directories (another world-writable directory) are not found; without keyctl a
  host runner does not clear a uid's keyrings; on a host runner (not a sandbox) the checkout cache's trees (074) are
  readable by any user while their workspace's run is open; a uid whose processes would not die stays quarantined
  until its runner exits.
- **Run credentials and egress per company** (mold_v0-075, built): a file credential's path in a declared variable
  (`deliver_as: {file, path_env}`, above); **operator credentials**: a pack declares `operatorCredentials`
  (`operator_credentials` in pack.json: name, label, help, `deliver_as` as a field's) and a kind names those its runs
  receive (`operator_credentials`; never with `company_egress`, so no host a workspace chose reaches them); the values are the platform's, in the key vault (provider `pack_credentials`,
  label `<pack>.<name>`, set by an owner of the platform on `/admin` key vault; `sql/migrations/0016_run_approvals_egress.sql`
  adds the provider, direct mode with no environment names, so no session is ever given one); the runner fetches them with
  the run's lease beside the workspace's (`src/credentials.ts`), delivered as declared (a pack's own program gets them; an
  agent's command and steps only when their `credentials` name them: an agent reads the workspace's files). A workspace never sees one: no console or API lists them (the console's fields are
  the workspace's own), the run's events name them but never carry a value, and everything the run writes is redacted
  of them and refused in the workspace's write-back and inputs, as a workspace credential. **Per-company egress
  hosts** (`src/egress-hosts.ts`, table `workspace_egress_hosts`, no tenant access): a kind with `company_egress: true`
  also reaches the hosts its workspace's owners list for the pack (`/api/egress-hosts`, PUT and DELETE for owners,
  mounted only when such a kind exists), for the whole workspace or for one of its asset records (the run's
  `targets.asset`), read when the run is claimed and given to the proxy as `exact` hosts (allowed exactly, never a
  subdomain; the kind's own `egress` still allows subdomains). A host is a DNS name only (no address in any notation,
  no port or wildcard, at least two labels, a top-level label of letters), never a local or internal name (`localhost`,
  `.local`, `.internal`, `.arpa`, `.lan`, `.corp`, `.test`, ...) nor the platform's own, and refused when it resolves
  here to a private, loopback, link-local or reserved address; the proxy checks every address again at connect time
  (DNS rebinding). Company hosts are reached only by the run's programs through the proxy, never by the runner's own
  fetches (the agent repository, checkout steps and git credentials need the kind's own egress), so they never receive a
  credential the runner holds. `npm run test:run-credentials` proves the three; `test:run-firewall` proves the exact
  match in the sandbox's own proxy. **Not covered:** a program that sends an operator credential out through an allowed
  host of the kind's own egress or encodes it past the redaction (as for a workspace credential); the proxy matches a
  company host by the CONNECT name, not the TLS server name inside the tunnel, and does not refuse the platform's own
  addresses by number (a name pointing at them passes the name check); no console page for the hosts yet (the API only).
- **Approval-gated writes** (mold_v0-079, built; `src/run-approvals.ts`): a kind that writes declares
  `approval: {preview, by, expires_minutes}` (`preview`: an ungated kind of the same pack, its dry run; `by`: `owner`, the
  workspace's owner, default, or `operator`, the platform's; `expires_minutes` 5 to 10080, default 1440) and
  `max_attempts: 1` (a yes is one write: never retried). No schedule may start it. A run of it starts only with an approval (`approval: "apr_…"` in `ctx.runs.start`, and in its generated
  start tool, where it is required). The approver is shown the preview's output and its sha256
  (`GET /api/runs/:id/approval`, the owner only, or `/api/admin/runs/:id/approval`): the run, its scope and targets, its results and the
  files it recorded; they approve that sha256 (`POST /api/runs/:id/approve` {kind, sha256}, a signed-in owner, never a
  key; `POST /api/admin/runs/:id/approve`, an operator); another sha256, another role, a preview that did not succeed or
  is older than the approval's life, and a second approval of one preview for one kind are refused. Starting the write
  takes the approval in the transaction that queues it: unused, unexpired, this workspace's, pack's and kind's (used once:
  no replay); the run's scope and targets must be the preview's; the preview's output must still hash to the approved
  sha256. When the write is claimed the approval must not have expired and its workspace must still be at the version it
  had when the preview was approved (else the write fails, not retried); the write is given the approved output (the
  file `RUN_APPROVED_PREVIEW` names: the approval, the sha256, the preview's run, results and recorded files) to apply
  exactly that. No MCP tool approves. **Not covered:** that the write applies only what it was given is the program's
  (a write that recomputes may write something else); a preview's own program chooses what it prints and records. `npm run test:run-approvals`.
  Also in 079: `strip` applies at checkout only (above); and a metric `unit` `percent_100` for values already 0 to 100
  (an average of percentages a run measured), shown as they are (`percent` stays a share from 0 to 1, shown times 100).
- **The onboarding checklist from packs** (mold_v0-011, built): a pack declares steps (`definePack({ onboarding })`: an
  id, a label, help, and `done_when`, one of `workspace`, `connected`, `first_call`, `tool:<name>`,
  `credential:<name>`, `record:<area>`, `run:<kind>`; a credential, a workspace-scope area or a kind must be the pack's
  own, a tool any tool of the build, all checked when the pack loads). `src/onboarding.ts` reads each condition for the
  calling workspace only (its id from the session; every query names it and runs under row-level security for it; the
  credential vault, which tenant work cannot reach, is read with that id), with the time it first held, and serves the
  list at `/api/onboarding` (signed-in people of the workspace, read only; mounted only when a step exists). The
  console's Setup page shows it above the shell's own timeline when the build has a step (`packOnboardingSteps` in
  `pack-nav.generated.ts`); with zero packs it asks nothing and the page is unchanged. `npm run test:onboarding` proves
  it with two workspaces (everything B does ticks none of A's steps). **Not covered:** the end-to-end browser walk of
  the old ticket's acceptance (a new person from the landing page to a first call): there is no browser harness in the
  shell yet. The product's own setup steps and tool groups are its host pack's Setup route (mold_v0-039, below); the
  shell's own Setup page asks for joining, a connection, the tools and a first call, in the profile's words.
- **Declarative packs** (mold_v0-057, built): a pack may be its `pack.json` alone, with no entry and no TypeScript.
  `src/pack-manifest.ts` is the one definition of pack.json (zod; its JSON Schema is written to `packs/pack.schema.json`
  by `npm run gen:pack-schema`, for editors and intake, and `npm run test:declarative-packs` holds it current and runs a
  JSON Schema validator over it). Beside the manifest keys it takes `record_areas`, `job_kinds`, `credentials`,
  `schedules`, `onboarding`, `metrics`, `charts`, `tabs`, `repositories` and `run_results`; `gen-packs` validates every pack.json with it
  (each refusal names its path: `packs/<id>/pack.json: record_areas[2].lifecycle.initial: …`) and compiles the
  declarations into the `definePack` fields they stand for, carried in `src/packs.generated.ts` as `declared` (no import
  for a pack with no entry). `src/packs.ts` merges them with the code entry's definition when there is one
  (`mergePack`: lists joined, a name both declare is refused), so code stays an escape hatch that extends a declarative
  pack. Without `entry`, `index.ts` is still the entry when the pack has one. What a declaration holds:
  - **Typed fields** (shared with `definePack`): `text` (`max_length`), `number` (`min`, `max`), `date`, `boolean`,
    `json`, `enum` (`options`: values or `{value, label}`; values are plain words, never markup or quotes), `person` (a
    sign-in id), `reference` (`to`: an area; the key must exist **as the writer sees it**, so a workspace never refers to
    another workspace's record, and a shared area may refer only to shared areas), `file` (`{path, name?, sha256?,
    size?}`, a path inside the workspace's files), the 047 `link`; `multiple` for enum, person, reference and file;
    `required`. Checked on every write by the shell's record store (`src/record-areas.ts` `checkRecord`), every problem in
    one 400. Stored in the 047 tables (`workspace_records`, `platform_records`): no per-pack SQL.
  - **A lifecycle** (workspace areas): `field` (a single enum field: its options are the states), `initial`,
    `transitions` (`from`: states or `"*"`, `to`, `label`, `roles`). A new record starts in `initial`; a write never
    changes the state (it is carried over; a different one is a 409); `records.move(area, key, to)` moves it only along a
    declared transition and its roles (409 naming the moves there are; 403 for the wrong role). Moves and writes on a
    lifecycle area change a row only from what they read (compare-and-set on the row's version), so a write racing a move
    never restores the old state. A row with no state (written before its area had a lifecycle) is in `initial`. The
    other fields stay editable in every state by whoever may `update`: per-state edit locks are an extension point.
  - **Permissions** per action (`read`, `create`, `update`, `move`, `delete`) as lists of account roles. Defaults: read
    every role; create, update, move the roles with the platform's `edit` (member, billing, owner); delete as update, or
    the owner alone on an area with a lifecycle (else deleting and re-adding a record would put it back in its initial
    state past the transitions' roles). Every write, move and delete also needs `read` (its answer and refusals show
    the stored record). A declaration only narrows the platform: a write naming `viewer` is refused at build, a shared area declares `read`
    only, and at run time a role must hold both. Enforced for the person a call is made for, on `ctx.records`
    (tools and workspace routes pass the caller's role), `list_records`/`get_record` and `/api/records` (a link into an
    area the caller may not read is left out). An account API key has no role limits, as for every shell tool.
  - **Only through the store.** Pack code (server and runner) may not name `workspace_records` or `platform_records`
    (gen-packs refuses it, beside `asPlatform` and the rest), so the checks above are not bypassed by a raw `ctx.db`
    query in a reviewed pack; as for every pack rule, this is a lint, not a sandbox (MOLD.md "The runner boundary").
    A pack with no entry may not carry server code (it would never load); text a database cannot store (NUL, a broken
    surrogate pair) is a 400 naming the field.
  - **Schema drift**: a row read under a changed declaration keeps its stored values, drops fields no longer declared
    from what is shown, and names every field that no longer fits in `drift`; the next write must fit.
  - **Job kinds**: `runner: "workspace-harness"` (a program of the pack, as before) or `"agent-workspace"` (mold_v0-061:
    declared with its limits, `args`, `credentials`, the run limits (`budget_usd`, `concurrency_per_workspace`, `month_budget_usd`)
    and its `agent` configuration, listed as `agentJobKinds` and run by the engine like any kind: "The agent-workspace runner" below). `args` are typed like fields and checked when a pack's code starts a run (`declaredRuns`, outside
    the engine); the run engine applies a harness kind's limits (above). A schedule may name an agent-workspace kind
    (validated, and its `scope` may give only the kind's `args`) and the scheduler starts it as any kind. A schedule's scope values are not yet type-checked against `args` (the scheduler
    starts runs through the engine, not through `declaredRuns`).
  - **Credentials, schedules, onboarding** as in `definePack`; **metrics**, **charts** and **tabs** (below, mold_v0-063 and
    058); **repositories** (mold_v0-059: below; an area names one with `repository`, checked) and
    **run_results** (mold_v0-061: how a run's output becomes rows; `check` names areas, checked); **mcp** (mold_v0-060,
    below: the generated MCP tools' settings). No key is reserved any more.
  - `npm run test:declarative-packs` proves it with `scripts/fixtures/packs/fixture_tracker` (a pack.json, no code) and
    two workspaces; `npm run test:packs` typechecks a build copy with it.
  - **Not covered yet:** a shared library and each workspace's state of it are two areas (one platform, one
    workspace, the second's rows keyed by the first's keys and linked to them); a declared "library + per-workspace
    state" pairing (one area name, two scopes) is still an extension point.
- **Sealed areas, keys, batch writes** (mold_v0-066, built; `src/record-areas.ts`): `sealed: true` on any workspace
  area (an asset area always is; refused on a shared area; `due` allowed since mold_v0-076, below) seals
  every record's title and data with the workspace's data key; a sealed write is refused (503) while the key vault is
  locked (for asset areas too: they were stored in the clear in that case before). A filter or sort over a sealed area
  opens the workspace's own rows (at most 5000) and runs in memory, never in the database. Record keys may hold ( and )
  (`RECORD_KEY` in `src/pack-api.ts`, shared by schedules and credentials); a key travels inside a sorted page's cursor
  as JSON in base64url, never as cursor syntax, and URLs carry it raw or percent-encoded. `records.batch(ops)` (put,
  create, update, move, delete) runs as one transaction: every query of the batch (reference checks included) runs on
  it, so later operations see earlier ones, and any refusal or database error leaves nothing (the refusal names the
  operation). `npm run test:record-batch`.
- **The generic data API and data repositories** (mold_v0-059, built; `src/data-api.ts`, `src/data-routes.ts`,
  `src/record-query.ts`, `src/data-repositories.ts`, `sql/migrations/0011_data_repositories.sql`). For every declared
  area, with no pack code: `GET/POST /api/data/:area` (list with `filter` as JSON `{field: value | {op: value}}`, ops
  eq ne in lt lte gt gte contains prefix exists; `sort` a field, key, title or updated_at, `-` for descending; `limit`
  and cursor `after`; create), `GET/PUT/DELETE /api/data/:area/:key`, `POST /api/data/:area/:key/move`,
  `POST /api/data/_batch`, behind the portal session and the CSRF header on cookie writes; `/api/admin/data` for staff
  (shared areas only: read, `library` to write, `delete` to delete; `/_repositories` and an upstream catalog's
  `/_repositories/:pack/:name/sync`). Every route calls the record store's functions (the same as `ctx.records`), so
  permissions, fields, references, lifecycles, sealing and isolation are applied once; filters and sorts are ANDed
  after the workspace's own scope, with field names and values as parameters. `DATA_API_OPERATIONS` lists the
  functions 060's generated MCP tools wrap (below). **Repositories** (one adapter interface, `ADAPTERS`):
  `shell_tables` (the default), `workspace_files` (a path template, one row per identity of a JSON-lines or JSON file,
  `append_only` keeping the last; or a dir template, one row per folder with its `files` (globs too) read into the
  fields of their names; `never_read` drops values; read only; re-indexed into the workspace's rows by the run engine
  after each commit, before the pack's own `onWorkspaceCommit` and the results), `upstream_catalog` (fetched at the
  pinned commit only, by git with redirects, hooks, credential helpers and every protocol but https off, or GitHub's raw
  files and tree at the commit; indexed by staff) and `http_api` (read live with the workspace's credential field in a
  header, https to its `egress` hosts only, the address resolved once, checked against private ranges and used for the
  connection, no redirects, 5 MB, 15 s). Rows come from a pack's `loaders` (code), else a declared `map` (`from`,
  `each`, `key`/`title` templates, `fields` value paths, `where`) or the kind's default (fields by name or camelCase).
  A value path (`VALUE_PATH`, `src/pack-api.ts`; read by `valueAt`) is a dotted path of properties, each optionally
  followed by list indexes (mold_v0-076: `controls[0]`, `refs[0].id`, `$.a[2].b`; 0 to 999, no negative, computed or
  quoted index, never `__proto__`, `constructor` or `prototype`), in `fields`, `key`/`title` templates, `where` and
  `identity`; a step that does not fit (an index past the end, an index on an object, a property on a list) is no value.
  An index is idempotent (each row's `fingerprint`, keyed with the workspace's key for a sealed area, and its `source`
  are stored with it), one transaction, and prunes only rows it wrote; a row written or changed by hand is kept (and
  counted as `kept_by_hand`), never overwritten or pruned, unless staff force the index. For an upstream catalog an
  empty result over existing rows, or a prune of more than `prune.max_fraction` (0.5) of its rows, is refused unless
  staff force it; a workspace's committed files are the truth (no such guard). A sorted page's cursor is the sort and
  the last key only: the row's sort value is read again in the caller's scope (a row gone by then: 409). `npm run test:data-api`,
  `npm run test:data-repositories` (a local git repository, never the network; `SECOND_APP_DECLARATION=<file>` also
  runs the second app's own declaration through the generic adapters). **Not covered:** an http_api area cannot be
  the target of a reference; a sealed area's filter is capped at 5000 rows; DNS rebinding is closed by connecting to the
  checked address, but an `egress` host's own redirects are refused rather than followed.
- **MCP as a core offering** (mold_v0-060, built; `src/mcp-catalog.ts`, `src/mcp-tools.ts`, `src/install-pages.ts`): every
  pack gets MCP tools generated from its declarations, so a pack with no hand-written tool still has a full MCP. Per pack,
  named `<prefix>_<verb>_<thing>` (the prefix its id unless `mcp.prefix` says otherwise) and in the pack's words (a pack's
  `words.run` "review" gives `review_status`, `list_reviews`, `get_review_results`, `cancel_review`; `words.workspace` is
  the descriptions' word): `list_<area>` (filter, sort, limit, after) and `get_<area>` for every area; `create_<area>`
  and `update_<area>` for a workspace area whose rows are not read from files or an API, `move_<area>` with a
  lifecycle (its states and transitions in the description); `get_metrics` when the pack declares metrics (063's
  computation); `start_<kind>` per job kind with its `args` typed from the declaration (and `target_asset` when the
  pack has asset areas, `target_environment` for environment-bound credentials), then `<run>_status`, `list_<runs>`,
  `get_<run>_results`, `cancel_<run>`; `get_<kind>_report` for a kind that declares `report` (a file of its workspace:
  `{path, label?, format: markdown|text|json}`, a workspace kind only, under an agent kind's `write_back`), read from the
  snapshot version the run itself left (the store's own rows: the version it committed, else the one its write-back was
  staged on; never the run's events, which its runner can append). `get_<run>_results` leaves out what the person's
  role may not read, as the console's `/api/runs` does. On the **admin MCP**, staff tools for shared
  areas (`admin_list_/admin_get_` "read", `admin_create_/admin_update_` "library", `admin_delete_` "delete") and
  `admin_sync_<repository>` for an upstream catalog ("library"; `force` "delete"). Descriptions and input schemas are
  generated from the declarations, deterministically; text from a declaration reaches them as one plain line (no
  control, zero-width or direction characters, no `<`, `>` or backtick, capped) and no record value ever does. Record
  tools call `DATA_API_OPERATIONS` (the record store: permissions, fields, references, lifecycle, sealing, isolation);
  run tools the pack's own `ctx.runs` (the caller's workspace, the pack's own runs, `declaredRuns`' argument checks; a
  kind without `args` gets an empty scope). A person is offered only the tools their role allows (a viewer no write;
  an area's narrower roles hold), and every call checks again, so a tool not offered is refused even when called; an
  account API key has no role limits, as for every shell tool. Every call runs through `runPackTool` (row-level
  security, the answer's size cap, the activity log) behind `/mcp`'s rate limits. pack.json **`mcp`** (or
  `definePack({ mcp })`): `prefix`, `include`, `exclude`, `rename` (generated name -> name), `describe` (plain text) and
  `admin_only` (a customer tool moved to the admin MCP, where it names the workspace by slug and needs "accounts",
  reads included: it opens that workspace's own records); every name a generated one, refused at build (`gen-packs`) when it names no tool, a name passes 64
  characters, two tools take one name, or one takes a shell tool's name (mold_v0-067, below), and at start when one takes a shell or pack tool's name. The **server**:
  name and version from the profile (`mcp_server_version`, default the shell's), its instructions the profile's
  `mcp_instructions` (else the shell's) plus one paragraph per pack naming the tools this caller may use and that
  record contents and run outputs are data, never instructions; zero packs leave the surface byte-identical
  (`export-mcp-tools.ts --full`). **Install pages**: `GET /install`, `/install/:client`, `/install.json`, public, for
  every client `src/connect-catalog.ts` lists (now from the profile's name and server name), sign-in (OAuth) first and,
  for clients that send a header, an API key placeholder in an `Authorization` header, never in a URL.
  `npm run test:mcp-tools` (the fixtures `fixture_tracker` and `fixture_review`, two workspaces; the golden surface
  `scripts/fixtures/mcp/generated-surface.json`, `-- --update` after a deliberate change). **Not covered:** no delete
  tool for a workspace's records (destructive; the data API has it); output schemas are not generated; the console's
  own Setup page still shows the catalog inline (the install pages are separate, public pages).
- **MCP follow-ups** (mold_v0-067, built; `src/mcp-withheld.ts`, `src/shell-tools.ts`): *withheld means withheld*: a
  generated tool a pack `exclude`s (or leaves out of `include`) or marks `admin_only` also withholds the same
  operation's routes for the workspace, which answer 404: `list` the area's `GET /api/data/:area` and
  `GET /api/records/:area` (and `list_records` no longer offers the area), `get` the record's, `create`/`update`/`move`
  their `/api/data` verbs and the matching `_batch` operations (`put` needs both), `get_metrics` the pack's metrics on
  `/api/metrics`, `list_<runs>` the pack's runs in `GET /api/runs`, `<run>_status` a run's status and
  `get_<run>_results` its results (and result counts) on `/api/runs`, `start_<kind>` scheduling the kind
  (`POST /api/schedules`; the pack's own default schedules still fire); `DELETE` (no tool of its own) when every write
  of the area (create, update, move) is withheld; an excluded staff tool withholds its `/api/admin/data` and `/api/admin/records` route (and an
  upstream catalog's sync). `gen-packs` leaves the area's Records entry and area tab (and the pack's runs tab) out of
  the sidebar. An `admin_only` tool stays usable by staff on the admin MCP. *The build knows the shell's names*:
  `src/shell-tools.ts` lists the customer MCP's, the record tools' and the admin MCP's own tool names (no imports;
  `src/server.ts` and `src/admin-mcp.ts` do not typecheck when their tools and the list differ), and `gen-packs` refuses
  a pack whose own or generated tool takes one. Since mold_v0-039 the customer MCP's list is empty (the product's tools
  are its host pack's); a host pack's tool names are reserved when the packs are installed, at the server's start. *Staff calls in the workspace's log*: a call of an `admin_only` tool is
  written to that workspace's `mcp_events` (refusals and failures too) as `staff:<12 hex of an HMAC of the admin
  identity, keyed with a server secret and the workspace>` with client `admin-mcp`, never the identity itself (a
  guessed email cannot be checked, and one person reads differently in each workspace) (the admin access log names the person); the usage
  pages label it Staff and do not count it among the workspace's people (DAU, WAU, retention); product analytics and
  journeys ignore it. *Staff runs under the account's launch rules*: a run staff start for a workspace (`org.staff`)
  passes `checkAccountRun` (`src/limits.ts`: the account's allowance, its month's cap and the buffer Budget rules hold
  back, fail closed), and its `requested_by` is the staff pseudonym. `npm run test:mcp-followups`.
- **Install guides and tool docs** (mold_v0-010, built; absorbs 015; `src/install-pages.ts`): the per-client install
  pages of 060 (one per client, the exact command or config, Cursor's one-click link, sign-in first and, for clients
  that send a header, the key in an `Authorization` header) now follow the profile's optional `install_clients` (ids
  from `src/connect-catalog.ts`; `gen-packs` refuses an unknown or repeated one; absent, every client). A signed-in
  member's own setup (`memberSetup`, answered once when they make a key, mold_v0-007) carries their key in each
  client's header, says per client whether it uses the key or signs in (OAuth), and the console shows it with copy
  buttons. The **tool reference**, `GET /install/tools` and `/install/tools.json`, public as the install pages: every
  tool the packs add to the customer MCP, per pack (its own tools and the generated ones that stay there), with its
  description in the pack's words, its input schema (JSON Schema) and the roles that may call it (the same check the
  server makes when it offers a tool), never an excluded, `admin_only` or staff tool; linked from `/install` and named
  in `/install.json` (`tool_reference`). With zero packs nothing is mounted or linked and every install page, the
  guide's JSON and the docs' tool table (`web/src/content/mcp-tools.generated.json`) are byte for byte what they were
  (the golden `scripts/fixtures/install/zero-packs.json` was written by the code before this change). `npm run
  test:install-docs`. **Not covered:** an editable override of the generated text and a playground (015's) are not
  built; VS Code's install link is not offered (the client pages are unchanged for zero packs).
- **Per-member MCP keys** (mold_v0-007, built; `src/member-keys.ts`, `sql/migrations/0013_member_keys.sql`,
  `/app/keys`): a signed-in person makes keys of their own (`POST /api/keys` `{name, expires_in_days}`: 7, 30, 90,
  180 or 365, default 90; at most 20 live), each named, shown once (only its sha256 is stored) and revocable
  (`POST /api/keys/:id/revoke`). A member key (`api_keys.scoped`, with `user_id` and `expires_at`, a check constraint)
  is accepted only in a header (`/mcp/<key>` and the preview's `?key=` refuse it), is refused on the next call once
  revoked or expired, and acts as its person with their **current** role in the workspace, read on every call from
  the sign-in's directory (`src/people.ts`: the built-in one live from Postgres; Clerk's with 30 seconds' cache, cleared
  when the shell changes a membership): a viewer's key is offered no write and is refused one; a removed or suspended
  member's keys stop working, and removing a member (mold_v0-004) also revokes their keys in that workspace; a
  directory that cannot be read fails closed. Rate limits: the key's
  own, the member's (all their keys) and the workspace's (mold_v0-018); creating one counts against the hourly key
  number per person (a bucket of its own, so no member can use up the one staff issue and rotate keys from; a request
  refused for its name or expiry does not count; the 20-key cap is counted under a lock per person); a cookie-borne change needs `X-Pack-Request: 1`. Owners (the team permission) see every key of the
  workspace on the same page, with whose it is, and revoke any (`revoked_by` keeps who, staff included). Staff revoke a
  member key but never rotate one (409: a replacement would be an unscoped key). The tenant role still cannot
  write `api_keys` (`check:rls` probes un-revoking). **Migration path:** existing keys keep working exactly as before:
  the account's own keys (no person, no role limits; also in the deprecated URL until `APP_URL_KEYS=off`) and
  the older keys staff issued for a person (their person, no role, no expiry). To move a client: the person makes a
  member key on `/app/keys`, pastes the setup shown, and they (or an owner) revoke the old key on the same page.
  `npm run test:member-keys`.
- **Metrics and charts** (mold_v0-063, built; `src/metrics.ts`, `src/metric-spec.ts`, `src/view-routes.ts`): pack.json
  `metrics` are computed on the server for one workspace: over a record area (its shared rows, or the workspace's own),
  the workspace's `run_results` or its `runs`; `measure` count, sum or average of a number field, rate (the share of rows
  meeting `rate.where`), or duration (`from` to `to`, each a date field, `created`, `updated`, `started`, `ended` or
  `state:<value>`, as average, median, p90 or max, in days or hours); `where` conditions (eq, ne, in, not_in, lt, lte,
  gt, gte against a number, a date or today/now with +/- days, empty, not_empty); `group_by` a single-valued field (an
  enum's options in order, a reference named by its record's title, run results by check, asset, source, status or
  `detail.<word>`) or `{due: <date field>}` (overdue, due soon, later, no date); a field that holds a list (a `link`, or
  an enum, person or reference with `multiple`) only with `group_by_list` (mold_v0-076): `first` (the list's first item;
  a link holding one key is that key) or `each` (a row in the group of every distinct item it lists: a lateral join on
  the list in SQL, the same in code; the groups may add up to more than the rows, `rows` counts each row once); `by_time` a series of the last N days,
  weeks (from Monday) or months (UTC), by group for an enum of at most 8 options, a boolean, a status or a kind; `limit`
  groups (at most 50, flagged `more`); `roles`. One aggregate query each, inside `withTenant` with `org_id` named, field
  names and values only as bound parameters, a group limit, a time window and a 5 s statement timeout on Postgres
  (PGlite, the embedded database of tests and one-machine runs, ignores statement timeouts); at most 30 metrics a
  request, 4 at a time. A sealed area's rows (an asset area, or `sealed: true`, mold_v0-066) are opened one by one and evaluated by the same rules in code,
  over its newest 5,000 rows and at most 32 MB of them, read once per request (`partial` when cut). A span that ends
  before it starts (a state entered again since) is not a duration. A person reads a metric when their role may read
  its area and is in its `roles` (an API key: no role limits); a run-results metric needs every check and asset area's
  read permission; a referenced record is named (title or key) only for those who may read its area ("Restricted"
  otherwise), and `/api/runs/:id` leaves out results whose check, and names no asset or source, the person may not
  read. When a record is created or moved the store stamps when
  it entered the state (`$state_at` in the row's data: never a field, never writable, carried over on writes), which is
  what `state:<value>` reads (time to fix). `charts` (`number` tiles, `bar`, `stacked_bar`, `line`, `area`, `table`;
  no donut, never two y-axes, `palette` categorical or ordinal) are checked against their metrics' shapes and units at
  build and drawn by the console (`web/src/features/tabs/charts.tsx`: colour tokens `--viz-*` in
  `web/src/styles/theme.css`, validated for colour-blind separation in light and dark, a legend for two series or more,
  a tooltip, an accessible summary and a table view per chart). `GET /api/metrics?names=` (signed-in people of the
  workspace; a refusal per metric) and `GET /api/runs`, `/api/runs/:id` (the workspace's runs and results, read only)
  are mounted only when the build has a metric or a job kind. `npm run test:metrics` proves it with two fixture packs
  (`fixture_vulns`: open by severity, found vs fixed per week, by application, control and regulator, against the
  fix-by date, time to fix; `fixture_adoption`: pick rate overall, per week, per task and per agent, runs, spend) and
  two workspaces, every number checked against the fixture rows, the code path equal to SQL, 20,000 rows bounded.
  **Not covered:** a metric across two areas (a join), a cumulative series, time zones other than UTC, state times of
  records moved before 063 (they have none: such rows are left out of a duration), texture fills for print.
- **Console tabs** (mold_v0-058, built): pack.json `tabs` is the /app sidebar: when any pack declares tabs the sidebar is
  exactly those, in order, grouped by `group` (a group shared by packs is one section); with none it is the shell's own,
  unchanged (`npm run test:console-tabs` compares the zero-pack and the no-tab sidebars with snapshots taken before 058).
  Kinds: `overview` (charts), `area` (a record area's `views`: table, board by a single-choice enum, the lifecycle's
  field by default, timeline by a date field or updated, detail; its charts above), `runs`, `reports` (finished runs and
  their results), and the shell's own pages `credentials`, `usage`, `schedules`, `notices`, `setup`, `billing`,
  `profile`, or one of the pack's `page`s. `label` in the app's words (an area tab defaults to the area's label), `icon`
  from a fixed set (`TAB_ICONS`). Each tab is shown to `roles` narrowed by what it shows (an area's read permission;
  for an overview, the roles that may read one of its metrics; a build refuses a tab no role could see); the server
  refuses the data whatever the sidebar shows. Tab pages render at `/app/packs/<pack>/<tab>` through the existing pack
  page route (no new route). Boards and timelines show up to 200 records; a board by a workspace area's lifecycle field
  offers each card the moves its state allows (a menu, no drag), through the data API's move (`POST
  /api/data/:area/:key/move`, the record store's roles and transitions; the move stamps the state's time). `npm run test:console-tabs` checks the sidebar, the tab pages, a rendered overview and board in a headless
  browser (when the machine has one) and the build copy's typecheck.
- **Schedules per workspace and due-date alerts** (mold_v0-035, built): a pack declares default schedules
  (`definePack({ schedules })`: a name, one of its own job kinds, a five-field cron expression in UTC, at most every 5
  minutes (`src/cron.ts`), optionally `assets` (one of its own asset areas, all records or up to 50 keys: one run per
  record, `targets.asset` {area, key}, so credentials bound to that asset reach it), an `environment`, a run `scope`,
  and `enabled`). Every workspace gets its own copy (`workspace_schedules`, `sql/migrations/0008_schedules.sql`;
  tenant work may only read its own rows); a copy no owner changed follows the pack's later changes, and a default the
  pack drops is turned off (its owner may then remove it). A workspace's owners ("manage") turn schedules off and on,
  change their time and assets, and add their own for a kind the pack itself schedules (with the scope of the pack's own
  schedule of it: owners never set a run's scope) in the console (`/app/schedules`, `src/schedule-routes.ts` at `/api/schedules`, mounted only when a job kind
  exists; the workspace is the session's, an asset key must be one of its own records, a default is turned off, never
  removed). The tick (`src/schedules.ts` `tickSchedules(now)`) takes every enabled row whose `next_at` has come: of the
  due times missed since the last tick only the latest runs, once (the others are counted in `last_skipped`), and the
  row's next due time is the first match after now. The row is moved on by a compare-and-set on its `seq`, so two ticks
  at once (the Vercel cron, servers' loops, replicas) start its runs once; a target whose previous run from the
  schedule is still queued or running is not started again, and an account that could not launch a run now (blocked: no
  allowance, over its cap; or its allowance unreadable, `src/limits.ts` overview) starts none. A firing shows "starting
  runs" until they are started, so one cut short is visible. Runs start through the run engine (`startRun`, requested by
  `schedule:<id>`, under its per-workspace cap); the run engine is unchanged. The tick runs from the product's existing
  cron entry on Vercel (`/api/cron/autoscale`, `CRON_SECRET` only, every 5 minutes) and from a one-minute loop on a
  server (`startScheduler`, `APP_SCHEDULER=off` turns it off). **Due dates:** a check area of workspace scope may
  declare `due` (one of its date fields, `within_days`, default 7, and the `notify` roles, owners by default), a sealed
  one too (mold_v0-076: its rows' dates are ciphertext in the database, so the check opens each workspace's sealed rows
  with that workspace's own key inside its own tenant scope, a page of 500 at a time, and applies the same window in
  code; the notice's title is sealed again with that key and opened only when the workspace lists its notices; the email
  names the record by its key, never its title; the record's key and due day are in the clear in the notice, as a key
  always is; with the key vault locked nothing sealed is opened, the workspaces are counted in `sealed_skipped` and the
  day is left unmarked, so the next tick checks again; a row whose ciphertext will not open is left out alone, counted in
  `sealed_unreadable`; `/api/notices` lists a notice, of any area, only to people whose role may read its area;
  `npm run test:record-gaps`). Once a UTC
  day (`scheduler_marks`, marked after the work, so a check cut short runs again) `dueCheck(now)` posts one in-app notice per record and due date within the window
  (`workspace_notices`; `/app/notices`, `/api/notices`, mounted only when such an area exists; "edit" dismisses), and
  emails the workspace's own people with those roles (its members in the sign-in's directory, suspended people left out) one
  list of the notices not yet emailed (`due_soon` in `email_log`, keyed by workspace, area, the notices listed and
  recipient, so the same list never reaches a person twice; a notice counts as emailed once it reached one recipient). `npm run test:schedules` proves it with a clock the test
  controls: five missed hours run once, three ticks at once start each run once (and, on Postgres 17 with eight
  concurrent ticks over twenty workspaces, each schedule fired once in five rounds), two workspaces never see or start each
  other's schedules, and due-date emails go only to each workspace's owners. **Not covered:** time zones (UTC only; day
  fields as Vixie cron); per-person limits for unattended runs (there is no launcher; the account's standing applies,
  and its spend counting is the limits tickets', 053/008/018); the run engine's per-workspace cap is a count then an
  insert, so concurrent firings can pass it slightly; a schedule fires at the resolution of the tick (every 5 minutes on
  Vercel).
- **Host packs** (mold_v0-039, built; `src/host.ts`, `src/pack-host.ts`, `src/hosts.ts`; the console's
  `web/src/features/packs/host-web.ts`; `orchestrator/main.ts`). A product whose surface is more than declarations and
  pack tools (the shell's first product, `octillion`) is a **host pack**: its pack.json names `host.entry` (a module whose
  default export is `defineHost({...})`), optionally `host.scripts` (its operator scripts) and `host.profile` (its names).
  Only a pack the build's `profile.json` lists in `host_packs` may be one: the factory writes that list for the packs an
  app names that `mold.json` `packs.host_packs` allows (`packs.py`); gen-packs refuses `host` from any other pack.
  *What a host entry wires, at the shell's fixed points* (with no host pack, each point does what it did, minus the
  product): the customer MCP server's instructions (when the profile has none), resources, tools (before every pack's)
  and prompts (after them), and the caller's context appended to the instructions (`src/server.ts`, `src/http.ts`);
  admin MCP tools placed after a named shell tool, the admin server's instructions listing the reads it ends up with
  (`src/admin-mcp.ts`); routes at the product's own paths: public ones (a webhook), the portal's `/api/app/*` mounted
  **before** the shell's (so its own Setup and Usage replace the shell's neutral ones), its larger request bodies, its
  error classes and its fields on `/api/app/billing`, `/api/admin/*`, `/api/admin/onboarding/*` (inside the shell's
  admin guard, access log and `assertGuarded`: every change names its permission) and `/api/worker/*` (behind the worker
  token, with the calling job's id); the session engine's hooks: scoring a completed session, extending a simulation's
  batch, the agent mix the autoscaler, fleet and Compute page schedule by (`src/agent-mix.ts`: else every registry agent
  at its registry weight); background work on the Vercel cron (its result in the cron's answer), the autoscaler's loop
  and after each successful tool call (`src/analytics.ts`); a new access request; global settings in groups placed after
  a shell group (`src/settings.ts` `settingGroups`, `allSettings`; a setting may go before a named one); its public
  files served after the shell's (else the root page is the shell's own, in the profile's words); the widget preview.
  *Its console* is `web/src/packs/<id>/`: `index.ts` (pages for `/app`, `/admin` and the site's root, by path; its
  landing page, the public pages' layout and metadata), `nav.ts` (sidebar transforms that put its entries among the
  shell's, and the shell features it enables: `tips`, `journeys`, `research`; kept apart from the pages so the sidebar's
  bundle never carries them), `routes.json` (the URLs its pages keep: next.config
  rewrites each, from `src/config/pack-routes.generated.json`, to `app/{app,admin}/host/[pack]/[...path]` or
  `app/(site)/host/[pack]/[...path]`, so `/app/pick-rate` stays `/app/pick-rate`; and its redirects) and `guide.ts` (its
  customer guide, which replaces the shell's short one at /app/docs; pure TS, as the docs corpus reads it). Its docs
  (`packs/<id>/docs/*.md`) join the shell's `docs/` as one folder on /admin/docs and in the docs answers' corpus.
  *Its orchestrator* is `orchestrator/packs/<id>/main.ts`, which `orchestrator/main.ts` runs (else the deterministic
  worker); it is uploaded to orchestrator sandboxes with the rest of `orchestrator/` (its `test/` is not).
  *Its scripts* run with `npm run pack:run -- <script>` (`scripts/pack-script.ts`); `npm run smoke` runs the shell's
  smoke test and then each host pack's `smoke.ts`, and `npm run mcp:check` runs a host pack's `mcp-check.ts` when it has
  one (else the shell's, which lists tools, prompts and resources and reads each resource).
  *The boundary* (`scripts/gen-packs.mjs`): a host pack's server code may import its own files, `src/pack-api.ts`,
  `src/pack-host.ts` and the server's packages, nothing else of the shell (the import graph is resolved as for every
  pack); it may leave a workspace's scope and read the environment (it is the product's reviewed code, in the server's
  process, not a sandbox: the text bans it keeps are the record tables, `SESSION AUTHORIZATION`, `eval` and
  `createRequire`), and it may carry Python data tools and, under `public/`, a `.zip` download. Its scripts are never
  loaded by its server code (refused). Its console code imports its own files, the console's shared code
  (`@/components`, `@/lib`, `@/hooks`, `@/types`, `@/config`, `@/features`, `@/styles`) and the console's packages, and
  reads no server environment; its orchestrator code imports the orchestrator's own files only. Console or
  orchestrator code of a pack that is not a host pack of the build is refused. `src/pack-host.ts` names, by module,
  every shell service a host pack reaches (the database and tenant scope, sealing, settings, telemetry, the result
  shaping of `src/server.ts`, the admin console's helpers, billing and limits, a few email and harness functions,
  the session engine's shared SQL, the one-model call `src/ask-model.ts`, transcripts, the orchestrator's text guard):
  adding a name is a change to the shell's contract and is reviewed as one. Nothing in the shell imports a pack: the
  host list is imported only by the processes' entries (`src/http.ts`, `src/stdio.ts`, `api/index.ts` through it, and
  the scripts that need the product), so no shell module's own imports reach pack code.
  *Its schema* (mold_v0-049). The product's 24 tables (`products`, `scenarios`, `simulations`, `agent_sessions`,
  `transcript_events`, personas and tasks, populations, research, context and memory, journeys, nudges, task sets,
  private harnesses, contributions, reports, product personas) left the shell's base schema for the host pack's own
  migrations (`packs/octillion/migrations/`: `0001_tables`, every statement of the earlier `0001_baseline` about them, in
  order; `0002_row_level_security`, the earlier `0003`'s policies, grants, reference checks and sequence grants for
  them), so a database built with no packs has none of them (`npm run test:zero-pack`). They keep
  their names, which the seam's pack-SQL rules cannot express; this is the **allowance**, for a host pack only (one
  `profile.json` `host_packs` lists), declared in its pack.json `host.schema` and nowhere else:
  - `tables`: its tables under names outside its `<id>_` prefix; never a shell table, another pack's, or a name in another
    pack's prefix (gen-packs and `src/migrate.ts` refuse each). Their indexes and the sequences they own are its own too.
  - Its migrations may also run DO blocks and GRANT, REVOKE and policy statements on those tables (the seam's helpers
    cannot express a parent-scoped table such as `scenarios` through `products`, a shared library readable by every
    workspace, or column-level grants), and define the functions it declares in `functions` (never a shell function,
    never SECURITY DEFINER). The build's scan still refuses, in DO block bodies too as written (a DO block can build a
    statement at run time, so the database check below is the guard that holds): roles, default privileges, SET/RESET ROLE,
    SESSION AUTHORIZATION, `set_config`, disabling or un-forcing row-level security, OWNER TO, inheritance and partitions,
    triggers, rules, views, extensions, schemas, operators, COPY, untrusted function languages and server file functions.
  - `platform_read`: its platform libraries (`library_tasks`, `journey_seed`), which every workspace reads and none
    writes and which had no row-level security in the shell; they stay so (the only pack tables without it): the runner
    refuses one with an `org_id` column or that tenant work may write, and `check:rls` keeps them read-only.
  - The database holds it to the rest whatever the build let through (`src/migrate.ts`): before and after its migrations,
    every relation, policy, grant, column, constraint, function, trigger, rule, role, membership, default privilege,
    inheritance, event trigger, publication and schema that is not its own must be unchanged; the one change allowed on a
    shell table is a foreign key it declares in `references` (a shell column to one of its tables: octillion's is
    `gateway_tokens.session_id` to `agent_sessions`, as before). Rows are not compared: a host pack's migration is the
    product's reviewed code, as its server code is, and could write shell rows; every
    declared table must exist and be under row-level security (but its platform libraries); `check:rls` checks and
    probes them (its policies are the product's: `tenant_isolation`, `tenant_read`, `tenant_write`, `ref_*`).
  - `adopts`: three shell migrations were split once for this (`SPLIT_MIGRATIONS` in `src/migrate.ts`: `0001_baseline`,
    `0003_row_level_security`, `0009_usage_and_limits`, the only merged migrations ever edited, each accepted at its
    earlier checksum, kept in `scripts/fixtures/pre-049-migrations/`). A database that applied the earlier version of a
    split file has the product's part already, rows and all: the host pack's migration that adopts it is recorded there
    without running (its one-time repairs, which already ran, never run again), and refused if its tables are missing.
    Elsewhere it runs (on a schema-on-boot database too, as its baseline did once more before). The gateway's session rule no longer names `agent_sessions` (`octillion_session_org()`, 0003,
    0009 and `0017_gateway_session_policies`, which rewrites it the same way on a database from before), so the shell's
    own policies hold with or without the pack.
  The session engine stays in the shell and reads those tables only in a build whose host pack has them
  (`src/host-tables.ts`, from the build's registry, never from the database); with none it is dormant: no demand, no
  claims, no spend, empty Compute, Accounts, Usage and Billing figures, and a workspace deletes without them. Its admin MCP
  job tools named for simulations (`list_simulations`, `get_simulation`, `cancel_simulation`) are the host pack's, at the
  same places (`adminMcp.tools`, with `adminMcp.reword` for `get_account`'s words and `adminMcp.skills` for the two skills
  that name them); the reads and the cancel behind them are the shell's (`src/pack-host.ts`).
  `npm run test:migrations` proves it: databases at the shell's older versions (schema-on-boot, and the pre-049
  migrations recorded up to 0001, 0003, 0008, 0013 and 0016, each with rows in every table) upgrade with every row identical;
  with no packs their shell schema equals a new one's and the product's tables stay with their rows; with the host pack
  every one comes out identical to a new database, which equals the earlier schema table for table, column for column,
  constraint, index, policy and grant, but for the pack's own bookkeeping and the gateway's rule through its function.
  **Not covered:** the session engine itself is still the shell's code, named for its sessions (a generic job engine is
  `jobKinds`, mold_v0-041); a database built before mold_v0-049 that runs with no packs keeps the product's tables, unused;
  a rollback to a release from before mold_v0-049 runs (its schema is there) but its `db:migrate` reports the split files as
  edited; with zero packs admin-added harnesses cannot be managed in the console (their routes
  add to the product's developer population, so they are the host pack's);
  the starter workspaces (`orchestrator/workspaces/`, neutral framework projects) stay with the engine; the shell's
  console pages still name some of the engine's concepts (simulations on Usage, Billing and Accounts; the library
  contribution credits on Billing; an access request's product fields), the default icons and Open Graph image are the
  first product's; the shell features a host
  pack's routes serve (in-chat tips, Setup's journeys, a requester's research) show only when its `nav.ts` names them; a dropped host pack's console and orchestrator folders are not
  pruned from a reused build copy (gen-packs then refuses the build, which the deploy rebuilds from scratch anyway).
- The profile (`profile.json` over a host pack's own profile over a neutral default, `src/profile.ts`) names the MCP
  server, the email sender and the console title. The codebase's `profile.json` names nothing since mold_v0-039: the
  shell is "Workspace", a build with the host pack `octillion` "Octillion" (its pack.json `host.profile`), a branded app
  its brand's.
- `npm run test:packs` proves it with a fixture pack (`scripts/fixtures/packs/fixture_notes`) in a build copy, and that
  with zero packs the MCP surface (`scripts/export-mcp-tools.ts --full`) is unchanged.

**In the shell.** A pack is a directory the shell discovers at build time. `gen-packs.mjs` (mold_v0-038) reads every
pack in the build copy and writes a generated registry the server and the console import; nothing in the shell names
a pack. A pack's definition is what its pack.json declares (mold_v0-057; the pack.json key in brackets below), extended
by its code entry's `definePack({...})` when it has one (tools and routes are code only):

| Field | What the pack declares | Where the shell puts it |
|---|---|---|
| `tools` | MCP tools: name, input and output schemas, annotations, a handler that receives the calling workspace first | the tool registry behind `/mcp` (today hand-written in `src/server.ts`) |
| `routes` | HTTP handlers | mounted at `/api/packs/<id>` (workspace-scoped, behind sign-in) and `/api/admin/packs/<id>` (platform staff, behind the admin roles), never at a shell path |
| `jobKinds` (`job_kinds`) | run kinds: the runner (`workspace-harness`: its `entry` and `validator` programs in the pack; or `agent-workspace`: an agent repository at a pinned commit with a declared command, validation and write-back), the gateway providers, token lifetime, lease, attempts, budget, egress allowlist, whether it uses the workspace store, what an unresolved result reference does | the run engine (mold_v0-041; agent-workspace mold_v0-061; results mold_v0-065) |
| `workspaceStore` (`workspace_store`) | the workspace store's retention (keep_last, keep_days) and the paths its file viewer never shows (secret_paths) | the daily retention sweep and the console's Files page (mold_v0-056) |
| `onWorkspaceCommit` (code only) | a hook given the files of each committed workspace snapshot, before the run's results are checked | `src/runs.ts` (mold_v0-064) |
| `recordAreas` (`record_areas`) | areas with a `role` (`source`, `check` or `asset`), a `scope` (`platform` or `workspace`), typed fields, list columns, links and references to other areas, a lifecycle and per-role permissions | a list page, a detail page and MCP list/get tools with no extra code (mold_v0-047); fields, states and permissions enforced on every write and move (mold_v0-057) |
| `credentials` (`credentials`) | fields a workspace must give: label, help, bound to the workspace, an asset or an environment, how a run receives it (environment name, or tmpfs file and optionally the variable naming its path) | the workspace credential vault (mold_v0-034, built): the console's Credentials page; a kind's `credentials` names what its runs receive; only names reach a run's definition |
| `schedules` (`schedules`) | default schedules per workspace (a run kind over the workspace's asset records, a cron expression in UTC) | the scheduler (mold_v0-035, built: `src/schedules.ts`), editable per workspace by owners at `/app/schedules`; record areas' `due` dates post notices and email owners daily |
| `onboarding` (`onboarding`) | checklist steps and the event that ticks each off | the `/app` setup checklist (mold_v0-011, built: `src/onboarding.ts`, `/api/onboarding`) |
| `migrations` | versioned SQL for the pack's own tables, prefixed with the pack id (a host pack's under their own names: `host.schema`, mold_v0-049); every workspace-owned table carries the workspace id under row-level security that fails closed | applied after the shell's migrations (mold_v0-031), in pack order; the context lane checks every pack table |
| nav and profile words | console navigation entries, and words the pack shows instead of the shell's (a workspace shown as a "company", a run as an "audit") | the console sidebar (today `web/src/config/nav-config.ts`) and the profile |

Record-area roles: a `source` is where requirements come from (versioned, read-only to customers); a `check` is a unit
checked repeatedly and traced to a source (library at platform scope, its per-workspace state at workspace scope); an
`asset` is what is checked and holds the workspace's private data (workspace scope only, sealed with the workspace
data key). Platform-scope areas are read-only to customers; workspace-scope areas pass the cross-workspace test. A
run's results are rows of (run, workspace, check, asset, status, finding fingerprint, evidence reference).

A pack that wraps an upstream project (the second app's audit-agent pack, for one) pins it by commit in its manifest
and runs it at a process boundary inside the run's sandbox; it is never vendored into the pack or the shell, and never
patched locally (changes go upstream by pull request).

**Source offer and data map (mold_v0-050).** A pack's `upstream` pin (`{repo, commit, license}`, the licence an SPDX id)
is offered when its licence is copyleft (AGPL, GPL, LGPL, MPL, EUPL, ...): the customer MCP server adds a "Source code:"
paragraph to its instructions, and the root page and every install page end with a footer, each naming the project, its
licence and the exact commit's address (`src/source-offer.ts`); an agent kind that runs the same repository at another
commit is refused, so the commit offered is the one that runs. The build's own source is the profile's `source_offer`:
`{"app": {"url", "license"}}` offers it; `{"app": "licensor_exception"}` (the factory's LICENSE-EXCEPTION.md
permission covers whoever runs this deployment; the factory writes it from `defaults.source_offer`) offers no link and
says why; absent, the build says nothing about its own source. With zero packs and no setting nothing changes. The
data-flow and residency statement (`src/data-map.ts`) maps, per pack, where the code runs, where data is stored, the
credentials by name, where model calls go and which hosts runs may reach, from the packs' declarations and the deploy
facts the factory writes into the build copy (`deploy-facts.json`, names and places only, checked by gen-packs); it is
`DATA-MAP.md` in the build copy (`scripts/data-map.ts`) and the console's About page (`/app/about`, `/admin/about`,
linked from the sidebar's footer), which adds what the running server measures (its region, its database's provider and
region, the object store, where each model provider's calls go now). Never a secret value: names, providers, regions and
hosts only.

**Landing page (mold_v0-091).** The console's `/` is the build's landing page, declared, not written: a declarative
pack's `pack.json` `landing` and the app's own `profile.json` `landing` over it, section by section (a section the
profile names replaces the pack's; at most one pack of a build declares one). The sections, all optional, in page order:
`hero` (eyebrow, headline, subheadline, primary and secondary call to action, note), `coverage` (a row of text badges,
such as the regulators covered), `value_points`, `how_it_works` (numbered steps), `features` (a grid), `faq` (disclosures
that open without script), `closing` (a last call to action), `footer` (a note and links) and `seo` (title and description
for search results and Open Graph). Every value is plain text on one line, shown as text; a link is a path of this site,
an https:// address or a mailto: address (`src/landing.ts`, checked by `gen-packs.mjs`, which writes the result and the
source offer's footer items into `web/src/config/landing.generated.ts`). The page (`web/src/features/site/landing.tsx`)
is in the build's brand (its name, tagline, `icon.svg` and the theme's tokens, light and dark) with a header (sign in,
get started, install) and a footer that carries the source offer whenever the install pages do. With no block it is the
neutral page in the profile's words: a hero, what every build does and how to start. A host pack's own landing page
(code, mold_v0-039) stays its own.

**In the factory.** A pack lives at `packs/<pack_id>/` (git-ignored): `pack.json` and a `files/` tree that mirrors the
codebase root and only adds files. An app names its packs in `application.json` (`"packs": ["octillion"]`), and
`packs.py apply <app>` copies them into `build/<app_id>/`, then runs the mold's generators there; deploys and lanes
use that build copy, never `molds/mold_v0/codebase`. The rules are this mold's own (mold_v0-024), in [mold.json](mold.json)
`packs` (a mold without that block, mold_v1, keeps the rules built into `packs.py`): a pack id is the shell's own
(`^[a-z][a-z0-9_]{1,30}$`, also its table prefix), a pack may add files only under `packs/{pack}/` with `{pack}` its own id
(its `pack.json`, entry, migrations and run programs; its console pages render through the shell's generic page and need
no files of their own), and a host pack (mold_v0-039; `host_packs` in mold.json, written into the build's profile.json
by `packs.py`) also under `web/src/packs/{pack}/` and `orchestrator/packs/{pack}/` (gen-packs refuses those folders for
any other pack); every pack must add `packs/{pack}/pack.json` (no hidden or `node_modules` folder, which `gen-packs.mjs` does not read, and no
link), the support test is `scripts/gen-packs.mjs`, the generators `node scripts/gen-packs.mjs` and what depends on the
packs' surface (the console's tool list, the docs corpus, the internal docs), and the checks `node scripts/gen-packs.mjs
--check` and the same `--check` of the tool list and the corpus (`packs.py verify`). A pack file that would
replace a codebase file is refused, as for mold_v1, and a pack folder left in a build copy by an earlier apply for a pack
the app no longer names is pruned. `build_copy` in mold.json says what the copy leaves out (the server deploy's own
excludes) and which installed `node_modules` folders it links (never written).

**Brand.** [branding/rules.json](branding/rules.json): `branding.py <app> set` takes a name, a colour and a logo as for any
app; `prepare` writes the name and words into the copy's `profile.json` (name, console title, email sender, MCP server
name, and the descriptions from the brand's own tagline, else the shell's neutral words, never the product's; a name
with a character the profile cannot carry is refused at `set` and intake; the sender address is kept, a mail-domain
setting) and re-runs `gen-packs.mjs`, writes the favicon set to
`web/src/app` and `web/public` and points the web manifest at it, and sets the console theme's brand tokens (primary, its
foreground, ring) from the colour, its neutrals kept; `check` proves each. It rewrites no source code: since mold_v0-039
the console's own text names the build by the profile (its sidebar mark is the build's `icon.svg`), and a product's
landing page and pages are its host pack's. The codebase's default icons are still the first product's (mold_v0-045).

**Deploy and lanes from the build copy.** An app with packs or a brand is deployed from `build/<app_id>/`, made afresh
from the codebase for every deploy before anything is created or contacted (`lib/single_service.py` `build_source`:
`branding.py prepare`, then `packs.py apply` and `verify`); a step that fails stops the deploy with nothing created, and
the app is not marked reverted. An app with neither deploys from the codebase, as before. The lanes of an app with packs
run in its unbranded lane copy `build/<app_id>.lane/` (`packs.py lane-copy`), as mold_v1's do.

**Two proofs.**

- **Zero packs is a neutral shell.** A build with `packs: []` signs in, has workspaces, keys, the console, the vaults
  and the run engine, passes the smoke test and the tenant-SQL check, and has none of the product's tools, pages or
  tables (mold_v0-038, 039, 049; `npm run test:zero-pack`); the vocabulary check finds no product word in it (mold_v0-045).
- **`["octillion"]` reproduces today's product.** A build of the new shell plus `packs/octillion` has the same surface as
  the old pin: the same MCP tools with the same schemas (the list `scripts/export-mcp-tools.ts` writes), the same HTTP
  routes, the same console pages and navigation, and the same tables. The surface diff between the two must be empty,
  and the re-mint (mold_v0-029) must still pass smoke, `mcp:check` and the isolation sweep (mold_v0-039).

## How the factory runs it

mold_v0 is a **single-service mold**: [mold.json](mold.json) says so, and every factory script hands such an app to
`.claude/scripts/lib/single_service.py` before any mold_v1 path. A deploy never changes the codebase: what the factory needs
(the compose project's default name, the service it builds, its port, the env names it requires or accepts, the
health check, the row-level security check) is read from the codebase's own `deploy/docker-compose.prod.yml`,
`deploy/bootstrap.sh`, `Dockerfile` and `package.json` each time.

**Mint.** `mint.py new <app> --brief briefs/<app>.md` (the brief says `Mold: mold_v0`) runs the same ten stations as any
app. *workspaces* and *package* are "not needed", each with the reason in mold.json: organisations made in the product's
own console, no agent package. *packs* and *brand* read as for any app (mold_v0-024); intake takes `Packs:` and `Brand:`,
`Brand colour:`, `Logo:` and `Tagline:` lines from the brief. `code-request`, `code`
and `reuse-keys` refuse a mold_v0 app.

**Intake.** The same four state files and schemas. It asks only where the app runs, unless the brief says ("its own
server", or "Vercel"), and takes the domain from the brief (`Domain: app.example.com`). Fields only this shape uses:
`infrastructure.compose_remote` (target `compose_remote`), `postgres.exposure: "compose_network"` and
`blob.provider: "none"`. `postgres.rls` is `"fail_closed"` (mold_v0-051): the product puts every tenant table under
row-level security for a per-database tenant role, and a query with no organisation set sees no tenant rows. Intake
writes it from [mold.json](mold.json) `rls` only while the codebase's `package.json` has that check (`check:rls`);
without it, `"off"`. Tenant rows are also scoped in the queries themselves, which the tenant-SQL check guards.

**Row-level security on every deploy (mold_v0-051).** After the health checks, each deploy runs the product's own
`npm run check:rls` (its catalog check, then a live two-organisation probe inside a transaction that is always rolled
back) against the **deployed** database, and writes the verdict to `datastores.postgres.rls_verified`; a check that
fails or cannot run is a failed health check, so the deploy goes back to what served before.
`provision.py <app> --verify-rls` runs it again and records it. What each target honestly proves:

- *Its own server:* the check runs in a one-off container of the new release's image with the server's env file, as
  the product's own `deploy/rolling-deploy.sh` does: the same code, database and login the serving containers use.
  Recorded `running_app: "enforced"`.
- *Vercel:* nothing can run inside the function, so the check runs on the factory machine (from the same codebase the
  deploy just uploaded; it needs the codebase's dependencies installed) against the api
  project's production `DATABASE_URL`, read back and never shown, right after the deployment that reads it was built.
  It proves the database the function uses. The function's own probe (`/healthz` `rls_probe`, run by the product's cron
  at most hourly) is read and recorded as it said: `"ok"` is `enforced`, `"failed"` fails the deploy, and `"not run"`
  (a fresh deployment) is `unmeasured`, never `enforced`. `factory.py validate` accepts `unmeasured` for this mold only,
  because the database proof is there and the product refuses tenant queries in a process whose start-up catalog check
  fails (the product's own guarantee, which the factory reads in its code but does not observe).

**Its own server** (target `compose_remote`; a deploy that comes up but fails its health checks switches back to the
release that served before, by itself): `provision.py <app> --set-remote host=<address> domain=<name>`,
`--remote-key`, then `--deploy-remote` (see every step first with `--dry-run`). It reuses vm_remote's host probe, SSH,
DNS check, key pair, hidden prompt and env file, then:

1. checks on this machine that the snapshot has every file the two image builds copy (the API's `Dockerfile` and the
   console's `web/Dockerfile`), that every name the compose file requires is written from state or minted by the
   product's own `bootstrap.sh`, that state lists the console's two sign-in names as the operator's values, and that
   the compose project is `sf-<app id>`, never the compose file's own default name, which another copy of the product
   uses;
2. qualifies the server: Ubuntu 24.04, sudo, systemd, 4 GB, 2 CPUs, 20 GB free, no other web server, and the web
   ports free or held by this app's own project. It refuses a server where another stack already answers on 80/443;
3. installs Docker and its compose plugin if absent, ufw (SSH, 80, 443 only) and fail2ban;
4. copies the source into a new release directory beside the serving one;
5. writes `DOMAIN` and `PUBLIC_URL` from state into `/etc/software-factory/<app>/env` (root, mode 600), then mints every
   name still missing (the database password and the product's keys) with the product's own `bootstrap.sh`, on the
   server, in a private temp directory that sees names and never values. The console's Clerk keys
   (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, mold.json `compose.console.operator_env`) are optional since
   mold_v0-004: without them the stack runs the built-in sign-in; an app whose state lists them in `secrets_user`
   keeps Clerk and the deploy asks for each at a hidden prompt when the server lacks it (or the operator sets it first
   with `provision.py <app> --set-secret NAME`). Other optional keys (billing, analytics, Google sign-in) stay off until the operator sets one;
6. points `current` at the new release, builds the API's image and then the console's, one at a time (a 4 GB server
   cannot run both builds at once), and runs `docker compose -p sf-<app> ... up -d --build --wait`; on failure it
   switches back to the release that served before and brings that up;
7. checks health: the API's and the console's containers healthy and not running as root, only Caddy publishing
   ports, `https://<domain>/healthz` answering 200 `{"ok": true}` from outside **through the console** (so it reaches
   the API), and `/admin` and `/app` answering without following a redirect (a page, its sign-in redirect, or
   401/403; never a 5xx or nothing). Then old releases are removed.

HTTPS comes from the stack's own Caddy (automatic certificate for `DOMAIN`), which is why the domain must point at the
server first. `--rollback-remote` goes back to the previous release by hand.

**Vercel** (target `vercel`): **two projects**, by the operator's decision of 2026-10-20 (mold_v0-029). Nothing is
typed by hand, and nothing in the snapshot changes:

- `<project>-api` is the API and MCP function, deployed from the product's own `vercel.json` (one function and its
  cron). `<project>` is the web console: `web/`, a server-rendered Next.js app behind a middleware, deployed as its own
  Next.js project from `web/` (its own `vercel.json` and committed `package-lock.json`). The console is pointed at the
  API through the one variable its `next.config.ts` reads for the API's address (`process.env.NAME ?? 'http://...'`),
  found there at plan time; its fallback rewrite then carries every other path (the landing page, `/mcp`, `/api`,
  `/healthz`) to the API, so people open one address. [mold.json](mold.json) declares the shape (`vercel.projects`).
- Both names pass the same refusals before anything reads or writes them: never one of the live projects, never a
  name another app holds (its base, `-api` or `-workflow`, or the names its state records). Both are created with
  `vercel project add <name> --scope <team>` and unhooked from git; the console's framework preset is set to Next.js.
  When neither exists yet and a name is taken in the team or on vercel.app, the free base provision.py chooses is
  used for both and recorded in `vercel.name_history`; intake already suffixes a default base whose either name
  another app holds, and says so.
- Only the api project gets the app's own Postgres, through provision.py's Neon provisioning (an empty free database
  adopted, or a new one from the Vercel Marketplace, each proven empty with the product's own `pg` client before the
  project is connected; `DATABASE_URL` is the one the integration writes, never written by the factory and never
  replaced), and only it gets the keys the product's `bootstrap.sh` mints and `CRON_SECRET`. Its `PUBLIC_URL` is its own
  address, so connector addresses point straight at the function.
- The console gets the API's address in its API-address variable and nothing else of the API's: never `DATABASE_URL`,
  never a minted key. The only other names it reads are its sign-in keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `CLERK_SECRET_KEY`, mold.json `operator_env`), set by the operator with `provision.py <app> --set-secret NAME`, which
  writes a name to every project that reads it (`CLERK_SECRET_KEY` to both, the publishable key to the console only).
  Since mold_v0-004 both are optional: without them the console and the API run the built-in sign-in (an emailed code,
  Google when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set on the API), and the console's `src/proxy.ts` only
  sends a visitor without a session cookie to `/auth/sign-in`. An app whose state already lists them in
  `secrets_user` (the re-mint and its live copy) keeps Clerk, and the check still asks for them. For the built-in
  sign-in on two Vercel projects, the factory writes the console's address on the API project as
  `APP_CONSOLE_URL` (mold.json `vercel.projects.api.env`, mold_v0-084), with `APP_PROXY_HOPS=1`: sign-in
  codes, invitations and every other email link to the console. On a server of its own both are in the env file
  (`compose.config`: the domain, and the stack's Caddy).
- Order: the API first (twice on a first deploy, so it reads its own address as `PUBLIC_URL`), its `/healthz` must
  answer 200 ok; then the API-address variable on the console, then the console; then, when the console's address is
  not the one the API holds (a first deploy, a new domain), the API once more with it, health-checked again. Health on the console: `/healthz`
  through the console answers 200 ok (so it reaches the API), and `/admin` and `/app` answer, read without following a
  redirect (a page, its sign-in redirect, or 401/403; never a 5xx or nothing).
- When anything after the first deploy fails (a health check, a build, an address that cannot be read), **both**
  projects go back to the production deployment that served before, where there was one, and the app is recorded as
  reverted with the reason and `vercel.rollback`. A later good deploy is promoted past that rollback on both.
- State: `vercel.project` (the base), `vercel.projects` (`api`, `web`), `vercel.api_url`, `vercel.production_url`
  (the console's: it is what people open, and it carries the API's paths too), `vercel.health` (`api`, `web`, and the
  console's `pages`), `vercel.release` (what served each project before the deploy). The lanes' MCP check targets the
  API: `--lane-key` reads `DATABASE_URL` from the api project and keeps a connector address for `vercel.api_url`.

`--deploy --dry-run` prints every step; `provision.py <app>` is the read-only check of both projects. The rehearsal in
`lib/single_service_selftest.py` runs the whole sequence through provision.py against `fixtures/release/fake.py`
(FACTORY_REHEARSAL): nothing real is contacted.

**Run sandboxes on both targets (mold_v0-055).** On Vercel the api project's cron and a kick when a run is queued
launch runs into the sandbox provider whose key is in the vault (its function includes `src/**` so it can upload the
runner); with no key, runs wait and say so. On a server of its own the compose project's `runner` service (the app's
image, no port, the Docker socket, `APP_RUN_API_URL=http://api:3333`) launches a container per run on the
`runs` network, or uses the provider when its key is in the vault. Neither needs a new env name: every setting has a
default (`APP_RUN_SANDBOX`, `APP_MAX_RUN_SANDBOXES`); `deploy/rolling-deploy.sh` recreates the runner on the new
image.

**The console on a server of its own (mold_v0-020).** The compose stack runs the console as a service of its own,
`console`: `web/Dockerfile` builds it with Next.js standalone output (`next.config.ts` `BUILD_STANDALONE`) from the
codebase root, so the internal docs and a host pack's docs are bundled as on Vercel, and a host pack's console files
(`web/src/packs/<id>/`, in the app's build copy) are in it. It runs as `node`, publishes no port, and is the second
of the stack's two built services (the API's `Dockerfile` no longer has a web stage). It sits on the stack's `edge`
network only, with Caddy and the API: it cannot reach the database or the run containers. The stack's Caddy sends the
API's own paths (`/mcp`, `/api/*`, `/gw/*` with the model streams, `/.well-known/*`, `/admin/session`, `/admin/mcp`,
`/install*`, `/preview/*`) straight to the API's replicas, and everything else (the console's pages and assets,
sign-in, the public pages, `/healthz`) to the console, whose fallback rewrite reaches the API at
`http://api:3333` inside the network for anything that is not one of its pages. The console holds that address
and its two sign-in names, nothing else of the API's. Its build arguments are public values only (the API's address,
the publishable key the browser needs, the public address); `CLERK_SECRET_KEY` is given at run time.
`deploy/rolling-deploy.sh` builds both images one after the other and rolls the API, then the console, each a new
replica healthy before the old one stops, and recreates Caddy when its routes changed (a few seconds without
answers, once) or reloads it otherwise. The factory's `up.sh` does the same for any container still holding a file the
previous release mounted (the Caddyfile is mounted through `current`, a path every release shares), and a rollback to
a release from before the console builds only the services that release has.

**Lanes** (`molds/mold_v0/testing/`, run by `lanes.py` as for any mold, in the app's lane copy `build/<app_id>.lane/`
with its packs; mold_v0-021): every lane has a harness, and every lane prints **a row per pack** (the shell's, each host
pack's, each pack's), so one pack's failure is visible on its own. *functional* runs the product's
`npm run typecheck`, `npm run test:migrations` (embedded throwaway databases only; `MIGRATIONS_PG_URL` unset), `npm run
smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep) and `npm run mcp:check` against
the deployed address, then `packs.tools` (each pack's MCP tools listed for a fresh workspace's owner and its read-only,
argument-free tools called, on an embedded database); *context* runs `npm run check:tenant-sql` and `npm run check:rls`
on a throwaway embedded database (the deployed database is proven by the deploy itself, above), then `packs.tables`
(every `<pack>_*` table under row-level security, forced, with a policy). `test:migrations` also upgrades from older
versions of `sql/schema.sql` found in git history; this repository holds one version of that file, so that part has
nothing to run here (the lane says so). *load* (`load/load.py`) is the one lane that contacts the deployed app: after a
warm-up, 30 seconds of 4 clients under 8 requests a second and 240 requests, over `tools/list`, every read-only tool
that needs no argument (the lane-check organisation's key) and the console's public pages; per pack and overall, errors
at most 1%, p50 at most 1500 ms, p95 at most 5000 ms, and a tripped threshold is measured once more before the lane
fails. It sends nothing until both addresses are proven the app's own (Vercel: one of the app's projects serves it;
its own server: the address its deploy recorded). *accessibility* (axe-core 4.13.0, WCAG 2.2 A/AA, serious and critical
fail) and *responsiveness* (phone 390, tablet 820, desktop 1440: sideways scroll and 24px tap targets) grade the
console's pages **from the lane copy, served on the factory machine** (`testing/console/`): `render.py` builds
`build/<app_id>.lane-console/` (the lane copy's `web/`, `next build --webpack`, with a lane stand-in for
`@clerk/nextjs` in that build only, since a local copy cannot reach Clerk with the app's keys), and `world.mts` serves it
on 127.0.0.1 against the lane copy's API on an embedded throwaway database behind the shell's offline Clerk
(`scripts/lib/test-world.ts`, `mock-providers.ts`), signed in as one workspace's owner who is also platform staff; every
request a page makes off the machine is aborted. The pages are read from the build (`console/surface.mts`): the shell's
own, each host pack's `routes.json` and each pack's tabs, pages and record areas. Clerk's own widgets and the deployed
console's bytes are not graded (each lane's `not_covered` says what is not). The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**The CI gate (mold_v0-040).** `provision.py`'s release gate (`lib/deploy_gate.py`) reads, for an in-tree mold, **this
repository's** checks for the commit being deployed: HEAD of the checkout the deploy runs from, and only when
`molds/mold_v0/codebase` on disk is exactly that commit (no tracked change, no untracked file, and no ignored file the
deploy would carry other than mold.json's `source_excludes`, such as `node_modules` and `.env`). Then:

- once mold_v0-001 names the shell's own workflow in [mold.json](mold.json) (`source.ci.workflow`), that workflow's run
  for the commit must have passed with every job it defines, the same rules as mold_v1's `ci.yml`;
- until then, at least one of this repository's **own** checks (a GitHub Actions run of its workflows) must have
  succeeded for that commit, and no check or status at all (from any app) may have failed or still be running. A
  check or status posted by an outside app (a git-connected deploy service, a bot) can refuse a deploy but never pass
  one, and a skipped check never counts. None of these checks tests the shell yet, so a green verdict says only "this
  repository's own checks passed for this commit", and the recorded verdict says exactly what was read.

Today this repository runs no workflow, so the verdict is *missing* and a mold_v0 deploy needs
`--allow-unverified-mold "<reason>"` (recorded in `infrastructure.json` `deploy_gate.override`). A check that failed, one
still running, GitHub not answering, no GitHub `origin`, or an uncommitted change refuses as for any mold.

**Known before the first deploy (mold_v0-029).** The codebase commits `web/package-lock.json`, so the server deploy's
preflight no longer refuses for it and the console project can install exactly.
