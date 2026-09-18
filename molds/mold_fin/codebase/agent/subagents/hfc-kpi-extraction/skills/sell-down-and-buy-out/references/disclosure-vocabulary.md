# Sell down / buy out: vocabulary, row labels and search patterns

Regulation titles, numbering and table formats change. Everything here describes how these disclosures are generally
laid out; the document in front of you wins. Report any difference you see.

## Search patterns (case-insensitive regex)

| Pattern | Finds |
|---|---|
| `transfer\s+of\s+loan\s+exposures` | the QR note that cites the RBI directions |
| `(loans?\|exposures?)\s+transferred\s+through\s+(direct\s+)?assignment` | the transferred table |
| `loans?\s+(not\s+in\s+default\s+)?acquired` | the acquired table |
| `not\s+in\s+default` | the sub-table for standard loans (the one that matters for SD / BO) |
| `stressed\s+loans?\|\bNPA\b.*transferred\|\bARCs?\b\|asset\s+reconstruction` | stressed-loan transfers (footnote only) |
| `securiti[sz](ation\|ed)\|pass[- ]through\s+certificates?\|\bPTCs?\b` | securitisation |
| `co[- ]?lending\|co[- ]?origination` | co-lending |
| `direct\s+assignment\|\bDA\b\s+(volume\|transactions?\|pool)` | IP wording |
| `portfolio\s+buy[- ]?out\|pool\s+(purchase\|buy[- ]?out)\|inorganic` | IP wording for BO |
| `off[- ]book\|assigned\s+(book\|portfolio\|AUM)` | the STOCK of sold-down loans: a balance, not the volume |

## Row labels in the QR disclosure table

| Row label (typical) | Use |
|---|---|
| Aggregate amount / aggregate principal outstanding of loans transferred | **SD volume** |
| Aggregate amount / aggregate principal outstanding of loans acquired | **BO volume** |
| Aggregate consideration received / paid | not the volume (may differ by premium or discount) |
| Weighted average residual maturity / residual tenor | ignore |
| Weighted average holding period | ignore |
| Retention of beneficial economic interest (MRR) | ignore; do not gross up |
| Coverage of tangible security | ignore |
| Rating-wise distribution of rated loans | ignore |
| Number of accounts / loans | ignore |

If both "aggregate principal outstanding" and "aggregate consideration" are printed, the volume is the principal
outstanding; note the consideration in the footnote only when it differs by more than rounding.

## Sentences that mean nil

- "The Company has not transferred or acquired any loan exposures during the quarter ..."
- "The Company has not acquired any loans not in default ..."
- "No stressed loans were transferred ..."
- table cells `Nil`, `-`, `NA`

Each of these → `not_found` with the sentence (or the cell) quoted in the footnote and the page cited.

## Instrument vocabulary

| Term | Meaning for the KPI |
|---|---|
| Direct assignment (DA) | sale of a pool to a bank or financial institution; off balance sheet for the share sold → SD |
| Co-lending (CLM) | loans jointly originated with a bank; the bank's share never sits on the company's book → counts toward AUM as off-book; the quarter's partner-share origination is SD only where the company presents it as transferred / off-book volume. Record the treatment in `definition` and `remember` it. |
| Securitisation (PTC) | pool sold to a trust; SD only if derecognised |
| Portfolio buy-out / pool purchase | acquisition of a pool from another lender → BO |
| Inorganic growth | IP wording for bought-out portfolios → BO when a volume is given |
| Assigned book / off-book AUM | outstanding stock of sold-down loans; equals AUM − gross loan book |

## Cross-checks (do them, report them, never "fix" the number)

| Check | Expectation |
|---|---|
| AUM − gross loan book | positive when any SD has ever happened; zero → the rule says SD `not_found` |
| change in off-book stock over the quarter | roughly SD volume minus run-off of the assigned pool; SD larger than the whole off-book stock is a red flag → `needs_review` |
| IP SD vs QR SD | reconcile with `python3 /workspace/scripts/reconcile_sources.py --request ...` |
