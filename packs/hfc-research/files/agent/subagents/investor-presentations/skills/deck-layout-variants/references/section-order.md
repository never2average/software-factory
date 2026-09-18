# Typical section order of an HFC investor presentation

The order varies; the building blocks rarely do. Section keys are the ones `slide_index.py` emits.

| # | Section key | Typical slide titles | What the analysts take from it |
|---|---|---|---|
| 0 | `cover` | Investor Presentation, Earnings Update, Q2 FY26 | The period. Nothing else |
| 1 | `disclaimer` | Disclaimer, Safe Harbour | Nothing |
| 2 | `company_overview` | At a glance, Our journey, Shareholding, Credit ratings | Sometimes branches/employees in an "at a glance" strip (cite only if no better slide) |
| 3 | `highlights` | Key Highlights, Performance Snapshot, Quarter at a glance | AUM, disbursements, branches, employees as headline tiles. Often rounded; often mixed with YoY growth |
| 4 | `aum_disbursements` | AUM trend, Disbursement trend, Business momentum | **Disbursements for the quarter**, AUM, on-book / off-book split. Usually a bar chart over 5 quarters, sometimes with H1/9M next to it |
| 5 | `product_customer_mix` | Product mix, Customer profile, Portfolio composition | AUM mix by product; salaried vs self-employed; ticket size; LTV |
| 6 | `network` | Branch network, Geographic presence, Distribution | **Branches** (vs locations, touchpoints, districts, states) and often **employees** |
| 7 | `asset_quality` | Asset quality, Stage-wise assets, Collection efficiency | Not yours: GNPA/NNPA come from the quarterly results (`hfc-kpi-extraction`). Skip restructured lines |
| 8 | `ecl_provisions` | ECL provisions, Provision coverage | Not yours |
| 9 | `borrowings_alm` | Borrowing profile, Liability mix, ALM, Liquidity | Direct assignment / co-lending volumes sometimes appear here rather than in the appendix |
| 10 | `margins_spreads` | Yield, cost of funds and spread; NIM | The company's **own** yield, cost of funds, spread, NIM as presented |
| 11 | `financials` | P&L summary, Balance sheet summary, Key ratios | Cross-check only. The results are the source for financials |
| 12 | `capital` | Capital adequacy, Net worth | Not yours |
| 13 | `esg` | ESG, Sustainability, CSR | Employees sometimes reported here (with diversity data) |
| 14 | `technology` | Digital, Technology | Nothing |
| 15 | `restructured_book` | Restructured book, OTR, Resolution framework | **Excluded by the rulebook. Extract nothing** |
| 16 | `appendix` | Appendix, Annexure, Additional information | **Sell down and buy out**; detailed tables; definitions |
| 17 | `glossary` | Glossary, Definitions, Basis of computation | The company's metric definitions (`metric-definitions-glossary`) |
| 18 | `closing` | Thank you, Contact | Nothing |

## Metric to section map

| Metric key | Look first in | Then in |
|---|---|---|
| `branches`, `employees` | `network` | `highlights`, `company_overview`, `esg` |
| `disbursements` | `aum_disbursements` | `highlights` |
| `aum`, `loan_book`, `off_book_aum` | `aum_disbursements` | `highlights`, `financials` |
| `aum_mix_*`, `avg_ticket_size`, `avg_ltv` | `product_customer_mix` | `aum_disbursements` |
| `sell_down_volume`, `buy_out_volume` | `appendix` | `borrowings_alm`, `aum_disbursements` |
| `yield`, `cost_of_funds`, `spread`, `nim` | `margins_spreads` | `highlights` |

## PDF versus PPTX

| | PDF export | Native PPTX |
|---|---|---|
| Slide number | PDF page number (covering letter pages count) | Presentation order |
| Title | Largest text in the top 40% of the page; first real line as fallback | Title placeholder; largest text as fallback |
| Tables | Text in reading order; columns usually survive | Cell by cell, reliable |
| Charts | Data labels and axis ticks come out as loose numbers | No text unless data labels are on; the script writes `[chart]` |
| Hidden slides | Not exported | Present in the file. If a slide looks like a draft or duplicate, say so; do not extract from a slide the company did not publish as PDF when both exist |
