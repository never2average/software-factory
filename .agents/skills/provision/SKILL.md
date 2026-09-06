---
name: provision
description: Check and deploy a stamped application to its target. Use after intake, or when asked whether an app can deploy, or to deploy it.
---
# provision

`python3 .claude/scripts/provision.py <app_id>` checks the secret store by name and creates the target scaffold (VM: Dockerfile + compose + .env.example under `infra/vm/apps/<app_id>/`; Vercel: links the product project). `--deploy` performs the deploy and records the URL in `infrastructure.json`. Launch the `provisioner` subagent for either. Missing secrets are the user's to set; report names, never collect values.

When the app carries `surface.branding`, `--deploy` first builds a branded copy of the mold under `build/<app_id>/` (`branding.py <app> prepare`) and deploys that: the mold snapshot is never edited, and each app gets its own build directory. `branding.py <app> show` prints the resolved brand and derived palette; `check` verifies a prepared copy. Packs live in `molds/<mold_id>/branding/<pack>/` (`brand.json` plus a 32x32 `mark.svg`); `rules.json` says which files carry the product name, tagline, icon and palette, and every rule must match or the deploy is refused.
