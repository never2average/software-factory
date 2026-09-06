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
   - `products.json`: one product per mold with a stage and the gates for each stage.
   - `tasks/<mold_id>.jsonl`: the backlog. Closing tasks advances products.
   - `application/<app_id>/`: four files per stamped app: application, infrastructure, datastores, datainfra. Secrets appear by name only.

3. **Scripts** (`.claude/scripts/`). Stdlib Python, no dependencies.
   - `factory.py`: status, next, tasks, add, set, close, validate.
   - `intake.py`: brief in, four state files out, questions for anything unresolved.
   - `provision.py`: state in, datastores created, secrets checked by name, deploy.

4. **Agents, skills, workflows** (`.claude/`, mirrored to `.agents/`). Thin wrappers that tell an agent which script to run and what it may and may not do. `intake` asks the user; `provisioner` deploys; `mold-engineer`, `lane-tester`, `product-packager` work backlog tasks.

## Describe to deploy, step by step

**Intake.** `intake.py briefs/x.md --app x` reads the brief for hints (target, customer, domain, "no browser", "no web search"), fills what factory defaults cover, and writes `questions.json` for the rest, exiting 2. The `intake` subagent asks those questions in batches of four and re-runs with `--answers`. The first intake ever also confirms the defaults; after that a new app asks one question: fresh database or shared with live. Output: validated state, app registered in `factory.json` and under its product.

**Provision, check mode.** `provision.py x` links the mold to the app's Vercel project, then for a fresh database creates a Supabase project and a Blob store through the Vercel Marketplace (env vars injected automatically), mints the app-internal secrets (cron secret, ops key, sign-in key pair), derives `DATABASE_URL`, and finally lists every secret name still missing. External credentials (Cloudflare, Resend, Google) are always the user's to set with `vercel env add`. For the VM target it instead writes a Dockerfile, compose file and `.env.example` under `infra/vm/apps/x/` and checks `.env`.

**Provision, deploy mode.** `provision.py x --deploy` refuses if anything is missing. Vercel: deploys the web app, then the eve API and workflow service as `<project>-api` and `<project>-workflow`, mirroring how the live app is split. If the database is shared with live, it deploys web only with crons stripped so live jobs never run twice. VM: `docker compose up -d --build`. The production URL lands in `infrastructure.json`.

**Lanes.** Five test lanes per mold: functional, context, load, accessibility, responsiveness. Results are written per lane into `application.json`. Any failure sets the app to `reverted` and files a task, returning control to the operator. Accessibility and responsiveness harnesses do not exist yet (tasks mold_v1-007/008).

**Product stage.** Tasks carry `advances_stage`. When every task for a stage is done, `factory.py close` moves the product forward: defined, stamped, lanes_passing, deployed, released.

## Secrets

Values never enter the repo, the state files, or the chat. State holds names; the store holds values (Vercel env for Vercel targets, an env file on the VM for VM targets). Claude Code's auto-mode classifier blocks the agent from writing secret values to Vercel env, even generated ones, so `provision.py` is run by a human for that step. The check-and-report half runs fine from an agent.

## Access

- VM: SSH alias `digitalocean`, root. Provisioned by `infra/vm/provision.sh` (node 24, docker, Vercel CLI, Playwright).
- GitHub: this repo via a write deploy key; fde-agent via a read-only deploy key (alias `github-fde`).
- Vercel: CLI logged in on the VM; factory project `claudecode-web`. The live `fde-agent*` projects are off limits to the factory.

## Where things stand (2026-09-06)

| Item | Status |
|---|---|
| VM runtime | provisioned on node 24, mold typechecks and builds |
| Vercel | logged in, project linked, nothing deployed |
| claudecode_web_internal | intake done, fresh database chosen, provisioner not yet run |
| Lanes | none run; two harnesses missing |
| mold_v2, mold_v3 | backlog only |

Run `python3 .claude/scripts/factory.py status` for the live view.
