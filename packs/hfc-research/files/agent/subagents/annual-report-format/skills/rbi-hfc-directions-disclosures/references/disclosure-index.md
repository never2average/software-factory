# The disclosure block: what reports usually carry

A guide to recognising sub-tables. Names and numbering differ by year and by company; the report in front of you
decides. `normalised_label` values here are this subagent's convention for `annual-report-data.jsonl`.

| Index item | Sub-heading wording | What to extract | normalised_label (unit) |
|---|---|---|---|
| Capital | Capital; Capital to risk assets ratio (CRAR) | CRAR, Tier I, Tier II; subordinated debt and perpetual debt raised | `crar`, `crar_tier_1`, `crar_tier_2` (percent) |
| Reserve fund | Reserve fund u/s 29C of the NHB Act, 1987 | Opening balance split between s.29C statutory reserve and s.36(1)(viii) special reserve; additions; appropriations; closing | `statutory_reserve_29c`, `special_reserve_36_1_viii` (crore), `dimension` opening / addition / closing |
| Investments | Investments | Gross value in and outside India, provisions for depreciation, net; movement of provisions | kept as printed |
| Derivatives | Forward rate agreements / interest rate swaps; exchange-traded derivatives; risk exposure | Notional principal, fair value, hedging sentence (relevant with ECB) | kept as printed |
| Securitisation / assignment | Securitisation; assignment transactions; sales to ARCs; NPAs purchased / sold | See the transfer-of-loan-exposures skill | |
| ALM | Asset liability management; Maturity pattern of certain items of assets and liabilities | Full bucket table, both years | `alm_advances`, `alm_investments`, `alm_deposits`, `alm_bank_borrowings`, `alm_market_borrowings`, `alm_fc_assets`, `alm_fc_liabilities` (crore), `dimension` = bucket as printed |
| Exposure to real estate sector | Exposure to real estate sector | Direct: residential mortgages (and of which individual housing loans up to the stated ticket size), commercial real estate, investments in MBS; indirect exposure | `re_exposure_residential_mortgages`, `re_exposure_commercial_real_estate`, `re_exposure_indirect` (crore) |
| Exposure to capital market | Exposure to capital market | Line items and total | `capital_market_exposure_total` (crore) |
| Other exposure items | Financing of parent company products; single / group borrower limits exceeded; unsecured advances; exposure to group companies engaged in real estate | Quote the statement, usually nil | |
| Provisions and contingencies | Provisions and contingencies; break-up of loans and advances and provisions thereon | Provisions by head; standard / sub-standard / doubtful / loss assets, housing and non-housing, with provisions | kept as printed |
| Draw down from reserves | | Quote | |
| Concentration | Concentration of public deposits; of loans and advances; of all exposures; of NPAs | Totals for the twenty largest and their percentage; top NPA accounts' exposure | `top20_advances_pct`, `top20_exposure_pct` (percent), `top_npa_exposure` (crore) |
| Sector-wise NPAs | Sector-wise NPAs | % of NPAs to total advances in each sector: housing loans individuals, builders / projects, corporates, others; non-housing likewise | kept as printed with `dimension` = sector |
| Movement of NPAs | Movement of NPAs | Net NPA to net advances %; movement of gross NPAs, of net NPAs, of provisions: opening, additions, reductions, closing | `gnpa_opening`, `gnpa_additions`, `gnpa_reductions`, `gnpa_closing`, `nnpa_closing` (crore), `nnpa_to_net_advances_pct` (percent) |
| Overseas assets; off-balance-sheet SPVs | | Usually nil; quote | |
| Customer complaints | Disclosure of complaints; Customer complaints | Pending at the beginning, received, redressed, pending at the end; newer reports add grounds of complaint and ombudsman-referred cases | `complaints_opening`, `complaints_received`, `complaints_redressed`, `complaints_pending` (count) |
| Principal business criteria | Principal business criteria | The two percentages | `principal_business_housing_pct`, `principal_business_individual_housing_pct` (percent) |
| Liquidity | Liquidity coverage ratio; public disclosure on liquidity risk | LCR by quarter where given; top lenders; funding concentration | `lcr_pct` (percent), `dimension` = quarter |
| Ind AS 109 vs prudential norms | Comparison of provisions under Ind AS 109 and IRACP norms | Asset classification x stage: gross, ECL, net, regulatory provision, difference. Cross-check for the staging skill | |
| Penalties, ratings, auditor remuneration, frauds | Miscellaneous | Penalties imposed by regulators: quote in full. Ratings table. Frauds reported: count and amount | kept as printed |
| Restructuring / resolution framework | | **Left out** per the analysts' rule; note the pages | |

## Gross NPA versus Stage 3

The analysts treat GNPA as gross Stage 3 and NNPA as net Stage 3. The movement-of-NPAs table is on the regulatory
(asset classification) basis, the staging table on the Ind AS basis; the two normally agree at year end but need not.
Report each from its own table with its own label. Never substitute one for the other silently.
