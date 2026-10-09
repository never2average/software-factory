---
name: provision
description: Check and deploy a stamped application to its target. Use when asked whether an app can deploy, to deploy it, or why a deploy failed.
---
# provision

```
python3 .claude/scripts/provision.py <app_id>                     # check, READ-ONLY: what exists, which secrets to set
python3 .claude/scripts/provision.py <app_id> --set-secret NAME   # the OPERATOR types one credential at a hidden prompt
python3 .claude/scripts/provision.py <app_id> --deploy            # refuses before creating anything if a secret is missing
```

A human runs `--set-secret`: an agent never handles a secret value. Report missing names; never collect values.

`--deploy` writes `state/application/<app_id>/deploy-log.txt` and, on success, `vercel.production_url` and
`deployed_at` in `infrastructure.json`. On failure it records `last_deploy.status = failed` and the log path.

## When a deploy fails

Read `deploy-log.txt` and the app's `infrastructure.json` before anything else. The mold is a Next.js app: its
Vercel project must build with the `nextjs` framework preset (`infrastructure.json` → `vercel.framework`).
Diagnose from the log and state; redeploy only when the operator agrees.
