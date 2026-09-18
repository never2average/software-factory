# Shareholding pattern: label map

## Public sub-categories -> `public_breakdown.group`

| Printed sub-category (variants) | group |
|---|---|
| Mutual Funds; Mutual Funds / UTI | `mutual_funds` |
| Alternate / Alternative Investment Funds; Venture Capital Funds | `alternative_investment_funds` |
| Foreign Portfolio Investors (Category I, Category II; older: FIIs, Foreign Portfolio Investors (Corporate)) | `foreign_portfolio_investors` (add the categories together only when the filing prints a sub-total; otherwise one row per printed line is not allowed, so use the printed "Institutions (Foreign)" sub-total and say so in `label_reported`) |
| Insurance Companies | `insurance_companies` |
| Banks; Financial Institutions / Banks | `banks_and_financial_institutions` |
| Provident Funds / Pension Funds | `provident_and_pension_funds` |
| NBFCs registered with RBI | `nbfcs` |
| Sovereign Wealth Funds; Foreign Direct Investment; Other Financial Institutions; Asset Reconstruction Companies; any other institutional line | `other_institutions` |
| Central Government / State Government(s) / President of India | `government` |
| Resident Individuals holding nominal share capital up to Rs 2 lakhs / in excess of Rs 2 lakhs; Individuals | `resident_individuals` (one row; use the printed sub-total of individuals, or leave the group out if no sub-total is printed) |
| Non Resident Indians (NRIs) | `non_resident_indians` |
| Bodies Corporate | `bodies_corporate` |
| Key Managerial Personnel, Directors and relatives, Trusts, HUF, Clearing Members, IEPF, Foreign Nationals, Foreign Companies, LLP, "Any Other (specify)" | `others` (may repeat, each with its printed label) |

Each group except `others` may appear once. The validator warns (not errors) when the breakdown covers less than
the public category, because a partial breakdown is legitimate; it errors when it covers more.

## Pledge / encumbrance vocabulary

"Number of shares pledged or otherwise encumbered", "Shares pledged", "Encumbered shares", "Non-disposal
undertaking (NDU)", "Lien". Newer formats split the column into pledged, NDU and other encumbrances with a total:
take the **total encumbered** figure into `pledged_or_encumbered_shares` and put the split in the reply with the page.

## Fields and where they come from

| Field | Source |
|---|---|
| `as_on` | "Shareholding pattern as on" / "Quarter ended" on page 1 (ISO date) |
| `period` | the fiscal quarter of `as_on` (April-March) |
| `total_shares` | "Total" row, total number of shares held (not the demat column, not voting rights) |
| `categories.*.holders` | "Nos. of shareholders" (may be PAN-consolidated; copy as printed) |
| `categories.*.pct` | "Shareholding as a % of total no. of shares" (not the "assuming full conversion" column) |
| `promoter_encumbrance.pct_of_promoter_holding` | the "As a % of total shares held" sub-column of the pledge column, promoter row |
| `promoter_encumbrance.pct_of_total_shares` | only when printed, or leave null |
| `significant_holders` | promoter table entities; public holders listed by name (1% and above) |

If the company has convertibles outstanding, the diluted ("assuming full conversion") percentages differ from the
basic ones. The extract holds the basic ones; mention the diluted promoter percentage in the reply if printed.
