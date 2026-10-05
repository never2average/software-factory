# The account-delivery library

The workflow scripts and the onboarding recipes this product carried as built-ins until the
library became the deployment profile's. They are written for a team that delivers a platform
to accounts: onboarding an account, sizing and securing its infrastructure, planning a data
migration, triaging evaluation regressions, a go-live sprint, incident routing and
post-mortems, renewal risk, a quarterly review.

Base code ships none of this. A deployment gets it only when its profile names it.

## Opt in

```bash
cp library/account-delivery/profile.json profiles/40-library-account-delivery.json && npm run build:generated
```

Commit the profile file with the regenerated `agent/lib/workflow-library.generated.ts` and the
two `deployment-profile.generated.ts` files, and deploy. From then on:

- every **new** workspace is provisioned with the 13 workflows, the 5 recipes and the 3
  starter apps (`agent/lib/provision-workspace.ts`), in the deployment's own words. The apps
  are created without a document: each is written when a person first opens it, or on its
  schedule, so creating a workspace runs no model;
- an **existing** workspace gets the workflows from
  `npm run operator:seed-workflows -- --org <id>`, and the starter apps from
  `npm run operator:library-apply -- --org <id>` (a dry run; `--apply` to add them).

A workflow that delegates to a specialist the profile excludes (`specialists.exclude`) is left
out of both, as before.

To turn it off again in a later profile: `"library": { "sources": { "account-delivery": null } }`.

## What is here

| Path | What |
|---|---|
| `workflows/*.workflow.js` | the 13 scripts. Text a person or a model reads is written with the placeholders the profile fills (`{account}`, `{owner}`, `{member}`, `{folder:projects}`, …) |
| `recipes.json` | the 5 onboarding recipes, in checklist order |
| `apps.json` | the 3 starter apps: "Open follow-ups" (weekdays 07:00 UTC) and "{Accounts} gone quiet" (Mondays 07:00 UTC), written by the `follow-ups` specialist, and "Evaluation regressions" (on request), written by `evals`. Each has a stable `key`; see "Starter apps" in `docs/DEPLOYMENT_PROFILE.md` |
| `profile.json` | the opt-in: one `library.sources` entry |
| `history.json` | every workflow name and recipe slug this library has ever shipped, with the code skeleton of each version, so `npm run operator:library-cleanup` can recognise a row an older build left behind |

## Changing it

Edit a script or `recipes.json`. A deployment that opted in regenerates on its next build
(`npm run build:generated`); workspaces that already hold a workflow keep their copy until
`operator:seed-workflows` is run for them.

If you change a script's **code** (not only the words in its strings), record the skeleton of
the version you are replacing in `history.json` first (the sha256 that
`scriptSkeleton` in `scripts/lib/profile-library.mjs` gives for it): today's files are always
recognised, earlier ones only through that file. If you **remove** a workflow or a recipe,
leave its name in `history.json`. A starter app needs no history: a workspace's row carries
its key, so one this library stops shipping is recognised by `operator:library-cleanup` as it
is. Never change a starter app's `key`: the new key would be created beside the old app.

A library for another line of work is another directory beside this one (`library/<id>/`),
named by that deployment's profile or shipped by its subagent pack. See
`docs/DEPLOYMENT_PROFILE.md`, "library".
