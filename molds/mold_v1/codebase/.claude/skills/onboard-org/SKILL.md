---
name: onboard-org
description: Provision a brand-new organization (workspace) on the platform — the tenant layer ABOVE customers/roster/connectors. Use when a new company adopts the platform ("set up <company> as a workspace", "onboard a new org", "create a tenant", "provision OnFinance"), before any customer work. Creates the orgs row, the owner membership + platform admin, seeds the recipe catalog, and points you at the readiness checklist. This is the operator-assisted door; the self-serve wizard writes the same tables. Sibling of onboard-self (a person) and onboard-customer (a customer account).
---

# Onboard an organization (workspace)

Set up a **company** on the platform so it has its own people, connectors,
workflows, and customers — org #1 is OnFinance. This is the tenant layer *above*
`onboard-customer`: a workspace owns many customer accounts.

The product name is **Delivered**; a company that adopts it gets a **workspace**
(`org_id` at the schema level). "One workspace per company."

## Prerequisite

The org-tenancy migration must have been run (the `orgs` table must exist). If it
hasn't, stop and tell the operator to run `.migrate-org-tenancy.mjs` first.

## Working style

One step at a time, against the **live** platform. The workspace id (slug) is
permanent — it's the blob prefix and the `hd`-claim → workspace key — so confirm
it before creating.

## The steps

**1. Name and slug.** Get the company display name. The id defaults to a
lowercase-kebab slug (`OnFinance` → `onfinance`); confirm before proceeding.

**2. Work email domain (optional).** The Google Workspace domain. Anyone signing
in from this domain joins this workspace (the `hd`-claim → org lookup). Consumer
-domain companies skip this and rely on per-email invites instead.

**3. Owner.** The email that becomes the workspace **owner** and a **platform
admin**. Defaults to your signed-in identity.

**4. Create.** Run:

```
npm run operator:new-org -- --name "OnFinance" [--id onfinance] [--domain onfinance.in] [--owner you@company.com]
```

This writes the `orgs` row, the owner into `org_members`, adds the owner to
`platform_admins`, and seeds the built-in recipe catalog.

**5. Invite operators.** Add the people who'll run it — owner + at least one
admin — via the Workspace › Members surface (or `POST /api/ops/orgs/{id}/invites`
for the deterministic setup email). Invites are one generated message per role,
identical for everyone, sent through the org's platform channel.

**6. Connect a source, import the roster, seed workflows, onboard the first
customer.** These are the remaining setup checks — each is its own recipe / skill
(`connect-sources`, `import-roster`, `seed-workflows`, `onboard-customer`).

**7. Verify readiness.** The checklist turns green only from
`GET /api/ops/orgs/{id}/health` — never on your say-so. Poll it until the
load-bearing checks pass:

```
curl -s -H "authorization: Bearer $TOKEN" https://fde-agent.vercel.app/api/ops/orgs/<id>/health | jq
```

Each check (`members`, `roster`, `connector`, `workflows`, `dataroom`,
`customer`) reports `ok` + a detail sentence. `ready: true` means the workspace
is operational.

## Coexistence

The skill, the self-serve wizard, and the console are all thin clients of the
same provisioning API and tables — none writes tables in a way the others don't.
Operator-assisted (this skill) is the path for enterprise / deployment-per-tenant orgs.
