# Transfer of loan exposures: search terms, label variants, table shapes

## Finding the note

Run over the notes pages, case-insensitive:

```
transfer of loan exposures|loans? (not in default )?(transferred|assigned|acquired)|direct assignment|
master direction.{0,80}transfer|loan participation|novation
```

Stressed-loan part: `stressed loans?|transferred to (arcs?|asset reconstruction)|permitted transferees`

Do not confuse with (these are different notes):

```
securiti[sz]ation|pass[- ]through certificates?|\bptcs?\b|special purpose (vehicle|entity)   -> securitisation disclosure
restructur|resolution framework|resolution plan                                                -> excluded by the rulebook
co-?lending                                                                                     -> company-specific; keep its own split
```

## Label variants

| Key | Labels you will meet |
|---|---|
| `loans_transferred_amount` | Aggregate amount of loans transferred; aggregate principal outstanding of loans transferred; amount of loan accounts assigned; value of loans transferred through assignment; aggregate consideration (this is the price received, not the principal: if both are printed take the principal and put the consideration in `note`) |
| `loans_transferred_count` | Number of loans / accounts; count of loan accounts assigned |
| `loans_transferred_wa_maturity_months` | Weighted average residual maturity; weighted average maturity (after transfer); residual tenor |
| `loans_transferred_wa_holding_period_months` | Weighted average holding period (by originator / after origination) |
| `loans_transferred_retention_pct` | Retention of beneficial economic interest; minimum retention requirement (MRR) retained; share retained by the originator |
| `loans_transferred_security_coverage_pct` | Coverage of tangible security; security coverage |
| `loans_acquired_*` | The same labels with "acquired" / "purchased" / "taken over"; "retention by the transferor" |
| `stressed_loans_transferred_amount` | Aggregate principal outstanding of (stressed / NPA / SMA) loans transferred to ARCs / permitted transferees / other transferees |
| `stressed_loans_acquired_amount` | Aggregate principal outstanding of stressed loans acquired |

## Table shapes

1. **Rows = particulars, columns = periods** (quarter and/or year-to-date, sometimes previous year). One disclosure
   row per particular per period column.
2. **Rows = particulars, one value column**, period in the note's lead sentence. Most common.
3. **Rows = particulars, columns = transferee type or asset class** (to banks / to NBFCs; home loans / LAP).
   Take the printed total only.
4. **Sentence form**, no table: "During the quarter, the Company assigned loans aggregating Rs X crore." One
   amount row; the other particulars are `not_disclosed` by omission (do not list each as a row: put
   `"loans_transferred_count"` etc. in `not_found` only if the analyst asked for them).
5. **Nil sentence.** See the skill body.

## Quarter vs year-to-date

The lead sentence decides. When the sentence says "quarter and half year ended" and the table has one column, the
filing is ambiguous: report it as such, give the amount with `period_kind: "ytd"` only if another part of the note
(or the prior quarter's filing in the data room) confirms it; otherwise leave `status: "unparseable"` with the
sentence in `note` and tell the analyst exactly what the filing says.
