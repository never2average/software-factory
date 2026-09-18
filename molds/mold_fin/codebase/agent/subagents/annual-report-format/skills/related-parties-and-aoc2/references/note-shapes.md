# Related-party note: shapes and wording

## Shape A: nature by category (most common)

Rows are natures of transaction; columns are party categories; two sub-columns per category for the two years. With
four categories this is nine columns: `extract_table()` often splits or merges them. Check every row has the
header's width before stitching; `stitch_tables.py` refuses otherwise.

## Shape B: party by party

A block per party: name, then rows of natures with current and previous year. Convert to rows with `dimension` =
party name. Easier to extract, longer.

## Shape C: separate tables

"Transactions with related parties" and "Balances outstanding" as separate tables, sometimes on separate pages,
sometimes with a third table "Maximum balance outstanding during the year". Keep them separate; put `transaction`,
`outstanding` or `maximum outstanding` in `dimension`.

## Wording variants

| Meaning | Wordings |
|---|---|
| The note | Related party transactions; Related party disclosures; Disclosure in respect of related parties pursuant to Ind AS 24 |
| KMP | Key managerial personnel; Key management personnel; Directors and KMP |
| Common control | Entities under common control; Fellow subsidiaries; Enterprises over which KMP have significant influence |
| Outstanding | Balances outstanding; Closing balances; Amount due to / from; Payable / Receivable |
| Remuneration split | Short-term employee benefits; Post-employment benefits; Share-based payments; Sitting fees; Commission |

## AOC-2 wording

"Details of contracts or arrangements or transactions not at arm's length basis: Nil"; "Details of material
contracts or arrangement or transactions at arm's length basis: ...". Some companies add "All related party
transactions were in the ordinary course of business and at arm's length; hence not applicable." Quote whichever
appears. Do not state the materiality threshold unless the form or the policy printed in the report states it.
