---
name: mold
description: Fetch a mold's codebase onto this machine at its pinned commit, refresh it to its source's current main, or check that the copy on disk is still exactly the source. Use when asked to "fetch mold_v1", "get the mold", "refresh the mold", "update the snapshot", when molds/<mold_id>/codebase is missing, or before minting on a fresh machine.
---
# mold

A mold's codebase is not in the repository. `molds/<mold_id>/codebase/` is a git-ignored snapshot of the mold's
source at the commit `state/factory.json` pins (`molds[].source.commit`). One script puts it there and proves it:

```
python3 .claude/scripts/mold.py fetch <mold_id>      # the pinned commit: what every application is built from
python3 .claude/scripts/mold.py check <mold_id>      # is the snapshot still exactly that commit? writes nothing
python3 .claude/scripts/mold.py refresh <mold_id>    # move the pin to the source's current main (a deliberate act)
```

- "Fetch mold_v1" means `fetch`. It ends with the word IDENTICAL when the copy is the source; anything else exits
  non-zero and names the differences. Running it again is safe and restores a snapshot a run wrote into.
- Where the source lives is this machine's own: `state/factory.local.json` → `mold_sources` →
  `{"<mold_id>": "<git URL>"}`, never committed. If `mold.py` says none is set, ask the operator for the address in
  one plain sentence and put it there yourself (`state/factory.local.example.json` shows the shape); the address is
  not a secret, but it never goes into a tracked file.
- `refresh` only when asked to move to a newer source. It records the new commit and date in `state/factory.json`
  and the mold's `MOLD.md`; commit those two files. Every deployed application then shows a redeploy due in `mint`.
- Never edit the snapshot by hand and never fork it (AGENTS.md). What the mold contains, and why some test runs
  write into it, is in `molds/<mold_id>/MOLD.md`.
- `python3 .claude/scripts/mold.py --self-test` runs offline against a local bare repository.
