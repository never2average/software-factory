---
description: Use when producing the efficiency, return and productivity KPIs (Cost to Income, Opex/Loan Book, Opex/AUM, ROA, ROE, Disbursement per Branch/Employee, Expense per Employee, Employee Cost per Employee), when choosing which profit-and-loss lines make up operating expenses, or when the company publishes its own version of one of these ratios.
---

# Computed ratios

These ten KPIs are ALWAYS computed by the workspace formulas, even when the company publishes its own figure,
because the analysts need a like-for-like series. The formulas are the rulebook's, not the textbook's. Do not
"correct" them.

| KPI | Formula (verbatim) | Note |
|---|---|---|
| Cost to Income % | (Operating Expenses ÷ Net Interest Income) × 100 | on NII, not on total net income |
| Opex / Loan Book % | (Operating Expenses ÷ Loan Book) × 100 | quarter's opex, closing loan book, not annualised |
| Opex / AUM % | (Operating Expenses ÷ AUM) × 100 | quarter's opex, closing AUM, not annualised |
| ROA % | (Quarterly PAT × 4 ÷ AUM) × 100 | on AUM, not on average total assets |
| ROE % | (Quarterly PAT × 4 ÷ Networth) × 100 | closing networth, not average |
| Disbursement per Branch | Disbursement ÷ Number of Branches | ₹ crore per branch |
| Disbursement per Employee | Disbursement ÷ Number of Employees | ₹ crore per employee |
| Expense per Employee | (Operating Expenses + Employee Cost) ÷ Number of Employees | applied as written (open point: may double count) |
| Employee Cost per Employee | Employee Cost ÷ Number of Employees | |
| Spread % (fallback only) | Yield − Cost of Funds | only when not disclosed (`margin-yield-variants`) |

Only ROA and ROE carry "× 4". The efficiency ratios are left un-annualised because the rulebook writes them that
way. All arithmetic happens in the script.

## Inputs you must extract first

| Input | Where | Kind |
|---|---|---|
| `opex` | QR standalone results table: expense lines (see below) | flow, discrete quarter |
| `employee_cost` | QR: "Employee benefits expense" | flow, discrete quarter |
| `nii` | QR: interest income − finance costs (see `references/pnl-lines.md`); or the IP's NII if the QR lines cannot be identified | flow, discrete quarter |
| `pat_quarter` | QR: "Profit for the period / after tax" (standalone; before other comprehensive income) | flow, discrete quarter |
| `aum`, `loan_book`, `networth`, `disbursements`, `branches`, `employees` | the KPI rows you already extracted | |

### Choosing the operating-expense line

The Ind AS results format has no line called "operating expenses". Pick ONE definition per company, record it, and
keep it every quarter:

| Option | Lines added | Use when |
|---|---|---|
| A (default) | employee benefits expense + depreciation and amortisation + other expenses | the company does not publish its own opex figure, or its published opex equals this sum |
| B | the company's own "Operating expenses" / "Opex" figure from the IP | the IP prints it for the quarter and it reconciles to a combination of QR lines; write which lines |
| C | other expenses only (or "other operating expenses") | only if memory says the analysts chose this for the company |

Never include finance costs, impairment on financial instruments (credit cost), fees and commission expense on
borrowings, net loss on fair value changes, or tax. Set `opex_definition` to the lines used and
`opex_includes_employee_cost` to `true` (options A, usually B) or `false` (option C). The Expense-per-Employee
footnote is generated from that flag: with option A the rulebook formula counts employee cost twice, and the
footnote says so. That is the agreed behaviour until the analysts close the open point.

Check `list_memories` for the company's definition before choosing; `remember` it after.

## Procedure

1. Make sure every flow is the three-month figure (`discrete-quarter-from-cumulative`). Set
   `flows_are_discrete_quarter: true` only then. With `false` the calculator refuses every flow-based KPI.
2. Write the inputs file (schema `/workspace/schemas/kpi-inputs.schema.json`). Give each input as an object with
   `value`, `unit`, `document`, `page_or_slide` (and `status` / `footnote` when it is `carried_forward` or
   `needs_review`; a `carried_forward` input also needs `period`, the quarter its value belongs to), so the computed
   rows are cited. A synthetic template:

   ```
   python3 /workspace/scripts/compute_kpis.py --example > /workspace/out/inputs-template.json
   ```

3. Put the company's own published ratios under `published` (`{"roa_pct": 3.4, "cost_to_income_pct": 33.5}`).
4. Run:

   ```
   python3 /workspace/scripts/compute_kpis.py --inputs /workspace/out/inputs-q2fy26.json --rows
   ```

5. Append the emitted `rows` to your batch file unchanged. Each has `source "computed"`, the inputs used, the
   citations of the inputs (`page_or_slide` like `"opex: 3; nii: 3"`), and the footnote.
6. A KPI that comes back `not_found` carries the reason ("missing input: Number of Branches (not provided)"). Keep
   the row: the table shows "not found" and the footnote says why.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26, standalone)

Inputs (₹ crore): AUM 10,000; loan book 8,200; disbursements 1,900; networth 2,400; opex 60 (option A: employee
benefits 36 + depreciation 4 + other expenses 20); employee cost 36; NII 150; PAT 75; branches 200; employees 2,500;
yield 11.4%; cost of funds 8.1%. The IP publishes ROA 3.4% (on average total assets) and cost-to-income 33.5% (on
net total income).

| KPI | Arithmetic | Value |
|---|---|---|
| Cost to Income % | 60 ÷ 150 × 100 | 40.00 |
| Opex / Loan Book % | 60 ÷ 8,200 × 100 | 0.73 |
| Opex / AUM % | 60 ÷ 10,000 × 100 | 0.60 |
| ROA % | 75 × 4 ÷ 10,000 × 100 | 3.00 |
| ROE % | 75 × 4 ÷ 2,400 × 100 | 12.50 |
| Disbursement per Branch | 1,900 ÷ 200 | 9.5000 |
| Disbursement per Employee | 1,900 ÷ 2,500 | 0.7600 |
| Expense per Employee | (60 + 36) ÷ 2,500 | 0.0384 |
| Employee Cost per Employee | 36 ÷ 2,500 | 0.0144 |
| Spread % | 11.4 − 8.1 | 3.30 |

Footnotes the script writes:

- ROA: "Company publishes 3.40%; the workspace formula (Quarterly PAT × 4 ÷ AUM) × 100 gives 3.00%."
- Cost to Income: "Operating expenses = employee benefits expense + depreciation + other expenses. Company publishes
  33.50%; the workspace formula (Operating Expenses ÷ Net Interest Income) × 100 gives 40.00%."
- Expense per Employee: "The rulebook formula adds Employee Cost to Operating Expenses; this filing's operating
  expenses ALREADY include employee cost, so employee cost is counted twice (formula applied as written). ..."

## Failure modes

- **Missing input** → that KPI `not_found` with the reason; the others are still computed.
- **Carried-forward branches or employees** → the productivity KPIs come back `carried_forward` with the input's
  footnote. A `needs_review` input makes the ratio `needs_review`.
- **Zero or negative NII** → Cost to Income `not_found` ("undefined" / "meaningless on a negative base").
- **Loss quarter** → ROA and ROE are negative; that is a valid result.
- **Consolidated inputs** → the whole inputs file is one `basis`. Never mix (see `standalone-vs-consolidated`).
- **Company's figure put in the KPI cell** → `validate_kpis.py` rejects it (`E-SOURCE`): these rows must have
  `source "computed"`.
- **PAT**: use profit after tax for the period, not total comprehensive income; for consolidated, the figure
  attributable to owners if the split is printed (say so).
