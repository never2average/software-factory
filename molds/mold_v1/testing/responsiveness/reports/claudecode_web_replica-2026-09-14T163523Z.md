# Responsiveness lane — claudecode_web_replica (2026-09-14T163523Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-14T16:35:23+00:00. Lane status: **pass** (6 of 6 checks passed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica`
This file: `molds/mold_v1/testing/responsiveness/reports/claudecode_web_replica-2026-09-14T163523Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

A Playwright chromium viewport matrix (320/390/820/1440) grading horizontal overflow, cumulative layout shift, content a user cannot reach, tap target size and interaction latency against published budgets, against the application's own deployed URL — or, for a `target: vm` fixture that has none, the mold started on this box at the loopback address the operator names in MOLD_V1_LANE_URL (lane-url.py refuses anything else) — over the mold's three page routes signed OUT, and over the product itself (chat thread and ops centre; the workflow builder only with an operator-lent session, see not_covered) signed IN with a session the factory signs for the application's own FDE identity with the app's own AUTH_JWT_PRIVATE_KEY (.claude/scripts/lib/session.py) — the same ES256 email-session token the app's verify route hands that person. A route that answers 2xx and renders no interactive control fails, a tap-target row that finds no target fails, and a signed-in surface that renders only the signed-out shell fails: nothing measured is never a pass. The two timing budgets (CLS, INP) must be exceeded on every one of 3 runs before a row fails.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `layout.matrix` | pass | exit 0 | /eve/v1 proxy blocked · 2 non-GET request(s) blocked (this lane is read-only) · 12 rows: 12 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `tap.targets` | pass | exit 0 | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 6 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `interaction.latency` | pass | exit 0 | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `layout.matrix.authenticated` | pass | exit 0 | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed |
| `tap.targets.authenticated` | pass | exit 0 | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed |
| `interaction.latency.authenticated` | pass | exit 0 | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed |

## Measured rows

### `layout.matrix`

| check | result | detail |
|---|---|---|
| layout / @ reflow-320            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ reflow-320     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ reflow-320   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ mobile-390            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ mobile-390     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ mobile-390   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ tablet-820            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ tablet-820     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ tablet-820   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout / @ desktop-1440          | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ desktop-1440   | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ desktop-1440 | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 2 non-GET request(s) blocked (this lane is read-only) · 12 rows: 12 pass, 0 fail, 0 skipped, 0 declared not covered_

### `tap.targets`

| check | result | detail |
|---|---|---|
| targets / @ mobile-390          | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x24 |
| targets /onboard @ mobile-390   | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x24 |
| targets /workspace @ mobile-390 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |
| targets / @ tablet-820          | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x24 |
| targets /onboard @ tablet-820   | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x24 |
| targets /workspace @ tablet-820 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 6 pass, 0 fail, 0 skipped, 0 declared not covered_

### `interaction.latency`

| check | result | detail |
|---|---|---|
| interaction /workspace click @ mobile-390      | pass | 4 in-page click(s) · INP=128ms (budget 200ms) |
| interaction / keyboard @ mobile-390            | pass | 6 Tab press(es) over 2 rendered control(s) · INP=112ms (budget 200ms) |
| interaction /onboard keyboard @ mobile-390     | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ mobile-390   | pass | 6 Tab press(es) over 8 rendered control(s) · INP=88ms (budget 200ms) |
| interaction /workspace click @ desktop-1440    | pass | 4 in-page click(s) · INP=24ms (budget 200ms) |
| interaction / keyboard @ desktop-1440          | pass | 6 Tab press(es) over 2 rendered control(s) · INP=152ms (budget 200ms) |
| interaction /onboard keyboard @ desktop-1440   | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ desktop-1440 | pass | 6 Tab press(es) over 8 rendered control(s) · INP=32ms (budget 200ms) |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_

### `layout.matrix.authenticated`

| check | result | detail |
|---|---|---|
| layout / chat @ reflow-320               | pass | 9 control(s) rendered · hOverflow=0px · CLS=0.0198 (budget 0.1) · no control past the edge |
| layout /workspace people @ reflow-320    | pass | 64 control(s) rendered · hOverflow=0px · CLS=0.0157 (budget 0.1) · 42 control(s) past the edge (Project workflows, Audit trail, + Add to workspace, Actions), all reachable by scrolling |
| layout /workspace audit @ reflow-320     | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0157 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout /workspace builder @ reflow-320   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0157 (budget 0.1) · 3 control(s) past the edge (Project workflows, Audit trail, Actions), all reachable by scrolling |
| layout / chat @ mobile-390               | pass | 9 control(s) rendered · hOverflow=0px · CLS=0.0178 (budget 0.1) · no control past the edge |
| layout /workspace people @ mobile-390    | pass | 64 control(s) rendered · hOverflow=0px · CLS=0.0150 (budget 0.1) · 42 control(s) past the edge (Project workflows, Audit trail, + Add to workspace, Actions), all reachable by scrolling |
| layout /workspace audit @ mobile-390     | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0150 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout /workspace builder @ mobile-390   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0150 (budget 0.1) · 3 control(s) past the edge (Project workflows, Audit trail, Actions), all reachable by scrolling |
| layout / chat @ tablet-820               | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0051 (budget 0.1) · no control past the edge |
| layout /workspace people @ tablet-820    | pass | 64 control(s) rendered · hOverflow=0px · CLS=0.0111 (budget 0.1) · 6 control(s) past the edge (+ Add to workspace, + Add to workspace, Actions, Actions), all reachable by scrolling |
| layout /workspace audit @ tablet-820     | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0111 (budget 0.1) · no control past the edge |
| layout /workspace builder @ tablet-820   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0114 (budget 0.1) · no control past the edge |
| layout / chat @ desktop-1440             | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0042 (budget 0.1) · no control past the edge |
| layout /workspace people @ desktop-1440  | pass | 64 control(s) rendered · hOverflow=0px · CLS=0.0089 (budget 0.1) · 10 control(s) past the edge (+ Add to workspace, + Add to workspace, + Add to workspace, + Add to workspace), all reachable by scrolling |
| layout /workspace audit @ desktop-1440   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0089 (budget 0.1) · no control past the edge |
| layout /workspace builder @ desktop-1440 | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0089 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 8 non-GET request(s) blocked (this lane is read-only) · 16 rows: 16 pass, 0 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed

### `tap.targets.authenticated`

| check | result | detail |
|---|---|---|
| targets / chat @ mobile-390             | pass | 9 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Open sidebar 28x28, Customer context 150x26, Attach files 32x32 |
| targets /workspace people @ mobile-390  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 162x32 |
| targets /workspace audit @ mobile-390   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 162x32 |
| targets /workspace builder @ mobile-390 | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 162x32 |
| targets / chat @ tablet-820             | pass | 24 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): OAOnfinance AI 150x32, New chat 28x28, Search chats 28x28 |
| targets /workspace people @ tablet-820  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 229x32 |
| targets /workspace audit @ tablet-820   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 229x32 |
| targets /workspace builder @ tablet-820 | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Workspace 229x32 |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 4 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed

### `interaction.latency.authenticated`

| check | result | detail |
|---|---|---|
| interaction / chat click @ mobile-390                  | pass | 3 in-page click(s) · INP=184ms (budget 200ms) |
| interaction /workspace people click @ mobile-390       | pass | 4 in-page click(s) · INP=104ms (budget 200ms) |
| interaction /workspace audit click @ mobile-390        | pass | 4 in-page click(s) · INP=112ms (budget 200ms) |
| interaction /workspace builder click @ mobile-390      | pass | 4 in-page click(s) · INP=328/240/120ms over 3 runs, best 120ms (budget 200ms) |
| interaction / chat keyboard @ mobile-390               | pass | 6 Tab press(es) over 9 rendered control(s) · INP=176ms (budget 200ms) |
| interaction /workspace people keyboard @ mobile-390    | pass | 6 Tab press(es) over 64 rendered control(s) · INP=88ms (budget 200ms) |
| interaction /workspace audit keyboard @ mobile-390     | pass | 6 Tab press(es) over 16 rendered control(s) · INP=144ms (budget 200ms) |
| interaction /workspace builder keyboard @ mobile-390   | pass | 6 Tab press(es) over 16 rendered control(s) · INP=216/120ms over 2 runs, best 120ms (budget 200ms) |
| interaction / chat click @ desktop-1440                | pass | 4 in-page click(s) · INP=288/272/200ms over 3 runs, best 200ms (budget 200ms) |
| interaction /workspace people click @ desktop-1440     | pass | 4 in-page click(s) · INP=144ms (budget 200ms) |
| interaction /workspace audit click @ desktop-1440      | pass | 4 in-page click(s) · INP=80ms (budget 200ms) |
| interaction /workspace builder click @ desktop-1440    | pass | 4 in-page click(s) · INP=72ms (budget 200ms) |
| interaction / chat keyboard @ desktop-1440             | pass | 6 Tab press(es) over 24 rendered control(s) · INP=288/256/120ms over 3 runs, best 120ms (budget 200ms) |
| interaction /workspace people keyboard @ desktop-1440  | pass | 6 Tab press(es) over 64 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace audit keyboard @ desktop-1440   | pass | 6 Tab press(es) over 16 rendered control(s) · INP=40ms (budget 200ms) |
| interaction /workspace builder keyboard @ desktop-1440 | pass | 6 Tab press(es) over 16 rendered control(s) · INP=32ms (budget 200ms) |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 36 non-GET request(s) blocked (this lane is read-only) · 16 rows: 16 pass, 0 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T16:30:22.000Z); the token itself is never printed


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
