# Period labels in decks and how the scripts read them

`python3 /workspace/scripts/iplib.py --periods "<text>"` prints what the period reader finds in any text.

| Printed | Read as | Kind |
|---|---|---|
| `Q2 FY26`, `Q2FY26`, `Q2'FY26`, `2QFY26`, `Q2 FY2025-26`, `Q2 FY 25-26` | Q2 FY26 | quarter |
| `Quarter ended 30.09.2025`, `Three months ended September 30, 2025` | Q2 FY26 | quarter |
| `H1 FY26`, `1H FY26`, `6M FY26`, `Half year ended September 30, 2025` | H1 FY26 | cumulative |
| `9M FY26`, `Nine months ended 31-12-2025` | 9M FY26 | cumulative |
| `FY26`, `FY2025-26`, `Year ended 31 March 2026` | FY26 | year |
| `Sep-25`, `Sep'25`, `30 September 2025`, `as on 30.09.2025` | Q2 FY26 | as_at (a balance date) |
| `TTM`, `LTM`, `trailing twelve months` | none | trailing |
| `H2 FY26`, `Oct-25` (not a quarter end), `Q3 CY25` | none | unparsed: reported, never guessed |

Indian fiscal year: April to March. `FY26` ends 31 March 2026. Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.

## Growth labels (never the metric)

`YoY`, `Y-o-Y`, `y/y`, `QoQ`, `Q-o-Q`, `q/q`, `CAGR`, and a percentage preceded by `up`, `down`, `growth of`,
`grew by`, `▲`, `▼`, `+`. The extractor sets `is_growth_rate: true` and `growth_basis`.

## Which is stock, which is flow

| Stock (as at quarter end; never derive) | Flow (for the quarter; may be derived from cumulative) | Average over the period (take the quarter's; never derive) |
|---|---|---|
| aum, loan_book, off_book_aum, branches, employees, aum_mix_*, avg_ltv, avg_ticket_size (on book) | disbursements, sell_down_volume, buy_out_volume | yield, cost_of_funds, spread, nim |

## Worked example

`python3 /workspace/scripts/iplib.py --periods "Disbursements Q2 FY26 vs H1 FY26; AUM as on Sep-25; NIM (TTM)"`
returns Q2 FY26 (quarter), H1 FY26 (cumulative), Q2 FY26 (as_at, from the label "Sep-25"), and TTM (trailing).
