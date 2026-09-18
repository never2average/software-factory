---
description: Use when a results table or presentation slide shows half-year (H1), nine-month (9M) or full-year (FY) columns next to or instead of the quarter, when you need Q2, Q3 or Q4 and only cumulative figures exist, or when you are unsure whether a number is a three-month figure.
---

# Discrete quarter from cumulative figures

Rulebook: "Precedence is given to Q2, Q3, and Q4 numbers, where H1, 9M, and Annual figures are also mentioned."
A cumulative figure is never reported as a quarter. If only cumulative figures exist, the quarter is derived by
subtracting the earlier published cumulative figure, and the row is footnoted.

## Recognise the variation

Indian fiscal year runs April to March: Q1 ends 30 June, Q2 30 September, Q3 31 December, Q4 31 March.

| What the filing shows | Typical header wording | What it is |
|---|---|---|
| Quarter column | "Quarter ended 30.09.2025", "Three months ended", "Q2 FY26", "2QFY26" | discrete quarter: use it |
| Half-year column | "Half year ended 30.09.2025", "Six months ended", "H1 FY26", "1HFY26" | cumulative April to September |
| Nine-month column | "Nine months ended 31.12.2025", "9M FY26" | cumulative April to December |
| Year column | "Year ended 31.03.2026", "FY26", "FY 2025-26" | cumulative April to March |
| "Year to date", "YTD", "for the period" | | cumulative; find which period |

A quarterly results table normally prints the quarter, the preceding quarter, the same quarter last year, the
year-to-date period and its comparative, and the last full year. The Q4 results table normally has no nine-month
column, so a Q4 flow that is not printed as a quarter needs the 9M figure from the Q3 filing. Presentations often show
only H1 / 9M / FY totals for disbursements. Trust the headers in front of you, not this description; the full header
regex table is in `references/column-headers.md`.

Let the script read the headers:

```
python3 /workspace/scripts/derive_quarter.py --target "Q2 FY26" --columns \
  "Quarter ended 30.09.2025" "Quarter ended 30.06.2025" "Quarter ended 30.09.2024" \
  "Half year ended 30.09.2025" "Half year ended 30.09.2024" "Year ended 31.03.2025"
```

It answers with each column's period and kind, `use_for_flows` (the column index to read), or `needs_derivation`.
If two columns read as the same quarter, they are probably standalone and consolidated side by side: see the
`standalone-vs-consolidated` skill.

## Flows and balances are different

| Kind | KPIs and inputs | Rule |
|---|---|---|
| Flow (accumulates through the year) | `disbursements`, `sell_down_volume`, `buy_out_volume`, `opex`, `employee_cost`, `nii`, `pat_quarter` | must be the three-month figure; derive if only cumulative |
| Balance (point in time) | `aum`, `loan_book`, `networth`, `borrowings`, `branches`, `employees` | the figure "as at" the quarter-end date IS the quarter's value, whichever column it sits in. Never subtract. |
| Ratio | `gnpa_pct`, `nnpa_pct`, `pcr_stage3_pct`, `yield_pct`, `cost_of_funds_pct`, `spread_pct`, `nim_pct`, `crar_pct`, `debt_equity` | cannot be derived by subtraction. Point-in-time ratios (GNPA, CRAR, D/E) are fine as at the date. Period ratios (yield, cost of funds, NIM) printed only for H1/9M/FY are reported with a footnote naming the period and status `needs_review`. |

## Procedure for a flow

1. If a discrete quarter figure is printed anywhere in the QR or IP for that quarter, use it. Stop.
2. Otherwise find the cumulative figure through the quarter, and the cumulative figure through the previous quarter:
   Q2 = H1 − Q1, Q3 = 9M − H1, Q4 = FY − 9M. Nothing else is a quarter (FY − H1 is a half year).
3. The earlier figure: prefer the comparative printed in the CURRENT filing if it prints one (it is restated to the
   current basis; pass `--before-restated`). Otherwise take it from the earlier quarter's filing in the data room. If
   that filing is not in the data room, stop and name it so the orchestrator can have it fetched.
4. Both figures must be on the same basis (standalone) and from the same kind of source. Run:

   ```
   python3 /workspace/scripts/derive_quarter.py --kind flow --metric disbursements \
     --through "9M FY26" --through-value "5,400" --before "H1 FY26" --before-value "3,500" --unit crore
   ```

   Units may differ between the two (`--unit lakh --before-unit crore`); the result is then in ₹ crore.
5. Write the row with the derived `value`, `derived_from_cumulative: true`, the script's `footnote` verbatim, the
   document and page of the cumulative figure in `document` / `page_or_slide`, and name the earlier document in the
   footnote too.
6. If the script returns `suggested_status: needs_review` (negative disbursement, or a quarter larger than the
   cumulative), mark the row `needs_review` and say why.

## Worked example (synthetic: Example Housing Finance Ltd)

The Q3 FY26 presentation shows "Disbursements 9M FY26: ₹5,400 crore". The Q2 FY26 presentation showed "H1 FY26:
₹3,500 crore". No slide gives Q3 alone.

```
python3 /workspace/scripts/derive_quarter.py --kind flow --metric disbursements \
  --through "9M FY26" --through-value "5,400" --before "H1 FY26" --before-value "3,500"
```

→ `period "Q3 FY26"`, `value 1900.0`, footnote: "Q3 FY26 derived as 9M FY26 (5,400.00) minus H1 FY26 (3,500.00);
the filing gives no discrete quarter figure. H1 FY26 is the figure published in the earlier filing."

And the refusal you should expect if you try it on a balance:

```
python3 /workspace/scripts/derive_quarter.py --kind balance --metric aum --through "H1 FY26" --through-value 9000 --before "Q1 FY26" --before-value 8600
```

→ exit 1, "refused: a balance ... is a point-in-time figure ... never subtract balances." AUM as at 30 September is
simply 9,000.

More cases (Q4 from FY − 9M with mixed units, restated comparatives, footnote wording) are in
`references/worked-examples.md`.

## Failure modes

- **H2 column** ("H2 FY26", "second half"): neither a quarter nor cumulative from April. Not usable; `normalise`
  returns nothing for it.
- **Restated comparatives.** When the current filing restates the earlier cumulative figure, the derived quarter
  differs from "current cumulative − originally published". Use the restated one if the current filing prints it,
  and say so (the footnote does with `--before-restated`).
- **Earlier filing missing** from the data room: the quarter cannot be derived. Status `not_found`, footnote names
  the missing filing, and the summary asks for it.
- **Average-based ratios for H1/9M** cannot be turned into a quarter. Do not try.
- **Calendar-year or non-March year-end companies**: `finlib.periods` assumes April to March. If the filing's year
  ends in another month, stop and tell the analyst.
