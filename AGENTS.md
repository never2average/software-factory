# AGENTS.md

This repository is a software factory, not an application. Read `state/factory.json` first: it names the operator, the service surface, the molds and the service/revert loop.

Work is tasked: run `python3 .claude/scripts/factory.py next <mold_id>` to get the current task, and use the `task` skill to move it. Products and their stage gates are in `state/products.json`.

Rules:
- Molds under `molds/<mold_id>/codebase` are snapshots. Do not edit them in place; refresh from source per the mold's `MOLD.md`, or fork into a new mold.
- Stamping an application means: copy `state/application/app_id/` to a real id, fill the four JSON files against their schemas, then run the five testing lanes in `molds/<mold_id>/testing/`. A failed lane sets the application to `reverted` and hands control back to the operator.
- Secrets are referenced by name only (`*_ref` fields). Values live in Vercel or the VM environment.
- Every command runs on the DigitalOcean VM. Shallow-clone external repos.
- Generic agent assets live under `.agents/`; Claude Code specific ones under `.claude/`.
