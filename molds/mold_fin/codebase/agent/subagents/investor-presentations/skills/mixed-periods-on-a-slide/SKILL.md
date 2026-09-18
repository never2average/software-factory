---
description: Use when a slide shows quarterly figures next to H1, 9M, full-year or trailing-twelve-month figures, when growth percentages (YoY, QoQ) sit beside the values, when only a cumulative figure is given and the discrete quarter has to be derived, or when you need to label which period a figure covers.
---

# Mixed periods on one slide

Rulebook: **precedence is given to Q2, Q3 and Q4 numbers where H1, 9M and annual figures are also
mentioned.** Instruction: take the discrete quarter, and label what you took.

## Recognise the variation

| On the slide | Meaning |
|---|---|
| Columns `Q2 FY25 | Q1 FY26 | Q2 FY26 | H1 FY25 | H1 FY26` | Quarter and half-year side by side. `slide_index.py` sets `mixed_periods: true` |
| `9M FY26` only, in a Q3 deck | Cumulative only |
| `FY26` next to `Q4 FY26` | Year and quarter side by side in a Q4 deck |
| `TTM`, `LTM`, "rolling 12 months" | Trailing: never a quarter and never a fiscal year |
| `Sep-25`, `as on 30 September 2025` | A balance date. For AUM, loan book, branches, employees this **is** the quarter (Q2 FY26) |
| `+18% YoY`, `▲ 9% QoQ` next to a value | Growth rates. Not the metric |
| Column headed only `H1` with a footnote "figures for the half year" | Cumulative, even though the deck is the Q2 deck |

## Procedure

1. Check the index: `python3 /workspace/scripts/slide_index.py /workspace/in/deck.pdf > /workspace/out/slide-index.json`
   and look at the slide's `periods` and `mixed_periods`.
2. Extract with the target quarter named:
   `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`
   - `period_source: column_header` means the script matched a row of N figures to a header of N periods.
   - `is_target_period: true` marks the discrete quarter you asked for.
   - `not_a_discrete_quarter` flags H1/9M/FY/TTM figures.
   - `period_ambiguous` means the row had a different number of figures than the header has periods (a
     blank cell, a growth column). The script does not guess which column is missing. Read the slide.
   - `is_growth_rate: true` marks YoY/QoQ percentages.
3. **Stocks vs flows.** Balances (AUM, loan book, off-book, branches, employees, mix shares, LTV) are
   point-in-time: the value "as at" the quarter end is the quarter's value, and an "H1" column for a balance
   is the same number. Flows (disbursements, sell down, buy out) are what cumulate.
4. **Only a cumulative flow is given.** In order:
   1. Look for the discrete quarter elsewhere in the deck (trend charts usually have it).
   2. Derive it: Q2 = H1 − Q1, Q3 = 9M − H1, Q4 = FY − 9M, where the earlier cumulative figure comes from the
      **previous deck's row already in `ip-metrics.jsonl`** or from the same slide. One line of Python using
      the shared library (never mental arithmetic):
      `python3 -c "import sys; sys.path.insert(0,'/workspace/scripts'); from finlib import periods; print(periods.derive_quarter(2, 2010.0, 960.0))"`
      Write the row with `status: derived` and the arithmetic and both sources in the note.
   3. If neither is possible, write the cumulative figure **as cumulative**: `period: "H1FY26"`,
      `period_basis: "ytd"`, and a note saying why. Never file a YTD number under a quarter.
5. **Never derive from approximate inputs, from TTM, or across a restatement** (footnote "previous period
   figures regrouped/restated"): report instead.
6. **Yields, spreads, NIM** are averages over a period. Take the quarter's (often labelled "Q2 FY26
   annualised"). An H1 average is not the quarter's; if only H1 is given, write it as `H1FY26` / `ytd`.
7. Validate (`validate-and-hand-off`): the validator rejects an H1/9M/FY period without
   `period_basis`, and a `ytd` basis on a quarter period.

## What to write

`period` is the period the value covers. Default is the discrete quarter. Anything else carries
`period_basis` and a note.

## Worked example

Example Housing Finance Ltd, Q2 FY26 deck, slide 9 (₹ crore):

```
                 Q2 FY25   Q1 FY26   Q2 FY26   YoY    H1 FY26
Disbursements        890       960     1,050   18%      2,010
AUM               10,460    11,870    12,345   18%
```

Extractor output: the header has five columns (four periods and a `YoY` growth column) and the Disbursements
row has five figures, so they map one to one: 890 → Q2 FY25, 960 → Q1 FY26, 1,050 → Q2 FY26
(`is_target_period`), 18% → `is_growth_rate`, 2,010 → H1 FY26 (`not_a_discrete_quarter`). The AUM row has
four figures for five columns: `period_ambiguous`, because the script will not guess which cell is blank. Looking at the
slide, the H1 cell is blank (a balance has no H1), so AUM 12,345 is the Q2 FY26 column. Rows:
`disbursements 1050 Q2FY26 slide 9`, `aum 12345 Q2FY26 slide 9`.

Q3 FY26 deck, appendix shows only "Loans assigned, 9M FY26: 520". `ip-metrics.jsonl` has Q1 130 and Q2 180
(H1 310). `derive_quarter(3, 520.0, 310.0)` = 210:

```json
{"customer_id":"example-hfl","period":"Q3FY26","metric":"sell_down_volume","value":210,"unit":"crore","document":"…/2026-02-03_Q3FY26_investor-presentation.pdf","slide":40,"approximate":false,"from_parent":false,"note":"Derived: 9M FY26 520 (slide 40) less H1 FY26 310 (Q1 130 + Q2 180 from the Q1 and Q2 decks, ip-metrics.jsonl). The deck gives no discrete Q3 figure.","extracted_at":"2026-02-04T09:00:00Z","status":"derived"}
```

## Failure modes and what to report

| Situation | Do this |
|---|---|
| Header says "Q2" with no fiscal year | Use the deck's own period from the cover only if every column is accounted for; otherwise `period_ambiguous`, report |
| Calendar-year labels ("Q3 CY25") | Indian HFCs report April to March. Record the label as printed in the note and map by the quarter-end month only if the slide gives it; else report |
| The previous quarter's row is approximate or missing | Do not derive. File the YTD figure as YTD |
| Quarter figure and (YTD − previous YTD) disagree | Restatement or regrouping. Cite the printed quarter figure, and mention the difference |
| `H2 FY26` | Neither a quarter nor a cumulative-from-April period. `finlib.periods` does not parse it on purpose; report it |
