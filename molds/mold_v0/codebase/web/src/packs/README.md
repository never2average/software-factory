# web/src/packs/

A host pack's console code (mold_v0-039; molds/mold_v0/MOLD.md "Host packs"): `web/src/packs/<id>/index.ts` (its pages
and landing page, `features/packs/host-web.ts`) and `routes.json` (the URLs its pages keep). Its customer guide is its
pack.json `guide` since mold_v0-139 (a `guide.ts` here is refused); its sidebar entries, the shell components its routes
serve and its redirects are its pack.json `console` since mold_v0-140 (a `nav.ts` here, or `redirects` in `routes.json`,
is refused). Copied here by the factory's `packs.py
apply`; `scripts/gen-packs.mjs` lists them in `src/config/pack-web.generated.ts` and `pack-routes.generated.json`. This
codebase ships none.
