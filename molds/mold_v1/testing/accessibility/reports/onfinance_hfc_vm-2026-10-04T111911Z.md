# Accessibility lane — onfinance_hfc_vm (2026-10-04T111911Z)

Mold: mold_v1 (commit 4ad0c2c05e11449e442c1ad5419cee56a1cfc451).
Run at 2026-10-04T11:19:11+00:00. Lane status: **pass** (3 of 3 checks passed).
Command: `python3 .claude/scripts/lanes.py onfinance_hfc_vm`
This file: `molds/mold_v1/testing/accessibility/reports/onfinance_hfc_vm-2026-10-04T111911Z.md` — written once, then left read-only. The runner creates a report O_EXCL and never reopens one, so a later run of this lane writes its own file beside this one rather than editing it. If the bytes here ever change, something other than lanes.py changed them.

axe-core 4.13.0 (WCAG 2.1 A/AA) and keyboard-only traversal, driven by Playwright chromium against the application's own deployed URL — or, for a `target: vm` fixture that has none, the mold started on this box at the loopback address the operator names in MOLD_V1_LANE_URL (lane-url.py refuses anything else): the mold's three page routes signed OUT, and the product itself — chat thread and ops centre; the workflow builder only with an operator-lent session (see not_covered) — signed IN with a session the factory signs for the application's own FDE identity with the app's own AUTH_JWT_PRIVATE_KEY (.claude/scripts/lib/session.py) — the same ES256 email-session token the app's verify route hands that person. A route that answers 2xx and then renders no interactive control fails the row, and so does a signed-in surface that renders only the signed-out shell: nothing measured is never a pass.

## Checks

| check | status | reason | output tail |
|---|---|---|---|
| `axe.wcag21aa` | pass | exit 0 | assed · 1 need review / _target https://hfc.useimmaculate.com · axe-core 4.13.0 · 3 rows: 3 pass, 0 fail, 0 skipped, 0 declared not covered_ |
| `keyboard.traversal` | pass | exit 0 |  workspace shell only / _target https://hfc.useimmaculate.com · axe-core 4.13.0 · 4 rows: 3 pass, 0 fail, 0 skipped, 1 declared not covered_ |
| `authenticated.surface` | pass | exit 0 |  itself is never printed blocked 1 browser request(s) to the live factory projects or the /eve/v1 proxy: this lane never talks to production |

## Measured rows

### `axe.wcag21aa`

| check | result | detail |
|---|---|---|
| axe /          | pass | 2 control(s) rendered · WCAG A/AA serious+critical: none · reported only: none · 30 rules passed · 1 need review |
| axe /onboard   | pass | 2 control(s) rendered · WCAG A/AA serious+critical: none · reported only: none · 30 rules passed · 1 need review |
| axe /workspace | pass | 8 control(s) rendered · WCAG A/AA serious+critical: none · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex1,best-practice] · 25 rules passed · 1 need review |

_target https://hfc.useimmaculate.com · axe-core 4.13.0 · 3 rows: 3 pass, 0 fail, 0 skipped, 0 declared not covered_

### `keyboard.traversal`

| check | result | detail |
|---|---|---|
| keyboard /                | pass | 2 tabbable of 3 interactive, all with a focus indicator: BUTTON:Continue with Google, BUTTON:Invited by email? Sign in with a code |
| keyboard /onboard         | pass | 2 tabbable of 3 interactive, all with a focus indicator: BUTTON:Continue with Google, BUTTON:Invited by email? Sign in with a code |
| keyboard /workspace       | pass | 7 tabbable of 9 interactive, all with a focus indicator: A:Back to chat, BUTTON:Data room, BUTTON:People, BUTTON:Agents |
| keyboard workflow-builder | not-covered | graded by the authenticated check instead (a11y.mjs --only auth), which needs a session token in MOLD_V1_SESSION_TOKEN; signed out this check sees the workspace shell only |

_target https://hfc.useimmaculate.com · axe-core 4.13.0 · 4 rows: 3 pass, 0 fail, 0 skipped, 1 declared not covered_

### `authenticated.surface`

| check | result | detail |
|---|---|---|
| auth axe / chat thread           | pass | 21 control(s) rendered (shell alone: 2) · WCAG A/AA serious+critical: none · reported only: region[moderatex1,best-practice] · 36 rules passed · 0 need review |
| auth keyboard / chat thread      | pass | 21 tabbable of 24 interactive, all with a focus indicator: BUTTON:OA OnFinance AI, BUTTON:New chat, BUTTON:Search chats, BUTTON:Collapse sidebar |
| auth axe /workspace people       | pass | 17 control(s) rendered (shell alone: 8) · WCAG A/AA serious+critical: none · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex12,best-practice] · 36 rules passed · 1 need review |
| auth keyboard /workspace people  | pass | 15 tabbable of 19 interactive, all with a focus indicator: A:Back to chat, BUTTON:Change workspace logo, A:Finish setup, 2 of 6 checks complete, A:Invite agents |
| auth axe /workspace audit        | pass | 16 control(s) rendered (shell alone: 8) · WCAG A/AA serious+critical: none · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex9,best-practice] · 36 rules passed · 1 need review |
| auth keyboard /workspace audit   | pass | 14 tabbable of 17 interactive, all with a focus indicator: A:Back to chat, BUTTON:Change workspace logo, A:Finish setup, 2 of 6 checks complete, A:Invite agents |
| auth axe /workspace builder      | pass | 15 control(s) rendered (shell alone: 8) · WCAG A/AA serious+critical: none · reported only: landmark-one-main[moderatex1,best-practice] page-has-heading-one[moderatex1,best-practice] region[moderatex7,best-practice] · 36 rules passed · 1 need review |
| auth keyboard /workspace builder | pass | 13 tabbable of 16 interactive, all with a focus indicator: A:Back to chat, BUTTON:Change workspace logo, A:Finish setup, 2 of 6 checks complete, A:Invite agents |

_target https://hfc.useimmaculate.com · axe-core 4.13.0 · 8 rows: 8 pass, 0 fail, 0 skipped, 0 declared not covered_
MOLD_V1_SESSION_TOKEN is already set: running with that session, nothing minted (an operator's own sign-in wins)
signed in as priyesh@onfinance.in (token expires 2026-10-11T11:12:03.000Z); the token itself is never printed
blocked 1 browser request(s) to the live factory projects or the /eve/v1 proxy: this lane never talks to production


## Not covered by this lane

- Anything the session token cannot reach. The signed-in check grades four surfaces (chat thread, People, Audit trail, workflow builder); the data room, connectors, agents tabs and the ops-centre modal inside the chat shell are NOT graded, and neither is any state that needs a write (creating a workflow, sending a message) — this lane is read-only on the application it grades and every non-GET the browser attempts is aborted and counted.
- The workflow builder on a `target: vm` fixture. The vm lane runs the web app alone; the builder is a client of the task-workflow service, one of the deployables the vm lane does not run (infra/vm/README.md), so on a fixture named in MOLD_V1_LANE_URL lane-url.py passes `--without task-workflow` and the builder rows print `not-covered` ("declared off on this fixture") instead of failing on a control the service would have rendered. The harness honours `--without` only when its --url is loopback (127.0.0.1 / localhost, the only addresses lane-url.py ever names for a fixture) and drops it anywhere else, so the `declared off on this fixture` row cannot be reached on a deployment; where it appears, the check's expect.skip_on records the check `skipped` (its measured rows still print) and the lane is then `skipped`, never `pass`. On a deployment the factory mints no session at all (session.py refuses every target=vercel app), so the builder has been measured by NO run of this lane to date; it is measured only with a session an operator signs in for and lends in MOLD_V1_SESSION_TOKEN, and its absence is then a fail. The three other signed-in surfaces (chat thread, People, Audit trail) have been measured on a vm fixture only, for the same reason.
- The signed-in surface at all, whenever no usable session exists: the factory mints one from the application's own key (.claude/scripts/lib/session.py), so this is now the case where that key is not in the app's secret store (a `target: vm` app that has not run --verify-db, which mints the pair into infra/vm/apps/<app>/.env), is not the key the deployment runs with, or the FDE identity belongs to no workspace there — and no operator lent a session in MOLD_V1_SESSION_TOKEN. session-live.py makes those checks `skipped` before a browser opens, and the LANE is then `skipped`. It is never `pass` on the strength of the signed-out rows alone (mold_v1-040), and never `fail` — an unusable session is not a defect of the application.
- Any identity but the application's own FDE. The minted session is for application.workspace.fde_self.email, the workspace owner; what a `member` or an invitee sees is measured only when an operator signs in as one and lends that session.
- Which identity's data is on screen. The lane measures the workspace the supplied session resolves to; a different role (member vs owner) renders different controls, and only the one supplied is graded.
- Screen-reader output. axe-core checks the accessibility tree, not what NVDA/VoiceOver actually announces.
- Best-practice and moderate/minor axe rules. They are printed in the detail column (for example landmark-one-main and region on /workspace) but do not fail the lane.
- axe `incomplete` results, which need a human to judge them; the count is printed per route.
- Colour rendering under a different theme or brand pack, zoom to 200%, reduced motion and forced-colors modes.
- Routes that do not exist in this mold snapshot. The mold has three page routes (/, /onboard, /workspace); there is no /chat route — chat is rendered at /, and the ops-centre tabs are `?tab=` addresses on /workspace.
- Whether the page served is THIS application's data. The precondition checks that the HTML carries this mold's own markers, which catches an undeployed URL and a URL now served by something else; it cannot tell two mold_v1 applications apart, because they render the same markup. A wrong-but-same-mold `production_url` is a provisioning defect, not one this lane can see.
