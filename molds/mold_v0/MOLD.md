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

## How the factory runs it

mold_v0 is a **single-service mold**: [mold.json](mold.json) says so, and every factory script hands such an app to
`.claude/scripts/lib/single_service.py` before any mold_v1 path. The snapshot is never edited: what the factory needs
(the compose project's default name, the service it builds, its port, the env names it requires or accepts, the
health check) is read from the product's own `deploy/docker-compose.prod.yml`, `deploy/bootstrap.sh` and `Dockerfile`
each time.

**Mint.** `mint.py new <app> --brief briefs/<app>.md` (the brief says `Mold: mold_v0`) runs the same ten stations as any
app. *packs*, *brand*, *workspaces* and *package* are "not needed", each with the reason in mold.json: no pack mechanism
and no brand overlay yet, organisations made in the product's own console, no agent package. `code-request`, `code`
and `reuse-keys` refuse a mold_v0 app.

**Intake.** The same four state files and schemas. It asks only where the app runs, unless the brief says ("its own
server", or "Vercel"), and takes the domain from the brief (`Domain: app.example.com`). Fields only this shape uses:
`infrastructure.compose_remote` (target `compose_remote`), `postgres.exposure: "compose_network"` and
`blob.provider: "none"`. `postgres.rls` is `"off"`: the product scopes tenant rows in its queries, which its tenant-SQL
check guards; proving row-level security on every deploy is mold_v0-031.

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
`npm run typecheck`, `npm run smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep) and
`npm run mcp:check` against the deployed address; *context* runs `npm run check:tenant-sql`. *load*, *accessibility* and
*responsiveness* have no harness in the product and are recorded `skipped`, never `pass`. The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**Known before the first deploy (mold_v0-029).** The snapshot now commits `web/package-lock.json` (refreshed to
4ec6634), so the server deploy's preflight no longer refuses for it and the console project can install exactly. The
product's repository has no CI workflow, so the factory's CI gate refuses its deploys unless the operator chooses
`--allow-unverified-mold "<reason>"`.
