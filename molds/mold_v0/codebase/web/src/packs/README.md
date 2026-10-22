# web/src/packs/

A host pack's console code (mold_v0-039; molds/mold_v0/MOLD.md "Host packs"): `web/src/packs/<id>/index.ts` (its pages,
sidebar entries and landing page, `features/packs/host-web.ts`), `routes.json` (the URLs its pages keep) and optionally
`guide.ts` (its customer guide). Copied here by the factory's `packs.py apply`; `scripts/gen-packs.mjs` lists them in
`src/config/pack-web.generated.ts`, `pack-routes.generated.json` and `pack-guides.generated.ts`. This codebase ships none.
