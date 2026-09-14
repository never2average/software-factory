# Responsiveness lane — claudecode_web_replica (2026-09-14T092253Z)

Mold: mold_v1 (commit dc98cb6c0c25ef81304fb6cf1db172396e62b805).
Run at 2026-09-14T09:22:53+00:00. Lane status: **fail** (3 of 6 checks passed, 3 failed).
Command: `python3 .claude/scripts/lanes.py claudecode_web_replica --lane responsiveness`
This file: `molds/mold_v1/testing/responsiveness/reports/claudecode_web_replica-2026-09-14T092253Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

A Playwright chromium viewport matrix (320/390/820/1440) grading horizontal overflow, cumulative layout shift, content a user cannot reach, tap target size and interaction latency against published budgets, against the application's own deployed URL — or, for a `target: vm` fixture that has none, the mold started on this box at the loopback address the operator names in MOLD_V1_LANE_URL (lane-url.py refuses anything else) — over the mold's three page routes signed OUT, and over the product itself (chat thread and ops centre; the workflow builder only with an operator-lent session, see not_covered) signed IN with a session the factory signs for the application's own FDE identity with the app's own AUTH_JWT_PRIVATE_KEY (.claude/scripts/lib/session.py) — the same ES256 email-session token the app's verify route hands that person. A route that answers 2xx and renders no interactive control fails, a tap-target row that finds no target fails, and a signed-in surface that renders only the signed-out shell fails: nothing measured is never a pass. The two timing budgets (CLS, INP) must be exceeded on every one of 3 runs before a row fails.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `layout.matrix` | pass | exit 0 | /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 12 rows: 12 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `tap.targets` | pass | exit 0 | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 6 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `interaction.latency` | pass | exit 0 | e /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `layout.matrix.authenticated` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed |
| `tap.targets.authenticated` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed |
| `interaction.latency.authenticated` | fail | exit 1, expected 0; output matched the forbidden /\/ fail \// | n operator's own sign-in wins) signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed |

## Failures

### `layout.matrix.authenticated` — exit 1, expected 0; output matched the forbidden /\| fail \|/
The workspace a customer actually works in is the one that has to reflow at 320px. Signed out this matrix measured a sign-in page with two buttons on it and printed 12 green rows.

`python3 /root/software-factory/.claude/scripts/lib/session.py claudecode_web_replica -- node /root/software-factory/molds/mold_v1/testing/responsiveness/responsive.mjs $(python3 /root/software-factory/molds/mold_v1/testing/responsiveness/lane-url.py claudecode_web_replica --harness) --only layout --auth`

```
layout /workspace audit @ reflow-320     | fail | horizontal scroll 114px at 320px wide (budget 0px, WCAG 1.4.10) · 1 control(s) unreachable even after scrolling: Finish setup, 5 of 6 che [still past the edge, right=433 > 320] |
| layout /workspace builder @ reflow-320   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ mobile-390               | fail | 2 control(s) unreachable even after scrolling: Browser [clipped by an overflow-x:hidden ancestor a user cannot scroll], Build [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace people @ mobile-390    | fail | horizontal scroll 43px at 390px wide (budget 0px, WCAG 1.4.10) · 45 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-x:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-x:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ mobile-390     | fail | horizontal scroll 43px at 390px wide (budget 0px, WCAG 1.4.10) |
| layout /workspace builder @ mobile-390   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ tablet-820               | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0051 (budget 0.1) · no control past the edge |
| layout /workspace people @ tablet-820    | fail | 21 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-y:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ tablet-820     | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0111 (budget 0.1) · no control past the edge |
| layout /workspace builder @ tablet-820   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ desktop-1440             | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0042 (budget 0.1) · no control past the edge |
| layout /workspace people @ desktop-1440  | fail | 29 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-y:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ desktop-1440   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0089 (budget 0.1) · no control past the edge |
| layout /workspace builder @ desktop-1440 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 8 non-GET request(s) blocked (this lane is read-only) · 16 rows: 4 pass, 12 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed
```

### `tap.targets.authenticated` — exit 1, expected 0; output matched the forbidden /\| fail \|/
The ops centre is where the small controls live — row actions, pagination, filter chips. Signed out none of them is on screen, so the tap-target budget was being enforced against a page with two full-width buttons.

`python3 /root/software-factory/.claude/scripts/lib/session.py claudecode_web_replica -- node /root/software-factory/molds/mold_v1/testing/responsiveness/responsive.mjs $(python3 /root/software-factory/molds/mold_v1/testing/responsiveness/lane-url.py claudecode_web_replica --harness) --only targets --auth`

```
| check | result | detail |
|---|---|---|
| targets / chat @ mobile-390             | pass | 24 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): OAOnfinance AI 150x32, New chat 28x28, Search chats 28x28 |
| targets /workspace people @ mobile-390  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace audit @ mobile-390   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace builder @ mobile-390 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| targets / chat @ tablet-820             | pass | 24 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): OAOnfinance AI 150x32, New chat 28x28, Search chats 28x28 |
| targets /workspace people @ tablet-820  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace audit @ tablet-820   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace builder @ tablet-820 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 4 non-GET request(s) blocked (this lane is read-only) · 8 rows: 6 pass, 2 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed
```

### `interaction.latency.authenticated` — exit 1, expected 0; output matched the forbidden /\| fail \|/
Switching a workspace tab and typing in the composer are the interactions this product IS. INP measured on a sign-in page is a number about a page nobody spends time on.

`python3 /root/software-factory/.claude/scripts/lib/session.py claudecode_web_replica -- node /root/software-factory/molds/mold_v1/testing/responsiveness/responsive.mjs $(python3 /root/software-factory/molds/mold_v1/testing/responsiveness/lane-url.py claudecode_web_replica --harness) --only interaction --auth`

```
| check | result | detail |
|---|---|---|
| interaction / chat click @ mobile-390                  | pass | 4 in-page click(s) · INP=120ms (budget 200ms) |
| interaction /workspace people click @ mobile-390       | pass | 4 in-page click(s) · INP=88ms (budget 200ms) |
| interaction /workspace audit click @ mobile-390        | pass | 4 in-page click(s) · INP=88ms (budget 200ms) |
| interaction /workspace builder click @ mobile-390      | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat keyboard @ mobile-390               | pass | 6 Tab press(es) over 24 rendered control(s) · INP=104ms (budget 200ms) |
| interaction /workspace people keyboard @ mobile-390    | pass | 6 Tab press(es) over 64 rendered control(s) · INP=72ms (budget 200ms) |
| interaction /workspace audit keyboard @ mobile-390     | pass | 6 Tab press(es) over 16 rendered control(s) · INP=80ms (budget 200ms) |
| interaction /workspace builder keyboard @ mobile-390   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat click @ desktop-1440                | pass | 4 in-page click(s) · INP=216/232/192ms over 3 runs, best 192ms (budget 200ms) |
| interaction /workspace people click @ desktop-1440     | pass | 4 in-page click(s) · INP=56ms (budget 200ms) |
| interaction /workspace audit click @ desktop-1440      | pass | 4 in-page click(s) · INP=72ms (budget 200ms) |
| interaction /workspace builder click @ desktop-1440    | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat keyboard @ desktop-1440             | pass | 6 Tab press(es) over 24 rendered control(s) · INP=232/152ms over 2 runs, best 152ms (budget 200ms) |
| interaction /workspace people keyboard @ desktop-1440  | pass | 6 Tab press(es) over 64 rendered control(s) · INP=40ms (budget 200ms) |
| interaction /workspace audit keyboard @ desktop-1440   | pass | 6 Tab press(es) over 16 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace builder keyboard @ desktop-1440 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 30 non-GET request(s) blocked (this lane is read-only) · 16 rows: 12 pass, 4 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed
```


## Measured rows

### `layout.matrix`

| check | result | detail |
|---|---|---|
| layout / @ reflow-320            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ reflow-320     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ reflow-320   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 2 control(s) past the edge (Project workflows, Audit trail), all reachable by scrolling |
| layout / @ mobile-390            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ mobile-390     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ mobile-390   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · 1 control(s) past the edge (Audit trail), all reachable by scrolling |
| layout / @ tablet-820            | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ tablet-820     | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ tablet-820   | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout / @ desktop-1440          | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /onboard @ desktop-1440   | pass | 2 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |
| layout /workspace @ desktop-1440 | pass | 8 control(s) rendered · hOverflow=0px · CLS=0.0000 (budget 0.1) · no control past the edge |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 12 rows: 12 pass, 0 fail, 0 skipped, 0 declared not covered_

### `tap.targets`

| check | result | detail |
|---|---|---|
| targets / @ mobile-390          | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x24 |
| targets /onboard @ mobile-390   | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 342x40, Invited by email? Sign 207x24 |
| targets /workspace @ mobile-390 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26 |
| targets / @ tablet-820          | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x24 |
| targets /onboard @ tablet-820   | pass | 2 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Continue with Google 384x40, Invited by email? Sign 207x24 |
| targets /workspace @ tablet-820 | pass | 7 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Data room 87x36, People 65x36 |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 6 rows: 6 pass, 0 fail, 0 skipped, 0 declared not covered_

### `interaction.latency`

| check | result | detail |
|---|---|---|
| interaction /workspace click @ mobile-390      | pass | 4 in-page click(s) · INP=104ms (budget 200ms) |
| interaction / keyboard @ mobile-390            | pass | 6 Tab press(es) over 2 rendered control(s) · INP=104ms (budget 200ms) |
| interaction /onboard keyboard @ mobile-390     | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ mobile-390   | pass | 6 Tab press(es) over 8 rendered control(s) · INP=104ms (budget 200ms) |
| interaction /workspace click @ desktop-1440    | pass | 4 in-page click(s) · INP=16ms (budget 200ms) |
| interaction / keyboard @ desktop-1440          | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /onboard keyboard @ desktop-1440   | pass | 6 Tab press(es) over 2 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace keyboard @ desktop-1440 | pass | 6 Tab press(es) over 8 rendered control(s) · INP=40ms (budget 200ms) |

_target https://claudecode-web-opal.vercel.app · signed out · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 0 non-GET request(s) blocked (this lane is read-only) · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_

### `layout.matrix.authenticated`

| check | result | detail |
|---|---|---|
| layout / chat @ reflow-320               | fail | 4 control(s) unreachable even after scrolling: Customer context [still past the edge, right=406 > 320], Search [clipped by an overflow-x:hidden ancestor a user cannot scroll], Browser [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace people @ reflow-320    | fail | horizontal scroll 114px at 320px wide (budget 0px, WCAG 1.4.10) · 46 control(s) unreachable even after scrolling: Finish setup, 5 of 6 che [still past the edge, right=433 > 320], + Add to workspace [clipped by an overflow-x:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ reflow-320     | fail | horizontal scroll 114px at 320px wide (budget 0px, WCAG 1.4.10) · 1 control(s) unreachable even after scrolling: Finish setup, 5 of 6 che [still past the edge, right=433 > 320] |
| layout /workspace builder @ reflow-320   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ mobile-390               | fail | 2 control(s) unreachable even after scrolling: Browser [clipped by an overflow-x:hidden ancestor a user cannot scroll], Build [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace people @ mobile-390    | fail | horizontal scroll 43px at 390px wide (budget 0px, WCAG 1.4.10) · 45 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-x:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-x:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-x:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ mobile-390     | fail | horizontal scroll 43px at 390px wide (budget 0px, WCAG 1.4.10) |
| layout /workspace builder @ mobile-390   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ tablet-820               | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0051 (budget 0.1) · no control past the edge |
| layout /workspace people @ tablet-820    | fail | 21 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-y:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ tablet-820     | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0111 (budget 0.1) · no control past the edge |
| layout /workspace builder @ tablet-820   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| layout / chat @ desktop-1440             | pass | 24 control(s) rendered · hOverflow=0px · CLS=0.0042 (budget 0.1) · no control past the edge |
| layout /workspace people @ desktop-1440  | fail | 29 control(s) unreachable even after scrolling: + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll], Actions [clipped by an overflow-y:hidden ancestor a user cannot scroll], + Add to workspace [clipped by an overflow-y:hidden ancestor a user cannot scroll] |
| layout /workspace audit @ desktop-1440   | pass | 16 control(s) rendered · hOverflow=0px · CLS=0.0089 (budget 0.1) · no control past the edge |
| layout /workspace builder @ desktop-1440 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 320/390/820/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 8 non-GET request(s) blocked (this lane is read-only) · 16 rows: 4 pass, 12 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed

### `tap.targets.authenticated`

| check | result | detail |
|---|---|---|
| targets / chat @ mobile-390             | pass | 24 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): OAOnfinance AI 150x32, New chat 28x28, Search chats 28x28 |
| targets /workspace people @ mobile-390  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace audit @ mobile-390   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace builder @ mobile-390 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| targets / chat @ tablet-820             | pass | 24 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): OAOnfinance AI 150x32, New chat 28x28, Search chats 28x28 |
| targets /workspace people @ tablet-820  | pass | 63 target(s) · none under 24px · exempt: + Add to workspace (inline in text); + Add to workspace (inline in text); + Add to workspace (inline in text) · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace audit @ tablet-820   | pass | 14 target(s) · none under 24px · reported only (<44px, SC 2.5.5 AAA): Back to chat 115x26, Change workspace logo 28x28, Onfinance AI (org-onfi 229x32 |
| targets /workspace builder @ tablet-820 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/820 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 4 non-GET request(s) blocked (this lane is read-only) · 8 rows: 6 pass, 2 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed

### `interaction.latency.authenticated`

| check | result | detail |
|---|---|---|
| interaction / chat click @ mobile-390                  | pass | 4 in-page click(s) · INP=120ms (budget 200ms) |
| interaction /workspace people click @ mobile-390       | pass | 4 in-page click(s) · INP=88ms (budget 200ms) |
| interaction /workspace audit click @ mobile-390        | pass | 4 in-page click(s) · INP=88ms (budget 200ms) |
| interaction /workspace builder click @ mobile-390      | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat keyboard @ mobile-390               | pass | 6 Tab press(es) over 24 rendered control(s) · INP=104ms (budget 200ms) |
| interaction /workspace people keyboard @ mobile-390    | pass | 6 Tab press(es) over 64 rendered control(s) · INP=72ms (budget 200ms) |
| interaction /workspace audit keyboard @ mobile-390     | pass | 6 Tab press(es) over 16 rendered control(s) · INP=80ms (budget 200ms) |
| interaction /workspace builder keyboard @ mobile-390   | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat click @ desktop-1440                | pass | 4 in-page click(s) · INP=216/232/192ms over 3 runs, best 192ms (budget 200ms) |
| interaction /workspace people click @ desktop-1440     | pass | 4 in-page click(s) · INP=56ms (budget 200ms) |
| interaction /workspace audit click @ desktop-1440      | pass | 4 in-page click(s) · INP=72ms (budget 200ms) |
| interaction /workspace builder click @ desktop-1440    | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |
| interaction / chat keyboard @ desktop-1440             | pass | 6 Tab press(es) over 24 rendered control(s) · INP=232/152ms over 2 runs, best 152ms (budget 200ms) |
| interaction /workspace people keyboard @ desktop-1440  | pass | 6 Tab press(es) over 64 rendered control(s) · INP=40ms (budget 200ms) |
| interaction /workspace audit keyboard @ desktop-1440   | pass | 6 Tab press(es) over 16 rendered control(s) · INP=32ms (budget 200ms) |
| interaction /workspace builder keyboard @ desktop-1440 | fail | signed in and accepted (200), but this surface did not render: the workflow builder's "New workflow" control is absent; 10 control(s) signed in vs 8 signed out — the shell renders either way, so grading this would have measured the shell, not the surface. |

_target https://claudecode-web-opal.vercel.app · SIGNED IN · viewports 390/1440 · 0 request(s) to the live projects or the /eve/v1 proxy blocked · 30 non-GET request(s) blocked (this lane is read-only) · 16 rows: 12 pass, 4 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-09-21T09:18:11.000Z); the token itself is never printed


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
