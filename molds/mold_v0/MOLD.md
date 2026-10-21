# mold_v0

**Status:** work in progress. Started as a verbatim snapshot of the operator's existing MCP product, by the operator's decision (2026-10-20): *clone first, generalise after*. **Authored in this repository since the fork point below** (operator decision D1, 2026-10-20; mold_v0-040).

**Source: in-tree.** `molds/mold_v0/codebase` is edited here, by pull request to this repository like any other file. The fork point is factory commit `e8d836532cb7` (the last refresh, which took in the product's hardening, mold_v0-031), a snapshot of the product at `7399bd4c3611` (snapshot 2026-10-21). Both are recorded in [mold.json](mold.json) (`source`: `in_tree`, `since`, `forked_from`) and in `state/factory.json` (`molds[mold_v0].source.in_tree`, `in_tree_since`). Nothing is fetched from the product's repository again: `mold.py refresh mold_v0` refuses, `mold.py fetch mold_v0` writes nothing, and `mold.py check mold_v0` reports "in-tree since e8d836532cb7", the last commit that changed the codebase and any uncommitted change under it. An app's `mold_commit` is the last commit of this repository that changed the codebase (the fork point reads as `7399bd4`, the same files), so `mint` shows a redeploy due after each merged change.

## Two recorded exceptions

**Edited in place (mold_v0-040).** AGENTS.md says a mold's codebase is never edited in place and base-code changes go to the mold's source by pull request. mold_v0 is the one exception: its source is this repository. A change to the shell is a pull request here that touches `molds/mold_v0/codebase`; the deploy gate then reads this repository's checks for the commit being deployed (below). mold_v1 keeps the rule unchanged: its snapshot is only ever written by `mold.py fetch|refresh` from its own source, and nothing in this exception reads or writes it.

**A product, not yet a general shell.** Molds are general-purpose: no product or customer words, apps declared through a profile and packs. mold_v0 starts as the opposite, a working product copied as it is, so the factory can reproduce it straight away (ticket mold_v0-029) and mint a second product from it (mold_v0-030). It becomes general step by step: [SCOPE.md](SCOPE.md) names each capability of the **agent-run shell**, where it lives in the snapshot today and the ticket that generalises it (mold_v0-038 to 050, with the surviving older tickets), and the product's own tools, pages, record areas and tables move into the pack `octillion`. Until then, an app minted from mold_v0 inherits the product's code.

## What is in it today

- A TypeScript server (Express, `src/http.ts`) with a stateless MCP endpoint (`/mcp`, tools in `src/server.ts`), per-organisation API keys (hashed), Clerk sign-in, client install guides, onboarding, usage analytics, billing and email.
- An agent-run engine: a job queue (`src/worker.ts`, `/api/worker`), an autoscaler that launches one sandboxed orchestrator per job (`src/autoscaler.ts`, `orchestrator/`), pinned coding-agent harnesses (`harnesses/registry.json`), an inference gateway with per-session tokens and cost metering (`src/gateway.ts`, `src/usage.ts`), a versioned key vault and per-organisation data keys (`src/keyvault.ts`, `src/orgcrypto.ts`), transcripts and an off-machine archive.
- A web console in `web/` (Next.js): `/admin` for platform staff, `/app` for an account's people.
- Postgres with versioned migrations (`sql/migrations/NNNN_*.sql`, `src/migrate.ts`, `npm run db:migrate`; proven by `npm run test:migrations`) and row-level security on every tenant table (`sql/migrations/0003_row_level_security.sql`, `src/rls.ts`; proven by `npm run check:rls`), plus optional analytics and archive stores.
- Two ways to run: its own server (Docker Compose with HTTPS) and Vercel.

## Hardening (ticket mold_v0-031, done)

API keys out of URLs, OAuth token audience checked, Origin validated on the MCP endpoint, no static admin token, database row-level security proven on every deploy, and versioned migrations: all in the codebase since the fork point. The factory's side of it is mold_v0-051 (intake, the deploy's RLS check, the lanes; below).

## Decisions

- Sign-in for apps from the generalised shell: Clerk at launch, the adapter the product already uses (operator decision, 2026-10-20, mold_v0-046); a built-in emailed code plus Google comes later, with Clerk then optional (mold_v0-004).
- The source has no licence constraints (a hackathon project).
- The operator's live copy moves to a factory-managed app through a new subdomain, two weeks side by side, then a public address switch only with the operator's yes (mold_v0-032).
- Generalisation (2026-10-20): mold_v0 becomes an **agent-run shell** (tenancy, an MCP front door, a run engine with sandboxed
  harness runs, an inference gateway with metering, vaults, storage, record areas, schedules, a console), with each product's own
  surface in a pack. The shell is authored **in this repository** (operator decision D1): after one last refresh that took in the
  product's hardening (mold_v0-031, factory commit `e8d836532cb7`), `molds/mold_v0/codebase` stopped being a snapshot and is edited
  here, a recorded exception to "never edit a mold in place" (mold_v0-040; see "Two recorded exceptions"). The product's own features become the pack `octillion`; the second app's is its own
  pack. Backlog: mold_v0-038 to 050.

## Pack and record-area contract

This is the seam the generalised shell exposes (mold_v0-038, record areas mold_v0-047). None of it exists in the
pinned snapshot yet: today every tool, page and table is the product's own, and `mold.json` says packs are "not
needed" for that reason. This section is the target the tickets build to.

**In the shell.** A pack is a directory the shell discovers at build time. `gen-packs.mjs` (new, mold_v0-038) reads every
pack in the build copy and writes a generated registry the server and the console import; nothing in the shell names
a pack. Each pack exports one `definePack({...})`:

| Field | What the pack declares | Where the shell puts it |
|---|---|---|
| `tools` | MCP tools: name, input and output schemas, annotations, a handler that receives the calling workspace first | the tool registry behind `/mcp` (today hand-written in `src/server.ts`) |
| `routes` | HTTP handlers | mounted at `/api/packs/<id>` (workspace-scoped, behind sign-in) and `/api/admin/packs/<id>` (platform staff, behind the admin roles), never at a shell path |
| `jobKinds` | run kinds: the harness or runner, the image, token lifetime, budget, egress allowlist, a result validator | the run engine (mold_v0-041) |
| `recordAreas` | areas with a `role` (`source`, `check` or `asset`), a `scope` (`platform` or `workspace`), fields, list columns and links to other areas | a list page, a detail page and MCP list/get tools with no extra code (mold_v0-047) |
| `credentials` | fields a workspace must give: label, help, bound to the workspace, an asset or an environment, how a run receives it (environment name or tmpfs file) | the workspace credential vault (mold_v0-034); only names reach a run's definition |
| `schedules` | default schedules per workspace (a run kind over a scope) | the scheduler (mold_v0-035), editable per workspace in the console |
| `onboarding` | checklist steps and the event that ticks each off | the `/app` setup checklist (mold_v0-011) |
| `migrations` | versioned SQL for the pack's own tables, prefixed with the pack id; every workspace-owned table carries the workspace id under row-level security that fails closed | applied after the shell's migrations (mold_v0-031), in pack order; the context lane checks every pack table |
| nav and profile words | console navigation entries, and words the pack shows instead of the shell's (a workspace shown as a "company", a run as an "audit") | the console sidebar (today `web/src/config/nav-config.ts`) and the profile |

Record-area roles: a `source` is where requirements come from (versioned, read-only to customers); a `check` is a unit
checked repeatedly and traced to a source (library at platform scope, its per-workspace state at workspace scope); an
`asset` is what is checked and holds the workspace's private data (workspace scope only, sealed with the workspace
data key). Platform-scope areas are read-only to customers; workspace-scope areas pass the cross-workspace test. A
run's results are rows of (run, workspace, check, asset, status, finding fingerprint, evidence reference).

A pack that wraps an upstream project (the second app's audit-agent pack, for one) pins it by commit in its manifest
and runs it at a process boundary inside the run's sandbox; it is never vendored into the pack or the shell, and never
patched locally (changes go upstream by pull request).

**In the factory.** A pack lives at `packs/<pack_id>/` (git-ignored): `pack.json` and a `files/` tree that mirrors the
codebase root and only adds files. An app names its packs in `application.json` (`"packs": ["octillion"]`), and
`packs.py apply <app>` copies them into `build/<app_id>/`, then runs the mold's generators there; deploys and lanes
use that build copy, never `molds/mold_v0/codebase`. Today `packs.py` carries mold_v1's rules (where a pack may add
files, which generator proves the mold supports packs) and refuses mold_v0. mold_v0-024 moves those rules into each
mold's `mold.json`: the paths a pack may add to under mold_v0 (its pack directory, `{pack}`-named migrations, console
pages under the pack's route), the generator to run (`gen-packs.mjs`), mold_v0's brand rules, and deploy and lanes from
the build copy. A pack file that would replace a shell file is refused, as for mold_v1.

**Two proofs.**

- **Zero packs is a neutral shell.** A build with `packs: []` signs in, has workspaces, keys, the console, the vaults
  and the run engine, passes the smoke test and the tenant-SQL check, and has none of the product's tools, pages or
  tables (mold_v0-038, 039, 049); the vocabulary check finds no product word in it (mold_v0-045).
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
app. *packs*, *brand*, *workspaces* and *package* are "not needed", each with the reason in mold.json: no pack mechanism
(until mold_v0-038 and 024) and no brand overlay yet, organisations made in the product's own console, no agent package. `code-request`, `code`
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

1. checks on this machine that the snapshot has every file the image build copies, that every name the compose file
   requires is written from state or minted by the product's own `bootstrap.sh`, and that the compose project is
   `sf-<app id>`, never the compose file's own default name, which another copy of the product uses;
2. qualifies the server: Ubuntu 24.04, sudo, systemd, 4 GB, 2 CPUs, 20 GB free, no other web server, and the web
   ports free or held by this app's own project. It refuses a server where another stack already answers on 80/443;
3. installs Docker and its compose plugin if absent, ufw (SSH, 80, 443 only) and fail2ban;
4. copies the source into a new release directory beside the serving one;
5. writes `DOMAIN` and `PUBLIC_URL` from state into `/etc/software-factory/<app>/env` (root, mode 600), then mints every
   name still missing (the database password and the product's keys) with the product's own `bootstrap.sh`, on the
   server, in a private temp directory that sees names and never values. Optional keys (sign-in, billing, analytics)
   stay off until the operator sets one with `provision.py <app> --set-secret NAME`;
6. points `current` at the new release and runs `docker compose -p sf-<app> ... up -d --build --wait`; on failure it
   switches back to the release that served before and brings that up;
7. checks health: the app container healthy and not running as root, only Caddy publishing ports, and
   `https://<domain>/healthz` answering 200 `{"ok": true}` from outside. Then old releases are removed.

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
  Both are required: the console's `src/proxy.ts` runs Clerk's middleware on `/admin` and `/app`, which cannot start
  without them, so the check (`provision.py <app>`) stops and asks for them (exit 3) rather than deploying a console that fails its health
  check. The built-in emailed-code sign-in comes with the generalised shell.
- Order: the API first (twice on a first deploy, so it reads its own address as `PUBLIC_URL`), its `/healthz` must
  answer 200 ok; then the API-address variable on the console, then the console. Health on the console: `/healthz`
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

**The console on a server of its own** is still not served the same way: the `Dockerfile` copies `/web/out` from its
web stage, and the console's `next build` writes no static export (it is a server app). That is the server target's
open question, not the Vercel one.

**Lanes** (`molds/mold_v0/testing/`, run by `lanes.py` as for any mold): *functional* runs the product's
`npm run typecheck`, `npm run test:migrations` (embedded throwaway databases only; `MIGRATIONS_PG_URL` unset), `npm run
smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep) and `npm run mcp:check` against
the deployed address; *context* runs `npm run check:tenant-sql` and `npm run check:rls` on a throwaway embedded
database (the deployed database is proven by the deploy itself, above). `test:migrations` also upgrades from older
versions of `sql/schema.sql` found in git history; this repository holds one version of that file, so that part has
nothing to run here (the lane says so). *load*, *accessibility* and
*responsiveness* have no harness in the product and are recorded `skipped`, never `pass`. The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**The CI gate (mold_v0-040).** `provision.py`'s release gate (`lib/deploy_gate.py`) reads, for an in-tree mold, **this
repository's** checks for the commit being deployed: HEAD of the checkout the deploy runs from, and only when
`molds/mold_v0/codebase` on disk is exactly that commit (no tracked change, no untracked file, and no ignored file the
deploy would carry other than mold.json's `source_excludes`, such as `node_modules` and `.env`). Then:

- once mold_v0-001 names the shell's own workflow in [mold.json](mold.json) (`source.ci.workflow`), that workflow's run
  for the commit must have passed with every job it defines, the same rules as mold_v1's `ci.yml`;
- until then, **every** check run and commit status GitHub reports for that commit must have passed, and there must be
  at least one. None of them tests the shell yet, so a green verdict says only "this repository's checks passed for
  this commit", and the recorded verdict says exactly what was read.

Today this repository runs no workflow, so the verdict is *missing* and a mold_v0 deploy needs
`--allow-unverified-mold "<reason>"` (recorded in `infrastructure.json` `deploy_gate.override`). A check that failed, one
still running, GitHub not answering, no GitHub `origin`, or an uncommitted change refuses as for any mold.

**Known before the first deploy (mold_v0-029).** The codebase commits `web/package-lock.json`, so the server deploy's
preflight no longer refuses for it and the console project can install exactly.
