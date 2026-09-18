# Line item synonym table

Documents `/workspace/scripts/reference/results_line_synonyms.json`, which `extract_results_lines.py` reads (dump it with
`python3 /workspace/scripts/extract_results_lines.py --print-table`). The JSON is the source.

Matching: the serial number (`1`, `(a)`, `ii)`) is stripped, whitespace collapsed, then regexes are tried **in this order**
and the first hit wins, which is why the narrower label (`profit before exceptional items and tax`) sits above the wider one
(`profit before tax`). `exclude` vetoes a hit. `context` is tried on `<last header row> > <label>` for rows whose own label is
too short to identify (`Basic`, `Current tax`, `Others`). A row that matches nothing is reported under `unmatched_rows`.

| # | Item | Group | Label regex | Exclude | Context regex |
|---|---|---|---|---|---|
| 1 | `interest_income` | revenue | `^interest income\|^interest earned\|^income from (interest\|lending)\|^interest on (loans\|housing)` |  |  |
| 2 | `dividend_income` | revenue | `^dividend income` |  |  |
| 3 | `rental_income` | revenue | `^rental income` |  |  |
| 4 | `fees_and_commission_income` | revenue | `^fees? (and\|&) commission income\|^fee income\|^fees and other charges\|^commission income\|^fees,? commission` |  |  |
| 5 | `net_gain_on_fair_value_changes` | revenue | `^net gain on fair value changes?\|^net gains? on (financial instruments\|investments).{0,40}fair value\|^gain on fair value` |  |  |
| 6 | `net_gain_on_derecognition` | revenue | `^net gain on de-?recognition\|^gain on de-?recognition\|^net gain on (assignment\|direct assignment\|securiti[sz]ation\|transfer of loans)\|^income (from\|on) (direct )?assignment\|^(gain\|income) on (assigned\|derecognised) loans` |  |  |
| 7 | `sale_of_services` | revenue | `^sale of services\|^income from services` |  |  |
| 8 | `other_operating_income` | revenue | `^other operating (income\|revenue)\|^other revenue from operations` |  | `revenue from operations.{0,20}> .{0,8}others?$` |
| 9 | `total_revenue_from_operations` | total | `^total revenue from operations\|^revenue from operations\s*\(?total\|^total (operating )?income from operations\|^total income from operations` |  |  |
| 10 | `other_income` | revenue_other | `^other income` |  |  |
| 11 | `total_income` | total | `^total income\|^total revenue$\|^total revenue \(\|^income total` |  |  |
| 12 | `net_interest_income` | memo | `^net interest income\|^\bnii\b` |  |  |
| 13 | `finance_costs` | expense | `^finance costs?\|^interest (and\|&) (other )?(finance )?charges\|^interest expen(se\|ses\|diture)\|^interest and finance` |  |  |
| 14 | `fees_and_commission_expense` | expense | `^fees? (and\|&) commission expen` |  |  |
| 15 | `net_loss_on_fair_value_changes` | expense | `^net loss on fair value changes?\|^loss on fair value` |  |  |
| 16 | `net_loss_on_derecognition` | expense | `^net loss on de-?recognition\|^loss on de-?recognition` |  |  |
| 17 | `impairment_on_financial_instruments` | expense | `^impairment (on\|of) financial (instruments\|assets)\|^impairment (loss(es)? )?(on\|of) (loans\|financial)\|^(expected )?credit loss(es)?( expense)?$\|^provisions? (for\|and) (contingencies\|expected credit\|write[- ]?offs?)\|^(loan losses\|credit costs?)( and provisions)?$\|^bad debts (written off )?and provisions\|^net loss on de-?recognition.{0,40}impairment` |  |  |
| 18 | `employee_benefits_expense` | expense | `^employee benefits? expen\|^employees? (cost\|benefit)\|^staff (cost\|expenses)\|^personnel expenses` |  |  |
| 19 | `depreciation_amortisation` | expense | `^depreciation\|^amorti[sz]ation` |  |  |
| 20 | `other_expenses` | expense | `^other expen(se\|ses\|diture)\|^administrative (and\|&) other expenses\|^operating and other expenses\|^establishment (and\|&) other expenses` |  |  |
| 21 | `total_expenses` | total | `^total expen(se\|ses\|diture)\|^expenses total` |  |  |
| 22 | `profit_before_exceptional_items_and_tax` | profit | `^profit\s*/?\s*\(?(loss)?\)?\s*before exceptional\|^profit before exceptional` |  |  |
| 23 | `exceptional_items` | profit | `^exceptional items?` |  |  |
| 24 | `share_of_profit_of_associates` | profit | `^share (of\|in) (net )?(profit\|loss\|profit\s*/\s*\(?loss\)?) (of\|from\|in) (associates?\|joint ventures?)` |  |  |
| 25 | `profit_before_tax` | profit | `^profit\s*/?\s*\(?(loss)?\)?\s*before tax\|^profit before tax\|^(net )?profit.{0,20}before tax\|^\bpbt\b` |  |  |
| 26 | `current_tax` | tax | `^current tax\|^provision for (current )?tax` |  | `tax expense.{0,30}> (\(?[a-z0-9]{1,3}\)?[.)]?\s*)?current` |
| 27 | `deferred_tax` | tax | `^deferred tax` |  | `tax expense.{0,30}> (\(?[a-z0-9]{1,3}\)?[.)]?\s*)?deferred` |
| 28 | `tax_earlier_years` | tax | `^(tax\|short\|excess).{0,40}(earlier\|prior\|previous) (years?\|periods?)\|^(earlier\|prior) (years?\|periods?) tax` |  |  |
| 29 | `total_tax_expense` | tax_total | `^total tax expen\|^tax expen(se\|ses)\s*(\(total\)\|total)?$\|^tax expen(se\|ses)\s*\(\|^provision for taxation$\|^income tax expense$` |  |  |
| 30 | `profit_after_tax` | profit | `^(net )?profit\s*/?\s*\(?(loss)?\)?\s*(for the (period\|quarter\|year)(\s*/\s*year)?\|after tax)\|^(net )?profit (for the (period\|quarter\|year)\|after tax)\|^profit.{0,20}after tax\|^\bpat\b` | `attributable\|non-?controlling\|owners of\|before` |  |
| 31 | `pat_attributable_to_owners` | profit | `^(net )?profit.{0,40}attributable to.{0,20}(owners\|equity holders\|shareholders)\|^owners of the (company\|parent)` |  | `profit.{0,40}attributable.{0,40}> .{0,8}(owners\|equity holders\|shareholders)` |
| 32 | `pat_attributable_to_nci` | profit | `^(net )?profit.{0,40}attributable to.{0,20}non-?controlling\|^non-?controlling interests?` |  | `profit.{0,40}attributable.{0,40}> .{0,8}non-?controlling` |
| 33 | `other_comprehensive_income` | oci | `^(total )?other comprehensive (income\|loss)\|^other comprehensive income\s*/?\s*\(?loss` |  |  |
| 34 | `total_comprehensive_income` | oci | `^total comprehensive (income\|loss)` | `attributable` |  |
| 35 | `paid_up_equity_share_capital` | capital | `^paid[- ]?up (equity )?(share )?capital\|^equity share capital` |  |  |
| 36 | `other_equity` | capital | `^other equity\|^reserves? (and surplus )?(excluding\|\(excluding) revaluation` |  |  |
| 37 | `eps_basic_and_diluted` (per share, not converted) | eps | `basic (and\|&\|/) diluted` |  | `(earnings? per\|\beps\b).{0,80}> .{0,8}basic (and\|&\|/) diluted` |
| 38 | `eps_basic` (per share, not converted) | eps | `^basic (eps\|earnings? per)\|^(eps\|earnings? per (equity )?share).{0,40}basic(?!.{0,15}diluted)\|^basic\s*\(?(₹\|rs\|in)\|^basic$` |  | `(earnings? per\|\beps\b).{0,80}> .{0,8}basic(?!.{0,15}diluted)` |
| 39 | `eps_diluted` (per share, not converted) | eps | `^diluted (eps\|earnings? per)\|^(eps\|earnings? per (equity )?share).{0,40}(?<!and )(?<!& )diluted\|^diluted\s*\(?(₹\|rs\|in)\|^diluted$` | `^basic` | `(earnings? per\|\beps\b).{0,80}> .{0,8}diluted` |

## Excluded labels

Any row whose label matches `restructur` is dropped and listed under `excluded_rows`: the analysts exclude restructured-book details.

## Footing identities (checked by `validate_results_extract.py`, per column, Rs crore)

Tolerance: the larger of 0.05 crore and 0.5% of the reported total.

| Identity | Level |
|---|---|
| `total_revenue_from_operations` + `other_income` = `total_income` | error |
| `total_income` - `total_expenses` = `profit_before_exceptional_items_and_tax` if present, else `profit_before_tax` (skipped when exceptional items or a share of associates' profit sits in between) | error |
| `profit_before_tax` - `total_tax_expense` = `profit_after_tax` | error |
| sum of `finance_costs`, `fees_and_commission_expense`, `net_loss_on_fair_value_changes`, `net_loss_on_derecognition`, `impairment_on_financial_instruments`, `employee_benefits_expense`, `depreciation_amortisation`, `other_expenses` = `total_expenses` (needs at least three components) | warning: an unmatched expense row explains a shortfall |

## Vocabulary notes

- `net_gain_on_derecognition` is where income on direct assignment / securitisation (sell down) appears. Some companies show it inside
  other operating income or as "income on assigned loans"; the label as printed is kept in `label_reported`.
- `impairment_on_financial_instruments` can be negative (a release). Brackets are read as negative.
- `net_interest_income` is extracted only when the filing prints such a row. It is never computed here.
- `profit_after_tax` on a consolidated statement is the total for the period; the owners / non-controlling split are separate items.
- EPS rows are rupees per share: not converted to crore, flagged `per_share`.
