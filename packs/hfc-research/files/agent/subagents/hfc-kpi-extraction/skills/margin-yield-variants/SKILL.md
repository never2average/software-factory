---
description: Use when extracting yield, cost of funds, spread or NIM, when a company defines them on a different base (average AUM, average loan book, average total assets), annualises differently, includes or excludes assignment and fee income, prints incremental as well as portfolio figures, or does not disclose a spread.
---

# Margin and yield variants

Rulebook: **Yield** = effective interest rate on loans. **Cost of Fund** = average cost of borrowing. **NIM** = net
interest margin (derived from net interest income). Margin and yield are "calculated/extracted based on Yield,
Cost of Funds, Spread, and NIM": take them **as disclosed**. **Spread = Yield − Cost of Funds when it is not
disclosed.**

These four are the least standardised numbers in the table. You do not harmonise definitions; you capture the
company's definition next to the number so the analysts can see what they are comparing.

## Recognise the variation

| Dimension | Variants you will meet |
|---|---|
| Base of yield | on average loan book / average on-book loans; on average AUM; on closing loans; "portfolio yield" (weighted average contracted rate of the book at quarter end) |
| Cost of funds | interest expense ÷ average borrowings (period average); weighted average cost of borrowings outstanding at quarter end (point in time); including / excluding assignment funding |
| Spread | portfolio yield − cost of funds; "spread on loans"; incremental spread |
| NIM | NII ÷ average total assets; ÷ average AUM; ÷ average loan book; ÷ average interest-earning assets. NII may include assignment (upfront) income, fee income, or neither |
| Annualisation | quarter × 4; quarter × 365 ÷ days; not annualised ("for the quarter": a NIM of 0.9% is a quarter's NIM) |
| Period | for the quarter; for H1 / 9M / FY (year to date) |
| Portfolio vs incremental | "yield on disbursements", "incremental cost of funds", "marginal": NOT the KPI |

Variant tables and the wording that signals each are in `references/definition-variants.md`.

## Procedure

1. Locate: `python3 /workspace/scripts/detect_content_type.py <ip.pdf> --find "yield" "cost\s+of\s+(funds?|borrowings?)" "spread" "\bNIM\b|net\s+interest\s+margin"`.
   The QR rarely prints these; the IP's margin / profitability slide and its footnotes do. Check the glossary or
   "definitions" slide at the end of the deck.
2. Take the PORTFOLIO figure for the QUARTER. Skip incremental figures (`kpi_catalog.py --match "Incremental yield"`
   → `no_match` on purpose).
3. For each of the four write the row with `definition` filled from the slide's own words, for example
   `"NIM = NII (incl. assignment income) / average AUM, annualised"`. If the deck gives no definition write
   `"definition not stated"`.
4. Spread:
   - disclosed → report as disclosed, `source` QR or IP.
   - not disclosed → compute with the calculator; never subtract in your head:

     ```
     python3 /workspace/scripts/compute_kpis.py --inputs /workspace/out/inputs-q2fy26.json --rows
     ```

     The `spread_pct` row comes back with `source "computed"` and the footnote "Spread is not disclosed; computed as
     Yield − Cost of Funds." Give `yield_pct` and `cost_of_funds_pct` as objects with their document and slide so
     the row is cited.
   - disclosed AND different from yield − cost of funds by more than 0.05 points → keep the disclosed figure; the
     calculator's `spread.advice` tells you to footnote the difference.
5. NIM is never computed by you: the rulebook gives no NIM formula. If the company does not print a NIM, the row is
   `not_found` with the footnote "NIM not disclosed; NII for the quarter is ₹x crore (QR p.n)".
6. Only a year-to-date figure is printed (for example "NIM 9M FY26: 3.6%") → report it with `value_period` =
   `"9M FY26"`, status `needs_review`, footnote "Only the 9M FY26 figure is disclosed; a ratio cannot be converted to
   a quarter." `python3 /workspace/scripts/derive_quarter.py --kind ratio ...` refuses, by design.
7. `remember` the company's definitions, and at the start of each run compare with `list_memories`: a changed
   definition is reported in the summary.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

IP slide 12, "Margins (annualised, on average AUM)": Yield 11.4%, Cost of borrowings 8.1%, NIM 5.9%. No spread is
printed. Slide footnote: "NIM = (interest income + assignment income − finance cost) / average AUM".

| Row | value | source | definition |
|---|---|---|---|
| `yield_pct` | 11.4 | IP, slide 12 | "yield on average AUM, annualised" |
| `cost_of_funds_pct` | 8.1 | IP, slide 12 | "cost of borrowings, annualised; base not stated" |
| `spread_pct` | 3.3 | computed | footnote "Spread is not disclosed; computed as Yield − Cost of Funds." |
| `nim_pct` | 5.9 | IP, slide 12 | "NIM = (interest income + assignment income − finance cost) / average AUM, annualised" |

Next quarter the slide says "Spread 3.0%" while 11.5 − 8.2 = 3.3: report 3.0 as disclosed and footnote
"Yield − cost of funds = 3.30%; the company's spread is defined on a different base."

## Failure modes

- **Fractions.** `0.114` for 11.4% is flagged by `validate_kpis.py` (`F-RANGE`, "looks like a fraction").
- **Basis points.** "Spread 330 bps" → 3.30. Write the conversion in the footnote.
- **Un-annualised quarter figure** reported next to annualised ones: do not annualise it yourself; report as
  printed with the definition, `needs_review`.
- **Cost of funds on a chart of the borrowing mix** with no data label → `needs_review`, `read_from_chart: true`.
- **Yield on investments / treasury** is not the KPI.
