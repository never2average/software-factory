# Products: what the factory ships

A **mold** is a codebase snapshot plus its five test lanes. A **product** is a mold under a brand, with stage
gates. An **application** is one stamped, deployable instance of a product. `state/products.json` (schema
`state/products.schema.json`) is the only list of products; `factory.py validate` checks it.

## A product is

| Field | Meaning |
|---|---|
| `product_id`, `name`, `tagline` | identity. `tagline` is the line under the sign-in wordmark |
| `mold_id` | the codebase it is stamped from. Several products may share one mold (`delivered`, `dover` and `onfinance_hfc_research` all sit on mold_v1) and they share that mold's backlog `state/tasks/<mold_id>.jsonl`; a gate task names its product (`factory.py add ... --product <id> --advances <stage>`) and only moves that product |
| `stage` | `defined` → `stamped` → `lanes_passing` → `deployed` → `released`. Written only by `factory.py close` when every task carrying that `advances_stage` is done; never by hand |
| `gates` | the plain-English conditions for each stage, the checklist the `productize` skill turns into tasks |
| `app_ids` | the applications stamped from it (intake appends; a retired or reverted app stays listed with its status in its own state) |
| `deploy_targets` | `vercel`, `vm` (local verification only) and/or `vm_remote` (a server of the customer's own over SSH, `docs/RUNBOOK.md` §9; in production since 2026-10-04 as `onfinance_hfc_vm` on a DigitalOcean `s-4vcpu-8gb`, mold_v1-150) |
| `target_model` | the model the product's apps actually run, in words (each app's exact ids are in its `application.model`) |
| `vercel_project` | project name for the product's first app; later apps get `<project>-<suffix>` |
| `brand` | the visual identity. Set it from three inputs and let the rest derive: `python3 .claude/scripts/branding.py --product <id> set --name "Acme Ops" --color #1F6F5C --logo brands/acme/logo.png` (optional `--tagline`). The stored block also carries the derived fields (`description`, `neutral_chroma`, `radius`, `icon_bg`/`icon_fg`, the inlined `icon_svg`, optional `tokens` pins) for a designer who wants an exact value |

## What an application carries

At stamp time `intake.py` copies the product's identity **into** `state/application/<app_id>/`, so an app is
self-contained and editing the product later does not change an app that already exists:

- `application.product_id`, and `application.surface.branding` = a full copy of `brand` (icon inline).
- The **surface** — one block per item of the factory's service surface (`state/factory.json`): `dm.md` (the data
  room folders), `browser` and `web_search` (on/off), `primary_context` (the corpus the agent knows),
  `multiplayer_context` (the team's processes), `custom_workflow_builder` (the app's own workflow scripts and definitions, and whether new workspaces get the account-delivery starter library). Field-by-field
  mapping to the mold: `docs/STATE.md`.
- `workspace`: the org, the operator identity, members and roles, the roster.
- `infrastructure.json`: target, Vercel projects, secret **names** (`secrets_user` the customer supplies,
  `secrets_derived` the factory mints), the runtime env flags. `datastores.json`: Postgres provider, scope, the
  RLS ask and its evidence. `datainfra.json`: where the data room physically lives.

How the brand reaches the build: mold_v1 has no theme system, so `branding.py <app> prepare` copies the snapshot
to `build/<app_id>/` and rewrites product name, tagline, description, icon, sign-in mark and palette there;
`provision.py --deploy` builds that copy. `molds/mold_v1/branding/rules.json` pins where each surface lives, and a
rule that stops matching refuses the deploy rather than shipping half-branded. Outgoing emails (invites, sign-in
codes) carry the product name too.

## What ships, concretely (mold_v1)

Three Vercel deployments per application — the web dashboard (Next.js), the eve agent API, the task-workflow
service — on the projects `<project>`, `<project>-api`, `<project>-workflow`; one free Neon Postgres with an
`app_rw` role and row-level security proven before `DATABASE_URL` is written; one private Vercel Blob store;
six crons (`vercel.json`); and one inference provider chosen at intake (`infrastructure.inference.provider`):

| `inference_provider` | model the app runs (`application.model`) | credential the customer brings | `MODEL_PROVIDER` |
|---|---|---|---|
| `cloudflare_workers_ai` (default) | `@cf/zai-org/glm-5.2` (GLM 5.2), context window 262144; `factory.defaults.inference_model` can override the id | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | `cloudflare` |
| `vercel_ai_gateway` | `anthropic/claude-sonnet-5` (Claude Sonnet 5, the mold's free-tier-safe default; the gateway's free tier refuses Opus); no context window recorded, the gateway looks it up | `AI_GATEWAY_API_KEY` | `gateway` |

Everything else — projects, database, Blob, crons, RLS gate, branding — is the same for both. On `vm_remote` the same
three services run as systemd units on the customer's server instead, with Postgres and file storage on its own disk,
six scheduled jobs, and microVM sandboxes (`docs/RUNBOOK.md` §9). The customer also
brings `RESEND_API_KEY`, `PLATFORM_NOTIFY_FROM` and the Google OAuth client id `GOOGLE_CLIENT_ID` (one
`--set-secret` writes it under both names the app reads), and `EXA_API_KEY` / `BROWSERBASE_API_KEY` when web search /
the browser are on: five credentials on Cloudflare, four on the gateway (`docs/RUNBOOK.md` §0, `intake.py`
`secrets_user`). Per role, a Cloudflare app may name its own models in `application.model.roles`; the deploy writes
them as `CLOUDFLARE_MODEL_ORCHESTRATOR` / `CLOUDFLARE_MODEL_SPECIALIST`. Inference cost
per workspace: `docs/COST_MODEL.md` (Cloudflare path only; the gateway path is not costed yet).

## Where each product stands

`stage` in `state/products.json`, moved only by `factory.py close`. The gate text per stage is in the same file;
`factory.py tasks <mold_id> --all` lists the task per gate with its evidence. A product may also carry `gate_evidence`
(optional, `products.schema.json`): per stage, each gate with the evidence that exists today and, for an open one,
exactly what closes it. It is a record, not a switch: `stage` still moves only through `factory.py close`.

| Product | Mold | Stage | Apps | Deploy targets |
|---|---|---|---|---|
| `delivered` | mold_v1 | released | claudecode_web_internal, claudecode_web_replica, sf_gateway_probe | vercel |
| `dover` | mold_v1 | released | none | vercel |
| `onfinance_hfc_research` | mold_v1 | released | onfinance_hfc (Vercel), onfinance_hfc_vm (own server) | vercel, vm_remote |
| `compliance_os` | mold_v1 | deployed | compliance_os | vercel |
| `mcp_product_shell` | mold_v0 | stamped (gates and their evidence: `gate_evidence` in `state/products.json`) | octillion, maxwell | vercel, compose_remote |
| `claudecode_web_governed` | mold_v2 | defined | none | vercel, vm |
| `claudecode_web_research` | mold_v3 | defined | none | vercel, vm |

`onfinance_hfc_research` runs on Cloudflare Workers AI with a model per role: GLM 5.3 for both roles on
`onfinance_hfc`; Kimi K2.6 orchestrating and GLM 5.3 as specialist on `onfinance_hfc_vm`. Its pricing and
packaging are not decided yet (a `released` gate, mold_v1-211; the options and a recommendation are in
`docs/customer-notes/pricing-options.md`); what it costs to run, per turn, per specialist run, per person and per
workspace, is in `docs/COST_MODEL.md` §2b, §2c and §7.

## What ships, concretely (mold_v0)

`mcp_product_shell` is the MCP product shell (`molds/mold_v0/MOLD.md`): an API and MCP server with a web console in
front of it, on Vercel as two projects (`<project>-api`, the function, with the app's own free Neon Postgres;
`<project>`, the Next.js console, which people open and which carries the API's paths) or as one Docker Compose stack
with HTTPS on a server of the app's own (`compose_remote`). Every app gets the same shell: accounts (each a workspace,
under row-level security), sign-in (Clerk, or the built-in emailed code and Google), install pages for every MCP client
(`/install`), a key vault, an inference gateway that meters every model call, sandboxed runs with an egress allowlist,
record areas, schedules, onboarding steps, usage, billing and email, and a staff console (`/admin`). What an app is,
it gets from **a pack** (`packs/<pack_id>/`: one `pack.json` declaring its records, runs, credentials, schedules,
onboarding, words, charts, landing page and customer guide; config only, no code) and **a brand**. Two apps today: the
re-mint of the first product (`octillion`, its host pack, live with users) and an audit product made from a pack and a
brand only (`maxwell`). The operator's path, brief to first customer: `docs/RUNBOOK.md` §11.

Customer-facing documentation is part of the build, never a separate site: the public install pages (`/install`, one
per client, and `/install/tools`, every tool with its inputs), the customer guide in the console (`/app/docs`: the
pack's own pages, then the pages the console writes from the pack's declarations: getting started and connecting a
client, the console, the records, the runs, the MCP tools, the account; plus the on-premises runner when a run kind may
need a private network), the staff guide (`/admin/docs`) and the data-flow statement each build writes (`DATA-MAP.md`).
A pack's guide pages are `pack.json` `guide.markdown`.

## mold_v0: packaging and pricing

**Pricing: operator decision pending.** Nothing is charged today. No price below is a proposal: this lists what the
shell can already do, so the decision is one choice plus its numbers. What is fixed today, from the app's state:

| Today (maxwell) | Value | Where it is set |
|---|---|---|
| ceiling on one audit's model spend | US$40 | `application.json` `profile.limits.runs.budget_usd_max` (brief, `## Budgets`, operator 2026-10-22); the shell's default is 25 and the most an app may set is 200 (`molds/mold_v0/branding/rules.json` `profile.app_limits_max`) |
| ceiling per audit kind, per company, per month | US$500 | `profile.limits.runs.kind_month_budget_usd` (same); default 200, at most 2000 |
| what one audit actually costs | PLACEHOLDER: not measured yet | the first end-to-end audit (ticket mold_v0-030) measures it; the console's **Overview** (Audit cost) and **FinOps** show it per run |
| a company's monthly allowance for model spend | none set: a company with no plan and no allowance has US$0 and cannot start an audit (unless the API project sets a default, `APP_ORG_MONTHLY_BUDGET_USD`) | staff set it per company (below) |

The options, each already built in the shell (`molds/mold_v0/codebase/docs/accounts.md`, `src/billing.ts`,
`src/run-charges.ts`, `src/entitlements.ts`):

| Option | What the customer pays for | What it takes |
|---|---|---|
| **A. Allowance only** (pilot, or invoiced outside the app) | nothing in the app; a monthly cap on model spend per company | staff set it on the account (**Set monthly allowance…**, or the staff MCP tool `set_account_allowance`). No Stripe |
| **B. Prepaid plans** | a monthly or yearly fee that includes a model-spend allowance; optionally usage pricing in tiers above it, a trial, and pricing experiments with weights | `provision.py <app> --set-secret STRIPE_SECRET_KEY`, then plans made in **FinOps › Plans › New plan** (or `create_plan`, dry run first); plans are invite-only per account (`allow_prepaid_plans`). `APP_REQUIRE_SUBSCRIPTION=1` makes a live plan required to start runs |
| **C. Price per audit** | each finished audit: a fixed amount, and/or its metered model cost plus a percent; failed and cancelled audits free unless allowed | the shell's price per run (mold_v0-019, built, off by default): the app's profile `billing` and a `price` on each job kind in the pack; charged once per run through a Stripe meter, or kept in a ledger without Stripe. **Needs one reviewed factory change first**: `billing` is not a profile field an app may set yet (`docs/INTAKE.md`) |
| **D. Plans with audits included or charged** | B, with each plan saying which features it unlocks (runs, schedules) and whether its audits are included or charged as in C | plan entitlements (mold_v0-083, built) and limits per plan (`profile.limits.plans.<plan>`, which an app may set). Entitlements need the same factory change as C |

Inside a company, its own admins split the allowance (shared pool, even split or caps per person, team budgets) on
**Limits**, whatever the option. To decide: pick A, B, C or D, and give the numbers it needs (the allowance; or each
plan's name, fee, interval and included allowance; or the fixed amount or percent per audit). The agent then writes
them where the table says.

Packaging, decided by how the shell is built rather than by price: one company per workspace; hosted on Vercel or on
a server of the customer's own (`compose_remote`); audits of systems inside a private network through the on-premises
runner when such audits are offered (`molds/mold_v0/codebase/docs/on-premises-runner.md`).

## What a product is not

Not a tenant: one application can serve many workspaces (`multi_tenant`, RLS `fail_closed`). Not a customer:
`customer_id` is a field on the app. Not a fork: a product that needs different code is a new mold (`mold_v2`,
`mold_v3` are scope, not status — no codebase, nothing stamped).
