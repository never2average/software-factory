---
description: Use when you need sell down (loans transferred or assigned) or buy out (loans acquired) volumes from a results filing, i.e. the disclosure under the RBI directions on transfer of loan exposures in the notes - including when it is nil, year-to-date rather than quarterly, split into several tables, or sits next to securitisation and stressed-loan tables.
---

# The transfer-of-loan-exposures note

The analysts' definitions: **Sell Down Volume (SD)** = loans transferred / assigned (moved off the balance sheet);
**Buy Out Volume (BO)** = loans acquired (brought onto the balance sheet). Both come from the disclosure lenders
make under the RBI's Master Direction on Transfer of Loan Exposures, which appears in the notes to the results
(the analysts call the place "the appendix or disclosure tables"). You locate and structure it; you do not decide
what it means for AUM.

## How to recognise it

A note that starts along the lines of "Disclosure pursuant to RBI Master Direction - Reserve Bank of India (Transfer
of Loan Exposures) Directions, 2021 ..." followed by one to three small tables:

| Table | Title wording | Maps to |
|---|---|---|
| (a) loans **not in default transferred** through assignment / novation / loan participation | "Details of loans not in default transferred", "transferred through direct assignment", "assigned" | sell down |
| (b) loans **not in default acquired** | "Details of loans not in default acquired", "acquired through assignment" | buy out |
| (c) **stressed loans** transferred (to ARCs, permitted transferees, others) and stressed loans acquired | "Details of stressed loans transferred", "NPA / SMA accounts transferred" | separate keys; not part of SD / BO |

Usual rows: aggregate amount (or "aggregate principal outstanding") of loans transferred / acquired; count of
accounts or loans; weighted average (residual) maturity; weighted average holding period; retention of beneficial
economic interest (the share kept, often 10% or 20%); security / tangible security coverage; rating-wise
distribution (usually "unrated" / "NA" for retail home loans). Layout is either one column per period or, for
co-lending and mixed pools, one column per asset class.

Search terms and label variants are in `references/vocabulary-and-shape.md`.

## Procedure

1. Locate the standalone notes:

   ```
   python3 /workspace/scripts/locate_results_sections.py /workspace/in/results.pdf
   ```

2. On those pages find the note (regex in the reference). Read its first sentence for the **period**: "during the
   quarter ended", "during the half year ended", "during the nine months ended", "during the year ended". This
   decides `period_kind`:

   | Wording | period | period_kind |
   |---|---|---|
   | during the quarter ended 30 September 2025 | `Q2 FY26` | `quarter` |
   | during the half year / six months ended 30 September 2025 | `H1 FY26` | `ytd` |
   | during the nine months ended 31 December 2025 | `9M FY26` | `ytd` |
   | during the year ended 31 March 2026 | `FY26` | `year` |
   | both quarter and year-to-date columns | one row per column |

   Most companies give year-to-date only. Hand over year-to-date as year-to-date. The discrete quarter is
   derived by `hfc-kpi-extraction` (cumulative minus previous cumulative) with a footnote; do not subtract here, and
   never label a year-to-date amount `quarter`.
3. Write disclosure rows: `loans_transferred_amount`, `loans_transferred_count`,
   `loans_transferred_wa_maturity_months`, `loans_transferred_wa_holding_period_months`,
   `loans_transferred_retention_pct`, `loans_transferred_security_coverage_pct`, and the same set with
   `loans_acquired_`. Stressed-loan tables: `stressed_loans_transferred_amount`, `stressed_loans_acquired_amount`.
   Amounts carry `raw` and `unit_reported` (the note's own unit when it states one, else the statement's).
   Maturity printed in years: keep the printed figure in `raw`, put months in `value` only if the filing says
   months; otherwise leave the key out and quote the figure in the reply (no unit conversion of time is defined).
4. **Nil disclosures are data.** "The Company has not transferred or acquired any loan exposures during the
   period" -> both amount keys with `status: "nil"`, `value: 0`, the sentence's page, and the sentence in `note`.
   A nil sell down matters to the analysts: if AUM equals the loan book there is no sell down. If the note covers
   only one direction ("has not acquired any loans"), only that direction is nil; the other is whatever its
   table says.
5. **No note at all** -> `status: "not_disclosed"` for both amounts, page null, and say which pages you searched.
   Absence of the note is not a nil.
6. Validate:

   ```
   python3 /workspace/scripts/validate_results_extract.py /workspace/out/extract.json
   ```

## What not to take

- **Restructured accounts** and resolution-framework tables often sit in the adjacent note. Excluded by the
  analysts' rulebook; the validator rejects them.
- **Securitisation** (PTC / SPV transactions) is disclosed under different directions and is not "transfer of loan
  exposures". If the company sells down through securitisation rather than direct assignment, say so in the reply
  with the page; do not put securitised volumes under `loans_transferred_amount`.
- **Co-lending** volumes: some companies disclose them within this note, some separately. Keep the company's own
  split and wording in `label_reported` / `note`.
- The **P&L line** "net gain on derecognition of financial instruments" is income on the sell down, not its volume.

## What to write

Rows in `extract.disclosures`. In the reply, one line per direction: amount, period covered, page, and whether it
is quarter or year-to-date.

## Worked example

Example Housing Finance Ltd, Q2 FY26, standalone notes page 8, filing unit Rs lakh:

> 9. Disclosure pursuant to RBI Master Direction on Transfer of Loan Exposures:
> (a) Details of loans not in default transferred through assignment during the half year ended September 30, 2025:
> Aggregate amount of loans transferred (Rs. in lakh) 62,000.00; Number of loans 3,410; Weighted average residual
> maturity (months) 182; Weighted average holding period (months) 14; Retention of beneficial economic interest 10%.
> (b) The Company has not acquired any loans not in default during the half year ended September 30, 2025.
> (c) The Company has not transferred or acquired any stressed loans.

```json
[{"key": "loans_transferred_amount", "label_reported": "Aggregate amount of loans transferred", "period": "H1 FY26", "period_kind": "ytd", "value": 620.0, "unit": "crore", "raw": "62,000.00", "unit_reported": "lakh", "status": "ok", "page": 8},
 {"key": "loans_transferred_count", "label_reported": "Number of loans", "period": "H1 FY26", "period_kind": "ytd", "value": 3410, "unit": "count", "raw": "3,410", "status": "ok", "page": 8},
 {"key": "loans_transferred_wa_maturity_months", "label_reported": "Weighted average residual maturity (months)", "period": "H1 FY26", "period_kind": "ytd", "value": 182, "unit": "months", "raw": "182", "status": "ok", "page": 8},
 {"key": "loans_transferred_retention_pct", "label_reported": "Retention of beneficial economic interest", "period": "H1 FY26", "period_kind": "ytd", "value": 10, "unit": "percent", "raw": "10%", "status": "ok", "page": 8},
 {"key": "loans_acquired_amount", "label_reported": "Loans not in default acquired", "period": "H1 FY26", "period_kind": "ytd", "value": 0, "unit": "crore", "raw": null, "status": "nil", "page": 8, "note": "The Company has not acquired any loans not in default during the half year ended September 30, 2025."}]
```

Reply line: "Sell down (loans transferred through assignment): Rs 620.00 crore for H1 FY26 (year-to-date, not the
quarter), p.8. Buy out: nil for H1 FY26, p.8. The Q1 FY26 filing's figure is needed to derive Q2."

## Failure modes

| Situation | Action |
|---|---|
| Table columns are asset classes, not periods | One row per class is not supported by the keys: sum only if the filing prints a total; otherwise hand over the printed total row, or report the classes in the reply and leave the amount `not_disclosed` with a note. Never add them yourself. |
| Amount given "in crore" inside a lakh filing | The note's unit wins for that row: `unit_reported: "crore"`. |
| Only the annual report carries the note | Say so; `annual-report-format` owns that document. |
| The note is on an image page | "Not readable", not "not disclosed" (skill `scanned-and-image-pdfs`). |
