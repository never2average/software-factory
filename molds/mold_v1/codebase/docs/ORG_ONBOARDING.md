# Org onboarding & the control plane

How a company (a **workspace**, `org_id` at the schema level) is provisioned on
the platform, how tenant isolation works, and the exact order to roll it out.
The product is **Delivered**; OnFinance is org #1 (`onfinance`).

This is the operator runbook for the multi-tenant layer added *above*
`customers` / `people_roster` / `connectors` / `workflows`. Design plan:
`plan-org-onboarding-control-plane.md`.

## The model

Row-level `org_id` scoping on one Neon DB + one Vercel deployment (plan option
1). Every global table carries a nullable `org_id`; customer-scoped tables
inherit their org through the `customer_id` FK. Enforcement is **structural**
(`lib/org-context.ts` + `orgDb`), not per-route discipline.

**Fail-safe first.** Every new code path resolves to the single implicit org
(`onfinance`) until (a) the tenancy migration runs and (b) the multi-tenant gate
is deliberately turned on. Nothing changes for the existing single-org world in
between.

## Roll-out order (STRICT)

1. **Review the DDL**, then run the migration:
   ```
   ! node .migrate-org-tenancy.mjs
   ```
   Additive, idempotent, **nullable-first**: new tables (`orgs`, `org_members`,
   `org_invites`, `platform_admins`, `recipes`), a nullable `org_id` (DEFAULT
   `'onfinance'`) on every global table, backfilled + indexed. No `NOT NULL`, no
   PK changes. Seeds org #1, its members, the owner as platform admin, and the
   built-in recipe catalog.

2. **Deploy — migration MUST come first.** The Drizzle schema now selects
   `org_id`, so `select().from(t)` emits `SELECT … org_id …`. Deploying this
   code against a DB without the column breaks every full-row-select route.
   Order is always **migrate → deploy front-end → deploy agent**.

3. **Verify single-org still behaves as today.** The app runs unchanged: every
   query resolves org `onfinance`; `GET /api/ops/orgs` returns the one workspace;
   the Workspace section renders.

4. **(Later, deliberate) multi-tenant cutover.** Only when a real second org
   exists. See below.

## Provisioning a workspace

Two doors, one engine (the provisioning API — nothing writes tables directly):

- **Self-serve wizard** — `/onboard`: name the company → fork (manual vs
  "agents run the recipes") → invite operators (deterministic setup email,
  previewed before send) / the six setup checks. Both branches read the same
  `GET /api/ops/orgs/{id}/health` — the round-trip is the product.
- **FDE-assisted** — the `onboard-org` skill + `npm run fde:new-org`. The path
  for enterprise / deployment-per-tenant orgs.

Creating a workspace is **platform-admin only** (`platform_admins`). The org
owner is written on create; invites carry a hashed one-time token
(`org_invites`) and are redeemed at `/api/ops/invites/accept`.

## Readiness checks

`GET /api/ops/orgs/{id}/health` is the single source of truth for the checklist —
green here or not at all. Checks: `members`, `roster`, `connector`, `workflows`,
`dataroom`, `customer`. `ready: true` when the load-bearing set passes.

## Control plane

Ops Center → **Workspace** section (`workspace-panel.tsx`), admin/owner-gated:

- **Members & roles** — add / change role / remove (`org_members`); last-owner
  guard; pending invites.
- **Settings** — name, domain, region; danger zone (suspend / reactivate). Org #1
  can't be suspended (it's the fail-safe home).
- **Usage & limits** — trailing-30d runs / tokens / cost vs `orgs.limits`.
- **Audit log** — `automation_audit` filtered by org.

## The multi-tenant cutover (deliberate, gated)

The single flag `OPS_MULTI_TENANT=1` widens who is admitted at the gate. Set it
on **both** projects together (front-end + agent), or the two gates diverge:

- `lib/ops-auth.ts` (front-end): with the flag, any verified Google token
  reaches the Node layer; without it, only `@onfinance.in`. Note: the Edge
  proxy may not see custom env — confirm `OPS_MULTI_TENANT` is exposed to the
  middleware environment before relying on it there.
- `agent/channels/eve.ts` (agent): with the flag, the `hd` lock is dropped; WHO
  can touch WHAT is decided by org membership in the data layer.

These are now DONE (org scoping has fully permeated):

1. Read-filter + write-stamp on every ops list/`[id]` route; customer-scoped
   `[id]` routes (`deployments`/`implementations`/`tickets`/`people`) guarded by
   the customer's org (`customerInOrg`).
2. Agent-side scoping (`agent/lib/org-context.ts`): dataroom tools, the customer
   data layer, and the write tools stamp/scope by the session or customer org.
3. Dispatcher skips a suspended workspace's rules.
4. `/api/dataroom` is gated + `?org`-scoped.
5. RLS backstop (`.migrate-org-rls.mjs` + `withOrgRls`) enforces org isolation at
   the DB for wrapped read paths; per-org HKDF secret keys derive from
   `OPS_SECRETS_KEY` so one workspace's secret dump can't decrypt another's.
6. Phase-3 tightening migration: `org_id` NOT NULL (DEFAULT kept) + `people_roster`
   PK `(org_id, email)`.

## Migration order (the three tenancy migrations)

1. `.migrate-org-tenancy.mjs` — base (run first; the schema selects `org_id`).
2. `.migrate-org-tenancy-tighten.mjs` — NOT NULL + composite roster PK. The code
   is decoupled from the PK (no ON CONFLICT), so this can run after deploy.
3. `.migrate-org-rls.mjs` — RLS policies (permissive-when-unset; safe to enable
   live). Activates DB enforcement for `withOrgRls`-wrapped routes.

## Isolation & safety

- Org filter is structural (`orgDb.where` / `stamp`), not hand-written per route.
- Blob: the data room is per-workspace. `getDataroomStore(orgId)` (agent) and
  the front-end twin `lib/dataroom-blob.ts` prefix every key by org — `onfinance`
  → `dataroom/…` (legacy root, no copy; byte-identical to before), others →
  `dataroom/orgs/{id}/…` with the identical dm.md tree. Called with no org they
  return org #1's store, so existing callers are unchanged.
  **Remaining for LIVE routing:** agent tools call `getDataroomStore()` with no
  org (→ onfinance) because a tool has no per-session org yet — routing by the
  session's workspace is the cutover step (needs eve session→org). Likewise
  `/api/dataroom` defaults to onfinance and would need auth + `?org=` (it's
  currently ungated) to serve another workspace. Until then a second org's tree
  is reachable by explicitly passing its `orgId`, and is populated the moment its
  first customer is onboarded (context.md lands under `orgs/{id}/Customers/…`).
- Secrets: `connector_secrets.org_id` is the hook for per-org derived keys
  (HKDF of `OPS_SECRETS_KEY`) in Phase 3 so one org's dump can't decrypt another.

## Remaining (Phase 3 hardening)

`NOT NULL` + composite-PK tightening migration (drops the `org_id` DEFAULT once
every write stamps explicitly); Postgres RLS; per-org dispatcher fairness in
`dynamic.ts`; per-org HKDF secret keys; billing; the `delivered` CLI + recipe
`--recipes` execution; optional Neon-branch / deployment-per-tenant tier;
legacy blob migration to the prefixed layout.
