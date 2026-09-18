# Reading charts: data label or axis reading?

## Decision table

| Evidence on the slide | Value | `approximate` | Note must say |
|---|---|---|---|
| Number printed on/above the bar, in the segment, at the marker, for the series and period you want | as printed | `false` | "data label on chart" and the series |
| Number printed for the bar's **total** only; you want a segment | segment read off axis | `true` | axis gridline spacing; total is labelled |
| Labelled segments, no total; you want the total | sum of labels | `false`, `status: derived` | the addends |
| No numbers on the bars; an axis with ticks | read off axis | `true` | gridline spacing and the rounding used |
| Pie with printed percentages | as printed | `false` | |
| Pie without percentages | do not estimate angles | | write `not_disclosed`, note "unlabelled pie" |
| No axis, no labels | nothing | | `not_disclosed` |

## Precision of an axis reading

Round to half the gridline spacing at most. Gridlines every 300: report to the nearest 50 or 100, never
"1,047". Gridlines every 2,000: nearest 250 or 500. If the bar top sits between two ticks and you cannot say
nearer which, give the midpoint and say "between X and Y" in the note.

## How text extraction scrambles a chart

| Extracted text pattern | What it usually is |
|---|---|
| `0 300 600 900 1,200` on one line, or those numbers on five consecutive lines | The value axis. `extract_labelled_numbers.py --from-chart` lists it under `axis_ticks` |
| `890 960 1,050` then `Q2 FY25 Q1 FY26 Q2 FY26` | Data labels, then category labels below the bars |
| `Q2 FY25 Q1 FY26 Q2 FY26` then `890 960 1,050` | Category labels as a header row (table-like) |
| `71% 19% 10%` with the legend text elsewhere on the slide | Pie labels separated from their legend: the order is **not** reliable. Match each to its segment on the slide |
| Two runs of numbers of the same length | Two series (e.g. disbursements and AUM). The script cannot tell which is which |
| `18% 12% 9%` next to the bars | Growth rates over the bars, not the values |

## Worked example

Stacked bar "AUM mix", Q2 FY26 column: segments labelled 8,765 / 2,346 / 1,234, no total.
`aum = 12345`, `status: derived`, `approximate: false`, note "Sum of labelled segments 8,765 + 2,346 + 1,234
on the stacked bar; the bar has no total label." If slide 9 prints AUM 12,345 in a table, cite slide 9
instead and skip the derivation.
