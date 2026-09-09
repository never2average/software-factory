# Products: what the factory ships

A **mold** is a codebase snapshot plus its five test lanes. A **product** is a mold under a brand, with stage
gates. An **application** is one stamped, deployable instance of a product. `state/products.json` (schema
`state/products.schema.json`) is the only list of products; `factory.py validate` checks it.

## A product is

| Field | Meaning |
|---|---|
| `product_id`, `name`, `tagline` | identity. `tagline` is the line under the sign-in wordmark |
| `mold_id` | the codebase it is stamped from. Several products may share one mold (`delivered` and `dover` both sit on mold_v1) and they share that mold's backlog `state/tasks/<mold_id>.jsonl` |
| `stage` | `defined` → `stamped` → `lanes_passing` → `deployed` → `released`. Written only by `factory.py close` when every task carrying that `advances_stage` is done; never by hand |
| `gates` | the plain-English conditions for each stage, the checklist the `productize` skill turns into tasks |
| `app_ids` | the applications stamped from it (intake appends; a retired or reverted app stays listed with its status in its own state) |
| `deploy_targets` | `vercel` (the one committed deploy target) and/or `vm` (local verification only) |
| `vercel_project` | project name for the product's first app; later apps get `<project>-<suffix>` |
| `brand` | the visual identity: `product_name`, `tagline`, `description`, `brand_color`, `neutral_chroma`, `radius`, `icon_bg`/`icon_fg`, a 32x32 `icon_svg`, and optional light/dark `tokens` overrides |

## What an application carries

At stamp time `intake.py` copies the product's identity **into** `state/application/<app_id>/`, so an app is
self-contained and editing the product later does not change an app that already exists:

- `application.product_id`, and `application.surface.branding` = a full copy of `brand` (icon inline).
- The **surface** — one block per item of the factory's service surface (`state/factory.json`): `dm.md` (the data
  room folders), `browser` and `web_search` (on/off), `primary_context` (the corpus the agent knows),
  `multiplayer_context` (the team's processes), `custom_workflow_builder` (the workflow library). Field-by-field
  mapping to the mold: `docs/STATE.md`.
- `workspace`: the org, the FDE identity, members and roles, the roster.
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
four crons; GLM 5.2 on Cloudflare Workers AI as the only model. The customer brings four credentials
(`docs/RUNBOOK.md` §0). Inference cost per workspace: `docs/COST_MODEL.md`.

## Stage gates for mold_v1 products (`delivered`, `dover`)

| Stage | Gate | True today? |
|---|---|---|
| stamped | state filled against all four schemas; mold builds on the VM | both apps of `delivered` were stamped; `dover` has none |
| lanes_passing | all five lanes pass; every lane has a harness | all five harnesses exist (load's `stress.py` landed with mold_v1-024); no app has all five passing — the replica is `reverted` on the accessibility lane |
| deployed | production URL on Vercel; secrets by name only; GLM 5.2 configured and smoke-tested | the replica is deployed at `claudecode-web-opal.vercel.app` but predates the RLS gate (mold_v1-026) |
| released | onboarding path works end to end (`fde:onboard-self`, `fde:new-org`, `fde:new-customer`); docs + pricing/packaging decided; inference budget per workspace known | docs exist as of this file; the onboarding path has not been executed end to end on a stamped app; pricing is a placeholder in the cost model |

Both products are at `defined`: a stage only moves when the tasks that carry it close, and no task has.

## What a product is not

Not a tenant: one application can serve many workspaces (`multi_tenant`, RLS `fail_closed`). Not a customer:
`customer_id` is a field on the app. Not a fork: a product that needs different code is a new mold (`mold_v2`,
`mold_v3` are scope, not status — no codebase, nothing stamped).
