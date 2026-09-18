# Label synonyms for the scale metrics

The regexes below are the ones in `/workspace/scripts/kpi_catalog.py` (case-insensitive). `--match "<label>"` applies
them with each KPI's exclusions and reports `matched`, `ambiguous`, `no_match` or `excluded_restructured`.

## AUM (`aum`)

| Printed label | Matches | Note |
|---|---|---|
| AUM, Gross AUM, Total AUM | `\bAUM\b`, `\bgross\s+AUM\b` | |
| Assets under management, Loan assets under management | `assets?\s+under\s+management` | "loan assets" alone would be the loan book; "under management" wins |
| Managed book, Managed assets, Managed portfolio, Managed AUM | `\bmanaged\s+(loan\s+)?(book\|assets?\|portfolio\|AUM)\b` | |
| Total portfolio, Total loan portfolio | `\btotal\s+(loan\s+)?portfolio\b` | confirm it includes assigned loans |

Excluded on purpose: "AUM growth", "AUM mix", "AUM per branch", "on-book AUM", "off-book AUM", "Opex to AUM",
"GNPA on AUM", "yield on AUM".

## Loan book (`loan_book`)

| Printed label | Matches | Note |
|---|---|---|
| Loans (balance sheet line, often "(c) Loans") | `^\s*(\(?[a-z]\)?\s*)?loans\s*$` | net of impairment allowance |
| Loans (at amortised cost), Loans (net) | `\bloans\s*\(?\s*(at\s+amortised\s+cost\|net)\s*\)?` | |
| Loan book | `\bloan\s+book\b` | IP wording |
| Loan assets | `\bloan\s+assets\b` | vetoed when followed by "under management" |
| On-book, On-book loans, On-book AUM, On book portfolio | `\bon[- ]book\s*(loans?\|AUM\|portfolio\|assets?\|book)?\b` | IP wording for the same thing |
| Own book | `\bown\s+book\b` | |
| Loans and advances, Gross loans, Net loans | as written | say gross or net in `definition` |

Excluded on purpose: anything with "under management", "off-book", "assigned", "securitised", "co-lending",
"transferred", "acquired", "growth", "mix", "stage", "provision", "impairment".

## On-book versus off-book vocabulary

| On-book (in the loan book) | Off-book (in AUM only) |
|---|---|
| own book, balance sheet assets, on-balance-sheet loans | assigned portfolio, direct assignment (DA) book |
| loans bought through portfolio buy-outs (after purchase they are on-book) | co-lending partner's share |
| securitised loans that do NOT qualify for derecognition (they stay on the balance sheet) | securitised / PTC pools that ARE derecognised |
| | "managed for others", "serviced portfolio" |

`AUM − loan book (gross) = off-book`. If the IP prints on-book and off-book separately, check that they add up to
AUM; if they do not, say so in the footnote and mark AUM `needs_review`.

## Disbursements, networth, borrowings, branches, employees

| KPI | Labels that match | Labels that must NOT be used |
|---|---|---|
| `disbursements` | Disbursements, Disbursals, Loans disbursed, Amount disbursed, Fresh disbursements | Sanctions, Logins, Approvals, Incremental yield on disbursements, Disbursement growth |
| `networth` | Net worth, Networth, Total equity, Shareholders' funds, Shareholders' equity, Tangible net worth (say so) | Equity share capital, Other equity (components), Return on net worth, Debt to net worth |
| `borrowings` | Total borrowings, Borrowings, Total debt, Debt securities, Borrowings (other than debt securities), Deposits, Subordinated liabilities (the last four are components: add them) | Cost of borrowings, Borrowing mix, Borrowing profile, Incremental borrowings, Debt-equity ratio |
| `branches` | Branches, No. of branches, Number of branches, Branch network | New branches, Branches added, Disbursement per branch, AUM per branch; "offices/locations/touchpoints" only if that is the company's sole published count |
| `employees` | Employees, No. of employees, Headcount, Employee strength, Team size, Workforce | Employee benefits expense, Employee cost, ESOP, Attrition, Disbursement per employee |

## Section titles to search for (IP)

`key highlights`, `performance highlights`, `quarterly performance`, `financial highlights`, `financial summary`,
`business update`, `AUM (and|&) disbursement`, `distribution network`, `geographic presence`, `liability profile`,
`borrowing (mix|profile)`, `key metrics`, `data book`, `annexure`, `appendix`.
