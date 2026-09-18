# Vocabulary for AUM, off-book and mix slides

## AUM versus loan book

| Term on the slide | Usually means | Metric key |
|---|---|---|
| AUM, Assets under management, Managed assets, Managed book | On-book + off-book loans the company services | `aum` |
| Loan book, On-book AUM, Own book, Loans and advances, Loan assets, Gross loans | Loans on the company's balance sheet | `loan_book` |
| Off-book, Assigned portfolio, DA outstanding, Co-lent book, Derecognised loans | Loans sold or co-originated, still serviced | `off_book_aum` |
| Net loans | Gross loans less ECL provisions | not `loan_book`; mention in the note |
| Total assets, Balance sheet size | Includes investments and cash | never AUM |

"Usually" is the operative word: companies define AUM differently (some exclude co-lent partner share, some
include it). The deck's footnote or glossary decides. See `metric-definitions-glossary`.

## Product mix categories

| Deck's label | Key |
|---|---|
| Individual housing loans, Home loans, Retail home loans, HL, IHL, Prime home loans | `aum_mix_individual_housing` |
| LAP, Loan against property, Non-housing loans, NHL, Mortgage loans, MSME LAP | `aum_mix_lap` |
| Construction finance, Developer finance, Builder loans, Project loans, Corporate / wholesale book | `aum_mix_construction_finance` |
| Affordable housing, Affordable home loans, PMAY-linked, EWS/LIG | `aum_mix_affordable` (usually a cut across housing; own `basis`) |
| LRD, Top-up, Insurance funding, Others | `aum_mix_other` |

"Self-construction" is an individual housing purpose, not construction finance. "Non-housing" is not always
only LAP: if the slide breaks it down, write LAP as LAP and the rest as other.

## Customer mix

| Deck's label | Key |
|---|---|
| Salaried, Formal salaried, Informal / cash salaried | `aum_mix_salaried` (say in the note if informal is included) |
| Self-employed, SEP, SENP, Non-salaried, Business owners | `aum_mix_self_employed` |

## Ticket size and LTV qualifiers to capture in the note

- on **outstanding** book vs **at origination / on disbursement**
- **portfolio** average vs **incremental** (this quarter's disbursements)
- housing only vs all products

## Worked example

Slide: "AUM composition (Sep-25): Home loans 68%, Non-housing loans 27% (of which LAP 21%, LRD 6%),
Construction finance 5%". Rows: individual housing 68, LAP 21, other 6 (note "LRD"), construction finance 5;
all `basis: aum`; sum 100.
