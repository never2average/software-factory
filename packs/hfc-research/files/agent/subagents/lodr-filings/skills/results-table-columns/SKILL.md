---
description: Use when a results table header has to be read - which column is the discrete quarter, the previous quarter, the year-ago quarter, the half-year / nine-month / full-year figures - especially when the header is split over two or three rows, standalone and consolidated sit side by side, a column is marked restated, or the table has no quarter column at all.
---

# Results table columns

The single most damaging mistake in this workspace is handing back a cumulative column (H1, 9M, FY) as the quarter.
The analysts give precedence to the Q2, Q3 and Q4 numbers where H1, 9M and annual figures are also shown. The column
roles are therefore decided by script from the header text, and anything unclear is reported.

## How headers vary

| Variation | Example |
|---|---|
| Three header rows with spanning cells | row 1 "Quarter ended" (spans 3) / "Half year ended" (spans 2) / "Year ended"; row 2 dates; row 3 "(Unaudited)" / "(Audited)" |
| One row in the exchange-format wording | "3 months ended 31/12/2025", "Preceding 3 months ended", "Corresponding 3 months ended in the previous year", "Year to date figures for current period ended", "Previous year ended" |
| Date formats | 30.09.2025, 30/09/2025, 30-Sep-25, September 30, 2025, 30th September 2025 |
| Column count by quarter | Q1: 3 quarter columns + previous full year. Q2 / Q3: 3 quarter + 2 cumulative + previous full year. Q4: 3 quarter + 2 full-year columns. Deviations exist (a missing year-ago column in a company's first filings). |
| Side by side bases | Top row "Standalone" / "Consolidated", each spanning a full set of columns |
| Restated comparatives | "(Restated)", "(Recast)", "refer note 5" on a prior-period column; occasionally both as-reported and restated columns |
| No quarter column | Half-yearly filings of debt-listed entities: "Half year ended" and "Year ended" only |
| Text-only header | No cell grid (no ruling lines): the span phrases on one line, the dates on the next |

## Procedure

1. Extract the header rows of the chosen table as cells, top row first, keeping empty cells as `null`
   (`pdfplumber` `page.extract_table()` gives exactly this; merged cells put their text in the first cell and
   `None` in the rest). Include the "Standalone / Consolidated" row when there is one. Write:

   ```json
   {"header_rows": [["Sr. No.", "Particulars", "Quarter ended", null, null, "Half year ended", null, "Year ended"],
                    [null, null, "30.09.2025", "30.06.2025", "30.09.2024", "30.09.2025", "30.09.2024", "31.03.2025"],
                    [null, null, "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Unaudited)", "(Audited)"]]}
   ```

   If only text lines are available use `{"header_lines": ["...", "..."]}` instead.
2. Run, passing the filing period that `locate_results_sections.py` read from the statement heading:

   ```
   python3 /workspace/scripts/parse_results_columns.py --input /workspace/out/header.json --filing-period "Q2 FY26"
   ```

3. Read `status`:
   - `ok`: use `by_basis.<basis>.discrete_quarter` as the quarter column. `columns` goes unchanged into
     `extract_results_lines.py`.
   - `no_discrete_quarter_column`: the table has cumulative / annual columns only. Hand them over flagged
     `discrete_quarter: false`. Do not subtract here.
   - `ambiguous`: read `problems`. Fix the input (a lost basis row, a header cell that did not extract), or report.
     Do not choose a column by position.
4. Audit markers: `audit_status` per column (`unaudited`, `audited`, `reviewed`, or null when the header does not
   say). In a Q4 filing the March-quarter column is often "Audited (refer note)", the note saying it is the
   balancing figure between the audited year and the published nine months. Mention that note in the reply.
5. Restated: `restated: true` comes from the header. When as-reported and restated columns of the same period both
   exist, the parser reports both and `extract_results_lines.py` refuses until you pass only one. Which one the
   analysts want is their decision: ask, or hand over the restated column with a `basis_note` saying the
   as-reported column exists on the same page. Do not drop the fact.

How the rules work in detail (forward-fill, year-to-date wording, the text-line allotment) is in
`references/header-rules.md`.

## What to write

Nothing on its own; the `columns` array becomes part of the results extract.

## Worked example

Q4 filing of Example Housing Finance Ltd, header as text lines only:

```json
{"header_lines": ["Particulars Quarter ended Year ended", "31.03.2026 31.12.2025 31.03.2025 31.03.2026 31.03.2025",
                  "Audited Unaudited Audited Audited Audited"]}
```

Five dates, two span phrases. "Quarter ended" accepts any quarter-end, "Year ended" only 31 March, and a date may not
repeat inside one span. Only one allotment survives: quarter = the first three, year = the last two. Result:
`discrete_quarter` (Q4 FY26), `previous_quarter` (Q3 FY26), `year_ago_quarter` (Q4 FY25), `full_year_current` (FY26),
`full_year_previous` (FY25), `status: ok`. Had the header been "31.03.2026 31.03.2025 31.03.2024" under the same two
phrases, two allotments would be valid and the parser returns `ambiguous` with "give header_rows (cells) instead".

## Failure modes

| Problem reported | Cause and action |
|---|---|
| "columns [a, b] both read as discrete_quarter" | Side-by-side bases without the basis row, or a restated twin. Re-extract the header including the top row. |
| "header '...' has a date or period word but does not parse" | e.g. "Half year ended 30.06.2025", a typo in the filing, or a span cell that landed over the wrong column. Look at the page; if the filing itself is wrong, report it verbatim. |
| A column reads `other_period` | A period a filing of this quarter does not normally show (e.g. the filing period passed is wrong). Check `--filing-period`. |
| Header cell text is centred in the middle cell of a span | Forward-fill cannot reach the first column of the span; that column comes out `unparsed`. Re-extract with explicit cell text, or use `header_lines`. |
| Fiscal year is not April-March | `finlib.periods` assumes April-March. A December year-end company cannot be parsed: report it, do not force labels. |
