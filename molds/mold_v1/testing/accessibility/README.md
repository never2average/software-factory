# Accessibility lane

Grades the pages a real customer lands on: axe-core 4.13.0 (WCAG 2.1 A/AA) plus a keyboard-only Tab
walk, driven by Playwright chromium against the application's **own deployed URL** — read-only, GET
only, and never against the live factory projects (see "Safety" below).

Run it through the runner, which is what writes state and the report:

    python3 .claude/scripts/lanes.py <app_id> --lane accessibility            # records the verdict
    python3 .claude/scripts/lanes.py <app_id> --lane accessibility --dry-run  # report only, no state

Or drive the harness directly against any URL — a deployment, or a locally started build of the mold:

    node molds/mold_v1/testing/accessibility/a11y.mjs --url https://<app>.vercel.app
    node molds/mold_v1/testing/accessibility/a11y.mjs --url http://127.0.0.1:3110 --only keyboard
    node molds/mold_v1/testing/accessibility/deps-check.mjs   # is the browser here?

## What it checks

| row | what it measures |
|---|---|
| `axe /`, `axe /onboard`, `axe /workspace` | every axe rule against the rendered page |
| `keyboard /`, `keyboard /onboard`, `keyboard /workspace` | Tab from the top: which controls are reachable, whether each one is visible and shows a focus indicator |
| `keyboard workflow-builder` | traversal of the builder — `not-covered` today, see below |

Those are the three page routes this mold snapshot has (`app/page.tsx`, `app/onboard/page.tsx`,
`app/workspace/page.tsx`). **There is no `/chat` route** — the chat shell renders at `/` — so the
lane grades `/` and says so rather than reporting a route it never visited. `--routes a,b` overrides
the list if a future mold adds pages.

## Pass criterion (deliberately narrow, so a pass means something)

- **fail** — an axe violation of impact **serious** or **critical** carrying a WCAG 2.1 A/AA tag; or a
  keyboard defect: no control reachable by Tab on a page that has interactive elements, a focused
  control that is offscreen or zero-size, or a focused control with no visible focus indicator
  (WCAG 2.4.7).
- **pass** — the page rendered and none of the above was found.
- **skipped** — the route did not answer 2xx, or the lane's preconditions were not met (including: the
  URL answered 200 with something that is not this application). A page that was never rendered is
  never graded green. Nothing measured is never a pass.
- **fail, specifically, when a declared route answers 2xx and then renders no interactive control.**
  That case used to *pass*: axe finds no violation in an empty body, and "0 tabbable of 0 interactive"
  printed green, so both new lanes read `pass` against a deployment showing none of the application.
  A mold_v1 page route has controls on it; one that renders none is a broken deploy, not a clean bill
  of health. The guard on the Tab walk is now unconditional (`if (!seen.length)`, no `&& interactive > 0`
  escape hatch), because the empty page has already failed by then.

Moderate and minor violations, axe best-practice rules, and axe `incomplete` results are printed in
the detail column but do not fail the lane; they need a human to judge them.

Three rules keep `pass` honest inside the harness itself. A declared route that did not render exits
non-zero, so the runner can never record `pass` for a page nothing looked at. A route that rendered
nothing fails its row rather than satisfying every criterion vacuously. And the one row that can never
run unauthenticated — `keyboard workflow-builder` — is labelled **`not-covered`**, not `skipped`: the
runner's rule is that a lane cannot be `pass` while something it declared went unmeasured, and a row
printed `skipped` reads as exactly that. It is a declared gap of this lane (below), not a measurement
that failed to happen, and it is printed in every report so a green lane cannot be read as "the builder
was traversed".

## How it degrades

`lane.json` gates both checks on two preconditions, so an app that is not deployed makes the lane
`skipped` with one instruction, never `pass` and never a mystery `fail`:

1. `infrastructure.vercel.production_url` is non-empty — else "deploy it first: `provision.py <app_id> --deploy`".
2. `target-up.py <url> / /onboard /workspace --expect ...` exits 0 — the pages answer 2xx right now
   **and** the HTML they serve carries this mold's own markers. HTTP 200 is not "the application is
   there": mold_v1 apps share one Vercel project, so a stale or colliding `production_url` answers 200
   with somebody else's page. Without the markers that page was graded, found clean, and recorded
   `pass`. With them it is `skipped`, with one instruction. The markers live in `lane.json`, so a future
   mold edits its own declaration rather than the probe.

Lane-level, `deps-check.mjs` must find Playwright chromium and the vendored rule set; if the VM has no
browser the whole lane is `skipped` with the install command, not a red lane blamed on the app.

## Safety

- Nothing is installed into `molds/mold_v1/codebase`. axe-core ships as one standalone file, vendored
  here as `vendor/axe.min.js` (MPL-2.0) and injected with `addScriptTag`, so the lane needs no
  `node_modules` and no network at run time. `npm --prefix molds/mold_v1/testing/accessibility run vendor`
  re-vendors it; `package.json` pins the version.
- The browser aborts any request to `fde-agent`, `fde-agent-api` or `fde-task-workflow`, and to the
  `/eve/v1/` and `/.well-known/workflow/` proxy paths. A mold built without `EVE_API_URL` bakes a
  rewrite to the **live** agent into `routes-manifest.json`, so without this guard a local run would
  quietly drive production traffic. Blocked requests are counted and reported.
- The lane reads no secret and holds no credential. Its only input is a public URL.

## Not covered

- **Anything behind a signed-in identity** — the workflow builder, the ops center tabs, a chat thread.
  Unauthenticated the lane sees 3 pages and 2-9 tabbable controls, so `keyboard workflow-builder` is
  reported `not-covered` with that reason rather than dropped. Deepening it means minting a local session
  (the mold's `scripts/test-email-signin.mjs` shows the shape: a self-generated P-256 keypair, no
  Google, no secret) against a migrated local database — worth its own task.
- Screen-reader output: axe checks the accessibility tree, not what NVDA or VoiceOver announces.
- Zoom to 200%, reduced motion, forced-colors, and any theme other than the one served.
- Viewport behaviour and layout shift — that is the responsiveness lane.

## Measured today (2026-09-08, `claudecode_web_replica`)

Real findings, against both the deployment and a locally started build of the same mold — identical:

    axe /workspace  fail  button-name[critical x1]  color-contrast[serious x7]
                          (plus best-practice landmark-one-main, page-has-heading-one, region)
    axe /, /onboard pass  29 rules passed, 1 needs review
    keyboard        pass  2, 2 and 7 tabbables, every one with a focus indicator

So this lane is red for the replica on its own merits, not for want of a harness.
- **Which mold_v1 application is serving this URL.** The precondition checks that the HTML carries this
  mold's markers, which catches an undeployed URL and a URL now served by something else. It cannot
  tell two mold_v1 applications apart — they render the same markup. A wrong-but-same-mold
  `production_url` is a provisioning defect, not one this lane can see.
