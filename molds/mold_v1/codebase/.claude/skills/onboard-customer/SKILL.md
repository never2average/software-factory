---
name: onboard-customer
description: Create a new customer account in the system of record and seed its context in the data room. Use when starting a new customer, an FDE says "onboard <customer>", "set up a new account", "create the customer", "add <company>", or when you need a Customers/{id}/ workspace to exist before doing research, deployment, or backfills. Requires you to be onboarded first (see the onboard-self skill). Walks the FDE through naming/slugging the account, choosing tier/vertical/region, assigning owners, and seeding context.md — writing the customers row, the internal_staff assignment, and the data-room workspace.
---

# Onboard a customer

Create the account so every later stage (research, deploy, migrate, operate) has a
`customers` row and a `Customers/{id}/` workspace to write into. This is **stage 1**
of the FDE lifecycle — see [`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md).

You must be onboarded yourself first (`onboard-self`), so your `@onfinance.in`
identity is the account's FDE owner.

## Working style

One step at a time. Everything writes to the **live** system of record and data
room. Confirm the slug with the FDE before creating — the id is permanent and is the
folder name under `Customers/`, `Deployments/`, `Implementation/`, `Tickets/`.

## The steps

**1. Name and slug.** Get the display name. The id defaults to a lowercase-kebab
slug (`Contoso Bank` → `contoso-bank`); let the FDE override with `--id` if they
have a house convention. Confirm before proceeding.

**2. Account facts.** Gather tier (Enterprise / Mid-Market / …), vertical, region,
and the owner emails you know (business / technical). All optional — missing ones
become `TODO` in `context.md`.

**3. Create.** Run:
```bash
npm run fde:new-customer -- --name "Contoso Bank" --tier Enterprise \
  --vertical banking --region APAC \
  --business-owner cfo@contoso.com --technical-owner cto@contoso.com
```
This writes the `customers` row (lifecycle `Onboarding`, `fde_owner` = you), assigns
you as `solution_engineer` in `internal_staff`, seeds `Customers/{id}/context.md`,
and logs an `account_created` interaction. It refuses if the id exists — pass
`--force` only to intentionally update.

**4. Fill context.** Open `Customers/{id}/context.md` (the seeded template) and
replace the `TODO`s: background, compliance profile, scale drivers, open questions.
This is the account's living brief the `research`/`customer-context` subagents build
on.

**5. Next.** Research the account (the `research` subagent builds the domain
workbooks), and if the customer has prior state, reconstruct it with
`backfill-customization-history` and `backfill-integration-history`.

## Where this reads / writes

READ: your identity (`onboard-self`), existing `customers` rows (to refuse dupes).

WRITE:
- `customers` row (id, name, tier, vertical, region, lifecycle, fde_owner, owners)
- `internal_staff` — you as `solution_engineer`
- `Customers/{id}/context.md` — seeded once, never clobbered without `--force`
- `Customers/{id}/interactions.jsonl` — an `account_created` event

## Never

- Never invent a different id for an existing customer — check first; reuse the slug.
- Never write customer content outside its `Customers/{id}/` subtree.
- Never put the FDE (yourself) under `People/` — that tree is external stakeholders
  only; you're recorded via `internal_staff` + your `onboard-self` team memory.

## Quick reference

```bash
npm run fde:new-customer -- --name "…" --tier … --vertical … --region … \
  [--id …] [--business-owner …] [--technical-owner …] [--force]
```
