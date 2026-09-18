# Telling the structures apart, and nil cases

## Words that identify each structure

| Structure | Words in the report |
|---|---|
| Direct assignment | "assignment", "direct assignment", "assigned pool", "loans transferred through assignment", "minimum retention requirement", "beneficial economic interest" |
| Co-lending | "co-lending", "co-origination", "co-lending model", "partner bank", a stated ratio such as 80:20 |
| Securitisation | "securitisation", "special purpose entity / vehicle", "trust", "pass-through certificates", "PTC", "credit enhancement", "first loss facility", "over-collateralisation" |
| Stressed-loan transfer | "asset reconstruction company", "ARC", "security receipts", "stressed loans transferred", "loans in default transferred" |
| Acquired loans | "loans acquired", "acquired through assignment", "pool buyout", "portfolio purchase" |

## On book or off book: what the report says

- "derecognised in their entirety", "meets the derecognition criteria", "gain on derecognition recognised upfront":
  off book (for the transferred share). Sell down.
- "does not meet the derecognition criteria", "continues to recognise the assets", "associated liability": on book,
  with a liability shown under borrowings (`securitisation_liabilities`). Not a sell down in the analysts' sense.
- Silent: say silent.

## Nil and near-nil cases (synthetic wording)

| Report says | Write |
|---|---|
| "The Company has not transferred or acquired any loan exposures during the year and the previous year." | Two rows (transferred, acquired), `value: null`, `note: "stated as Nil"`, sentence quoted with pages. |
| A table printed with dashes in every cell | Same: rows with `value: null`, `note: "table printed with nil values"`. |
| A table printed with 0.00 | Rows with `value: 0`. |
| No mention anywhere | No rows. The reply states what was searched and found nothing. "Not disclosed" is different from "nil": keep them apart. |
| Disclosure exists only in the consolidated notes | Say so. Extract it only if consolidated was asked for, labelled consolidated. |

## Cross-checks worth stating (never forced)

- Assigned assets outstanding + loan book compared with the AUM the report states.
- Net gain on derecognition in the P&L present while the note says nothing was assigned in the year: report both
  facts; income can arise from earlier years' pools.
