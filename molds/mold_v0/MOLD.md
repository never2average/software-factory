# mold_v0

**Status:** work in progress. Started as a verbatim snapshot of the operator's existing MCP product, by the operator's decision (2026-10-20): *clone first, generalise after*. **Authored in this repository since the fork point below** (operator decision D1, 2026-10-20; mold_v0-040).

**Source: in-tree.** `molds/mold_v0/codebase` is edited here, by pull request to this repository like any other file. The fork point is factory commit `e8d836532cb7` (the last refresh, which took in the product's hardening, mold_v0-031), a snapshot of the product at `7399bd4c3611` (snapshot 2026-10-21). Both are recorded in [mold.json](mold.json) (`source`: `in_tree`, `since`, `forked_from`) and in `state/factory.json` (`molds[mold_v0].source.in_tree`, `in_tree_since`). Nothing is fetched from the product's repository again: `mold.py refresh mold_v0` refuses, `mold.py fetch mold_v0` writes nothing, and `mold.py check mold_v0` reports "in-tree since e8d836532cb7", the last commit that changed the codebase and any uncommitted change under it. An app's `mold_commit` is the last commit of this repository that changed the codebase (the fork point reads as `7399bd4`, the same files), so `mint` shows a redeploy due after each merged change.

## Two recorded exceptions

**Edited in place (mold_v0-040).** AGENTS.md says a mold's codebase is never edited in place and base-code changes go to the mold's source by pull request. mold_v0 is the one exception: its source is this repository. A change to the shell is a pull request here that touches `molds/mold_v0/codebase`; the deploy gate then reads this repository's checks for the commit being deployed (below). mold_v1 keeps the rule unchanged: its snapshot is only ever written by `mold.py fetch|refresh` from its own source, and nothing in this exception reads or writes it.

**A product, being made a general shell.** Molds are general-purpose: no product or customer words, apps declared through a profile and packs. mold_v0 started as the opposite, a working product copied as it is, so the factory could reproduce it straight away (ticket mold_v0-029) and mint a second product from it (mold_v0-030). It becomes general step by step: [SCOPE.md](SCOPE.md) names each capability of the **agent-run shell**, where it lives and the ticket that generalises it (mold_v0-038 to 050, with the surviving older tickets). Since mold_v0-039 the product's own surface (its 31 MCP tools, widget and slash commands, its domain modules, its routes, console pages, landing page, docs, orchestrator extension, client skill and operator scripts) is the factory's **host pack `octillion`** (`packs/octillion/`, git-ignored like every pack: "Host packs" below; since mold_v0-145 the **engine pack `apo`**, run by Octillion's config pack: "Engine packs and config packs" below), and an app minted from mold_v0 with no packs gets a neutral shell. Since mold_v0-049 its tables are the pack's own migrations too: a shell with no packs has none of them. What still carries the product in the shell: the session engine that reads those tables in a build that has them (the job queue, the autoscaler's jobs, the Compute and Accounts pages; dormant without them). Its name left the shell's words and environment names in mold_v0-045 ("Neutral words and environment names" below): what is left of it is listed, with what holds each, in the vocabulary check's allow list.

## What is in it today

- A TypeScript server (Express, `src/http.ts`) with a stateless MCP endpoint (`/mcp`: the host packs' tools, then every pack's, `src/server.ts`), per-organisation API keys (hashed) and per-member keys (header-only, expiring, with the member's role; mold_v0-007), sign-in (built-in emailed code and Google, or Clerk; mold_v0-004), client install guides, onboarding, usage analytics, billing and email.
- An agent-run engine: a job queue (`src/worker.ts`, `/api/worker`), an autoscaler that launches one sandboxed orchestrator per job (`src/autoscaler.ts`, `orchestrator/`), pinned coding-agent harnesses (`harnesses/registry.json`), an inference gateway with per-session tokens and cost metering (`src/gateway.ts`, `src/usage.ts`), a versioned key vault and per-organisation data keys (`src/keyvault.ts`, `src/orgcrypto.ts`), transcripts and an off-machine archive.
- A web console in `web/` (Next.js): `/admin` for platform staff, `/app` for an account's people. Its top bar (both areas, every app; mold_v0-177): search, Docs (and admin's MCP) at one height, the search box's (44px icon buttons on a phone), and a Light / Dark / System theme switcher kept per browser; System follows the device live. Dark is the default, what every console showed before; the pages outside the console stay dark. An inline script in `<head>` (`web/src/components/themes/color-mode.ts`) puts the mode on `<html>` before the first paint.
- Postgres with versioned migrations (`sql/migrations/NNNN_*.sql`, `src/migrate.ts`, `npm run db:migrate`; proven by `npm run test:migrations`) and row-level security on every tenant table (`sql/migrations/0003_row_level_security.sql`, `src/rls.ts`; proven by `npm run check:rls`), plus optional analytics and archive stores.
- Two ways to run: its own server (Docker Compose with HTTPS) and Vercel.

## Hardening (ticket mold_v0-031, done)

API keys out of URLs, OAuth token audience checked, Origin validated on the MCP endpoint, no static admin token, database row-level security proven on every deploy, and versioned migrations: all in the codebase since the fork point. The factory's side of it is mold_v0-051 (intake, the deploy's RLS check, the lanes; below).

## Neutral words and environment names (mold_v0-045)

**Environment names.** Every variable the shell reads is `APP_` and a name (`APP_VAULT_KEY`, `APP_WORKER_TOKEN`,
`APP_PROXY_HOPS`, ...): short, the factory's own word for what it mints, and no clash with the shell's `SHELL` or a
product's name. Until mold_v0-045 they had the first product's prefix, and apps deployed before then (the re-mint
`octillion`, the audit app) hold their values under those names on Vercel or in a server's env file: **each old name is still
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
databases and the host pack read them by name; their environment value is read under the `APP_` name first). The names
held outside a release (the database's functions, tenant role and setting; the agent images' tags and boat templates; the
orchestrator sandboxes' service unit, home and host marker) were renamed by mold_v0-097, each with its old name still
answered to until a later cleanup: "Neutral names held outside a release" below.

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

**Neutral names held outside a release (mold_v0-097).** What a running database, host or sandbox already held under
the first product's name, renamed so that what holds it keeps working, the old name still answered to until a later
cleanup (the vocabulary check's `legacy-*` entries list where each old name is still spelled, and why):

| Held by | Name | How the old one keeps working |
|---|---|---|
| the database (`sql/migrations/0024_neutral_database_names.sql`) | functions `app_tenant_role()`, `app_tenant_org()`, `app_session_org()`, `app_run_charge*()`; role `app_tenant_<hash>`; setting `app.org_id` | renamed in place (policies, the trigger and grants hold them by id: none rewritten, no table locked, no row touched); each old function a one-line alias; the old role a member of the new one with nothing of its own, for the release still serving during a rolling deploy; the old setting read when the new one is unset; a policy a pack migration writes through an old function re-pointed by the runner. `check:rls` holds the alias role to that and probes the old path. A rollback to a release from before: `sql/rollback/0024_neutral_database_names.sql` (docs/migrations.md "Rolling back") |
| a host's local images (`harnesses/registry.json` `image.docker`, `SANDBOX_IMAGE`) | `app/agent-<harness>:<version>`, `app-sandbox:latest` | a tag the host does not have runs under its old name when only that is built (`orchestrator/core/runners.ts` `localImage`); images are never pulled (`--pull never`); `deploy/cleanup.sh` removes the old tag once the same version is built under the new one |
| the boat account's named snapshots (`image.boat_snapshot`) | `app-<harness>-<version>` | nothing starts from a snapshot by name; the next bake (`orchestrator/images/boat-snapshot.sh`) saves the new names and the old snapshots can then be deleted |
| an orchestrator sandbox (`orchestrator/deploy/boat-lib.ts`) | unit `app-orchestrator`, home `/home/user/app`, marker `/etc/app/host-role` | a sandbox set up before keeps running until the launcher configures it again (`update`, a relaunch), which stops, disables and removes the old unit and deletes its home (with its env file) and marker; `down` stops whichever unit runs; `status` and `logs` read it |
| the boat account's sandboxes and snapshot images, a Docker host's run containers (mold_v0-156, `orchestrator/core/boat-namespace.ts`) | the default namespace `app` (`appv` on Vercel): `app-orch-*`, `app-w-<orchestrator>-<agent>`, `app-run-*`, `app-orch-img-*`, `app-img-build`, run containers labelled `app.<project>_runs` | with `APP_BOAT_NAMESPACE` unset, the old default of the same runtime is ours too: what was named under it (orchestrators launched before the update and their workers, a run sandbox or container mid-run or left over, the last snapshot image, an image builder) is listed, counted on the boat plan and the Compute page, and reaped as ours, never leaked or counted as another deployment's; nothing new is named under it. Orchestrators from before are retired on the deploy as always (old code), their workers with them. A deployment that sets `APP_BOAT_NAMESPACE` is unchanged |
| an orchestrator sandbox's service user (mold_v0-156) | `appsvc` | configure makes it and the unit runs as it; a sandbox set up before keeps its old account (no sudo, no login, owns only its home), which nothing runs as once configured again, and goes with the sandbox |
| a runner host's uid leases and checkout cache (mold_v0-156, `src/run-users.ts` `hostDir`) | `/run/app-run-uids`, `/var/cache/app-checkouts` | a host that has the old directory and not the new keeps using the old one, so a runner of the release before and one of this release never lease one uid from two directories during a rolling deploy; the leases move at the next boot (`/run` is cleared), the cache once its old directory is deleted |
| what a release's own image or sandbox set-up makes and uses within that release (mold_v0-156) | run users `apprun`, `apprun-<uid>`; the egress proxy's user `appproxy`, unit `app-egress-proxy`, files `/opt/app-egress`, logs `/var/log/app-egress.*`, firewall table `app_egress`; the run tools `/opt/app-tools`; the runner unit `app-runner`; a worker sandbox's `/tmp/app`, `.app-env`, `.app-snap.git`; pods `app-pool-*`, `app-busy-*` | nothing to keep: the runner image (the app's own `Dockerfile`) is built again by every deploy, and run, worker and pod sandboxes live one run or session on the code that set them up. `fleet/status.ts` counts a pod renamed busy under any prefix as busy |

Proof: `npm run test:migrations` (an 0023 database with rows upgraded, every row kept; the old release's tenant
transaction before and after; the alias role held to nothing; the rollback leaving exactly what 0023 left; on a real
Postgres also a database dropped and made again under one name), `npm run check:rls`, `npx tsx
orchestrator/test/legacy-names.ts` (the image fallback over a stand-in docker; configure and stop run over a stand-in
sandbox set up before; mold_v0-156: the namespace's old default as ours, a set one alone), `npm run
test:run-sandboxes` (run sandboxes and run containers under the old default reaped as orphans, another deployment's
kept; the Compute page's classification), `npm run test:run-users` (a host's old lease directory kept while it has only
that one: a uid the release before holds there is never handed out), and the host pack's autoscaler test (orphan,
stale and stuck orchestrators and workers under the old default reaped).

**The vocabulary check** (`npm run check:vocabulary`, also run by the smoke test; `npm run test:vocabulary` proves it)
fails when a product word (`scripts/vocabulary.json` `words`) is in a file of the shell, in its text or its path, outside
the allow list, where each entry is an exact spelling, the files it may be in and what holds it; an entry that covers
nothing fails too. The product word's short forms are words too (mold_v0-096: the abbreviation runtime identifiers
used, and its Vercel twin). mold_v0-156 renamed what carried them (above); two entries are left, each one file:
`legacy-boat-namespace` (the namespace's old defaults, `orchestrator/core/boat-namespace.ts`) and
`legacy-runner-host-dirs` (a runner host's old lease and cache directories, `src/run-users.ts`); a run user, tools
directory or sandbox name with a short form fails anywhere. A pack's own files are not read. It also checks the table below, which it writes
(`npm run check:vocabulary -- --write`) from every `APP_` name in the shell's code and deploy files.

<!-- env-names:begin (generated by `npm run check:vocabulary -- --write` in the codebase; do not edit) -->

182 names. The old name is read only when the new one is unset (src/env-names.ts); a family (`*`) is every name with that start.

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
| `OCTILLION_CATALOG_AUTOINDEX` | `APP_CATALOG_AUTOINDEX` |
| `OCTILLION_CONSOLE_URL` | `APP_CONSOLE_URL` |
| `OCTILLION_DATA_ALLOW_FILE_UPSTREAM` | `APP_DATA_ALLOW_FILE_UPSTREAM` |
| `OCTILLION_DATA_ALLOW_PRIVATE` | `APP_DATA_ALLOW_PRIVATE` |
| `OCTILLION_DEFAULT_SAMPLES` | `APP_DEFAULT_SAMPLES` |
| `OCTILLION_DEV_ALLOW_LOCAL` | `APP_DEV_ALLOW_LOCAL` |
| `OCTILLION_DEV_ENV` | `APP_DEV_ENV` |
| `OCTILLION_DIR` | `APP_DIR` |
| `OCTILLION_DIRECT_KEYS` | `APP_DIRECT_KEYS` |
| `OCTILLION_DOCKER_SOCKET` | `APP_DOCKER_SOCKET` |
| `OCTILLION_DOCUMENT_FETCH_STANDIN` | `APP_DOCUMENT_FETCH_STANDIN` |
| `OCTILLION_DRAIN_SECONDS` | `APP_DRAIN_SECONDS` |
| `OCTILLION_EGRESS` | `APP_EGRESS` |
| `OCTILLION_EMAIL_ALLOWED_PRIVATE_HOSTS` | `APP_EMAIL_ALLOWED_PRIVATE_HOSTS` |
| `OCTILLION_EMAIL_ALLOW_INSECURE` | `APP_EMAIL_ALLOW_INSECURE` |
| `OCTILLION_EMAIL_BACKFILL_MAX_MESSAGES` | `APP_EMAIL_BACKFILL_MAX_MESSAGES` |
| `OCTILLION_EMAIL_GMAIL_URL` | `APP_EMAIL_GMAIL_URL` |
| `OCTILLION_EMAIL_GOOGLE_TOKEN_URL` | `APP_EMAIL_GOOGLE_TOKEN_URL` |
| `OCTILLION_EMAIL_GRAPH_URL` | `APP_EMAIL_GRAPH_URL` |
| `OCTILLION_EMAIL_INTAKE` | `APP_EMAIL_INTAKE` |
| `OCTILLION_EMAIL_INTAKE_MAX_MESSAGES` | `APP_EMAIL_INTAKE_MAX_MESSAGES` |
| `OCTILLION_EMAIL_MS_LOGIN_URL` | `APP_EMAIL_MS_LOGIN_URL` |
| `OCTILLION_EMAIL_NOTIFICATIONS` | `APP_EMAIL_NOTIFICATIONS` |
| `OCTILLION_EMAIL_PROVIDER` | `APP_EMAIL_PROVIDER` |
| `OCTILLION_EMAIL_TIMEOUT_SECONDS` | `APP_EMAIL_TIMEOUT_SECONDS` |
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
| `OCTILLION_LEDGER_PUBLIC_KEYS` | `APP_LEDGER_PUBLIC_KEYS` |
| `OCTILLION_LEDGER_SIGNING_KEY` | `APP_LEDGER_SIGNING_KEY` |
| `OCTILLION_LIMIT_*` | `APP_LIMIT_*` |
| `OCTILLION_LIMIT_ENDPOINTS_*` | `APP_LIMIT_ENDPOINTS_*` |
| `OCTILLION_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE` | `APP_LIMIT_ENDPOINTS_INVITES_PER_HOUR_PER_WORKSPACE` |
| `OCTILLION_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE` | `APP_LIMIT_ENDPOINTS_KEYS_PER_HOUR_PER_WORKSPACE` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNIN_CHECKS_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS` | `APP_LIMIT_ENDPOINTS_SIGNIN_CODES_PER_HOUR_PER_ADDRESS` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNIN_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP` | `APP_LIMIT_ENDPOINTS_SIGNUP_PER_HOUR_PER_IP` |
| `OCTILLION_LIMIT_MCP_*` | `APP_LIMIT_MCP_*` |
| `OCTILLION_LIMIT_MCP_PER_IP_PER_MINUTE` | `APP_LIMIT_MCP_PER_IP_PER_MINUTE` |
| `OCTILLION_LIMIT_MCP_PER_KEY_PER_MINUTE` | `APP_LIMIT_MCP_PER_KEY_PER_MINUTE` |
| `OCTILLION_LIMIT_MCP_PER_MEMBER_PER_MINUTE` | `APP_LIMIT_MCP_PER_MEMBER_PER_MINUTE` |
| `OCTILLION_LIMIT_MCP_PER_WORKSPACE_PER_MINUTE` | `APP_LIMIT_MCP_PER_WORKSPACE_PER_MINUTE` |
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
| `OCTILLION_MCP_URL` | `APP_MCP_URL` |
| `OCTILLION_MIGRATE_ON_BOOT` | `APP_MIGRATE_ON_BOOT` |
| `OCTILLION_MIN_ONE_SANDBOX` | `APP_MIN_ONE_SANDBOX` |
| `OCTILLION_MODELS` | `APP_MODELS` |
| `OCTILLION_MODEL_DAILY_BUDGETS` | `APP_MODEL_DAILY_BUDGETS` |
| `OCTILLION_NUDGE_INTERVAL_HOURS` | `APP_NUDGE_INTERVAL_HOURS` |
| `OCTILLION_OAUTH_ACCESS_MINUTES` | `APP_OAUTH_ACCESS_MINUTES` |
| `OCTILLION_OAUTH_AUDIENCE` | `APP_OAUTH_AUDIENCE` |
| `OCTILLION_OAUTH_REFRESH_DAYS` | `APP_OAUTH_REFRESH_DAYS` |
| `OCTILLION_ONPREM_RUNNERS` | `APP_ONPREM_RUNNERS` |
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
| `OCTILLION_RUNNERS_PER_WORKSPACE` | `APP_RUNNERS_PER_WORKSPACE` |
| `OCTILLION_RUNNER_ALLOW` | `APP_RUNNER_ALLOW` |
| `OCTILLION_RUNNER_ALLOW_HTTP` | `APP_RUNNER_ALLOW_HTTP` |
| `OCTILLION_RUNNER_CAPACITY` | `APP_RUNNER_CAPACITY` |
| `OCTILLION_RUNNER_DEBUG` | `APP_RUNNER_DEBUG` |
| `OCTILLION_RUNNER_ENROLL_HOURS` | `APP_RUNNER_ENROLL_HOURS` |
| `OCTILLION_RUNNER_IMAGE` | `APP_RUNNER_IMAGE` |
| `OCTILLION_RUNNER_IMAGE_REF` | `APP_RUNNER_IMAGE_REF` |
| `OCTILLION_RUNNER_ISOLATION` | `APP_RUNNER_ISOLATION` |
| `OCTILLION_RUNNER_MAX_CAPACITY` | `APP_RUNNER_MAX_CAPACITY` |
| `OCTILLION_RUNNER_NAME` | `APP_RUNNER_NAME` |
| `OCTILLION_RUNNER_NETWORK` | `APP_RUNNER_NETWORK` |
| `OCTILLION_RUNNER_OFFLINE_REAP_MINUTES` | `APP_RUNNER_OFFLINE_REAP_MINUTES` |
| `OCTILLION_RUNNER_ONLINE_SECONDS` | `APP_RUNNER_ONLINE_SECONDS` |
| `OCTILLION_RUNNER_POLL_SECONDS` | `APP_RUNNER_POLL_SECONDS` |
| `OCTILLION_RUNNER_STATE_DIR` | `APP_RUNNER_STATE_DIR` |
| `OCTILLION_RUNNER_TOKEN` | `APP_RUNNER_TOKEN` |
| `OCTILLION_RUNNER_URL` | `APP_RUNNER_URL` |
| `OCTILLION_RUNNER_WAIT_SECONDS` | `APP_RUNNER_WAIT_SECONDS` |
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
| `OCTILLION_RUN_PRIVATE_ALLOW` | `APP_RUN_PRIVATE_ALLOW` |
| `OCTILLION_RUN_SAME_USER` | `APP_RUN_SAME_USER` |
| `OCTILLION_RUN_SANDBOX` | `APP_RUN_SANDBOX` |
| `OCTILLION_RUN_SETUP_CHECK_SECONDS` | `APP_RUN_SETUP_CHECK_SECONDS` |
| `OCTILLION_RUN_TEST_PREPARE_MS` | `APP_RUN_TEST_PREPARE_MS` |
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
| `OCTILLION_WORKER_INLINE_MAX_BYTES` | `APP_WORKER_INLINE_MAX_BYTES` |
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
  The list page (mold_v0-170) is the console's database table (`RecordView`): the area's `list_columns` typed by their
  fields (an enum filters by its options, a date or number sorts as one), search, a record count, sorting and filters,
  a row opening the record as a full card in the list's place (mold_v0-217) with **Open record** for its own page; empty, it says where the area's rows
  come from (for staff: its data repository, what to press on Data repositories, the admin MCP's sync tool;
  `web/src/features/records/empty.ts`). The breadcrumb names the area by its label, as the sidebar does. Each area has
  one icon (mold_v0-242, `src/record-icons.ts`), in both consoles' Records groups and its spec: its own `icon` (a tab
  icon), else its customer tab's, else one picked from its name so that no two Records entries share one and none
  repeats another staff sidebar entry's; two areas declaring one icon is a build warning (docs/RECORDS.md section 5). An area of
  platform scope may declare `samples` (at most 20 records, each data key a declared field): the lane world
  (`testing/console/world.mts`) writes them into its throwaway database so the pages are graded with rows; a deployed
  build never writes them. `npm run test:record-pages` checks the empty states, the staff guide and the samples rule.
  **The staff record pages are the standard list** (mold_v0-212; `web/src/features/records/staff-records.tsx`):
  `/admin/records/<area>` has no title or description above it; it reads as a customer's list tab does (mold_v0-208):
  the area's four cards (`GET /api/admin/records/_console/<area>/sparklines`, `src/sparklines.ts` `areaSparklines`: an
  area tab's defaults over the shared rows, counted as platform work since they name no workspace; staff read every
  card), the search row, the table, a row opening the record as a full card in its place. Where staff may write, **New record** is
  the primary action at the search row's right end (the tab action's create form, `CreateRecordForm`, as a full card) and an open record has **Edit** (its
  title and fields, data the form does not show kept); both write through `/api/admin/data`, whose checks are unchanged.
  `GET /api/admin/records/_console/<area>/form` says what the role is offered: create, edit and import for an area
  whose rows the shell stores (not read live) with no encrypted field, for a role with `library` (Operator and Owner),
  the staff tool not withheld; remove with `delete` (Owner); the repository that fills it. The record's
  own page (`/admin/records/<area>/<key>`) is one details card: key, where it comes from, every field by its label (references linked),
  version, updated, its clocks' timeline and its links, with Edit on the same terms. No pack declares anything for it.
  `npm run test:record-areas` checks the cards and the offer per role; `npm run test:record-pages` the layout.
  **Staff rows on every shared area (mold_v0-221).** An area a repository fills (an upstream catalog's regulators or
  control library) takes staff rows too: until then it was read only on the console, so staff had no way to add to it.
  The primary action reads **New <noun>** (the area's label in the singular: New report format, New regulator,
  New control) and opens the create card; **Import** beside it reads a CSV or JSON file in the browser, maps its
  columns to the key, title and fields (matched by name or label first), previews each row from the server (create,
  update, override, unchanged, or invalid with its problems; `POST /api/admin/records/_console/<area>/import`, dry run
  by default, `src/record-import.ts`) and imports the valid rows that change something as staff rows in one
  transaction, at most 1000 per file: idempotent by key (fields the file leaves out keep their values; the same file
  again writes nothing). Every row an import writes is an `IMPORT` line of the staff access log (`admin_access_log`,
  as every staff request and admin MCP call; `/admin/access-log`), and a staff entry of the platform trail when it is
  on; shared rows belong to no workspace, so no workspace's data trail holds them. A row's **provenance** is `staff`
  (written through a door: no `source`) or `repository`; the staff list and detail routes return it per row
  (`src/record-areas.ts` `platformProvenance`). A repository's rows stay read only: **Edit** on one reads
  **Override** and saves a staff row of the same key that wins over it, the repository's version kept behind it
  (`platform_records.upstream`, `sql/migrations/0040_platform_record_overrides.sql`) and refreshed by every index; the
  details card marks it **Overridden by staff** with what it stands over. **Remove** (Owner) deletes a staff row, or
  removes an override and puts the repository's version back; a door's delete of a repository's row is refused (409).
  A repository's index never overwrites, prunes or claims a staff row, forced or not (a forced index only passes the
  prune guard); a key staff added first becomes an override once the repository has it, and an override whose key the
  repository drops stays as a plain staff row. The platform roles (`src/admin-roles.ts`): Viewer reads; Support adds
  access requests, invitations and tips; Operator adds the library (these writes and imports among it); Owner adds
  deleting. `npm run test:data-repositories` (staff rows survive a sync, forced too; overrides win; removing restores),
  `npm run test:record-import` (the offer per role, cells typed, the preview's outcomes and problems, the import,
  idempotent, the access log), `npm run test:migrations` (0041 and its rollback).
  **Every customer list is that table (mold_v0-176).** An area tab's table view (`RecordTableView`, the same component
  as the list page: a merged tab's rows too, a row opening the record of the first of its areas), the `runs` and
  `reports` tabs (`web/src/features/tabs/runs.tsx`: kind in the pack's words, status, the asset record it ran over,
  started or finished, duration, results and cost; status and kind filter by their options; a row opens the run beside
  the list with its error and results and a link to that record), Schedules (a row opens the schedule, where owners
  change when it runs or remove one they added; the switch turns it on and off in its row), Notices (a row's menu
  dismisses it) and Credentials (a workspace credential per row, opening its details and its Set, Replace or Clear as a full card in the list's place; mold_v0-239) all draw
  `RecordView`, with the page's own empty state guiding the person (a tab's `empty`) and nothing linking to a staff page.
  Boards and timelines stay as they were. Pages a build's original look gives a look of their own (API keys, Usage,
  Activity, Connected apps, Files, Billing and a host pack's pages) are unchanged. The lane world also gives its
  workspace sample rows of its own (`testing/console/seed.mts`): every stored workspace area a few records made from its
  fields (an enum through its options, dates around today, a reference to a record the world has) and a few runs of the
  build's job kinds (finished, failed, running; over an asset record when the kind reads one; with results against the
  shared check samples), so the lists are graded with rows. Only the lane world writes them; `npm run
  test:record-pages` checks a run's row in words and that every customer list page is the table.
  **The record contract (mold_v0-222).** An area may declare `contract` (`src/pack-api.ts` `RecordContractSchema`):
  its provenance (`staff`, `people`, `repository`, `intake`, `run`), each of eight actions (read, create, update, move,
  delete, reveal, export, import) as the roles that may, `{staff: library|delete}` or `{none: reason}`, and its list's
  primary action (`create_record`, `start_run`, `link`, or `{none: reason}`). The build refuses what the area alone
  contradicts (`contractProblems`), and the factory's `spec check` derives every area's contract from the declaration
  and holds a declared one to it (the factory's `docs/RECORDS.md`). `npm run test:record-contract`. Since mold_v0-237 the primary action speaks for **every** list of the
  area (each tab whose own area it is, its Settings tab, its Records page), and an area may turn its own lists' action
  off with `"action": false` and `"action_reason"` (refused without the reason; a Settings area's contract then says
  `{none}`).
  **An area's own lists (mold_v0-237).** A Settings area tab and an area's Records page (`/app/records/<name>`) are the
  standard list (`web/src/features/records/record-pages.tsx` `AreaRecordList`): the area's four cards
  (`GET /api/records/_console/<area>/sparklines`, `src/sparklines.ts` `workspaceAreaSparklines`: the defaults an area
  tab over it would have, for the workspace), the search row with Export CSV and the area's primary action, then the
  table. The action is `src/metric-spec.ts` `areaListAction`: the area's `action: false` (none, said by
  `action_reason`), else the shell's default an area tab gets (Add <its singular>, a new record, for a workspace area of
  the shell's tables whose create tool a workspace is offered), else none for what the area is (shared, read from a
  repository, its create withheld). The build's registry carries it (`recordAreas[].action`, never a reason); the server
  says who may use it (`GET /api/tab-actions/_areas/<area>`, the create checks of a tab's); its form is the tab's full
  card (`?new=1`). gen-packs lists a Settings tab with none its area does not say as a warning. `npm run
  test:console-tabs`, `test:record-pages`, `test:record-files`.
  **Import, export and reveal from the contract; each row's writer (mold_v0-234, mold_v0-235, mold_v0-236).** The
  runtime reads three of the contract's actions, today's behaviour when an area declares none (`src/record-areas.ts`):
  `import` lets its roles (those that may also create and update) import a CSV or JSON file into the workspace's own
  records (`POST /api/data/<area>/_import`, a preview then one transaction, as the person; `src/record-import.ts`
  `importWorkspaceRecords`; the console's Import, its own button next to Export in a list's search row, its form a full
  card in the list's place, `?import=1`, with the preview and what it wrote: `web/src/features/records/workspace-import.tsx`);
  `export` is its own permission within read's (the list routes' `?audit=export`, `export_<area>`, Export CSV shown only
  to those roles); `reveal` is the area's, a field's `reveal_roles` narrowing it, `{none}` revealing nothing. Every
  workspace row records who or what wrote it (`sql/migrations/0042_workspace_record_provenance.sql`: `provenance` one of
  staff, people, repository, intake, run; `written_by`, `updated_by`), set by each door with `asWriter`; a record's
  detail carries it and `GET /api/admin/records/_provenance` counts each area's rows by provenance across workspaces,
  naming one its contract leaves out. `npm run test:record-contract-runtime`.
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
  **Provider-safe CLI settings and the refused-before-spend retry** (mold_v0-189, `src/provider-safe-env.ts`): a run
  with the Claude provider gets Claude Code's documented quiet settings (`DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`: no self-update, no telemetry and so no remotely served
  feature flags), and, when the gateway does not serve it from Anthropic's own API (a Vertex backend, only a Vertex key,
  any other upstream), `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: no beta request fields, so Vertex never sees
  `context_management` (its "400 context_management: Extra inputs are not permitted" ended the audit app's hosted run of
  2026-11-01 10:06 in 3 s on a sandbox whose own Claude Code was 2.1.220). In the gateway's variables for a program, and
  under an agent-workspace kind's declared `env` (the kind's own values win). An attempt that fails after the model API
  refused it (an upstream error in its own tokens' `gateway_usage`) with no token metered and nothing spent is queued
  **once** more whatever `max_attempts` says, with a `model_refused_retry` event (requests, refused); not a cancelled
  run, a timeout or a gated write.
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
  - `tools` (072): tools from a fixed catalogue (`src/run-tools.ts`: claude-code 2.1.316 (mold_v0-189), sops 3.13.3, age 1.3.2,
    kubectl 1.37.1, aws 2.37.5, cfn-lint 1.56.3, cfn-guard 3.2.1, aws-guard-rules 1.0.2, moto 5.2.4, each with its
    release artifact's sha256 for x64 and arm64, measured when pinned; git is the image's distribution package; the
    last four since mold_v0-184, below). `gen-packs` writes the union across the build's kinds
    (`src/run-tools.generated.json`, `check:packs` keeps it current; an unknown tool is refused at build); the Dockerfile
    installs exactly those (`scripts/install-run-tools.ts`: each artifact's sha256 checked before it is unpacked into
    `/opt/app-tools`, root's, with a manifest) and checks them last (`--verify`: an image that lacks a tool the build
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
    file of the pinned tree, never through a link, never under a write-back path, so never written back). **`pin`**
    (mold_v0-166; `{list, url, branch, commit, hosts, max_items}`, a json input only): the repositories the value lists
    at the JSON pointer `list` that give no `commit` are pinned to their branch's current commit, and those that name no
    `branch` get their default branch, before the file is written (`src/agent-workspace.ts` headCommit: `git ls-remote`
    by the runner, outside the run's proxy as the agent repository is, with fetchPinned's hygiene and no credential, so
    a private repository's item gives its commit); each url https on one of `hosts` exactly (each in the kind's egress,
    checked at build); the value is checked against the schema before (nothing is asked for a refused value) and after.
    The start tool types an argument written to an input file (`from: scope.<argument>`) by that input's schema
    (properties, required, patterns, choices; `src/mcp-catalog.ts` schemaInput), so a client sees the object it must give.
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
    per workspace (`<APP_RUN_CACHE_DIR or /var/cache/app-checkouts>/ws-<id>`, root's, traversable by the run's
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
- **CloudFormation checked with AWS's own tools, offline (mold_v0-184, built)**: four catalogue entries, two loopback
  ports and one conditional egress, so a pack's kind can lint, rule-check and run CloudFormation templates in its
  sandbox and, only with a workspace's read-only cloud key, reach that cloud's API.
  - **Python tools** (`format: "python"`: cfn-lint, moto[server]): the artifact is a pinned relocatable CPython
    (python-build-standalone 3.12.15, asset digests matched), `python.wheels` one wheel per package per architecture
    (`src/run-tools-wheels.ts`, chosen by `scripts/run-tools-resolve-wheels.py` from the hash-locked
    `scripts/run-tools-locks/<tool>.txt`, compiled with `uv pip compile --universal --generate-hashes --exclude-newer`;
    each wheel's sha256 one of its lock's). The installer downloads and checks the interpreter and every wheel before
    anything is unpacked, installs the wheels into that interpreter alone (`pip install --no-index --no-deps
    --only-binary=:all:` from those files: nothing fetched or built), removes pip's own scripts and writes a launcher
    per `python.entry_points` that runs the interpreter isolated (`-I`). The manifest's pin is one digest over the
    interpreter's and every wheel's sha256 (`pinDigest`); the interpreter is re-hashed at every run beside the launcher.
    cfn-lint's lock carries its `sarif` extra (`-f sarif` needs sarif-om).
  - **A data tool** (`format: "zip"` with `data`, `exclude`: aws-guard-rules, AWS's Guard rule sets per framework from
    the aws-guard-rules-registry release, measured at pin): no program; its directory's files are hashed into the
    manifest (`treeDigest`: every file's path and sha256, no link or special file) and checked file by file at every
    run (`verifyToolSet`), then linked at `RUN_TOOLS_DATA/<name>`. A bin path may name the release's architecture
    (`<arch>`: cfn-guard's static `cfn-guard-v3-x86_64-linux-latest/cfn-guard`).
  - **`agent.loopback_ports`** (at most 4, above 1023, never the egress proxy's): ports on 127.0.0.1 the run's own
    programs serve each other on (an emulator one starts and the AWS CLI calls). The claim carries them
    (`egress.loopback_ports`); the sandbox's strict rules (`orchestrator/core/egress.ts`) accept the run user's
    connections to them and the reply direction of its server's answers, nothing else on loopback (a client bound to
    such a port as its source opens nothing new); the runner refuses the run when anything already listens on one
    (`listeningOn`, /proc/net/tcp{,6}): a daemon of the sandbox's there would be reachable.
  - **`credential_egress`** (`[{credentials, hosts}]`, the kind's own workspace credentials): the hosts (with
    subdomains, as `egress`) join the run's allowlist at claim only when the run's own slot holds a stored value of one
    of those credentials (`src/credentials.ts` runHasCredential: nothing opened or minted; `src/egress-hosts.ts`
    credentialEgressHosts); the claim's event names them (`credential_hosts`). Another workspace's value opens nothing.
  - The boat set-up installs unzip for the rule sets too; a build with these tools grows its runner image by about
    1.2 GB (each Python tool its own interpreter) and a boat run sandbox downloads about 300 MB in its set-up.
  Proof: `npm run test:run-tools` (stand-ins: a Python tool's interpreter and wheels, a changed wheel refused, the
  interpreter re-hashed; a data tool changed, added to or linked refused; offline after install), `npm run
  test:run-firewall` (the declared port answers the run user's own client; a source-port trick and other loopback
  ports reach nothing), `npm run test:run-credentials` (credential_egress), and `npm run test:run-tools-real` (not
  in CI: the real artifacts downloaded and checked, then with no network at all cfn-lint and cfn-guard find the known
  issues of `scripts/fixtures/cfn/insecure.yaml`, moto creates it on 127.0.0.1 and the security group reads back open
  to 0.0.0.0/0). **Not covered:** LocalStack is not in the catalogue: it needs Docker (root's in a run sandbox: never
  the run user's) and, since 2026-03, an auth token with online activation; a pack runs moto in the sandbox and may
  use LocalStack only where its program has Docker of its own.
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
  installed in the sandbox when missing; the run's user is leased by the runner and given an account, `apprun-<uid>`).
  **A boat launch fits its call** (mold_v0-179): the launch only creates the sandbox, sends the code's tarball and the
  env file, and starts the set-up script (`runSetupScript`, `run-setup.sh`) as a detached unit; unpacking, `npm ci`,
  the run user, packages, the run tools and the runner's start happen in the sandbox afterwards, the script writing its
  step to `run-setup.status` and its errors to `run-setup.err`. Each tick asks a launched, unclaimed sandbox where its
  set-up stands (after `APP_RUN_SETUP_CHECK_SECONDS`, 20): a failed one is reaped at once as a failed start with its
  step (`setup <step>`) and the sandbox's own error, which the run then fails with after its tries; one still going is
  said on the run (`waiting`: "its sandbox is being set up (npm)"). On Vercel a launch starts only with
  90 s of its call left and each step only with time for it (`getDeadline`), so a launch ends, deleting its sandbox
  if it failed, inside its call, never frozen half done (a 300 s call once was, mid-upload). Boat requests that can be
  repeated (reads, file writes, deletes, renames, a create with its idempotency key) are tried again on a fresh
  connection when one drops (a keep-alive socket dead after a Vercel freeze: "fetch failed"), and a request that fails
  says which and why (`boat GET /sandboxes: fetch failed (UND_ERR_SOCKET: other side closed)`). The runner keeps its
  run's lease, and the workspace store's, from its claim on while it prepares the sandbox (the lockdown took longer
  than a 120 s lease), and records how long that took (`sandbox_prepared`). On Vercel the database pool closes idle
  connections after 5 s and is attached to the function (`attachDatabasePool`), so a frozen instance never reuses a
  dead one. `docker` (a server of its own: the compose project's
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
- **On-premises runners** (mold_v0-036, built; `src/onprem-runners.ts`, `src/onprem-runner-routes.ts`, the runner
  `src/onprem-runner.ts`, `sql/migrations/0027_on_premises_runners.sql`; customer and operator guide
  `codebase/docs/on-premises-runner.md`). A kind declares `private_network: true` when its runs may need a workspace's own
  private network (an audit's runtime probes of systems that are not on the internet). A workspace's owners add a runner
  on **Credentials** (a one-time enrollment token, sha256 stored, 24 hours) and install it inside their network with one
  command (the app's own image; `deploy/runner.Dockerfile`). It connects **out only**: it enrolls once (its own
  credential, sha256 stored, bound to that workspace) and long-polls `POST /api/runner/poll`, reporting its version, host,
  capacity, the kinds its image has and its private allow list, and is handed its workspace's runs routed on premises
  (only of kinds it has, within the kind's limits: `claimableRuns` scoped to the workspace), each as a `run_sandboxes`
  row (provider `onprem`) with a worker token bound to that run and that sandbox, exactly a hosted run sandbox's. It
  starts a container per run with the hosted docker provider's settings (`src/run-container.ts`, shared), whose runner
  claims, locks down and reports as a hosted one does, outbound too; the customer's private hosts and networks
  (`APP_RUNNER_ALLOW`, `orchestrator/core/egress.ts` `parsePrivateAllow`: names at their private addresses, IPv4
  networks by address through CONNECT, each on its ports; never loopback, link-local, multicast) are added to the
  proxy's allowlist only for a kind with `private_network`, and come from the runner's environment, never the app.
  **Routing:** the workspace's runner location (`workspace_runner_settings`: `hosted` by default, `on_premises` only
  with a runner online) is frozen into each run of such a kind when it is queued (`runs.runner_location`); switching
  moves its queued runs. The hosted scaler, the fleet claim and its demand never see a run routed on premises, and a
  sandbox claims only a run of its own place (`claimForSandbox`). **Health:** online when it polled within 90 s; the
  console shows status, last seen, runs and allow list; staff list every workspace's (`/api/admin/onboarding/runners`).
  **Revoking** (owner, or staff): credential and sandbox tokens stop at once, its runs' gateway tokens are revoked and the
  runs requeued (the sweep), and the runner removes its sandboxes and exits at its next poll; one silent for 15 minutes
  loses its sandboxes' tokens. **An app's toggle, off by default** (mold_v0-205): the app's profile turns them on with
  `"onprem_runners": true` (profile.json; the factory's `application.json` `profile.onprem_runners`, app-settable in
  [branding/rules.json](branding/rules.json), the app spec's `profile.onprem_runners`, the brief line `onprem_runners =
  true`). **Off** (absent or false, whatever its kinds declare): `/api/runners`, `/api/runner/*` and the staff
  `/api/admin/onboarding/runners` are not mounted (404, so enrolment is refused), Settings › Credentials has no runner
  section (nor the Credentials entry for it alone), the admin Compute page no On-premises runners tab, the customer guide
  no On-premises runner page and /admin/docs no runner guide, the data map no on-premises rows, and every run is hosted
  (a run queued on premises before goes back to the hosted scaler). There are no runner MCP tools, so the MCP surfaces
  are the same either way. **On**: exactly the behaviour above. Also off in a build with no such kind (nothing mounted,
  every run hosted, zero-pack unchanged) and with `APP_ONPREM_RUNNERS=off` (every run hosted again).
  `npm run test:onprem-runners` (both: the toggle off with private-network kinds, then on).
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
- **Usage page in neutral words** (mold_v0-008, built; `src/usage-report.ts`, `src/usage-routes.ts`): each MCP call
  records its workspace, member or key id, client name and version (from its User-Agent), tool, outcome, error class,
  latency and request and answer sizes (`mcp_events`; never arguments or answers; recording is fire-and-forget and never
  fails the call). `GET /api/usage` (the workspace's members) gives calls per tool with errors and p50/p95, errors by
  class, clients, daily and weekly active people, week-over-week retention, per member calls, runs and run cost, and per
  run its tool calls (events of type `tool_call` or `tool.<name>`), model requests, tokens and cost. The console's
  `/app/activity` shows them in the build's words (a pack's `words` for workspace, member, run, tool call, key), in the
  sidebar once the build has a pack; the existing Usage, Billing and Spend pages show runs only when there are any.
  The staff's every-workspace Activity page (`/admin/activity`, `GET /api/admin/onboarding/usage`) was removed in
  mold_v0-211: staff read use across accounts on Analytics and spend on FinOps; `/admin/activity` is the console's 404.
  Spend per person is for billing roles (owners, billing managers); everyone else sees the workspace's figures and
  their own.
  `npm run test:usage`.
- **The vocabulary** (mold_v0-100, built; `src/words.ts`, `src/vocabulary.ts`, `web/src/lib/vocabulary.ts`): the shell's
  text never spells a concept of any product. It writes a placeholder the build's words fill: `{run}` `{runs}` `{Run}`
  `{Runs}`, `{workspace}`, `{account}`, `{member}`, `{owner}`, `{tool_call}`, `{key}` (each with its plural and
  capitalised forms) and `{product}` (profile.json `name`); "a {run}" takes the article of its word ("an audit"). The
  words, last wins: the neutral BASE (the default profile's: run, workspace, account, member, owner, tool call, key),
  the packs' pack.json `words` (the first pack that names one), a host pack's `host.profile.words` (its own engine's
  work: the first product's host pack says `"run": "simulation"`, which keeps every one of its sentences as it was),
  and the app's own profile.json `words` (`{"run": "audit", "runs": "audits"}`; gen-packs refuses an unknown key or a
  word with markup). The server fills with `fill()`/`word()`, the console with its own `fill()`/`W` over
  `web/src/config/vocabulary.generated.ts` and a gen-packs copy of the same engine (`web/src/lib/words.generated.ts`).
  The usage pages count the generic runs, so they take the packs' and the app's words, never a host pack's. Billing,
  Budget rules, the launch refusals (over MCP and the console), the policy checks and the account and platform roles'
  help are written this way; contact lines name `{product}`. A placeholder with its article inside the braces
  ("{an account}") is never filled, so the page would show it as written: `npm run check:vocabulary` refuses one in the
  shell's code (mold_v0-171; the article goes before it, "an {account}"). `npm run check:vocabulary` also runs the concept-word
  ratchet (`scripts/lib/concepts.ts`): the first product's concepts (`scripts/vocabulary.json` `concepts.words`:
  simulation, scenario, visibility, pick rate ...) may not stand as prose in base text; identifiers, SQL and stored
  values are contracts and are not counted; since mold_v0-113 the staff docs (`docs/*.md`, which `/admin/docs` and the
  docs answers serve) are read too, every line outside a fenced block, and say the engine's units in neutral words.
  Since mold_v0-141 no file carries one (`concepts.ceilings` is empty; a ceiling is only for a stored identifier that
  cannot be written otherwise, with its migration). Where a product's own concept would stand and no word says it, the
  shell writes a **shell text** (`src/shell-texts.ts`, no imports): an id, where it is shown, and the shell's neutral
  text, which any pack's pack.json `texts` replaces in its product's words (the first pack wins; gen-packs refuses an
  unknown id, a text two packs write and a placeholder that is not the build's). Server texts reach the server in
  `src/hosts.generated.ts` `PACK_CONFIG` (`src/texts.ts` `shellText`), console texts the console in
  `build-facts.generated.ts` `TEXTS` (`web/src/lib/texts.ts` `text`, over gen-packs' copy of the list,
  `web/src/lib/shell-texts.generated.ts`). Today: the viewer refusals (`refusal.viewer_launch`, `refusal.viewer_edit`),
  the Support role's help, Billing's no-plan notice, New plan's example description, the research brief's comparison label, the tip dock's
  sequence field, a host pack's journeys' nouns on Setup and the session engine's score on /app/usage. A host pack's
  tables are named on the Storage page by its `host.schema.labels` (else the table's name, capitalised). The session
  engine's plan metric, compute knob and settings help say `{run}`. `npm run test:words`.
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
  as Example Compliance: `due_dates`), or they are logged as skipped. The factory writes the sender and the groups for an app
  whose host pack does not (mold_v0-101, `branding/rules.json` `profile.email_defaults`: `<app_id>@<notify_domain>`,
  `access_requests`, and `due_dates` when a pack declares due dates). No product word is in the text (mold_v0-101,
  `emailWords`): it writes placeholders (`{product}`, `{run}`, `{runs}`, `{account}`, `{owner}`, "a {product}") that the
  build's vocabulary fills (mold_v0-100, `src/vocabulary.ts`), never inside a value someone typed. The welcome email's
  pitch is the profile's `email.pitch` (a host pack's profile may set it), else the landing block's hero subheadline
  (gen-packs writes it to `src/email-pitch.generated.ts`), else the short description. The first
  product's emails are what they were when its host pack's profile gives `words.run` (simulation), `email.pitch` and
  `email.library_nouns` (what a library item of each kind is called; absent, the kind as it is). With no transport that
  can send, `/admin/emails` says so in one sentence. Every message is a row in `email_log` with a hash
  and the domain of its one address, never the address, a code or a key; subjects, senders and recipients lose line
  breaks; every link is on the console's address from the environment (`src/console-url.ts`: `APP_CONSOLE_URL`,
  else `PUBLIC_URL`; anything but a plain http(s) address is ignored).
- **The company's own email** (mold_v0-192, built; `src/company-email.ts`, `src/email-intake.ts`, `src/mail-protocols.ts`,
  `src/email-routes.ts`, `src/company-email-config.ts`, `sql/migrations/0034_company_email.sql`; `npm run test:company-email`).
  A pack turns it on with pack.json `email` (or `definePack({ email })`): `sender: { allow: true }` and/or `intake: { area,
  label, folder ("INBOX"), fields: { subject, from, from_name, from_domain, to, cc, date, received_at, body, attachments,
  attachment_count, mailbox, message_id → the area's fields }, set: { field: constant }, body_chars, backfill_days,
  attachments: { max_bytes, max_count } }`; the area is one of the pack's own workspace areas not fed by a repository
  (checked by definePack and the build). A workspace's owners ("manage") configure it on the console's **Settings ›
  Email** tab (`/app/settings?tab=email`, `/api/email`; mold_v0-218: the Settings entry directly below Overview):
  **Sending**: one sender per workspace, SMTP (STARTTLS or SSL/TLS, AUTH PLAIN), Microsoft 365 (Graph `sendMail`, app-only
  client credentials) or Google Workspace (Gmail `messages.send`, a service-account key with domain-wide delegation,
  the JWT signed here). The email adapter's messages about one workspace (due dates, usage alerts, invitations to it, a
  library item's outcome: `Email.org`) go out through it while it is on; otherwise, or switched off, through the app's
  default sender as before. A failure is not handed to the default sender; the operator's email log says only that the
  workspace's sender failed and its kind. Sign-in codes and the operator's own alerts never use it. **Mailboxes**: IMAP,
  Graph or Gmail, up to 10 per workspace, each read by the intake job (its own module and loop, `startEmailIntake`,
  `APP_EMAIL_INTAKE=off`; on Vercel the cron entry polls) every `poll_minutes` (default 5), each inbox claimed with
  `FOR UPDATE SKIP LOCKED`, at most `APP_EMAIL_INTAKE_MAX_MESSAGES` (25) per poll. Only the pack's folder or label is
  opened, read only (IMAP `EXAMINE` and `BODY.PEEK[]`; Graph and Gmail with read scopes; nothing deleted, moved, flagged or
  marked read), from the inbox's read position (UIDVALIDITY and last UID, a Graph delta link, a Gmail history id; the
  first poll looks back `backfill_days`). Each new message becomes one record (key `mail-<24 hex>`, title the subject,
  fields as mapped), **once per Message-ID** in the workspace's area (the ledger `workspace_email_messages`; the
  provider's own id when a message has none), whichever mailbox brought it and however often a read position restarts.
  Attachments are sealed with the workspace's data key in the object store under `workspaces/org-<id>/.mail/` (bound to
  their workspace, message and place); one past `max_count` or larger than `max_bytes` is listed with why and not kept; a
  message over 25 MB keeps its header fields. A failing mailbox shows its error by kind (auth_failed, permission_missing,
  tls_error, unreachable, not_found, refused, protocol) with what to change, and backs off 1, 2, 4 … minutes (at most an
  hour, never sooner than its interval). **Credentials** are write-only: set or replaced, never returned in any part (the
  page shows "set", when and by whom, and Replace), sealed with the workspace's data key (AES-256-GCM, the key wrapped by
  the vault key), bound to the workspace and the row's slot; each sender and mailbox has a **Test** button (sign in; the
  sender optionally sends a test email, in the email adapter's words; a mailbox opens its folder read-only and counts it; the workspace's transports, `src/mail-protocols.ts`, are reached only through the adapter's `send()` and these buttons, so `src/email.ts` stays the one place a message is written). The three tables have no
  grant for tenant work, and there is no admin route, admin MCP tool, operator script or log line that shows a workspace's
  mail settings, credentials or mail: the platform operator never sees them. Hosts: an SMTP or IMAP host must resolve to a
  public address unless the operator lists it in `APP_EMAIL_ALLOWED_PRIVATE_HOSTS`; no TLS only with
  `APP_EMAIL_ALLOW_INSECURE=1` outside production; the providers' stand-in addresses (`APP_EMAIL_GRAPH_URL`,
  `APP_EMAIL_MS_LOGIN_URL`, `APP_EMAIL_GMAIL_URL`, `APP_EMAIL_GOOGLE_TOKEN_URL`) are honoured only outside production and
  only on 127.0.0.1. **MCP**: `list_intake_items` (read only, under the intake area's own read roles) when a pack
  declares an intake; none with zero packs (the zero-pack surface is unchanged). People who may read the area download
  an attachment at `/api/email/attachments/<area>/<key>/<n>` (always a download). DATA-MAP.md gets a section when a pack
  declares `email`. **Not covered:** a certificate (instead of a client secret) for Graph; delegated (refresh-token)
  sign-in; marking ingested messages read or labelled; rules on sender or subject. Since mold_v0-220 the intake may
  keep a message's body and attachments as files on its record (`fields.body_file`, `fields.attachment_files`: "Record
  files and document previews" below), previewed and downloaded on the record's own card.
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
  `objectStore()`: the bucket the environment's `R2_*` names, else the one in Key vault › Object storage (mold_v0-181,
  `docs/storage.md`; a platform owner adds and tests it on `/admin/keys`), else `APP_STORAGE_DIR` on one machine and in
  tests) under
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
  owners set the values in the console (Settings › Credentials, `/app/settings?tab=credentials`, `src/credential-routes.ts` at `/api/credentials`, mounted
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
  - **Each credential in its own place, in the customer's words** (mold_v0-239; `web/src/features/credentials/`:
    `model.ts`, `credentials-tab.tsx`, `record-credentials.tsx`, `credential-card.tsx`). Settings › Credentials lists only
    the workspace's own credentials (`GET /api/credentials?scope=workspace`), as the standard list (its four cards, the
    search row, the table; no caption). A credential of a record (`bound_to: asset`) and one of a record's environment
    (`bound_to: environment`) are on that record's own page, `/app/records/<area>/<key>`: a Credentials card below its
    details (`GET /api/credentials?area=<area>&key=<key>`: that record's values only, 404 for a record that is not the
    workspace's), the record's own first, then one group per environment the record has (Production, Staging: the
    usual names in words). The environments are the field's fixed `environments`, or the record's own through
    `environments_from: {field, key}` (a field of the area holding names, or objects whose `key` holds one: an app's
    per-environment documents and their id field); a value is accepted only for one of them, and the console offers them in a
    select, never a text box. Fields that share a `group` (an access key id and its secret) are one credential: one
    row, one card with an input each, set (`PUT {pack, group, asset?, environment?, values: {<field>: <value>}}`, all
    of them, in one transaction) and cleared (`DELETE {pack, group, ...}`) together; the group's first field names it
    (`group_label`). Every credential says what it is for (`purpose`, else its help), how to get it (`steps`: numbered,
    the first naming the web address to open, addresses as links), what still works without it (`without`, an
    optional one; else built from `adds`), its status (Set, Missing, Optional; a pair half set says so), when it was set
    and by whom, and when it was last used (`workspace_credentials.last_used_at`, `sql/migrations/0043_credential_last_used.sql`:
    stamped when a run receives the value or the shell uses a workspace value, never when it is only read to redact what
    a run wrote; cleared on replace). Set, Replace and Clear open a full card in the page's (or the list's) place, never
    a dialog or a side sheet, kept in the address (`?credential=<id>&do=set|clear&environment=<name>`); a value is typed
    into a hidden field (a file's text too, or chosen from the computer), sent once and never shown again (owners see its
    last 4 characters). The binding, the delivery, a variable's or a pack's name and an area's id are never shown. A
    get-started step for a record's credential points to the area's records. `npm run test:credentials` (section 9)
    proves the places with the API and the console's model; `npm run test:record-pages` (12) the pages.
  - **A row per record on Settings › Credentials** (mold_v0-241). Below the workspace's own rows, one row per record of
    each area whose records have credentials (an application): its title; "Credentials for this <record> and its
    environments"; its status in plain words ("All set", "N missing": N required and not set, "Optional only"); when one
    of its credentials last changed, was last used, and who set it. One request per area, never per record
    (`GET /api/credentials?records=<area>`, `src/credentials.ts` areaCredentials: every record of the workspace the
    person may read, its environments and its values' slots, no last 4 characters; 403 for an area they may not read,
    and `?scope=workspace` names only the areas they may read in `record_areas`; the record page's own answer checks the
    same read permission). The four cards count credentials, not rows: the workspace's, and each record's one by one
    (each environment's apart). Opening the row opens the record's page at its Credentials card
    (`/app/records/<area>/<key>#credentials`); the card is never drawn on Settings. Search finds a record by its name. `npm run test:credentials`
    (section 10) proves the counts, the read permission and the link.
- **Repository access by a GitHub App per workspace** (mold_v0-014, built; `src/github-app.ts`,
  `src/github-app-routes.ts`, `sql/migrations/0021_github_app.sql`; `npm run test:github-app`). A credential field may
  say `github_app: true` (pack.json `credentials[].github_app`): a GitHub repository token. When the platform holds a
  GitHub App and the workspace has connected an installation of it, a run receiving that field gets a short-lived
  **installation token** in its place; with no app set up, or no live installation, the pasted value is delivered as
  before. Nothing is mounted unless a field asks for it (the zero-pack MCP surface and routes are unchanged).
  - **The app** is the platform's: its id, URL name, client id and secret, private key and webhook secret are one sealed
    entry of the key vault (provider `github_app`, label `app`, direct mode with no environment names), set by an owner
    of the platform on `/admin/keys` (section GitHub App, which also shows the addresses to register with GitHub and
    the key's SHA256 fingerprint; never a secret). Only the server reads them: the app's JSON Web Token (RS256, nine
    minutes) goes to GitHub's `/app/` endpoints only, and no run, session, answer, log or error carries the key or a
    secret.
  - **Install** (Settings › Credentials, the GitHub row's card, owners): `POST /api/github-app/install` gives GitHub's install
    address with a state signed by the client secret around a one-time nonce (its sha256 stored in `github_app_states`
    for that workspace and person, ten minutes). GitHub returns the browser to `GET /api/github-app/callback` with the
    installation id and a user-authorization code (the app must "Request user authorization (OAuth) during
    installation"); the installation is bound only when the signature and expiry hold, the signed-in session is the same
    person in the same workspace and an owner, the nonce is unused (then used), the code's user token lists the
    installation in `/user/installations` (proof the person reaches it; that token is revoked at once and never
    stored), the installation is of this app, and no other workspace holds it (one live installation per workspace,
    one workspace per installation). Every refusal is a code on the redirect back, never an echo of the request.
  - **Runs**: per run and field, a token scoped to read-only contents (`{contents: read}`; GitHub adds read metadata) and
    to the installation's repositories, or to the ones an owner narrowed the run's asset record to
    (`PUT /api/github-app/repositories`). GitHub's answer is checked: a token with more permission, or more
    repositories, than asked is revoked and not delivered (the run gets none, never a broader pasted one). Tokens are
    sealed with the workspace's data key in `run_github_app_tokens`, reused while more than five minutes are left,
    minted again after, and all of a run's tokens are redacted from what it writes. The run's `credentials` event
    names which fields were installation tokens, their repositories and expiry, or why none was given.
  - **Revocation**: when a run's attempt ends its tokens are marked revoked with its gateway tokens
    (`revokeRunTokens`) and GitHub is asked to revoke each (`DELETE /installation/token`). The app's webhook
    (`POST /api/github-app/webhook`, `X-Hub-Signature-256` checked against the webhook secret before anything is read)
    ends a connection at once on `installation.deleted`, stops minting while suspended, and keeps the repository list
    (and every asset's narrowing) current on `installation_repositories`. Owners disconnect (`DELETE /api/github-app`),
    staff revoke (`DELETE /api/admin/onboarding/github-app/installations/:org`), and removing a workspace
    (`src/tenancy.ts`) does the same: the row ends, its tokens are revoked and the installation is uninstalled on GitHub.
  - **Isolation**: the three tables have no grant for tenant work (`check:rls`, the live probe). `test:github-app`
    proves it against a GitHub stand-in (`scripts/lib/github-standin.ts`): the install's refusals (another workspace's
    session, another person, a used, tampered or expired state, an installation the person cannot reach, another
    app's, one held by another workspace), the token's scope, reuse, re-mint near expiry and expiry, over-grants
    refused, revocation at run end, the webhook, disconnect, staff revoke and workspace removal, 0 cross-workspace
    injections, and no private key, client or webhook secret in any run's environment or files, answer, log or table.
  - **Runs longer than an hour**: GitHub caps an installation token at one hour; the run harness renews it mid-run
    ("Short-lived credentials in long runs" below). The install's state is the shared one (`src/oauth-state.ts`,
    table `oauth_states` since migration 0023).
  - **Not covered**: an installation with more than 500 repositories needs each asset narrowed. GitHub Enterprise
    Server addresses are not configurable yet. The webhook's deliveries are not de-duplicated (each handler is
    idempotent).
- **Credentials connected through OAuth** (mold_v0-014, built; `src/oauth-connections.ts`, `src/oauth-routes.ts`,
  `src/oauth-state.ts`, `sql/migrations/0023_oauth_connections.sql`; `npm run test:oauth-providers`). A pack declares
  OAuth 2.0 providers (pack.json `oauth_providers`, definePack `oauthProviders`: `name`, `label`, `authorize_url`,
  `token_url`, optional `revoke_url` (RFC 7009), `scopes` and `scope_separator`, `client_id` and `client_secret` as
  `{vault: "<label>"}`, `pkce` (S256, on by default), `token_auth` (`body` or `basic`) and fixed `authorize_params`; https
  only, and never the flow's own parameters) and a credential field names one (`oauth: "<provider>"`; not with
  `github_app`). Nothing is mounted unless a field does. The GitHub App is the other kind of connection (above); a field
  with neither is pasted, as before.
  - **The client** is the platform's: its id and secret are key-vault entries of provider `oauth_clients` under the labels
    the provider names, set by an owner of the platform with Add a key on `/admin/keys`; the page's OAuth providers
    section shows which are set and the redirect address to register (`<console>/api/credential-connections/callback`), never a value.
  - **Connect** (Settings › Credentials, the field's card, owners, per slot of the field: the workspace, an asset record of theirs, an asset's
    environment): `POST /api/credential-connections/connect` gives the provider's sign-in address with the shared signed one-time state
    (bound to the person and the workspace, ten minutes, used once; the slot and the sealed PKCE verifier kept
    server-side). `GET /api/credential-connections/callback` refuses another workspace's session, another person, a changed, used or
    expired state, a sign-in the person cancelled and a code the provider refuses; otherwise it exchanges the code (with
    the verifier and the redirect address) and stores the tokens in `workspace_oauth_connections`, sealed with the
    workspace's data key and bound by additional data to their slot and provider. Every outcome is a code on the redirect
    back to the page, never an echo.
  - **Tokens**: a run receiving the field gets the slot's access token, delivered like any credential (a variable or a
    file), recorded sealed in `run_oauth_tokens` so everything the run writes is redacted of it. With less than ten
    minutes left (`src/clock.ts` `REFRESH_MARGIN_MS`) it is refreshed first, the row locked (concurrent askers: one
    refresh; a rotating refresh token is used once). A provider that refuses the refresh (`invalid_grant`: revoked,
    expired) marks the connection `needs_reconnect`: nothing is sent, not even a pasted value, until an owner connects
    again. A slot with no connection gets its pasted value. The server's own reads with a workspace-bound field (an
    `http_api` repository's header) use the same token.
  - **Disconnect**: an owner (`DELETE /api/credential-connections`), staff (`DELETE /api/admin/onboarding/oauth/connections/:id`) or the
    workspace's removal deletes the connection (nothing is sent from then on) and tells the provider's revoke address.
  - **Not covered**: providers that do not return JSON or form-encoded token answers; a provider's ID token is not read
    (no account name is shown); one connection per slot (no per-person connections).
- **Short-lived credentials in long runs** (mold_v0-014, built; `src/run-harness.ts`, `src/clock.ts`). The engine gives a
  GitHub App's or an OAuth connection's token with its `expires_at` (in the run's `credentials`), and hands out a fresh
  one once it has less than ten minutes left. While a run goes, the harness checks every minute (`credentialRefreshMs`)
  and before each step and the command: once a token is within that margin it asks for the run's credentials again and
  rewrites every credential file the running program holds, and git's token files (`git_credentials`, read by the helper
  at each request), in place (a new file renamed over the old, the run user's, 0400); a credential no longer given (a
  connection removed, an installation uninstalled) has its files emptied. The next step gets the fresh values as it
  starts, and everything the run writes is redacted of the old and the new (`credentials_refreshed` events name what
  changed, never a value). A variable is fixed when a program starts: a program that runs longer than its token's hour
  must take such a credential as a file (`deliver_as: {file, path_env}`) or through `git_credentials`.
  `test:oauth-providers` runs a 4.5-hour run on a simulated clock (the stand-ins' tokens live one hour) reading an OAuth
  token file and a GitHub App token file every few simulated minutes: every read works and the files held six tokens
  each; the same run without the refresh fails after the first hour.
- **A run user per run** (mold_v0-078, built; `src/run-users.ts`, used by `src/run-harness.ts` and
  `src/run-sandbox-runner.ts`): every run's programs run as a uid of their own, leased for that run alone from a reserved
  range (`APP_RUN_UIDS`, default `61000-64999`: never root, nobody or 65535; a uid `/etc/passwd` names is skipped)
  and given back when it ends; the gid is the uid, with no supplementary groups. Before, every run of a host shared one
  uid (`APP_RUN_UID`, no longer read) and the end-of-run sweep (every process of that user killed, its files in
  the shared temporary directories removed) was host-wide: a concurrent run on the same host lost its steps (exit 128).
  Leases are files in a root-only directory (`APP_RUN_UID_DIR`, default `/run/app-run-uids`) naming the holding
  process (pid and start time, so a reused pid is not mistaken for it) and its run, taken and given back under a
  host-wide lock (flock on a file of that directory, held by a child process: the kernel frees it when its holder dies,
  and no run's user can reach it), round robin (a released uid comes
  back only after every other free one). A lease whose runner died is taken over only after every process of that uid
  is killed and its files swept; a uid with processes this runner never leased is skipped and left alone; a uid whose
  processes will not die stays out of use ("quarantined") while its holder lives. A fixed `runAs` (tests, older setups)
  is leased the same way: a second run asking for it at once is refused (infrastructure, retried), never run beside the
  first. In a run sandbox (boat, docker: one run per sandbox) the runner leases the uid inside the sandbox, gives it an
  account (`apprun-<uid>`), and the lockdown firewall matches it by number (`setupScript` `uid`); the unix sockets of
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
- **Optional credentials** (mold_v0-186, built): a workspace's credential field and an operator credential may say
  `optional: true` (default false) and, in one line, what a value `adds` (only beside `optional`; the help's first
  sentence after a leading "Optional." is used when absent: `src/vault-providers.ts` `optionalAdds`). A run never waits
  for a credential (`src/runs.ts` records which were delivered and which were missing); `optional` says the runs are
  meant to go ahead without it and do less. The company's Settings › Credentials and the admin Key vault (which lists every
  declared run credential, set or not, and offers them in Add a key) tag them Optional; `operator:vault-status` lists
  them apart from what the runs need (below).
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
  console shows **one checklist** (mold_v0-146, `web/src/features/portal/setup-steps.ts`): the shell's setup steps
  (joining, connecting an AI client, its tools, a first question) first, then the packs' steps in declared order, as one
  list with one count (mold_v0-171: a host pack's setup step declared `optional` is shown and counted on neither side,
  as the server's own `done` and `total`: "3 of 7" for eight steps with one optional, `stepProgress`). A pack step whose condition the shell measures too (`workspace`, `connected`, `first_call`;
  `/api/onboarding` says which as `covers`: `joined`, `connected`, `first_call`) takes that shell step's place, and the
  shell's later steps follow it: a pack puts the connection where it wants it by declaring a `done_when: connected`
  step. With zero packs (`packOnboardingSteps` 0 in `pack-nav.generated.ts`) it asks nothing and the list is the
  shell's. `npm run test:onboarding` proves
  it with two workspaces (everything B does ticks none of A's steps). The same steps reach AI clients (mold_v0-105): a
  pack with steps gets a generated `<prefix>_get_started` MCP tool (below) and a step may carry `prompt`, the words a
  person types to do it (plain text, one line), and `how` (mold_v0-166: `tool:`, `credential:`, `record:` or `run:`,
  checked as `done_when` is), the action get_started points to when it is not what `done_when` measures (an area whose
  rows a run writes as files of the workspace is done by that run, not by adding a record). **Not covered:** the end-to-end browser walk of
  the old ticket's acceptance (a new person from the landing page to a first call): there is no browser harness in the
  shell yet. The product's own setup steps and tool groups are its host pack's Setup route (mold_v0-039, below); the
  shell's own Setup page asks for joining, a connection, the tools and a first call, in the profile's words.
  The same steps are the admin console's account stages after the shell's own five (account created to first tool
  call; mold_v0-103): `src/admin.ts` `accountStages`, each account's step times read across workspaces in one grouped
  query per condition (`src/onboarding.ts` `stageStepsReached`, steps other than `workspace`, `connected` and
  `first_call`), and an account two days at a stage with the next step not done (nothing of its running) is named under
  Needs attention with that step. With zero packs the funnel ends at the first tool call and asks nothing more. A build
  with the session engine (a host pack's tables) keeps that engine's stages and messages word for word instead.
- **Admin sections per build** (mold_v0-104, built): the account pages, Analytics, Health and the plan editor show the
  session engine's products, research, simulations, jobs and metered units only when the build has its tables
  (`web/src/features/admin/engine.ts`, the console's copy of `src/host-tables.ts`, from `build-facts.generated.ts`:
  the host pack's tables and the packs' job kinds with their labels). Without it they show the packs' runs per job kind,
  by the kind's label and in the build's word for a run: an account's runs and latest runs (`orgDetail` `runs`), the
  weekly chart (Analytics), and FinOps' runs tab, named with the build's run noun ("Audits"), runs per kind with
  their cost over FinOps' period (`GET /spend/runs`, `src/compute-jobs.ts` `runKinds`; mold_v0-126 moved it there
  from Health, whose old `?section=runs` link redirects to it in a build with the session engine; without it Health has a Runs tab of its own again, mold_v0-204); an account's month spend is its runs'. The runs tab
  takes the place of FinOps' pricing Experiments tab, which shows only when the app has a pricing experiment (a live
  plan in one, or an account ever shown a variant: `src/experiments.ts` `anyPricingExperiment`,
  `GET /spend/experiments/any`), after the runs tab, or when a link opens it. `npm run test:admin-sections` proves zero packs and a declarative fixture pack in a shell
  build, and, run in a host pack's build, that the engine's stages, messages, account page and funnel are unchanged.
- **Admin pages of an engine the build has not got** (mold_v0-169, built): the platform admin shows an engine's pages,
  tabs, settings and keys only in a build that has it, from the build itself (the host pack's tables, the packs' job
  kinds, credentials and OAuth providers, the run sandbox setting), never from an app's name. Without the session
  engine: Compute lists Limits (the packs' run sandboxes: how many at once, queued, where they run; the boat plan only
  when the runs may use boat), Environment (the run sandboxes' settings instead of the orchestrators'; boat's rows and
  "Test connection" only when boat is used) and Emails (and On-premises runners where a kind may need them), not
  Orchestrators, Failures or Autoscaler decisions; its summary (`GET /compute/summary`, the admin MCP's) says the
  autoscaler's kill switch in runs, never asks for a boat key the build does not use, and carries `engine: false`,
  `uses_boat` and `runs` (absent with the engine, so its answer is unchanged). Agent configuration and `list_settings`
  (`src/settings.ts` `settingsInBuild`, a shell setting's `readBy`) leave out the engine's settings (orchestrator model,
  sessions per run, capacity, sandbox size), list the Vertex AI region only with the engine or a Vertex key in the vault,
  and name the Cloudflare model for what it does without the engine (the docs answers' first model); every setting
  may still be set (`update_setting`). Key vault and `key_vault_status` (`src/platform-keys.ts` `providerInBuild`) list
  the shell's providers (Resend, and the docs answers' Cloudflare, Anthropic, Vertex AI and OpenAI), a gateway
  provider a pack's job kind names, "Staff-held run credentials" (`pack_credentials`) and "OAuth app clients" only when
  a pack declares operator credentials or OAuth providers, boat with the engine or when the packs' runs may get their
  sandbox there (`src/run-sandboxes.ts` `boatForRuns`: job kinds and `APP_RUN_SANDBOX` auto, the default and on Vercel
  the only hosted sandbox, or boat; not when the deployment names docker or off), the engine's (coding agents, research
  search, Gemini, DashScope) with the engine, "Object storage (R2 / S3)" (mold_v0-181: the bucket's four settings,
  when the environment has no `R2_*`; with the engine or a pack whose runs keep a workspace store), and any provider
  that holds a key. Compute's boat rows follow the same
  rule (`uses_boat`, also true in auto with a boat key). Data repositories names each repository by its pack's `label` (pack.json `repositories.<id>.label`), else
  its id in words, and its pack by name, and says catalogs that do not index on their own in words for staff. Agent
  configuration's help wraps, so its Value, From and Variable columns stay on the page at 1440 px. `npm run
  test:admin-engine` proves a shell build and, run in a host pack's build, that every setting, provider and Compute
  figure is as before.
- **Health's tabs in every app** (mold_v0-204, built): the staff console's Health (`/admin/health`) is a page of in-page
  tabs (`UrlTabs`, `?section=`; no title above the strip). A build with the session engine keeps exactly its three
  (Errors, Jobs, Sessions; its old `?section=runs` link still goes to FinOps), so an engine app's Health is unchanged
  pixel for pixel. Without it (`web/src/features/admin/health-tabs.tsx`, `src/health-tabs.ts`, read-only staff routes
  under `/api/admin/onboarding/health/`): **Errors** as before; **Runs** (in the build's word): four cards (runs, failure
  rate, cost, median duration; the refused-and-retried runs of mold_v0-189 and the top error kinds said under them) and
  one table, the failed runs (kind, agent or job, error kind with `output_missing`, the error cleaned, account, duration,
  cost; views for agent, job, output missing and refused-and-retried) or, by the toolbar's picker, the kinds (runs,
  failures per error kind, median and p95, cost); a failed run's peek lists its events (type, attempt, time and the
  shell's own figures and words, never who asked or a value); **Scheduled work**: every job the shell runs that this
  build has turned on (schedules and due dates, record clocks, email intake, the event outbox relay, webhook deliveries,
  ledger checkpoints, encrypted-field batches, audit and workspace retention, run charges), each with its state (on time,
  late, failing, not run yet), cadence, last run, last success, lag and last error, kept by `src/scheduler-jobs.ts`
  `tracked` in `scheduler_jobs` (`sql/migrations/0037_scheduler_jobs.sql`, platform bookkeeping closed to tenant work)
  by whichever process ran it, a server's loops or the Vercel cron entry (a success at most every 30 s per job and
  process, every failure; rollback: `sql/rollback/0037_scheduler_jobs.sql`, which drops it with its rows); **Email Delivery** (`?section=deliveries`; named Deliveries until mold_v0-210), only when a pack declares company email or the app has a developer surface, emails only
  (mold_v0-215): four cards (sent, failed with the failure rate, not sent: skipped before sending, and the kinds) and
  the emails by kind and status (never an address, a domain or a subject); **Webhook Delivery** (`?section=webhooks`,
  `GET /api/admin/onboarding/health/webhooks`, mold_v0-215), only when the app has a developer surface (kind
  embedded: its declared events go out as webhooks): four cards (delivered, failed, pending or retrying, endpoints
  switched off) and, by its Show picker, the webhook deliveries by event and status or the endpoints switched off
  (account, reason, failures in a row; never their address). Tab order: Errors, Runs, Scheduled work, Email Delivery,
  Webhook Delivery, Status (each only when it applies); **Status**: the live checks as
  `/healthz` says them (database, the row-level security probe, at most hourly, object storage, the key vault and
  the Claude provider from `vaultStatus` read in a rolled-back read-only transaction: set or missing, never a value),
  the key vault's providers, and the last deploy (the last migration applied, the commit on Vercel, the instance's
  start) and the mold version (the shell's newest migration, the package version). Every error shown is cut short and
  has addresses, links, credentials and key-like text taken out (`safeError`). Proof: `npm run test:health-tabs`, and
  `npm run test:admin-sections` (the engine's tabs as before).
- **Health › Status as a grid of graphs** (mold_v0-210, built): the Status tab (`/admin/health?section=status`) is a grid
  (three columns from 1280 px, two from 768 px, one on a phone; the console's own charts, `components/ui/chart`,
  recharts, in `components/layout/chart-grid` boxes) with one graph per signal, its current state as its headline
  (e.g. "Up · 4 ms") and one 24h / 7d / 30d switch for the whole grid: database latency, API latency (p50 and p95), the
  health check (an uptime band: the share of samples up per bucket, grey where there was no sample), the row-level
  security probe and object storage (bands), the key vault's providers set and missing, the Claude provider's errors
  and refusals, scheduler lag (the most any job is behind, from `scheduler_jobs`), the run failure rate, the email failure rate (only when the app has Email Delivery) and the webhook
  failure rate (mold_v0-215, only with a developer surface: each sample counts the webhook deliveries settled and failed
  apart from the emails, `webhooks_total` and `webhooks_failed`, `sql/migrations/0039_health_samples_webhooks.sql`;
  rollback: `sql/rollback/0039_health_samples_webhooks.sql`, which drops the two columns); the last deploy and the mold version are a line above it, not a
  graph. The history is `health_samples` (`sql/migrations/0038_health_samples.sql`, platform bookkeeping closed to tenant
  work, `src/rls.ts` NO_ACCESS; rollback: `sql/rollback/0038_health_samples.sql`, which drops it with its rows), one
  row every 4 minutes at most across processes (`src/health-samples.ts`): a server's own loop (`startHealthSampler`)
  and, on Vercel, the cron entry, so history exists without the long-running server; each sample is tracked as the
  scheduled job `health_samples` and prunes samples older than 35 days. A sample is numbers and states only (no free
  text column: `rls` and `storage` are checked against their sets), never an address, a secret or a person. The API's
  latency is this process's requests since the sample before (a request's duration, nothing else; not `/healthz` or
  the cron entry), else the MCP requests' times every instance recorded (`mcp_events.ms`); the Claude provider's
  counters are the day's so far (`gateway_model_usage`), turned into differences per sample; refusals are the runs'
  refused-and-retried events. Staff only: `GET /api/admin/onboarding/health/history?range=24h|7d|30d`. Only in a build
  without the session engine (`APP_SCHEDULER=off` turns the loop off too): an engine build such as Octillion has
  neither the sampling nor these tabs, so its Health is unchanged. Proof: `npm run test:health-tabs` (sampling,
  throttle, retention, buckets, numbers and states only, closed to tenant queries), `npm run test:migrations`
  (rollback), `npm run check:rls`.
- **Accounts › Admins** (mold_v0-204, built): the platform's staff and their roles are the Admins tab of Accounts
  (`/admin/accounts?section=admins`, `web/src/features/admin/accounts-tabs.tsx`: Accounts | Admins, the same tab strip
  as Health's), in every app; the sidebar has no Admins entry and `/admin/admins` is gone (the console's not-found page,
  no redirect). The staff guide's Accounts row says so.
- **The key vault from the factory, read-only** (mold_v0-173, built): `npm run operator:vault-status [-- --json] [-- --all]`
  (`scripts/operator/vault-status.ts`, `src/vault-status.ts`) says, per key vault provider the build reads (as the Key
  vault page lists them: `src/vault-providers.ts` `providerInBuild`, moved out of `src/platform-keys.ts`), its name,
  category, whether a key is set (turned on, the provider turned on; a Vertex AI backend counts its service-account
  key) and when a key last changed; which providers the build's run kinds need (each kind's `providers`, its
  `operator_credentials` as `pack_credentials` labels, boat when `boatForRuns` sends the runs' sandboxes there; with
  the deployment's `APP_RUN_SANDBOX`) and which of those are missing; and how many runs are queued and the latest
  `waiting` reason on them (`run_events`). It is **read-only**: one connection with the app's own role (`DATABASE_URL`,
  else the local PGlite database), one transaction made `READ ONLY` before its first query (checked with `SHOW
  transaction_read_only`) and always rolled back; it never calls `getDb` (which migrates): `DATABASE_URL` is taken out of
  the environment before the app's modules load. It never prints a value: its queries select slugs, flags, counts and
  timestamps only, never the sealed value, its hint or its metadata. Its first line, `// READ-ONLY. ...`, is what the
  factory's `provision.py <app> --operator vault-status [--dry-run|--yes]` reads to say so when it asks for the yes
  (`.claude/scripts/lib/operator_run.py`: a mold_v0 app on Vercel runs it from its build copy with `DATABASE_URL` and
  `APP_RUN_SANDBOX` read from its `<project>-api` production environment for the run only), and `provision.py <app>`
  (the check, offline) names the providers the packs' job kinds need with that command. Claude needed with no Anthropic
  key but a Vertex AI service-account key in the vault is "set (via Vertex AI ...)", as the gateway runs it there
  (`src/gateway.ts`); a kind that keeps a workspace store needs Object storage when the run's environment names no
  bucket (mold_v0-181). An operator credential declared `optional` (mold_v0-186) is never a need nor MISSING: the
  report lists it apart, after what the runs need, as "optional, not set (<what it adds>)" or "optional, set"
  (`runs.optional` in `--json`); a kind naming only optional ones adds no `pack_credentials` need, and the factory's
  offline check leaves them out too. `npm run test:vault-status`
  proves set and unset, no seeded secret or its hint in any output, a write inside its transaction refused (25006) and
  the database unchanged after it ran.
- **A run's events from the factory, read-only** (mold_v0-183, built): `npm run audit:run-events -- <run_id> [--type
  <type>]... [--attempt n] [--limit n] [--full] [--json]`, or `-- --recent [n] [--pack <id>]` for the latest runs' ids
  (`scripts/operator/run-events.ts`, `src/run-events.ts`): the run's state, cost and error, how many events of each type
  it has, and its events in order: the steps' output lines (`step_log`, `log`, `stderr`), the program's output files
  (`agent_output`, with the JSON of a small one), `workspace_ignored`, `workspace_written` (`unchanged` says the run wrote
  nothing), `workspace_indexed`. It is read-only exactly as vault-status is (one `READ ONLY` transaction, always rolled
  back, never `getDb`); it reads `runs`, `run_events` and the workspace's slug only (the scope's keys, never its values),
  and masks shapes of secrets (a URL's password, well-known token prefixes) in what it prints, on top of the redaction
  each event got when it was written. As an `audit:` script the factory runs it with no yes
  (`provision.py <app> --operator audit:run-events -- <run_id>`). `npm run test:run-events`.
- **A kind that always writes** (mold_v0-183, built): an agent-workspace kind's `write_back_required: true` fails a run
  ("run": it changed nothing in its workspace) that exited 0 and validated but left every write-back path as it found
  it, instead of letting it succeed silently (the audit app's seed-company stopped to ask a question; its refresh-apps was
  refused its writes; both "succeeded"). The harness learns it from the store's answer to the staged write-back
  (`unchanged`) and records `workspace_unchanged`. `npm run test:agent-runner` (11).
- **Required outputs** (mold_v0-188, built): an agent-workspace kind's `required_outputs` (globs of write-back files,
  `{name}` a declared argument) are what it always writes when it works, a report say. A run that exited 0, validated
  and staged its write-back but added or changed no file matching one fails with error_kind `output_missing`, naming
  it (event `workspace_output_missing`); nothing of it is written back and its results are not taken, as for any
  failed run. `required_outputs_when: "workspace_changed"` checks only a run that changed something (a program's
  quiet exit, "the report is current", writes nothing and still succeeds); `"always"` is the default. The audit app's
  report_audit_findings had its write to the report refused, appended one ledger line and "succeeded" ($11.60,
  run_S59pF-Rit5xA3fsh): declared, that run fails, saying so. **Why a failure, not a new status:** every API, MCP and
  console reader, the charges, the schedules and the allowances already know `failed`; a fourth terminal state would
  be one they all had to learn, and a reader that takes `succeeded` as done would count a run with its report missing
  as a finished one. The run's status stays `queued | running | succeeded | failed | cancelled`; `output_missing`
  joins error_kind (migration 0030 widens its check), never retried, and its cost counts as a failed run's does
  (`price.on_failure`; allowances count every run's cost). The console's runs tab shows it as a red "Failed (output
  missing)" with the error; the factory board's spend line names it and counts the month's.
  `npm run test:required-outputs`, `npm run test:agent-runner` (12).
- **Checkouts as directories** (mold_v0-183, built): a checkout step's `mount_as: "directory"` places each repository
  as a read-only copy of the cache's tree (directories 0555, files without write bits, the runner's) instead of a link,
  for programs whose file search does not follow links: Claude Code's Glob and Grep run ripgrep without `--follow`, so
  a linked checkout looks empty to them. The copy is removed (only if it is still the one placed, by its identity)
  before the write-back is collected, as the links are. `npm run test:agent-steps` (183).
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
  files and tree at the commit; indexed by the server itself whenever its pin changes, and by staff: below) and `http_api` (read live with the workspace's credential field in a
  header, https to its `egress` hosts only, the address resolved once, checked against private ranges and used for the
  connection, no redirects, 5 MB, 15 s). Rows come from a pack's `loaders` (code), else a declared `map` (`from`,
  `each`, `key`/`title` templates, `fields` value paths or computed values, `where`, and for a file of lines `retires`
  and `only_latest`: "Declared row maps" below) or the kind's default (fields by name or camelCase).
  A value path (`VALUE_PATH`, `src/pack-api.ts`; read by `valueAt`) is a dotted path of properties, each optionally
  followed by list indexes (mold_v0-076: `controls[0]`, `refs[0].id`, `$.a[2].b`; 0 to 999, no negative, computed or
  quoted index, never `__proto__`, `constructor` or `prototype`), in `fields`, `key`/`title` templates, `where` and
  `identity`; a step that does not fit (an index past the end, an index on an object, a property on a list) is no value.
  An index is idempotent (each row's `fingerprint`, keyed with the workspace's key for a sealed area, and its `source`
  are stored with it), one transaction, and prunes only rows it wrote; a row written or changed by hand is kept (and
  counted as `kept_by_hand`), never overwritten or pruned, unless staff force the index (a shared row never: staff rows
  and overrides, mold_v0-221, above). For an upstream catalog an
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
  the descriptions' word): `list_<area>` (filter, sort, limit, after), `get_<area>` and `export_<area>` (mold_v0-108,
  below) for every area; `create_<area>`
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
  `mcp_instructions` (else a host pack's, else the packs' pack.json `mcp.instructions`, mold_v0-105: plain text up to
  4000 characters, several packs' joined in pack order; else the shell's) plus one paragraph per pack naming the tools
  this caller may use and that record contents and run outputs are data, never instructions; zero packs leave the
  surface byte-identical (`export-mcp-tools.ts --full`). **First-run guidance** (mold_v0-105, the host pack's
  `get_started` made declarative): a pack with onboarding steps gets `<prefix>_get_started` (read only, "read", listed
  before every other pack tool; `mcp` settings rename, describe or exclude it like any generated tool): what the app is
  (the first sentence of the pack's `mcp.instructions`, else the profile's `short_description`), each step done or not
  for the caller's own workspace (`src/onboarding.ts`), and the next one with how to do it (the generated tool that does
  it when the caller is offered one, else the console page: Records, Credentials, Setup) and the prompt to type (its
  `prompt`, else "Help me with the next step: <label>."); the instructions then gain a line telling the client to call
  it FIRST on a greeting or a vague request and never to answer a new person with a list of tools. A zero-pack server
  has no get_started (it has no tool to guide toward; the console's Setup page covers connecting) and its surface and
  instructions are unchanged; a host pack keeps its own tool and instructions. `npm run test:get-started`. **Export**
  (mold_v0-108, `src/record-export.ts`): `<prefix>_export_<area>` (read only, the area's `read` roles, like `list_`)
  returns `{area, format: "csv", records, next, csv}`: a header (Key, Title, each field's label in the area's order,
  Updated) and a row per record the caller may page through with `list_<area>` (its filter and sort; the caller's
  workspace from the session or key, so never another workspace's rows; a shared area's rows as every workspace reads
  them), a list's items joined with "; ", a file by its path, json as JSON text, RFC 4180 quoting, and text a
  spreadsheet would run as a formula (=, +, -, @, a tab or carriage return first) written with a leading apostrophe. At
  most 5000 records or 1 MB of CSV a call: `next` is the cursor after the last record it holds (a page that does not fit
  whole is read again just up to what fits), passed as `after` for the rest; one record larger than that is refused
  (413). The console offers **Export CSV** on every area tab (one area, or a merged tab's rows with its Source column)
  and on an area's records page (`web/src/features/tabs/export.tsx`): the same file, read through the same routes the
  page shows (`/api/records`, so the person's role and workspace as there), up to 10,000 records, with a byte-order mark
  for spreadsheets. A pack that withholds an export tool (`mcp.exclude`, `admin_only`) has no Export CSV on that area's
  pages (`exportWithheldAreas` in `pack-nav.generated.ts`); the rows stay readable where the list is. Zero packs: no
  export tool, the surface unchanged. `npm run test:record-export` (`--browser`: the downloads in a built console) and
  `npm run test:mcp-tools` (every export probed across two workspaces). **Install pages**: `GET /install`, `/install/:client`, `/install.json`, public, for
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
- **MCP words as config** (mold_v0-137, built; `src/text-template.ts`, `src/mcp-prompts.ts`, `src/host.ts` `engineConfig`):
  what an MCP client reads of an app is declared, not coded. pack.json **`mcp.prompts[]`**: slash commands, each a `name`,
  `title`, `description`, `arguments` (each a `name`, `description`, `required` or not, `type` `string` or `integer`: an
  integer counts as given only when it is a positive number, and is filled in rounded) and `text` (one string or a list
  of lines joined with line breaks), a **text template**: `{arg}` the value as given (an empty one included), `{arg|json}`
  its JSON, `{a,b|json}` a JSON object of those of a and b that are given (in that order), `{?arg}…{/arg}` only when it is
  given, `{!arg}…{/arg}` only when it is not (blocks nest; given: not absent and not empty), `{{` a brace; anything else
  in braces is text as written (`{}`, `{ key: ... }`). The build refuses a template that names no argument of its prompt,
  a block never closed or closed by another name, a prompt name two packs declare, and control or direction characters.
  The customer MCP server lists them after every tool and the host packs' own prompts, in pack order; each answers one
  user message, its text filled with the arguments given (a required one missing is refused by the server, as for a
  coded prompt). Zero packs, or none declared: no prompt and no prompts capability (the zero-pack surface is unchanged).
  A **host pack's** pack.json `mcp.instructions` stand where its host entry's `instructions` did in `leadInstructions`:
  the profile's `mcp_instructions` win, then the host entry's own, then the host packs' pack.json ones, then the other
  packs' (joined), then the shell's. A host pack's **`engine.config`** (pack.json `engine: { config }`, only a host pack's,
  plain JSON up to 256 kB, written into `src/hosts.generated.ts` when one declares it) holds the words its own code reads:
  its host entry gives the schema (`defineHost({ engine: { config: <zod schema> } })`), checked when the hosts register
  (`registerHosts`: every problem with its path; a config with no schema, a schema with no config and a config of no
  registered host are refused, so a server does not start on words it cannot check), and its code reads the checked value
  with `engineConfig(id)` (`src/pack-host.ts`, with `fillTemplate` and `templateProblems` for its own templates) where it
  is used, never at a module's top level (that runs before registration and is refused). The first product moved its
  server instructions, its five slash commands, its tools' titles, descriptions, argument descriptions and status lines,
  its widget's description, its get_started stage texts and its no-plan message there (the pack's `server/texts.ts`);
  a parity snapshot of its build before and after shows the same MCP surface. `npm run test:mcp-prompts` (the template
  engine; the declarative fixture `fixture_digest`; zero packs; order and the host slot; the build's refusals; a host
  pack's engine.config). **Not covered:** a prompt name a host pack registers in code is not known at build (the server
  refuses the second registration when it is made); prompts carry no role (they read nothing; the tools they name check
  their own).
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
- **The client skill** (mold_v0-144, built; `src/client-skill-config.ts`, `src/client-skill.ts`): every build serves a
  skill bundle for AI clients (the Agent Skills format: `<name>/SKILL.md` and reference files), generated from its own
  profile and config and what its customer MCP server lists: the frontmatter (name, description), the body, a section
  saying where the connector is (the front door's `/mcp`, and `/install`), and `reference/tools.md` (every tool the
  server lists, with its description and whether it changes anything). `GET /install/skill.zip` (also
  `/downloads/<name>-skill.zip`), public, deterministic (sorted entries, one fixed time); `/install` offers it with the
  upload steps, `/install.json` names it (`skill`). With no config the body is generated (the product's description, the
  server's instructions, a table of its tools). A pack declares its own in pack.json `client_skill` (`name`,
  `description`, `body`, `files`, `words`; at most one pack of a build), the app's profile.json `client_skill` over it
  field by field; gen-packs checks it (a skill name of lowercase words and hyphens without a client's reserved words,
  one-line description, a body without frontmatter, files beside SKILL.md ending .md or .txt, never SKILL.md or
  reference/tools.md) and writes `src/client-skill.generated.ts`. `npm run test:client-skill`.
- **The connect guide** (mold_v0-171, built; `src/connect-page-config.ts`, `src/install-pages.ts`): one more public page
  where a pack declares pack.json `connect_page` (one pack per build), at the address it names (the first product's
  `/connect.html`, a link it had sent to customers; never one of the shell's own addresses). The shell draws it from the
  config's words (title, heading, lead, each client's numbered steps, the skill's heading and steps, first-run cards and
  note, footer tagline and links, a header link, the accent colours) and what it knows: the connector's address (the
  front door's `/mcp`), how a client signs in, how a member key goes in a header (with keys on, never in the address),
  a link to `/app`, the client skill's download button (`/downloads/<name>-skill.zip`) and "© <year> <product>". Texts
  are one line each, escaped, with `**bold**`, `` `code` ``, `[links](/path)` (a path, an #anchor or https) and the
  `{product}` and `{skill_file}` placeholders; gen-packs refuses anything else and carries the block to the server in
  `PACK_CONFIG`. Without one, nothing changes. `npm run test:connect-page`.
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
  **Off** (mold_v0-099): `"member_keys": false` in the profile (`src/profile.ts`, checked by gen-packs: true or false)
  removes member keys. The console has no API keys page (`/app/keys` is not found) and no sidebar link to it; the
  customer guide names no key; every route of `/api/keys` answers 403 `{code: "member_keys_off"}` with how to connect
  instead; the install pages and `/install.json` (`api_keys: false`) offer each client's sign-in only (no "With an API
  key" card, no header-only entry), and sign-in counts as available under the built-in sign-in as well as Clerk, since
  `/mcp`'s OAuth (`src/mcp-oauth.ts`, or Clerk's) is then the only way a client connects. Every client the catalog
  lists connects by sign-in, so none is dropped; the only header-only entry ("Header-capable clients") is listed only
  with a key. **Existing member keys stop working:** `/mcp` refuses one with a 401 whose message says API keys are
  turned off and to sign in (`error.data.reason: "member_keys_off"`), and a client falls back to OAuth from its
  `WWW-Authenticate`; the rows are kept, so turning keys on again brings back those not revoked or expired. The account
  keys staff issue on `/admin` (no person, or an older person key) are not member keys and keep working; the
  generic 401 then names sign-in only. `npm run test:member-keys`, `npm run test:install-docs`.
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
  field by default, timeline by a date field or updated, detail; no charts since mold_v0-208), `runs`, `reports` (finished runs and
  their results), and the shell's own pages `credentials`, `usage`, `schedules`, `notices`, `setup`, `billing`,
  `profile`, `team` and `keys` (the Team part of Billing and the person's own API keys, mold_v0-133; a build refuses
  `keys` when member keys are off; two packs' tabs that open one shell page are one sidebar entry, the first's), or one of the pack's `page`s. `label` in the app's words (an area tab defaults to the area's label), `icon`
  from a fixed set (`TAB_ICONS`). Each tab is shown to `roles` narrowed by what it shows (an area's read permission;
  for an overview, the roles that may read one of its metrics; a build refuses a tab no role could see); the server
  refuses the data whatever the sidebar shows. Tab pages render at `/app/<tab>`, as a pack's own customer pages do at
  `/app/<page>` (mold_v0-132, flat: one route, `web/src/app/app/[page]`; before, `/app/packs/<pack>/<id>`, which now
  redirects to the flat address, `pack-routes.generated.json`). The breadcrumbs read "Account / <the tab's label>".
  `gen-packs` refuses an id whose address another page holds: a shell page (a folder of `web/src/app/app`: `billing`,
  `records`, ..., and `packs`, `host`), a host pack's page (its `routes.json`), or another pack's page or tab. Admin pack
  pages stay at `/admin/packs/<pack>/<page>`. Boards and timelines show up to 200 records; a board by a workspace area's lifecycle field
  offers each card the moves its state allows (a menu, no drag), through the data API's move (`POST
  /api/data/:area/:key/move`, the record store's roles and transitions; the move stamps the state's time). `npm run test:console-tabs` checks the sidebar, the tab pages, a rendered overview and board in a headless
  browser (when the machine has one) and the build copy's typecheck.
  **Empty states** (mold_v0-107): an area, runs or reports tab with nothing to show says so with a title ("No findings
  yet.", from the area's label or the tab's), a line of text and a link, as a section named by its title
  (`web/src/features/tabs/empty.tsx`). pack.json `tabs[].empty` sets `text` and `cta` (`label` and either an `href`: a
  path of this site, an https:// or a mailto: address, the landing block's rules; or an `action`: `setup`,
  `onboarding:<one of the pack's steps>`, `run:<one of the pack's job kinds>`); plain text on one line, no braces, at
  most 300 and 40 characters. What it leaves out is the shell's default, in the build's words (`src/metric-spec.ts`
  `tabEmpty`): the onboarding step that waits on the area (`done_when: record:<area>`) with a link to it on the Setup
  page (`/app#onboarding-<pack>-<step>`); for a shared area, that the platform adds its records; for an area the
  AI client can add to (its create tool is on the customer MCP), to ask the client; for a pack with job kinds, that its
  runs add them; for a runs or reports tab, to start one from the AI client. gen-packs checks and resolves it into the
  tab's spec. A record table or a board that scrolls sideways (any `Table` of the console, and the board's columns) is
  then a labelled region with `tabindex="0"`, so a keyboard can scroll it (axe `scrollable-region-focusable`,
  mold_v0-114; `web/src/hooks/use-scrolls-sideways.ts`); one that fits is not a tab stop. `npm run test:declarative-packs` refuses malformed `empty` blocks and checks the defaults;
  `npm run test:console-tabs` draws empty states, a scrolling table and a scrolling board.
  **Columns and merged tabs** (mold_v0-135): an area tab's `columns` names its table's columns (and a board card's
  fields), the area's list columns by default. An area tab may show several record areas as one list: `areas` in place
  of `area`, 2 to 4 entries `{area, rows, source}`, config only. Rows are merged by record key: the first area's rows,
  then each later area's rows that no earlier area holds (`rows: all`, the default); an area with `rows: matched` only
  adds its fields to rows another area brings (a lookup by key), so a shared catalog joins the workspace's own rows
  without listing the whole catalog. A row's fields are the union of its areas' fields (the first area in the list with
  a value gives each; the title likewise; its time the latest), and `source` is the area's word in the tab's `source`
  column (an enum of those words: a column, a board field). The first area is the tab's own: its label names the empty
  state ("No <its label> yet.") and its onboarding step; a row opens the record of the first of its areas. Why a union
  by key and not stacked sections or a join on a field: an app's "everything that applies, with its status" is one list
  (one sort, one board, one count), its areas already share their keys (a status row is keyed by what it is the status
  of, as the audit app's ledger keys its control lines by the control's key), and a row only some areas hold (a control with no
  status yet) still shows. gen-packs refuses an undeclared area, an area twice, a first area that brings no rows, a
  column, `board_by` or `timeline_by` no area declares or that two areas declare with different types (an enum's options
  are every declaring area's), a merged board with no `board_by`, and a `source` word beside an area field named
  `source`. The tab is shown to the roles that may read every one of its areas, and hidden when one of them is withheld
  (`mcp`); the views are the same (table, board, timeline, detail; a merged board offers no moves). The rows come from
  `GET /api/records/tabs/<pack>/<tab>` (`src/record-merge.ts`): only a declared merged tab, each area read as on
  `/api/records/<area>` (its read permission for the person, a shared area's rows, the workspace's own rows), `limit`
  1-200 and a cursor that names the area being listed and its own cursor, so the order never depends on how the
  database sorts one area's keys against another's; a page may hold fewer rows than `limit` (later areas' rows mostly
  listed already) and still have a `next`. `npm run test:declarative-packs` refuses malformed merged tabs and checks the
  resolved spec (`scripts/fixtures/packs/fixture_status`); `npm run test:merged-tabs` checks the rows, paging at every
  size, two workspaces and the route's refusals in an embedded database; `npm run test:console-tabs` draws a merged
  table, board, timeline, empty state and a narrow table in a headless browser.
  **A home tab** (mold_v0-134, mold_v0-172): an `overview` tab's `include` (`["setup", "notices"]`, each at most once)
  makes it the build's home, drawn as the Setup page itself, the same layout for every build (`SetupPage` in
  `web/src/features/portal/setup.tsx`; `HomeTab` in `web/src/features/tabs/tab-page.tsx`), with no page title: the main
  column is the one checklist (the setup steps and the packs' steps, mold_v0-146), every step with its description and,
  while open, its prompt in a Copy prompt box (a pack step's pack.json `prompt`, the get_started tool's "say"; the
  current one highlighted, done ones checked), then tips when the build has them; the right column is the "Connect your
  AI client" card (pick a client, the URL with Copy URL, Test my connection), then the tab's `rail`, up to two cards in
  order: `journeys` (since mold_v0-207 the **Due soon** card, below; the journey selector it once was is the main
  column's heading), `notices` (the records due soon, the first
  five then "Show all"; `DueSoonCard` in `web/src/features/schedules/notices-page.tsx`; needs `include: notices`), or
  `chart:<name>` (one of the pack's `number` charts as a card of its tiles, with a link to the pack's other overview
  tab that lists it). Without `rail` the second card is the Due soon card (the Setup page's own layout, zero packs
  included). Included `notices` no card shows follow the checklist (`DueSoonSection`, headed "Notices" in a build with a
  clock, beside the Due soon card). **No charts on the home page** (mold_v0-207): the tab's `charts` and `charts_title`
  are accepted (a pack stays valid: its metrics still drive the headline row, the list tabs' cards and the rail's number
  cards) and not drawn; a build does not refuse them, so packs written before keep building. The
  tab is drawn at `/app` itself (mold_v0-175, `web/src/app/app/page.tsx`): its own `/app/<id>` and `/app/notices` (and
  every address under it) redirect to `/app` (`pack-routes.generated.json`; a hidden page, mold_v0-130, leads there
  too, in one hop); the pages themselves stay for a build without one. A build refuses `include` on any other kind, a
  section twice or unknown, `roles` on such a tab (it is every member's home: it is every role's, not narrowed by its
  charts' metrics), `notices` with no due-date area, a second tab including the same section, a `setup` or `notices`
  tab beside it (its page would only redirect), and a `rail` on any other tab, a card twice, `notices` without
  `include: notices`, a chart that is not one of the pack's number charts, and `charts_title` on a tab that is not a
  home tab with charts. **The sidebar** shows no heading for a group of one entry named like the group (mold_v0-175:
  `web/src/components/layout/app-sidebar.tsx`; a pack's Overview tab in an Overview group is one entry).
  `npm run test:declarative-packs` refuses those and checks the registry and the redirects; `npm run test:console-tabs`
  draws the tab (the checklist with its prompts, the connection card, a number card and the notices card, no charts
  grid; then every step done).
  **The journey selector and the Due soon card** (mold_v0-207). The main column's heading is the journey selector, for
  every build: a button with the selected journey's name ("Get set up" by default), its progress and a chevron, opening
  a listbox (`role="listbox"`, options with `aria-selected`, the active one by `aria-activedescendant`; a search box,
  `role="combobox"`, past six) of every journey with its progress (1/9); Enter, Space or the arrows open it, the arrows,
  Home and End move, Enter picks, Escape closes back to the heading. Picking one switches the steps below and keeps
  `?journey=<id>` (`JourneyMenu` in `web/src/features/portal/setup.tsx`). A home tab whose `rail` leaves out `journeys`
  keeps a plain "Get set up" heading. The right column's second card is **Due soon**
  (`web/src/features/records/due-soon-card.tsx`, the Connect card's style): the records coming due or overdue across the
  workspace, from the record clocks (`GET /api/records/due-soon`, `src/record-clocks.ts` `dueAcross`): one row per record
  and clock that is overdue or due soon, overdue first, then the soonest deadline, six at most, each with its title, area
  and clock, a badge (Overdue Nd, Due soon) and a relative date, a link to the record's page; View all opens the area's
  list (its own tab, inside its sections tab when it has one, else `/app/records/<area>`) with the Overdue filter on
  (`?overdue=1`, now kept in the address) when something is overdue. The server reads each area inside the workspace's
  tenant scope, only the clock areas the person's role may read and whose list no pack withholds (a sealed area while
  the vault is locked is skipped). Nothing due: a calm line ("Nothing is due or overdue"). **No card** in a build with
  no clock (Octillion: a card that could never fill would only promise a feature the app does not have) nor for a role
  that may read no clock area (as a tab is never shown to a role that may not read it). `npm run test:record-clocks`
  checks the route (order, the default six, two workspaces, a role that may not read the area, signed out).
  **A sections tab** (mold_v0-175): `{"kind": "sections", "sections": ["<tab id>", ...]}` draws several of the pack's
  own tabs (area, runs, reports or schedules: 2 to 6) as one page with an in-page tab strip (`Tabs`, line variant)
  above the selected one's charts, views and table (`SectionsTab` in `web/src/features/tabs/tab-page.tsx`; the table is
  the area tab's own, whatever draws it). `?tab=<id>` picks one (the first by default); each in-page tab is the page's
  `?tab=<id>` in the registry, leaves the sidebar, and its address of before (`/app/<id>`, or the shell's page for a
  schedules tab: `/app/schedules`) redirects there. The page is shown to the roles that may read one of its tabs, each
  in-page tab to its own roles. Refused: a sections tab naming none or one, a tab twice, an undeclared tab, another kind,
  a tab in two sections tabs. **A filtered area tab** (mold_v0-175): an area tab over one area may declare `filter`
  (a list filter as the record tools take it: `{"status": {"in": ["remediating", "resolved"]}}`), applied by the server
  on `/api/records/tabs/<pack>/<tab>` (never by the page: paging stays right); a field the area lacks is refused.
  `npm run test:declarative-packs` refuses those and checks the URLs, the sidebar and the redirects.
  **A list tab's four cards** (mold_v0-181): every area, runs, reports and schedules tab (on its own page or as an
  in-page tab) shows four cards first, then its toolbar (the row with search, Filter and Export CSV), then its table
  (mold_v0-208: the cards moved above the search row, in the console's shared table, `RecordView`'s `summary`, so every
  list that draws cards reads the same: the Access log, Health's tabs, FinOps and Compute; above a board or a timeline,
  which have no toolbar), each a label, a value and a sparkline of the last 12
  weeks (`web/src/features/tabs/sparklines.tsx`, drawn as the console's headline numbers: `StatStrip` with `quad`, four
  across from a wide screen and two by two below it, one fixed height with placeholders while they load, each card's
  value and trend said in words for a screen reader). pack.json `sparklines` on such a tab names exactly 4 of the pack's
  metrics, in order: a single number (a count or a sum: its line is a running total of the rows it reads today by the
  week each was added, ending at the value; an average, a rate or a duration: its line is the same measure week by week,
  by its duration's end or else when the row was added) or a series (`by_time`: the value is its current bucket, the
  label "<label> this week", "this month" or "today", the line its weeks); never one with `group_by`. Without it the
  shell's four (`src/metric-spec.ts` `sparkPlan`): an area tab's rows (under the tab's label), new in the last 7 days,
  then two of the pack's own metrics over the area that the person may read, else changed in the last 7 days and the
  most common value of the area's main enum (its lifecycle's field, else the first single-choice enum of the table's
  columns); a filtered tab's cards count the rows its filter shows (a filter they cannot apply, a key, a title, a
  prefix or text, is refused at build: declare the tab's `sparklines`), a merged tab's its own area's. A runs, reports
  or schedules tab: {Runs} this week (reports: finished), the share that succeeded, the average duration and the
  spend. The numbers come from `GET /api/sparklines/<pack>/<tab>` (`src/sparklines.ts`, mounted when a pack declares a
  list tab, so with zero packs or none nothing answers): every card a metric the metric engine computes for the
  session's workspace under its row-level security (`computeSpec`: the declared ones and the shell's, no SQL of its
  own), the tab refused to a role the sidebar does not show it to (403) or when its list is withheld (404), each card
  to a role that may not read its metric alone (its place and label kept, "not shown to your role"). gen-packs refuses
  `sparklines` that are not exactly 4, a metric twice, on another kind of tab, a metric the pack does not declare, one
  with `group_by`, one whose weeks have no point in time. A build whose packs declare no list tab (Octillion's host
  pack) shows no card and mounts no route. `npm run test:declarative-packs` refuses those; `npm run test:metrics`
  checks each card's value and weeks by hand (declared, an area's and a runs tab's defaults, the commonest value), two
  workspaces, a role, and the route; `npm run test:record-pages` the words and that every list shows them.
  **A home tab's headline row** (mold_v0-203): pack.json `sparklines` on the home tab (an `overview` that includes
  `setup`) names 1 to 4 of the pack's metrics, drawn as the same cards (`TabSparklines`, `StatStrip` with `quad`: four
  across from a wide screen, two by two below it, in the console's light or dark theme) in a row at the very top of the
  Overview, above the checklist or journey and the right column (the connection card, the Due soon card). The same
  rules as a list tab's cards (a declared metric, never grouped, weeks to draw, never twice) and the same route
  (`GET /api/sparklines/<pack>/<home tab>`, mounted for it too; the home tab is every role's, each card refused alone to
  a role that may not read its metric). The registry carries the list as the tab's `headline`; a number the row shows is
  left out of the tab's `number` charts (below, and a `chart:<name>` card on the right), a number chart left with none
  is left out (one idea once per page; a bar or line chart draws a breakdown or a trend, not the same number, and
  stays). Without it, no row: the page is unchanged. gen-packs refuses more than 4, none, one on an overview that is not
  the home tab, and the list tab's other refusals; `npm run test:declarative-packs` checks those and the registry, `npm
  run test:console-tabs` draws the row above both columns and the number card without its numbers.
  **A list tab is its cards, its search row and its table** (mold_v0-208): an area tab draws no charts (`charts` on an
  area tab stays valid and is ignored: the console's registry carries none for it and the guide lists none; a pack's
  charts are an overview's), so no chart grid sits above or around a list. Why ignored and not refused: every pack
  written before (the audit app's five list tabs, the fixtures) keeps building unchanged, and dropping the key is its own
  pack change, not a broken build.
  **A list tab's primary action** (mold_v0-208): pack.json `tabs[].action` declares one primary button for the tab,
  config only: `{"kind": "start_run", "label"?, "job_kind"? | "job_kinds"?}` on an area, runs or reports tab (one of
  the pack's job kinds, a picker of 2 to 20 in order, or every kind of the pack; never one gated by an approval),
  `{"kind": "new_schedule", "label"?, "job_kind"?}` on a schedules tab (a kind the pack itself schedules, preset in the
  form) or `{"kind": "create_record", "label"?, "area"}` on an area tab (one of the pack's own workspace areas, not read
  from a repository). It opens the shell's existing ways in, never a pack's own form: a run starts exactly as the
  generated `start_<kind>` MCP tool starts it (its input schema, its permission, its handler: `src/mcp-tools.ts`
  `startFromConsole`, behind `POST /api/tab-actions/<pack>/<tab>/start`, `src/tab-actions.ts`), with the kind's `args`
  as a form (typed as record fields), the asset record it runs over and its environment when the kind takes them; a
  schedule through the schedules page's Add a schedule form (in a drawer, in place of the form below the list); a record
  through the data API's create (`POST /api/data/<area>`), its key, title and fields. The button
  (`web/src/features/tabs/tab-action.tsx`; mold_v0-217, before it floated at the window's bottom right) is a normal
  primary button, the last control of the list's search row at its right end (`RecordView` `toolbarAction`; a board or
  a timeline: after Export CSV in the views' row), the toolbar's button size, an icon and its label from `sm` up and the
  icon alone on a phone (its label the accessible name and title), the row wrapping as it must. Its form opens as a full
  card in the list's place (`ActionCard`, `CardForm`; the record details card's style): a way back, the title, a short
  summary of what will happen, the fields, then the submit and Cancel. It is kept in the address (`?start=1` for a run,
  `?new=1` for a record or a schedule), so Back returns to the list; Cancel, Esc or a submit return to it, the list read
  again and focus back on the button. A link action navigates. A row opened from any `RecordView` table is the same
  full details card in the list's place (no peek beside a narrowed list), and a record's own page is that card too.
  A json field never shows raw JSON (mold_v0-240, `web/src/features/records/json-text.ts`, `json-value.tsx`): on a
  record's page, an open row's card and a staff record's page a list of objects is one line per item (its name, then
  its meaningful fields: "Production · Hosting: AWS, ap-south-1") and an object one "Label: value" line per field;
  nested objects flatten to their values; bookkeeping (`schemaVersion`, `kind`, `$`/`_` keys, a value repeating the
  record's own key, a field repeating its item's name) is hidden; common short values read in words with the
  credentials card's mapping (`web/src/lib/value-words.ts`: prod reads Production). A list's cell, its search and a
  board's card keep it one line ("Production (AWS, ap-south-1); Staging (AWS, ap-south-1)"); Export CSV keeps the
  stored JSON. A record's Credentials card has no count line under its heading. Proof: `npm run test:record-pages`
  section 13. A
  list (an area, runs, reports or schedules tab, a records page; mold_v0-231: every list page of both consoles, Notices,
  Billing's Access log and the staff `/admin/access-log` too; proof: `npm run test:record-pages` section 10 walks them
  and `npm run test:console-tabs` draws the list tabs) has no title or description above it, no count toggle
  in its toolbar (the Overdue filter is the Filter menu's rule, `?overdue=1`), and its cells show a status as plain
  text, not a badge. Every area list has **Export** in its search row just left of the primary action (empty or not;
  `web/src/features/tabs/export.tsx`, the same pages with `?audit=export`, so the data trail records it, and withheld where
  the pack withholds the area's export): the export tool's file, or, when search or a filter narrows the list, its rows shown alone. It is shown only to a role that may use it
  (`GET /api/tab-actions/<pack>/<tab>`: the start tool offered to the role, `manage` for a schedule, the area's create
  roles and `edit`), and the server refuses the rest. The route is mounted only when a tab has an action (since
  mold_v0-213 every list tab's by default), so a build without a list tab (zero packs, Octillion) answers nothing and
  its MCP surface is unchanged. gen-packs refuses an
  unknown kind or key, an undeclared or doubled job kind, one whose start tool the pack withholds (mcp), a picker of
  one, both `job_kind` and `job_kinds`, an action
  on the wrong kind of tab, a schedule with no kind the pack schedules, a missing, shared, undeclared or
  repository-read area, and a label with braces; `npm run test:declarative-packs` proves those and the registry.
  **Every list tab has its primary action by default** (mold_v0-213): an area, runs, reports or schedules tab with no
  `action` gets the shell's, from what it shows (`src/metric-spec.ts` `tabAction`, the same resolution in the build's
  registry and in `src/tab-actions.ts`): an area tab "Add <its area's singular>" (`create_record`, the create drawer)
  when the area is the pack's own, the workspace's (not shared), not read from a repository and its create tool is
  offered to a workspace; a runs tab "Start {run}" with the picker of every kind a workspace may start (no approval,
  its start tool offered); a reports tab "Generate <the tab's singular>" with the pack's report kinds, when it has one;
  a schedules tab "New schedule" when the pack schedules a kind. A declared action without a label gets the same
  words. Who sees the button is unchanged (the server's checks: the area's create roles and `edit`, the start tool's
  permission, `manage`). A pack overrides with its own `action`, or opts out with `"action": false` and a required
  `reason` (plain text, at most 300 characters: why the list has nothing to press; documented in pack.json, carried
  nowhere, shown nowhere). A fourth kind, `{"kind": "link", "label", "href"}` (both required; an /app path, an https://
  or a mailto: address, the empty state's rules), is a plain link on any list tab, everyone's who sees it, for a list
  whose rows a setting brings (the audit app's Private communications: "Connect mailbox", Settings › Email). gen-packs prints
  every shown list tab left without an action, and why, as a warning (`gen-packs: warning: N list tab(s) without a
  primary action:`, one line per tab: the opt-out's reason, or what kept the default away: a shared area, a
  repository, a withheld create tool, no startable or report kind, nothing scheduled). gen-packs refuses a link without
  its label or href or with a job kind or area, `action: false` without a reason or off a list tab, and a reason
  without it; `npm run test:declarative-packs` proves those, each default and the warning.
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
- **Clocks, reminders and escalation** (mold_v0-191, built; `src/clock-math.ts`, `src/record-clocks.ts`,
  `sql/migrations/0032_record_clocks.sql`; `npm run test:record-clocks`). A workspace area declares `clocks` in pack.json
  (at most 5; `src/pack-api.ts` `ClockSchema`, checked at build by `clockProblems`), with no pack code: a deadline each record
  runs against. `starts` is one of its date fields, `{event: "created"}` or `{event: "entered", state}` (its lifecycle's
  `$state_at`); `after` a duration (`"90d"`, `"48h"`, `"10bd"`: business days, Monday to Friday UTC) or `{by: a single-choice
  enum, values: {option: duration}, default?}`; `not_later_than` a date field that caps it (the earlier wins); `stops_when`
  `{field, in, at?}` (met when it stopped by the deadline, missed after; `at` a date field saying when, else the lifecycle's
  time for its field, else when the check saw it); `pauses_when` `{field, in}` (the deadline moves out by the time paused,
  business time for a business-day clock, exactly from the lifecycle's times when the field is its field); `assignee` a
  person field; `notify` the roles (and `assignee`) told by default (owners); `soon` (the first reminder's `before`, else
  7d); `remind` `[{before, notify?}]`; `escalate` `[{after, label?, notify?, reassign?: {field, from_field}, raise?: {field,
  to?}}]` in order of `after` (time past the deadline). Refused at build: a start that is not a date, mixed calendar and
  business time, an assignee not declared or not a single person field, steps out of order or doing nothing, raising the
  field the duration is chosen by (its deadline would move with every step) or the lifecycle's field, a clock on a shared
  area or on an area read live from an API, reassign or raise on a read-only (repository) area, a clock named like a field.
  **What the shell keeps** (`workspace_record_clocks`: per record and clock, the status and deadline last seen, the time
  paused, when the current pause began, when it stopped) and **what happened** (`workspace_clock_events`, append-only:
  started, paused, resumed, stopped, reopened, `remind:<i>`, `escalate:<j>`, each once per record, clock and deadline by its
  unique key, with what it did: who it told, a person reassigned or a value raised). Both under `tenant_isolation`: the check
  runs one workspace at a time inside that workspace's tenant scope, so it reads its own records and writes its own clock rows
  and events only (the tenant role may insert and update clock rows, insert events, never change or delete one; `check:rls`
  probes A writing B's). **The check** (`clockCheck(now)`, from the scheduler's tick, `src/schedules.ts` `schedulerTick`, at
  most every 15 minutes: `scheduler_marks` `record_clocks`): each record's clock observed (`observe`: its view, the memory to
  keep, what changed), every change and every step due (`stepsDue`: a reminder once the deadline is within its `before`, an
  escalation once overdue for its `after`; nothing while not started, paused or stopped) recorded once; a record first seen
  with several steps due does every one (their changes too) and tells only the latest, so nobody gets a pile of old
  reminders. A step tells people only through the shell's own paths: one in-app notice per record and deadline
  (`workspace_notices` kind `clock`, raised again by each step, its latest step in words on Notices) and one email per person
  of the workspace (`src/email.ts` `clockSteps`, kind `clock_step` in the profile's `due_dates` group: off unless the profile
  lists it; owners by role, the assignee when they are a member; a sealed record named by its key). Reassign and raise write
  through the record store as the shell (the area's fields and lifecycle rules apply; a refusal is recorded as
  `<step>:failed`). Running it again, or several at once, does nothing more. Sealed areas are opened with the workspace's
  key in its scope; with the key vault locked they are skipped and counted. **Where it shows:** every read of a clock area's
  records (`listFor`/`getFor`, so `/api/records`, the data API, `list_records`/`get_record` and the generated tools) carries
  `clocks` `{name: {status, due_at, due_on, overdue, overdue_days, ...}}`, computed at the read from the record and what
  the shell kept (the same function as the check, so a page shows what the check records); `list_records` rows add `due`;
  the record page shows each deadline and the clock's history (`clock_events`); the console's tables
  (`web/src/features/records/clocks.tsx`, every customer list of the area and its tabs) add a column per clock (its date and
  a status badge), its status as a filter and an **Overdue** toggle with the count above the table; `list_due_records`
  (the shell's MCP tool, only with a clock area: `src/shell-tools.ts` `CLOCK_TOOL_NAMES`) lists a workspace's records by a
  clock's status, soonest first (overdue and due soon by default); a metric may filter by a clock's status (`clock: {name,
  is: [...]}`, counted in code over the opened rows, as a sealed area's); a list tab over a clock area shows **Overdue**
  as its second default card. Zero packs and builds without a clock: no tool, no column, no check (the MCP surface hash is
  unchanged). Rolling back: `sql/rollback/0032_record_clocks.sql` (the clock notices and both tables go, the notices' kind
  check is 0008's again). **Not covered:** holiday calendars and time zones (business days are Monday to Friday, UTC); a
  pause by a field that is not the lifecycle's is timed when the check sees it (at most 15 minutes late); per-person
  in-app notices (a notice is the workspace's, shown to whoever may read the area).
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
  **before** the shell's (so its own Usage replaces the shell's neutral one; its Setup page is the shell's, from its
  pack.json `setup`, mold_v0-140), its larger request bodies, its
  error classes and its fields on `/api/app/billing`, `/api/admin/*`, `/api/admin/onboarding/*` (inside the shell's
  admin guard, access log and `assertGuarded`: every change names its permission) and `/api/worker/*` (behind the worker
  token, with the calling job's id); the session engine's hooks: scoring a completed session, extending a simulation's
  batch, the agent mix the autoscaler, fleet and Compute page schedule by (`src/agent-mix.ts`: else every registry agent
  at its registry weight); background work on the Vercel cron (its result in the cron's answer), the autoscaler's loop
  and after each successful tool call (`src/analytics.ts`); a new access request; its public files served after the
  shell's (else the root page is the shell's own, in the profile's words); the widget preview. Its global settings, the
  admin MCP's words for shell tools and skills, its Setup page, its sidebar entries and redirects are pack.json config
  since mold_v0-140 (below, "A host pack's console, Setup page, settings and admin words").
  *Its console* is `web/src/packs/<id>/`: `index.ts` (pages for `/app`, `/admin` and the site's root, by path; its
  landing page, the public pages' layout and metadata) and `routes.json` (the URLs its pages keep: next.config
  rewrites each, from `src/config/pack-routes.generated.json`, to `app/{app,admin}/host/[pack]/[...path]` or
  `app/(site)/host/[pack]/[...path]`, so `/app/pick-rate` stays `/app/pick-rate`). Its sidebar entries, the shell
  components its routes serve and its redirects are pack.json `console` since mold_v0-140 (a `nav.ts` here, or
  `redirects` in `routes.json`, is refused, naming the declaration). Its customer guide
  and its staff docs are config since mold_v0-139 (pack.json `guide`, the whole guide at /app/docs, and `staff_docs`,
  which join the shell's `docs/` as one folder on /admin/docs and in the docs answers' corpus; "Customer guide" below):
  a `guide.ts` here or a `packs/<id>/docs/*.md` file is refused, naming the declaration.
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
  private harnesses, contributions, reports, product personas; the three context and memory tables are the shell's
  again since mold_v0-142, "Account context and memory" below, and the six journeys and tips tables since mold_v0-143,
  "Journeys and tips" below, so 15 today) left the shell's base schema for the host pack's own
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
    Elsewhere it runs (on a schema-on-boot database too, as its baseline did once more before). The gateway's session rule no longer names `agent_sessions` (a session lookup function, 0003,
    0009 and `0017_gateway_session_policies`, which rewrites it the same way on a database from before), so the shell's
    own policies hold with or without the pack.
  The session engine stays in the shell and reads those tables only in a build whose host pack has them
  (`src/host-tables.ts`, from the build's registry, never from the database); with none it is dormant: no demand, no
  claims, no spend, empty Compute, Accounts, Usage and Billing figures, and a workspace deletes without them. Its admin MCP
  job tools named for simulations (`list_simulations`, `get_simulation`, `cancel_simulation`) are the host pack's, at the
  same places (`adminMcp.tools`; `get_account`'s words and the steps of the two skills that name them are its pack.json
  `admin_mcp` since mold_v0-140); the reads and the cancel behind them are the shell's (`src/pack-host.ts`). The engine's
  account stages (their labels, next steps and funnel labels) and needs-attention messages are the host pack's pack.json
  `account_stages` (mold_v0-121), required from the pack that owns the engine's tables.
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
  pages name the engine's work in the build's words and its own concepts in its host pack's (`texts`,
  `host.schema.labels`, mold_v0-141), but still carry its structure (the research brief's fields, the engine's
  onboarding-research sections, the library contribution credits on Billing); the default icons and Open Graph image are the
  first product's; the shell components a host
  pack's routes serve (in-chat tips, Setup's journeys, a requester's research) show only when its pack.json
  `console.components` names them; a dropped host pack's console and orchestrator folders are not
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
| `credentials` (`credentials`) | fields a workspace must give: label, help, bound to the workspace, an asset or an environment, how a run receives it (environment name, or tmpfs file and optionally the variable naming its path); `github_app: true` for a GitHub repository token a connected GitHub App replaces, or `oauth: "<provider>"` for one connected through an OAuth provider (mold_v0-014) | the workspace credential vault (mold_v0-034, built): the console's Credentials page; a kind's `credentials` names what its runs receive; only names reach a run's definition |
| `oauth_providers` (`oauthProviders`) | OAuth 2.0 providers the pack's credential fields connect to: sign-in, token and revoke addresses, scopes, the client id and secret by key-vault label, PKCE | credentials connected through OAuth (mold_v0-014, built): the Credentials page's Connect, tokens sealed and refreshed, `/admin/keys` lists providers and connections |
| `schedules` (`schedules`) | default schedules per workspace (a run kind over the workspace's asset records, a cron expression in UTC) | the scheduler (mold_v0-035, built: `src/schedules.ts`), editable per workspace by owners at `/app/schedules`; record areas' `due` dates post notices and email owners daily |
| `clocks` (on `record_areas`) | deadlines per record: a start, a duration (by a field's value), a cap, stops and pauses, reminders and escalation steps | due dates, statuses and an Overdue filter on every list and record, notices and emails at each step, reassign and raise through the store, `list_due_records`, metrics by status (mold_v0-191, built: `src/record-clocks.ts`) |
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

**Engine packs and config packs (mold_v0-145; the operator's rule: an app pack is config only).** A host pack whose
code carries no product's words is an **engine**: code and migrations an app runs through a **config pack** of its own,
an ordinary declarative pack (its `pack.json` alone) whose `engine.pack` names the engine. The app names both in its state
(`application.json` `packs`); `mold.json` `packs.host_packs` lists engines only (`apo`, the Agentic Preference
Optimization engine, the factory's `packs/apo`), so every app pack that is not an engine is config only, and `packs.py`
refuses an app that names a config pack without its engine, or a config pack whose engine is not a host pack of the
mold (each before anything is copied, naming the line to add). `scripts/gen-packs.mjs` folds the config pack into its
engine before anything reads the packs: the build has one pack, under the engine's id, exactly as if the engine's
`pack.json` said everything (proved file for file by `npm run test:engine-packs`):
- the config pack's `engine.config` is the engine's (its host entry's schema checks it when the server starts),
  `engine.profile` its `host.profile`, `engine.labels` its `host.schema.labels`, and every other declaration (`mcp`,
  `landing`, `access_request`, `guide`, `staff_docs`, `settings`, `admin_mcp`, `setup`, `console`, `account_stages`,
  `memory`, `journeys`, `tips`, `client_skill`, `texts`, `pages`, `words`) the engine's; its `name`, `version` and
  `description` are the build's pack's;
- the engine's own `pack.json` says its code only (`host.entry`, `host.scripts`, `migrations`, `host.schema` without
  labels): a declaration, `host.profile` or table labels there are refused while a config pack configures it, as are
  two config packs for one engine, a config pack with code, migrations or any other file, and the config pack's keys
  (`engine.profile`, `labels`, `migrations_recorded_as`) in a pack that names no engine;
- the engine's code reads the product's name from the build's profile wherever a person reads it, and the ids a client
  or a stored row carries from its config (Octillion's: the widget's `ui://octillion/dashboard-v2.html`, the transcript
  format `octillion-jsonl`, the spans' `octillion.*` attributes); it reads the shell's environment names (`APP_*`, the
  spelling before mold_v0-045 as the fallback: `src/pack-host.ts` `env`) and persisted setting keys (`persistedKey`).
*Its migrations' earlier id* (`engine.migrations_recorded_as`). When a product's host pack split into an engine and
its config pack, the engine's migrations are the files the product's pack had, and a database that ran them recorded
them in `pack_schema_migrations` under the product's id. The config pack names that id; gen-packs writes it as the
engine's `formerly` in `src/pack-migrations.generated.ts`, and `src/migrate.ts` reads the rows under it as the engine's
(`packRows`): same names, same checksums (`host.schema.split` included), so nothing is pending and nothing runs, no DDL,
and the ledger is only read: the release from before the split (a rollback, or the one still serving during a rolling
deploy) still finds its rows under the id it knows, and a migration the engine adds later is recorded under the engine's
own id. No shell migration is needed. An earlier id that is the engine's own, or another pack's of the build with
migrations of its own, is refused (gen-packs, and the runner again). `npm run test:migrations` proves it on PGlite and
Postgres; `npm run db:rehearse` on a copy of a live database shows it (nothing pending, nothing applied).
Octillion is the first: `packs/octillion` is its `pack.json` alone (`engine.pack: "apo"`, `migrations_recorded_as:
"octillion"`), and `packs/apo` carries what its host pack carried (server, console pages, orchestrator extension,
operator scripts, the curated library under `vault/`, the two migrations byte for byte).

**Source offer and data map (mold_v0-050).** A pack's `upstream` pin (`{repo, commit, license}`, the licence an SPDX id)
is offered when its licence is copyleft (AGPL, GPL, LGPL, MPL, EUPL, ...): the customer MCP server adds a "Source code:"
paragraph to its instructions, and the root page and every install page end with a footer, each naming the project, its
licence and the exact commit's address (`src/source-offer.ts`); an agent kind that runs the same repository at another
commit is refused, so the commit offered is the one that runs. The build's own source is the profile's `source_offer`:
`{"app": {"url", "license"}}` offers it; `{"app": "licensor_exception"}` (the factory's LICENSE-EXCEPTION.md
permission covers whoever runs this deployment; the factory writes it from `defaults.source_offer`) offers no link and
says why; absent, the build says nothing about its own source. An upstream that is the app licensor's own project
(mold_v0-099) is named in the app's own `profile.json` as `"source_offer": {"upstreams": {"<pack id>": "licensor_owned"}}`
(only there: gen-packs refuses it in a host pack's profile, and refuses a pack id the build lacks or whose pack pins no
upstream): as its copyright holder the licensor need not offer that source, so the build leaves it out everywhere: no
MCP instructions line, no footer on the root, install or landing pages, no `source_code` in `/install.json`, no
`DATA-MAP.md` row. When no other upstream is left and the app's own source is not offered, `DATA-MAP.md` has no "Source
code" section at all (under `"app": "licensor_exception"` too: its sentence explains a missing offer, and nothing is
offered anywhere). A copyleft upstream not marked `licensor_owned` is offered exactly as before (the footers,
`/install.json` and the MCP line), so whoever runs a modified copy can still comply. `"app": "licensor_exception"` keeps
its meaning wherever something else is still offered. Without `upstreams`, nothing changes. With zero packs and no setting nothing changes. The
data-flow and residency statement (`src/data-map.ts`) maps, per pack, where the code runs, where data is stored, the
credentials by name, where model calls go and which hosts runs may reach, from the packs' declarations and the deploy
facts the factory writes into the build copy (`deploy-facts.json`, names and places only, checked by gen-packs); it is
`DATA-MAP.md` in the build copy (`scripts/data-map.ts`, checked by `check:data-map`). The console has no About page
(operator decision, mold_v0-099: an About page is not part of the mold; `/app/about`, `/admin/about`, `/api/about` and
`/api/admin/about` were removed with what only they showed, the running server's own measurements). Never a secret
value: names, providers, regions and hosts only.

**Landing page (mold_v0-091; pick and place, mold_v0-122).** The console's `/` is the build's landing page, declared,
not written: a pack's `pack.json` `landing` (a declarative pack's, or a host pack's since mold_v0-138) and the app's own
`profile.json` `landing` over it (at most one pack of a build declares one). The page is a list of sections the app picks from the shell's section library, in its own
order: `sections: [{"type": ...}]`. The library is the first product's landing page generalised: each section and each
drawing is a data-driven port of that page's own (its section wrapper, hero with its backdrop and logo strip, header,
footer and accordion of questions; the `visual` templates `decision_graph`, `transcript`, `loop`, `paths`, `scorecard`
and `chat`), so that page's own words reproduce it (`scripts/fixtures/landing-reference.json`, compared by screenshots).
The types: `hero` (eyebrow, headline and its highlighted end, subheadline, its call to action (by default the account
button) and a second call (by default "Early access"), and up to 3 links such as the app's docs (with `first_screen.calls`
1 only its one call; below), a note, a visual, and a `strip` of text names (set in the logo row's type),
named logos or the logos of the AI clients the install pages offer), `logos` (mold_v0-164: a row of organisations'
logos under a title (with none, right after the hero: the hero's foot, mold_v0-165), each item {name, logo, href}: `logo` an image file of the pack that declares the block,
`assets/<name>.svg` or `.png` of at most 30 KB, which gen-packs checks (a PNG by its signature; an SVG with no script,
event handler, foreign object, entity or link or load of anything but its own parts), measures and copies under its
content's hash to `web/public/landing/` (a file there no logo names is removed; `--check` calls it stale); the page
draws each in a light tile of one height with its size reserved, grey until pointed at or focused, its name as its text,
and an item with no file as its name; never in the wireframe, so an app has one only when it picks one), `problem` (icon points), `concept` (cards with a path of chips,
one highlighted), `how_it_works` (steps drawn as numbered cards, a flow, or a flow that loops back to its first step),
`proof` (metrics and/or a what-you-get list), `where_you_work` (the AI clients, from `src/connect-catalog.ts` and
`install_clients`), `faq` and `cta` (the only type a page may pick more than once); each but the hero and the cta may
carry a visual, its anchor, its navigation label (or `nav: false`), an eyebrow, a title and a lead. Each is drawn by the
shell from data: a pack brings words, never a page, a component or a picture. Beside the sections, `header` (at most 1
link, by default the page's other call, "Early access"; the ways in: one account button by default, or "Sign in" with
the start call only on a page with no hero and no link (`"sign_in_and_start"`); `sign_in` and `open` relabel or
re-address the account button's two states, "Sign in" to `/auth/sign-in` and "Open dashboard" to `/app` by default,
wherever the page shows it), `open_source` (mold_v0-164: `{repo: "https://github.com/<owner>/<repo>", label}`, an open-source app's
repository: a GitHub button in the header on every width, named "<name> on GitHub", 44 px, its mark drawn inline, and a
footer link, `label` or "Open source on GitHub", unless the footer already links it; the repository may not also be a
hero link. Every component only an open-source app has is configured under this key, so a later one, such as a star
count, joins it; an app without it has none of them), `footer` (a tagline, a note, links, a copyright line,
`shell_links: false`), `seo` (title and description for search results and Open Graph, and `card`, the X card's size,
`summary` or `summary_large_image` by default: the landing page's, and, since mold_v0-138, every public page's default
title, description and link preview; the share image is the build's, mold_v0-093) and
`request_page` (mold_v0-138, after the first product's early-access page: a public page asking for access at its own
one-segment `path`, such as `/early-access`, never one of the console's own: an eyebrow, a title and its highlighted
end, a lead, up to 6 `benefits` {icon, title, body}, its own `seo`, and its form in `form`: `submit`, `message_label`,
`fields` (the build's `access_request` fields it asks above its fold, by key; default every declared one not in the
fold), `more` {label, fields} (a fold holding the name, the message and those fields) and `done` {title, steps}, where
`{company}` and `{email}` are the sender's; gen-packs refuses a key the build does not declare and a required field the
page does not ask). `gen-packs.mjs` rewrites the request page's path to the shell's
`app/(site)/declared/[page]` (`src/config/pack-routes.generated.json`, which lists it under `declared` for the lanes'
`testing/console/surface.mts`), refusing a path a host pack's `routes.json` claims; the sitemap lists it. Its form
(`web/src/features/site/request-page-form.tsx`) asks the work email and the company first, then the build's fields,
checks the addresses before sending, posts to `POST /api/access-requests` like `/request-access`, and sends the visit's
first page as `source.landing` (the root layout's `VisitSource`, mold_v0-110). With no `sections` the page
is the whole wireframe in that order, in the shell's neutral words (through the build's words: `{product}`,
`{workspace}`, `{runs}`). A profile's `sections` replace a pack's; its `header`, `footer` and `seo` replace the pack's
one by one, as is its `request_page`. **The first screen (mold_v0-168: the operator's decision of 2026-10-28, the first product's buttons are every
app's default).** The header and the hero ask for two things, signing in and one other, each shown in both. Unless the
block says otherwise, the header has one link, "Early access" to the request page (`request_page.path`, else
`/request-access`), and the account button ("Sign in" to `/auth/sign-in`; "Open dashboard" to `/app` once signed in);
the hero has the same account button (with an arrow) and an outlined "Early access" to the same page. An open-source
app's GitHub icon (`open_source`) is not a call. A block's own hero call (a link as `primary_cta`, or a
`secondary_cta`) is the page's other call instead, and the header's default link follows it; `header.links: []` leaves
the header's link out. A call is where it leads (the sign-in's addresses `/app`, `/auth/sign-in` and the header's
`sign_in`; the start's `/auth/sign-up`, `/request-access` and the request page's path), so one shown in both the header
and the hero counts once, and a header link or hero call that would add a third is refused with a message that names
it and says what to do instead, at its path in the pack's block, an old block's or the app's profile, and again on the
page they make together (`firstScreenProblems`, run by gen-packs after merging; the shell draws the same page,
`twoCallPage` in `src/landing.ts` and `web/src/features/site/site-ctas.ts`). **One call (mold_v0-165), by choice:**
`first_screen: {"calls": 1}` makes the first screen ask for one thing, the hero's button, "Get started" unless the
block's `primary_cta` labels it. It leads to the start (sign-up, or `/request-access` while accounts are invite-only,
where "Already invited? Sign in" is) and, for someone already signed in, into the console (`/app`) under the same label
(`StartButton`, `web/src/features/site/account-links.tsx`: the label never flips). The header then asks for nothing,
signing in is always in the footer (even with `shell_links: false`), and a header link, `header.account: "account"`, a
hero's `secondary_cta` or a hero's `links` is refused. The install pages stay one click away: the footer's shell links (or the block's own
footer link), the where-you-work section's link and the console. A `logos` section with no title right after the hero
is drawn as the hero's foot (no heading, no divider, no band of its own; its `label` names the list for a screen
reader). At most 10 sections, each type once (three calls to action), the hero first, each anchor its own; every
value is plain text on one line, shown as text; a link is a path of this site, an https:// address or a mailto: address
(`src/landing.ts`, checked by `gen-packs.mjs`, which writes the result, the offered clients and the source offer's
footer items into `web/src/config/landing.generated.ts`). The old block (`hero`, `coverage`, `value_points`,
`how_it_works`, `features`, `faq`, `closing` at the top level) is still read and converted to sections at build time
(coverage becomes the hero's strip, value points the concept's cards, features proof's items, closing a cta), so a build
that declared one still builds; a block that mixes the two is refused. Every call to action comes from
`web/src/features/site/site-ctas.ts`, which knows who may open an account (mold_v0-098). A host pack that still names
a landing page in its console code (`index.ts`, mold_v0-039) keeps that page; the first product's moved to its
`pack.json` `landing` in mold_v0-138.

**Share image (mold_v0-093).** What a shared link to the build shows (Open Graph and X: `web/src/app/opengraph-image.tsx`
and `twitter-image.tsx`, one renderer in `web/src/features/site/share-image.tsx`) is the build's own, never another
product's picture: a 1200x630 PNG drawn when the console is built from the landing page's words (the hero's headline, else
the profile's tagline; its sub-headline, else the console's description unless it repeats the headline) beside the
profile's name, the build's mark (`web/src/app/icon.svg`, else the brand step's PNG icon) and its brand colour (the web
manifest's `theme_color`, which the brand step sets), in the font `next/og` carries (nothing is fetched). Its
alternative text is the same words. `gen-packs.mjs` writes the words and the text to
`web/src/config/share-image.generated.ts`. A brand that has its own picture (the factory's `branding.py <app_id>
share-image brands/<name>/<file>.png`, rules.json `share_image`: a 1200x630 PNG of at most 1 MB, recorded in the app's
state with its sha256) has it copied to `brand/share-image.png` in the build copy and embedded byte for byte, with the
console's description as its text; the routes then answer exactly those bytes. `npm run test:share-image` renders both.

**Upstream catalogs index themselves (mold_v0-128, mold_v0-129).** An upstream catalog is pinned to a commit, so its rows
are fixed by the build: the server indexes every one whose stored pin (`repository_index`, migration 0019) is not its
declared pin, with nobody pressing anything (`src/repository-index.ts`). Triggers: an instance's first request (in the
background, once per instance; kept alive past the answer on Vercel); the first unfiltered read of an empty catalog area
(`listPlatform`, which starts it and waits up to 8 s, then reads again); the deploy (`npm run catalogs:index`, run once by
the factory after its health checks: mold.json `catalogs`, `lib/single_service.py`; its summary line is printed and
recorded in infrastructure.json `catalog_index`, never a failed deploy); and staff (the admin MCP's
`admin_sync_<repository>` and the console's Index now, one code path, `indexNow`). One instance indexes a catalog at a
time: a ten-minute lease claimed in a short transaction under an advisory lock (a transaction-pooling proxy keeps it);
another instance finds it held and leaves it, and staff get 409 until it ends; an expired lease (an instance that died)
is taken over. The fetch is the adapter's (at the pin only, redirects refused, its timeouts), the whole index bounded by
8 minutes. A failure is recorded (the pin attempted, the error), the rows already there stay and are read, no request
fails; the automatic retry at the same pin waits 15 minutes (the deploy retries at once). A pack opts a catalog out with
`index: "manual"` (staff only). `APP_CATALOG_AUTOINDEX=off` turns the request triggers off (the offline tests do). The
admin console's **Data repositories** page (Operations, `/admin/repositories`, with a repository declared) lists each
repository: for a catalog its pin, the commit and time of its last index, the last attempt and who made it, the rows in
each area, the last error and Index now (the library permission; forcing a refused prune, the delete permission); Health
says when a catalog could not be indexed at its pin. `npm run test:catalog-index`. The audit app's catalogs at its pin
5f7e77e2 index 37 regulators and 826 controls (GitHub transport, about 36 s).

**Shell pages a build hides (mold_v0-130).** `console.hide` in a pack's pack.json or the app's profile.json (joined) names
shell pages of the customer console to leave out: `activity`, `usage`, `billing`, `profile`, `credentials`, `schedules`,
`notices`, `files`, `connected-apps`, `keys` (`src/console-pages.ts`; `keys`, mold_v0-171: the API keys page and the
sidebar footer's link, the keys already made still working). A hidden page leaves the /app sidebar (the shell's entries, the Workspace
and Activity groups, any declared tab that opens it), the tab pages and the customer guide's tab list, and its address
and everything under it redirect to /app (`pack-routes.generated.json`). The staff console and the API are unchanged.
`npm run test:console-hide`.

**Console sections shown from the start (mold_v0-171).** `console.show` in a pack's pack.json or the app's profile.json
(joined) names shell sections that otherwise appear only once they hold something: `experiments`, FinOps' Experiments
tab, shown with its empty state (how to start a pricing experiment) before the first exists (the admin MCP offers the
`pricing_experiment` skill either way). gen-packs writes `SHOWN_SECTIONS` into the console's build facts only when a
section is named, so a build without the setting is unchanged.

**The whole sidebar from config (mold_v0-133).** With declared tabs the /app sidebar is exactly the tabs, in their
groups and order (mold_v0-058), and the tab kinds now reach every shell page (`team`, `keys` beside `setup`, `usage`,
`billing`, `profile`...). The app's profile.json may declare the sidebar across its packs: `console.sidebar`, a list of
groups `{"label": "Company", "items": ["overview", "billing", "team"]}`, each item a pack's tab by id (`<pack>/<id>` when
two packs have it) or a shell page by kind (`setup`, `usage`, `billing`, `profile`, `team`, `keys`, `credentials`,
`schedules`, `notices`, `connected-apps`). Then the sidebar is exactly that; `gen-packs` refuses a tab left out, an entry that is neither
or is listed twice, a shell page a tab already opens, one the build lacks or hides, and `sidebar` in a pack.json (a pack
orders its own tabs). Without tabs or a declared sidebar the shell's own sidebar joins a pack's group to the shell group
of the same heading and lists each page once (`mergeNav`, `web/src/config/nav-config.ts`); a declared API keys entry
takes the footer's place. `npm run test:console-sidebar`.

**The active sidebar entry (mold_v0-213).** Each console lights exactly one entry for the page drawn
(`web/src/lib/active-nav.ts` `activeNavUrl`, used by `components/layout/app-sidebar.tsx` for the customer and the staff
console): the entry whose page it is, its query a subset of the page's (an in-page tab's `?tab=`, a filter's
`?overdue=1`, the home page's `?journey=`, Accounts' `?section=admins` keep their page's entry), else the longest entry
the page is under (`/admin/accounts/<slug>` under Accounts); the area's home only on itself, or, with no entry of its
own, the sidebar's first. A record's own page (`/app/records/<area>/<key>`) lights the tab that lists its area (its own
unfiltered tab first, then a filtered one, then one that merges it; an in-page tab's page), and a few pages outside the
sidebar light the page they are reached from (`PORTAL_HOMES`, `ADMIN_HOMES`: Journeys the home page, Connected apps
Profile, Schedules a tab sidebar's runs tab). The footer's API keys and Profile count as entries, lit only when the
groups have none of their own. A collapsible entry holding the active one opens on load, and the active entry stands
out: the brand's colour behind it and in its words, and a bar at its edge, in either theme, also in the phone's sheet.
`npm run test:console-sidebar` walks every console route of a tab build and of a zero-pack build (pages a build lacks
without a feature, and Docs, excepted) and asserts exactly one entry lit, the right one.

**Connected apps (mold_v0-087).** `/app/connected-apps`: each person's own AI apps signed in to `/mcp`. Under the built-in
sign-in (the server is the authorization server, mold_v0-013) it lists every connected app across the person's
workspaces (`GET /api/oauth/grants`: the app, a metadata-document client by its verified address and a registered one
marked not verified, the workspace it acts in, when it was allowed, when it was last used: at token issue and, at most
once a minute, on `/mcp`) with Revoke (a confirmation, then `POST /api/oauth/grants/<id>/revoke`: every token of it ends
on its next request). Under Clerk, Clerk is the authorization server and its Backend API has no list of a person's OAuth
consents or grants (checked against Clerk's OpenAPI specs, 2026-08-20: `/oauth_applications` lists the instance's apps,
`revoke_token` needs the token itself; the Frontend API's `/v1/me/oauth/consent/{client_id}` reads one app's scopes for a
consent screen), so the page says the connections are managed by the sign-in provider, links to the person's Account
Portal page (derived from the publishable key; else the profile) and says how to disconnect an app from the app. It is an
optional shell entry: in the shell's own sidebar (Operational), in a declared sidebar as `connected-apps`, hidden with
`console.hide`. Built-in OAuth also lets a refresh **narrow** its scope (RFC 6749 section 6, migration 0022): the access
token carries only the scopes asked for, the refresh token keeps its own, never wider (a refused scope leaves the
refresh token usable). `npm run test:mcp-oauth`,
`npm run test:connected-apps` (both sign-ins; `--browser` renders the page).

**Customer guide (mold_v0-106).** `/app/docs` and the docs answers' corpus (Ask AI, `src/docs-answers.ts`;
`scripts/sync-docs-corpus.ts` writes `src/docs-corpus.generated.json` from the same pages) come from the packs when no
host pack brings guide code. A declarative pack's `pack.json` `guide` holds its own pages: `markdown` (inline, one page
per `## ` heading; the only form since mold_v0-124, which took `dir` away: a pack is its pack.json alone, and `guide.dir`
is refused, saying to write the pages inline), `groups` (the navigation's groups, in order) and `generated` (false leaves out the pages written from the declarations).
Every page is markdown only, checked by `gen-packs.mjs` with `src/pack-guide.ts`: no raw HTML, scripts or images, no
control or invisible characters, and every link a path of this site, an #anchor, an https:// or a mailto: address
(never javascript:, data:, http: or //host); a page may not take a generated page's title. After a pack's own pages the
console writes pages from what the packs declare (`web/src/content/pack-guide.ts`, from the facts gen-packs writes into
`web/src/config/pack-guides.generated.ts` `PACK_GUIDE`): what the app does, getting started (connecting a client, the
onboarding steps with the prompt to type and the generated `get_started` tool), the console's tabs, the record areas
(fields, lifecycle, due dates, tools), the job kinds with their credentials and schedules, the MCP tools grouped by what
they reach, and the account; whatever a pack's `mcp` settings withhold is left out. So a pack with no guide of its own
still gets a real one. Base text writes the build's words (`{run}`, `{workspace}`, `{product}`). With zero packs the
guide is the shell's, byte for byte (`PACK_GUIDE` null). `guide.tool_groups` (mold_v0-139, `[{ title, tools }]`) puts a
pack's own groups of tools first on the MCP tools page (each tool in the order listed; one the build lacks is left out),
and `guide.prompts_intro` is the line before its slash commands' list, in the pack's words (default "Clients that support
MCP prompts also offer these:").

A **host pack's** `guide` (mold_v0-139; it was its console code, `web/src/packs/<id>/guide.ts`, now refused) is the
whole guide: its pages in its groups, nothing generated and no title reserved (`generated` is refused), written by
gen-packs into `pack-guides.generated.ts` `HOST_GUIDE` (`PACK_GUIDE` null; a declarative pack's guide beside it is
refused, as it would never show). Its page titled as the MCP tools page ("MCP tools" in the build's words) is followed by
the tools: its `tool_groups`, then "More tools", then the slash commands (one is added in Reference when it wrote none).

**Staff docs (mold_v0-139).** A pack's `pack.json` `staff_docs` (`src/staff-docs.ts`: `[{ path, title, markdown }]`,
inline; a host pack's `packs/<id>/docs/*.md` until then, now refused) join the shell's `docs/` on /admin/docs
(`web/scripts/sync-docs.mjs`) and in the docs answers' corpus (`scripts/sync-docs-corpus.ts`) as files at those paths
would: `# <title>`, a blank line, then the markdown. The markdown is checked with the guide's rules, except that HTML
is allowed (the renderer shows it as text) and so are relative links between docs (`journeys.md`, `../beta-guide.md`,
which /admin/docs opens as that doc); a path the shell's `docs/` or another pack already has is refused.
`npm run test:pack-guide`.
/admin/docs opens on the first doc of its Guides group (a guide or walkthrough, such as a pack's beta guide). When no
doc is one, it opens on the **staff guide** written from the build (mold_v0-170, `web/src/content/staff-guide.ts`, not a
file and not in the docs answers' corpus): "<product> staff guide", with what the product does (the first page of its
customer guide), letting people in, the sidebar's pages in order with what each is for, the shared record areas and
the daily checks, so staff never land on an engineering document; those stay below it under Architecture and Specs.

**A host pack's console, Setup page, settings and admin words (mold_v0-140, mold_v0-121).** What a host pack's code
used to hand the shell is its pack.json, checked by `gen-packs.mjs` (`src/pack-manifest.ts` for the shape) and carried to
the server as `src/hosts.generated.ts` `PACK_CONFIG` (`src/host.ts` `packConfigs`, `PackConfig`), written only when a pack
declares one, so a build without writes what it did:
- `console.nav` (a host pack's; it was `web/src/packs/<id>/nav.ts`): `{app: [...], admin: [...]}`, placements applied in
  order to the shell's sidebar groups (`web/src/features/packs/host-nav.ts` `placeNav`): a new group
  `{"label", "before"|"after": <a group's label>, "items"}` or entries put into a group `{"into": <its label>,
  "before"|"after": <an entry's url>, "items"}` (no anchor, or one the sidebar lacks: at the end); each item
  `{title, url, icon, shortcut?}` is one of the pack's own pages (its `routes.json`), an icon of the tabs' set, a shortcut
  (`g` then a key) once in its console. `console.components` names the shell's components its routes serve (`tips`,
  `journeys`, `research`: `src/console-pages.ts` `CONSOLE_COMPONENTS`; `hostFeature`). `console.redirects`
  (`[{source, destination, permanent}]`, any pack; they were `routes.json` `redirects`) are next.config redirects. The
  sign-up form's subtitle is the profile's `sign_up_subtitle` (a host pack's `host.profile` may set it; else
  short_description).
- `setup` (a host pack's, one per build; it replaced the `/api/app/setup` route in code): `steps` placed among the shell's
  (`after` a step, else last), each done when the person read a resource whose address starts with a prefix
  (`resource:ui://<ns>/`, a widget) or the account reached a session-engine stage (`stage:onboarded|simulated|reported`,
  only in a build with the engine); `optional` (not counted), `help_text_only` (its help when every client the person
  connected shows results as text), `prompt`, `launch` (someone who may not launch reads `viewer_note` instead);
  `shell_steps` (the shell's four steps in the product's words); `workflow` (`[{id, label, tools, prompt}]`: Setup's
  coverage and next group, the shell's Usage workflow, and `setupWorkflow()` in `src/pack-host.ts` for the pack's own
  pages). `mcp.error_hints` (`[{match, text}]`, any pack) gives each recent error on Setup the first fix whose pattern
  (a regular expression, any case) its text matches.
- `settings` (any pack; they were the host entry's `settings`): `groups` placed after a named group and `defs`, pure-data
  settings (`SettingDef`) before a named setting or at their group's end (`src/settings.ts`); a group or key twice, a
  shell group, a setting in no group are refused at build, a key the shell has when the settings are read.
- `admin_mcp` (any pack; they were the host entry's `adminMcp.reword` and `skills`): `reword` gives a shell admin tool
  its description and its summary line as a template filled with the result's fields (`src/text-template.ts`
  `summaryValues`: `{account_name}`, `{members_count}`); `skills` replaces exact passages of a shell skill's text
  (`[{from, to}]`, in pack order). The skills' texts are `src/admin-skills.ts` (no imports), so the build refuses a `from`
  the skill no longer reads, and a tool or skill the shell lacks.
- `account_stages` (mold_v0-121; the host pack that owns the session engine's tables must declare it): each engine stage's
  label, next step and Analytics funnel label, the next step after the first tool call, and the needs-attention messages
  ("Product onboarding failed" and the rest were the shell's words), filled with the build's words; the console reads them
  from `build-facts.generated.ts` `ENGINE_WORDS`.
- `texts` (mold_v0-141; any pack): the shell's texts in the product's words, by id (`src/shell-texts.ts`; see "The
  vocabulary"), and a host pack's `host.schema.labels` (table -> its Storage page label).
`npm run test:host-config`; `npm run test:admin-sections` in a build with the engine.

**Account context and memory (mold_v0-142).** A component of the shell any app turns on from its pack.json `memory` (one
pack's per build; `src/account-context.ts`, `src/account-context-tools.ts`, `src/account-context-words.ts`); off, nothing
of it is served and the MCP surface is exactly the shell's. What it keeps, in the shell's own tables
(`sql/migrations/0025_account_context_memory.sql`): the company's context (`account_context`: what it does, who it
serves, names it tracks, its terms, notes for the AI client; the account's owners edit it), each person's own
(`user_context`: role, focus, interests, answer style, notes; the person, or an owner) and memory (`context_memories`:
short items, a fact, decision, preference or note, about the company, one person, or one subject, scope `product`).
- `scopes` (`company`, `user`, `product`: whose memory there is), each a page of `/app/context` (`company`, `users`,
  `products`; `web/src/app/app/context/[[...section]]`, `web/src/features/context`), with `/app/context` leading to the
  page its `?tab=` names (a page, an old name, a scope or `me`), else the first; `pages.titles` and `pages.aliases` (old
  page names kept working: Octillion's `you`). The pages show the memory list, add, edit and remove (by role: viewers
  read, members add company and subject items and their own, owners anyone's), search, import (CSV or JSON, beyond the
  portal's 16 kB body limit) and export. With no pack placing them in its `console.nav`, a Context sidebar group.
- At connect time `/mcp` appends to the server's instructions the company's and the person's context, the answer style's
  hint and the latest memory (company 20, the person's 10, their focus subject's 10): `connectContext` in `src/http.ts`,
  then a host pack's own `mcp.context` hook. Every line is a word of `memory.words` (`MEMORY_WORDS`: neutral defaults;
  `{value}`, `{account}` filled once), the hints `memory.answer_styles`.
- `tools` `{save, search}` names its two MCP tools, registered right after the host packs' tools and before every pack's
  (reserved like a host pack's names): save one item (`edit` permission; scope `company`, `me` or `product`, a subject by
  key, name or id, else the person's focus, else the only one, else asked), and search (the company's, the person's own,
  the subjects'; never another person's; every word must appear). Their titles, descriptions, status lines and argument
  texts are `tool_words`, the `_meta` both carry `tool_meta` (Octillion's: its dashboard widget; the MCP Apps legacy key
  beside `ui.resourceUri` is added). Answers: a summary line, then the structured result `{view: "memory", ...}`.
- Host hooks (`src/host.ts`): `context.subjects(orgId)` lists what the `product` scope names (Octillion: the account's
  products, by name), which keys a subject's memory, names it in lists, checks a person's focus and resolves the save
  tool's subject; without it any name is kept as written. `mcp.decorate(org, tool, result)` adds to the shell tools'
  answers (Octillion's in-chat tip until mold_v0-143, now the shell's tips component's own). `src/pack-host.ts` `accountContext` gives a host pack the company's context (its
  research prompt starts from it).
- **The tables, adopted.** They were a host pack's (Octillion's 0001, and before mold_v0-049 the shell's base schema).
  0025 makes them with exactly those statements and the same row-level security; `src/migrate.ts`
  `ADOPTING_MIGRATIONS` records it as adopted, running nothing, on a database that has all three in the shape it gives
  (`tableShape`: columns, constraints, indexes, RLS, policies, the tenant role's grants; independent of the server's
  version and the tenant role's name), with a row in the ledger `schema_adoptions` (what, from what, the shape's sha256);
  runs it where none is; refuses some of them or another shape, changing nothing. The host pack's migrations that made
  them are rewritten without them and keep their earlier checksums (pack.json `host.schema.split`).
  `src/migration-rehearsal.ts` and `npm run db:rehearse` say what applying the pending migrations does to a database copy:
  catalog rows by object id and the transaction that wrote them (no DDL reached a table whose stamps are equal), rows,
  every relation created, changed or dropped, and check:rls. The factory's `provision.py <app> --rehearse-migrations`
  runs it on a Neon branch of the live database and deletes the branch.
`npm run test:context-memory` (the declarative fixture `scripts/fixtures/packs/fixture_memory`: on, off, refusals),
`npm run test:migrations` (fresh, pre-049 and post-049 host-pack databases adopt, rows and catalog rows untouched).

**Journeys and tips (mold_v0-143).** Two more components of the shell, each turned on from one pack's pack.json
(`journeys`, `tips`; `src/journeys.ts`, `src/tips.ts`, `src/journeys-words.ts`, `web/src/features/journeys`); off, nothing
of them is served (no route, no page, no tip on an answer) and the MCP surface is exactly the shell's. They were the first
product's host pack's (`server/playbooks.ts`, `server/journeys.ts`, its /app/journeys and /admin/journeys pages); its
pack keeps only their config. Every text is a word: the journeys' nouns are the shell texts `journeys.one` and
`journeys.many` (side `both` since this ticket: the server's refusals use them too), the rest `journeys.words` and
`tips.words` over neutral defaults, with `{guide}`, `{guides}`, `{Guide}`, `{Guides}` and `{product}` filled.
- **Journeys** (`journeys`): step-by-step pipelines a customer replicates in their AI client, one prompt at a time. The
  pack's built-in ones (`templates`) are seeded once each through a ledger (`journey_seed`: one an admin deleted stays
  deleted, one untouched follows the pack when its stages change, one edited is left alone; `seeded_before_ledger` for a
  database seeded before the ledger) and promoted; admins write more on `/admin/journeys` (`library` permission; delete:
  `delete`), promote and order them, and see each one's adoption across accounts (started, finished, median time, where
  most stop). A stage is done when one of its tools (the build's own: the host packs', the memory component's and,
  mold_v0-175, the declarative packs' generated ones) ran
  successfully for the account after the previous stage was done, or an /app page's action that does the same
  (`recordPageAction`); a stage with no tool is marked by hand. Progress is kept once (`journey_progress`) and sent as
  events once each. Placeholders in a stage (`{product}`, `{competitor}`: whatever the templates use) are filled per
  account by the host hook `journeys.values(orgId)`; without it they read as written. Customers see them on /app Setup
  (the picker, the shell's) and on `/app/journeys`. **Every build has journeys** (mold_v0-175): the picker on the home
  page always offers "Get set up" first, the setup steps themselves (the shell's and the packs' onboarding steps, its
  progress theirs), so a build without the component (zero packs) shows the picker with Get set up alone and serves
  nothing else of it; a pack adds its own journeys with `journeys.templates` (the audit app: eight, JSON only). On
  `/app/journeys`: each use case person by person (how far, calls, errors, where stuck,
  who can help), help requests between teammates (ask, pick up, hand back, close), their own use cases (add, import JSON
  or CSV beyond the 16 kB body limit, export, remove). `launch` names the tools and Setup workflow groups that start work:
  a viewer sees the Setup page's viewer note instead of their prompts. Routes: `/api/app/journeys`, `/api/app/adoption`,
  `/api/admin/onboarding/playbooks`.
- **Tips** (`tips`): a workflow tool's webhook (`/api/journeys/nudges`, `APP_JOURNEY_SECRET` as a Bearer header or in the
  path) or an admin (`journeys` permission, on `/admin/journeys` and from `/admin/accounts`) queues a tip for an account
  or one person; it is appended to the next tool answer of the build (the memory tools here, a host pack's own through
  `src/pack-host.ts` `withTip`) at most once per `APP_NUDGE_INTERVAL_HOURS` (or `tips.interval_hours`, default 20) and
  three times in all, always after the tools `always_after` names, and listed on /app Setup with dismiss and a mute;
  `recipes` are the sequences to build in the workflow tool, shown with ready-to-paste webhook bodies. Routes:
  `/api/app/nudges`, `/api/admin/onboarding/journeys`.
- `labels` names their tables on the Storage page (listed only where each is on). The pages' sidebar entries are the
  pack's `console.nav` (`/app/journeys`, `/admin/journeys` count as its own pages where it turns them on), else an
  Engagement group; `console.components` no longer names `tips` or `journeys` (refused: they are config now), and
  `/app/journeys` and `/admin/journeys` are the shell's pages (a host pack's route there is refused).
- **The tables, adopted.** `0026_journeys_and_tips` makes the six with the host pack's statements and rules and is
  adopted, running nothing, where a database has them in its shape, from any release (before 0024, at 0024 or at 0025);
  `secured_after: 3` runs it on a database whose 0003 secured them in the same run (it never had row-level security
  before); the host pack's migrations rewritten again keep both earlier checksums (`host.schema.split` as a list).
  `sql/rollback/0026_journeys_and_tips.sql` keeps adopted tables as they are. `npm run db:rehearse` and the factory's
  `--rehearse-migrations` cover it with the rest of `ADOPTING_MIGRATIONS`.
`npm run test:journeys-tips` (the declarative fixture `scripts/fixtures/packs/fixture_journeys`: on, off, refusals),
`npm run test:migrations` (0026 adopted from 0023, 0024 and 0025, from every pre-049 start, refusals, rollbacks).

**Declared row maps and config-only packs (mold_v0-123, mold_v0-124).** An app pack on mold_v0 is config only (the
operator's rule): its `pack.json` alone, and (mold_v0-164) its landing page's images under `assets/` (`<name>.svg` or
`.png`, one folder deep, with a `sources.json` saying where each came from: `mold.json` `packs.declarative.files`, and
gen-packs, which checks each one the page names; "Landing page" above). A repository's `map` (`src/pack-api.ts` `RowMapSchema`, read by
`src/data-repositories.ts`) says, with no code, what a pack's loader used to:
- a field's value is a value path (`a.b`, `a[0]`: a list's first item) or a **computed value**
  `{value, only?, matches?, max_length?, as?}`: the values at `value` (a value path that may also take every item of a
  list: `a[]`, `a[].b`), kept when they are of kind `only` (`text`, not empty; `number`; `key`, a record key; `list`;
  `boolean`) and match the bounded pattern `matches` (text only), text cut to `max_length` characters (1 to 20,000), then
  `as` `first` (the default for a path with no `[]`) or `list` (all of them, none when there are none: the default for
  a path with `[]`). `{any: [{value, only?, matches?}, ...]}` (1 to 10 tests) is true when any test finds a value, else
  false. A value that does not fit is no value, never an error;
- `where` takes, beside an equal text, number or true/false, a test `{only?, matches?}`; `$.x` reads the document's
  root (for a file of lines, the line itself, whatever `each` walks);
- for a `workspace_files` `path` (a file of lines; the validator refuses them anywhere else, an API's map included):
  `retires`, a value path naming the key of an EARLIER row a line ends (only with `append_only`: one naming its own key
  is its new version; a key retired comes back with a later line; a value that is not text is ignored), and
  `only_latest` `{by, among?}`: only the lines whose `by` value (text compared as text, numbers as numbers) is the
  greatest among the lines that match `among` (a `where`), e.g. the points of the latest measurement; no line matches
  `among`: no rows. The last line of a key still wins among them.

A **bounded pattern** (`src/safe-pattern.ts`, checked when the build reads pack.json and again when it is compiled)
can never take long on any text: at most 200 characters, Unicode rules; literals, `.`, `^`, `$`, classes (`[a-z0-9_-]`,
`[^/]`), `\d \D \w \W \s \S` and escaped punctuation, alternation, groups `( )` and `(?: )` (nested at most 4 deep), and
`? * + {n} {n,} {n,m}` (at most 1,000); never a lookaround, backreference, named group, lazy or stacked repetition, word
boundary, property or code-point escape, or control character; a group is never repeated (only `?`, on a group with no
repetition inside: a repeated group is what takes exponential time); the product of the repetitions' ranges (an
unbounded one counted as 1,000) is at most 2,000, so one test is at most a few tens of milliseconds on the worst text;
and the text tested is at most 1,000 characters (longer text never matches). `npm run test:row-maps` proves each
operator (taken, refused, the limits and the worst case's time).

The factory holds an app's pack to it (`packs.py check`, from `mold.json` `packs.declarative`): a pack that is not one of
`host_packs` adds `packs/<id>/pack.json` and nothing else, and its pack.json may not name `entry`, `migrations` or
`runner`; each refusal names the declaration to write instead (a row map, `record_areas`, `guide.markdown`). gen-packs
says the same of a pack with no entry, migrations or runner (a declarative pack): any file beside its pack.json is
refused. The shell keeps its code seam (`entry`, `loaders`, `migrations`, `runner`) for its own fixtures and other molds'
packs; a host pack (`octillion`) keeps its code. `npm run test:pack-guide` and `packs.py --self-test` prove the refusals.

**Access-request fields (mold_v0-102).** What the request form asks besides the shell's own fields (a work email, a
name, the company, a message, and where the person came from) is declared, never the shell's: `access_request.fields` in
a pack's pack.json (the packs' joined in pack order, a key once in a build) or in the app's `profile.json`, which then
replaces the packs' (a host pack's `host.profile` may not set it). Each field is a `key` (lowercase letters, digits and
`_`, never `email`, `name`, `company`, `message` or `source`), a `label`, a `type` (`text`, `long_text`, `url`, `email`,
`select`, `multi_select`), optionally `required`, `options` (`{value, label}`, a select's only), `max_length`, `help`,
`placeholder`, `person` (mold_v0-171: a `text` or `select` answer that says who the requester is, such as a role,
shown beside their name in the Requests list, "DevRel · sam@…", and on the request's Person line); at most 20. The rules are `src/access-request.ts`, pure and shared: `gen-packs.mjs` checks the blocks
with it and writes the build's fields to `src/access-request.generated.ts` and `web/src/config/access-request.generated.ts`
(and copies the rules to `web/src/lib/access-request.generated.ts`), never into the profile modules, so the MCP surface
is unchanged. The public `/request-access` form and the portal's page for no account (mold_v0-098) ask the fields after
the company; `POST /api/access-requests` checks the answers (a required one empty, an option not offered, an address
that is not one, an answer over its length: 400 naming the label; an address without a scheme gets https://), reads a
declared key at the top level of the request too (a host pack's own flat form), drops a key nobody declared, and stores
them as `access_requests.answers` (jsonb, `sql/migrations/0020_access_request_answers.sql`). The staff console's Requests
page shows each answer under its label (an option by its label; the first `url` field as the site under the company and
"Open <label>" in the menu), `list_access_requests` names them by label, and the operator's alert email lists them.
The first product's own questions were columns of the table (product URL, role, team size, agents, docs, competitors,
goal, timeline, heard from, sub-industry): the migration copies a row's values into its answers under the same keys and
leaves the columns, which nothing in the shell writes any more (the host pack's research still reads them until it reads
`answers`). With zero packs the form asks the shell's fields only and a request stores no answer.
`npm run test:access-request` (`--browser` adds the console: the form's fields in order, sent and stored, and the
Requests page's labels, axe-graded). **Not covered:** the request's own acknowledgement text is still the shell's.

**Legal and crawl pages (mold_v0-109).** The app's own `profile.json` `legal` (`company_name`, `contact_email`,
`effective_date` YYYY-MM-DD; optionally `jurisdiction`, and `terms_url` and `privacy_url`, the company's own https://
pages, which then win) turns on the console's `/terms` and `/privacy`: the shell's neutral template
(`web/src/features/site/legal-text.ts`) in the build's words (`{product}`, `{account}`, `{runs}`... through
`web/src/lib/vocabulary.ts`) with the company's facts placed as text after the words are filled, so nothing a profile
writes is read as a placeholder; a paragraph needing a fact the profile leaves out (the jurisdiction) is not shown. The
landing page's footer, the sign-in, sign-up and consent pages (`AuthShell`) and the install pages (`src/install-pages.ts`)
link Terms and Privacy. Without `legal` there are no such pages (404) and no links: the shell never publishes terms
nobody agreed to. The rules are `src/legal.ts` (plain text on one line with no markup or brackets, one address, a date
that exists, own pages https:// only), checked by `gen-packs.mjs`, which writes the block to `src/legal.generated.ts` and
`web/src/config/legal.generated.ts`, never into the profile modules (the MCP surface is unchanged); a host pack's
profile may not set it. `web/src/app/robots.ts` lets crawlers read the public pages and keeps them out of `/app`,
`/admin`, `/api` and `/auth`; `web/src/app/sitemap.ts` lists the landing page, `/install`, the landing block's request
page when there is one (mold_v0-138) and the legal pages the console serves itself (`web/src/features/site/public-pages.ts`; `npm run test:legal` fails when a public page under
`web/src/app/(site)` is not listed). Both are on the console's own address, read when asked (`web/src/lib/site-url.ts`:
`APP_CONSOLE_URL`, else `NEXT_PUBLIC_APP_URL`, else Vercel's production address, which is the custom domain once one is
attached), as are the icons' and share image's absolute URLs. The factory's intake asks a new app for the company (the
brief's `## Profile` `legal.*` lines, or one question; `later` leaves the pages off; docs/INTAKE.md). The lanes grade
`/terms` and `/privacy` only when the build serves them (`testing/console/surface.mts`).

**Developer surface (mold_v0-193; an app of kind `embedded`).** On in a build where one pack's pack.json declares
`developer_surface` (`src/developer-config.ts`: `events`, `sdk_languages`, `client_sessions` {ttl_seconds,
allowed_origins, scopes}, optional `webhooks_in` and `api_version`; checked by `gen-packs.mjs` against the build's record
areas, one pack's per build, carried to the server as `PACK_CONFIG`). The factory writes it there from the app spec
(`mint.py new --spec`: the spec's `developer_surface` into the first inline pack; docs/APP_SPEC.md). Off, in every
`kind: tool` app, nothing of it is mounted, read or queued: no `/v1`, no `/openapi.json`, no `/api/developer`, the MCP
surface unchanged (`npm run test:developer-surface` step 1; the zero-pack MCP hash is unchanged). What it gives:

- **The API** (`src/developer-api.ts`, `/v1`): every record area's list (cursor pages), get, create, replace, move,
  delete and `/v1/batch` through the generic data API (the record store's rules), runs (start, list with a keyset
  cursor, get, results, cancel), client sessions, allowed origins, webhook endpoints and deliveries, inbound sources.
  Errors are `application/problem+json` (`type` `/problems/<code>`, `title`, `status`, `detail`, `code`, `request_id`);
  `API-Version` (dated, `API_VERSIONS`; a key is pinned to the version current when it was made); `Idempotency-Key` on
  writes (24 hours, per credential, the first answer replayed byte for byte with `Idempotent-Replayed: true`, another
  request with the key 422); rate limits per key (or client session) and per workspace a minute (the MCP front door's
  numbers, `src/rate-limits.ts`), 429 with `Retry-After`.
- **The description** (`src/developer-openapi.ts`, `/openapi.json`): OpenAPI 3.1 generated from the pack contract (each
  area's paths and typed schemas: enums, references, lifecycle states; shared and repository-fed areas read only;
  withheld operations left out; job kinds; the declared events as OpenAPI `webhooks`), each operation with `x-sdk`
  {group, method}. Checks (mold_v0-196) are record areas of role check today and appear as such. The customer guide gets
  a Developers group from it (`src/developer-docs.ts`, written by gen-packs into `PACK_GUIDE`, so `/app/docs` and the
  docs answers' corpus carry it).
- **SDKs** (`npm run gen:sdks`, `scripts/gen-sdks.ts`, `scripts/lib/sdk-gen.ts`): from the build or a running server's
  `/openapi.json`, into `dist/sdk/` (git-ignored): one JavaScript/TypeScript package (ESM with its `.d.ts`, no build step
  or dependency) and one Python package (standard library, TypedDicts), each sending an Idempotency-Key per write and
  retrying safely, errors as `ApiError` with the problem's `code`; when a check buckets (mold_v0-226), both carry the
  server's bucket function (`bucket`, `inRollout`/`in_rollout`; "Declarative checks"). `--publish-dry-run` shows what `npm pack` and the
  Python package would hold; publishing is the operator's own step with their yes, never from here.
- **Keys** (`src/developer-keys.ts`, `developer_keys`): a workspace's keys for its own servers, made by its owners on
  `/api/developer/keys` (`src/developer-routes.ts`): `sk_`, shown once (the sha256 kept, and the first 9 characters to
  tell keys apart), scopes (`read`, `write`, `run`, `sessions`, `webhooks`, and `checks` since mold_v0-196, narrowable to a check; the first three narrowable to an area or kind:
  `read:<area>`), an expiry or none, revocation, rotation (the old key kept for a grace of 0 to 168 hours, 24 by default),
  integration keys holding exactly one scope. Never accepted on `/mcp` (the MCP keys, `oct_`, are unchanged). Per request:
  `X-Scope` narrows to fewer scopes; `X-Actor` (keys only) names the backend's signed-in user the call is for, recorded
  as the actor on the platform audit hook and on the events the call causes.
- **Client sessions** (`src/developer-sessions.ts`): `cs_` tokens a backend mints with a key holding `sessions`
  (`POST /v1/client_sessions` {subject, scopes, ttl_seconds}): at most the app's ttl and session scopes (`read`, `write`,
  `run` and, since mold_v0-224, `checks`, each narrowable: `checks:<name>` asks one check from a page) and never beyond
  the minting key's; the subject is the actor; revocable, and dead with their key. A browser calls only from an origin
  allowed for the session's workspace (the app's `allowed_origins` and the workspace's own, `/v1/allowed_origins`);
  a key sent with an `Origin` is refused (`secret_key_in_browser`).
- **Webhooks out** (`src/developer-webhooks.ts`, Standard Webhooks): endpoints with a `whsec_` signing secret (sealed with
  the workspace's data key; answered when made or rotated; read again only through the audited reveal, counted on the
  endpoint and handed to the audit hook; a rotation signs with both secrets for its grace). Events: record created,
  updated, state changed and deleted (`src/record-areas.ts` `onRecordChangeInTransaction`; a sealed or asset area's
  events carry its key only), `run.finished` (a trigger on `runs`, in the transaction that ends the run: `src/runs.ts`
  untouched), `clock.overdue` (`src/record-clocks.ts` calls `emitEvent` in the transaction that records a clock as
  overdue, once per record, clock and deadline) and the test ping.
- **Event outbox** (mold_v0-202, `sql/migrations/0036_event_outbox.sql`): every event is written to `event_outbox` in
  the same database transaction as the change it tells of (`app_event_outbox_put`, the tenant's own workspace only), so
  a change rolled back has no event and a crash right after the commit loses none. A single record write becomes a
  transaction of its own only when the build declares a record event for its area; nothing is written in a tool build
  or for a workspace with no enabled endpoint that takes the event. The scheduler's step (`relayOutbox`: the server's
  15-second loop, Vercel's cron entry `/api/cron/autoscale`, and at once after each commit) queues each pending event
  once per endpoint and marks it relayed in the same transaction (claimed with `SKIP LOCKED`: schedulers running at
  once never share an event); a failed relay is retried after 5 s, doubling, at most an hour; relayed rows go after
  30 days. `npm run test:event-outbox` proves it with real processes (a writer killed between commit and enqueue, three
  schedulers at once on Postgres with `OUTBOX_PG_URL`). Rollback: `sql/rollback/0036_event_outbox.sql` (queues what
  is still pending first).
- Each delivery is POSTed signed within 15 seconds, no redirect, never to a private address (a preview server also
  takes localhost); retried after 5 s, 5 min, 30 min, 2, 5, 10 and 10 h with every attempt in its log; an endpoint whose
  last 30 attempts failed is disabled until enabled again. A server ticks every 15 seconds; Vercel's cron ticks it.
- **Webhooks in** (`src/developer-inbound.ts`): a workspace adds a source for a pack-declared receiver and gets its
  address (`/v1/inbound/<id>`) and secret; a payload verified by its Standard Webhooks signature (5 minutes' tolerance)
  is written into the receiver's workspace area, one record per item (JSON Pointers for key, title and fields), as one
  batch, once per `webhook-id`.
- **The audit hook** (`src/developer-audit.ts`): every API request (credential, actor, scopes, status, request id) and
  every key and secret action is handed to `setPlatformAuditSink`, which the platform audit trail (mold_v0-197)
  registers; without it nothing is written.
- **The console** (mold_v0-201, `web/src/features/developer`; Settings tabs since mold_v0-219): only in an embedded
  app, its four parts are **Settings tabs** (below, "Features registry"): API keys and Allowed origins in Access, Webhooks
  and Integrations (the inbound sources) in Connections. The old `/app/developers` page and its Developers sidebar entry
  are gone, with no redirect (`developerConsole` in `pack-nav.generated.ts` still says whether it is on). Each tab is the
  console's database table (RecordView): **API keys** (made with a name, a scopes picker narrowing read, write and run to an
  area or kind, an expiry, secret or integration; shown once in a dialog with Copy; then only the prefix; Rotate with a
  grace, Revoke), **Webhooks** (add with the events picked; a row's peek edits the address and events, reveals the signing
  secret (recorded), rotates it, sends a test ping and offers Enable again after an automatic disable; below the table the
  endpoint's delivery log: status, attempts, answer and next retry, four numbers with the last two weeks' sparklines, and a
  delivery's peek with every attempt and its payload, any credential-named field masked), **Allowed origins** (the app's
  and the workspace's; add, remove) and **Inbound webhooks** (only with `webhooks_in`: add a source, its address and secret
  shown once, the last 24 hours' deliveries from `GET /api/developer/sources/:id/deliveries`; the Integrations tab). Every role reads; every
  change is an owner's (`manage`), the buttons disabled with the role they need for anyone else. Proof: `npm run
  test:developer-console` (offline: the sidebar and route in an embedded, a tool and a zero-pack build; the helpers; the
  page's shape).

Tables: `sql/migrations/0033_developer_surface.sql` (all platform bookkeeping per workspace, closed to the tenant role;
`check:rls` and `check:tenant-sql` know them; rollback `sql/rollback/0033_developer_surface.sql`). Proof: `npm run
test:developer-surface` (offline) and `npm run test:developer-e2e` (the fixture pack `scripts/fixtures/packs/
fixture_embedded` over a running dev server: a key, OpenAPI read from the server, both SDKs generated and called, a
client session, an idempotent write replayed, signed webhooks verified with the Standard Webhooks reference libraries in
JavaScript and Python; it fetches those libraries once).

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
- **`["octillion", "apo"]` reproduces today's product.** A build of the new shell plus `packs/octillion` (since mold_v0-145
  its config pack, with the engine pack `packs/apo`: "Engine packs and config packs") has the same surface as the old pin: the same MCP tools with the same schemas (the list `scripts/export-mcp-tools.ts` writes), the same HTTP
  routes, the same console pages and navigation, and the same tables. The surface diff between the two must be empty,
  and the re-mint (mold_v0-029) must still pass smoke, `mcp:check` and the isolation sweep (mold_v0-039).

## Features registry (mold_v0-219)

One on/off flag for every optional capability of the shell, in **one registry**, `codebase/src/features.json`, read by
the server's gates (`src/features.ts`, `src/feature-flags.ts`), the build (`scripts/gen-packs.mjs`, which writes
`web/src/config/features.generated.ts` for the console), the factory (`.claude/scripts/lib/features.py`: the app spec's
`features`, the brief's `features.<flag> = true|false` lines, `factory.py spec check` and `spec apps`) and the factory
board. The app sets them in `profile.json` `features`, `{"<flag>": true|false}`.

A capability is **on** only when something **asks for it** (a pack's declaration; the audit toggles always) **and** its
flag is not `false`. Each flag's default keeps every existing app as it was: on where the capability was on whenever a
pack declared it, off for the opt-in profile toggles. The legacy keys (`audit.data`, `audit.platform`, `audit.sign`,
`onprem_runners`) still read and must agree with `features` (the build refuses a contradiction).

| Flag | Default | Asked for by | Gates (off: none of it) |
|---|---|---|---|
| `customer_key_vault` | on | a pack's `credentials` | Settings › Credentials; `/api/credentials`, `/api/credential-connections`, `/api/github-app`. Refused off while a job kind needs a credential that is not optional |
| `company_email` | on | a pack's `email` (sender.allow or intake) | Settings › Email; `/api/email`; the intake job and tools; Health's Email Delivery |
| `scheduled_alerts` | on | a due-date area, or clocks (with `record_clocks`) | due-date notices and emails; clock reminders and escalation steps; `/api/notices`, Notices; Settings › Alerts |
| `record_clocks` | on | a workspace area's `clocks` | the clock check job, the records' `clocks`/`due`, clock columns, the Due soon card, `list_due_records`; a metric or tab counting by a clock is refused off |
| `audit.data` | off | always | the data trail (Billing's Access log, `/api/audit/data`, `read_audit_trail`) |
| `audit.platform` | off | always | the platform trail (`/admin/access-log`, `/api/audit/platform`, `read_platform_trail`) |
| `audit.sign` | off | always; needs `audit.data` or `audit.platform` (refused alone) | checkpoints, `/api/ledger`, `/.well-known/ledger-keys.json`, `verify_audit_trail`; Settings › Signing |
| `onprem_runners` | off | a kind with `private_network: true` | `/api/runners`, `/api/runner`, the runners section, staff's Runners tab |
| `developer_surface` | on | a pack's `developer_surface` (the spec's `kind: embedded`) | `/v1`, `/openapi.json`, the outbox and webhook jobs; Settings › API keys, Allowed origins, Webhooks, Integrations; Health's Webhook Delivery |
| `declarative_checks` | on | a pack's `checks` | `/api/checks`, `/v1/checks`, `check_<name>` |
| `encrypted_fields` | on | an `encrypted: true` field | reveal routes and tools, the migration job. Refused off while a field is encrypted (never stored in the clear) |
| `health_history` | on | a build without the session engine | the `health_samples` job and its history (Status's graphs) |
| `document_preview` | on | a `file` field, or a field with `preview: "document"` | the record file card routes (`/api/records/<area>/<key>/files[/...]`) and the console's document cards |
| `agent_harness` | off | always (the profile alone) | the workspace agent (mold_v0-243, below): `/api/agent`, staff's `/api/admin/onboarding/agent`, the worker's `/agent/*` steps, the agent MCP tools, the top bar's agent icon, `/app/agent` and `/admin/agent`, the "Workspace agent" settings, the built-in run kind and the sweep. `quiet_off`: while off it is left out of the generated files |
| `record_pages` | off | an area's page layout (`detail`) or a `copyable` field | the laid-out record page (mold_v0-253, below): header, badges, facts, notices, tabs of sections, copy buttons; mold_v0-254: related lists, a record's runs, the header's actions and `/api/records/_page`. `quiet_off`: while off the generated files leave it, the layouts and `copyable` out |

**`kind` stays the developer surface's switch** in the app spec: `kind: embedded` with its `developer_surface` block asks
for it; `features.developer_surface` may only repeat what `kind` says (the spec check refuses true with `tool` or false
with `embedded`); in a build the flag false turns a declared surface off. The spec's completeness rules add: `audit.sign`
needs `audit.data` or `audit.platform`; `developer_surface` needs `audit.platform`.

**Settings, from the registry.** Each capability that is on contributes its Settings tabs, in four fixed groups:
**Access** (Credentials, API keys, Allowed origins), **Connections** (Email, Webhooks, Integrations), **Automation**
(Alerts), **Data & trust** (Signing), each followed by the packs' own: a workspace record area declared
`"settings": {"group": "automation", "label": "Escalation contacts"}` is a Settings tab of that group (its standard record
table) instead of an entry in Records (never also a sidebar tab). Billing stays under Operational. The sidebar follows the
tab count (`web/src/config/settings.ts`): **0** no Settings entry (Octillion); **1** one entry, `/app/settings` that table
alone with no strip; **2 to 5** one entry directly below Overview, one in-page strip (the audit app: Credentials | Email); **past
5** a collapsible Settings entry with one item per group that has a tab, each `/app/settings/<group>` (`access`,
`connections`, `automation`, `data-trust`) with its own strip. A tab is `?tab=<id>` on its page, the page's first bare
(`/app/settings?tab=email`, `/app/settings/connections?tab=webhooks`); `/app/settings?tab=<id>` always works (past 5 it
leads to the tab's group page). Every tab is the standard full-area table (cards, search row with its primary action,
table, full card). **Alerts** lists, read only from the packs' declarations, each due date and clock step: when, who is
told, what else it does. **Signing** lists the workspace's signed checkpoints (`GET /api/ledger/checkpoints`, owners) with
the public key, and Verify now.

Proof: `npm run test:features` (the registry; zero packs; a fixture asking for every capability with each flag turned:
its routes, tools and jobs go or come and nothing else changes; the same per flag in build copies for the console's
pages, sidebar and Settings tabs; the refusals), `npm run test:console-sidebar` (0, 1, 2 to 5 and past 5 tabs; a 9-tab
build grouped; every Settings page lights its group's entry), `npm run test:developer-console`, `npm run test:zero-pack`
(the zero-pack MCP surface stays `4e3e14917286b00c`).

## Workspace agent (mold_v0-243)

A long-lived agent a person talks to, run through a harness, with full steering: the design note
[docs/agent-harness.md](docs/agent-harness.md) maps each piece of the reference's approach to its home here and lists what
is not copied. **Off by default** (`features.agent_harness`): off, nothing below exists, the zero-pack MCP surface stays
`4e3e14917286b00c`, and the generated files are what they were (the flag is `quiet_off`: left out of
`features.generated.ts`, and its two pages out of `console-routes.generated.json`, so the proxy answers them not found).

- **A session is a row, each wake a run.** `harness_sessions` (migration 0044; named apart from the session engine's own
  `agent_sessions`) holds a conversation or a task: its state, the policy frozen at its start (harness, model, provider,
  limits, web tools, the resolved hooks), its budget and spend, the harness's session id and its last checkpoint. Each
  wake is a run of the built-in kind `_agent/session` (`runner: "agent-harness"`, `src/agent-harness-config.ts`), so the
  run engine's lease, deadline, per-attempt gateway token, budget refusal, run sandboxes (boat, docker), on-premises
  runners and limits apply unchanged. `runnableKinds()` adds it for claims and the sandboxes' demand only; `jobKinds()`
  never lists it (no schedule, start tool, developer API or Compute row sees it).
- **The harness** (`src/agent-harness.ts`, dispatched from `run-harness.ts` for its runner): the pinned `claude-code` run
  tool with stream-json on an **open stdin** (`--input-format stream-json --replay-user-messages`): the first turn is one
  line, each message the person sends while it works one more (steer), echoed back as the CLI takes it in. It beats every
  few seconds (`POST /api/worker/runs/:id/agent/beat`: the lease, its cumulative spend, the person's messages, pause, end,
  budget), checks each tool call against the session's policy (a host or a tool not allowed becomes a request and the wake
  stops with SIGTERM so the CLI keeps its session), parks a quiet conversation (or one past its wake's cap) by closing
  stdin, ends a task once its work is answered (the stdin ledger), and checkpoints the CLI's session files and its
  working directory (sealed with the workspace's key in the object store, `workspaces/org-<id>/.agent/<session>/`).
- **Steering** (`src/harness-sessions.ts`, through `/api/agent`, the MCP tools and the console): message (mid-run, or a
  wake), pause / resume / stop, approve / decline (a web host or a tool: exactly that, for that session), raise budget (a
  reason, the role, under the ceiling, never while it works, recorded in `harness_budget_grants`). Only the person who
  started a session messages or resumes it; the starter or an owner pauses, stops and decides; billing managers and
  owners raise; staff see every workspace's, pause, stop, raise and decline, never message or approve.
- **Crash recovery and parking.** A wake that ends without saying how (its runner went silent: the lease sweep; or the
  CLI died) parks the session with its unanswered messages pending again; the next message continues it on the same
  harness session, or, with `AGENT_AUTO_RESUME` on, it continues by itself, at most `AGENT_CRASH_RESUMES` in a row and
  not once crashes have spent half its budget. A crash's silent window is held back from the next wake (`reserve_usd`).
- **Spend once per session.** Per wake the greater of the gateway's meter and the harness's own cumulative reports,
  accrued over a high-water mark from a baseline that takes out what a resumed session re-reports (`min(saved, charged)`).
- **Budgets.** The session's budget (setting, at most the ceiling, at most the platform's `runs.budget_usd_max`) less what
  it spent is each wake's `budget_usd`; the kind's month budget per workspace is `AGENT_MONTH_BUDGET_USD`; the account's
  allowance applies as for every run.
- **Retention.** The sweep (scheduler job `harness_sessions`) expires requests past `AGENT_APPROVAL_WINDOW_HOURS`, archives
  sessions quiet for `AGENT_ARCHIVE_AFTER_DAYS`, and past `AGENT_RETENTION_DAYS` after a session ended removes its
  messages, requests and checkpoint; its spend, wakes and budget raises stay.
- **Platform settings** (group "Workspace agent" in `src/settings.ts`, listed only with the flag on): harness, provider,
  model, budget per session, raise ceiling, month budget per workspace, sessions at once, turns per wake, longest wake, park
  after, task idle close, checkpoint interval, request window, crash resumes, automatic resume, retention, archive, web tools,
  web hosts, web calls, workspace tools used without asking, the named ones, workspace context size (mold_v0-250). Each has plain words; the staff Agent configuration page, `list_settings` and `update_setting` show
  and change them; every change is kept in `platform_setting_changes` (key, before, after, who, when) beside the staff
  log's `settings.save` line.
- **The console.** The top bar's last item, after Search, Docs and the theme switcher, is one icon button
  (`aria-label="Workspace agent"`) opening `/app/agent` (staff `/admin/agent`) as a full page: four cards, the search row
  with Start a session, the table; a session opens as the list's full card (`?session=<id>`) with its transcript, the
  composer, the request's card (Approve / Decline, or Raise budget), Pause, Resume and Stop (stop asks once more in place).
  While a session waits for a decision its state line shows no reason of its own: the request's card says what it
  asked for (mold_v0-245). **Start a session opens as a modal dialog** (mold_v0-249, the operator's one exception to the
  console's full-card rule): the first message, the model (shown; staff set it), the budget (the setting's, lower if the
  person likes, up to the ceiling for a billing manager or owner: `budget_usd` on `POST /api/agent`), the kind, an
  optional title, Start; focus held inside, Esc closes it, its title names it; on Start the session's full card opens.
- **What a session reaches** (mold_v0-250, `src/harness-reach.ts`; [docs/agent-harness.md](docs/agent-harness.md) "What a
  session reaches"): the app's own customer MCP server as the MCP server `app` (tools `mcp__app__<tool>`), opened by a token per wake
  (`hst_...`, hashed in `harness_session_tokens`, migration 0048) that acts as the person who started the session with
  their role (re-read on every call), for that workspace only, and works only while its wake runs: revoked when the wake
  ends, at a pause or stop, at budget, when the session ends, and refused once the person leaves the workspace. Reads
  (`readOnlyHint`) are used without asking; the rest become `tool` approval requests (what the call wanted to send shown
  with it), and `/mcp` refuses them too. Setting `AGENT_WORKSPACE_TOOLS` (reads, reads and named
  `AGENT_WORKSPACE_TOOLS_NAMED`, all) is frozen at the start. The server's instructions and the company's and person's
  context and memory join the standing instructions, cut to `AGENT_CONTEXT_MAX_CHARS`. The session card's "How this
  session runs" lists who it acts as, the tools it uses freely, those that ask first, and the context's parts with
  their sizes; no internal id.
- **The agent's icon** (mold_v0-252). The top-bar button is the shared outline button (no styling of its own) with an
  18 px icon, centred, named "Workspace agent"; the agent pages' heading (the top bar's trail, its last crumb: the
  console's list pages have no title above their cards) shows the same icon. In order: the workspace's own, the app's, the default (`web/src/components/layout/agent-icon.tsx`).
  - *The app's*: its brand (`branding.py <app> set --agent-icon <file>` or `--agent-icon-name <name>` from the console's
    icon set, Tabler's outline icons; `--agent-icon-dark <file>`; the app spec's `product.agent_icon`). `prepare` writes
    `web/public/agent-icon/{light,dark}.{svg,png}` and `profile.json` `agent_icon` `{light, dark, mask}`
    ([branding/rules.json](branding/rules.json) `agent_icon`); `scripts/gen-packs.mjs` checks the files and writes the
    field into the console's profile module only, so an app without one builds exactly what it built before. An SVG is
    sanitised and, drawn in one colour, redrawn in currentColor (painted as a mask in the text colour, light and dark); a
    picture is fitted inside 64 px and shipped as a PNG, never wrapped in an SVG.
  - *A workspace's own*: Settings › Workspace agent (a Settings tab of group Automation, only with the flag on): the two
    icons in play as the standard full-area table, Upload icon (an owner's) and Reset to the app's icon. `GET /api/agent/icon`
    (any person of the workspace), `PUT` (an owner; the bytes as `application/octet-stream`, at most 256 KB) and `DELETE`
    (an owner) in `src/agent-routes.ts`; `src/agent-icon.ts` checks the bytes by what they are: an SVG through the same
    allowlist as the factory's (no script, handler, foreignObject, style sheet, picture, outside link, DOCTYPE or entity),
    a PNG decoded, trimmed, fitted inside 64 px and re-encoded (nothing of the file but its pixels kept), a JPG or WebP
    only at most 64 px a side (the console resizes every picture to a 64 px PNG before it sends it). Kept sealed with the
    workspace's data key at `workspaces/org-<id>/.agent-icon/icon.wse`, bound to the workspace (a copy under another
    workspace's prefix does not open), gone with the workspace. Staff consoles show the app's.

Proof: `npm run test:agent-harness` (offline, with a stand-in CLI that speaks the harness's stream-json,
`scripts/fixtures/agent-cli/cli.mjs`), `npm run test:agent-icon` (mold_v0-252: the upload's checks, a malicious SVG
sanitised, an oversized file refused, owners only, workspace B never seeing A's), `npm run test:features`,
`npm run test:zero-pack`, `python3 .claude/scripts/branding.py --self-test` (the brand's agent icon). One real session was measured
once on the example app's lane copy (mold_v0-245, [docs/agent-harness.md](docs/agent-harness.md) "A real session"): the
pinned Claude Code, steered mid-turn, parked, restored from its checkpoint, coherent, and its spend against the
provider's usage.

## Audit trails (mold_v0-197)

Two toggles in the app's profile, each **off unless the app turns it on** (`profile.json` `audit`; the factory's
`application.json` `profile.audit`, checked by `lib/app_profile.py audit_problems`, app-settable in
[branding/rules.json](branding/rules.json); the app spec's `audit.data` and `audit.platform`):

```json
"audit": { "data": true, "platform": false, "retention_days": 400, "platform_retention_days": 400 }
```

- **`data`, the company's data trail.** Every list, read, reveal, export, create, update, move and delete of a
  workspace's records (record areas' workspace rows, files in the workspace store, run results), through the console,
  the API, MCP, a run (the worker API: the run is the actor), staff (the admin MCP: their activity-log pseudonym), or the
  system (a repository's index: one entry per index, not per row). Each entry: actor (kind and id, the key's id), action,
  target, pack, area or store, the record's key or the file's path, how many rows, when, and the door (console, api,
  mcp, admin_console, admin_mcp, run, system). A list or an export is **one entry per page or file, never one per row**,
  and an entry never holds a field's value or a title; a sealed area's read is a `reveal`; a batch's entries are written
  only when it commits. Per workspace under row-level security: the workspace's owners read it on Billing's
  **Access log** tab (`/app/billing?tab=access-log`, mold_v0-209; Download CSV), `GET /api/audit/data[.csv]`, and the
  MCP tool `read_audit_trail` (owners and account keys only); platform staff through `/admin/access-log` and the admin
  MCP's `read_audit_trail` (by slug).
- **`platform`, the platform usage trail.** Every API and MCP request (`/mcp` with its methods and tool names, never
  arguments) and sign-in (the built-in code check and Google's return, the MCP authorization server's token grants):
  the key's id (its prefix joined on read, never the key), the actor, the scopes it acted with (workspace key, member key
  and role, sign-in and role, session and role), the result code and latency; plus **staff actions on an account**: every
  `/api/admin` request (the account by the slug in its path) and every admin MCP tool call (the account its `slug`
  names). The operator reads it fleet-wide (`/admin/access-log`, `GET /api/admin/audit/platform[.csv]`, admin MCP
  `read_platform_trail`); a workspace's owners read their slice (`GET /api/audit/platform[.csv]`, the Access log's
  Requests tab, `read_audit_trail` with `trail: platform`), staff shown as their pseudonym and without addresses.
  The worker API (runs) and cron are machine traffic, not entries.
- **Retention.** `retention_days` (default 400) for the data trail, `platform_retention_days` (default the same) for
  the platform trail: pruned 5,000 rows a trail per call, hourly on a server and after each Vercel cron tick (`/api/cron/autoscale`).
- **Separate from usage metering.** `mcp_events`, `compute_events` and `run_events` are unchanged (billing, analytics,
  the factory board's `run_spend.py` and `app_usage.py`).
- **Off** (the default): nothing is written (not even a sequence row), no route is mounted, no console page or sidebar
  entry shows, and no MCP or admin MCP tool is listed: the zero-pack MCP surface stays `4e3e14917286b00c`.
- **One writer, append-only, numbered** (for chain-and-sign, mold_v0-195): `src/audit-trail.ts` is the only module that
  writes the tables (`sql/migrations/0031_audit_trails.sql`: `audit_data_events`, `audit_platform_events`,
  `audit_sequences`). Entries queue in memory and are written in one transaction per flush (every 200 ms, at 200 entries,
  at the end of each request; kept alive past the answer on Vercel), each workspace's numbered by a monotonic, gapless
  per-workspace sequence taken under its row's lock (commit order). A trigger refuses every UPDATE and every DELETE but
  the retention prune's (`app.audit_prune`) and a removed workspace's cascade; tenant work may only SELECT its own rows.
  The hooks are one call each in the existing paths (`src/record-areas.ts` listFor/getFor/writeRow/deleteWorkspace and
  batches, `src/record-export.ts`, `src/runs.ts` results, `src/workspace-files.ts`, `src/http.ts` the middleware and the
  MCP caller, `src/builtin-auth.ts` sessions, `src/admin-mcp.ts` staff tools). Rollback:
  `sql/rollback/0031_audit_trails.sql` (refuses while entries exist unless `app.audit_rollback_drop` is on).

- **The Access log is the records pages' table** (mold_v0-205): each trail is a read-only system area (no pack
  declares it; its fields typed as an area's are) drawn by `RecordTableView` (`web/src/features/records/record-pages.tsx`,
  what every record area's page and tab draws) through its data adapter (`RecordSource`: rows from the trail's own
  route, Download CSV in place of Export CSV, the record column as the entry's time). So it has everything an area's
  page has: the trail's four cards above the search row (mold_v0-208) (`GET /api/audit/<trail>/sparklines`, staff
  `/api/admin/audit/platform/sparklines` and `/api/admin/audit/data/<workspace>/sparklines`, `src/audit-trail.ts`
  `trailSparklines`: this week's entries, changes, exports and reveals, people and keys; or requests, sign-ins, refused
  or failed, average latency; each with twelve weeks, counts only), filters on who, action, area, door and the date
  range, the column picker (the entry's kind, pack, actor kind and key on request), sort, a pager and a row drawer with
  the entry's details. /admin/access-log is the same table (the platform trail fleet-wide; a workspace's data trail by
  its slug). Owners only, never a value, each workspace's own rows under row-level security, as before.
- **The customers' Access log is Billing's 4th tab** (mold_v0-209): Billing's in-page tabs are People, Teams, Budget
  rules (admins) and **Access log**, each held in `?tab=` (`/app/billing?tab=access-log`; People, the first, has none).
  The tab shows only where the profile turns `audit.data` on, and only to the workspace's owners (anyone else asking for
  it gets People); no title above the strip, the same `RecordTableView` page as before (with both trails on, its Data
  access / Requests switch above the table). The separate page and its sidebar entry are gone: the old address is
  the normal not-found page, no redirect, and nothing links to it. The staff `/admin/access-log` is unchanged (its own
  sidebar entry under Security; the staff guide says what it is for). Proof: `npm run test:record-pages` (section 7).
- **Settings: Credentials and Email in one page** (mold_v0-218): the customer console's one **Settings** entry sits
  directly below Overview (the console's home `/app`, or a pack's overview tab; else first), whatever the sidebar is
  made of (the shell's, the packs' tabs or the profile's: a pack's `credentials` tab and a declared sidebar's
  `credentials` both open it and leave their own place for it, their roles kept; `web/src/config/nav-config.ts`
  `withSettings`). `/app/settings` has the in-page tabs **Credentials | Email** (`?tab=`, Credentials the default; no
  title above the strip): Credentials when a pack declares a credential field or a kind that needs the workspace's
  private network (and the build does not hide `credentials`: `console.hide` names the tab,
  `/app/settings?tab=credentials`), Email when a pack declares `email`; one alone is its table with no strip; neither,
  and there is no entry and the page is not found (gen-packs `settingsPage`, `web/src/lib/console-routes.ts` SHOWN).
  Each tab is the standard list, full page: four cards, the search row, the table. **Credentials**
  (`web/src/features/credentials/credentials-tab.tsx`): cards Set, Missing, Required missing, Changed in the last 7
  days; a row per credential field (pasted or connected through OAuth), the GitHub connection and the on-premises runner
  (each when the build has it): name, what it is for, bound to (workspace, each record of an area, or per environment),
  status in words (Set, Missing, Optional), last changed and by whom; a row opens its full details card with Set,
  Replace, Clear, Connect, Disconnect, Install and the runners' Add and Revoke, as before. Values stay write-only (owners
  see a value's last 4 characters in its card, nothing more). **Email** (`web/src/features/email/email-tab.tsx`, owners;
  anyone else reads that an owner sets it up): cards Mailboxes, Messages taken in, With an error, Sender (On, Off, Not
  set); a row for the sender and each mailbox: provider, the address the workspace gave, the folder or label, status,
  last checked, messages taken in, last error; the search row's **Add mailbox** and **Set sender** (until one is set;
  mold_v0-217's `ToolbarAction`) open the shell's full card in the list's place (`ActionCard`, `CardForm`); a row's card holds On, Test, the form, Remove or Disconnect. The old
  `/app/credentials` and `/app/settings/email` are gone with no redirect (the normal not-found page), as are their
  sidebar entries; the OAuth and GitHub returns, the MCP get-started step, the guides and the console lead to
  `/app/settings?tab=credentials`; a pack's link to the mailbox setting is `/app/settings?tab=email`. Proof: `npm run
  test:record-pages` (section 9), `test:console-sidebar`, `test:console-tabs`.
- **Action and Actor columns** (mold_v0-209): both trails' tables (Billing's tab and `/admin/access-log`) show **Action**
  (what was done: a data entry's list, read, reveal, export, create, update, move or delete; a platform entry's read,
  change, delete, tool call, MCP request, sign-in or check, from its kind, method and path) and **Actor** (who did it:
  User, Key, Staff, Agent run or System, with the person, staff's pseudonym, the key's prefix or number, or the run's
  id), where the platform trail had Kind and Who. The server words both (`src/audit-trail.ts` `actorLabel`,
  `platformAction`) on every entry it returns (`action`, `actor`), so the table, its filters and sort, the row drawer,
  the MCP tool's answer and the CSV (`seq,at,action,actor,…` for the data trail, `seq,at,workspace,action,actor,…` for
  the platform trail; the raw actor kind and id follow) read the same words. Proof: `npm run test:audit-trail`.

Proof: `npm run test:audit-trail` (gen-packs' check of the setting; both off, each alone, both on; tenant isolation by
route, MCP tool and the tenant role; no value in either trail; one entry per list; a 250-operation batch in at most two
INSERTs and a refused batch in none; staff through the admin API and MCP; a built-in sign-in; append-only; retention),
`npm run check:rls` (the probe: a workspace sees none of another's entries and cannot write, change or remove its own),
`npm run test:migrations` (0031 and its rollback).

## Declarative checks (mold_v0-196)

A pack names yes/no questions its own records answer, in pack.json `checks` (or `definePack({ checks })`), with no
code: `src/check-spec.ts` (the declaration and its build checks), `src/check-eval.ts` (the condition evaluator, pure),
`src/checks.ts` (reading the records and answering). No migration and no table: answers are read from the record areas.

```json
"checks": [{ "name": "may_send", "inputs": { "subject": "string", "topic": "string", "at": "datetime?" },
  "rule": { "area": "permissions_given", "match": { "subject": "$subject", "topic": "$topic" }, "latest_by": "recorded_at",
            "require": [{ "field": "status", "eq": "given" }, { "field": "expires_at", "gt": "$at|now" }] },
  "explain": true }]
```

- **Inputs** by name and type (`string`, `number`, `boolean`, `date`, `datetime`; `?` optional). Anything else is
  refused (400), and the workspace is never an input: it is the caller's.
- **Rule.** `area` (any area of the build, not one read live from an API); `match` (equality, or set membership for a
  list, on fields or `key`: literals or required inputs; at least one); `latest_by` (a date or number field or
  `updated_at`: the latest matching record alone decides, latest-record-wins); without it any matching record meeting
  `require` says yes. `lookup` (one level): a record of a second area by `key` or `match` (`latest_by` optional), its
  fields read as `<as>.<field>`. `require`: a list (all of) or `{all}`, `{any}`, `{not}` of `{field, op: value}`,
  op one of `eq`, `ne`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte` (numbers and dates), `within` (`{last|next: "30d",
  of?}`), `exists`, `has` (a list field). Values: literals, `$input`, `$input|now`, `now`, `now-30d`, `@field`,
  `@<as>.field`; `$$` starts a literal `$`. An absent optional input makes its condition fail (closed).
- **Percentage bucketing** (mold_v0-226): a condition `{"bucket": {"input": "$subject", "salt": "$name", "percent":
  "@share"}}`. The bucket is SHA-256 of the UTF-8 text `<salt>:<input>`, its first 4 bytes read as a big-endian
  unsigned 32-bit integer, mod 10000 (`src/check-spec.ts` `bucketOf`); it holds when that is below
  `floor(percent x 100 + 0.5)`. `input` is a string input or a text field; `salt` a literal, a string input or a text
  field (default the check's name); `percent` a number 0 to 100, a number input or a number field. Stable across runs,
  machines and languages: 0 holds for no one, 100 for everyone, a larger percent keeps everyone a smaller one held, two
  salts bucket independently. An absent input, salt or percent fails closed; the explanation shows the bucket and the
  threshold. The SDKs ask the server for answers (they never evaluate a check), and when a check buckets they carry
  the same function for the client's own use: `bucket(input, salt)` and `inRollout` / `in_rollout(input, salt,
  percent)` (`scripts/lib/sdk-gen.ts`, the document's `x-sdk.bucketing`).
- **A fallback across areas** (mold_v0-226): `"rule": {"first_of": [step, step]}` (2 to 4 steps, each a rule as above).
  The first step whose latest matching record exists, and meets the step's `when` when it has one, decides with its
  `require`; a step with no such record passes to the next; the last step decides when none before it did. For "this
  subject's own record in area A if a current one exists, else the latest record of area B":

  ```json
  "rule": { "first_of": [
    { "area": "<area_a>", "match": { "subject": "$subject", "item": "$item" }, "latest_by": "recorded_at",
      "when": [{ "any": [{ "field": "until", "exists": false }, { "field": "until", "gt": "now" }] }],
      "require": [{ "field": "enabled", "eq": true }] },
    { "area": "<area_b>", "match": { "item": "$item" }, "latest_by": "recorded_at",
      "require": [{ "field": "enabled", "eq": true },
                  { "bucket": { "input": "$subject", "salt": "$item", "percent": "@share" } }] } ] }
  ```

  The answer's reason says why each earlier step passed ("no ... record matches", "... does not apply: ...") and what
  decided; the explanation adds `decided_by_area` and `steps` (each area with `decided`, `no_record`,
  `not_applicable` and its `when` conditions, or `not_reached`), the deciding step's conditions as before;
  `record_refs` are the deciding step's records. `GET /api/checks` lists a fallback's areas (`first_of`), the MCP
  tool's description names each, and `checkHints()` gives one index hint per step.
- **Refused at build** (gen-packs and `installPacks`, `checksProblems`): unknown areas, fields and inputs; type
  mismatches (an input or literal against its field, an enum value not an option, an operator a type does not take);
  unbounded scans (an empty match, or one resting on an optional input); `latest_by` not a date or number; a lookup
  named like a field or of a workspace area from a shared one; an any-record rule the database cannot find by itself
  (groups, lookups, `not_in`, field-to-field comparisons, buckets need `latest_by`); a name twice; a `check_<name>`
  tool name taken; a bucket whose input is a literal or not text, whose salt is not text, whose percent is not a
  number from 0 to 100 (or a number input or field); a `first_of` of fewer than 2 or more than 4 steps, a step before
  the last without `latest_by`, a `when` on the last step or outside a `first_of`, and each step's own areas, fields and
  inputs as above.
- **Answers.** `POST /api/checks/<name>` (the console's session with `X-Pack-Request` on a cookie, or an MCP key `oct_`),
  `GET /api/checks`; `POST /v1/checks/<name>` and `GET /v1/checks` on the developer surface (mold_v0-193) with a key
  or client session holding `checks` or `checks:<name>` (a client session never beyond its key; `/openapi.json` and
  the SDKs list each check). A client session holds a check scope only when `developer_surface.client_sessions.scopes`
  allows it (mold_v0-224): `read`, `write`, `run` or `checks`, each maybe narrowed, one pattern for the pack schema,
  the app spec's schema and the runtime (`src/developer-config.ts` `SESSION_SCOPE_PATTERN`); the build refuses a
  `checks:<name>` naming no check of the build (and `read:<area>`/`write:<area>` naming no area, `run:<kind>` no kind),
  and minting refuses one too; the MCP tool `check_<name>` (read-only). Each returns `{check, allowed, reason,
  record_refs, explanation?}`; the explanation (unless `explain: false`) lists every condition evaluated (field, op,
  expected, actual, passed, in words) and `decided_by`, the ones that decided it, plus the index hint.
- **Safety.** Records are read only through the record store for the caller's workspace (`listFor`/`getFor`: row-level
  security, the area's read permission for the caller's role, sealed areas opened with the workspace's key, the data
  trail's one entry per read), so another workspace's records never answer. Nothing mounted and no tool listed with no
  check (the zero-pack MCP surface stays `4e3e14917286b00c`).
- **Onboarding** (mold_v0-225): a step `done_when: "tool:check_<name>"` (or `how`) names the check's tool and is
  accepted with the check (refused without it). It is done once that check was answered for the workspace by any
  door: the MCP tool's call is recorded as every tool call is; an answer at `/api/checks` or `/v1/checks` is recorded
  once per workspace and check as an `mcp_events` row `check/answer` under the tool's name (`recordCheckAnswered`:
  never an input, a value or the outcome; a refused question is no answer). The admin funnel reads it the same way.
- **Audit.** With `audit.platform` on, each answer is one platform-trail entry (`method` CHECK, `path`
  `/checks/<name> allowed|denied`, the asker, the latency): never an input or a value (`src/audit-trail.ts`
  `auditCheckAnswer`).
- **Speed.** The latest rule is one `ORDER BY <latest_by> DESC LIMIT 1` query within the workspace's area rows (the
  records' (org_id, pack, area, key) index; `key` in a match is that index alone); an any-record rule pushes its
  conditions into the query (dates widened by a day each side, the evaluator decides) and reads at most 20.
  `checkIndexHint` (the build's hint, `checkHints()`) names how and suggests the expression index for a large area;
  the shell adds no per-app index.

Proof: `npm run test:checks` (the fixture `scripts/fixtures/packs/fixture_checks`: granted, withdrawn, expired,
latest-wins both ways, a lookup, an any-record rule, a cross-workspace attempt denied at every door; property tests on
the evaluator; 44 refused declarations; scopes on keys and client sessions; the audit entry; a median answer of about
12 ms over 3,000 records on the embedded database; mold_v0-226: a fallback whose first area decides when a current
record exists, allowing or denying, and passes when it is expired or absent, with each step explained; bucketing equal
to an independent SHA-256 in Python and to both SDKs' copies, uniform within 3% over 100,000 ids, each percent within
half a point, 0% and 100% exact; the answers recorded once for onboarding), `npm run test:developer-surface` (a client
session holding `checks:<name>` asks that check from a browser and nothing else; the schema, the build and minting
agree), `npm run test:onboarding` (a step `tool:check_<name>`, done by an answer at an HTTP door or the MCP tool).

## Chain and sign (mold_v0-195)

The audit trails' entries, and the records of a pack's record area declared `"append_only": true, "chain": true`, are
**hash-chained in the database**, and with `profile.json` `audit.sign: true` (default `false`; the app spec's
`audit.sign`, the brief line `audit.sign = true`) **signed** in checkpoints with a key the database never sees:

```json
"audit": { "data": true, "sign": true, "checkpoint_minutes": 60 }
```

- **The chain** (`sql/migrations/0035_ledger_chain.sql`; found by name, so a renumbering keeps its tests): per workspace
  and stream (`data`, `platform`, `records:<pack>/<area>`; scope 0: the platform's own entries) every entry's
  `hash = sha256(prev_hash || canonical entry)`, 32 zero bytes before the first. The canonical entry is each field as
  `<bytes>:<text>;` (a null `~;`), led by `ledger/v1` and the stream's kind, times as whole microseconds since 1970
  (`app_ledger_canon`, `app_ledger_fields_*`). A trigger computes it on every INSERT under the stream's head row's lock
  (`ledger_heads`, platform-only) and checks a hash or `prev_hash` a writer sends rather than trusting it; an entry numbered
  at or behind the head is refused. Entries written before the migration are chained once, in sequence order. Always on
  where entries are written (it costs one head update per entry); off-by-default trails still write nothing.
- **Chained records**: `append_only` (workspace areas of the shell's own tables; no lifecycle, no repository) makes the
  record store refuse every change and delete (409); `chain` (which needs `append_only`) makes the database refuse them
  too (a removed workspace's cascade aside), numbers the area's records per workspace (`chain_seq`) and chains them
  (`workspace_records.chained`, `prev_hash`, `hash`); an unchained write to a chained area is refused.
- **Signed checkpoints** (`src/ledger.ts`; the scheduler's tick, every minute on a server, the cron on Vercel): every
  stream with entries after its last checkpoint, and none signed in the last `checkpoint_minutes` (5 to 1440, default
  60), gets one: the window's entries (at most 10,000; a long stream catches up window by window) recomputed from their
  values and checked to continue from the last checkpoint, then the RFC 6962 Merkle root of their hashes, the window's
  last hash and the previous checkpoint's hash in a statement (`ledger-checkpoint/v1`) signed with Ed25519
  (`ledger_checkpoints`, append-only, per workspace under row-level security). **A tampered window is refused, never
  certified**: nothing is written and the scheduler logs why.
- **The key**: `APP_LEDGER_SIGNING_KEY` in the app's environment (a 32-byte seed, hex or base64, or a PKCS#8 PEM), set by
  name. The factory makes it (mold_v0-227, `mold.json` `profile_secrets`): its check and the keys station require it while
  `audit.sign` is on, `provision.py <app> --generate-secret APP_LEDGER_SIGNING_KEY` makes one on the factory machine,
  writes it to the target and prints only its public half (`--rotate` replaces it, keeping the old public key in
  `APP_LEDGER_PUBLIC_KEYS`), and a server's first deploy makes it when the server lacks it (the compose file hands both
  names to the API). By hand: `npm run ledger:keygen -- --out <file>` makes one and prints only its public half, then
  `--set-secret`. Never printed, never sent to the database: a key the database role can read (a database
  or role setting, a Key vault provider serving that name) is refused and nothing is signed. Its public key, and retired
  ones (`APP_LEDGER_PUBLIC_KEYS`), are published at **`/.well-known/ledger-keys.json`**.
- **Verify**: a workspace's owners, `GET /api/ledger/verify[?stream=]` and the MCP tool `verify_audit_trail`: ok, or the
  first bad sequence number and why (an entry whose values no longer give its hash, a broken link, a gap, a checkpoint
  whose signature, link or Merkle root does not hold). The operator, offline and read-only:
  `provision.py <app> --operator verify-ledger [-- --json] [-- --scope <slug>] [-- --keys <file|url>] [-- --export <file>]`
  (`scripts/operator/verify-ledger.ts`, its own read-only transaction, the published public key only), and
  `python3 scripts/operator/verify_ledger.py <bundle> --public-key <key>` (cryptography or PyNaCl) on its export.
- **What it proves**: a superuser who turns the triggers off and rewrites entries with a chain that is consistent again
  (heads too) is caught by the signed Merkle root of every checkpoint that covered them; entries after the last checkpoint
  are protected by the chain only until the next one. Retention prunes old entries: their checkpoints stay, and a window
  pruned at its start is checked by its last hash.
- **Off** (`audit.sign` false, the default): no route, no well-known keys, no MCP tool, no checkpoint; the zero-pack MCP
  surface stays `4e3e14917286b00c`. Rollback: `sql/rollback/0035_ledger_chain.sql` (refuses while a signed checkpoint
  exists unless `app.ledger_rollback_drop` is on; export them first).

Proof: `npm run test:ledger` (Node and SQL agree byte for byte; the chain on a fixture; append-only in the store and the
database; checkpoints and their cadence; tamper: a changed entry at its sequence number, a consistent rewrite caught by
the checkpoint, the next checkpoint refused; the key in a database setting, the Key vault, unset, malformed; owners'
route and MCP tool, members refused, tenant isolation, the published keys; off; the CLI's exit codes and export, and the
Python verifier), `npm run test:migrations` (0035 backfill, sequence, rollback), `npm run check:rls` (a tenant reads its
own checkpoints only and cannot write, change or remove one; the heads are out of its reach).

## Encrypted fields (mold_v0-194)

A record area's field may be declared **encrypted** in pack.json (or `definePack`), so its value is never shown or
stored in the clear, only revealed on purpose:

```json
{ "name": "ref", "label": "Reference", "type": "text", "encrypted": true, "searchable": "equality", "reveal_roles": ["owner"] }
```

- **Where.** A workspace area's field (a shared area has no workspace key) whose rows are in the shell's own tables (not a
  `workspace_files`, `upstream_catalog` or `http_api` repository); types text, number, date, boolean, json or a single
  enum. Never the lifecycle's, due date's, a link's or a clock's field, a job kind's argument, nor a field a metric or a
  tab computes, groups, sorts or filters by (refused by the pack schema and at build, `src/packs.ts`
  `encryptedFieldProblems`). The brief line: `field <name>: <Label> | text | encrypted | searchable | reveal owner`.
- **Encryption.** Each value is envelope-encrypted on its own (`src/encrypted-fields.ts`) with the workspace's data key,
  which is kept only wrapped by the app's vault key (`APP_VAULT_KEY`, `org_keys`): the same `sealBytes` (AES-256-GCM)
  the company email's secrets and the workspace store use, no second scheme. Stored as `encf:v1:<base64>`, the
  additional data binding it to its workspace, pack, area, record key and field (moved anywhere else, it does not open).
  A write is refused (503) while the vault is locked. Rotating the vault key (`npm run keyvault -- rekey` with
  `APP_VAULT_KEY_PREVIOUS`) re-wraps the data keys and never touches a field's ciphertext.
- **Never shown.** Every read carries `[encrypted]` in the value's place (null stays null): the console's lists, record
  pages and Export CSV, the data API, the generated MCP tools (`list_`, `get_`, `export_`, `list_records`, `get_record`),
  the developer API (`/v1`), webhooks' record events, and a pack's own `ctx.records`. The data trail never held values;
  nothing logs one. A write may send the mask back, or leave the field out: the stored value is kept; null clears it;
  input that looks like an envelope is refused.
- **Reveal.** `POST /api/data/:area/:key/reveal` `{fields?}`, `POST /v1/records/:area/:key/reveal`, the generated MCP
  tool `<prefix>_reveal_<area>` (offered only to roles that may reveal one of its fields) and `ctx.records.reveal(area,
  key, fields?)`. The caller needs the area's read permission and, per field, one of its `reveal_roles` (default: the
  roles that may update the area's records); an account or developer key has no role limits, as everywhere. Each reveal
  is a `reveal` entry of the data trail (when `audit.data` is on): person, door, area and key, never the value.
- **Equality only.** `searchable: "equality"` keeps a blind index beside the value (`$bi:<field>`: HMAC-SHA256 under a
  key derived from the workspace's data key, `orgcrypto.orgMac`), outside a sealed area's ciphertext too, so a filter
  `{field: value}` runs in SQL. Every other operator (`ne`, `in`, `prefix`, `contains`, comparisons, `exists`) and a sort
  on an encrypted field are refused (400). The same value has a different index in each workspace. A declarative check
  (mold_v0-196) compares an encrypted field only by equality: in its `match` (one value, a searchable field), through the
  blind index; never in `require`, an order or an operand (`src/check-spec.ts` refuses it at build).
- **The migration.** Each stored row carries the tag of the declaration it was written under (`$enc`). When a pack newly
  marks a field encrypted (or searchable), reads mask the old plain values at once, and the scheduler's tick (every
  minute on a server, the cron on Vercel; `src/encrypted-fields-migration.ts`) rewrites the rows whose tag differs, 500 a
  tick: idempotent (a value already sealed is kept; each UPDATE a compare-and-set on the row's version), resumable (the
  work left is exactly the rows whose tag differs), quiet (no updated_at, title or sealing change, no webhook; one data
  trail entry per workspace and batch). A field no longer encrypted is opened back the same way. A chained area's rows
  (mold_v0-195) never change: values stored before the field was encrypted stay as stored, masked on every read. No
  schema migration: values, indexes and the tag live in `workspace_records.data`.

Proof: `npm run test:encrypted-fields` (the declaration; round trip; every output grepped for the values: lists, record
pages, exports, MCP, developer API, webhooks received and queued, the data trail, every log line; reveal by role and
audited; the blind index for equality only and per workspace; key rotation re-wraps without re-encrypting; tenant
isolation; the migration in resumed batches, idempotent, and un-marking; declarative checks by equality only).

## Record files and document previews (mold_v0-220)

A record shows its documents on its own card: the files its `file` fields hold and the documents its URL fields point
at, each with its name, type and size, **Download**, and an inline preview. No pack writes code for it.

```json
{ "name": "attachments", "label": "Files", "type": "file", "multiple": true }
{ "name": "url", "label": "Official text", "type": "text", "preview": "document" }
"documents": { "hosts": ["rbi.org.in", "*.sebi.gov.in"], "max_bytes": 20971520, "refresh_days": 30 }
```

- **Stored files** (`src/record-files.ts`, `src/record-files-config.ts`). A `file` field holds a path in the workspace
  store (mold_v0-057, unchanged) or a **stored file** `{object, name, size, content_type, sha256}`: an object the shell
  keeps for one record of a workspace area (`storeRecordFile`), sealed with the workspace's data key (`sealBytes`, the
  mail intake's and the workspace store's scheme) under `workspaces/org-<id>/.records/<area>/<object>.wse`, the
  additional data binding it to its workspace, pack, area, record key, object and sha256: a reference copied into another
  record, area or workspace opens nothing (404). The type kept is what the bytes say for a PDF or an image. The objects go
  with the workspace's prefix when it is deleted; a record deleted on its own leaves its sealed objects (unreachable,
  removed with the workspace).
- **Uploads from the console** (mold_v0-238). A create form's file field (of a workspace area of the shell's tables,
  while `document_preview` is on) takes files from the person's device: **Choose files** (one for a single field), then
  each file's name, size and state (waiting, a progress bar as its bytes go, **Uploaded**, or why it failed) with Remove.
  When the form is sent each file goes, one at a time, to `POST /api/data/<area>/<key>/files/<field>` (the bytes as
  `application/octet-stream`, the name in `X-File-Name`, URI-encoded, the type in `X-File-Type`; `uploadRecordFile`),
  which keeps it as the intake does (`storeRecordFile`: sealed, bound to that record key) for a person who may read and
  create or update the area's records and answers its reference; then the create writes the references through the
  data API, checked as any write. At most 25 MiB a file, 4 MiB where the API runs on Vercel's functions (their request
  bodies stop at 4.5 MB; `recordUploadMax`); the form refuses a bigger file before sending it. A refused create keeps the
  uploaded files for the next try (one kept for an earlier key is uploaded again); Cancel, Back or Remove discards the
  ones kept but never written (`DELETE` on the same address with the reference, `discardRecordFile`: only a file kept for
  that key, which opens with its binding, and never one the record holds: 409). An upload is a `create` of target `file`
  in the data trail, a removal a `delete`. The console's create form for a record: `web/src/features/tabs/tab-action.tsx`
  (`CreateRecordForm`, `FileUploads`). Changing an existing record's files stays the data API's.
- **A `url` field** (mold_v0-238, `src/pack-api.ts` `isFieldUrl`): an absolute `http` or `https` address of up to 2048
  characters, written with its host and no user name or password, checked on every write (the record store, the MCP
  tools' input, the developer API's schema `format: uri`); filtered and sorted as text. The console takes it in an
  address input and shows it as a link (a new tab, `noopener noreferrer nofollow`). It may carry `preview: "document"`
  (as a text field still may).
- **Never inlined.** Lists, record answers, Export CSV (the name only), the MCP tools, the developer API and webhooks carry
  the reference; the console's lists show the file name and how many more (`a.pdf +2`); the record's details list leaves
  stored files to the cards. The bytes are read one file at a time, from the card.
- **The cards.** `GET /api/records/<area>/<key>/files` (and `/api/admin/records/...` for staff, shared areas only): the
  record as the caller may read it (the area's read permission; a withheld `get` answers 404), then a card per stored file
  and per document, each with a **signed link** (`?mode=inline|download&exp&t`: an HMAC under a key derived from the
  vault's, bound to the person, the workspace, the record, the field and the file; ten minutes), served
  (`GET .../files/<field>/<n>`) only with the same person's session. Previews: a PDF (its bytes start `%PDF-`) inline
  for the browser's own viewer (the console has no pdf.js), PNG, JPEG, GIF and WebP (by their bytes, sandboxed), plain
  text (as text, sandboxed), and HTML (an email's body, a fetched page) only through `src/html-sanitise.ts` (an
  allowlist: no script, style block, frame, form, handler, `javascript:` link or `url()` style; links open in a new tab
  with `noopener noreferrer`), in a frame with `sandbox="allow-popups allow-popups-to-escape-sandbox"` and a policy that
  runs no script and loads **no remote image until the reader presses Load images** (`images=1`). Anything else (docx,
  xlsx ...) is download only, said so on the card. A download is always `application/octet-stream` as an attachment with
  `sandbox` in its policy. Console: `web/src/features/records/documents.tsx` (`RecordDocuments`) on a record's page, an
  open row's full card (mold_v0-217) and the staff record page.
- **The data trail** (when `audit.data` is on): a preview is a `read` of target `file`, a download an `export`, keyed
  `<record>:<field>/<n>` (never the file's name or bytes). A shared area's document is no workspace's data: no entry.
- **Document previews** (`src/document-fetch.ts`). A url field (or a text field) with `preview: "document"` holds a URL; the pack lists
  the hosts (`documents.hosts`: the egress allowlist's rule, a host and its subdomains, `*.x` the same; refused at build
  when a field previews and the pack lists none). The server fetches only `https://` on port 443, no user or password, a
  listed name (never an address), resolving it here, refusing any private, loopback, link-local, reserved or multicast
  address (`src/egress-hosts.ts` `privateAddress`) and connecting to the address it checked; at most 3 redirects, each
  checked again; 20 seconds; at most `max_bytes` (default 20 MiB, at most 25 MiB); only a PDF, the four image types,
  plain text or HTML, by their bytes. No cookie, credential or referrer is sent. The copy is kept in the object store (a
  shared area's under `documents/shared/<sha256 of the URL>`, a workspace area's sealed under the workspace's
  `.documents/`) and fetched again after `refresh_days`; a failed refresh keeps the last copy, a failed first fetch is
  said on the card (with the source link) and tried again after an hour. Tests and the lane world only:
  `APP_DOCUMENT_FETCH_STANDIN=http://127.0.0.1:<port>` sends an allowed fetch to a local fixture (never in production).
- **The mail intake** (mold_v0-192): `email.intake.fields.body_file` (a file field: the message's HTML, sanitised, as
  `message.html`, else its text as `message.txt`; a `multiple` field gets both) and `attachment_files` (a `multiple` file
  field: each kept attachment, in order; the one copy, which `/api/email/attachments/...` reads too). Migration
  `0041_email_files` (rollback `sql/rollback/0041_email_files.sql`) marks each ledger row `kept`, `backfilled` or
  `not_found`. **Backfill:** messages taken in before (their row unmarked) get their files once: after each poll the
  intake claims one mailbox that brought such messages (for 30 minutes), reads it again, read only, over the window they
  came in (from the oldest one's arrival less `backfill_days`, at most 90 days back, at most
  `APP_EMAIL_BACKFILL_MAX_MESSAGES`, 500), and a message whose Message-ID hash matches a waiting row gets its body and
  attachments kept as files on its record (nothing else of the record changes; the old `.mail/` copies are removed);
  what the window no longer holds is marked `not_found` and never looked for again. The ledger keeps only a hash of the
  Message-ID, so a message is found by reading the window, not by asking the mailbox for one id.
- **Flags.** The features registry's `document_preview` (mold_v0-219; default on, asked for by a file field or a field
  previewing its document) gates the card routes (`previews` in `mountFileRoutes`: off, `404 document_preview_off`) and
  the console's cards (`hasDocuments`); the files stay stored either way.

Proof: `npm run test:record-files` (the declaration; a round trip sealed at rest under the workspace's prefix; never in
lists, the record, exports, MCP, the data trail, the database or the logs; permission by area role, workspace, person,
forged and expired links, a reference copied to another record or workspace; HTML sanitising, remote images blocked
until asked, the frame's policy; the data trail's entries; URL documents: the allowlist's refusals, redirects, private
addresses, size and type, the cache, a shared area for every workspace and staff, a workspace area's sealed copy, a
failure on the card), `npm run test:company-email` (8b: the body and attachments kept as files, previewed, and the
backfill once), `npm run test:migrations` (0041 and its rollback).

## Record page layouts (mold_v0-253)

Part 1 of rich record pages: a pack lays out an area's record page in pack.json (`record_areas[].detail`), and marks
fields `copyable`. **Off by default** (`features.record_pages`, `quiet_off`): off, every record page is the one details
card it always was, and the build writes exactly what it wrote before the flag (no `detail`, no `copyable`, no flag in
`web/src/config/features.generated.ts`, the generated types unchanged). With the flag on and no layout declared for an
area, its page is also as before.

- **Declared** (`src/pack-api.ts` `RecordDetailSchema`, the pack schema, the app spec's embedded copy): a `header`
  (`title` and `subtitle` fields, up to 3 `badges` on single-choice enum fields with each value's colour a theme token
  of `BADGE_COLORS`, `creator`, up to 8 `facts` with a number's `unit`), `notices` (`when` one test of one field:
  `equals`, `in`, `not_in`, `empty`; tone `info`, `warning`, `danger`; `title`, `text`), `tabs` (a `label`, at least one
  section each), each section a `title`, `fields` or `groups` of fields, `columns` 1, 2 or 3 and its own `empty` words;
  `unplaced` (`show`: the fields nothing names as "Other details" at the end of the first tab; `hide`).
- **Refused at build** (`detailProblems`, run by the area's schema, so `gen-packs` and the factory's spec check both
  refuse it): a field the area lacks, more than 8 facts, a tab without sections, a section without fields, fields and
  groups together, a badge on another kind of field or with a colour outside the token set, option values the field
  does not have, a unit on a field that is not a number, a title, subtitle, badge or fact on an encrypted or file field,
  two facts or badges on one field, two tabs with one address. `copyable` is refused on encrypted, file and json fields.
- **Drawn** (`web/src/features/records/detail-page.tsx`; what it decides, pure, in `detail-layout.ts`): in the standard
  grid, full-width cards. The header card (the area and where its records live, the title, the summary, the badges,
  **Copy ID** and **Copy link** as outlined buttons, the facts in a grid of 2 on a phone, 3, then 4, each formatted by its
  type, and a line with who added it, the id, the version and when it changed), the notices whose condition holds, the
  tab strip (`?tab=<id>`, the first tab with none; one tab: no strip), then the open tab's sections, each a card of field
  groups in its columns (one on a phone) or its empty state. The first tab ends with "Other details", the record's
  documents and deadlines, its linked records and its Credentials card. Every copy confirms with a toast and works on a
  phone (the clipboard API, else a selection copied). Badge and notice colours are the console's status tones and the
  theme's chart colours mixed toward the foreground, legible in light and dark.
- **Later parts**: a run's own page, logs, history, code views and a side panel for forms (part 2 is below).

Proof: `npm run test:record-pages` (14: the schema's refusals and the build's, on and off; the badges' tokens; facts by
type; a notice's conditions; tabs and sections; copy; off, the console's generated files those of the same pack without
its layouts; the page drawn in a headless browser for a failed and a running build, a one-tab project and an area with
no layout), `npm run test:features` (the flag off by default, asked for by a layout, in the console's files only while
on), `npm run test:console-tabs` (a laid-out build's console typechecks), `npm run test:zero-pack`, and the fixture
`scripts/fixtures/packs/fixture_pages` (projects, environments, builds), whose pages a lane world draws in light and dark
at 1440 and 390 px with each copy's toast and the clipboard read back.

## Record pages, part 2: related lists, runs, actions (mold_v0-254)

Under the same flag (`record_pages`, off by default; off, `/api/records/_page` answers nothing and the generated files
are as before), a layout's section may list **another area's records that point back** (`related`) or **the runs that
ran on the record** (`runs`), and the layout's `actions` fill the header. docs/RECORDS.md section 6 has the shape.

- **Declared** (`src/pack-api.ts` `DetailRelatedSchema`, `DetailRunsSchema`, `DetailActionSchema`; the pack schema and
  the app spec's copy): a related list's `area`, `via`, up to 8 `columns`, `sort`, `limit` (5; at most 50); a runs
  section's `kinds` and `limit`; each action's `kind` (`start_run`, `move`, `edit`, `delete`, `link`, `copy_link`),
  `place` (`primary`: one; `secondary`: up to 3; `more`, the default), `label`, `job_kind` and `input` (an argument to
  a field, `$key` or `$title`), `to`, `field`, `roles`, `unavailable` (a condition and its reason), `confirm`.
- **Refused at build**, on or off: in the area (`detailProblems`) two primary actions, a fourth secondary, a move on an
  area without a lifecycle or to a state no transition reaches, a write on a shared or append-only area, an edit on one
  with an encrypted field, an input from a field it lacks, a viewer's write, a section mixing fields with a list;
  across the build (`detailBuildProblems`, run by `checkViews`: gen-packs and the server's install) a related list
  whose area has no link back here (or two without `via`), a column or sort it lacks, a job kind the pack does not
  have, an argument the kind does not take, a kind that writes only after an approval.
- **Served** (`src/record-page-routes.ts`, mounted before `/api/records`): `GET /api/records/_page/<area>/<key>?tab=`
  answers the actions this person may take on the record (each with why it is disabled, when it is) and the open tab's
  related lists (read as the person, in the workspace's own scope, each row with its own area's actions; `{hidden}`
  for a role that may not read that area) and runs; `POST .../actions/<id>` takes one: a run of the kind (started as
  its generated start tool starts one, inside `src/runs.ts` `onRecord`, so the run carries the record), a move, an edit
  or a delete through the data API. A role the page hides an action from is refused (403), a disabled one with its
  reason (409). Who may: the action's `roles` within the kind's start tool (a run), the area's move and the
  transition's roles (a move), its update (an edit), its delete (a delete: an area with a lifecycle, the owner by
  default), the target area's read (a link); never an operation the pack's MCP settings withhold.
- **The link from a run to a record**: `runs.record_area` and `runs.record_key` (sql/migrations/0047, both or neither;
  its rollback drops them). A record's runs are those that carry it and those whose `targets.asset` names it.
- **Drawn** (`web/src/features/records/page-actions.tsx`, `detail-page.tsx`): the primary action as the filled
  Button, the secondary outlined, More outlined (the rest, then Copy ID and Copy link, the delete last), each move a
  menu of states; a disabled action keeps its place and focus (`aria-disabled`), its reason in a tooltip on hover and
  focus and read with it (in a menu, under its label). Delete asks with the console's `ConfirmDialog` (ConfirmButton's
  question); a run's form and the edit form (`EditRecordForm`, the staff pages' own) are full cards in the page's place
  (`?act=<id>`). A related list is a table on a desktop and a list on a phone, with Show all (the area's list,
  `?linked=<field>:<key>`); the runs likewise, each linked to its pack's runs tab with the run open (`?run=<id>`).

Proof: `npm run test:record-pages` (15: the refusals in the area and across the build, the console's decisions, how
it draws, gen-packs refusing a related list with no link back, an unknown kind or transition and two primaries, and the
page with actions, a related list and runs drawn in a headless browser; then `scripts/record-page-actions-test.ts`:
off, no route; each action by role, the API refusing the same, a run carrying its record, related lists by role and
workspace), `npm run test:migrations` (0047 and its rollback), `npm run test:features`, `npm run test:console-tabs`,
`npm run test:zero-pack`; the fixture `scripts/fixtures/packs/fixture_pages` (a project's builds and runs; a build's
Re-run, Open project, Edit, Move, Copy link and Delete).

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
- **The app's own domain is where AI clients connect (mold_v0-118).** Once `domain.py <app> switch` made a domain the
  console's front door (`infrastructure.vercel.custom_domain`, and `production_url` is that domain), the switch and
  every deploy after it write `APP_MCP_URL=https://<domain>` on the API project (mold.json `vercel.projects.api.env`
  `{own_domain}`; the old spelling too only where the project holds it). The console forwards `/mcp`, `/.well-known`,
  `/oauth` and `/install` to the API, so the API names the domain everywhere an AI client looks
  (`src/console-url.ts` `mcpUrl`): the MCP resource URI (the first of `src/clerk.ts` `mcpAudiences`), the protected
  resource metadata, the 401's `resource_metadata`, `/install`, `/install.json`, invitations' connector address, and,
  under the built-in sign-in, the authorization server's issuer and endpoints. A token issued for the API's own
  `PUBLIC_URL/mcp` is still accepted, the old address stays an allowed Origin, and `PUBLIC_URL` itself is unchanged
  (webhooks, the gateway, the run sandboxes keep calling the API directly). Proven by `npm run test:mcp-domain`.
- **One front door: the console's address (mold_v0-144; the operator's decision of 2026-10-26).** An app without a
  domain publishes its console's own address the same way: with no `APP_MCP_URL`, the shell takes the console's address
  (`APP_CONSOLE_URL`, which every deploy writes on the API project) whenever it is another origin than `PUBLIC_URL`
  (`src/console-url.ts` `frontDoor`, `mcpUrlSetting`), so the MCP address, the resource its sign-in is for (Clerk and
  built-in), the OAuth metadata (`/.well-known/*`), the install pages, the client skill and every connector address
  are on the console (`https://<app>.vercel.app/mcp`, or the domain once switched to). The API's root (`GET /`) answers
  `308` to the console's root, with the query kept; every other address of the API answers as before (a token for
  `PUBLIC_URL/mcp` is still accepted, the OAuth metadata keep `Access-Control-Allow-Origin: *`). Links that send a
  person somewhere (the billing pages' return addresses, the in-chat tips' "turn them off" link) are on the console.
  A server that serves both on one address (no `APP_CONSOLE_URL`, or the same origin) is unchanged. `npm run
  test:mcp-domain` runs every check with the console as the front door too (`clerk console`, `builtin console`).
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
smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep; each host pack's own smoke
runs with `APP_PROXY_HOPS=1`, as every deploy sets it, unless the environment sets it: mold_v0-149) and `npm run mcp:check` against
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
console's pages **from the lane copy, served on the factory machine** (`testing/console/`): `render.py` builds the
lane copy's `web/` (`next build --webpack`, with a lane stand-in for `@clerk/nextjs` in that build only, since a local
copy cannot reach Clerk with the app's keys) and keeps the build under a hash of every input that can change it
(`console/cache.py`, mold_v0-147: the console's files, the packs and profile, the installed packages, node, the build
environment), so the next run with the same inputs serves a copy of it with no build; `--suite a11y,layout,shots,...`
runs several harnesses in one world and `--pages auto` grades only the pages a change can reach (`console/pages.py`,
plus a smoke), while the lanes grade every page. `world.mts` serves it
on 127.0.0.1 against the lane copy's API on an embedded throwaway database behind the shell's offline Clerk
(`scripts/lib/test-world.ts`, `mock-providers.ts`), signed in as one workspace's owner who is also platform staff; every
request a page makes off the machine is aborted. The pages are read from the build (`console/surface.mts`): the shell's
own, each host pack's `routes.json` and each pack's tabs, pages and record areas. Clerk's own widgets and the deployed
console's bytes are not graded (each lane's `not_covered` says what is not). The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**Parity snapshots (mold_v0-136; [testing/parity/](testing/parity/README.md)).** Not a lane yet: a check that a build
still shows people, AI clients and the console the same thing, for refactors meant to change nothing (moving the host
pack `octillion` into config). `parity.py snapshot <app_id|zero> --out <dir>` records, in the lane world above (embedded
database, offline Clerk, the console served on 127.0.0.1): the customer and admin MCP servers over an in-memory client
(instructions, tools, prompts and each prompt's text over an argument matrix, resources and every widget, the skills),
every `*.generated.*` file, the API's route list and every GET without a path parameter under `/api/*`, and every page of
`console/surface.mts` (text, links, screenshots at 390 and 1440 wide in both colour schemes), plus each pack's own
`scripts/smoke.ts` pass or fail. Times, ports and minted ids are masked, never dropped. `parity.py diff <before>
<after> [--allow <phase>.json]` prints what differs, grouped, and fails on anything a phase's allow list does not name;
`parity.py probe <app_id>` reads a deployed app (pages, `/app` and `/admin` status, `/mcp` without a key) and writes
nothing. Two snapshots of one build compare equal; how to run it as a lane is in its README.

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
