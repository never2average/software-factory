# How the software factory works

The factory turns a mold (a known-good application codebase) into products (deployed, tested, sellable applications), driven by an operator: Fable (the model) plus sol (the human solutions engineer). Everything runs on the DigitalOcean VM at `/root/software-factory`.

## The four layers

```
brief (5 lines) ──intake──▶ state/application/<app_id>/ ──provision──▶ running app ──lanes──▶ product stage
                                     ▲                                                      │
                                     └──────────────── revert (failed lane → task) ◀────────┘
```

1. **Molds** (`molds/<mold_id>/`). A mold is a snapshot of a codebase plus its test lanes. `mold_v1` is fde-agent at a pinned commit: eve framework, Next.js 16, Drizzle on Postgres, Vercel Blob data room, GLM 5.2 on Cloudflare Workers AI. `mold_v2` and `mold_v3` hold a `MOLD.md` and a roadmap and no codebase at all; nothing has been stamped from either. Molds are never edited in place; they are refreshed from upstream or forked.

2. **State** (`state/`). JSON that describes the factory and every application, validated by schemas.
   - `factory.json`: operator, the six-item service surface, the molds, the service/revert loop, and `defaults` (the answers that apply to every app).
   - `products.json`: products with a stage and the gates for each stage. Several products may share a mold — the same
     codebase under different brands and packaging — so a brief says which with `product: <id>`, and the product's `brand` is
     copied into the app. mold_v1 carries `delivered` and `dover`.
   - `tasks/<mold_id>.jsonl`: the backlog. Closing tasks advances products.
   - `application/<app_id>/`: four files per stamped app: application, infrastructure, datastores, datainfra. Secrets appear by name only.

3. **Scripts** (`.claude/scripts/`). Stdlib Python (plus node 24 for the `lib/*.mjs` probes), no pip installs.
   - `factory.py`: status, next, tasks, add, set, close, validate — validate also refuses an RLS claim with no evidence.
   - `intake.py`: brief in, four state files out, questions for anything unresolved.
   - `provision.py`: state in, datastore created, secrets checked by name, deploy — and `--verify-db` / `--verify-rls`.
   - `lanes.py`: the five testing lanes, their reports, and the revert gate.
   - `branding.py`: a per-app branded copy of the mold under `build/<app_id>/`.
   - `clone.py`: stamp, deploy and regression-diff a replica of the live deployment.
   - `lib/`: `localpg.py` (the app's private Postgres, no host port) and the `.mjs` probes the gates run
     (`verify-apprw.mjs`, `rls-policy.mjs`, `rls-cover.mjs`, `db-tables.mjs`, `surface.mjs`).

4. **Agents, skills, workflows** (`.claude/`, mirrored to `.agents/`). Thin wrappers that tell an agent which script to run and what it may and may not do. `intake` asks the user; `provisioner` deploys; `mold-engineer`, `lane-tester`, `product-packager` work backlog tasks.

## Describe to deploy, step by step

**Intake.** `intake.py briefs/x.md --app x` reads the brief for hints (target, customer, domain, "no browser", "no web search"), fills what factory defaults cover, and writes `questions.json` for the rest, exiting 2. The `intake` subagent asks those questions in batches of four and re-runs with `--answers`. The first intake ever also confirms the defaults; after that a new app asks one question: fresh database or shared with live. Output: validated state, app registered in `factory.json` and under its product.

**Provision, check mode — NOT read-only on a Vercel app.** `provision.py x` (or `--check`) counts the secret
names the app declares against the store and prints what is still missing. It builds and deploys nothing. But on
`target: vercel` it is not a look: before it can count a secret it (1) creates the three Vercel projects `<proj>`,
`<proj>-api`, `<proj>-workflow` if they do not exist, (2) provisions the datastores the state names — for a fresh
`neon` database it adopts an unattached free Neon resource on the team if one exists **and is empty**, otherwise
runs `vercel integration add neon` (no checkout page); plus a private **Blob store created inside the app's own
Vercel project**, whose connection is what injects `BLOB_READ_WRITE_TOKEN` — and (3) mints the app-internal secrets
(`CRON_SECRET`, `OPS_SECRETS_KEY`, the `AUTH_JWT_*` sign-in key pair) into the project. So a `--check` of an app
whose datastores are not provisioned yet creates real, team-visible, potentially billable resources. That is task
**mold_v1-041, still open**: read `provision.py <app>` as "check *and provision*, do not build"; only `--deploy` puts
code in front of traffic. There is no copy-from-live path for external credentials: Vercel stores them write-only
(`sensitive`), so the user sets each one with `provision.py <app> --set-secret NAME` (value typed at a hidden
prompt, written as `encrypted` to all three projects, never to a file). `DATABASE_URL` is not written here at all —
only the RLS gate inside `--deploy` / `--verify-db` writes it.

**What check mode DELETES.** To learn whether a candidate Neon database is empty the factory must connect it
somewhere, and it must not be somewhere that matters. So it creates a throwaway Vercel project named
`sf-neon-inspect-<8 hex chars>` (pattern `^sf-neon-inspect-[0-9a-f]{8}$`, `SCRATCH_RE` in `provision.py`), connects
the candidate to it on the `development` environment only, reads the table count, disconnects, and deletes that
project by REST `DELETE /v9/projects/<id> --dangerously-skip-permissions` — the one deletion that works
unattended on Vercel CLI 59.11.7 (`project rm` has no `--yes`; the flag name is Vercel's, it means "the
confirmation was deliberate", it grants nothing extra). This happens on every `--check`, `--deploy` or
`--verify-db` of a **vercel** app with `postgres.scope: fresh`, `provider: neon` and no `DATABASE_URL_UNPOOLED` on
its project yet — once per candidate resource, and once more for a freshly created resource (which is created into
an inspection project too, then read the same way). Before creating one it also **sweeps** the team: every project
whose name matches `SCRATCH_RE` and whose `createdAt` is older than **30 minutes** (`SCRATCH_STALE_S`) is deleted
the same way, because a probe that died mid-run left a project holding a database URL. Younger matches are left
alone (a parallel run may be using one) and so is any match whose age cannot be read. Nothing else is ever
deleted: not the app's projects, not a Neon resource, not a Blob store, never anything named outside that pattern.
A deletion is reported only after Vercel answers 404 for the name; a lookup that merely failed prints a NOTE with the
dashboard path instead of claiming success.

For the VM target it instead REGENERATES `infra/vm/apps/x/` from the four state files (compose for the app's own
private-network Postgres, `.env.example`, README) and checks `.env`. The VM target verifies; it does not deploy — see
`infra/vm/README.md`.

**Provision, deploy mode.** `provision.py x --deploy` refuses if anything is missing, then mirrors the mold's own `Makefile deploy` target:

1. `drizzle-kit push` (the schema is the source of truth; the journal is two tables behind it), then the Drizzle migration journal, then the database bootstrap for a fresh Postgres. Drizzle does not model row-level security or the `app_rw` login role, so the mold's `.bootstrap-supabase.mjs` applies the org-isolation policies and creates that role without bypass rights; `DATABASE_URL` on all three projects then points at it — and `.claude/scripts/lib/verify-apprw.mjs` proves that exact URL is `app_rw`, `NOBYPASSRLS`, policied, encrypted and pooler-safe before it is written anywhere. Skipping this leaves the app connecting as a superuser with every isolation policy silently ignored. Re-runs reuse the deployed password, because rotating it invalidates deployments already built against the old one.
2. The task-workflow microservice from `services/task-workflow` (a Next.js app, preset `nextjs`), then the Eve API (`vercel build` with the experimental framework, shipped `--prebuilt`, preset `eve`), then the web dashboard. Presets are set through the API and verified by slug, since auto-detection picks Next.js for the Eve output and then rejects it.
3. The three health endpoints the Makefile checks: `<workflow>/api/health`, `<api>/eve/v1/health`, `<web>/api/ops/health`. Results land in `infrastructure.json` under `vercel.health`.

If the database is shared with live, it deploys web only with crons stripped so live jobs never run twice. VM apps are not deployed: `--deploy` refuses and points at `--verify-db`. Every URL is captured from the CLI output by pattern, never from the last line.

**Tenant isolation is a gate, not a label.** `datastores.postgres.rls` used to be the string `fail_closed`
in every app, written by intake regardless of provider, scope or tenancy, checked only against a JSON-schema
enum — while the deployed app's own health endpoint said `role postgres — WARNING: BYPASSRLS, row-level
security is NOT enforced`. It is now the application's *ask* (`fail_closed` for a multi-workspace app, `on`
for a single-workspace one, `off` for no isolation), and the evidence lives beside it in
`datastores.postgres.rls_verified`, written only by a live measurement — never by hand.

`.claude/scripts/lib/verify-apprw.mjs` is that measurement. It is handed the exact string that is about to
become `DATABASE_URL` (in the environment, never in argv) and runs eight checks inside one transaction that
ends in `ROLLBACK`: the role is the app role and is neither `SUPERUSER` nor `BYPASSRLS` (either one ignores
every policy, and the mold's own health endpoint only looks at the second); the wire is encrypted; a
transaction-local `set_config('app.org_id', …, true)` survives a round trip, which is what makes RLS hold
through a pooler; every `public` table carrying an `org_id` column — derived from `pg_attribute`, never from
a name list — has RLS enabled *and forced* and at least one permissive policy that scopes by `org_id` and not
one that does not; a row of workspace B is invisible while scoped to A and visible while scoped to B; a
cross-workspace `INSERT` is refused with SQLSTATE 42501 specifically; with `app.org_id` set to the empty
string a `fail_closed` app returns zero rows; and every permissive policy is additionally *executed* against
rows the check itself planted, because a predicate can name `org_id` and still say `OR true`. The read and
write probes run on every eligible table, not on one.

Why that shape: an earlier version of this gate checked the role, the wire and `count(pg_policies) > 0`, and
passed a database where `app_rw` was perfect and 37 of 52 org-scoped tables had no policy at all. A gate that
certifies the broken state is worse than no gate.

The gate has three teeth. `provision.py --deploy` writes `DATABASE_URL` in exactly one place, after the
proof. `provision.py <app> --verify-rls` re-proves whatever the app is running right now (repairing coverage
first unless `--no-repair`) and records the result — run it after any restore or migration. And
`factory.py validate` refuses an app that claims `on`/`fail_closed` while deployed and cannot show matching
evidence: same mode, same backend as the current provider (a proof against a local database is not a proof
about a Neon one), a non-superuser non-BYPASSRLS role, zero unprotected or unmeasured tables, zero foreign
rows read, and a cross-workspace write refused with 42501.

**The local database (`self_hosted`).** `self_hosted` is a Postgres for *verification on this box*, not a
deploy target: `provision.py` refuses to pair it with `target: vercel`, because reaching a private docker
network from a Vercel function would mean opening a Postgres port to the internet, and this droplet has no
firewall. `.claude/scripts/lib/localpg.py` runs `postgres:17` on the app's own `sf-<app_id>` network with a
self-signed certificate, `ssl=on`, and **no published host port** — `docker port` on the container is empty.
`localpg.py up` reads the merged compose config first and refuses to start anything that publishes a port
(including a hand-written `docker-compose.override.yml`), and removes the container if one appears anyway. The server listens on 6543 *inside* the container, which makes
`.bootstrap-supabase.mjs`'s hardcoded `appUrl.port = "6543"` a no-op instead of something to work around; the
mold scripts are run inside the network (`localpg.py run`) rather than the database being exposed to them.
TLS is not optional here: 48 of the mold's `.mjs` scripts pass `ssl: "require"` explicitly, which beats any
`sslmode` in the URL, so a plaintext server is simply unreachable by them. The generated password and the
server key live in `infra/vm/apps/<app_id>/`, which is created with its `.gitignore` already in place.

```
python3 .claude/scripts/provision.py <app> --verify-db    # bring it up, run the whole mold chain, prove app_rw
python3 .claude/scripts/lib/localpg.py down <app>         # remove the container and its volume
```

`--verify-db` rotates the app_rw password, so it is not a read-only check; `--verify-rls` does not.

**Never relink the mold directory.** Agents, workflows and deploys share `molds/<mold>/codebase`, and `vercel link` rewrites its project file for all of them. Every Vercel call passes `--project` instead; a relink mid-run once made the provisioner read another project's environment.

**Clone (live replica).** A brief that says "clone of live" stamps an app with `clone_of` set. `clone.py <app> run` does the rest in one go (extract, provision, deploy, snapshot, configure, regress) and stops with a plain sentence on the first failure. Step by step: `extract` reads the live surface tables into `application.surface`; after provision and deploy, `snapshot --apply` restores a `pg_dump` of live and copies the blob tree, `configure` upserts the surface, and `regress` diffs the clone against live table by table and writes the context-lane report. Live is only ever read. Details: `.claude/skills/clone/SKILL.md`, field mapping: `docs/STATE.md`.

**Branding.** An app carrying `surface.branding` is not built from the mold directly: `branding.py <app> prepare` copies the
mold source into `build/<app_id>/` and rewrites the product name, icon, sign-in mark and palette there, and `provision.py
--deploy` builds that copy. The snapshot is never edited, and each app gets its own build directory. The brand lives in the app's own state, copied from its product at stamp time, so nothing points at a shared file and an app
cannot change under it; `molds/<mold_id>/branding/rules.json` pins only WHERE each surface lives in that mold, and a rule that
stops matching refuses the deploy rather than shipping half-branded.

**Lanes.** Five test lanes per mold — functional, context, load, accessibility, responsiveness — run by one
runner, `.claude/scripts/lanes.py`:

```
python3 .claude/scripts/lanes.py <app_id>                 # all five, in order, stopping at the first fail
python3 .claude/scripts/lanes.py <app_id> --lane load     # one lane; repeatable
python3 .claude/scripts/lanes.py <app_id> --list          # harness or not, check count, what is blocking each
python3 .claude/scripts/lanes.py <app_id> --dry-run       # writes NO state and files NO task; reports go to <lane>/reports/dry/
```

Nothing about a lane is coded into the runner. Each lane declares itself in
`molds/<mold_id>/testing/<lane>/lane.json` against `lane.schema.json`: an order, a summary, what it does
*not* cover, and a list of checks, each a shell command plus what to expect of it (`exit`, `stdout`,
`stdout_not`) and `requires` preconditions that say in one sentence — with a runnable command in it — what
would make the check run. So a new check, harness or precondition in a future mold never edits the runner;
only a sixth *lane* would, because `application.testing` has one key per lane and a result for an unknown
lane has nowhere legal to live. A lane folder outside the five is announced on stdout, never ignored.

The rollup is deliberately hard to fake, in this order: no `lane.json`, no checks, or an unmet lane-level
precondition → `skipped`; any check failed → `fail`; every check *ran* and passed → `pass`; anything else
(at least one check skipped) → `skipped`. `pass` is never printed beside a command that did not execute.
`known_defect: <task_id>` is an annotation, not a mute — the three known mold defects still fail the
functional lane and still revert the app; the flag only links the task and stops a duplicate being filed.

A fail sets `application.status` to `reverted` and files a task against the mold, handing control back to
the operator; the runner is the only writer of `testing.<lane>` and the only status it may write is
`reverted`. Promotion stays with the operator. Every run writes
`molds/<mold_id>/testing/<lane>/reports/<app_id>-<date>.md`: the checks table, raw failure output, the
measured rows, what was skipped and what would unblock it, and what the lane does not cover. Output is
redacted for URLs-with-credentials, bearer tokens and token query parameters before it reaches a report.

Two harnesses were built for this round and both run against the application's own deployed URL under
Playwright chromium: `accessibility/a11y.mjs` (axe-core 4.13.0 WCAG 2.1 A/AA plus keyboard-only traversal
over `/`, `/onboard`, `/workspace`) and `responsiveness/responsive.mjs` (a 320/390/820/1440 viewport matrix
grading horizontal overflow, CLS, unreachable content, tap-target size and INP). Both refuse the vacuous
pass: a route that answers 200 and renders no interactive control fails rather than scoring zero
violations, and a `target-up` precondition first checks the URL is serving *this mold's* markup. The
`load` lane's harness is `testing/load/stress.py` (mold_v1-024, done): it builds the task-workflow service from
the snapshot, runs the mold's own stress spec against a throwaway private Postgres, and refuses to grade any of
its eight rows it did not measure.

**Product stage.** Tasks carry `advances_stage`. When every task for a stage is done, `factory.py close` moves the product forward: defined, stamped, lanes_passing, deployed, released.

## Secrets

Values never enter the repo, the state files, or the chat. State holds names; the store holds values (Vercel env for
Vercel targets, an env file on the VM for VM targets). Claude Code's auto-mode classifier blocks the agent from
writing secret values to Vercel env, even generated ones, so `provision.py` is run by a human for that step. The
check-and-report half runs fine from an agent. Two kinds of name appear in `infrastructure.json`: `secrets_user`
(only the user can supply: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM`,
plus `EXA_API_KEY` with web search on and `BROWSERBASE_API_KEY` with the browser on) and `secrets_derived` (the
factory mints or derives them during provisioning). The runbook for a new operator is `docs/RUNBOOK.md`.

**`OPS_SECRETS_KEY` is minted per app, and sealed rows do not travel.** The mold seals every connector credential
and browser credential with AES-256-GCM under `OPS_SECRETS_KEY` (`lib/secret-crypto.ts`; tables `connector_secrets`
and `browser_credentials`). `provision.py` mints a fresh 32-byte key for every app it provisions and never reads
another project's, and Vercel would not reveal it anyway. Consequences (task mold_v1-021):

- A fresh app imports nothing sealed. It starts with zero connectors and zero stored browser credentials; nothing
  in intake, provision or the lanes copies a sealed row in.
- A clone is the only path that restores rows from another app, and `clone.py snapshot --apply` clears
  `connector_secrets` and `browser_credentials` right after the restore and records the counts in
  `datastores.postgres.snapshot.cleared_sealed_rows`, because a row sealed under live's key would only fail at use.
- A restored dump from any other source (a hand `pg_restore`, a Neon branch) will carry rows the app cannot open.
  There is no factory command to re-key them, by design: re-keying needs the source key in a terminal.
- What an operator does when the app needs a connector: sign in to the app and enter it there (Ops -> connectors, or
  the browser-credentials screen), which seals it under this app's own key. Rotating the key later is the mold's
  `.rotate-connector-secrets.mjs` (`OPS_SECRETS_KEY_V<n>`), a human-terminal step, not a factory one.

## Access

- VM: SSH alias `digitalocean`, root. Provisioned by `infra/vm/provision.sh` (node 24, docker, Vercel CLI, Playwright).
- GitHub: this repo via a write deploy key; fde-agent via a read-only deploy key (alias `github-fde`).
- Vercel: CLI logged in on the VM; every project of a stamped app (`<project>`, `<project>-api`, `<project>-workflow`) is Node 24.x with Root Directory `.` — Git integration must stay disconnected; `provision.py` now enforces it (it disconnects each project right after the deploy that may have created it, and `--check` refuses to proceed while one is reconnected) so only `provision.py --deploy` creates deployments. A project the CLI creates from inside the factory checkout is auto-connected to `never2average/software-factory`, and every push then builds the factory root as that app: 39 failed production deployments, plus a poisoned build cache the next CLI deploy restores. Do not reconnect Git or set a Root Directory, both break CLI deploys from the mold dir. The live `fde-agent*` projects are off limits to the factory.

## Where things stand (2026-09-08)

| Item | Status |
|---|---|
| VM runtime | provisioned on node 24, docker 29.8, Playwright chromium; the mold typechecks and builds |
| Vercel | logged in; `claudecode-web`, `-api`, `-workflow` deployed for the replica |
| claudecode_web_internal | retired placeholder; its Supabase + Blob went to the replica |
| claudecode_web_replica | clone of live, deployed at `claudecode-web-opal.vercel.app`; **`reverted`** — the accessibility lane failed it on 2026-09-08 (task mold_v1-023) |
| Free tier | Supabase's free tier is exhausted (live + one factory app). Neon's is not, so `defaults.postgres_provider` is `neon` and app #2 onward costs nothing (mold_v1-015) |
| RLS gate | built and proven on new databases (mold_v1-016). The replica's *deployed* build still connects as `postgres` with BYPASSRLS — it predates the gate and its `datastores.postgres` still says `supabase` with no `rls_verified` (mold_v1-026) |
| Lanes | all five declared and runnable; run on the replica 2026-09-08: responsiveness **pass**, accessibility **fail** (1 of 2 checks), functional **fail** (15/20 pass, 4 fail — three are known mold defects 017/018/019, the fourth is the BYPASSRLS row), context **fail** (clone regression), load **skipped** at the time (stress harness landed afterwards, mold_v1-024) |
| Harnesses | accessibility (`a11y.mjs`, axe-core 4.13.0) and responsiveness (`responsive.mjs`) exist and run — mold_v1-007/008 closed. `testing/load/stress.py` exists (mold_v1-024); `lanes.py <app> --list` shows `load  yes  1  all met` |
| mold_v2, mold_v3 | backlog only — `MOLD.md` and a roadmap, no codebase, nothing stamped |

Run `python3 .claude/scripts/factory.py status` and `python3 .claude/scripts/lanes.py <app_id> --list` for the live view.
