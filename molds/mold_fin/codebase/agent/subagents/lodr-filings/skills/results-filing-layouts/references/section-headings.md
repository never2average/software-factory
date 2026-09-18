# Section heading table

Documents `/workspace/scripts/reference/results_section_headings.json`, which `locate_results_sections.py` reads. The JSON is the source.

A heading is accepted when the regex matches a line (or a line joined with the next one, for titles split over two lines) and the match
starts within `max offset` characters of the line start. Sections marked *needs numbers* are accepted only on a page with at least
15 number-like tokens (`1,23,456.78`, `(1,234.50)`, `12.5`): the auditor's report and the covering letter quote statement
titles in running prose, and those pages have almost no numbers.

| Section | Needs numbers | Max offset | Regex |
|---|---|---|---|
| `auditor_report` | no | 12 | `independent auditor'?s'?\s+(limited\s+)?(review\s+)?report\|limited review report\|auditor'?s'? report on (the )?(quarterly\|annual\|standalone\|consolidated\|audited\|unaudited\|financial)\|report on the audit of the\|review report to the board` |
| `results` | yes | 40 | `statement of\s+((un-?audited\|audited\|standalone\|consolidated\|reviewed)\s+(and\s+)?)*financial results\|(un-?audited\|audited)\s+((standalone\|consolidated)\s+)?financial results for the\|statement of (standalone \|consolidated )?profit (and\|&) loss` |
| `assets_liabilities` | yes | 40 | `statement of\s+((un-?audited\|audited\|standalone\|consolidated)\s+)*assets (and\|&) liabilities\|(standalone \|consolidated )?balance sheet as at\|(standalone\|consolidated)\s+statement of assets` |
| `cash_flow` | yes | 40 | `statement of\s+((un-?audited\|audited\|standalone\|consolidated)\s+)*cash ?flows?\|cash ?flow statement\|(standalone\|consolidated)\s+statement of cash ?flows?` |
| `segment` | yes | 40 | `segment[- ]?wise (revenue\|results)\|segment (reporting\|information\|results)\s*(for\|as\|:\|$)` |
| `notes` | no | 6 | `^\W{0,3}notes?\s*(:\|-\|$)\|^\W{0,3}notes? to (the )?(un-?audited \|audited )?(standalone \|consolidated )?(financial )?(results\|statements?)\|^\W{0,3}notes? forming part` |
| `reg52_4_ratios` | no | 200 | `regulation\s*52\s*\(\s*4\s*\)\|reg\.?\s*52\s*\(\s*4\s*\)` |
| `security_cover` | no | 60 | `security cover (certificate\|available\|as (on\|at))\|certificate (of\|on\|for) (the )?security cover\|asset cover (certificate\|as (on\|at))` |
| `deviation_statement` | no | 40 | `statement of (material )?deviations?( or \|/\| and )?variations?\|statement of utili[sz]ation of (issue )?proceeds\|statement indicating (the )?utili[sz]ation` |
| `related_party` | no | 40 | `disclosure of related party transactions\|related party transactions for the (half[- ]year\|six months)` |

Extra conditions:

- `auditor_report`, `reg52_4_ratios`, `security_cover`, `deviation_statement`, `related_party` are never started on a covering-letter page
  (a page with two or more letter cues), because the letter lists its enclosures by their titles.
- `reg52_4_ratios` needs the citation and at least 3 ratio labels on the same page; a bare citation is reported under `reg52_4_mentions`.
- `notes` must be a short line (80 characters or fewer) that starts with "Notes".
- A repeated heading of the same section and basis on the next page is a continuation.

## Basis

`standalone` / `consolidated` / `both` is read from the heading line and the next two lines (eight lines for the auditor's report, whose title
is long). Assets and liabilities, cash flow, segment and notes that name no basis inherit it from the results or auditor's section before
them (`basis_source: inherited`). Otherwise `unspecified`.

## Ratio labels (for the Reg 52(4) page test)

```
debt[- ]?(to[- ])?equity ratio
debt service coverage
interest service coverage
net ?worth
capital redemption reserve
debenture redemption reserve
outstanding redeemable preference
net profit after tax
earnings per share
current ratio
long[- ]term debt to working capital
bad debts to accounts? receivable
current liability ratio
total debts? to total assets
debtors'? turnover
inventory turnover
operating margin
net profit margin
gross (npa|non[- ]performing|stage ?(3|iii))
net (npa|non[- ]performing|stage ?(3|iii))
provision coverage
capital (to risk|adequacy)|\bcrar\b|\bcrwa\b
liquidity coverage ratio
security cover|asset cover
```

## Covering-letter cues

```
dear sir|dear madam|\bsub(ject)?\s*[:.-]|scrip code|\bsymbol\s*[:.-]|bse limited|national stock exchange|listing department|corporate relationship|phiroze jeejeebhoy|exchange plaza|yours (faithfully|sincerely|truly)
```

## Unit lines

A line is a unit line when it matches the pattern below; `finlib.units.detect_unit` then reads it. Two different units, or a line naming two
units, give `unit: null`, `unit_status: conflicting`.

```
(₹|`|\brs\.?|\binr\b|rupees|amounts?|figures|currency).{0,40}?\b(lakhs?|lacs?|crores?|cr\.?|crs\.?|millions?|mn\.?|billions?|bn\.?|thousands?)\b|\(\s*in\s+(₹\s*)?(lakhs?|lacs?|crores?|millions?|billions?)
```
