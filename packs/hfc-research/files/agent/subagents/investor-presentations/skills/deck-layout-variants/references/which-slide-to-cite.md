# The same number on several slides: which slide to cite

Decks repeat their headline numbers. `ip-metrics.jsonl` takes **one row per metric per period**
(`validate_ip_metrics.py` flags a second row as a duplicate, and as a conflict if the value differs).

## Preference order

1. The slide whose **subject is the metric** (its title names it), giving the **discrete quarter** as a
   **printed number** in a table or a data label.
2. A summary table of several quarters (P&L / operating summary) that prints the number.
3. The highlights / snapshot tile. Tiles are often rounded ("₹ 12.3k crore") or carry growth next to the number.
4. A chart without a data label: only if nothing above exists, and then `approximate: true`.
5. Never the cover strip, the "at a glance" marketing slide, or a slide in the restructured-book section.

Ties: the slide with the more precise number (more digits) wins; then the earlier slide.

## When the repeats disagree

| Pattern | What it usually is | Do |
|---|---|---|
| 12,345 on one slide, 12,300 or "12.3k" on another | Rounding | Cite the precise one. No note needed |
| 12,345 vs 10,900 | AUM vs loan book (on-book) | Two different metrics. Write both rows (`aum`, `loan_book`). See `aum-mix-and-off-book` |
| 1,050 vs 2,010 | Quarter vs H1 | Cite the quarter. See `mixed-periods-on-a-slide` |
| 215 vs 480 | Branches vs touchpoints | Two bases. See `operational-metrics` |
| Genuinely different values for the same metric, period and basis | An error in the deck, or a restated number | Do not choose. Write **no** row for it, report both values with slide numbers, and let the analyst decide |

## Worked example

Example Housing Finance Ltd, Q2 FY26. Disbursements appear as: slide 4 tile "₹ 1,050 Cr", slide 9 table
"Disbursements 890 960 1,050 2,010" under "Q2 FY25, Q1 FY26, Q2 FY26, H1 FY26", slide 10 bar chart with no
labels. Cite **slide 9**, value 1050, period `Q2FY26`. Slide 4 agrees, so no note. The chart is not used.
