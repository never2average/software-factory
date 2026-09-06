---
name: provision
description: Check and deploy a stamped application to its target. Use after intake, or when asked whether an app can deploy, or to deploy it.
---
# provision

`python3 .claude/scripts/provision.py <app_id>` checks the secret store by name and creates the target scaffold (VM: Dockerfile + compose + .env.example under `infra/vm/apps/<app_id>/`; Vercel: links the product project). `--deploy` performs the deploy and records the URL in `infrastructure.json`. Launch the `provisioner` subagent for either. Missing secrets are the user's to set; report names, never collect values.
