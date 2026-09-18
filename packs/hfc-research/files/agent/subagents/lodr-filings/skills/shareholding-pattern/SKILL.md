---
description: Use when reading a Regulation 31 shareholding pattern (PDF, XBRL or exchange page text) - to extract promoter, public and non-promoter-non-public holdings, pledged or encumbered promoter shares, the institutional split and named holders, and to compare with the previous quarter.
---

# Shareholding pattern (Reg 31)

Equity-listed companies file the pattern every quarter in the exchange's prescribed tables. A debt-listed HFC does
not file one: say "not applicable: no listed equity", do not search for it.

## How to recognise the structure

The filing follows a fixed family of tables. Table numbering and columns have been revised by SEBI more than once:
read the titles on the page, not the numbers here.

| Table (usual title) | What it holds | What you take |
|---|---|---|
| Summary statement holding of specified securities | One row per category: (A) Promoter & Promoter Group, (B) Public, (C) Non Promoter - Non Public [(C1) shares underlying DRs, (C2) shares held by employee trusts]; columns: number of shareholders, fully paid-up shares, total shares, % of total, voting rights, shares underlying convertibles, **locked-in shares**, **shares pledged or otherwise encumbered** (number, and as % of total shares held), dematerialised shares | total shares; per category: holders, shares, %; the promoter row's pledged / encumbered number and % |
| Statement showing shareholding pattern of the Promoter and Promoter Group | Indian / foreign promoters by entity, with their pledge columns | each promoter entity as a named holder; which entity's shares are pledged |
| Statement showing shareholding pattern of the Public shareholder | Institutions (domestic): mutual funds, AIFs, banks, insurance companies, provident / pension funds, NBFCs ...; Institutions (foreign): FPI category I / II ...; governments; non-institutions: resident individuals (by holding size), NRIs, bodies corporate ...; names of holders with 1% or more | institutional split; named 1%+ holders |
| Statement showing shareholding pattern of the Non Promoter - Non Public shareholder | Custodian / DR holder, employee benefit trust | the category total |
| Declarations (yes/no grid on page 1) | Partly paid shares, convertibles, DRs, locked-in shares, **"Whether any shares held by promoters are pledged or otherwise encumbered?"** | the pledge yes/no, as a cross-check |
| Significant beneficial owners; foreign ownership limits | Newer annexures | only when asked |

Formats: a PDF print of the XBRL (text, many narrow columns, numbers wrap), the exchange's HTML page, or the XBRL
itself. `python3 /workspace/scripts/detect_content_type.py <file>` tells you which you have.

## Procedure

1. Detect, then classify if the source is unclear:

   ```
   python3 /workspace/scripts/detect_content_type.py /workspace/in/shp.pdf
   python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/shp.pdf --listing equity
   ```

2. Read the **as-on date** (quarter end) from page 1; it, not the filing date, gives `period`.
3. From the summary table take the three category rows and the total. Use share **counts** as printed (whole
   shares, Indian digit grouping: `10,00,00,000` is 100,000,000) and the printed percentages. Columns wrap in PDF
   prints: confirm that (A) + (B) + (C) equals the printed total before going on.
4. Pledge / encumbrance: from the promoter row of the summary table (number, % of promoter holding). Three
   distinct outcomes: a number (`status: "disclosed"`), an explicit nil / "No" in the declaration grid
   (`status: "nil"`), or the column absent / unreadable (`status: "not_disclosed"`). The percentage printed in
   that column is of the **promoter's own holding**, not of total capital; the schema has both fields, so put each
   number where it belongs.
5. Public breakdown: map the printed sub-categories to the schema's groups (table in
   `references/extraction-map.md`); keep the printed label in `label_reported`. Named holders: every promoter
   entity and every public holder the filing names.
6. Write the JSON per `/workspace/schemas/shareholding.schema.json` and validate. With the previous quarter's
   extract in the data room, fetch it and compare:

   ```
   python3 /workspace/scripts/validate_shareholding.py /workspace/out/shareholding.json --previous /workspace/in/prev-shareholding.json
   ```

   The comparison is refused unless `--previous` is the immediately preceding quarter.
7. Standing facts: when `promoter_band_crossed` is non-empty, or the pledge status changes between nil and
   disclosed, update the company record (`upsert_customer`) and say what you changed. Small moves within a band are
   reported, not recorded.

## What to write

`Customers/{customer_id}/filings/lodr/extracts/{filing file stem}.shareholding.json` via `dataroom_write`, after the
validator exits 0; then the log row (`tag: reg31_shareholding`, `period` = the as-on quarter, no `basis`).

## Worked example

Example Housing Finance Ltd, as on 30 September 2025, total 10,00,00,000 shares.

| Category | Holders | Shares | % |
|---|---|---|---|
| (A) Promoter & Promoter Group | 3 | 4,80,00,000 | 48.00 |
| (B) Public | 85,000 | 5,10,00,000 | 51.00 |
| (C) Non Promoter - Non Public (employee trust) | 1 | 10,00,000 | 1.00 |

Promoter shares pledged or otherwise encumbered: 48,00,000 (10.00% of promoter holding). Previous quarter (Q1 FY26):
promoter 5,05,00,000 (50.50%), pledged 20,00,000.

Validator output (abridged):

```json
{"valid": true,
 "comparison": {"period": "Q2 FY26", "previous_period": "Q1 FY26",
  "categories": {"promoter_and_promoter_group": {"shares_change": -2500000, "pct_point_change": -2.5, "pct": 48.0, "previous_pct": 50.5}},
  "promoter_band_crossed": [50.0], "pledged_shares_change": 2800000,
  "notes": ["promoter holding moved from 50.5% to 48.0%, across [50.0]%: a standing fact for the company record (upsert_customer)"]}}
```

Reply: "Promoter holding 48.00% as on 30 Sep 2025 (50.50% on 30 Jun 2025), p.2. Pledged / encumbered promoter
shares 48,00,000 = 10.00% of promoter holding (20,00,000 a quarter earlier), p.3." No adjectives.

## Failure modes

| Validator error | Usual cause |
|---|---|
| "category shares add up to X, total_shares is Y" | A wrapped number was read as two, or the (C1)/(C2) sub-rows were added on top of (C). Re-read the row. |
| "pct_of_promoter_holding ... does not agree" | The % of total capital was put in the % of promoter holding field (or the reverse). |
| "pledged/encumbered shares exceed the promoter holding" | The locked-in column was read instead of the pledge column; they are adjacent. |
| "as_on ... is not a quarter end" | The filing date was used. Some patterns are filed for a capital change (not quarter end): log the filing, note the date, and do not force it into a quarter extract. |
| Percentages move but shares do not | `total_shares_change` is non-zero (allotment, ESOP exercise, buy-back): the note says so. Report the cause only if a filing states it. |
