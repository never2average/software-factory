# Accessibility lane

Grades the pages a real customer lands on: axe-core 4.13.0 (WCAG 2.1 A/AA) plus a keyboard-only Tab
walk, driven by Playwright chromium against the application's **own deployed URL** — read-only, GET
only, and never against the live factory projects (see "Safety" below).

Two halves. **Signed out**: the mold's three page routes, which is a sign-in page and an empty shell.
**Signed in** (`--only auth`): the product — the chat thread, the ops centre and the workflow builder —
graded with a session this deployment itself minted. Until this second half existed, a green
accessibility lane certified a sign-in page and nothing else (mold_v1-040).

Run it through the runner, which is what writes state and the report:

    python3 .claude/scripts/lanes.py <app_id> --lane accessibility            # records the verdict
    python3 .claude/scripts/lanes.py <app_id> --lane accessibility --dry-run  # report only, no state

Or drive the harness directly against any URL — a deployment, or a locally started build of the mold:

    node molds/mold_v1/testing/accessibility/a11y.mjs --url https://<app>.vercel.app
    node molds/mold_v1/testing/accessibility/a11y.mjs --url http://127.0.0.1:3110 --only keyboard
    MOLD_V1_SESSION_TOKEN='<a session for that app>' \
      node molds/mold_v1/testing/accessibility/a11y.mjs --url https://<app>.vercel.app --only auth
    node molds/mold_v1/testing/accessibility/deps-check.mjs   # is the browser here?

## What it checks

| row | what it measures |
|---|---|
| `axe /`, `axe /onboard`, `axe /workspace` | every axe rule against the rendered page |
| `keyboard /`, `keyboard /onboard`, `keyboard /workspace` | Tab from the top: which controls are reachable, whether each one is visible and shows a focus indicator |
| `keyboard workflow-builder` | signpost row: the builder is graded by the signed-in check, not this one |
| `auth axe …`, `auth keyboard …` | the same two measurements over the **signed-in** product: `/` (chat thread), `/workspace?tab=people`, `?tab=audit` (ops centre), `?tab=workflows` (workflow builder) |

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

Four rules keep `pass` honest inside the harness itself. A declared route that did not render exits
non-zero, so the runner can never record `pass` for a page nothing looked at. A route that rendered
nothing fails its row rather than satisfying every criterion vacuously. A **signed-in surface that
renders the signed-out shell** fails too (see "Authenticated coverage"). And `keyboard workflow-builder`
is labelled **`not-covered`**, not `skipped`: it is a signpost saying which check does grade the
builder, not a measurement that failed to happen — the runner's rule is that a lane cannot be `pass`
while something it declared went unmeasured, and a row printed `skipped` reads as exactly that.

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

3. For the signed-in check only, `session-live.py <url> --min-remaining <seconds>` exits 0 — the
   variable holds a session **this deployment still accepts**, with enough life left to outlast the
   check that is about to run. A missing, malformed, expired, nearly-expired or refused session makes
   the check `skipped` and the lane `skipped`, with one instruction. See "A stale session is `skipped`,
   not `fail`" below for why that verdict is taken here rather than in the harness.

Lane-level, `deps-check.mjs` must find Playwright chromium and the vendored rule set; if the VM has no
browser the whole lane is `skipped` with the install command, not a red lane blamed on the app.

## Authenticated coverage

`--only auth` is the half that grades the product. It needs one thing the factory does not otherwise
hold: **a session for the application under test**, passed in by name.

    MOLD_V1_SESSION_TOKEN='<paste the token>' python3 .claude/scripts/lanes.py <app_id> --lane accessibility

Where the token comes from, honestly: **you sign in, and lend the harness the session you got.**

1. Open the application in Chrome and sign in the way you normally would.
2. `F12` -> **Application** -> **Local Storage** -> the app's own URL -> the row `fde-google-token`.
3. Copy that value and put it in the command above, in front of the command, for that one run.

Treat it as a password: it is a live session for that workspace. Do not save it in a file, a commit,
or a chat message — it belongs in the environment of one run and nowhere else. The harness prints the
identity it signed in as and the expiry, never the token. It expires on its own (seven days for an
emailed code session, about an hour for a Google one); a stale one makes the lane `skipped` with one
instruction rather than silently grading the shell — never `pass`, and never `fail` either.

**What the harness does with it.** It stores the token under `fde-google-token` for the app's own
origin only — the same key the app's own sign-in writes (`app/_components/auth-gate.tsx`), which is
the whole of what "signed in" means to this client. It then opens `/`, `/workspace?tab=people`,
`?tab=audit` and `?tab=workflows` (the app's own deep links) and grades them exactly as the signed-out
rows are graded.

**What it refuses to do.** There is no way to reach a green row without a session this deployment
accepts:

- no token, no run. `lane.json` gates the check on the variable's presence, so the check is `skipped`
  and, by the runner's rollup, the **lane** is `skipped` — never `pass`. A lane that has not seen the
  product may not certify it.
- a token the **server** refuses grades nothing. Before grading, each surface asks the deployment
  itself — a read-only `GET /api/ops/orgs` carrying that bearer, the same call the app's own ops client
  makes. 401 or 403 prints the status, marks the surface `not-covered` and exits 2 — never a quiet fall
  back to grading the shell, and never `pass`. A token minted by another key, or expired, or
  hand-written, lands here.
- a surface that renders the shell anyway fails. Each surface names a control that exists only once its
  own content has rendered (the builder's "New workflow", People's "Invite", Audit's actor filter), and
  the row also compares the control census against the *same URL loaded with no session*. If signing in
  changed nothing, the row says so and fails instead of grading the shell twice.

### A stale session is `skipped`, not `fail`

A `fail` lane is not a report — it *reverts the application* and files a defect against the mold
(`.claude/scripts/lanes.py`). So the question "is this credential still usable" must never be answered
by a graded row. A session a human copies out of a browser lasts about an hour and a full lane run is
minutes of it, so the likeliest thing that goes wrong here is not a broken application, it is a paste
that went stale between signing in and running the lane. Grading that `fail` would revert a healthy
deployment and tell a non-technical operator their app was broken when their token was.

`session-live.py` answers it **before a browser opens**, as the check's precondition, where the only
verdicts available are "run it" and `skipped`:

- the variable is missing, or is not a JWT -> `skipped`;
- `exp` is in the past -> `skipped`;
- `exp` is closer than the check's own `timeout_s` + 300s of slack -> `skipped`. Checking only that a
  token is *currently* valid is not enough: one with 40 seconds left passes and then dies in the middle
  of a fifteen-minute run;
- the deployment answers 401/403 to the read-only `GET /api/ops/orgs` -> `skipped`;
- 2xx -> the check runs.

The probe refuses to send a credential to `fde-agent*` or `fde-task-workflow*` at all (HARD RULE 2): a
`production_url` pointing at a live factory project is a provisioning defect, not a target.

**The window this does not close, stated plainly.** A session accepted by the probe and then revoked
*during* the run (signed out elsewhere, key rotated) still reaches the harness, which prints
`not-covered` and exits 2 — and the runner, which can only read a check's exit code, records that as a
lane `fail`. The margin above removes ordinary expiry from that window; what is left is one run long
and needs a deliberate act elsewhere. Closing it entirely needs the runner to be able to read "nothing
was measured" back from a harness, which is a change to `.claude/scripts/lanes.py`, not to this lane.

**The harness never mints a token.** No signing key is read here and none is in this repo; the mold's
private key (`AUTH_JWT_PRIVATE_KEY`) lives in the deployment. Minting one for a test identity would
need a factory-owned test membership in the app's database plus that key — see "What would make this
automatic" at the bottom.

**Read-only, enforced.** In signed-in mode the app writes on its own (presence, telemetry, a
chat-session backfill). Every non-GET request the page attempts is aborted and counted, and the count
is printed, so grading a real deployment cannot change it.

## Safety

- Nothing is installed into `molds/mold_v1/codebase`. axe-core ships as one standalone file, vendored
  here as `vendor/axe.min.js` (MPL-2.0) and injected with `addScriptTag`, so the lane needs no
  `node_modules` and no network at run time. `npm --prefix molds/mold_v1/testing/accessibility run vendor`
  re-vendors it; `package.json` pins the version.
- The browser aborts any request to `fde-agent`, `fde-agent-api` or `fde-task-workflow`, and to the
  `/eve/v1/` and `/.well-known/workflow/` proxy paths. A mold built without `EVE_API_URL` bakes a
  rewrite to the **live** agent into `routes-manifest.json`, so without this guard a local run would
  quietly drive production traffic. Blocked requests are counted and reported.
- Signed out, the lane reads no secret and holds no credential: its only input is a public URL.
  Signed in, it holds exactly one — the session it was handed by name in `MOLD_V1_SESSION_TOKEN`, for
  the life of the process. It is never written to a file, a report or state; it is stored only in the
  browser profile for the application's own origin (the init script checks `location.origin` before
  writing, so a third-party sign-in iframe never receives it); and only the identity it names and its
  expiry are ever printed. `session-live.py` does not print the response body either.

## Not covered

- **Anything the session cannot reach.** The signed-in check grades four surfaces (chat thread, People,
  Audit trail, workflow builder). The data room, connectors and agents tabs, the ops-centre modal inside
  the chat shell, and anything that needs a write (creating a workflow, sending a message) are not
  graded — this lane is read-only on the application it grades.
- **The signed-in surface at all, when `MOLD_V1_SESSION_TOKEN` is absent** — the check is `skipped` and
  so is the lane. Not `pass`.
- **Which identity is on screen.** A member and an owner see different controls; the lane grades the
  workspace the supplied session resolves to, and the report names that identity.
- Screen-reader output: axe checks the accessibility tree, not what NVDA or VoiceOver announces.
- Zoom to 200%, reduced motion, forced-colors, and any theme other than the one served.
- Viewport behaviour and layout shift — that is the responsiveness lane.

## Measured today (2026-09-08)

Signed out, against `claudecode_web_replica` and a locally started build of the same mold — identical:

    axe /workspace  fail  button-name[critical x1]  color-contrast[serious x7]
                          (plus best-practice landmark-one-main, page-has-heading-one, region)
    axe /, /onboard pass  29 rules passed, 1 needs review
    keyboard        pass  2, 2 and 7 tabbables, every one with a focus indicator

Signed in, against a locally built mold_v1 with its own throwaway Postgres and its own generated
keypair (a session minted by that app's own `POST /api/auth/email/verify`) — the product surface this
lane had never once measured:

    auth axe / chat thread            fail  color-contrast[serious x5]   20 controls (shell alone: 2)
    auth axe /workspace people        fail  color-contrast[serious x20]  16 controls (shell alone: 8)
    auth axe /workspace audit         fail  color-contrast[serious x15] select-name[critical x1]
    auth axe /workspace builder       fail  color-contrast[serious x15]  14 controls (shell alone: 8)
    auth keyboard /workspace people   fail  SELECT "Rows per page" takes focus with no focus indicator
    auth keyboard / chat thread       pass  20 tabbable of 22, every one with a focus indicator

One `pass` and seven `fail` on the first run — against three `pass` rows and a `not-covered` for the
same application signed out. That gap is the whole of mold_v1-040.

**Every session state, measured.** Against a throwaway local fixture with the same auth shape as the
mold (`/api/ops/orgs` 401s unless the bearer matches; the shell renders either way; surface content
only after a 200), each state was run end to end — the harness on its own, and then through
`lanes.py`'s own `run_check` with this lane's real `lane.json`:

    session state                              harness rows          exit   check      lane
    ----------------------------------------   -------------------   ----   --------   -------
    variable not set                           4 x not-covered         2    skipped    skipped
    set, not a JWT                             4 x not-covered         2    skipped    skipped
    expired (the stale-paste case)             4 x not-covered         2    skipped    skipped
    valid, but less life than the run needs    no browser opens        -    skipped    skipped
    deployment answers 401 to it               4 x not-covered         2    skipped    skipped
    accepted (200), only the shell renders     4 x fail                1    fail       fail
    accepted, the surfaces render              8 x pass                0    pass       pass

The two rows that matter are the last two: a stale credential can never revert an application, and a
deployment that takes the session and still shows nothing can never pass.

## What would make this automatic

Today a human signs in once per run. To let the factory do it unattended, three things it does not yet
have, none of which belong to this lane:

1. a **test identity per application** in state (an address the factory owns, recorded as
   `testing.identity_ref`), seeded as an `org_members` row when the app is provisioned;
2. a **mint step in `provision.py`** that signs a session for that identity with the app's own
   `AUTH_JWT_PRIVATE_KEY` (already a named secret in `infrastructure.json`) and hands it to the runner
   in the environment, never to disk;
3. the runner passing that variable through to the lane.

Each is outside `molds/mold_v1/testing/`, so each is a task, not a patch to this harness.
- **Which mold_v1 application is serving this URL.** The precondition checks that the HTML carries this
  mold's markers, which catches an undeployed URL and a URL now served by something else. It cannot
  tell two mold_v1 applications apart — they render the same markup. A wrong-but-same-mold
  `production_url` is a provisioning defect, not one this lane can see.
