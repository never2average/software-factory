---
name: configure-infra
description: Scaffold a customer deployment's infrastructure substrate under {folder:deliveries}/{customer}/{ver}/infrastructure/ across the eight domains (network, compute, storage, inference, agents, database, observability, autoscale) plus the 4-party signoff chain, and upsert the deployments row. Use when standing up a customer deployment's infra, when someone says "configure infra", "set up the deployment infrastructure", "scaffold the infra", or before driving the signoff chain. This is the per-deployment substrate a solution runs on — not a solution itself.
---

# Configure infra

> `{folder:<id>}` below is the data-room folder this deployment stores that domain under: its profile's
> `dataroom.domains.<id>.folder` (`uploads_folder` for `{folder:uploads}`). Read the real name with
> `node --experimental-strip-types -e 'import("./agent/lib/dataroom-folders.ts").then((m) => console.log(m.FOLDER))'`.

The **per-deployment substrate** — what a configured solution runs *on*. Scaffolds
the eight infrastructure domains under
`{folder:deliveries}/{customer}/{ver}/infrastructure/` and the 4-party signoff chain, and
upserts the `deployments` row. Customer-scoped (unlike the shared `{folder:platform}/{ver}/`
architecture). See [`docs/OPERATOR_WORKFLOW.md`](../../../docs/OPERATOR_WORKFLOW.md) (stage 4).

## Steps

**1. Scaffold.**
```bash
npm run operator:configure-infra -- --customer contoso-bank --org <workspace id> --version v2.4.0 \
  --region APAC --cloud aws
```
Upserts the `deployments` row and writes `customizations.tf` + `rationale.md` under
each of `network / compute / storage / inference / agents / database /
observability / autoscale`, plus the `inference/signoff/` skeleton (four parties,
`PENDING`). Never clobbers authored infra.

**2. Author each domain.** Fill the `customizations.tf` + `rationale.md` per domain
with the real terraform and the why.

**3. Drive the signoff.** Move each of `internal`, `customer.infra`,
`customer.infosec`, `customer.cloudvendor` from `PENDING` to signed. **The
deployment is not done until all four sign.**

## Where this reads / writes

WRITE:
- `deployments` row (upsert by customer + deploymentId = version)
- `{folder:deliveries}/{customer}/{ver}/infrastructure/{domain}/{customizations.tf,rationale.md}` for each of the 8 domains
- `{folder:deliveries}/{customer}/{ver}/infrastructure/inference/signoff/{internal,customer.infra,customer.infosec,customer.cloudvendor}.md`

## Never

- Never mark a deployment ready while any signoff is `PENDING`.
- Never fabricate terraform — leave `TODO`.
- Never put shared/reference architecture here — that's `{folder:platform}/{ver}/architecture/`
  (configure-platform); this tree is the customer's own substrate.

## Quick reference

```bash
npm run operator:configure-infra -- --customer <id> --org <workspace id> --version <ver> [--region … --cloud …]
```
