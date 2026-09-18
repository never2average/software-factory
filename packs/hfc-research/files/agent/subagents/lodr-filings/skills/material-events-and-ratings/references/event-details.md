# Event details: what the annexure usually gives, and what to capture

SEBI prescribes, by circular, the details to be given for each event type. The lists change; the filing in front of
you shows what was required at its date. Capture what is there, note what is conspicuously blank.

## Rating actions

| Capture | Notes |
|---|---|
| Agency | ICRA, CRISIL, CARE, India Ratings, Acuite, Brickwork ... exact name |
| Instrument / facility and amount rated | long-term bank lines, NCDs, subordinated debt, CP, fixed deposits; enhanced amounts are an action too |
| Previous rating and outlook; new rating and outlook | exact symbols, including "(CE)", "(SO)", "rating watch with developing / negative / positive implications" |
| Action verb as printed | assigned, reaffirmed, upgraded, downgraded, outlook revised, placed on watch, withdrawn |
| Date of the agency's letter or press release vs date of the intimation | both; the record uses the agency's date as the effective date |

Record change when: any symbol or outlook differs from the record; a watch is placed or removed; a rating is
withdrawn; a new agency rates the company. The agency's rationale document is background, not a LODR filing.

## Fund raises

| Instrument | Capture |
|---|---|
| NCDs (private placement / public issue) | series, amount, coupon, tenor / maturity, secured or unsecured, senior or subordinated (Tier II), listed where, allotment date |
| Commercial paper | usually Reg 51 / 57 style intimations of issue and redemption: amount and maturity |
| Equity (QIP, preferential, rights) | shares, price, amount, allottees named, post-issue capital; check the next shareholding pattern |
| Bank / NHB refinance / ECB | sanction amount, lender, tenor (often disclosed only when material) |
| Securitisation / direct assignment announced as an event | pool amount, counterparty class, retained share. It is the same flow that the transfer-of-loan-exposures note reports later. Cross-reference, do not add. |

## KMP, directors, auditors

Name, designation, DIN / membership where given, effective date, term, reason for change as stated, brief profile
(one clause), relationships with other directors. For an auditor's resignation the annexure has the auditor's own
reasons and whether they raised concerns: quote.

## Regulatory and legal

Authority, date of order and of receipt, provision contravened, amount, period covered, whether appealable,
company's statement of financial impact. Tax demands are common and usually contested: report amount and forum.

## Investor meets, presentations, transcripts

Schedule intimation (date, type: one-on-one / group / conference / earnings call), then within short order the
presentation, the audio recording link, and the transcript. The intimation letters are `reg30_event` filings. The
attached presentation is an investor presentation: tell the orchestrator its URL / data-room path; the
`investor-presentations` subagent files it under `filings/presentations/` and reads it.

## Reg 57 and other debt servicing

Due date, payment date, ISIN, interest / principal amount. "Paid on due date" is routine. A delay, a default, or a
restructuring of terms is material: record it.
