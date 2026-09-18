---
name: backfill-customization-history
description: Reconstruct a customer's deployment and customization history into the canonical Deployments/ layout and the deployments row. Use when an existing customer's platform customizations (model routing, guardrails, infra, inference config) aren't yet recorded, when someone says "backfill the customizations", "record the deployment history", "we deployed X for them but it's not in the system", or before an upgrade/audit that needs the current customized state. Requires the customer to exist (onboard-customer). Materialises customizations.tf, rationale.md, and the 4-party signoff skeleton per platform version, and upserts the deployment row.
---

# Backfill customization history

Reconstruct what was customized in a customer's deployment(s) into the canonical
`Deployments/{id}/{version}/…` layout and the `deployments` system-of-record row.
This is **stage 4** — see [`docs/FDE_WORKFLOW.md`](../../../docs/FDE_WORKFLOW.md).

Use it when a deployment happened but its customizations were never recorded, or
before an upgrade/audit that needs the current customized state captured.

## Working style

One version at a time. Gather the real customizations from wherever they live
(terraform, PRs, `Deployments/syncs/{github,aws}`, the FDE's memory) before writing —
don't invent config. The signoff chain is a **gate**: the skill seeds it as
`PENDING`, it is not done until the four parties actually sign.

## The steps

**1. Pick the customer + version.** Confirm the customer id exists and the
platform version id (e.g. `v2.4.0`) being recorded.

**2. Gather the customizations.** For each customization: a short title, the
terraform/config (`tf`), and the `rationale` (why). One or many.

**3. Backfill.** Single customization via flags:
```bash
npm run fde:backfill-customizations -- --customer contoso-bank --version v2.4.0 \
  --region APAC --cloud aws --summary "GPU inference + custom guardrails"
```
Many at once via a JSON file (`[{ "title", "tf", "rationale" }, …]`):
```bash
npm run fde:backfill-customizations -- --customer contoso-bank --version v2.4.0 \
  --from-file customizations.json
```
This upserts the `deployments` row, writes `customizations.tf` + `rationale.md`
under `…/infrastructure/inference/`, ensures the 4-party signoff skeleton, and logs
a `customization_backfilled` interaction.

**4. Fill and sign.** Replace any `TODO`s in the written files, then drive the
signoff chain (`internal`, `customer.infra`, `customer.infosec`,
`customer.cloudvendor`) from `PENDING` to signed.

## Where this reads / writes

READ: the `customers` row (must exist); your gathered customization inputs.

WRITE (per `Deployments/{id}/{version}/infrastructure/inference/`):
- `customizations.tf`, `rationale.md`
- `signoff/{internal,customer.infra,customer.infosec,customer.cloudvendor}.md` (only
  if absent — never overwrites an existing signoff)
- the `deployments` row (upsert by customer + deploymentId)
- `Customers/{id}/interactions.jsonl` — a `customization_backfilled` event

## Never

- Never fabricate terraform or a rationale — leave `TODO` if unknown.
- Never overwrite a signoff file that already records a real decision.
- Never mark a deployment done while any signoff is `PENDING`.

## Quick reference

```bash
npm run fde:backfill-customizations -- --customer <id> --version <ver> \
  [--region …] [--cloud …] [--summary "…"] [--from-file customizations.json]
```
