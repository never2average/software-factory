# The patch agent-workspace applies to eve

agent-workspace depends on [eve](https://github.com/vercel/eve), a third-party framework, at exactly **0.25.1**, and changes it
in one place: `patches/eve+0.25.1.patch`, applied to the installed copy. Nothing is forked, published or filed upstream.
What it changes and why is in docs/SPECIALIST_HANDBACK.md ("Per-result delegation"); this page is how it is applied
and kept honest.

## The mechanism: patch-package

| Piece | What it is |
|---|---|
| `package.json` `dependencies.eve` | `"0.25.1"`, exact. A `^` would let a minor bump bring code the patch was not written for. |
| `patch-package` (devDependency, exact) | applies `patches/*.patch` to `node_modules/` |
| `"postinstall": "node scripts/eve-patch/postinstall.mjs"` | every `npm ci` / `npm install` applies the patch with `patch-package --error-on-fail`. If that fails because eve already carries something else (an EARLIER revision of the patch, from a restored build cache), it puts eve back as published (the lockfile's tarball, checked against its integrity hash) and applies the patch again; a second failure fails the install. `npm run test:eve-patch-install` (CI) holds both: a second install, and an install over an older patch |
| `scripts/check-eve-patch.mjs` (`npm run check:eve-patch`) | fails unless eve is pinned exactly, installed at that version, the one eve patch is for that version, and every file the patch touches has exactly the content recorded when the patch was made (`scripts/eve-patch/patched.sha256.json`). Has a `--self-test`. |
| `prebuild:eve` and `prebuild` | run `check:eve-patch` first, so neither the agent build nor the web build can run on an unpatched or differently patched eve |
| CI (`verify`) | runs `check:eve-patch` right after install, and the behavioural tests on the patched runtime |

eve ships minified modules, so the patch file is one long line per changed file. **Review the readable source instead:**
`scripts/eve-patch/changes.mjs` lists every edit as an exact anchor and its replacement, each with the reason, and
`scripts/eve-patch/files/` holds the three new modules, written readably. `node scripts/eve-patch/apply.mjs --dry-run`
checks that every anchor occurs exactly once in a pristine eve 0.25.1.

## How each deployment applies it

- **Vercel** (`vercel build`, and the git-connected builds): Vercel installs with npm, which runs the root
  `postinstall`, so `patch-package` patches `node_modules/eve` before the build command. Vercel restores
  `node_modules` from its build cache and runs `npm install` over it, so after a change to the patch eve arrives
  carrying the PREVIOUS revision; plain patch-package cannot move it to the new one (it failed the first deploy of #133:
  "Failed to apply patch for package eve"), which is why postinstall puts eve back as published first in that case. The build command is
  `npm run build:eve` (`vercel.eve.json`, `vercel.api.json`) or `npm run build` (the web app); both run the check
  first. The eve build bundles eve from `node_modules/eve/dist`, so the deployed functions carry the patched code.
- **The self-hosted server** (in-place `npm ci --include=dev` + `npm run build:eve` + `npm run build`): `npm ci` runs
  `postinstall`, and the builds run the check. Note that the factory's build script runs `npm ci` only when
  `package-lock.json` changed (`build-stamps/app.lock`). This change edits the lockfile (the exact pin, patch-package),
  so the first deploy re-installs. A later edit to the patch alone does NOT change the lockfile: the build then stops at
  `check:eve-patch` ("node_modules/eve does not carry patches/eve+0.25.1.patch … run `npm ci`") instead of building on
  stale code. Run `npm ci` in the app directory, or make the stamp include `patches/`: in the factory's build script
  (`.claude/scripts/lib/vm_remote.py`, the app's stamp line before `npm ci --include=dev`)
  `lock_now="$(cat @APPDIR@/package-lock.json @APPDIR@/patches/*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)"`.
- **CI and local**: `npm ci` applies it. An install with `--ignore-scripts` does not; the check says so by name.

## Changing the patch

1. Edit `scripts/eve-patch/changes.mjs` or `scripts/eve-patch/files/`.
2. `node scripts/eve-patch/apply.mjs --regenerate` — takes the installed patch off (`patch-package --reverse`), applies
   the source to the pristine copy, records `patches/eve+0.25.1.patch` (`patch-package eve`) and its hashes
   (`check-eve-patch --record`).
3. `npm run check:eve-patch && npm run test:specialist-detach && npm run test:detached-delegation`.

**Replay compatibility.** On the self-hosted server every in-flight run is replayed with the code on disk after a
deploy. A revision that adds or removes a workflow-level operation (a hook, a sleep, a step) on a path that runs the
deployed revision already recorded breaks those runs ("replay diverged"). Seen on the rig: child sessions recorded
under this PR's first revision diverged under the second, which creates a parked-stop hook in a detachable child's
driver; that first revision was never deployed. Gate any new operation on data only new runs carry — as this patch
gates everything new on `driverCapabilities.delegationResults`, the adapter's `parentSessionContinuationToken`, or a
delivery's `delegationResults` — or deploy it only when no affected run is in flight. mold_v1-196/197 follow the same
rule: the idle bound, the independent-work hand-over and the sweep hook (new hooks and a new step in the turn's wait)
run only under `driverCapabilities.delegationSweep`, which only the new driver writes into a NEW turn's input.

**What the application may call.** The patch exports one thing for the application's own code: `delegationSweep` from
`eve/channels` (execution/delegation-sweep.js), what the specialist sweep (agent/lib/specialist-sweep.ts) does from a
schedule or a route: read a session's stream, cancel or end a run, hand a waiting batch over, deliver a late result. No
route exposes it.

## Rolling back

The only supported rollback is a build that KEEPS the patch and sets `subagents: { batch: "all" }`. A build without the
patch fails, on the self-hosted server, every chat that delegated since the deploy (its recorded run no longer replays),
and on Vercel drops late results: docs/SPECIALIST_HANDBACK.md "Deploying and rolling back".

## Upgrading eve

Do not bump the pin alone: the check fails the build, by design. Install the new version, try
`node scripts/eve-patch/apply.mjs --dry-run`; every anchor that no longer matches names the function that changed.
Re-derive those edits against the new code (or drop them if eve now does it), regenerate, rename the patch to the new
version, re-record, and run the tests above plus the rig (docs/SPECIALIST_HANDBACK.md "Checking a running app").
