# Tag regex table

This documents `/workspace/scripts/reference/filing_tag_patterns.json`, the table `classify_filing.py` reads. The JSON is the
source; if this page and the JSON ever differ, the JSON is what runs (`python3 /workspace/scripts/classify_filing.py --print-table`).
All regexes are case-insensitive and run on text with whitespace collapsed, so a citation broken over two lines still matches.

## 1. Regulation number to tag

A citation is `Reg` / `Regn` / `Regulation(s)` followed by a number of up to three digits, an optional letter (24A) and
sub-clauses, and any further numbers joined by `,` `and` `&` `/` `read with` `r/w`. "Regulations, 2015" is never read as a number.

| Regulation cited | Tag |
|---|---|
| 33 | `reg33_results` |
| 52 | `reg52_results` |
| 30 | `reg30_event` |
| 51 | `reg51_event` |
| 31 | `reg31_shareholding` |
| 23 | `reg23_rpt` |
| 32 | `reg32_deviation` |
| 54 | `reg54_security_cover` |
| 55 | `reg55_rating` |
| 57 | `reg57_payment` |
| 27 | `reg27_cg` |
| 24A | `reg24a_secretarial` |
| 29 | `reg29_notice` |
| 50 | `reg29_notice` |
| 34 | `reg34_annual_report` |
| 53 | `reg34_annual_report` |

Sub-clause overrides:

| Citation | Tag | Why |
|---|---|---|
| 52 with sub-clause matching `^\(7a?\)` | `reg32_deviation` | Reg 52(7)/(7A) is the statement of utilisation / deviation of debt issue proceeds |
| 52 with sub-clause matching `^\(8\)` | `other` | Reg 52(8) is the newspaper publication of debt-listed results, not the results themselves |

LODR regulations that are commonly cited but have no tag of their own map to `other`, with a note saying what they usually are.
These descriptions are a convenience, not regulation text; the document in front of you says what it is.

| Regulation | Commonly |
|---|---|
| 7 | share transfer agent compliance certificate |
| 13 | statement of investor complaints |
| 39 | loss of share certificates / issue of duplicates |
| 40 | transfer and transmission of securities certificate |
| 42 | record date or book closure (equity) |
| 44 | voting results of a shareholders' meeting |
| 46 | website disclosure |
| 47 | newspaper advertisement (including the published results extract) |
| 56 | documents furnished to the debenture trustee |
| 58 | documents sent to holders of debt securities |
| 60 | record date (debt) |
| 62 | website disclosure (debt-listed) |

## 2. Not a LODR citation

If, within 90 characters after the number, the text names another regulation set before it names LODR, the citation is not mapped:

```
insider trading|\bpit\b|substantial acquisition|takeovers?|\bsast\b|depositor(y|ies)|buy-?back|\bicdr\b|issue of capital|debenture trustees?\) regulations|share based employee|\bsbeb\b|non-convertible securities\) regulations|\bncs regulations
```

## 3. Subject cues

A cue either names one tag, or a group that resolves by listing: `results` -> `reg33_results` (equity) / `reg52_results` (debt);
`event` -> `reg30_event` (equity) / `reg51_event` (debt). With citations present, a group cue supports whichever of its two tags is cited.

| Cue id | Tag or group | Regex |
|---|---|---|
| `results.financial_results_period` | group `results` | `(un-?audited\|audited)?\s*(standalone\|consolidated)?\s*(and\|&\|/)?\s*(standalone\|consolidated)?\s*financial results\b.{0,80}?\b(quarter\|half[- ]year\|nine months\|year\|period)\b.{0,30}?\bended\b` |
| `results.outcome_with_results` | group `results` | `outcome of (the )?(board\|meeting).{0,200}?financial results` |
| `results.limited_review` | group `results` | `(limited review report\|auditor'?s'? report).{0,120}?financial results` |
| `reg29.prior_intimation` | `reg29_notice` | `(prior )?intimation (of\|for\|regarding\|about) (the )?(date of )?(a )?(board\|committee) meeting\|notice of (the )?board meeting\|board meeting (is \|will be )?(scheduled\|to be held)\|meeting of the board of directors.{0,60}?(is\|will be) (scheduled\|held)` |
| `reg31.shareholding_pattern` | `reg31_shareholding` | `share ?holding pattern` |
| `reg23.rpt` | `reg23_rpt` | `(disclosure\|statement\|details) (of\|on) related party transactions?\|related party transactions? (disclosure\|for the half[- ]year)` |
| `reg32.deviation` | `reg32_deviation` | `statement of (material )?deviations?( or \|/\| and )?(variations?)?\|deviation or variation\|utili[sz]ation of (issue \|the )?proceeds` |
| `reg54.security_cover` | `reg54_security_cover` | `security cover (certificate\|available)\|certificate (of\|on\|for) (the )?security cover\|asset cover certificate\|asset cover available` |
| `reg55.rating` | `reg55_rating` | `credit ratings?\b.{0,80}?\b(review\|reviewed\|reaffirm\w*\|re-affirm\w*\|upgrad\w*\|downgrad\w*\|revis\w*\|assign\w*\|withdraw\w*\|outlook)\|\b(revision\|reaffirmation\|upgrade\|downgrade\|review) (in\|of) (the )?(credit )?ratings?` |
| `reg57.payment` | `reg57_payment` | `(payment\|paid\|servicing) of (the )?(interest\|principal\|redemption)\|interest( and \|/\| or )(principal\|redemption) (payment\|amount)\|certificate (of\|for\|regarding) (timely )?payment\|status of payment\|due dates? (of\|for) (payment of )?(interest\|principal)\|redemption of (the )?(non[- ]convertible )?(debentures\|ncds)` |
| `reg27.cg` | `reg27_cg` | `(quarterly )?(compliance )?report on corporate governance\|corporate governance report` |
| `reg24a.secretarial` | `reg24a_secretarial` | `(annual )?secretarial compliance report` |
| `reg34.annual_report` | `reg34_annual_report` | `(submission of \|copy of (the )?)?annual report\b.{0,60}?\b(financial year\|fy\|f\.y\.)\|annual report (and\|along with\|together with) (the )?notice of (the )?(annual general meeting\|agm)\|notice of (the )?\d{1,3}(st\|nd\|rd\|th) (annual general meeting\|agm) (and\|along with) (the )?annual report` |
| `event.rating_generic` | group `event` | `\b(icra\|crisil\|care ratings?\|india ratings\|acuite\|brickwork)\b.{0,120}?\b(rating\|outlook)` |
| `event.fund_raise` | group `event` | `(allotment\|issue\|issuance) of (secured \|unsecured \|rated \|listed \|redeemable \|senior \|subordinated )*(non[- ]convertible debentures\|ncds\|commercial papers?\|equity shares\|bonds)\|qualified institutions? placement\|preferential (issue\|allotment)\|rights issue\|raising of funds\|fund ?rais\w+` |
| `event.kmp_change` | group `event` | `(appointment\|re-?appointment\|resignation\|cessation\|retirement\|change) (of\|in) (the )?(a \|an )?(managing director\|md ?(&\|and) ?ceo\|chief executive officer\|ceo\|chief financial officer\|cfo\|company secretary\|key managerial personnel\|kmp\|director\|independent director\|chairman\|chairperson\|compliance officer)` |
| `event.auditor_change` | group `event` | `(appointment\|re-?appointment\|resignation\|change) (of\|in) (the )?(joint )?(statutory \|secretarial )?auditors?` |
| `event.investor_meet` | group `event` | `(analysts?\|institutional investors?)( ?/ ?\| or \| and )?(institutional )?(investors?\|analysts?)? ?(meet\|meeting\|call\|conference)\|earnings (conference )?call\|schedule of .{0,40}?(investor\|analyst)\|investor presentation\|transcript of (the )?(earnings\|conference\|investor\|analyst)\|audio (recording\|link)` |
| `event.regulatory_order` | group `event` | `(order\|penalty\|fine\|show cause notice\|direction\|inspection\|supervisory action\|search\|seizure)s? (passed\|imposed\|levied\|issued\|received\|conducted) (by\|from)\|(reserve bank of india\|rbi\|national housing bank\|nhb\|sebi\|income tax\|gst\|enforcement directorate).{0,80}?(order\|penalty\|fine\|notice)` |
| `event.scheme_acquisition` | group `event` | `scheme of (amalgamation\|arrangement\|merger)\|acquisition of (shares\|stake\|control\|business)\|sale of (stake\|shares\|subsidiary)\|change in (control\|promoters?)` |
| `event.esop` | group `event` | `(grant\|allotment) of .{0,40}?(stock options\|esops?\|employee stock)` |
| `event.outcome_generic` | group `event` | `outcome of (the )?(board\|committee) meeting` |
| `other.newspaper` | `other` | `newspaper (advertisement\|publication\|clippings?\|cuttings?)s?\|copy of (the )?(newspaper\|advertisement)\|extract of .{0,80}?results.{0,60}?published` |

`other.newspaper` only applies when Regulation 47 or 52(8) is also cited.

## 4. Sets used by the rules

- carriers: `reg30_event`, `reg51_event`
- results tags: `reg33_results`, `reg52_results`
- absorbed into a results filing: `reg32_deviation`, `reg54_security_cover`, `reg23_rpt` and the carriers
- cues that show the document carries results (not just mentions them): `results.outcome_with_results`, `results.limited_review`
