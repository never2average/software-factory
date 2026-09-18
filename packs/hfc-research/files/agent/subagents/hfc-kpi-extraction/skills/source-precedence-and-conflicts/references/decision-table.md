# Decision table implemented by reconcile_sources.py

`python3 /workspace/scripts/reconcile_sources.py --request <file>` — request schema:
`/workspace/schemas/reconcile-request.schema.json`.

## Which source is preferred, per KPI

| KPI key | Nature | Preferred source (listed) | In practice |
|---|---|---|---|
| `branches`, `employees` | operational | IP | almost never in the QR |
| `disbursements` | operational | IP | sometimes in the QR's notes or press release |
| `aum` | operational | IP | the QR's balance sheet has the loan book, not AUM |
| `loan_book`, `networth`, `borrowings` | financial | QR (balance sheet) | IP repeats them, often rounded |
| `sell_down_volume`, `buy_out_volume` | financial | QR (disclosure note) | IP appendix is the fallback |
| `gnpa_pct`, `nnpa_pct`, `pcr_stage3_pct` | financial | QR | IP repeats them, sometimes on a different base |
| `yield_pct`, `cost_of_funds_pct`, `spread_pct`, `nim_pct` | financial | QR | usually only the IP prints them; then the IP is the source and a `note` says so |
| `crar_pct`, `debt_equity` | financial | QR | QR ratios disclosure; IP repeats |
| efficiency, return, productivity KPIs | computed | never reconciled | the company's own figure goes to the footnote via `compute_kpis.py` |

For an unlisted company the preferred source is always the company's own LODR filing (`qr`); the second is `parent_ip`.

## Outcome by case

| # | QR usable | IP / parent IP usable | Comparison | value | source | status | footnote |
|---|---|---|---|---|---|---|---|
| 1 | yes | no | n/a | QR | `QR` | `ok` | empty; `note` if the KPI is operational |
| 2 | no | yes (listed) | n/a | IP | `IP` | `ok` | empty; `note` if the KPI is financial |
| 3 | no | yes (unlisted) | n/a | parent IP | `parent IP` | `ok` | "Not disclosed in the company's LODR filing; taken from the parent company's investor presentation (path)." |
| 4 | yes | yes | equal after rounding to the KPI's decimals | preferred source's value | preferred | `ok` | empty |
| 5 | yes | yes | differ, `pct_diff` ≤ 5 | QR | `QR` | `ok` | "QR x vs IP y (d% apart, within the 5% tolerance): QR value used." |
| 6 | yes | yes | differ, `pct_diff` > 5 | QR | `QR` | `needs_review` | both values, IP document and slide, "needs analyst review" |
| 7 | yes (zero) | yes (non-zero) | % undefined | QR | `QR` | `needs_review` | says a % cannot be computed on a zero base |
| 8 | no | no | n/a | null | null | `not_found` | where it was looked for |

"Usable" means: the value parses as a number, an amount has a unit (or a header naming exactly one unit), a count is a
whole number, and the candidate's `period` (when given) is the requested quarter. Anything else is listed under
`ignored` with the reason and takes no part in the decision.

`pct_diff = |QR − other| ÷ |QR| × 100`, computed after converting amounts to ₹ crore, rounded to 2 decimals in the
output. Exactly 5.00% is within tolerance.

## Boundary cases (all in `--self-test`)

| QR | IP | pct_diff | status |
|---|---|---|---|
| 1,000 | 1,050 | 5.00 | `ok` |
| 1,000 | 1,050.1 | 5.01 | `needs_review` |
| 1,000 | 940 | 6.00 | `needs_review` |
| 1,88,000 lakh | 1,900 crore | 1.06 | `ok` |
| 1,900 crore | 19.0 bn | 0.00 | `ok`, IP cited (operational, equal) |
