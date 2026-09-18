---
description: Use when the results filing is from a debt-listed ("unlisted") housing finance company under Regulation 52, or when an equity-listed company's results carry the Regulation 52(4) line items, security cover or a deviation statement - to know what differs from a Reg 33 filing, where the ratios sit, and what is normally absent.
---

# Reg 52 results of a debt-listed HFC

For a debt-listed HFC this filing **is** the analysts' Quarterly Report, and it is their first-priority source
(before the parent's investor presentation). It looks like a Reg 33 filing with three differences: what is
appended, what is missing, and how far back quarterly data goes.

## How to recognise it

- The covering letter cites Regulation 52 (often with 51, 52(4), 52(7)/(7A), 54), addresses the exchange's debt
  listing department, and identifies the company by the ISINs / scrip codes of its debentures, not an equity symbol.
- The statement heading usually names no basis ("Statement of Unaudited Financial Results ..."): most debt-listed
  HFCs have no subsidiaries. See layout D in skill `results-filing-layouts`.
- `python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/results.pdf --listing debt` returns
  `reg52_results`.

## What differs from Reg 33

| Topic | Debt-listed (Reg 52) filing | What you do |
|---|---|---|
| Basis | Usually one unlabelled statement | `bases_in_filing: "single_unlabelled"`, `basis_note` required |
| Reg 52(4) line items | Always present: as a note, as rows under the P&L, or an annexure | Extract as `disclosures` (list in `references/reg52-4-line-items.md`) |
| Security cover (Reg 54) | Certificate often appended, with a cover multiple per ISIN / trustee | `security_cover_times` when one overall figure is stated; otherwise summarise in the log row and cite the page |
| Deviation statement (52(7)/(7A)) | Appended while issue proceeds are outstanding | Log under `also_covers`; note "no deviation" or what it says |
| History | Older years may have **half-yearly** results only (the regulation moved debt-listed entities to quarterly results later) | No discrete quarter exists for those periods: see below |
| Comparatives | The first quarterly filings after the change may omit prior-quarter or year-ago columns, or mark them not applicable | Take what is printed; blanks stay blank |
| Shareholding, investor presentation, concall | Not applicable / not published | Report as "not published by a debt-listed entity", not as "not found" after a search |
| EPS | Often present but of little use (closely held) | Extract as printed |

If the filing in front of you contradicts this table (for example quarterly results in a year you expected
half-yearly), the filing is right. Extract what it contains and mention the difference.

## Procedure

1. Locate sections and check units:

   ```
   python3 /workspace/scripts/locate_results_sections.py /workspace/in/results.pdf
   ```

   Look for a `reg52_4_ratios` section; if there is none, check `reg52_4_mentions` and the `unmatched_rows` of the
   P&L extraction: the ratios may be rows of the results table itself.
2. Parse the header. Half-yearly history gives `status: no_discrete_quarter_column`:

   ```
   python3 /workspace/scripts/parse_results_columns.py --input /workspace/out/header.json
   ```

3. Extract the P&L (skill `results-filing-layouts`, step 6), then add each Reg 52(4) item as a disclosure with
   the label exactly as printed, its unit, page and period. Ratios: `unit: "times"` or `"percent"` as printed
   (a debt-equity of "5.10" is times; "82%" is percent; do not rescale one into the other). Amounts (net worth,
   PAT, reserves): `unit: "crore"` with `raw` and `unit_reported` so the validator can check the conversion.
4. Items that the filing marks "Not applicable" / "NA" / "-" (common for an NBFC: current ratio, debtors turnover,
   inventory turnover, DSCR, ISCR): `status: "not_disclosed"`, `value: null`, and put the printed text in `note`.
   They are absent by design; do not compute substitutes.
5. Validate, then write:

   ```
   python3 /workspace/scripts/validate_results_extract.py /workspace/out/extract.json
   ```

## Half-yearly history

Where only "Half year ended" and "Year ended" columns exist, there is no Q1, Q2, Q3 or Q4 figure in the filing. Hand
over the cumulative columns with `discrete_quarter: false` and `discrete_quarter_status: "absent"`. The second half
is not a quarter, and H1 is not Q2. The KPI subagent applies the analysts' rule for missing quarter data (most
recent available, with a footnote naming the period); you only make sure the period label is honest.

## What is typically absent (say so once, in the reply)

Investor presentation, concall transcript, shareholding pattern, segment table, consolidated statements, and
operational metrics (branches, employees, disbursements). AUM, disbursements and sell-down may appear only in the
notes (transfer of loan exposures) or in the parent's presentation. For those the analysts' second-priority source is the
parent company's investor presentation: name that gap so the orchestrator can send `investor-presentations` to it.

## Worked example

Example Housing Finance Ltd (debt-listed), Q3 FY26, annexure on page 6, table unit "Rs. in Lakhs":

| Printed | Disclosure row |
|---|---|
| Debt-Equity Ratio 5.10 | `debt_equity_ratio`, value 5.1, unit `times`, period `Q3 FY26`, period_kind `as_at`, page 6 |
| Net worth 4,50,000.00 | `net_worth`, value 4500.0, unit `crore`, raw "4,50,000.00", unit_reported `lakh` |
| Net profit after tax 21,000.00 (nine months) | `net_profit_after_tax`, value 210.0, period `9M FY26`, period_kind `ytd` |
| Total debts to total assets 0.82 | `total_debts_to_total_assets`, 0.82, `times` |
| Gross Stage 3 (%) 1.10% | `gnpa_pct`, 1.1, `percent`, label_reported "Gross Stage 3 (%)" |
| Capital adequacy ratio 24.5% | `crar_pct`, 24.5, `percent` |
| Current ratio: Not applicable | not extracted as a key (no such key); mention in the reply only if asked |
| Debt service coverage ratio: NA | `debt_service_coverage_ratio`, value null, status `not_disclosed`, note "printed as NA" |

Check which period a ratio row belongs to: annexures often give the quarter and the year-to-date side by side, and
profit-based lines (PAT, margins) differ between them while balance-sheet ratios do not.

## Failure modes

| Signal | Action |
|---|---|
| No Reg 52(4) items anywhere in a Reg 52 filing | Check image pages; then report "Reg 52(4) line items not found in the text pages (pages x-y are images)". |
| The ratio's definition is footnoted and unusual (e.g. debt-equity including securitisation liabilities) | Keep the value; copy the footnote into `note`. Definitions are the analyst's to reconcile. |
| Parent's numbers offered instead of the company's own | Log with `source: "parent_company"` and say so; never merge them into this extract. |
