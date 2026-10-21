# packs/

Where a build copy's packs live (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract"). This codebase
ships none: the factory's `packs.py apply <app>` copies an app's packs here in `build/<app_id>/`, then runs
`npm run gen:packs`. Each pack is a directory `packs/<id>/` with a `pack.json` and an entry module whose default export
is `definePack({...})` from `src/pack-api.ts`. `scripts/fixtures/packs/fixture_notes` is a small example (the test
fixture `npm run test:packs` installs into a build copy).
