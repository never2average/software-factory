# Responsiveness lane — claudecode_web_replica (2026-09-08)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-08T10:14:51+00:00. Lane status: **pass** (3 of 3 checks passed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane responsiveness`

A Playwright chromium viewport matrix (320/390/820/1440) over the mold's three page routes, grading horizontal overflow, cumulative layout shift, content a user cannot reach, tap target size and interaction latency against published budgets. A route that answers 2xx and then renders no interactive control, or a tap-target row that finds no target, fails: nothing measured is never a pass. The two timing budgets (CLS, INP) must be exceeded on every one of 3 runs before a row fails.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `layout.matrix` | pass | exit 0 | laudecode-web-opal.vercel.app · viewports 320/390/820/1440 · 0 request(s) to live fde-* hosts blocked · 12 rows: 12 pass, 0 fail, 0 skipped_ |
| `tap.targets` | pass | exit 0 | t https://claudecode-web-opal.vercel.app · viewports 390/820 · 0 request(s) to live fde-* hosts blocked · 6 rows: 6 pass, 0 fail, 0 skipped_ |
| `interaction.latency` | pass | exit 0 |  https://claudecode-web-opal.vercel.app · viewports 390/1440 · 0 request(s) to live fde-* hosts blocked · 8 rows: 8 pass, 0 fail, 0 skipped_ |

## Measured rows

### `layout.matrix`

| check | result | detail |
|---|---|---|
| layout / @ reflow-320            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0215 (budget 0.1) · no control past the edge |
| layout /onboard @ reflow-320     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0215 (budget 0.1) · no control past the edge |
| layout /workspace @ reflow-320   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ mobile-390            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0145 (budget 0.1) · no control past the edge |
| layout /onboard @ mobile-390     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0145 (budget 0.1) · no control past the edge |
| layout /workspace @ mobile-390   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 1 control(s) past the edge (Audit trail), all reachable by scrolling |
| layout / @ tablet-820            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0038 (budget 0.1) · no control past the edge |
| layout /onboard @ tablet-820     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0038 (budget 0.1) · no control past the edge |
| layout /workspace @ tablet-820   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout / @ desktop-1440          | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0023 (budget 0.1) · no control past the edge |
| layout /onboard @ desktop-1440   | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0023 (budget 0.1) · no control past the edge |
| layout /workspace @ desktop-1440 | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · viewports 320/390/820/1440 · 0 request(s) to live fde-* hosts blocked · 12 rows: 12 pass, 0 fail, 0 skipped_

### `tap.targets`

| check | result | detail |
|---|---|---|
| targets / @ mobile-390          | pass | 2 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x16 |
| targets /onboard @ mobile-390   | pass | 2 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x16 |
| targets /workspace @ mobile-390 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26 |
| targets / @ tablet-820          | pass | 2 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x16 |
| targets /onboard @ tablet-820   | pass | 2 target(s) · none under 24px · exempt: Invited by email? Sign 207x16 (spacing exception: nearest target >= 24px away) · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x16 |
| targets /workspace @ tablet-820 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |

_target https://claudecode-web-opal.vercel.app · viewports 390/820 · 0 request(s) to live fde-* hosts blocked · 6 rows: 6 pass, 0 fail, 0 skipped_

### `interaction.latency`

| check | result | detail |
|---|---|---|
| interaction /workspace click @ mobile-390      | pass | 4 in-page click(s) · INP=96ms (budget 200ms) |
| interaction / keyboard @ mobile-390            | pass | 6 Tab press(es) over 2 rendered control(s) · INP=96ms (budget 200ms) |
| interaction /onboard keyboard @ mobile-390     | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ mobile-390   | pass | 6 Tab press(es) over 8 rendered control(s) · INP=80ms (budget 200ms) |
| interaction /workspace click @ desktop-1440    | pass | 4 in-page click(s) · INP=32ms (budget 200ms) |
| interaction / keyboard @ desktop-1440          | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /onboard keyboard @ desktop-1440   | pass | 6 Tab press(es) over 2 rendered control(s) · INP=40ms (budget 200ms) |
| interaction /workspace keyboard @ desktop-1440 | pass | 6 Tab press(es) over 8 rendered control(s) · INP=32ms (budget 200ms) |

_target https://claudecode-web-opal.vercel.app · viewports 390/1440 · 0 request(s) to live fde-* hosts blocked · 8 rows: 8 pass, 0 fail, 0 skipped_


## Not covered by this lane

- Anything behind a signed-in identity. Unauthenticated this lane measures 3 routes and 2-7 controls; the ops-centre panels and the workflow builder are never rendered, so their layout at mobile width is UNMEASURED, not passing.
- Real devices, real networks and real fingers. Chromium's mobile emulation sets viewport, touch and device pixel ratio; it does not reproduce a slow CPU, a slow radio, a notch, a software keyboard covering the field being typed into, or a browser's own chrome eating vertical space.
- Orientation change, browser zoom to 200-400% (WCAG 1.4.4 Resize Text), reduced motion, forced-colors and print layout.
- Routes that do not exist in this mold snapshot. The mold has exactly three page routes (/, /onboard, /workspace); there is no /chat route, chat is rendered at /.
- Timing jitter below the repeat threshold. CLS and INP are re-measured up to 3 times and a row fails only when the budget is exceeded on every run, so a single marginal overshoot on this shared VM is reported (every sample is printed) rather than used to revert an application. A budget missed by a hair on one run in three is therefore NOT flagged.
- Interaction latency under load or with a cold cache. INP here is measured on an already-warm page against a deployed build, so it is a floor, not the number a first-time visitor on a phone will see.
- WCAG 2.5.8 exceptions this harness cannot judge: the 'equivalent' exception (the same action available through a larger control elsewhere) and the 'user agent control' and 'essential' exceptions. Targets exempted by inline-in-text or by the 24px spacing rule are named in the detail column so the exemption is auditable rather than silent.
- Whether a layout shift was worth it. CLS counts movement, not intent; a deliberate expanding panel and a janky late-loading banner score the same.
- Whether the page served is THIS application's data. The precondition checks that the HTML carries this mold's own markers, which catches an undeployed URL and a URL now served by something else; it cannot tell two mold_v1 applications apart, because they render the same markup.
