# Label synonyms and traps

The machine-readable table is `metric-synonyms.json` in this folder. It is a mirror of
`/workspace/references/metric-synonyms.json`, which the scripts read; `iplib.py --self-test` fails if the two
differ. To see the keys: `python3 /workspace/scripts/find_metric_slides.py --list-metrics`.

## Branches

| Label on the slide | `basis` | Is it the branch count? |
|---|---|---|
| Branches, Branch offices, Branch network: N, No. of branches | `branches` | Yes |
| Locations, Cities, Towns | `locations` | No. Several branches can share a city; one branch can serve several |
| Touchpoints, Points of presence, Service centres, Spokes, Satellite offices, Digital branches, Sourcing points | `touchpoints` | No. Includes non-branch outlets |
| Districts | `districts` | No |
| States, States and UTs | `states` | No |
| "Offices", "Distribution network" | read the footnote | Only if the footnote equates it with branches; otherwise `touchpoints` |

Trap phrases the scripts blank out before matching: "per branch", "branch manager", "bank branches" (a
co-lending partner's branches are not the company's).

## Employees

| Label | `basis` |
|---|---|
| On-roll employees, Employees on rolls, Permanent employees | `on_roll` |
| Off-roll, Contractual, Outsourced, DSAs | `off_roll` (not an employee count for the ratios) |
| Total workforce, Total headcount, "including off-roll" | `total` |
| Employees, Team strength, Headcount, Manpower, People strength (nothing more said) | `unspecified` |

Trap phrases: "employee cost", "employee benefit expenses", "per employee", "ESOP".

## Disbursements

| Label | Use? |
|---|---|
| Disbursements, Disbursals, Loans disbursed, Fresh disbursements, Gross disbursements | Yes |
| Sanctions, Logins, Approvals | No. Earlier stages of the funnel |
| Disbursement per branch / per employee | No. A ratio `hfc-kpi-extraction` computes itself |
| "Business volume" | Only if the footnote says it means disbursements |
| Co-lending disbursements | A part of disbursements, and an input to sell down. See `sell-down-and-buy-out-in-appendix` |

## Quarter versus year to date

| Label | Period basis |
|---|---|
| "Q2 FY26", "for the quarter", "quarter ended 30 September 2025" | quarter (take this) |
| "H1 FY26", "6M", "half year", "YTD" | ytd (do not take, unless nothing else; see `mixed-periods-on-a-slide`) |
| "9M FY26" | ytd |
| "FY26", "full year" | full_year |
| "TTM", "LTM" | trailing (never a quarter; never derive a quarter from it) |

## Worked example

Slide text: `215 branches across 14 states | 480 touchpoints | 3,410 employees | Disbursement per branch ₹ 4.9 Cr`

`python3 /workspace/scripts/extract_labelled_numbers.py --text-file slide.txt` returns 215 with label
"branches across" (metric `branches`), 14 "states" and 480 "touchpoints" (counts, with
`basis_candidates: {"branches": ["states"]}` and `["touchpoints"]`), 3,410 "employees". The 4.9 comes back
labelled "Disbursement per branch" with no metric candidate, because the synonym table excludes that phrase
from `disbursements`. You write `branches = 215 (basis branches)` and `employees = 3410 (basis unspecified)`.
