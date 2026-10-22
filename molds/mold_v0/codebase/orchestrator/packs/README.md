# orchestrator/packs/

A host pack's own orchestrator (mold_v0-039; molds/mold_v0/MOLD.md "Host packs"): `orchestrator/packs/<id>/main.ts`,
copied here by the factory's `packs.py apply` for an app that names the pack. `orchestrator/main.ts` runs the first one
listed in `packs.generated.ts` (written by `scripts/gen-packs.mjs`), else the deterministic worker. This codebase ships
none. Its code imports the orchestrator's own files only (never the server's `src/`); its `test/` is run by hand and
never uploaded to a sandbox.
