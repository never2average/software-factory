# Division III statements: the line items an HFC usually shows

This is the usual shape. It is a guide for recognising rows, not a template to fill. If the report shows a line
that is not here, keep it as printed. If the format itself has changed, follow the document and report the difference.

## Balance sheet

| Block | Usual line items | Normalised label |
|---|---|---|
| **ASSETS - Financial assets** | Cash and cash equivalents | `cash_and_cash_equivalents` |
| | Bank balance other than cash and cash equivalents | `bank_balances_other` |
| | Derivative financial instruments | `derivative_financial_instruments_assets` |
| | Receivables: (i) Trade receivables, (ii) Other receivables | `trade_receivables`, `other_receivables` |
| | **Loans** | **`loan_book`** (the analysts' Loan Book Value: from the balance sheet, net as shown) |
| | Investments | `investments` |
| | Other financial assets | `other_financial_assets` |
| **Non-financial assets** | Current tax assets (net); Deferred tax assets (net); Investment property; Property, plant and equipment; Right-of-use assets; Capital work-in-progress; Intangible assets under development; Goodwill; Other intangible assets; Other non-financial assets; Assets held for sale | `current_tax_assets_net`, `deferred_tax_assets_net`, `investment_property`, `property_plant_and_equipment`, `right_of_use_assets`, `capital_work_in_progress`, `intangible_assets_under_development`, `goodwill`, `other_intangible_assets`, `other_non_financial_assets`, `assets_held_for_sale` |
| | Total assets | `total_assets` |
| **LIABILITIES - Financial liabilities** | Derivative financial instruments | `derivative_financial_instruments_liabilities` |
| | Payables: trade and other, each split into dues of micro and small enterprises and dues of other creditors | `payables_dues_msme`, `payables_dues_other_than_msme` |
| | **Debt securities** | `debt_securities` (borrowings component) |
| | **Borrowings (other than debt securities)** | `borrowings_other_than_debt_securities` (borrowings component) |
| | **Deposits** | `deposits` (borrowings component; deposit-taking HFCs only) |
| | **Subordinated liabilities** | `subordinated_liabilities` (borrowings component) |
| | Lease liabilities; Other financial liabilities | `lease_liabilities`, `other_financial_liabilities` |
| **Non-financial liabilities** | Current tax liabilities (net); Provisions; Deferred tax liabilities (net); Other non-financial liabilities | `current_tax_liabilities_net`, `provisions`, `deferred_tax_liabilities_net`, `other_non_financial_liabilities` |
| **EQUITY** | Equity share capital; Other equity; (consolidated: Non-controlling interest) | `equity_share_capital`, `other_equity`, `non_controlling_interest` |
| | Total equity; Total liabilities and equity | `total_equity`, `total_liabilities_and_equity` |

`borrowings` (derived) = the four components in bold. Securitisation liabilities, where a company shows them, sit
inside "Borrowings (other than debt securities)" or as a separate line: keep the company's presentation.

## Statement of profit and loss

| Block | Usual line items | Normalised label |
|---|---|---|
| Revenue from operations | Interest income; Dividend income; Rental income; Fees and commission income; Net gain on fair value changes; Net gain on derecognition of financial instruments under amortised cost category; Sale of services; Other operating income | `interest_income`, `dividend_income`, `rental_income`, `fees_and_commission_income`, `net_gain_on_fair_value_changes`, `net_gain_on_derecognition_amortised_cost`, `sale_of_services`, `other_operating_income` |
| | Total revenue from operations; Other income; Total income | `total_revenue_from_operations`, `other_income`, `total_income` |
| Expenses | Finance costs; Fees and commission expense; Net loss on fair value changes; Impairment on financial instruments; Employee benefits expenses; Depreciation, amortisation and impairment; Other expenses; Total expenses | `finance_costs`, `fees_and_commission_expense`, `net_loss_on_fair_value_changes`, `impairment_on_financial_instruments`, `employee_benefits_expense`, `depreciation_and_amortisation`, `other_expenses`, `total_expenses` |
| Profit | Profit before exceptional items and tax; Exceptional items; Profit before tax; Current tax; Deferred tax; Tax of earlier years; Profit for the year | `profit_before_exceptional_items_and_tax`, `exceptional_items`, `profit_before_tax`, `current_tax`, `deferred_tax`, `tax_of_earlier_years`, `profit_after_tax` |
| OCI | Items that will not / will be reclassified (remeasurement of defined benefit plans, cash flow hedge reserve, and their tax); Other comprehensive income; Total comprehensive income | `other_comprehensive_income`, `total_comprehensive_income` |
| EPS | Basic; Diluted (Rs. per share: never unit-converted) | `eps_basic`, `eps_diluted` |

"Net gain on derecognition of financial instruments under amortised cost category" is where income from assigned
(sold-down) loans usually appears. It is relevant to the transfer-of-loan-exposures section.

## Cash flow statement

Indirect method. For a lender, loans disbursed and borrowings raised run through **operating** activities in most
reports (some show borrowings under financing). Extract the three sub-totals, the net change, and opening and closing
cash: `net_cash_from_operating_activities`, `net_cash_from_investing_activities`,
`net_cash_from_financing_activities`, `net_increase_in_cash`, `cash_at_beginning`, `cash_at_end`. Other rows are kept
as printed. Note in the extract where the company places borrowings and loans: it differs between companies and
matters when comparing them.

## Statement of changes in equity

Part A: equity share capital (opening, changes, closing). Part B: other equity, a wide table with one column per
reserve: statutory reserve u/s 29C of the NHB Act (`statutory_reserve_29c`), special reserve u/s 36(1)(viii) of the
Income-tax Act (`special_reserve_36_1_viii`), securities premium, general reserve, retained earnings, share options
outstanding, cash flow hedge reserve, debenture redemption reserve, total. Rows: opening balance, profit for the
year, OCI, transfers to reserves (`transfer_to_statutory_reserve`), dividends, share-based payments, closing balance.
It is printed landscape or split across two pages with the reserves continuing as new columns: that is a
**column-wise** split, which `stitch_tables.py` does not handle. Extract each half as its own table and say so.
