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

**Vercel** (target `vercel`): one project, from the product's own `vercel.json` (one function and its cron). Nothing
is typed by hand:
- the project is refused if it is one of the live projects or another app's (provision.py's own rule), before anything
  reads or writes it; intake suffixes a default name that is taken, and says so;
- the app gets its own Postgres through provision.py's Neon provisioning: an empty free database adopted, or a new
  one from the Vercel Marketplace, each proven empty (with the product's own `pg` client, from a throwaway project)
  before the app's project is connected. `DATABASE_URL` is the one the integration writes, never written by the
  factory and never replaced. Row-level security is not part of this gate: the product has none yet (mold_v0-031);
- the product's keys and `CRON_SECRET` are minted by the same `bootstrap.sh`, in a private temp directory here, and
  written without being shown; `PUBLIC_URL` is the address Vercel reports;
- a deploy whose `/healthz` does not answer 200 ok puts production back on the deployment that served before.

**The web console on Vercel is not served yet, and why.** `web/` is a server-rendered Next.js app (its `/admin` and
`/app` routes render on the server behind a middleware, and `next.config.ts` has no `output: 'export'`); measured with
its own `npm run build` at 5310a51, it writes no `web/out`. The API function serves `web/out` when it exists, so the
factory builds the console into the one function only when the product's config produces a static export (the build
step and its config overlay live in the build copy, never the snapshot). Today the deploy records
`vercel.console: "not served: ..."`. The product needs one of these upstream: a static export of the console, or the
two-project shape its own comments describe (`web/` as its own Next.js project, with the API-address variable in `web/next.config.ts` set to the
API's address). The same gap stops the image build on a server: the `Dockerfile` copies `/web/out` from its web stage.

**Lanes** (`molds/mold_v0/testing/`, run by `lanes.py` as for any mold): *functional* runs the product's
`npm run typecheck`, `npm run smoke` (embedded throwaway Postgres; it must reach its per-tool tenant-isolation sweep) and
`npm run mcp:check` against the deployed address; *context* runs `npm run check:tenant-sql`. *load*, *accessibility* and
*responsiveness* have no harness in the product and are recorded `skipped`, never `pass`. The MCP check needs an
organisation of the app's own: `provision.py <app> --lane-key --dry-run`, then `--lane-key --yes` once the operator
says yes. It runs the product's `scripts/create-org.ts` and keeps the connector address in a private file outside
the repository (mode 600, never shown).

**Known before the first deploy (mold_v0-029).** The snapshot at the pinned commit lacks `web/package-lock.json`,
which the `Dockerfile` copies (the product's own `web/.gitignore` keeps it out), and its web stage writes no `web/out`
for the final stage to copy (above), so the image cannot build from it. The server deploy refuses the first before
contacting anything. The fix belongs in the product's repository, followed by
`mold.py refresh mold_v0`. The product's repository has no CI workflow, so the factory's CI gate refuses its deploys
unless the operator chooses `--allow-unverified-mold "<reason>"`.
