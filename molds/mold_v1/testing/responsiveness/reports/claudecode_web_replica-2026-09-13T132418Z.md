# Responsiveness lane — claudecode_web_replica (2026-09-13T132418Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-13T13:24:18+00:00. Lane status: **fail** (1 of 6 checks passed, 2 failed, 3 skipped).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/responsiveness/reports/claudecode_web_replica-2026-09-13T132418Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

A Playwright chromium viewport matrix (320/390/820/1440) grading horizontal overflow, cumulative layout shift, content a user cannot reach, tap target size and interaction latency against published budgets, against the application's own deployed URL — or, for a `target: vm` fixture that has none, the mold started on this box at the loopback address the operator names in MOLD_V1_LANE_URL (lane-url.py refuses anything else) — over the mold's three page routes signed OUT, and over the product itself (chat thread and ops centre; the workflow builder only with an operator-lent session, see not_covered) signed IN with a session the factory signs for the application's own FDE identity with the app's own AUTH_JWT_PRIVATE_KEY (.claude/scripts/lib/session.py) — the same ES256 email-session token the app's verify route hands that person. A route that answers 2xx and renders no interactive control fails, a tap-target row that finds no target fails, and a signed-in surface that renders only the signed-out shell fails: nothing measured is never a pass. The two timing budgets (CLS, INP) must be exceeded on every one of 3 runs before a row fails.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `layout.matrix` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// |  /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 12 rows: 4 pass, 8 fail, 0 skipped, 0 declared not covered_ |
| `tap.targets` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 4 pass, 2 fail, 0 skipped, 0 declared not covered_ |
| `interaction.latency` | pass | exit 0 | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `layout.matrix.authenticated` | skipped | No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this d |  |
| `tap.targets.authenticated` | skipped | No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this d |  |
| `interaction.latency.authenticated` | skipped | No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this d |  |

## Failures

### `layout.matrix` — exit 1, expected 0; output matched the forbidden /\| fail \|/
A page that scrolls sideways at 320px, or that shifts under the reader's finger, or that hides a control where no scroll can reach it, is a customer who cannot finish the task on the device they actually own.

`node /root/software-factory/molds/mold_v1/testing/responsiveness/responsive.mjs $(python3 /root/software-factory/molds/mold_v1/testing/responsiveness/lane-url.py claudecode_web_replica --harness) --only layout`

```
| check | result | detail |
|---|---|---|
| layout / @ reflow-320            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ reflow-320     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ reflow-320   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ mobile-390            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ mobile-390     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ mobile-390   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 1 control(s) past the edge (Audit trail), all reachable by scrolling |
| layout / @ tablet-820            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ tablet-820     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ tablet-820   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout / @ desktop-1440          | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ desktop-1440   | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ desktop-1440 | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 12 rows: 4 pass, 8 fail, 0 skipped, 0 declared not covered_
```

### `tap.targets` — exit 1, expected 0; output matched the forbidden /\| fail \|/
A control smaller than a fingertip, with another control beside it, is a mis-tap: on a touch screen that is the difference between sending a message and deleting one.

`node /root/software-factory/molds/mold_v1/testing/responsiveness/responsive.mjs $(python3 /root/software-factory/molds/mold_v1/testing/responsiveness/lane-url.py claudecode_web_replica --harness) --only targets`

```
| check | result | detail |
|---|---|---|
| targets / @ mobile-390          | pass | 3 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /onboard @ mobile-390   | pass | 3 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /workspace @ mobile-390 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26 |
| targets / @ tablet-820          | fail | 3 target(s) · UNDER 24px: Invited by email? Sign 207x16 · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /onboard @ tablet-820   | fail | 3 target(s) · UNDER 24px: Invited by email? Sign 207x16 · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /workspace @ tablet-820 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 4 pass, 2 fail, 0 skipped, 0 declared not covered_
```


## Measured rows

### `layout.matrix`

| check | result | detail |
|---|---|---|
| layout / @ reflow-320            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ reflow-320     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ reflow-320   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ mobile-390            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ mobile-390     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ mobile-390   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 1 control(s) past the edge (Audit trail), all reachable by scrolling |
| layout / @ tablet-820            | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ tablet-820     | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ tablet-820   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout / @ desktop-1440          | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /onboard @ desktop-1440   | fail | 1 control(s) unreachable even after scrolling: Continue with GoogleCont [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace @ desktop-1440 | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 12 rows: 4 pass, 8 fail, 0 skipped, 0 declared not covered_

### `tap.targets`

| check | result | detail |
|---|---|---|
| targets / @ mobile-390          | pass | 3 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /onboard @ mobile-390   | pass | 3 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /workspace @ mobile-390 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26 |
| targets / @ tablet-820          | fail | 3 target(s) · UNDER 24px: Invited by email? Sign 207x16 · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /onboard @ tablet-820   | fail | 3 target(s) · UNDER 24px: Invited by email? Sign 207x16 · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Continue with GoogleCo 400x40, Invited by email? Sign 207x16 |
| targets /workspace @ tablet-820 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 4 pass, 2 fail, 0 skipped, 0 declared not covered_

### `interaction.latency`

| check | result | detail |
|---|---|---|
| interaction /workspace click @ mobile-390      | pass | 4 in-page click(s) · INP=128ms (budget 200ms) |
| interaction / keyboard @ mobile-390            | pass | 6 Tab press(es) over 3 rendered control(s) · INP=216/112ms over 2 runs, best 112ms (budget 200ms) |
| interaction /onboard keyboard @ mobile-390     | pass | 6 Tab press(es) over 3 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ mobile-390   | pass | 6 Tab press(es) over 8 rendered control(s) · INP=96ms (budget 200ms) |
| interaction /workspace click @ desktop-1440    | pass | 4 in-page click(s) · INP=288/104ms over 2 runs, best 104ms (budget 200ms) |
| interaction / keyboard @ desktop-1440          | pass | 6 Tab press(es) over 3 rendered control(s) · INP=200ms (budget 200ms) |
| interaction /onboard keyboard @ desktop-1440   | pass | 6 Tab press(es) over 3 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ desktop-1440 | pass | 6 Tab press(es) over 8 rendered control(s) · INP=32ms (budget 200ms) |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_


## Skipped, and what would make them run

- `layout.matrix.authenticated` — No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this deployment must then accept it, list a workspace for that identity, and leave it 1200s of life. Run `python3 .claude/scripts/lib/session.py claudecode_web_replica -- python3 /root/software-factory/molds/mold_v1/testing/responsiveness/session-live.py <the URL lane-url.py prints> --session-env MOLD_V1_SESSION_TOKEN --min-remaining 1200` to see which of those failed, in one sentence (no key on this target, a key the deployment does not run with, no membership); or sign in to the app yourself and re-run the lane with that browser's `fde-google-token` in MOLD_V1_SESSION_TOKEN, which the helper leaves untouched — molds/mold_v1/testing/responsiveness/README.md, "Authenticated coverage". Until then this check is `skipped` and so is the LANE: never `pass`, and never `fail` either — an unusable session is not a defect of the application.
- `tap.targets.authenticated` — No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this deployment must then accept it, list a workspace for that identity, and leave it 900s of life. Run `python3 .claude/scripts/lib/session.py claudecode_web_replica -- python3 /root/software-factory/molds/mold_v1/testing/responsiveness/session-live.py <the URL lane-url.py prints> --session-env MOLD_V1_SESSION_TOKEN --min-remaining 900` to see which of those failed, in one sentence (no key on this target, a key the deployment does not run with, no membership); or sign in to the app yourself and re-run the lane with that browser's `fde-google-token` in MOLD_V1_SESSION_TOKEN, which the helper leaves untouched — molds/mold_v1/testing/responsiveness/README.md, "Authenticated coverage". Until then this check is `skipped` and so is the LANE: never `pass`, and never `fail` either — an unusable session is not a defect of the application.
- `interaction.latency.authenticated` — No usable session for the signed-in product: the factory signs one for this application's own FDE (application.workspace.fde_self.email) with the app's AUTH_JWT_PRIVATE_KEY, read by name from its secret store, and this deployment must then accept it, list a workspace for that identity, and leave it 1200s of life. Run `python3 .claude/scripts/lib/session.py claudecode_web_replica -- python3 /root/software-factory/molds/mold_v1/testing/responsiveness/session-live.py <the URL lane-url.py prints> --session-env MOLD_V1_SESSION_TOKEN --min-remaining 1200` to see which of those failed, in one sentence (no key on this target, a key the deployment does not run with, no membership); or sign in to the app yourself and re-run the lane with that browser's `fde-google-token` in MOLD_V1_SESSION_TOKEN, which the helper leaves untouched — molds/mold_v1/testing/responsiveness/README.md, "Authenticated coverage". Until then this check is `skipped` and so is the LANE: never `pass`, and never `fail` either — an unusable session is not a defect of the application.

A skipped check is why this lane cannot report `pass`: nothing measured it.

## Not covered by this lane

- Anything the session token cannot reach. The signed-in checks measure four surfaces (chat thread, People, Audit trail, workflow builder); the data room, connectors and agents tabs, the ops-centre modal inside the chat shell, and anything that needs a write (creating a workflow, sending a message) are NOT measured — this lane is read-only on the application it grades and every non-GET the browser attempts is aborted and counted.
- The workflow builder on a `target: vm` fixture. The vm lane runs the web app alone; the builder is a client of the task-workflow service, one of the deployables the vm lane does not run (infra/vm/README.md), so on a fixture named in MOLD_V1_LANE_URL lane-url.py passes `--without task-workflow` and the builder rows print `not-covered` ("declared off on this fixture") instead of failing on a control the service would have rendered. The harness honours `--without` only when its --url is loopback (127.0.0.1 / localhost, the only addresses lane-url.py ever names for a fixture) and drops it anywhere else, so the `declared off on this fixture` row cannot be reached on a deployment; where it appears, the check's expect.skip_on records the check `skipped` (its measured rows still print) and the lane is then `skipped`, never `pass`. On a deployment the factory mints no session at all (session.py refuses every target=vercel app), so the builder has been measured by NO run of this lane to date; it is measured only with a session an operator signs in for and lends in MOLD_V1_SESSION_TOKEN, and its absence is then a fail. The three other signed-in surfaces (chat, People, Audit trail) have been measured on a vm fixture only, for the same reason.
- The signed-in surface at all, whenever no usable session exists: the factory mints one from the application's own key (.claude/scripts/lib/session.py), so this is now the case where that key is not in the app's secret store (a `target: vm` app that has not run --verify-db, which mints the pair into infra/vm/apps/<app>/.env), is not the key the deployment runs with, or the FDE identity belongs to no workspace there — and no operator lent a session in MOLD_V1_SESSION_TOKEN. session-live.py makes those checks `skipped` before a browser opens, and the LANE is then `skipped`. It is never `pass` on the strength of the signed-out rows alone (mold_v1-040), and never `fail` — an unusable session is not a defect of the application.
- Any identity but the application's own FDE. The minted session is for application.workspace.fde_self.email, the workspace owner; what a `member` or an invitee sees is measured only when an operator signs in as one and lends that session.
- Which identity's data is on screen, and how much of it. A workspace with a hundred members lays out differently from the one this session resolves to; the lane measures the workspace it was given.
- Real devices, real networks and real fingers. Chromium's mobile emulation sets viewport, touch and device pixel ratio; it does not reproduce a slow CPU, a slow radio, a notch, a software keyboard covering the field being typed into, or a browser's own chrome eating vertical space.
- Orientation change, browser zoom to 200-400% (WCAG 1.4.4 Resize Text), reduced motion, forced-colors and print layout.
- Routes that do not exist in this mold snapshot. The mold has exactly three page routes (/, /onboard, /workspace); there is no /chat route, chat is rendered at /.
- Timing jitter below the repeat threshold. CLS and INP are re-measured up to 3 times and a row fails only when the budget is exceeded on every run, so a single marginal overshoot on this shared VM is reported (every sample is printed) rather than used to revert an application. A budget missed by a hair on one run in three is therefore NOT flagged.
- Interaction latency under load or with a cold cache. INP here is measured on an already-warm page against a deployed build, so it is a floor, not the number a first-time visitor on a phone will see.
- WCAG 2.5.8 exceptions this harness cannot judge: the 'equivalent' exception (the same action available through a larger control elsewhere) and the 'user agent control' and 'essential' exceptions. Targets exempted by inline-in-text or by the 24px spacing rule are named in the detail column so the exemption is auditable rather than silent.
- Whether a layout shift was worth it. CLS counts movement, not intent; a deliberate expanding panel and a janky late-loading banner score the same.
- Whether the page served is THIS application's data. The precondition checks that the HTML carries this mold's own markers, which catches an undeployed URL and a URL now served by something else; it cannot tell two mold_v1 applications apart, because they render the same markup.
