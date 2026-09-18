---
description: Use when extracting the regulatory disclosure block in an HFC's notes - capital and CRAR with Tier I and Tier II, reserve fund, investments, asset-liability maturity pattern, exposure to real estate and capital market, concentration of advances, exposures and NPAs, sector-wise NPAs, movement of NPAs, customer complaints, principal business criteria.
---

# RBI HFC Directions disclosures

Housing finance companies add a long block of regulator-prescribed disclosures to their notes: typically 15-30
pages of small tables. It is the single richest source of comparable numbers in the annual report.

**Follow the document.** The Directions, their numbering and the names of individual disclosures have changed over
time (older reports refer to the NHB Directions; later ones to the RBI Master Direction for HFCs, and further
disclosure requirements have been added since). Do not expect a fixed list or order. Use the headings printed in the
report, extract what is there, and when a heading in the index below is absent or named differently, say so rather
than hunting for a regulation.

## How to recognise it and where it sits

- Map key `rbi_hfc_disclosures`. Usually one of the **last notes** of the standalone statements, after related
  parties, segment reporting and financial-instruments notes, headed "Disclosures required by / pursuant to / in
  terms of the Master Direction ... Housing Finance Company (Reserve Bank) Directions" or similar.
- Sub-headings carry their own numbering (52.1, 52.2 ... or 3.1, 3.2 ... mirroring the annexure of the Directions).
- It is often missing from the consolidated notes. It is standalone by nature.
- Some items are split off into separate notes: liquidity coverage ratio, liquidity risk disclosures, the Ind AS 109
  versus prudential-norms comparison, transfer of loan exposures, restructuring / resolution-framework tables (left
  out: say they are present).
- `remember` the note number: it moves by one or two a year at most.

## Procedure

1. Take the start page from the map. Find the end by reading sub-headings forward until the notes end or an
   unrelated note begins; record the end in the map by hand if you wish (`end_pdf_page`), and re-validate:

   ```
   python3 /workspace/scripts/validate_section_map.py /workspace/out/map.json
   ```

2. List the sub-headings with pages first. That list goes at the top of the extract and tells the analyst what this
   report has. Match them to [references/disclosure-index.md](references/disclosure-index.md).
3. Extract each requested sub-table as a table, both years. Units: most are in the statements' unit; ratios are
   per cent; complaints are counts. Read each table's own header. Stitch where needed:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/alm.pages.json
   ```

4. **ALM maturity pattern**: keep the report's buckets exactly (they commonly run from "1 to 7 days" to "over 5
   years", but follow the page). Rows: deposits, borrowings from banks, market borrowings, foreign currency
   liabilities; advances, investments, foreign currency assets. Use `dimension` = bucket.
5. **Principal business criteria**: the two percentages (housing finance to total assets net of intangibles;
   housing finance to individuals to total assets) as printed, with the thresholds only if the report prints them.
6. Rows: `section: "rbi_hfc_disclosures"`, `statement: "note"`, `unit` = `crore` / `percent` / `count` / `times`.
   Normalised labels for the common items are in the index reference. Validate before appending:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`.../{fy}_annual-report/rbi-hfc-directions-disclosures.md`: list of sub-headings with pages; then one section per
sub-heading extracted, as tables; "Not in this report" list against the section index; a line on left-out
restructuring tables if present.

## Worked example

Example Housing Finance Ltd FY26, Note 52, printed pages 247-268 (PDF 255-276). Sub-headings found: 52.1 Capital;
52.2 Reserve fund u/s 29C; 52.3 Investments; 52.4 Derivatives; 52.5 Securitisation and assignment; 52.6 Asset
liability management; 52.7 Exposures (real estate, capital market); 52.8 Related party (pointer to Note 48); 52.9
Provisions and contingencies; 52.10 Concentration of advances, exposures and NPAs; 52.11 Sector-wise NPAs; 52.12
Movement of NPAs; 52.13 Customer complaints; 52.14 Principal business criteria.

52.1, as printed:

| Particulars | March 31, 2026 | March 31, 2025 |
|---|---|---|
| CRAR (%) | 21.40 | 23.10 |
| CRAR - Tier I capital (%) | 19.85 | 21.30 |
| CRAR - Tier II capital (%) | 1.55 | 1.80 |
| Amount of subordinated debt raised as Tier II capital (Rs. in crore) | - | 100.00 |

Rows: `crar` 21.4 percent, `crar_tier_1` 19.85, `crar_tier_2` 1.55 (Tier I + Tier II = total: check it). The dash
is nil: no row, or `value: null` with `note: "printed as -"` if the analyst wants the line kept.

52.14: "Housing finance to total assets (net of intangible assets): 78.20%; housing finance for individuals: 71.05%."
Rows `principal_business_housing_pct` and `principal_business_individual_housing_pct`, unit percent.

## Failure modes and what to report

| Situation | Report |
|---|---|
| Block not found by the map | Search the last 40 pages of the standalone notes for "CRAR", "maturity pattern", "exposure to real estate". If found without an umbrella heading, record the first sub-heading's page by hand. |
| The report's list differs from the section index | Normal. Report "present / not present in this report" per index item; never say the company failed to disclose. |
| NPA tables mix restructured accounts in | Extract gross and net NPA movement as printed; leave out lines or tables specific to restructured accounts, and say so. |
| Tier I + Tier II does not equal CRAR | Report as printed, note the difference. |
| Percentages printed without "%" and amounts in the same table | Take the unit from each row's label; if a row's unit cannot be told, do not write a row for it: quote it in the markdown only. |
