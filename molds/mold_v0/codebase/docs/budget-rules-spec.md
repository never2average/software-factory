# Budget rules tab: final redesign spec

Base design: **policy-sentence** (it scored highest). From **allocation-board** it takes the "This month" strip, the "Limited by" column, the team-delete impact preview and the per-run dollar cap. From **guardrails-first** it takes the Review dialog with a required checkbox, the plain-sentence change history, the member card wording and the spend-per-run hint in sessions. Every flaw the judges raised is fixed or explicitly deferred.

---

## 1. Summary

1. The tab becomes a short **policy written as sentences**, with one control per sentence. The three mode cards become one dropdown: "Inside each budget, people [share it freely / get an equal share / can each spend up to $X]". It maps 1:1 to `pool / even / custom`.
2. **One meaning per field, in every mode:**
   - The buffer and team budgets are always set aside.
   - A person's own limit (`cap_usd`) always applies.
   - "Everyone else" is a real pot.
   - Launch access is stated as the default for everyone who has no setting of their own.
3. **"Who gets what" is computed on the server from the draft** by one pure `allocate()`, which also does the enforcement. It shows each person's limit, spend, what's left, what limits them, and who would be blocked right away. Nothing is clipped.
4. **Saving is one atomic call with a concurrency check.** If anyone would be blocked or the plan is over the allowance, a Review dialog with a checkbox opens first. Every save writes a one-line history entry.
5. **v1 adds no notification stack, no requests and no new worker states.**
   - Spend is live everywhere.
   - "Sessions per run" applies to the whole run.
   - An optional dollar cap per run stops adaptive runs.
   - Email alerts and "Request more" are phase 2.

---

## 2. Wireframe (desktop, full width)

```
Billing  >  [This month] [People] [Teams] [Budget rules]
──────────────────────────────────────────────────────────────────────────────────────────────
Budget rules                                Last changed by Priya S., Oct 12, 14:03 UTC · History
Changes apply right away to this month's spend.                Month resets Nov 1, 00:00 UTC
──────────────────────────────────────────────────────────────────────────────────────────────
THIS MONTH
  Allowance      Spent so far        Running now        On pace for          Left
  $500.00        $220.10 (live)      $14.60 · 3 runs    $379 by Oct 31       $279.90
──────────────────────────────────────────────────────────────────────────────────────────────
YOUR POLICY
  This account can spend  $500.00  in October.                               (set by Octillion)
  Hold back  [$ 50.00  ]  as a buffer for runs that go over.
     Nobody can launch into this. It absorbs runs that finish past a limit.
  [Platform ▾]  gets  [$ 100.00 ]  this month.                                         [Remove]
  [Mobile   ▾]  gets  [$  80.00 ]  this month.                                         [Remove]
  + Give another team its own budget
  Everyone else shares the remaining  $270.00.
  Inside each budget, people  [ get an equal share                ▾ ]
     Each budget is split between the people in it who can launch. It goes down when someone joins.
     Today: Platform $25.00 each (4) · Mobile $26.67 each (3) · Everyone else $24.00 each (5)
  [ Everyone on the account ▾ ]  can launch simulations.
──────────────────────────────────────────────────────────────────────────────────────────────
RUN LIMITS  (these limit size and speed, not who gets which dollars)
  Each person can have        [    ]  simulations running at once.   placeholder "no limit"
  Each simulation can use up to [ 20 ] agent sessions.   Octillion's maximum is 100. Applies to
                                                         every batch, including adaptive runs.
  Each simulation can spend up to [$     ]   placeholder "no limit"
                                  Adaptive runs stop adding sessions once a run reaches this.
                                  ≈ 16 sessions at this month's average of $1.24 per session.
──────────────────────────────────────────────────────────────────────────────────────────────
EXCEPTIONS   2 people and 1 team have their own settings
  Alice R.      own limit $150.00      spent $21.10    [Reset to default]   Edit on People →
  Dan K.        can't launch                           [Reset to default]   Edit on People →
  Mobile team   1 run at once per person                                    Edit on Teams →
──────────────────────────────────────────────────────────────────────────────────────────────
WHO GETS WHAT                                                     Showing your unsaved changes
 $500 ┃▒Buffer $50▒┃█ Platform $100 █┃█ Mobile $80 █┃██████ Everyone else $270 ██████┃
      ┃ dark = spent (live) · light = running now                                    ┃cap
 Budget            People  Each person can spend  Spent    Left     Limited by       Change
 Buffer              —     —                      —        $50.00   —                was $0
 ▸ Platform          4     $25.00                 $61.20   $38.80   —                —
 ▸ Mobile            3     $26.67                 $70.10    $9.90   Team budget      —
 ▾ Everyone else     7     $24.00                 $80.40  $189.60   —                was $34.00
     Ben T.                $24.00                 $12.00   $12.00   —
     Carla M.              $24.00                 $29.80    $0.00   Her limit        Blocked now
     Alice R.              $150.00 (own limit)    $21.10  $128.90   —
     Dan K.                —                      $0.00    —        Can't launch
     … 3 more
 Not limited by these rules: connector keys ($8.40 this month).
──────────────────────────────────────────────────────────────────────────────────────────────
[sticky] Buffer $0 → $50 · 5 people's limits go down · 1 blocked right away (Carla M.)
                                                               [Discard]   [Review and save]
```

**Over-allocation.** The bar scale is `max(cap, buffer + team budgets)`. Anything past the cap is drawn as a red segment beyond a solid cap line, labelled "$40 more than your $500 allowance". Segments are never clipped.

**Mobile (under 640px, 16px gutters)**
- Each sentence wraps so that its control sits on its own full-width line beneath the words. The [Remove] links become a trailing icon button with an aria-label.
- "This month" becomes a 2×2 grid of stat tiles, with "Left" spanning the full width.
- The ledger bar stays full width. Segment labels move into a legend list under the bar.
- "Who gets what" becomes one card per budget:
  - The card shows name, each person's limit, spent and left.
  - Tapping the card expands its people as stacked rows: name, limit, left, and a chip.
  - The "Limited by" and "Change" values show as chips, not columns.
- Exceptions become cards, with Reset as a secondary button.
- The save bar is pinned to the bottom. It shows "{n} changes · {k} blocked" and one primary button, "Review". Discard goes into an overflow menu.
- No horizontal scroll anywhere. Number inputs use `inputmode="decimal"`.

---

## 3. Sections and controls

### 3.1 Header (read-only)
| Item | Copy | Source |
|---|---|---|
| Title / subtitle | "Budget rules" / "Changes apply right away to this month's spend." | static |
| Last changed | "Last changed by {name}, {Mon D, HH:MM} UTC · History". With no row: "Using Octillion's default rules" | newest `usage_rule_changes` row, falling back to `policy.updated_by`/`updated_at`. Names are resolved from Clerk (new `updated_by_name`) |
| History | Opens a side panel with the last 50 entries, one sentence each, e.g. "Oct 12 14:03 · Priya S. · Buffer $0 → $50; Platform $80 → $100". No undo in v1 | new `GET /limits/history` |
| Reset | "Month resets {1st of next month}, 00:00 UTC." | new `period_end` (UTC month, as limits.ts:35) |

### 3.2 This month (read-only)
| Tile | Copy | Source |
|---|---|---|
| Allowance | "$500.00". At $0: "None" | `budget_usd` (`orgBudget`, billing.ts:145) |
| Spent so far | "$220.10 (live)": the same number as the page header | new `spent_live_usd` (the queries.ts:326 query). Replaces `spent_usd` |
| Running now | "$14.60 · 3 runs" | new `in_flight_usd`, `running_count` |
| On pace for | "$379 by Oct 31". Red "over by $X" when above the allowance. Before day 3: "Too early to tell" | new `projected_usd` = live spent ÷ elapsed UTC days × days in month |
| Left | "$279.90", never below $0 | cap − live spent |

### 3.3 Your policy
| # | Exact copy | Control / default | Validation | Maps to |
|---|---|---|---|---|
| P1 | "This account can spend **$X** in {Month}." Side note "(set by Octillion)". Tooltip: "Your prepaid monthly allowance. Contact Octillion to change it." | read-only | — | `budget_usd` |
| P2 | "Hold back [$ ] as a buffer for runs that go over." Hint: "Nobody can launch into this. It absorbs runs that finish past a limit." | money, default $0.00, step 0.01, empty = $0 | 0 ≤ v ≤ cap. Inline error above the cap: "Can't hold back more than your ${cap} allowance." | `usage_policies.reserve_usd`. **It now applies in every mode** (§7, change B) |
| P3 | "[Team ▾] gets [$ ] this month." plus [Remove]. Then "+ Give another team its own budget", whose dropdown lists teams with no budget. With no teams: "No teams yet. Create one on Teams →" | team select + money. A new row starts empty; saving it empty shows "Enter an amount or remove this row." | 0 ≤ v ≤ 1e7, cents. **$0 is allowed** and the row then reads "gets $0. Its people can't launch." A team with 0 members shows "No one is in {team}, so this ${b} sits unused." (warning) | `usage_teams.budget_usd`. [Remove] sets it to null. Saved through `PUT /limits/plan` |
| P4 | "Everyone else shares the remaining **$R**." With no team rows: "Everyone shares **$R**." With one person: "You can spend **$R**." | computed | R < 0 shows in red: "Team budgets and the buffer are ${-R} more than your allowance." | R = cap − reserve − Σ team budgets |
| P5 | "Inside each budget, people [▾]". Options and the hint under each: **"share it freely"**: "Anyone can use the whole budget until it runs out. One person can use all of it." **"get an equal share"**: "Each budget is split between the people in it who can launch. It goes down when someone joins." **"can each spend up to a set amount"**: "Everyone gets the same personal limit. A budget still stops at its total." A live line follows: "Today: Platform $25.00 each (4) · …" (from the preview) | select. Existing accounts keep their mode; new accounts get "get an equal share" | — | `policy.mode`: pool / even / custom |
| P5a | (only with "set amount") "Each person can spend up to [$ ] a month." Live note when it exceeds a budget: "7 × $60 = $420 is more than Everyone else's $270, so the budget runs out first." (informational) | money, **required**, prefilled with nothing | $0.01 ≤ v ≤ cap. When empty: "Enter an amount, or choose 'share it freely'." | `policy.default_cap_usd` |
| P6 | "[▾] can launch simulations." Options: **"Everyone on the account"** / **"Only people I've allowed"**. With the second option, the hint reads "{n} people are allowed individually. Allow people on People →" | select, default Everyone | Switching to the second option adds this to the save bar and Review: "This stops {n} people who haven't been allowed individually, including people already here." | `policy.new_members_can_run`. Only the copy changes; there is no backfill |

### 3.4 Run limits
| # | Exact copy | Control / default | Validation | Maps to |
|---|---|---|---|---|
| R1 | "Each person can have [ ] simulations running at once." Hint: "Counts whole simulations, not agent sessions. Teams and people can set their own; the most specific one wins. ({n} do)" | integer, empty = "no limit" (as today; no silent default) | 1–10000. 0 is rejected with "Use 'can launch' to stop launches." | `policy.max_concurrent_runs` |
| R2 | "Each simulation can use up to [ ] agent sessions." Side note: "Octillion's maximum is {N}." Hint: "Applies to every batch, including adaptive runs." | integer, empty = Octillion's maximum (the placeholder shows N) | 1 ≤ v ≤ `server_max_sessions`. 0 is rejected | `policy.max_sessions_per_run` + new `server_max_sessions` |
| R3 | "Each simulation can spend up to [$ ]." Hint: "Adaptive runs stop adding sessions once a run reaches this. Sessions already running finish." Live: "≈ {n} sessions at this month's average of ${avg} per session." With fewer than 20 sessions this month: "Not enough runs yet to estimate." | money, empty = "no limit" | $0.01–cap. A warning (not an error) when it is below one average session | **new** `usage_policies.max_run_usd` |

### 3.5 Exceptions
- **Heading:** "{n} people and {m} teams have their own settings". With none: "Nobody has their own settings."
- **Person row kinds:**
  - "own limit ${x}": `cap_usd` is not null.
  - "+${x} on top of equal share" or "−${x}": `adjust_usd ≠ 0`. Even mode only.
  - "can't launch" or "allowed to launch": `can_run` is not null and differs from the default.
  - "{k} runs at once": `max_concurrent_runs`.
- **Team row kinds:** "{k} runs at once per person" (`usage_teams.max_concurrent_runs`). Team budgets are not listed here, because they live in P3.
- **Person actions:**
  - [Reset to default] is part of the draft. It sets `cap_usd = null`, `adjust_usd = 0`, `can_run = null` and `max_concurrent_runs = null`, so it shows in the preview and save bar. It does not take effect immediately.
  - "Edit on People →" opens that person's Edit limits dialog.
- **Team action:** "Edit on Teams →".
- **Lists longer than 5:** "+{k} more · See all on People →" (`/app/billing?tab=people&filter=exceptions`).

### 3.6 Who gets what
Specified in §4.

### 3.7 Save bar and Review
- **Save bar.** It is sticky and appears only when the draft is dirty. It reads "{field summary, up to 2 items} · {j} people's limits go down · {k} blocked right away ({names, max 3, +n})", plus a line for the launch-access warning or inactive values when those apply.
- **Buttons.** [Discard] and [Review and save]. The second button is labelled [Save rules] when the change neither blocks anyone nor goes over the allowance; it then saves directly.
- **Review dialog.** Changes are listed as before → after. Affected people are listed with their limit before → after and their spend, and anyone who would be blocked comes first.
  - When k > 0 or the plan is over the allowance, a checkbox is required: "I understand {k} people will be blocked right away" or "I understand this is ${x} more than the allowance and {n} people outside teams get $0."
  - The button reads "Save and block {k}" or "Save rules".
- **Inactive values** come from changing P5:
  - Example row: "Ben's +$6 adjustment only applies with 'equal share'. [Keep for later] [Clear]". The default is Clear.
  - This now applies only to `adjust_usd`, because `cap_usd` applies in every mode (change A).
  - Maps to `clear_inactive`.
- **Toast:** "Rules saved. They apply to this month's spend now."

---

## 4. Live preview model

- **Single source of truth.** Extract a pure function in src/limits.ts:

  ```
  allocate({policy, teams, members, usage, cap}) -> {members[], teams[], rest, set_aside, over_by, ...}
  ```

  `overview`, `checkRun`, `launcherOverLimit` and the preview all call it. The client does no allocation math. That removes the `Allocation` math at billing.tsx:410-439 and the saved-vs-draft bug at billing.tsx:390.
- **Allocation rules inside `allocate`:**
  1. **Pots:** the buffer = `reserve_usd`. Each budgeted team = `budget_usd`. Everyone else = R = max(0, cap − reserve − Σ team budgets). A $0 team budget is a real $0.
  2. **Person limit:** the person's own `cap_usd`, if set. Otherwise it follows the mode:
     - pool: null, meaning "shared"
     - custom: `default_cap_usd`
     - even: (pot − Σ own limits of pot members) ÷ the pot members who effectively can launch and have no own limit, plus `adjust_usd`, clamped at ≥ 0 and rounded to cents
  3. **At a $0 cap:** every limit is $0, never null.
  4. **Effective can launch:** `can_run`, otherwise `new_members_can_run`.
  5. **Binding limit:** the first that fails, in this order: can't launch → own or share limit → team budget or Everyone else pot → account allowance (cap − reserve, for signed-in launchers). It is reported as `limited_by` when spend is ≥ 90% of that limit, otherwise null.
- **Call.** `POST /limits/preview` is debounced at 300 ms. The body is the full draft (policy fields, team budgets, exception resets). It returns the `overview` shape plus:
  - `changes[]`: `{user_id, before, after, blocked_now, limited_by}`
  - `over_by_usd`
  - `inactive[]`: `{user_id, field, value}`
  - `launch_access_stops`: number
  - `warnings[]`: `over_allocated`, `rest_zero`, `empty_budgeted_team`, `set_amount_exceeds_budget`, `no_personal_limits`
- **Load and staleness.** Usage (live spend per person) is fetched once per preview session and cached for 30 s server-side per org. Only the policy changes between keystrokes, so `allocate` is in-memory. While a request is in flight, the table dims to 60% and shows "Updating…". If the call fails: "Preview unavailable. Your edits are kept." Save stays enabled, with the Review dialog forced.
- **Ledger bar.**
  - Segments: Buffer, each budgeted team, Everyone else, and "Not set aside" (cap − set aside, when > 0).
  - Inside each segment: a dark fill for spent, a light band for running now.
  - Clicking a segment expands its table row.
  - Under "share it freely" the Everyone else label reads "shared, no personal limits".
  - When `over_by > 0`, a red overflow segment appears past the cap line, with the text "That's ${over} more than your ${cap} allowance. Lower a team budget or the buffer."
- **Table columns:** People · Each person can spend · Spent (live) · Left · Limited by · Change ("was $x").
  - Person chips: **Blocked now**, **Can't launch**, **Near limit** (≥ 80%), **Own limit**.
  - Each person row has a tooltip that names the binding rule and what is left, e.g. "Limited by: Mobile budget ($9.90 left)".
- **Connector footer:** "Not limited by these rules: connector keys (${x} this month)." Shown only when x > 0, from the new `unattributed_spent_usd`.

---

## 5. At the limit and member messaging

**What blocks**
- Every limit on this tab blocks new launches. Nothing is alert-only in v1, so nobody has to ask "does this block?".
- Adaptive runs stop adding batches when any money limit or R3 is hit (`launcherOverLimit`, extended).
- Sessions that are already running always finish; nothing is cancelled. The buffer exists for that overshoot.
- Non-adaptive runs are bounded by R2 sessions.

**Check order** (`runSimulation` then `checkRun`). The first one that fails is named:
1. `no_allowance`
2. `account_cap` (live)
3. `launch_access`
4. `person_limit` (live)
5. `team_budget` (live), or `rest_pot` (live; people outside budgeted teams)
6. `buffer` (signed-in launch and live account spend ≥ cap − reserve)
7. `runs_at_once` (person > team > account)
8. `run_sessions`

Onboarding research clamps its run to the effective session limit instead of failing.

**Error payload**

```
{code, message, limit_usd, left_usd, set_by: "you"|"team"|"account", admins: [{name}]}
```

Every message ends with: "Ask {admin names} to change Budget rules on the Billing page, or wait until {reset date}." This replaces "under Limits" at limits.ts:116.

| Code | Message |
|---|---|
| no_allowance | "Your account has no prepaid allowance this month, so simulations can't run. Contact Octillion." (no admin suffix) |
| account_cap | "Your account has used its ${cap} for {Month}." |
| launch_access | "You haven't been allowed to launch simulations yet. Reports and transcripts stay available." |
| person_limit | "You've used your ${a} for {Month} (${s} spent)." |
| team_budget | "The {Team} team has used its ${b} for {Month}." |
| rest_pot | "The shared ${R} for people outside a team budget is used up for {Month}." |
| buffer | "Your account has reached the part of its allowance available for launches (${cap−reserve} of ${cap}). The rest is held back for runs that go over." |
| runs_at_once | "You have {n} simulations running; you can have {limit} at once (set for {you / your team / the account}). Wait for one to finish." |
| run_sessions | "This simulation needs {p} agent sessions; the limit is {limit}." |
| (mid-run) | On the run page: "Stopped adding sessions at {n}: {reason sentence}. Results so far are kept." |

**Member surfaces.** Members never see this tab.
- **"Your budget" card** on Billing → This month: "${left} left of ${limit} this month".
  - Under "share it freely": "No personal limit · {Everyone else / Team} has ${left} left".
  - Then: "Team {name}: ${left} left · {m} of {n} running · up to {k} sessions and ${r} per run · resets {date}".
  - It shows "Limited by: …" when that applies, plus a "Near your limit" chip at ≥ 80%.
  - Account totals move to a smaller secondary line.
- **Plain-English summary** under the card: the policy sentences rewritten in the second person, read-only. Example: "You're in Everyone else, which shares $270. People get an equal share, so yours is $24.00 and changes if people join."
- **Launch form:** the same "left" line, plus an estimate: "≈ ${est} for {p} sessions at this month's average". It shows an amber warning when the estimate is more than what is left; this is a warning, not a refusal. The form is disabled with the reason when a blocking check would fail.
- **Admin banner** on Billing (computed on GET, no notification table): "Your account has used {pct}% of this month's allowance" at ≥ 80%, and "Your account is on pace to run out on {date}" when the projection is over the cap.

**Phase 2** (needs an email provider; none exists in the repo): emails at 80% and 100% for person, team and account; a notice when your limit changes by more than 10%; a "Request more" flow.

---

## 6. States

| State | What shows |
|---|---|
| $0 allowance | P1 reads "This account has **no prepaid allowance** this month, so nobody can launch. Contact Octillion to add one." The "This month" tiles read "None". The rules stay editable, and the preview shows $0 with the chip "No allowance". The wrong line at billing.tsx:412 is removed |
| Allowance lookup failed | Banner: "We couldn't load your monthly allowance, so the preview is unavailable and saving is off." The server returns `budget_error: true`. `checkRun` refuses with "We couldn't check your account's allowance. Try again in a minute." (fail closed). `extendAdaptive` stops instead of using Infinity (queries.ts:467) |
| Member list unavailable (Clerk off or empty) | Banner: "We can't load your people, so personal and team limits aren't being applied. Only the account allowance and run limits are." The table is hidden. Account, buffer and run checks still apply |
| No teams | P3 reads "No teams yet. Create one on Teams → to give a group its own budget." P4 reads "Everyone shares $R." The table shows Buffer and Everyone |
| Teams but none budgeted | Only "+ Give a team its own budget" |
| Budgeted team with no members | Warning on the row: "No one is in {team}, so this ${b} sits unused." |
| One person | P4 reads "You can spend $R." The equal-share hint is hidden and the table lists one person |
| Over-allocated (including after Octillion lowers the cap) | Red overflow plus the P4 error text. Saving is allowed through Review with the checkbox. The server never refuses a save for over-allocation, so unrelated saves (e.g. on Teams) keep working |
| Never saved | Header reads "Using Octillion's default rules". Defaults are shown and the preview is live |
| Upgrade pending (change B not yet applied, §7) | Notice at the top: "Your team budgets don't yet limit people outside teams. Turning this on gives Everyone else a real ${R} limit. {n} people would be blocked right away. [Preview] [Turn on]" |
| Save conflict (409) | Inline: "Someone changed these rules while you were editing." [Reload and keep my edits] re-applies the draft on top of the latest rules |
| Loading | Skeleton for the tiles and sentences. Inputs stay disabled until GET /limits returns |
| Non-admin | Tab hidden. Members get the card and summary from §5 |

---

## 7. Backend changes

**Meaning changes.** Each ships with its own migration and a one-time notice.
- **A. `cap_usd` applies in every mode.** In even mode, people with their own limit are left out of the split and their limit is taken out of their pot.
  - Migration (one transaction, logged to `usage_rule_changes` as "System: cleared unused personal limits"):
    - `UPDATE usage_members SET cap_usd = NULL WHERE org's mode <> 'custom'`. These values were not being applied, so this does not change behaviour.
    - `UPDATE usage_policies SET mode = 'pool' WHERE mode = 'custom' AND default_cap_usd IS NULL`. After A this has the same effect, and it removes the "empty means unlimited" state.
- **B. Buffer and team budgets are set aside in every mode** (the new `rest_pot` and `buffer` checks).
  - Migration: `UPDATE usage_policies SET reserve_usd = 0 WHERE mode <> 'even'`. Reserve was ignored in those modes, so nothing changes.
  - New column `usage_policies.set_aside_enforced boolean NOT NULL DEFAULT true`. It is migrated to **false** for accounts in pool or custom mode that have any team budget, which preserves their behaviour. Those admins see the "Upgrade pending" notice, and [Turn on] sets it to true through `PUT /limits/plan`, logged.
  - Run a pre-release query that lists the affected orgs.
- **C. Equal share counts only people who effectively can launch** (limits.ts:77). It ships in the same release as a dismissible notice on the tab: "Equal shares now count only people who can launch. Shares went up for {n} people."
- **D. Live spend per person and team.** `usageByPerson` uses `GREATEST(s.cost_usd, live gateway sum)` per session, the same source as queries.ts:326, and also returns `in_flight_usd`. The comment at limits.ts:52 is fixed. Spend still follows the person (current team, active members only); the team row tooltip says: "Spend counts the current members' whole month, including time before they joined."
- **E. Sessions per run applies everywhere.** queries.ts:483 and research.ts:591 use `min(config.maxSessionsPerRun(), policy.max_sessions_per_run)`. Research clamps rather than failing.
- **F. Run dollar cap.** `extendAdaptive` stops when the run's live spend ≥ `max_run_usd`. There is no change to the worker claim path and no new session status.

**Schema**

```sql
ALTER TABLE usage_policies
  ADD COLUMN max_run_usd numeric(12,2),
  ADD COLUMN set_aside_enforced boolean NOT NULL DEFAULT true;
CREATE TABLE usage_rule_changes (
  id bigserial PRIMARY KEY, org_id text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  actor text, summary text NOT NULL, before jsonb, after jsonb);
CREATE INDEX ON usage_rule_changes (org_id, at DESC);
```

There are no column renames and no changes to `usage_teams` or `usage_members`.

**Defaults for existing accounts.** Every current value is kept: mode, reserve (except as zeroed in B), runs at once (empty stays no limit), sessions, launch access, `max_run_usd` null.
- Existing 0 values in `max_concurrent_runs` or `max_sessions_per_run` (which block every launch today) are migrated as follows: set `can_run = false` for each active member who has no `can_run` set, and set the count to null. This is logged. A pre-release query should confirm the number of such orgs, which is expected to be zero.

**Endpoints**
- `GET /limits` adds:
  - account-level: `spent_live_usd`, `in_flight_usd`, `running_count`, `projected_usd`, `period_end`, `server_max_sessions`, `avg_session_usd`, `budget_error`, `unattributed_spent_usd`, `set_aside_enforced`, `max_run_usd`, `last_change {by_name, at, summary}`, `admins [{name}]`
  - per member: `effective_can_run`, `effective_max_concurrent` + `concurrent_source`, `limited_by`, `left_usd`, `in_flight_usd`
  - The member payload gets the same fields for their own row, plus `admins`.
- `POST /limits/preview` (admin, no writes): see §4.
- `PUT /limits/plan` (admin), one transaction:
  - Body: `{policy: Partial<Policy>, team_budgets: [{id, budget_usd|null}], member_resets: [userId], clear_inactive: bool}`, with header `If-Match: <updated_at>`.
  - It writes policy, team budgets, resets and clears, then appends one `usage_rule_changes` row with a server-generated summary.
  - Returns 204. 409 on a stale If-Match. 422 for a field validation error.
  - It never returns 422 for over-allocation.
- `GET /limits/history?before=` (admin).
- `PUT /limits/teams/:id` becomes **partial**, keyed on the fields present (no more silent nulling).
- `PUT /limits/policy`, `/limits/teams*` and `/limits/members/:id` stay, and each one also appends to history.
- **Validation everywhere:**
  - counts are ≥ 1 or null
  - sessions ≤ server max
  - `default_cap_usd` is required when mode = custom
  - money is cents in 0–1e7
  - reserve ≤ cap (skipped when the cap is 0 or unknown)
- **checkRun:** structured errors as in §5, the `rest_pot` and `buffer` checks (only when `set_aside_enforced`), and fail-closed on `budget_error`.

---

## 8. People and Teams tabs

**People**
- **Edit limits dialog**, one input per row:
  - "Monthly limit": (•) Use the default ({source}: $24.00) / ( ) Own limit [$]. Shown in **every** mode.
  - "Adjustment on top of equal share [± $]": even mode only.
  - "Team".
  - "Can launch": Use the account setting ({Everyone}) / Yes / No.
  - "Runs at once": empty shows "Use team or account setting ({n})".
  - The dialog sends **only the fields that changed** (fixes billing.tsx:305).
- **"Runs at once" column:** shows the effective value with its source ("2 · team"), from `effective_max_concurrent` (fixes billing.tsx:224).
- **New columns:** "Limited by" and "Left". The table supports `?filter=exceptions`.

**Teams**
- Copy fixes:
  - billing.tsx:475: "This budget is set aside for the team and is the most it can spend."
  - billing.tsx:451, the delete confirm, now shows impact from the preview: "Its 4 people move to Everyone else. Their limits become $24.00 each. The $100 set aside goes back to Everyone else. 1 person will be blocked right away."
- Team budgets stay editable here, through the partial PUT, and also on Budget rules.

---

## 9. Build steps (each one ships on its own)

1. **Correctness fixes, no UI change:**
   - live spend in `usageByPerson` (D)
   - sessions min in extendAdaptive and research (E)
   - reject 0, with the 0-value migration
   - partial team PUT
   - dialog sends only changed fields
   - checkRun copy says "Budget rules", with structured codes
   - `budget_error` fail-closed
2. **Extract a pure `allocate()`** with a unit test matrix covering mode × teams × own limits × can_run × $0 cap. `overview`, `checkRun` and `launcherOverLimit` call it. There are no intended behaviour changes beyond step 1, as a snapshot diff on staging data will show.
3. **History:** add the `usage_rule_changes` table, write to it from every existing endpoint, and show "Last changed by · History" on the current tab.
4. **Preview and plan:** `POST /limits/preview`, `PUT /limits/plan` (If-Match, transaction), and the new GET fields (`server_max_sessions`, `period_end`, tile figures).
5. **New tab UI:** header, This month strip, policy sentences, run limits R1–R2, exceptions, the Who gets what table and bar, save bar and Review, and all the states. It ships behind a per-org flag, with the old tab as fallback.
6. **Meaning change A + C:** the `cap_usd` and custom→pool migration, with equal share counting only launchers. Ship it with the notices and the People dialog change.
7. **Meaning change B:** the `set_aside_enforced` column and migration, the `rest_pot` and `buffer` checks, the upgrade notice with [Preview] [Turn on], and the affected-org list given to Octillion support.
8. **Run dollar cap:** `max_run_usd` (R3), `avg_session_usd`, and the stop in extendAdaptive.
9. **Member surfaces:** the "Your budget" card, plain summary, launch form line and estimate, and the admin 80% / pace banner.
10. **People and Teams updates:** effective columns, Limited by and Left, the exceptions filter, and the team-delete impact confirm.
11. **Remove the flag and the old `Rules` / `Allocation` / `MODES` code.**

---

## 10. Open questions for the product owner

1. **Turning on change B for existing pool or custom accounts with team budgets.** Should admins opt in through the notice (the proposal), or should Octillion switch it on for everyone after a notice period?
2. **The buffer.** Should it be reachable by admins (guardrails-first's "held back for admins") or by nobody, as proposed? "Nobody" keeps one meaning but makes the money reachable only through overshoot and connector keys.
3. **Connector-key spend.** It is shown but stays unlimited in v1. Do you want a separate monthly cap for connector keys now, or later?
4. **Phase 2 alerts and "Request more".** Is adding an email provider (e.g. Resend or Postmark, a new SaaS dependency) approved, and should increase requests be one-month-only, permanent, or both?

Sources: /root/octillion-live/octillion-admin/web/src/features/portal/billing.tsx, /root/octillion-live/octillion-admin/src/limits.ts, /root/octillion-live/octillion-admin/src/app.ts, /root/octillion-live/octillion-admin/src/queries.ts, /root/octillion-live/octillion-admin/src/research.ts, /root/octillion-live/octillion-admin/src/billing.ts, /root/octillion-live/octillion-admin/sql/schema.sql