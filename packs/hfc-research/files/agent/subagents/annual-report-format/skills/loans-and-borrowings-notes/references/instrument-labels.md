# Loans and borrowings: what reports print, and the normalised labels

Normalised labels come from `statement-labels.json` (statements `loans_note` and `borrowings_note`). Anything not
listed is kept as printed.

## Loans note

| Printed | Normalised | Remarks |
|---|---|---|
| Total (A) - Gross; Total gross; Gross loans | `gross_loans` | Appears three times (A, B, C); same value each time |
| Less: Impairment loss allowance; Less: Allowance for expected credit loss | `impairment_loss_allowance` | |
| Total (A) - Net; Net loans | `net_loans` | Equals the balance sheet `loan_book` |
| Secured by tangible assets | `loans_secured_by_tangible_assets` | |
| Unsecured | `loans_unsecured` | |
| Loans in India; Loans outside India | `loans_in_india`, `loans_outside_india` | |
| Housing loans, Home loans, Individual housing loans, Loans against property, Non-housing loans, Construction finance, Developer loans, Lease rental discounting, Top-up loans, Inter-corporate deposits | none: kept as printed, product in `dimension` | Product definitions differ between companies |
| Public sector; Others | none | Sector split inside "Loans in India" |

## Borrowings notes

| Note | Printed | Normalised |
|---|---|---|
| Debt securities | Secured / unsecured redeemable non-convertible debentures | `non_convertible_debentures` |
| | Commercial paper | `commercial_paper` |
| Borrowings (other than debt securities) | Term loans from banks | `term_loans_from_banks` |
| | Refinance from / term loans from National Housing Bank (NHB) | `refinance_from_nhb` |
| | Term loans from financial institutions / other parties | `term_loans_from_financial_institutions` |
| | External commercial borrowings | `external_commercial_borrowings` |
| | Loans repayable on demand; cash credit; bank overdraft; working capital demand loans | `bank_overdraft_cash_credit_wcdl` |
| | Liability against securitised assets; associated liabilities in respect of securitisation | `securitisation_liabilities` |
| Deposits | Public deposits; deposits from public | `public_deposits` |
| | Inter-corporate deposits | `inter_corporate_deposits` |
| Subordinated liabilities | Subordinated / Tier II non-convertible debentures or bonds | `subordinated_debt_instruments` |

## Terms of repayment

Extract as printed. Typical shape per instrument: rows are maturity bands, columns are interest-rate bands, cells are
amounts; or a list of NCD series with ISIN-level coupon, date of allotment, redemption date and amount. For series
lists, extract the table but do not create one data row per series unless asked: report the count, the coupon range
and the redemption-year totals the report itself gives.

Security and covenants worth quoting: the asset-cover sentence for secured NCDs, the charge created for NHB
refinance, negative-lien statements, and any statement that the company has not defaulted in repayment (or has).
