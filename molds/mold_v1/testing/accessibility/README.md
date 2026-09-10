# Accessibility lane

Grades the pages a real customer lands on: axe-core 4.13.0 (WCAG 2.1 A/AA) plus a keyboard-only Tab
walk, driven by Playwright chromium against the application's **own deployed URL** — read-only, GET
only, and never against the live factory projects (see "Safety" below).

Two halves. **Signed out**: the mold's three page routes, which is a sign-in page and an empty shell.
**Signed in** (`--only auth`): the product — the chat thread, the ops centre and the workflow builder —
graded with a session the factory signs for the application's own FDE with the app's own key (see
"Authenticated coverage"). Until this second half existed, a green accessibility lane certified a
sign-in page and nothing else (mold_v1-040).

Run it through the runner, which is what writes state and the report:

    python3 .claude/scripts/lanes.py <app_id> --lane accessibility            # records the verdict
    python3 .claude/scripts/lanes.py <app_id> --lane accessibility --dry-run  # report only, no state

Or drive the harness directly against any URL — a deployment, or a locally started build of the mold:

    node molds/mold_v1/testing/accessibility/a11y.mjs --url https://<app>.vercel.app
    node molds/mold_v1/testing/accessibility/a11y.mjs --url http://127.0.0.1:3110 --only keyboard
    python3 .claude/scripts/lib/session.py <app_id> -- \
      node molds/mold_v1/testing/accessibility/a11y.mjs --url https://<app>.vercel.app --only auth
    MOLD_V1_SESSION_TOKEN='<a session you signed in for>' \
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

1. `lane-url.py <app_id>` prints a URL — `infrastructure.vercel.production_url` when it is set, else, for a
   `target: vm` fixture only, the loopback address the operator named in `MOLD_V1_LANE_URL` (see "Measuring
   a vm fixture"). Anything else is "deploy it first: `provision.py <app_id> --deploy`", or the one line
   that says why the fixture URL was refused.
2. `target-up.py <url> / /onboard /workspace --expect ...` exits 0 — the pages answer 2xx right now
   **and** the HTML they serve carries this mold's own markers. HTTP 200 is not "the application is
   there": mold_v1 apps share one Vercel project, so a stale or colliding `production_url` answers 200
   with somebody else's page. Without the markers that page was graded, found clean, and recorded
   `pass`. With them it is `skipped`, with one instruction. The markers live in `lane.json`, so a future
   mold edits its own declaration rather than the probe.

3. For the signed-in check only, `session.py <app_id> -- session-live.py <url> --min-remaining <seconds>`
   exits 0 — the helper could sign a session for this application (or an operator lent one), the
   deployment **accepts it**, lists **a workspace** for that identity, and it has enough life left to
   outlast the check that is about to run. No key, a refused session, no membership, or too little life
   makes the check `skipped` and the lane `skipped`, with one instruction. See "A stale session is
   `skipped`, not `fail`" below for why that verdict is taken here rather than in the harness.

Lane-level, `deps-check.mjs` must find Playwright chromium and the vendored rule set; if the VM has no
browser the whole lane is `skipped` with the install command, not a red lane blamed on the app.

## Authenticated coverage

`--only auth` is the half that grades the product. It needs **a session for the application under
test**, and since this round the factory makes one itself:

    python3 .claude/scripts/lanes.py <app_id> --lane accessibility

`lane.json` runs the check — and its precondition — through `.claude/scripts/lib/session.py <app_id> -- …`,
which signs a session and hands it to the harness by name in `MOLD_V1_SESSION_TOKEN`. Nothing is typed,
pasted or stored.

**Why that is a real session and not a fake.** Read from the mold, not assumed (`lib/auth-session.ts`,
`lib/ops-auth.ts`, `proxy.ts`, `app/_components/auth-gate.tsx`): every `/api/ops/*` call carries a
bearer that is either a Google ID token — signed by Google, with an `hd` claim, which the factory cannot
produce and must not try — or the app's **own** "email-session" token: ES256, signed with the app's
`AUTH_JWT_PRIVATE_KEY`, claims `{email, kind: "email-session", iss: "delivered", aud: "delivered-app",
exp}`. `verifyOpsAuth` checks that kind first and asks nothing else of it. The emailed six-digit code
gates the **route** that mints (`/api/auth/email/verify`), not the token: what that route returns after a
code is exactly this token for that email. The browser's "signed in" is the same token under
`localStorage["fde-google-token"]`. The factory generates and holds a provisioned application's key pair
by name, so it can sign the same bytes — for **the app's own FDE**, `application.workspace.fde_self.email`,
the person the app was stamped for and seeded as its workspace owner; never a hard-coded address.

**What the token does not do.** It proves an email. Membership is read from the application's database
on every request (`lib/org-context.ts`), so an identity with no workspace there lands on onboarding, and
the precondition refuses that as `skipped` ("lists no workspace for that identity") rather than grading
an empty shell.

**Where the key is read from**, by name, from the app's own secret store: `infra/vm/apps/<app_id>/.env`
for `vm_env_file`, a `vercel env pull` into a 0600 temp file (read once, deleted) for `vercel_env`. The
key is used for one signature in node's environment, the token goes into the harness's environment, and
neither ever reaches argv, a file, stdout or state. The minted session lives 30 minutes — the longest
check here is 15 and asks for 20 — not the seven days the app's own sessions get.

**An operator's session still wins.** If `MOLD_V1_SESSION_TOKEN` is already set the helper mints nothing
and runs the check with that. To measure as yourself, or as a `member` rather than the owner:

1. Open the application in Chrome and sign in the way you normally would.
2. `F12` -> **Application** -> **Local Storage** -> the app's own URL -> the row `fde-google-token`.
3. Copy that value and put it in the environment of one run:
   `MOLD_V1_SESSION_TOKEN='<paste>' python3 .claude/scripts/lanes.py <app_id> --lane accessibility`.

Treat it as a password. The harness prints the identity it signed in as and the expiry, never the token.

**What the harness does with it.** It stores the token under `fde-google-token` for the app's own
origin only — the same key the app's own sign-in writes — then opens `/`, `/workspace?tab=people`,
`?tab=audit` and `?tab=workflows` (the app's own deep links) and grades them exactly as the signed-out
rows are graded.

**What it refuses to do.** There is no way to reach a green row without a session this deployment
accepts:

- no usable session, no run. `session-live.py` is the check's precondition; it exits 1 when nothing could
  be signed (a `target: vm` app that has not run --verify-db, which mints the pair), when the deployment answers
  401/403 (the factory's key is not the one the deployment runs with), when the identity belongs to no
  workspace, or when the session cannot outlive the check. The check is `skipped` and, by the runner's
  rollup, the **lane** is `skipped` — never `pass`.
- a token the **server** refuses grades nothing. Before grading, each surface asks the deployment
  itself — a read-only `GET /api/ops/orgs` carrying that bearer, the same call the app's own ops client
  makes. 401 or 403 prints the status, marks the surface `not-covered` and exits 2 — never a quiet fall
  back to grading the shell, and never `pass`.
- a surface that renders the shell anyway fails. Each surface names a control that exists only once its
  own content has rendered (the builder's "New workflow", People's "Invite", Audit's actor filter), and
  the row also compares the control census against the *same URL loaded with no session*. If signing in
  changed nothing, the row says so and fails instead of grading the shell twice. Note the builder is
  backed by the task-workflow service (`/api/ops/workflow-definitions` answers "Task workflow service is
  not configured" without it): a deployment without that service has no builder to grade, and this row
  says so rather than passing.

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

**The harness never mints a token.** `a11y.mjs` reads one variable and never sees a key. Signing happens
in `.claude/scripts/lib/session.py`, from the application's own key, for the application's own FDE —
see "Authenticated coverage". A session that key cannot produce is the `skipped` case above, not a
`fail`.

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
- **The workflow builder on a `target: vm` fixture.** The vm lane does not run the task-workflow service
  the builder is a client of, so on a fixture named in `MOLD_V1_LANE_URL` its rows are declared
  `not-covered` with the reason; on a deployment the builder is measured and its absence is a fail.
- **The signed-in surface at all, when no usable session exists** — no key in the app's secret store (a
  `target: vm` app that has not run `--verify-db`), a key the deployment does not run with, an FDE identity with no workspace there, and
  no operator-lent session: the check is `skipped` and so is the lane. Not `pass`.
- **Any identity but the application's own FDE.** The minted session is the workspace owner's; a
  `member`'s or an invitee's controls are graded only when an operator lends such a session.
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

## Measured today (2026-09-09): the signed-in half, with no human in the loop

Against a throwaway `target: vm` application (`sess_probe`, stamped by intake, database from
`provision.py --verify-db`, the mold built from a scratch copy and started on 127.0.0.1 with that app's
own `.env`, its workspace seeded by the mold's own `fde:new-org`), the lane's exact commands:

    python3 .claude/scripts/lib/session.py sess_probe -- \
      python3 molds/mold_v1/testing/accessibility/session-live.py http://127.0.0.1:3123 --min-remaining 1200
    session minted for priyesh@onfinance.in on sess_probe (ES256, key from infra/vm/apps/sess_probe/.env, 1800s of life)
    http://127.0.0.1:3123/api/ops/orgs 200 · session accepted for priyesh@onfinance.in · member of 1 workspace(s) · 1799s left

    python3 .claude/scripts/lib/session.py sess_probe -- node …/a11y.mjs --url http://127.0.0.1:3123 --only auth
    auth axe / chat thread            fail  color-contrast[serious x1]                  20 controls (shell alone: 2)
    auth keyboard / chat thread       pass  20 tabbable of 22, every one with a focus indicator
    auth axe /workspace people        pass  16 controls (shell alone: 8), 36 rules passed
    auth keyboard /workspace people   fail  SELECT "Rows per page" takes focus with no focus indicator
    auth axe /workspace audit         fail  select-name[critical x1]                    15 controls (shell alone: 8)
    auth keyboard /workspace audit    fail  SELECT "Rows per page" takes focus with no focus indicator
    auth /workspace builder           fail  "New workflow" absent; 9 controls vs 8 signed out — the builder is the
                                            task-workflow service, which this fixture does not run

And the two ways it refuses, each measured: a key the deployment does not hold (a fresh pair written into
the app's `.env`) -> `GET /api/ops/orgs` 401 -> exit 1 -> `skipped`; an FDE identity with no membership
(`fde_self.email` swapped in state) -> 200, "lists no workspace for that identity" -> exit 1 -> `skipped`.

The same manifests, resolved by `lanes.py`'s own `unmet()` with this app and URL, report the rewired
precondition MET. `lanes.py` itself could not run the lane end to end: a `target: vm` app may hold no
`production_url` (mold_v1-053), so the runner's URL gate stops first — the vm lane never serves a web
process. The first application deployed on Vercel with its pair generated by `provision.py` is the run
that remains to be made.

## Measuring a vm fixture (2026-09-10): the runner, end to end

A `target: vm` application has no `production_url` — the vm lane brings up a database and mints the
app's key pair (`provision.py --verify-db`) but starts no web process — so until now `lanes.py` stopped
at the URL gate and the signed-in half had only ever been driven by hand. The gate is now `lane-url.py`:
it prints `production_url` when there is one, and for a vm fixture the loopback address the operator
names in **`MOLD_V1_LANE_URL`** — honoured only when the app is `target: vm` with `secret_store:
vm_env_file`, has no `production_url`, is in a status that serves nobody (planned/reverted/retired), and
the URL is plain `http://127.0.0.1:<port>` or `http://localhost:<port>` with nothing after it. Any other
address, and any vercel app, is refused with one sentence — this is not a way to aim the lane at a server
the factory did not verify. The same script hands the harness `--without task-workflow` for a fixture,
so the workflow builder is declared `not-covered` with that reason instead of failing on a control the
task-workflow service would have rendered; on a deployment it is measured.

What it took, run today (2026-09-10) against a throwaway `v040fix` — a copy of a validated vm app's
state under a new id, registered in `state/factory.json` and `state/products.json`, then removed with its
container, volume, network, state and reports. Every step below was executed in that order and the
outputs quoted are the ones it printed:

1. `python3 .claude/scripts/provision.py v040fix --verify-db` — brought up `pg-v040fix` on the private
   network `sf-v040fix`, ran the mold's schema chain, proved isolation (52/52 org-scoped tables), and
   wrote exactly four names into `infra/vm/apps/v040fix/.env` (mode 600): `POSTGRES_ADMIN_URL`,
   `DATABASE_URL`, `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_PUBLIC_KEY` (`generated AUTH_JWT key pair`).
2. The mold copied to a scratch directory — never built in place — with a hard-linked `node_modules`,
   `npm run build` (exit 0), then `next start -H 127.0.0.1 -p 3123`. **The env the app needed was those
   four names and nothing else** (plus `NEXT_TELEMETRY_DISABLED=1`), with the database host in the two
   URLs rewritten from the network alias `db` to the container's address (`docker inspect` of
   `pg-v040fix`), because the mold ran on the host rather than on the app's private network. No inference,
   blob, mail or task-workflow variable was set; the three signed-in surfaces render without them.
3. The workspace seeded once with the mold's own `npm run fde:new-org -- --name "Fix 040" --id fix-040
   --domain onfinance.in --owner <application.workspace.fde_self.email>`, with a `.env.local` in the
   SCRATCH copy holding `DATABASE_URL=<the admin URL>` (the seed writes rows the app_rw role's policies do
   not let it insert; the file was deleted right after). It created the `orgs` row and the owner +
   platform-admin membership, then its own `recipes` insert failed on a NULL `org_id` — a defect of the
   mold's seed script at that snapshot (`65fbc2d`), not of the lane; membership is what the session needs
   and it was there. **That failure is gone from the tree:** the snapshot was refreshed to `a735e5e`
   (MOLD.md; mold_v1-059), where `new-org.mjs` seeds the catalog inside the org's own scope, and the same
   command re-run on 2026-09-10 against a throwaway vm fixture (`swp_vm`, `provision.py --verify-db`, then
   `new-org.mjs` on the app's private network as the **app_rw** role, no `.env.local` written anywhere)
   printed `Recipe catalog: 5 new` and `Workflow library: 13 installed`, and the database held
   `recipes org_id=sweep-059 n=5`, `workflows org_id=sweep-059 n=13` and no NULL `org_id` row. Repeating
   these five steps today seeds the whole workspace, not just its membership.
4. `python3 .claude/scripts/lib/session.py v040fix -- python3 molds/mold_v1/testing/accessibility/session-live.py http://127.0.0.1:3123 --session-env MOLD_V1_SESSION_TOKEN --min-remaining 1200` printed
   `session accepted for <fde_self.email> · member of 1 workspace(s) · 1798s left (needs 1200s)`.
5. Then the runner itself:

    MOLD_V1_LANE_URL=http://127.0.0.1:3123 python3 .claude/scripts/lanes.py v040fix --lane accessibility --dry-run

    accessibility    fail     2/3 passed  molds/mold_v1/testing/accessibility/reports/dry/v040fix-2026-09-10T053805Z.md

    axe.wcag21aa            pass   3 rows: /, /onboard, /workspace signed out
    keyboard.traversal      pass   3 rows + the builder signpost (not-covered, as always signed out)
    authenticated.surface   fail   the signed-in product, measured through session.py by the runner itself:
      auth axe / chat thread            fail  color-contrast[serious x1]   20 controls (shell alone: 2)
      auth keyboard / chat thread       pass  20 tabbable of 22, every one with a focus indicator
      auth axe /workspace people        pass  16 controls (shell alone: 8), 36 rules passed
      auth keyboard /workspace people   fail  SELECT "Rows per page" takes focus with no focus indicator
      auth axe /workspace audit         fail  select-name[critical x1]     15 controls (shell alone: 8)
      auth keyboard /workspace audit    fail  SELECT "Rows per page" takes focus with no focus indicator
      auth /workspace builder           not-covered  declared off on this fixture: it does not run the
                                                     task-workflow service (--without task-workflow from lane-url.py)
      7 rows: 2 pass, 4 fail, 0 skipped, 1 declared not covered

The four failing rows are the same mold defects the hand-driven run found on 2026-09-09 — a real
verdict on the product surface, reached by `lanes.py` with no human in the loop, which is what
mold_v1-040 asked for. It is a `fail`, as it should be: a lane that measures the ops centre and finds
a select with no name does not pass. The report was a `--dry-run` (reports/dry/, no state written).

The guards, measured the same day: without `MOLD_V1_LANE_URL` the same command is `skipped` at the
gate with the instruction above (`0/3 passed`, no browser opened); `MOLD_V1_LANE_URL=http://10.0.0.5:3123`
is refused by `lane-url.py`; for a vercel app the variable is ignored and `production_url` wins;
`session.py <vercel app> --explain` refuses (`target is 'vercel'`); and a session signed with ANOTHER
vm app's key against this fixture is refused by the fixture itself (`/api/ops/orgs` 401) and the check is
`skipped`, never graded.

## What is still manual

- **Starting the fixture.** `provision.py --verify-db` brings up a `target: vm` app's database and mints
  its key pair, but the vm lane starts no web process (infra/vm/README.md): building the mold from a
  scratch copy and starting it on 127.0.0.1 with that app's env is the operator's step, and
  `MOLD_V1_LANE_URL` is how the lane is told where. "Measuring a vm fixture" lists exactly what that took.
- **The workflow builder on a vm fixture.** It is a client of the task-workflow service, which the vm
  lane does not run, so on a fixture it is declared `not-covered` rather than measured — the row and the
  report say so. It is measured on a deployment, where its absence is a fail.
- **A key stored Sensitive on Vercel** cannot be read by the CLI; the helper refuses and points at the
  manual path.
- **The workspace must exist.** `fde_self` is seeded as owner by whatever stamped the application
  (`fde:new-org`, a live snapshot, the onboarding wizard). Nothing in this lane writes it, and the
  precondition refuses to grade an identity with no workspace.
- **Which mold_v1 application is serving this URL.** The precondition checks that the HTML carries this
  mold's markers, which catches an undeployed URL and a URL now served by something else. It cannot
  tell two mold_v1 applications apart — they render the same markup. A wrong-but-same-mold
  `production_url` is a provisioning defect, not one this lane can see.
