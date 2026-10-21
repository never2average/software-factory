# packs/

Where a build copy's packs live (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract"). This codebase
ships none: the factory's `packs.py apply <app>` copies an app's packs here in `build/<app_id>/`, then runs
`npm run gen:packs`. Each pack is a directory `packs/<id>/` with a `pack.json` and, optionally, an entry module whose
default export is `definePack({...})` from `src/pack-api.ts`. A pack.json alone is a whole pack (mold_v0-057): record
areas with typed fields, lifecycles and permissions, job kinds, credentials, schedules, onboarding, metrics,
charts, console tabs (mold_v0-063, 058), repositories, all declared in it; `pack.schema.json` here is its JSON Schema (written by `npm run gen:pack-schema`;
point a pack.json's `$schema` at it). `scripts/fixtures/packs/fixture_tracker` is a declarative example; `fixture_vulns` and `fixture_adoption` declare metrics, charts and tabs. `scripts/fixtures/packs/fixture_notes` is a small example (the test
fixture `npm run test:packs` installs into a build copy).
