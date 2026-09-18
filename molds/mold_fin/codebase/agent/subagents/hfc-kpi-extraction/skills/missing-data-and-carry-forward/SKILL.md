---
description: Use when a KPI cannot be found for the requested quarter, when the quarter's filing or presentation is missing from the data room, when branches or employees are not published this quarter, when deciding between not_found and carried_forward, or when restructured-book figures show up and must be left out.
---

# Missing data and carry-forward

Rulebook:

- "For missing quarter data: Use the most recent available data and include a footnote specifying the period."
- "Number of Employees/Branches: If missing for a quarter, use the previous quarter's Investor Presentation value."
- "Restructured Book: Exclude these details from the report."

And from the instructions: a value you cannot cite is `not_found`; never estimate; if the FILING for the requested
quarter is not in the data room at all, stop and name it so the orchestrator can have it fetched.

## Decide which case you are in

| Situation | Status | What to write |
|---|---|---|
| The quarter's QR / IP is not in the data room | none: **stop** | reply naming the missing filing(s); `lodr-filings` / `investor-presentations` fetch them. Do not carry a whole quarter forward. |
| The filing is present but is a scanned PDF (`text_layer: scanned`) | none: **stop** | report it as unreadable: `python3 /workspace/scripts/detect_content_type.py <file>` |
| Filing present, metric published for an EARLIER period only (branches, employees; a balance with no balance sheet this quarter) | `carried_forward` | the earlier value, `value_period` = that period, footnote naming the period and document |
| Metric has never been published by the company (checked this and earlier quarters / memory) | `not_found` | value null, footnote where you looked |
| Company states nil ("has not acquired any loans") | `not_found` | value null, footnote quoting the statement |
| Sell down when AUM equals loan book | `not_found` | verdict footnote (`scale-and-aum-vs-loan-book`) |
| Number only readable off a chart | `needs_review` | the reading, `read_from_chart: true`, footnote |
| Flow published only as H1 / 9M / FY | derive | `discrete-quarter-from-cumulative`; if the earlier cumulative is unavailable → `not_found` |
| Ratio published only for H1 / 9M / FY | `needs_review` | value with `value_period` = that period and a footnote |
| Restructured book, OTR, resolution-framework figures | **no row at all** | leave it out of rows, footnotes and the summary |

## What may be carried forward, and from where

| KPI kind | Carry forward? | From |
|---|---|---|
| `branches`, `employees` | yes | the PREVIOUS quarter's investor presentation (rulebook). Get the label with `python3 -c "import sys; sys.path.insert(0,'/workspace/scripts'); from finlib import periods; print(periods.previous_quarter('Q2 FY26'))"` |
| Balances: `aum`, `loan_book`, `networth`, `borrowings` | yes ("most recent available") | the most recent earlier quarter in the data room. First try the same quarter's other source (IP for loan book when the QR has no balance sheet): that is NOT a carry-forward, it is an `ok` row with `source "IP"`. |
| Point-in-time ratios: `gnpa_pct`, `nnpa_pct`, `pcr_stage3_pct`, `crar_pct`, `debt_equity` | yes | most recent earlier quarter |
| Period ratios: `yield_pct`, `cost_of_funds_pct`, `spread_pct`, `nim_pct` | yes | most recent earlier quarter |
| Flows: `disbursements`, `sell_down_volume`, `buy_out_volume`, and the inputs PAT / NII / opex / employee cost | **no** | a previous quarter's flow is not this quarter's flow. `not_found`. (Interpretation of the rulebook: "most recent available data" is applied to stock figures and ratios only. Reported as an ambiguity.) |
| Computed KPIs | never directly | they inherit `carried_forward` from an input via `compute_kpis.py` |

How far back: the rulebook sets no limit. Go back one quarter at a time through the data room; stop at the first
quarter that has the value. If it is more than one quarter old, `validate_kpis.py` flags branches / employees
(`F-CARRY`); say the age in the summary. If nothing within four quarters, write `not_found`.

## Procedure

1. `dataroom_list` both folders; note which quarters exist. Fetch the previous quarter's IP when branches or
   employees are missing.
2. Look the value up in the earlier document the normal way (page, unit, basis). If the earlier quarter is already
   in `kpis.jsonl`, you may reuse that row's value, document and page, but re-cite that document, not `kpis.jsonl`.
3. Write the row:

   ```json
   {"kpi": "branches", "value": 198, "unit": "count", "period": "Q2 FY26", "value_period": "Q1 FY26",
    "source": "IP", "document": "Customers/example-hfl/filings/presentations/q1fy26-ip.pdf", "page_or_slide": "slide 4",
    "status": "carried_forward",
    "footnote": "Branches not published for Q2 FY26; value as of Q1 FY26 from the previous quarter's investor presentation."}
   ```

   The footnote MUST contain the `value_period` text (`Q1 FY26`): the validator checks it.
4. Feed carried-forward inputs to the calculator with their status so the ratios inherit it:

   ```
   python3 /workspace/scripts/compute_kpis.py --inputs /workspace/out/inputs-q2fy26.json --rows
   ```

   with `"branches": {"value": 198, "status": "carried_forward", "period": "Q1 FY26", "footnote": "Not published for Q2 FY26; previous quarter's IP used.", "document": "...", "page_or_slide": "slide 4"}`.
   `period` is required on a carried-forward input (the calculator refuses without it, and refuses a carried-forward
   flow). The computed rows come back `carried_forward` with `value_period` set and "(as of Q1 FY26)" in the footnote.
5. Every KPI in the catalog gets a row, found or not, so the table has no silent gaps:
   `python3 /workspace/scripts/validate_kpis.py <batch.jsonl> --expect-complete` lists the KPIs with no row.

## Worked example (synthetic: Example Housing Finance Ltd, Q3 FY26)

The Q3 deck has no distribution slide. The Q3 results (nine-month period) carry no balance sheet. The Q3 deck shows
"Loan book ₹84.1 bn" and "Net worth ₹24.9 bn".

| KPI | Row |
|---|---|
| `branches` | 205, `carried_forward`, `value_period "Q2 FY26"`, source IP (Q2 deck, slide 4), footnote "Branches not published for Q3 FY26; value as of Q2 FY26 from the previous quarter's investor presentation." |
| `employees` | same pattern |
| `loan_book` | 8410.00, `ok`, source IP (Q3 deck, slide 5), footnote "No balance sheet in the Q3 FY26 results; on-book loans from the investor presentation." |
| `networth` | 2490.00, `ok`, source IP, similar footnote |
| `disbursement_per_branch` | computed on 205 branches → `carried_forward`, footnote inherited |
| `buy_out_volume` | `not_found`, footnote "No loans acquired disclosed in the QR notes (pp. 6–8) or the IP appendix." |
| a slide titled "Restructured book (OTR 2.0): ₹118 crore" | no row, no mention |

## Restructured book: what to leave out

`python3 /workspace/scripts/kpi_catalog.py --match "<label>"` returns `excluded_restructured` for labels matching
the patterns in `references/absence-and-exclusion-patterns.md`. `validate_kpis.py` rejects any row whose `kpi`,
`label` or `definition` matches (`E-RESTRUCT`) and flags a footnote that mentions restructuring (`F-FOOTNOTE`).
Stage 3 or GNPA figures that happen to include restructured accounts are reported as printed, without comment on
the restructured part.

## Failure modes

- **Carrying forward silently.** A carried value with status `ok` is the worst error in this table. The schema
  requires `value_period` and a footnote for `carried_forward`.
- **Carrying a flow forward.** Never.
- **Using the annual report** for branches / employees: allowed only as "most recent available" when no IP in the
  data room has it; cite it, and expect the `F-CARRY` flag.
- **Guessing from growth** ("branches were 198, the company said it added about 10") is an estimate: not allowed.
