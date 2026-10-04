# Fixture specialists for `npm run test:sandbox-coverage`

Two specialists the test adds to a copy of the checkout, the way the factory applies a pack
(`packs/<id>/files/agent/subagents/<name>/`), to prove that every sandbox takes the `SANDBOX_*` settings
(docs/self-hosting/SANDBOX.md) without the specialist doing anything for it:

- `fixture-bare`: no sandbox file at all. eve would give it its default backend.
- `fixture-pack`: the shape a pack ships: `sandbox/sandbox.ts` with a `bootstrap` and no `backend`, and seed
  files under `sandbox/workspace/`.

They are never part of a build of this repository.
