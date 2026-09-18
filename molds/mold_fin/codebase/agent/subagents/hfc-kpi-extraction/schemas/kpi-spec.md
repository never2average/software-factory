# KPI extraction rules (as supplied by the operator, 2026-09-18)

This is the analysts' own specification, kept as they wrote it. `../instructions.md` restates it for the agent;
if the two ever disagree, this file is the source and the instructions are the defect.

## Key Definitions

- Sell Down Volume (SD): Loans transferred/assigned (moved off balance sheet).
- Buy Out Volume (BO): Loans acquired (brought onto balance sheet).
- GNPA: Gross Stage 3 (GS3) / Gross NPA.
- NNPA: Net Stage 3 / Net NPA.
- Loan Book Value: To be extracted from the Balance Sheet.
- Yield: Effective Interest Rate on loans.
- Cost of Fund: Average cost of borrowing.
- NIM: Net Interest Margin (derived from Net Interest Income).
- AUM: Assets Under Management (includes On-book + Off-book loans).
- Important: If AUM equals the Loan Book, then no Sell Down Volume is found (as there are no off-book loans).

## Data Extraction Preferences & Sources

Listed Companies:
- Investor Presentation (IP): Used for operational metrics like Branches, Employees, and Disbursements.
- Quarterly Report (QR): Used for financial ratios, asset quality, and capital adequacy.
- Conflict Resolution: If values differ, use the Quarterly Report value (if within a 5% tolerance).

Unlisted Companies:
- 1st Priority: SEBI LODR Filings.
- 2nd Priority: Parent Company's Investor Presentation (e.g., IIFL Home Finance, TATA Capital).

General Rules:
- Use standalone Profit and Loss statements and ratios from LODR when both standalone and consolidated data are provided.
- Precedence is given to Q2, Q3, and Q4 numbers, where H1, 9M, and Annual figures are also mentioned.
- For missing quarter data: Use the most recent available data and include a footnote specifying the period.
- Number of Employees/Branches: If missing for a quarter, use the previous quarter's Investor Presentation value.

## KPI Logic by Category

- Scale Metrics: Extracted from Key Highlights, Balance Sheet, Quarterly Performance section, and Financial Highlights.
- Sell Down & Buy Out: Extracted from the Appendix section of financial reports or disclosure tables.
- Asset Quality: Percentages sourced from Gross/Net NPA and Stage-3 Provision Coverage Ratio (PCR).
- Margin & Yield: Calculated/extracted based on Yield (Effective Interest Rate), Cost of Funds, Spread, and NIM.
- Capital & Leverage: CRAR % and Debt/Equity Ratio (expressed as a decimal, e.g., 3.2x).
- Efficiency Metrics:
  - Cost to Income %: (Operating Expenses ÷ Net Interest Income) × 100
  - Opex/Loan Book %: (Operating Expenses ÷ Loan Book) × 100
  - Opex/AUM %: (Operating Expenses ÷ AUM) × 100
- Return Metrics:
  - ROA %: (Quarterly PAT × 4 ÷ AUM) × 100
  - ROE %: (Quarterly PAT × 4 ÷ Networth) × 100
- Productivity Metrics:
  - Disbursement per Branch: Disbursement ÷ Number of Branches
  - Disbursement per Employee: Disbursement ÷ Number of Employees
  - Expense per Employee: (Operating Expenses + Employee Cost) ÷ Number of Employees
  - Employee Cost per Employee: Employee Cost ÷ Number of Employees

## Additional Notes

- Restructured Book: Exclude these details from the report.
- Unit Conversion: Lakhs (divide by 100), Millions (divide by 10), Billions (multiply by 100), Crores (use as-is).

## Open points (the agent's behaviour until the analysts decide)

- A QR/IP difference of MORE than 5% is not covered above: the agent reports the QR value, shows the IP value in the footnote, and marks the cell `needs_review`.
- "Expense per Employee" adds Employee Cost to Operating Expenses. Where a company's reported operating expenses already include employee cost this counts it twice; the formula is applied as written and the footnote says which definition of operating expenses the filing used.
- **Conflict rule on operational metrics.** "If values differ, use the Quarterly Report value" has no exception for operational metrics. It is applied as written: when disbursements or branches appear in both documents and differ by 5% or less, the QR value is used even though the IP is their named source. The IP is cited when the two agree or the QR lacks the metric.
- **The 5% boundary and base.** "Within 5%" is inclusive (exactly 5.00% is within). The difference is measured relative to the QR value.
- **Unlisted company with both an LODR value and a parent-IP value.** The same 5% / `needs_review` logic is applied. An unlisted company's own presentation is not ranked by the rules above and is not used.
- **Efficiency ratios are not annualised.** Only ROA and ROE carry "× 4". Opex/AUM and Opex/Loan Book use the quarter's operating expenses as written, so they read lower than companies' published annualised figures.
- **Closing balances.** ROA and ROE use closing AUM and closing networth, not averages, as written.
- **"AUM equals Loan Book".**
  - The balance-sheet loans line is net of impairment allowance while AUM is gross, so the two rarely match exactly.
  - The test is an exact match after rounding both to 2 decimal places.
  - An optional tolerance (default 0, capped at 5%) and an optional gross loan book input exist for the analysts to switch on.
- **Loan book in Q1 and Q3.** Quarterly results usually carry no balance sheet in those quarters. The same-quarter IP on-book figure is used, with source IP and a footnote, before falling back to the most recent balance sheet.
- **"Most recent available data".** It is applied to balances and ratios only. Flows (disbursements, sell down, buy out, PAT, operating expenses) are never carried forward and become `not_found`. There is no limit on how far back a carried value may come from; branches and employees older than one quarter are flagged.
- **A stated nil for sell down or buy out.** It is recorded as `not_found` with the company's statement quoted, not as 0.
- **What counts as sell down.**
  - Transfers of stressed loans to ARCs are excluded from the volume and mentioned in the footnote.
  - Securitisation counts only when derecognised.
  - A co-lending partner's share counts only when the company presents it as transferred.
  - The disclosed aggregate is not grossed up for retained share.
- **"Operating Expenses" has no single Ind AS line.**
  - The default is employee benefits + depreciation + other expenses.
  - The alternatives are the company's own IP figure, or other expenses only.
  - The choice made is recorded on the row. Impairment and finance costs are never included.
- **Net Interest Income has no formula above.** It is taken as interest income minus finance costs, excluding assignment income. NIM is taken as disclosed and never computed.
- **Debt/Equity has no formula above.** It is taken as disclosed only. There is no borrowings ÷ networth fallback, so it is `not_found` when the company does not disclose it.
- **Productivity units.** They are reported in Rs crore per branch / per employee to 4 decimal places.
- **Stage 3 % and regulatory GNPA % both printed and different.** The figure labelled GNPA/NNPA in the QR's ratios note is used, and the other goes in the footnote.
- **Sell down and buy out source.** They are taken from the QR's transfer-of-loan-exposures note first and the IP appendix second. AUM is treated as operational (IP preferred).
- **Validator thresholds are the builder's choices.**
  - Loan book may exceed AUM by up to 1%.
  - Out-of-range ratios (for example GNPA above 25%) are flagged, not rejected.
