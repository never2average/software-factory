---
description: Use when extracting related-party transactions from an annual report - the Ind AS 24 note (parties, nature, amounts, outstanding balances) or Form AOC-2 annexed to the Board's Report - or when the two seem to disagree.
---

# Related parties: the Ind AS 24 note and Form AOC-2

Two different documents inside one annual report describe related-party dealings. They answer different questions
and are **not expected to match**.

| | Ind AS 24 note | Form AOC-2 |
|---|---|---|
| Where | Notes to the financial statements (map key `related_party_transactions`) | Annexure to the Board's Report (map key `aoc_2`) |
| Covers | Every related party and every transaction in the year, plus balances outstanding | Only contracts or arrangements under s.188 of the Companies Act: those **not at arm's length**, and **material** ones at arm's length |
| Typical content | List of parties by category; transaction table; outstanding table; KMP compensation | Two short tables; very often "Nil" or "Not applicable" |
| Basis | Standalone note and a separate consolidated note | The company only |

## Shape of the Ind AS 24 note

1. **Names and relationships**: holding company / promoter, subsidiaries, fellow subsidiaries, associates, entities
   under common control, key managerial personnel (executive directors, CFO, CS), non-executive and independent
   directors, relatives of KMP, post-employment benefit trusts.
2. **Transactions during the year**: a matrix. Either rows = nature of transaction with one column per party
   category, or grouped by party with rows for each nature. Usual natures: equity or debt issued, dividend paid,
   loans given or taken and their interest, inter-corporate deposits, NCDs subscribed by related parties, rent,
   shared-service or brand / royalty charges, sourcing or servicing fees, insurance commission, assignment of loans to
   or from group entities, remuneration, sitting fees and commission, ESOPs, contributions to trusts.
3. **Balances outstanding** at year end: payables, receivables, borrowings from, investments in, guarantees.
4. **KMP compensation**: short-term benefits, post-employment, share-based payments.

## Procedure

1. Take the pages from the map. The note often spans 3-8 pages: stitch row-wise continuations and name the pages:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/rpt.pages.json > /workspace/out/rpt.table.json
   ```

   A matrix whose party columns continue on the next page is a column-wise split: extract the halves separately
   and say so.
2. Extract the list of parties as printed (names and relationship). Do not infer a relationship the note does not state.
3. Extract transactions and outstanding balances as tables. Unit from the note's header, converted to crore. Keep
   zero and dash distinct from absent. For rows: `section: "related_party_transactions"`, `statement: "note"`,
   `label` = nature of transaction as printed, `dimension` = `"<party or category> | transaction"` or
   `"... | outstanding"`.
4. AOC-2: extract both parts as printed: (1) contracts not at arm's length, (2) material contracts at arm's length:
   name of party and relationship, nature, duration, salient terms and value, date of Board approval, advances paid.
   A "Nil" form is a finding: quote it.
5. Do not reconcile the note with AOC-2. If AOC-2 lists a contract whose party is absent from the note, report both
   facts with pages.
6. Validate before appending:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`.../{fy}_annual-report/related-party-transactions.md`: parties; transactions table; outstanding table; KMP
compensation; AOC-2 as printed; both years; pages cited; basis stated (standalone unless asked otherwise).

## Worked example

Example Housing Finance Ltd FY26, Note 48, printed pages 232-236 (PDF 240-244), "(Rs. in lakh)".

Parties: Example Holdings Ltd (holding company); Example Insurance Broking Ltd (fellow subsidiary); Ms. A. Rao
(Managing Director), Mr. B. Shah (CFO) (KMP).

| Nature of transaction | Holding company | Fellow subsidiary | KMP |
|---|---|---|---|
| Dividend paid | 2,430.00 | - | 1.20 |
| Brand licence fee paid | 1,250.00 | - | - |
| Commission income | - | 640.50 | - |
| Remuneration | - | - | 585.00 |
| **Outstanding**: NCDs held by related party | 5,000.00 | - | - |

Rows (crore): "Brand licence fee paid", dimension "Example Holdings Ltd (holding company) | transaction", 12.5;
"NCDs held by related party", dimension "Example Holdings Ltd (holding company) | outstanding", 50.0; and so on.
Dashes produce no rows.

AOC-2 (printed p. 52): part 1 "Nil"; part 2 lists the brand licence agreement with Example Holdings Ltd, ongoing,
fee at 0.75% of total income, approved by the Board on May 12, 2025. Reported as printed; the note's dividend and
commission lines are not in AOC-2, and that is as expected.

Shapes and wording variants: [references/note-shapes.md](references/note-shapes.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| Only party categories shown, no names in the transaction table | Extract by category; say names are given only in the list of parties. |
| "Transactions below a threshold are not shown" or "only material transactions disclosed" | Quote the sentence; the tables are then partial by design. |
| AOC-2 missing from the PDF | Say the Board's Report refers to it (quote) but the annexure is not in the file, or that no reference exists. |
| Consolidated note asked for | Extract with `basis: "consolidated"`, `section: "related_party_transactions"`; intra-group items are eliminated there, so it is shorter. Say so. |
