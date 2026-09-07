# infra/vm

Host: DigitalOcean droplet, 4 vCPU / 8 GB / 154 GB, Ubuntu 24.04, SSH alias `digitalocean`.
Provisioned 2026-09-06 by `provision.sh` (idempotent, rerun on a fresh box): node 24, npm, docker
engine + compose, Vercel CLI, Playwright + chromium with system deps.

---

## The factory has ONE deploy target: Vercel

`target: vm` is a **local verification** target. It generates the app's database artifact and runs
the mold's own schema chain against it. It does not serve the application, and `--deploy` on a vm
app refuses in one sentence rather than pretending.

That is a decision with a cause, not a deferral (task **mold_v1-020**):

| what a real mold_v1 deployment needs | on the VM |
| --- | --- |
| web (Next.js) | buildable — 1.89 GB image from a 1.10 GB context |
| eve API (`vercel.eve.json`, framework `eve`) | **fails off Vercel**, three distinct ways: the `just-bash` package is not bundled; bootstrap exits 1 with `no python3 on PATH in this sandbox image`; the docker backend answers `bash: line 1: /root/fmt_xlsx.py: Permission denied` |
| task-workflow service (its own Next.js app) | buildable |
| 4 cron schedules (`vercel.json`) | would be systemd timers |
| durable-workflow auto-resume | **impossible without a mold fork.** `resumeBearer()` reads `x-vercel-oidc-token` / `VERCEL_OIDC_TOKEN`; with no bearer the route degrades to `{resumed: 0, note: "No VERCEL_OIDC_TOKEN (OIDC federation off)"}`. Giving the VM its own identity means editing `app/api/cron/resume-workflows/route.ts` and `agent/channels/eve.ts` — HARD RULE 1 forbids it |
| reverse proxy + TLS for the web door | not built |

Every fix for the eve API lives inside `molds/mold_v1/codebase`, which is immutable. And making
`eve start` run here at all required mounting `/var/run/docker.sock` into it, which hands the
customer's agent sandbox root on the droplet. So: **unsupported, with cause.**

Moving to the VM would not even remove the Vercel dependency — seven TypeScript files import
`@vercel/blob`, and `agent/lib/artifact.ts` has no filesystem fallback.

---

## The app database

    python3 .claude/scripts/provision.py <app_id> --verify-db     # up + full mold chain + proof
    (cd infra/vm/apps/<app_id> && docker compose up -d)           # the database alone
    python3 .claude/scripts/lib/localpg.py ls | down <app_id>

`infra/vm/apps/<app_id>/` is **pure generated output**, rewritten from the four state files on every
run — `--check` and `--verify-db` alike. (It used to be skipped by `--verify-db`, which is the command
this README puts first, so an app could hold a live database while state named a compose file that did
not exist — and the run that mints `.pg-admin` and `pg/server.key` was the one run that never wrote the
`.gitignore` protecting them. The generation now happens before either path branches, the per-app
`.gitignore` is written by whichever function first creates the directory, and the root `.gitignore`
carries `infra/vm/apps/*/.pg-admin` and `infra/vm/apps/*/pg/` as a second belt.) The generation also
mints those two files, so the compose command above works on a freshly generated artifact instead of
failing on a bind mount that does not exist yet.

Hand edits to the generated files do not survive, on purpose: the old scaffold was written only
`if not os.path.exists(...)`, so a hand-edited compose came back byte-identical on a re-run and — the
real damage — a *branded* app kept building the *unbranded* mold from a frozen build context. The one
sanctioned hand-edit seam is `docker-compose.override.yml`, which is never generated.

**Run compose from the app directory.** Compose merges the override automatically only when it
discovers the files itself; an explicit `docker compose -f <the generated file>` silently drops it —
no warning, no error, `max_connections=200` where the override said `42`. That is also why
`localpg.up()` now shells out to `docker compose up -d` with its cwd in the app directory rather than
running `docker run`: the seam governs the database `--verify-db` brings up, not just manual runs.
An override that publishes a port is refused *before* anything starts (the merged config is read
first), and a published port found after start removes the container.

### How it is secured

**No Postgres port is ever opened.** Postgres listens on **6543 inside the container**, on the app's
own private network `sf-<app_id>`; mold scripts are run *on that network* rather than the database
being published to them. `docker port pg-<app_id>` is empty and `ss -tln` shows only sshd on a public
address. Listening on 6543 internally is also what makes `.bootstrap-supabase.mjs:206`
(`appUrl.port = "6543"`, unconditional) a true no-op — no host port, no port allocator, no rewrite.

Everything else: TLS on with a per-app self-signed certificate (`ssl_cert_file`/`ssl_key_file`, key
0600 and owned by uid 999), `password_encryption=scram-sha-256`, a generated 24-byte admin password
in `.pg-admin` (0600, ignored by both this directory's `.gitignore` and the root one, never typed by anyone), and an `app_rw` login role that is
`NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`. `DATABASE_URL` carries `?sslmode=require` — the
mold's runtime clients pass no `ssl` option at all, so that query parameter is the only thing that
turns TLS on.

TLS is not optional even locally: `ssl: "require"` is hardcoded as an explicit postgres.js option in
48 of the mold's `.mjs` scripts, and an explicit option beats any `sslmode` in the URL, so a plaintext
server is simply unreachable by them.

### One CLUSTER per app, never one database per app

`app_rw` is a **cluster-global** role and its name is hardcoded across the mold (the bootstrap, the
task-workflow GRANTs, `/api/ops/health`, and provision.py's password-reuse regex). Two apps on one
cluster is not a theory — it was measured:

    app_two credential -> app_one DATABASE: OK      # read "APP ONE CONFIDENTIAL CUSTOMER", wrote a row
    ALTER ROLE app_rw <new password>                # app #1's live deployment then failed 28P01

So each app gets its own container, its own volume and its own network. This is a finding, not a
preference — do not "simplify" it into a shared cluster next quarter.

### Backups

Neon's free tier keeps a short restore window and no export you own. The factory therefore writes a
generated systemd timer per app that runs `pg_dump -Fc` of the app's database into that app's own
(already provisioned, free) Vercel Blob store with 7-day retention — see `infra/vm/backup/`. The
local `self_hosted` lane is a verification database and is not backed up: it is reproducible from
state in one command.

### If you ever publish a port here, read this first

This droplet has **no firewall** — `ufw status` is `inactive`, `iptables -S` shows `-P INPUT ACCEPT`
and only Docker chains — and it absorbs ~1100 SSH credential attempts a day with no fail2ban. A port
bound to 0.0.0.0 is found by internet scanners within about four minutes (measured).

And the obvious block does **not** work, because Docker's `nat/PREROUTING` DNATs to the *container*
port before any filtering runs:

    iptables -I DOCKER-USER 1 -p tcp --dport <published> -j DROP          # NO-OP: all probes connected
    iptables -I INPUT      1 -p tcp --dport <published> -j DROP          # NO-OP: all probes connected
    iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdstport <published> -j DROP   # works: 4/4 timed out

The chosen design publishes nothing, so none of this is load-bearing today. It is written down so the
next person does not build a decorative firewall.

### Why not self-host the app's production Postgres

Because Vercel Pro has no static egress IP (Secure Compute is Enterprise), so a Vercel-hosted app
talking to this droplet forces `hostssl ... 0.0.0.0/0` — one password between the open internet and
every customer's data. And the practical TLS ceiling is `sslmode=require`, not `verify-full`:
postgres.js takes a CA only from `ssl: { ca }` in code (`agent/lib/db/index.ts`, `lib/ops-db.ts`), an
edit HARD RULE 1 forbids — so the server is encrypted but *unauthenticated*, and an on-path attacker
can relay SCRAM. There is also no pooler: the mold opens 10 + 5 backends per serverless instance and
the pool size cannot be capped from the URL (`?max=3` still opened 10).

`provision.py` encodes that refusal in code rather than in a comment: `provider == "self_hosted"` and
`target == "vercel"` exits.

### Escape hatch, if Neon's free tier is ever exhausted the way Supabase's was

A pgbouncer appliance (`edoburu/pgbouncer`) in front of a self-hosted cluster is the documented
fallback — see `infra/vm/pgbouncer.md`. Two gotchas that cost real time and are recorded there so
nobody re-derives them: the key file must be readable by **uid 70** in that image, and SCRAM
pass-through works from `auth_file` but **not** from `auth_query` (`server login failed: wrong
password type`), so the auth file must be regenerated from `pg_authid` and HUP'd after every rotation.
