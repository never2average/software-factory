# mold_v1 (rehearsal stand-in)

**Status:** active
**Source:** the mold's source @ c0ffee1 (pinned in `state/factory.json`)

A tiny stand-in for the real mold, used only by the benchmarks. `codebase/` is a few files of a Next.js app; the real
mold is a multi-workspace, multi-agent web app on Next.js and Postgres. It is never edited in place and never forked
to stamp an application: an application's own code is a pack, and a base-code change is a pull request to the mold's
source.

`testing/` holds the five lanes (`functional`, `context`, `load`, `accessibility`, `responsiveness`); each
`lane.json` lists its checks. `lanes.py` runs them; never edit a lane to make it pass.
