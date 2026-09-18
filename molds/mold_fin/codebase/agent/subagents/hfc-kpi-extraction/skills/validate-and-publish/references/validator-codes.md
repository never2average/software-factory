# validate_kpis.py: codes, meaning, what to do

`python3 /workspace/scripts/validate_kpis.py <kpis.jsonl> [--expect-complete] [--existing <file>] [--loan-book-tolerance-pct 1]`

Output: `{"valid", "rows", "companies", "periods", "by_status", "errors": [{code, line, message}], "flags": [...],
"review_cells": [...]}`. Exit 1 when `errors` is not empty.

## Errors (block writing)

| Code | Meaning | Usual cause | What to do |
|---|---|---|---|
| `E-SCHEMA` | row does not match `kpi-row.schema.json` | missing `document` / `page_or_slide` on a value row; empty footnote on `needs_review` / `carried_forward` / consolidated / derived row; `value_period` missing on `carried_forward`; `not_found` with a value; a chart reading not marked `needs_review`; unknown field or KPI key; bad `extracted_at` | complete the row from the source; a value you cannot cite becomes `not_found` |
| `E-CATALOG` | category or unit differs from the catalog | amount left in lakhs with a made-up unit; `%` on an amount | convert with `convert_units.py`; use the catalog's unit |
| `E-PERIOD` | `period` is not `Qn FYyy`; `value_period` unreadable | `Q2FY26`, `H1 FY26` as a period | write the canonical label (`finlib.periods.normalise`) |
| `E-CARRY` | carried-forward period not earlier, or footnote does not contain the `value_period` text | | fix the footnote / period |
| `E-COUNT` | branches / employees not a non-negative whole number | "1.2k" typed as 1.2 | re-read the slide |
| `E-BOUNDS` | impossible value (negative amount; % outside hard bounds) | sign or unit slip | re-read the page |
| `E-NNPA` | NNPA % > GNPA % | misread row, or GNPA on AUM vs NNPA on loan book | re-read; if the filing really says so, report and do not write |
| `E-LOANBOOK` | loan book > AUM by more than 1% | consolidated vs standalone, lakhs vs crore, different dates | re-read; report if real |
| `E-SELLDOWN` | sell down reported although AUM = loan book | one of the three is wrong | re-read; report if real |
| `E-RESTRUCT` | restructured-book content in `kpi` / `label` / `definition` | | delete that row (it should never have been created) |
| `E-SOURCE` | a computed KPI not marked `computed` (company's own ratio used), or a disclosed KPI marked `computed` | | use `compute_kpis.py` rows; put the company's figure in `company_published` |
| `E-ARITH` | computed spread / disbursement per branch / per employee does not follow from the rows | rows edited after computing | recompute with `compute_kpis.py` |
| `E-DUP` | same cell twice with the same `extracted_at` | batch assembled twice | remove the duplicate line |

## Flags (reported, do not block)

| Code | Meaning |
|---|---|
| `F-RANGE` | a ratio outside its usual range (GNPA > 25%, PCR outside 5–90%, yield outside 6–30%, cost of funds outside 4–16%, spread outside 0–15%, NIM outside 1–20%, CRAR outside 12–100%, D/E outside 0.2–15x, cost-to-income outside 5–150%, opex ratios outside 0.05–5%, ROA outside −5–10%, ROE outside −30–40%), or a percentage that looks like a fraction |
| `F-DUP` | cell already extracted earlier (re-extraction); the workbook uses the latest |
| `F-FOOTNOTE` | `not_found` with no footnote; or a footnote mentioning restructuring |
| `F-MISSING` | (`--expect-complete`) catalog KPIs with no row for the company-quarter |
| `F-DERIVED` | `derived_from_cumulative` set on a KPI that is not a flow |
| `F-BASIS` | standalone and consolidated rows mixed in one company-quarter |
| `F-CARRY` | branches / employees carried forward from further back than the previous quarter, or not from an IP |

Every flag is repeated in the summary with one line of explanation. A flag you have checked against the filing is
reported as "checked: the filing prints this".
