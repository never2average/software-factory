# Header rules in `parse_results_columns.py`

## Composing a column's header from rows

1. Every cell is whitespace-collapsed; `null` becomes empty.
2. A row is a *span row* when any of its cells contains a span word (quarter, months, half year, year, period,
   standalone, consolidated) and the row is not made only of dates. In a span row an empty cell takes the text of
   the nearest span cell to its left. Cells are not filled from a non-span cell ("Particulars" never spreads).
3. The column header is the top-down join of its cells: `Standalone Quarter ended 30.09.2025 (Unaudited)`.

## Reading the period

`finlib.periods.normalise` reads "Quarter ended 30.09.2025", "Half year ended September 30, 2025", "Nine months
ended 31-12-2025", "Year ended 31 March 2026", "3 months ended ...", "Six months ended ...". On top of that:

- `30-Sep-25`, `30 Sep 25`, `30th September 2025` are rewritten to a form finlib reads.
- "Year to date figures for current period ended <date>", "YTD", "period ended", "cumulative" take their length from
  the date: 30 September -> H1, 31 December -> 9M, 31 March -> FY, 30 June -> the first quarter, labelled
  cumulative.
- A span word that contradicts the date ("Half year ended 30.06.2025") does not parse and is reported.

| Header | period | kind |
|---|---|---|
| Quarter ended 30.09.2025 | Q2 FY26 | quarter |
| Preceding 3 months ended 30/06/2025 | Q1 FY26 | quarter |
| Corresponding 3 months ended in the previous year 30/09/2024 | Q2 FY25 | quarter |
| Half year ended 30.09.2025 | H1 FY26 | cumulative |
| Year to date figures for current period ended 31/12/2025 | 9M FY26 | cumulative |
| Year ended 31.03.2025 / Previous year ended 31/03/2025 | FY25 | year |

## Roles

The filing period is `--filing-period`, else the latest quarter column, else (no quarter columns) the quarter in
which the latest cumulative column ends. `filing_period_source` says which.

| Role | Rule (within one basis) |
|---|---|
| `discrete_quarter` | kind quarter, period = filing period |
| `previous_quarter` | kind quarter, period = `finlib.periods.previous_quarter(filing period)` (Q1's previous is Q4 of the prior fiscal year) |
| `year_ago_quarter` | kind quarter, same quarter, fiscal year - 1 |
| `cumulative_current` / `cumulative_year_ago` | kind cumulative ending in the filing quarter, this / previous fiscal year |
| `full_year_current` | kind year, same fiscal year, only in a Q4 filing |
| `full_year_previous` | kind year, fiscal year - 1 |
| `other_period` | parses, fits none of the above: reported |
| `label` | no date and no span phrase (Particulars, Sr. No.) |
| `unparsed` | has a date or a span phrase but no readable period: status becomes `ambiguous` |

`discrete_quarter` (the boolean on every column) is true exactly when kind = quarter. The validator enforces the
same on the extract, so a cumulative column can never be delivered as a quarter.

## Text-line headers

Span phrases are found in order (`quarter ended`, `3 months ended`, `half year ended`, `six months ended`, `nine
months ended`, `year to date ... ended`, `year ended`), and dates in order. When there are more dates than phrases,
every way of cutting the date list into consecutive groups, one per phrase, is tried; a cut is valid when every
date parses under its phrase and no date repeats inside a group. Exactly one valid cut -> columns. Zero or several
-> `ambiguous`. Audited / unaudited markers are attached only when their count equals the column count.
Standalone / consolidated cannot be read from lines: the parser says so and you must supply `header_rows`.
