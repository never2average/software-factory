# The FDE workflow

How a Forward-Deployed Engineer operates this platform, and where every kind of
work lands in the data room. This is the backbone the FDE **skills** are built on
— each skill tells the agent *where to read* and *where to write* against the tree
below, and this doc is the shared map.

The data-room tree is defined in [`dm.md`](../dm.md). Postgres (Neon, via Drizzle)
is the **system of record**; the blob data room holds the documents, transcripts,
and artifacts that don't fit a table. Everything is reached two ways: the **Ops
Center** in the browser, and the **`fde` MCP** from your coding agent (see
[`setup/TEAM-SETUP.md`](../setup/TEAM-SETUP.md)).

---

## The lifecycle

An FDE takes a customer from first contact to a running, evaluated deployment, and
keeps the system of record honest the whole way. The stages map onto the top-level
data-room folders:

| Stage | What happens | System of record | Data room |
| --- | --- | --- | --- |
| **0. Onboard yourself** | Get wired to the platform and known to the system | `memories` (team) | — |
| **1. Onboard a customer** | Create the account, seed context, assign owners | `customers`, `internal_staff`, `customer_stakeholders` | `Customers/{id}/` |
| **2. Research the account** | Build the domain workbooks & relationship map | `interactions` | `Customers/{id}/context.md`, `syncs/` |
| **3. Scope & design** | Pick platform version, design decisions | `platform`, `solutions` | `Platform/`, `Solutions/` |
| **4. Deploy** | Stand up infra; run the 4-party signoff chain | `deployments` | `Deployments/{id}/{ver}/` |
| **5. Migrate & integrate** | Backfill data; wire pipelines/integromat | `implementation` | `Implementation/{id}/`, `Deployments/{id}/{ver}/platform/` |
| **6. Operate** | Tickets, evals, follow-ups, SLAs | `tickets`, `automation_runs` | `Tickets/`, `Solutions/.../evals/` |

The **subagents** the orchestrator delegates to line up with the stages:
`research` (2), `configuration` (3), `deployment` (4), `data-migration` (5),
`customer-context` (2/6), `evals` (6), `follow-ups` (6).

---

## Where things live (read/write map)

Skills annotate these paths with `← you write this`. The canonical tree is `dm.md`;
the high-traffic FDE paths:

```
Customers/{customer_id}/
  context.md              ← account context, curated by the FDE / customer-context
  interactions.jsonl      ← append-only log of touchpoints (mirrors `interactions`)
  agreements/             ← MSAs, order forms
Deployments/{customer_id}/{platform_version_id}/
  infrastructure/.../signoff/   ← 4-party signoff (internal, infra, infosec, cloud)
  platform/
    migrations/{migration_id}/  ← the migration approach + interactions
    pipelines/{pipeline_id}/    ← pipeline_config.json (+ private.integromat.json)
    integromat.json
Implementation/{customer_id}/
  migrations/{migration_id}/    ← in-flight migration working set
  pipelines/{pipeline_id}/
Tickets/{feat|bug|docs|...}/{customer_id}/{platform_id}/tickets_*.jsonl
People/{person_id}/            ← EXTERNAL people only (stakeholders, contacts)
```

**Never** write customer content outside its `{customer_id}` subtree, and never put
internal staff under `People/` (that tree is external-only; FDEs are recorded as a
team memory — see the `onboard-self` skill).

---

## The FDE skills

Each skill is a guided, step-at-a-time procedure. They share the scripts under
[`scripts/fde/`](../scripts/fde/) (run with `node --experimental-strip-types`, wired
as `npm run fde:*`).

| Skill | Use it to | Backing script |
| --- | --- | --- |
| `onboard-self` | Get yourself operational as an FDE and recorded in the system | `fde:onboard-self` |
| `onboard-customer` | Create a customer, seed its context, assign owners | `fde:new-customer` |
| `configure-platform` | Author a platform version's schema contract + customer governance | `fde:configure-platform` |
| `configure-solution` | Scaffold a reusable pipeline solution (a minified solution-manager) | `fde:configure-solution` |
| `configure-agents` | Scaffold a reusable agent solution (the agents sibling) | `fde:configure-agents` |
| `configure-infra` | Scaffold a deployment's infra substrate + the 4-party signoff | `fde:configure-infra` |
| `backfill-customization-history` | Reconstruct a customer's deployment/customization history into `Deployments/` | `fde:backfill-customizations` |
| `backfill-integration-history` | Reconstruct pipeline/integromat integration history into `Implementation/` | `fde:backfill-integrations` |

Shared gate: **`fde:validate-solution`** structurally validates any configured
solution (schema parses, artifact/recipe filled, evals seeded) — advisory by
default, `--strict` to gate.

### When the agent's bash tools stop working

Each agent node (root + every subagent) runs bash in a Vercel Sandbox created
from a **named template snapshot** in the `fde-agent-api` project. The template
key is derived from that node's sandbox source, and a deployed function cannot
build one on demand — it fails every bash call with `Sandbox template
"eve-sbx-tpl-vercel-…" is not provisioned`, which reads to the user as "the
sandbox won't spin up". Templates are built by `eve build` inside the Vercel
builder, so a prebuilt deploy, `--skip-sandbox-prewarm`, or a half-failed
prewarm leaves production with a missing template.

```
npm run build:eve                  # keys come from .output, not the source tree
npm run fde:sandbox -- --check     # which templates are missing (exit 1 if any)
npm run fde:sandbox                # build the missing ones
```

Both need `VERCEL_OIDC_TOKEN` for the **agent API** project (not the front-end
one); the script prints how to pull it.

### Folder context graphs

Every folder's required structure is **derived** from the dm.md grammar
(`DATAROOM_PATH_TEMPLATES`), never hand-authored — so it can't drift:

- **`fde:context-graph -- --path "Customers/{id}"`** (or `--customer {id}`) — the
  computed graph for a folder: required files/dirs (from the templates), what's
  present, what's missing, and live `[[edges]]` (a customer → its deployments,
  implementation, tickets, stakeholders — the same `[[wikilink]]` vocabulary the
  memory system uses).
- **`fde:doctor [--customer {id}] [--strict]`** — walks customer folders and
  reports missing required files / dangling edges against their context graph. The
  dm.md-driven, structural analogue of solution-manager's `doctor.ts`.

The graph is computed on demand from the single source (the templates), so the
dataroom tree, the skills' READ/WRITE maps, and this check all agree by
construction.

Start with **`onboard-self`** — you can't do the rest until you're wired in. Then
`onboard-customer`.

### The configure family (the fractal)

`configure-*` nests as a contract → instance → substrate hierarchy:

- **`configure-platform`** owns the **contract**: `Platform/{ver}/design_decisions/
  *.schemas.json`, shared across customers.
- **`configure-solution`** / **`configure-agents`** author **reusable solutions**
  bound to that contract. A configured solution is a *minified solution-manager* —
  a self-describing unit (schema + artifact + evals + migrations + grounding), not a
  fork of the tooling. The machine (`fde:*`) stays central; each solution is data it
  runs. The `OnFinance/solution-manager` PR gate maps onto **eval acceptance + the
  deployment signoff**, not git.
- **`configure-infra`** provisions the per-deployment **substrate** the solution
  runs on, and a customer's `Deployments/.../platform/{pipelines,agents}/{id}/` is
  the **instance** seeded from a solution's recipe.
