# Period column headers: how they are printed and what they mean

`finlib.periods.normalise` (used by `python3 /workspace/scripts/derive_quarter.py --columns ...`) reads all of these.
Matching is case-insensitive.

## Shorthand forms (mostly presentations)

| Pattern (regex) | Examples | Normalised | Kind |
|---|---|---|---|
| `\bq\s*([1-4])` + `fy\s*'?(20)?\d{2}` | `Q2FY26`, `Q2 FY26`, `Q2 FY'26`, `Q2 FY2026` | `Q2 FY26` | quarter |
| `\b([1-4])\s*q` + FY | `2QFY26` | `Q2 FY26` | quarter |
| `fy\s*'?(20)?\d{2}\s*[-/]\s*(20)?\d{2}` | `Q2 FY2025-26`, `FY 2025-26` | second year wins: `FY26` | |
| `h1`, `1h`, `6m` + FY | `H1 FY26`, `1HFY26`, `6MFY26` | `H1 FY26` | cumulative |
| `9m` + FY | `9MFY26`, `9M FY26` | `9M FY26` | cumulative |
| FY alone | `FY26`, `FY 2026` | `FY26` | year |
| `h2`, `2h` + FY | `H2 FY26` | unreadable on purpose | not usable |

## Long forms (results tables)

| Wording | With end date | Normalised |
|---|---|---|
| `quarter ended`, `three months ended`, `3 months ended` | 30.06 / 30.09 / 31.12 / 31.03 | `Q1` / `Q2` / `Q3` / `Q4` of the fiscal year |
| `half year ended`, `half-year ended`, `six months ended` | 30.09 only | `H1 FYnn` |
| `nine months ended`, `9 months ended` | 31.12 only | `9M FYnn` |
| `year ended`, `twelve months ended` | 31.03 only | `FYnn` |

Date spellings read: `30.09.2025`, `30-09-2025`, `30/09/25`, `30 September 2025`, `30th Sept, 2025`,
`September 30, 2025`. Fiscal year = the year the March falls in: 30.09.2025 → FY26; 31.03.2026 → FY26; 30.06.2025 → FY26.

A date that is not a quarter end (31.10.2025), or a label with no period words ("Particulars", "Audited"), is
`unreadable`. Do not force it.

## Second header rows you will meet

| Second-row text | Meaning | What to do |
|---|---|---|
| `Unaudited` / `Reviewed` / `Audited` | audit status of the column | ignore for period purposes |
| `Standalone` / `Consolidated` | basis super-header spanning several period columns | pick the standalone block first (`standalone-vs-consolidated`) |
| `Refer note n` | restated or regrouped comparative | read the note; mention it in the footnote if it changes a figure you use |
| `Year to date figures for current period ended` | cumulative column | it is H1 or 9M depending on the date |
| `Previous year ended` | last full fiscal year | never the quarter |

## Balance sheet and cash flow columns

The statement of assets and liabilities is printed "As at" two dates (the period end and the previous March).
Those are balances: take the period-end column. The cash flow statement is always cumulative for the half year or
year: never use it for a quarter flow without deriving.
