# How the software factory works

The factory turns a mold (a known-good application codebase) into products (deployed, tested, sellable applications), driven by an operator: Fable (the model) plus sol (the human solutions engineer). Everything runs on the DigitalOcean VM at `/root/software-factory`.

## The four layers

```
brief (5 lines) ──intake──▶ state/application/<app_id>/ ──provision──▶ running app ──lanes──▶ product stage
                                     ▲                                                      │
                                     └──────────────── revert (failed lane → task) ◀────────┘
```

1. **Molds** (`molds/<mold_id>/`). A mold is a snapshot of a codebase plus its test lanes. `mold_v1` is fde-agent at a pinned commit: eve framework, Next.js 16, Drizzle on Postgres, Vercel Blob data room, GLM 5.2 on Cloudflare Workers AI. `mold_v2` and `mold_v3` are defined but empty. Molds are never edited in place; they are refreshed from upstream or forked.

2. **State** (`state/`). JSON that describes the factory and every application, validated by schemas.
   - `factory.json`: operator, the six-item service surface, the molds, the service/revert loop, and `defaults` (the answers that apply to every app).
   - `products.json`: products with a stage and the gates for each stage. Several products may share a mold — the same
     codebase under different brands and packaging — so a brief says which with `product: <id>`, and the product's `brand` is
     copied into the app. mold_v1 carries `delivered` and `dover`.
   - `tasks/<mold_id>.jsonl`: the backlog. Closing tasks advances products.
   - `application/<app_id>/`: four files per stamped app: application, infrastructure, datastores, datainfra. Secrets appear by name only.

3. **Scripts** (`.claude/scripts/`). Stdlib Python, no dependencies.
   - `factory.py`: status, next, tasks, add, set, close, validate.
   - `intake.py`: brief in, four state files out, questions for anything unresolved.
   - `provision.py`: state in, datastores created, secrets checked by name, deploy.

4. **Agents, skills, workflows** (`.claude/`, mirrored to `.agents/`). Thin wrappers that tell an agent which script to run and what it may and may not do. `intake` asks the user; `provisioner` deploys; `mold-engineer`, `lane-tester`, `product-packager` work backlog tasks.

## Describe to deploy, step by step

**Intake.** `intake.py briefs/x.md --app x` reads the brief for hints (target, customer, domain, "no browser", "no web search"), fills what factory defaults cover, and writes `questions.json` for the rest, exiting 2. The `intake` subagent asks those questions in batches of four and re-runs with `--answers`. The first intake ever also confirms the defaults; after that a new app asks one question: fresh database or shared with live. Output: validated state, app registered in `factory.json` and under its product.

**Provision, check mode.** `provision.py x` links the mold to the app's Vercel project, then for a fresh database creates a Supabase project and a Blob store through the Vercel Marketplace (env vars injected automatically), mints the app-internal secrets (cron secret, ops key, sign-in key pair), derives `DATABASE_URL`, and finally lists every secret name still missing. External credentials (Cloudflare, Resend, Exa) are copied by name from the live project (`defaults.secret_source_project`) when missing; only a credential that exists nowhere in the team is left for the user. For the VM target it instead writes a Dockerfile, compose file and `.env.example` under `infra/vm/apps/x/` and checks `.env`.

**Provision, deploy mode.** `provision.py x --deploy` refuses if anything is missing, then mirrors the mold's own `Makefile deploy` target:

1. Drizzle migrations, then the database bootstrap for a fresh Postgres. Drizzle does not model row-level security or the `app_rw` login role, so the mold's `.bootstrap-supabase.mjs` applies the org-isolation policies and creates that role without bypass rights; `DATABASE_URL` on all three projects then points at it. Skipping this leaves the app connecting as a superuser with every isolation policy silently ignored. Re-runs reuse the deployed password, because rotating it invalidates deployments already built against the old one.
2. The task-workflow microservice from `services/task-workflow` (a Next.js app, preset `nextjs`), then the Eve API (`vercel build` with the experimental framework, shipped `--prebuilt`, preset `eve`), then the web dashboard. Presets are set through the API and verified by slug, since auto-detection picks Next.js for the Eve output and then rejects it.
3. The three health endpoints the Makefile checks: `<workflow>/api/health`, `<api>/eve/v1/health`, `<web>/api/ops/health`. Results land in `infrastructure.json` under `vercel.health`.

If the database is shared with live, it deploys web only with crons stripped so live jobs never run twice. VM: `docker compose up -d --build`. Every URL is captured from the CLI output by pattern, never from the last line.

**Never relink the mold directory.** Agents, workflows and deploys share `molds/<mold>/codebase`, and `vercel link` rewrites its project file for all of them. Every Vercel call passes `--project` instead; a relink mid-run once made the provisioner read another project's environment.

**Clone (live replica).** A brief that says "clone of live" stamps an app with `clone_of` set. `clone.py <app> run` does the rest in one go (extract, provision, deploy, snapshot, configure, regress) and stops with a plain sentence on the first failure. Step by step: `extract` reads the live surface tables into `application.surface`; after provision and deploy, `snapshot --apply` restores a `pg_dump` of live and copies the blob tree, `configure` upserts the surface, and `regress` diffs the clone against live table by table and writes the context-lane report. Live is only ever read. Details: `.claude/skills/clone/SKILL.md`, field mapping: `docs/STATE.md`.

**Branding.** An app carrying `surface.branding` is not built from the mold directly: `branding.py <app> prepare` copies the
mold source into `build/<app_id>/` and rewrites the product name, icon, sign-in mark and palette there, and `provision.py
--deploy` builds that copy. The snapshot is never edited, and each app gets its own build directory. The brand lives in the app's own state, copied from its product at stamp time, so nothing points at a shared file and an app
cannot change under it; `molds/<mold_id>/branding/rules.json` pins only WHERE each surface lives in that mold, and a rule that
stops matching refuses the deploy rather than shipping half-branded.

**Lanes.** Five test lanes per mold: functional, context, load, accessibility, responsiveness. Results are written per lane into `application.json`. Any failure sets the app to `reverted` and files a task, returning control to the operator. Accessibility and responsiveness harnesses do not exist yet (tasks mold_v1-007/008).

**Product stage.** Tasks carry `advances_stage`. When every task for a stage is done, `factory.py close` moves the product forward: defined, stamped, lanes_passing, deployed, released.

## Secrets

Values never enter the repo, the state files, or the chat. State holds names; the store holds values (Vercel env for Vercel targets, an env file on the VM for VM targets). Claude Code's auto-mode classifier blocks the agent from writing secret values to Vercel env, even generated ones, so `provision.py` is run by a human for that step. The check-and-report half runs fine from an agent.

## Access

- VM: SSH alias `digitalocean`, root. Provisioned by `infra/vm/provision.sh` (node 24, docker, Vercel CLI, Playwright).
- GitHub: this repo via a write deploy key; fde-agent via a read-only deploy key (alias `github-fde`).
- Vercel: CLI logged in on the VM; every project of a stamped app (`<project>`, `<project>-api`, `<project>-workflow`) is Node 24.x with Root Directory `.` — Git integration must stay disconnected; `provision.py` now enforces it (it disconnects each project right after the deploy that may have created it, and `--check` refuses to proceed while one is reconnected) so only `provision.py --deploy` creates deployments. A project the CLI creates from inside the factory checkout is auto-connected to `never2average/software-factory`, and every push then builds the factory root as that app: 39 failed production deployments, plus a poisoned build cache the next CLI deploy restores. Do not reconnect Git or set a Root Directory, both break CLI deploys from the mold dir. The live `fde-agent*` projects are off limits to the factory.

## Where things stand (2026-09-06)

| Item | Status |
|---|---|
| VM runtime | provisioned on node 24, mold typechecks and builds |
| Vercel | logged in, project linked, nothing deployed |
| claudecode_web_internal | retired placeholder; its Supabase + Blob went to the replica |
| claudecode_web_replica | clone of live, surface extracted, uses project claudecode-web; `clone.py run` continues from provision |
| Free tier | Vercel Marketplace allows two free Supabase projects per team (live + one factory app). Further apps need VM Postgres (mold_v1-015) |
| Lanes | none run; two harnesses missing |
| mold_v2, mold_v3 | backlog only |

Run `python3 .claude/scripts/factory.py status` for the live view.
