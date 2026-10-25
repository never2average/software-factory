# web/src/packs/

A host pack's console code (mold_v0-039; molds/mold_v0/MOLD.md "Host packs"): `web/src/packs/<id>/index.ts` (its pages,
sidebar entries and landing page, `features/packs/host-web.ts`) and `routes.json` (the URLs its pages keep). Its customer
guide is its pack.json `guide` since mold_v0-139 (a `guide.ts` here is refused). Copied here by the factory's `packs.py
apply`; `scripts/gen-packs.mjs` lists them in `src/config/pack-web.generated.ts` and `pack-routes.generated.json`. This
codebase ships none.
