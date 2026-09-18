# The tag table

One tag per filing. Regulation numbers are those of the SEBI (LODR) Regulations, 2015 as the analysts' index uses
them. If a filing's own numbering differs, SEBI has amended it: record what the filing says and report the difference.

| Tag | Regulation | Chapter | What the document is | Typical subject line | Typical cadence |
|---|---|---|---|---|---|
| `reg33_results` | 33 | IV (equity) | Quarterly / annual financial results with limited review or audit report and notes. The analysts' QR. | "Outcome of Board Meeting", "Unaudited Financial Results for the quarter ended ..." | quarterly |
| `reg52_results` | 52 | V (debt) | Financial results of a debt-listed entity with the Reg 52(4) line items. The QR of an "unlisted" HFC. | "Financial Results under Regulation 52" | quarterly (half-yearly in older years) |
| `reg30_event` | 30 | IV | Material events and information | "Intimation under Regulation 30", "Credit Rating", "Allotment of NCDs", "Schedule of Analyst / Investor Meet", "Investor Presentation", "Transcript" | as it happens |
| `reg51_event` | 51 | V | Price-sensitive information, debt-listed | "Intimation under Regulation 51" | as it happens |
| `reg31_shareholding` | 31 | IV | Shareholding pattern | "Shareholding Pattern for the quarter ended ..." | quarterly |
| `reg23_rpt` | 23(9) | IV (also applied to large debt-listed entities) | Related-party transactions disclosure | "Disclosure of Related Party Transactions" | half-yearly |
| `reg32_deviation` | 32, 52(7), 52(7A) | IV / V | Statement of deviation or variation, utilisation of issue proceeds | "Statement of Deviation or Variation" | quarterly while proceeds are unutilised |
| `reg54_security_cover` | 54 | V | Security cover certificate for secured debt | "Security Cover Certificate" | quarterly, usually with results |
| `reg55_rating` | 55 | V | Credit rating review | "Credit Rating" citing Reg 55 | at each review |
| `reg57_payment` | 57 | V | Interest / principal payment intimations and certificates | "Payment of Interest", "Redemption of NCDs" | per due date |
| `reg27_cg` | 27 | IV | Corporate governance report | "Corporate Governance Report for the quarter ended ..." | quarterly |
| `reg24a_secretarial` | 24A | IV | Secretarial compliance report | "Annual Secretarial Compliance Report" | yearly |
| `reg29_notice` | 29, 50 | IV / V | Prior intimation of a board meeting | "Intimation of Board Meeting" | before each meeting |
| `reg34_annual_report` | 34, 53 | IV / V | Annual report (reading it belongs to `annual-report-format`) | "Annual Report for FY ..." | yearly |
| `other` | any other | | Anything else: say what it is (newspaper publication, voting results, investor complaints, trading window ...) | | |

## When the letter cites several regulations

| Cited together | Tag | Log under `also_covers` |
|---|---|---|
| 30 + 33 (outcome letter with results) | `reg33_results` | `reg30_event` |
| 33 + 52 [+ 52(4), 52(7), 54] | `reg33_results` | `reg52_results`, `reg32_deviation`, `reg54_security_cover` as cited |
| 51 + 52 [+ 54, 52(7)] | `reg52_results` | the rest |
| 30 (or 51) + one specific regulation, wording of the specific one present | the specific tag | the carrier |
| 30 (or 51) + one specific regulation, wording absent | ambiguous: read the letter | |
| two specific regulations (e.g. 27 + 31 in one upload) | ambiguous: read the document; tag by the subject line's first disclosure, log the other in `also_covers`, say so | |
| 29 / 50 + mention of results | `reg29_notice` | none (no results are carried) |
| 47 (or 52(8)) + 33 / 52, newspaper wording | `other` | none |
| only another regulation set (PIT, SAST ...) | `other` | |

The investor presentation, the earnings-call schedule, the audio link and the transcript are Reg 30 intimations. The
intimation is filed here as `reg30_event`; reading the presentation itself belongs to `investor-presentations`.
