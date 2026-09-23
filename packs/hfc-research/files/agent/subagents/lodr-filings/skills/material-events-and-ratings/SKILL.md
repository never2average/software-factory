---
description: Use when the filing is a material-event or price-sensitive intimation (Regulation 30 for equity-listed, 51 for debt-listed) or a credit rating review (Regulation 55) - rating actions, fund raises, KMP or auditor changes, regulatory orders, investor-meet schedules, presentation and transcript intimations - to summarise it factually, decide whether the company record must change, and hand follow-ups to the right subagent.
---

# Material events and ratings

Event intimations are short letters, many per quarter. Most are routine; a few change a standing fact about the
company. Your job is to file each, state what it discloses and when, and keep the company record true.

## Event types for an HFC

| Type | How the letter reads | What the analyst needs | Company record? |
|---|---|---|---|
| Rating action | "has assigned / reaffirmed / upgraded / downgraded / revised the outlook / placed on watch / withdrawn"; agency name; instrument (NCDs, bank lines, CP, FD, subordinated debt); amount rated | agency, instrument, rating and outlook before and after, date of the agency's letter, amount | **Yes** when rating or outlook changes, a new agency or instrument appears, or a rating is withdrawn. A plain reaffirmation: no, log only. |
| Fund raise | Board / committee approval or allotment of NCDs, CP, QIP, preferential issue, rights, ECB, NHB refinance; securitisation or assignment deals announced as events | instrument, amount, coupon / price, tenor, allottee class, date; approval vs allotment (different events) | Only equity raises that change the promoter band or bring in a new large holder |
| KMP / director change | appointment, re-appointment, resignation, cessation of MD & CEO, CFO, CS, directors; brief profile annexed; reason for resignation | who, role, effective date, reason as stated | **Yes** for MD / CEO, CFO, chairperson |
| Auditor change | appointment, resignation, completion of term of statutory auditors (joint auditors are common); resignation letter annexed | firm(s), effective date, reason as stated, whether mid-term | **Yes** |
| Regulatory order | order, penalty, show-cause, inspection finding from RBI, NHB, SEBI, tax authorities, courts; amount; nature of violation | authority, date, amount, provision cited, company's stated impact | **Yes** for business restrictions; a small fine: log only |
| Investor meet / earnings call | schedule of analyst or institutional investor meets, earnings call date and dial-in; afterwards: **presentation**, **audio link**, **transcript** | the date, and the link to the document | No. But tell the orchestrator: the presentation and transcript belong to `investor-presentations` |
| Corporate action | scheme of amalgamation, acquisition, stake sale, change in control, change of name / registered office, ESOP grants and allotments, dividend | what, counterparties, consideration, appointed date, approvals pending | **Yes** for merger, change in control, name change |
| Debt servicing (usually Reg 57) | payment of interest / principal, record dates | confirm paid on due date; a **delay or default** is the material one | **Yes** only for a delay or default |

Debt-listed HFCs file the same events under Reg 51 (and rating reviews under Reg 55). Same table applies.

## Procedure

1. Classify (the letter's citation decides between `reg30_event`, `reg51_event`, `reg55_rating`, `reg57_payment`):

   ```
   python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/event.pdf --pages 2 --listing equity
   ```

   The cue ids in the evidence (`event.fund_raise`, `event.kmp_change`, `event.auditor_change`,
   `event.investor_meet`, `event.regulatory_order`, `event.scheme_acquisition`, `reg55.rating` ...) tell you the
   event type. An outcome-of-board-meeting letter can carry several events plus results: it is one file and one
   log row (tagged by the rules in skill `classify-a-filing`), but the summary names each event.
2. Read the letter and its annexure (the prescribed details table for the event type). Take facts as stated:
   names, dates, amounts with their unit, ratings with their exact symbols and outlook.
3. Name and log:

   ```
   python3 /workspace/scripts/filing_name.py --company-id example-housing-finance --filed-on 2026-05-02 --tag reg30_event --title "Credit rating upgrade - long term NCDs" --ext pdf
   python3 /workspace/scripts/validate_filing_log.py /workspace/out/new-rows.jsonl --existing /workspace/in/filing-log.jsonl
   ```

4. Company record. `get_company` first. If the filing changes a standing fact (third column above), call
   `upsert_company` with the new value, and say in the reply what you changed, from what, to what, citing the
   filing. If the record has no field for the fact, put it in the record's notes / context rather than dropping it.
   Use `remember` for conventions ("rating letters are filed under Reg 30 and Reg 55 together"), not for facts.
5. Follow-ups you hand back to the orchestrator, not do yourself: the investor presentation and transcript
   (`investor-presentations`), the annual report (`annual-report-format`), KPI work (`hfc-kpi-extraction`).

## Writing the summary

Two sentences at most (the validator counts). What was disclosed and when. No "positive", "negative",
"concerning", "strong": the analysts characterise, you report. Quote rating symbols exactly; never translate a
rating into words of your own ("high safety") unless the filing prints them.

## What to write

The filing (or `.md` capture), one validated log row, and the company-record update when warranted.

## Worked example

Example Housing Finance Ltd, letter dated 2 May 2026 under Regulation 30:

> ... ICRA Limited has upgraded the rating of the Company's Non-Convertible Debentures programme of Rs. 5,000 crore
> from [ICRA]AA (Positive) to [ICRA]AA+ (Stable). The rating letter dated April 30, 2026 is enclosed.

- Classifier: `reg30_event`, matched; note that the wording also suggests `reg55_rating`, which the letter does not cite.
- Log row: `filed_on: "2026-05-02"`, `tag: "reg30_event"`, title "Credit rating upgrade - NCD programme", summary
  "ICRA upgraded the Rs 5,000 crore NCD programme rating from [ICRA]AA (Positive) to [ICRA]AA+ (Stable); agency
  letter dated 30 April 2026."
- Record: rating field for NCDs changed from "[ICRA]AA (Positive)" to "[ICRA]AA+ (Stable)" with the filing path.
  Reply says so.

A reaffirmation at the same rating and outlook would be logged with no record change. An intimation "Schedule of
Analyst / Institutional Investor Meet on 12 May 2026" is logged; the reply tells the orchestrator that the
presentation and transcript intimations should follow within days and belong to `investor-presentations`.

More patterns per event type: `references/event-details.md`.

## Failure modes

| Situation | Action |
|---|---|
| The letter says "rating reaffirmed" but the enclosed agency letter shows an outlook change | Report both statements with pages. Update the record to what the agency letter says, and say why. |
| Several agencies / instruments in one letter | One log row; the summary lists the changes; the record is updated per instrument. |
| The event arrives only as a news article | Not a filing. Look for the intimation (skill `find-filings-on-exchanges`); if not found, report the lead, file nothing, change nothing in the record. |
| Approval vs allotment of the same NCD issue | Two filings, two rows. Do not merge; do not double count the amount in any summary. |
| Resignation letter gives reasons that the covering letter softens | Quote the resignation letter. |
