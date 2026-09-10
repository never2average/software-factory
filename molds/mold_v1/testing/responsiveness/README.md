# Responsiveness lane (mold_v1)

Does the application work at the width the customer actually holds?

Two halves. **Signed out**: the mold's three page routes — which is a sign-in page and an empty
workspace shell. **Signed in** (`--auth`): the product — the chat thread, the ops centre and the
workflow builder — measured with a session the factory signs for the application's own FDE with the
app's own key (see "Authenticated coverage"). Until the second half existed,
a green responsiveness lane meant a sign-in page reflowed at 320px and said nothing at all about the
workspace people actually work in (mold_v1-040).

The runner drives this lane; nothing here is run by hand:

```
python3 .claude/scripts/lanes.py <app_id> --lane responsiveness
python3 .claude/scripts/lanes.py <app_id> --lane responsiveness --dry-run   # measure and report, write no state
MOLD_V1_SESSION_TOKEN='<a session you signed in for>' \
  python3 .claude/scripts/lanes.py <app_id> --lane responsiveness           # measure as yourself instead
```

The signed-in half needs no paste: `lane.json` runs each `*.authenticated` check through
`.claude/scripts/lib/session.py <app_id> -- …`, which signs a session for the application's own FDE with
the application's own `AUTH_JWT_PRIVATE_KEY` and hands it over by name.

| file | what it is |
|---|---|
| `lane.json` | the declaration the runner reads (six checks — three signed out, three signed in — their preconditions and their budgets) |
| `responsive.mjs` | the harness: a Playwright chromium viewport matrix that prints a markdown table and exits 0/1 |
| `deps-check.mjs` | lane precondition — is chromium actually here? |
| `target-up.py` | check precondition — does the URL answer 2xx *and* serve this application's own markup? |
| `session-live.py` | precondition of the signed-in checks — is there a session this deployment accepts, for an identity with a workspace, with enough life left? (a copy of the accessibility lane's) |
| `package.json` | declares that this lane installs **nothing**, and never into `molds/mold_v1/codebase` |
| `reports/` | one report per run, written by the runner |

There are no dependencies to install. Playwright and chromium are the VM-wide install, reached with
`createRequire("/usr/lib/node_modules/")` because Node ESM ignores `NODE_PATH`. Layout shift, event
timing and target geometry are plain DOM and Performance APIs.

## The budgets, and why those numbers

Every row compares a measurement against a number that someone else published. None of them is a taste
call, which matters because the operator has to be able to argue with a failure.

| budget | value | where it comes from |
|---|---|---|
| horizontal document overflow | **0px** (1px tolerance for subpixel rounding) | WCAG 2.1 SC 1.4.10 *Reflow* (AA) requires content to reflow without horizontal scrolling at a viewport of **320 CSS px**. That is why 320 is the narrowest viewport in the matrix and why the budget is zero rather than "small". |
| cumulative layout shift | **CLS ≤ 0.10** | The Core Web Vitals "good" boundary. Above 0.10 Google classifies the page as needing improvement. Must be exceeded on **all three** runs — see "Repeat and confirm". |
| tap target size | **24 × 24 CSS px** | WCAG 2.2 SC 2.5.8 *Target Size (Minimum)*, Level AA — including its exceptions, see below. |
| tap target, advisory | 44 × 44 CSS px | SC 2.5.5 *Target Size (Enhanced)*, Level AAA, and the Apple/Google platform guidance. **Reported, never failed** — failing a whole application on a AAA criterion nobody committed to would be dishonest. |
| interaction latency | **INP ≤ 200ms** | The Core Web Vitals "good" boundary for Interaction to Next Paint. Measured from real `PerformanceEventTiming` entries, which include the paint after the handler, not just handler time. Must be exceeded on **all three** runs — see "Repeat and confirm". |

Viewports: **320×800** (the WCAG reflow width), **390×844** (iPhone 14/15), **820×1180** (iPad Air,
portrait), **1440×900** (a common laptop). The three touch viewports get `hasTouch`/`isMobile` and
`deviceScaleFactor: 3`; the desktop one does not.

## Repeat and confirm: the two numbers that move on their own

Overflow, clipping and tap size are geometry — measure them twice, get the same answer. CLS and INP are
not. Measured once against an **unchanged** deployment, `interaction / keyboard @ desktop-1440` came
back 32ms, then 176ms, then 208ms, then 208ms on four consecutive runs of the identical command: two
runs in four crossed a 200ms budget by 4%, and each of those would have reverted a healthy application,
filed a task, and told a non-technical operator their app had been pulled out of service. That is a
shared 4-vCPU box running headless chromium, not a responsiveness defect.

So a timing row is re-measured up to **3 times** and fails only when the budget is exceeded on **every**
run. Cost is zero on a healthy row: the repeat only happens after a sample lands over budget. Every
sample is printed —

    | interaction /workspace click @ desktop-1440 | pass | 4 in-page click(s) · INP=224/32ms over 2 runs, best 32ms (budget 200ms) |
    | interaction / keyboard @ desktop-1440       | fail | INP over budget 200ms on all 3 runs: 704/704/704ms over 3 runs, best 704ms |

— so a borderline application stays visible instead of being smoothed away, and the operator can see
exactly what the verdict was built from. This is not a softened budget: a genuinely slow interaction
cannot come in under 200ms on a repeat, and a real 0.17 CLS reproduces at 0.17 three times running.
Both were verified against local pages built with exactly those defects. What it *does* stop flagging
is a budget missed by a hair on one run in three, which is named in `not_covered`.

## Two judgement calls worth arguing with

**Overflowing is not the same as clipped.** On this mold `/workspace` renders an ops-centre tab strip
475px wide inside a 390px viewport, so "Project workflows" and "Audit trail" sit past the right edge. A
naive check calls that a mobile layout bug and cries wolf on every horizontal tab strip in every future
mold. It is not a bug: the strip is `overflow-x: auto`, and scrolling it brings "Audit trail" from
right=459 back to right=374, inside the viewport. So the harness **actually performs the scroll and
re-measures** instead of guessing from CSS.

The trap underneath that: `overflow: hidden` still scrolls under *script* control. A first version of
this harness called `scrollIntoView` and pronounced a clipped control reachable — `scrollIntoView`
happily scrolls a container that no mouse, finger or keyboard can ever scroll. So a control fully
outside an `overflow: hidden`/`clip` ancestor is now tested **before** any scrolling and is reported
unreachable, and reachability is confirmed by hit-testing the control's centre with
`elementFromPoint` rather than by trusting its rectangle. That also catches a control buried under an
overlay, which geometry alone reads as visible.

**The 24px rule has exceptions, and they are applied.** SC 2.5.8 exempts a target that is inline in a
sentence, and a target whose 24px-diameter circle does not intersect another target's. The mold's
"Invited by email? Sign in with a code" button is 207×16 — under 24px tall, but its nearest neighbour
is 74px away, so the **spacing exception applies and it passes**. It is still printed in the detail
column under "reported only", so the exemption is auditable rather than silent. Rigging the budget to
manufacture a failure there would be as dishonest as hiding it.

## How this lane refuses to lie

- **No reachable target ⇒ `skipped`, never `pass`.** `target-up.py` runs as a check precondition, so a
  target that was never deployed is recorded as a lane that did not run — not as a layout defect, and
  not as a pass. Without that probe a navigation timeout would land as `fail`, revert the application
  and file a task against a layout nobody has looked at.
- **A 200 is not a rendered application, and this lane no longer treats it as one.** An empty shell — a
  colliding `production_url` (mold_v1 apps share one Vercel project), or a deploy that died on the
  client — answers 200 and then satisfies every budget above *vacuously*: 0px of overflow, CLS 0, 0 tap
  targets. All 24 rows read green against a page with nothing on it. Two doors are now shut:
  `target-up.py` requires the mold's own markers in the HTML (`--expect` in `lane.json`), so a URL
  serving something else makes the lane **`skipped`** with one instruction; and every row counts what
  the browser can actually see, so a declared route that renders **no interactive control**, or a
  `targets` row that finds **no target**, is a **`fail`**. Verified: the same 200 crash shell that used
  to produce 24 green rows now produces 26 failing ones.
- **A verdict is a parsed number, not an exit code.** Each row states the measurement and the budget it
  was compared against. `lane.json` additionally forbids the string `| fail |` in stdout and requires
  the summary line, so a harness that crashed after printing a header cannot read as green.
- **Losing the target mid-run exits 3**, not 0 — nothing measured must never be reported as nothing wrong.
- **HARD RULE 2 is enforced in the browser, by host *and by path*.** Every request to a live
  `fde-agent` / `fde-agent-api` / `fde-task-workflow` host is aborted and counted — and so is every
  request to `/eve/v1/` or `/.well-known/workflow/`, whatever host it is addressed to. The second half
  is not belt-and-braces: `next.config.ts` rewrites those **same-origin** paths to `EVE_API`, which
  `lib/agent-url.ts` defaults to the live `fde-agent-api` whenever the variable is missing, and it
  forwards the `Authorization` header. The browser only ever sees `https://<app-under-test>/eve/v1/…`,
  so a hostname test alone never fires and Vercel proxies the test session straight into a production
  project. Signed out that path is unreachable (the chat shell never renders); signed in, `/` **is**
  the chat thread and it fetches `/eve/v1/session/*` on load. Measured against a fixture that serves
  those paths and counts what arrives: with the hostname-only guard the footer said `0 … blocked` while
  the fixture received **16** `/eve/v1` requests; with the path guard the footer says **16 blocked** and
  the fixture received **0**. The count is in the footer of every run as evidence rather than as a
  promise. Interaction rows only click in-page controls whose accessible name is not an auth or
  destructive verb, and each click asserts the URL did not change.

## Authenticated coverage

The three `*.authenticated` checks measure the product. They need **a session for the application under
test**, and the factory now makes one: `lane.json` runs each check, and its precondition, through
`.claude/scripts/lib/session.py <app_id> -- …`, which signs the app's own kind of session — the ES256
"email-session" token `lib/auth-session.ts` defines and `lib/ops-auth.ts` admits on its signature alone —
with the app's own `AUTH_JWT_PRIVATE_KEY`, for the app's own FDE (`application.workspace.fde_self.email`),
and hands it to the harness by name in `MOLD_V1_SESSION_TOKEN`. Why that is a real session and not a
bypass, where the key is read from, what the token does and does not prove, and how to measure as
yourself instead, are written out once in the accessibility lane's README ("Authenticated coverage") —
the mechanism, the refusals and the storage key are identical, because it is the same product and the
same client.

The short version:

- **no usable session, no run.** `session-live.py`, each authenticated check's precondition, exits 1
  when nothing could be signed (a `target: vm` app that has not run --verify-db, which mints the pair), when the
  deployment answers 401/403 (the factory's key is not the one it runs with), when the identity belongs
  to no workspace there, or when the session cannot outlive the run (`--min-remaining <timeout_s + 300>`).
  The check is `skipped` and, by the runner's rollup, the **lane** is `skipped` — never `pass`. A lane
  that has not seen the product may not certify it.
- **an unusable session is `skipped`, not `fail`.** That verdict is taken before a browser opens,
  deliberately: a `fail` lane *reverts the application*, and none of the cases above is a defect of it.
  The accessibility README's "A stale session is `skipped`, not `fail`" states the reasoning and the one
  window this does not close.
- **a token the server refuses measures nothing, so it grades nothing.** Each surface first asks the
  deployment itself (read-only `GET /api/ops/orgs` with that bearer). 401/403 marks the row
  `not-covered`, names the status, and exits 2 — never `pass`, and never a quiet fall back to the
  shell.
- **a surface that renders the signed-out shell fails.** Each names a control that appears only with
  its own content, and the census is compared against the same URL loaded with no session. If signing
  in changed nothing, the row says so rather than measuring the shell twice. The builder is backed by
  the task-workflow service; a deployment without it has no builder, and the row says so.
- **an operator's session wins.** If `MOLD_V1_SESSION_TOKEN` is already set the helper mints nothing.
- **read-only, enforced.** Signed in, the app writes on its own and this lane clicks. Every non-GET the
  page attempts is aborted and counted, and the count is in the footer of every run. The click denylist
  (`save`, `publish`, `delete`, `invite`, `export`, …) is the second fence behind it.

The four surfaces: `/` (chat thread), `/workspace?tab=people` and `?tab=audit` (ops centre),
`?tab=workflows` (workflow builder) — the app's own deep links, not a click path this harness invented.

### What it found the first time it ran

Against a locally built mold_v1 (throwaway Postgres, its own generated keypair, a session minted by
that app's own `POST /api/auth/email/verify`):

    layout / chat @ reflow-320              fail  4 controls unreachable even after scrolling:
                                                  "Customer context" still past the edge (right=406 > 320),
                                                  "Search"/"Browser" clipped by an overflow-x:hidden ancestor
    layout / chat @ mobile-390              fail  2 controls unreachable: "Browser", "Build"
    layout /workspace people @ reflow-320   fail  "Actions" clipped by an overflow-x:hidden ancestor
    layout /workspace people @ mobile-390   fail  same
    layout … @ tablet-820 / desktop-1440    pass  16 rows, CLS 0.0000–0.0174, no horizontal scroll
    targets (390, 820) × 4 surfaces         pass  12–20 targets each, none under 24px

Twelve of the sixteen layout rows pass, and the four that fail are real: on a 320px screen the chat
composer's own action row cannot be reached at all. Signed out, those same four viewports produced
nothing but green.

### Measured today (2026-09-09): with no human in the loop

Against a throwaway `target: vm` application (`sess_probe`: stamped by intake, database from
`provision.py --verify-db`, the mold built from a scratch copy and started on 127.0.0.1 with that app's
own `.env`, its workspace seeded by the mold's own `fde:new-org`; the key pair written into its `.env`
by hand at the time; `--verify-db` now mints it, as the vercel lane does), each check exactly as `lane.json` runs it:

    python3 .claude/scripts/lib/session.py sess_probe -- node …/responsive.mjs --url http://127.0.0.1:3123 --only layout --auth
    session minted for operator@example.com on sess_probe (ES256, key from infra/vm/apps/sess_probe/.env, 1800s of life)
    layout / chat @ reflow-320               fail  4 controls unreachable even after scrolling ("Customer context" right=406 > 320,
                                                   "Search"/"Browser" clipped by an overflow-x:hidden ancestor)
    layout /workspace people @ 320 and 390   fail  "Actions" clipped by an overflow-x:hidden ancestor
    layout / chat @ mobile-390               fail  "Browser", "Build" clipped
    layout … audit @ 320/390, all @ 820/1440 pass  8 rows, CLS 0.0000–0.0174, hOverflow 0px
    layout /workspace builder (4 viewports)  fail  "New workflow" absent, 9 controls vs 8 signed out — the builder is the
                                                   task-workflow service, which this fixture does not run
    --only targets --auth                          6 pass (13–20 targets each, none under 24px), builder x2 as above
    --only interaction --auth                      12 pass (INP 32–192ms, budget 200ms), builder x4 as above
    footer, every run                              0 requests to the live projects or /eve/v1 blocked · 0 non-GET blocked

The precondition, the same way: `session.py sess_probe -- session-live.py http://127.0.0.1:3123
--min-remaining 1200` -> `200 · session accepted for operator@example.com · member of 1 workspace(s)`.
A fresh key pair the deployment does not hold -> 401 -> `skipped`; an FDE identity with no membership
-> "lists no workspace for that identity" -> `skipped`. `lanes.py`'s own `unmet()` resolves the rewired
precondition MET for this app and URL; the runner itself could not drive the lane end to end because a
`target: vm` app may hold no `production_url` (mold_v1-053). The first Vercel application whose pair
`provision.py` generated is the run still to be made.

## What this lane does *not* cover

Listed in `lane.json` under `not_covered` and reprinted verbatim at the foot of every report, so a green
lane cannot imply more than it measured. What is left after the signed-in half:

- **the surfaces the session does not open** — the data room, connectors and agents tabs, the ops-centre
  modal inside the chat shell, and anything needing a write (creating a workflow, sending a message).
  This lane is read-only on the application it grades;
- **the signed-in half itself, whenever no usable session exists** — no key in the app's secret store
  (a `target: vm` app), a key the deployment does not run with, an FDE identity with no workspace there,
  and no operator-lent session: those checks are `skipped` and so is the lane. Never `pass`;
- **any identity but the application's own FDE** — the minted session is the workspace owner's; a
  `member`'s layout is measured only when an operator lends such a session;
- **which identity, and how much data.** A workspace with a hundred members lays out differently from
  the one the supplied session resolves to. The report names the identity it measured.
