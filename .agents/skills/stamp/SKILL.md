---
name: stamp
description: Stamp a new application from a mold. Use when asked to create an app, instance, or deployment of mold_v1/v2/v3.
---
# stamp

1. Choose `app_id` (lowercase, underscores). Copy `state/application/app_id/` to `state/application/<app_id>/`, delete the README there.
2. Write `application.json`, `infrastructure.json`, `datastores.json`, `datainfra.json` against the four schemas. Reference secrets by name only.
3. Run `python3 .claude/scripts/factory.py validate`.
4. Append `<app_id>` to `applications` in `state/factory.json` and to the product's `app_ids` in `state/products.json`.
5. Build the mold on the VM: `cd molds/<mold_id>/codebase && npm ci && npm run typecheck && npm run build`.
6. Set `status` to `stamped`, then hand off to the `run-lanes` skill.
