---
description: Use when reading a Reg 33 (or Reg 52) financial results PDF - to find which pages hold the covering letter, auditor's report, standalone and consolidated statements, assets and liabilities, cash flow, notes and Reg 52(4) ratios, to pick the standalone quarter column, and to turn the P&L rows into clean line items in Rs crore.
---

# Results filing layouts (the analysts' "Quarterly Report")

A results filing is one PDF stitched from several documents. The parts are always roughly the same; their order,
their presence and their unit are not. Locate first, then extract. Never read "the table on page 3" from habit.

## The parts, and how they vary

| Part | Variations you will meet |
|---|---|
| Covering letter / outcome of board meeting | 1-3 pages; often an image even when the rest is text; cites the regulations; may list other board decisions (fund raise, appointments) that are Reg 30 events in their own right |
| Auditor's limited review report (Q1-Q3) or audit report (Q4 / FY) | Before the statements or after them; one per basis; very often scanned signed pages; quotes the statement titles in prose (a false heading) |
| Standalone statement of results | First or second; alone when the company has no subsidiaries (heading then says neither "standalone" nor "consolidated") |
| Consolidated statement of results | After standalone, before it, or side by side with it in one wide table |
| Statement of assets and liabilities | Only in half-year (Q2) and year-end (Q4) filings; per basis |
| Statement of cash flows | Only in half-year and year-end filings; per basis |
| Segment note / segment table | HFCs usually state a single segment in a note instead of a table |
| Notes | After each basis's statements, or once; may start on the same page as the table; carry ECL / Stage 3, transfer of loan exposures, CRAR, the Reg 52(4) pointer |
| Reg 52(4) ratios | Only when the entity has listed debt; as a note, as rows under the P&L, or as an annexure at the end |
| Security cover certificate, deviation statement, RPT disclosure | Appended to some filings; separate filings for others |

Units differ per part: it is common for one basis to be in Rs lakh and an annexure in Rs crore. The unit is read per
section, from that section's header, never carried across.

## Procedure

1. Content type (skill `scanned-and-image-pdfs` if anything is an image):

   ```
   python3 /workspace/scripts/detect_content_type.py /workspace/in/results.pdf
   ```

2. Locate the sections:

   ```
   python3 /workspace/scripts/locate_results_sections.py /workspace/in/results.pdf > /workspace/out/sections.json
   ```

   Read, in this order: `warnings`, `scanned_pages`, `filing_period`, `results_bases`, `single_basis_filing`,
   `missing_expected`, then the `sections` list (section, basis, basis_source, pages, unit, unit_status).
   How headings are recognised: `references/section-headings.md`.
3. **Choose the basis.** The analysts use **standalone** when both exist. Take the `results` section with
   `basis: standalone`. If the only results section is `basis: both`, the table is side by side: you will select
   the standalone columns in step 5. If `single_basis_filing` is true, the statement names no basis: check the
   notes and the auditor's report title for "standalone"/"consolidated"; if the company simply has no subsidiaries
   it is a standalone statement, and you write `bases_in_filing: "single_unlabelled"` with a `basis_note` saying how
   you established it.
4. **Confirm the unit.** `unit_status: ok` gives the unit. `not_found` or `conflicting`: open the page, read the
   header line yourself ("(Rs. in Lakhs)", "₹ in crore", "INR million"), and if it truly is not stated, stop and
   report; do not infer the unit from the size of the numbers.
5. **Extract the table** from the standalone results pages with pdfplumber (`page.extract_table()`; fall back to
   `extract_text()` lines when there are no ruling lines). Header rows go to the column parser (skill
   `results-table-columns`):

   ```
   python3 /workspace/scripts/parse_results_columns.py --input /workspace/out/header.json --filing-period "Q2 FY26"
   ```

6. **Normalise the rows** (labels -> items, numbers -> Rs crore, page on every item):

   ```
   python3 /workspace/scripts/extract_results_lines.py --input /workspace/out/table.json > /workspace/out/extract.json
   ```

   `python3 /workspace/scripts/extract_results_lines.py --example` prints a complete synthetic input. The label
   table is `references/line-item-synonyms.md`. Look at `unmatched_rows` (tell the analyst about any that carry
   money), `misaligned_rows` (re-extract them; a row that lost a cell would put numbers in the wrong period),
   `problems`.
7. **Add the notes disclosures** to `extract.disclosures` (skills `notes-asset-quality-and-ecl`,
   `notes-transfer-of-loan-exposures`, `reg52-debt-listed-results` for the ratios), and the loan book and other
   balance-sheet lines from the statement of assets and liabilities when the filing has one (`key: "loans"`,
   `period_kind: "as_at"`).
8. **Validate before anything is written or handed over:**

   ```
   python3 /workspace/scripts/validate_results_extract.py /workspace/out/extract.json
   ```

   Exit 1 means do not write it. Fix the extraction or report the failure; never edit a number to make it foot.

## NBFC line items (Division III of Schedule III), as an HFC shows them

Revenue from operations: interest income; fees and commission income; net gain on fair value changes; **net gain on
derecognition of financial instruments under amortised cost category** (the income booked on direct assignment /
sell down, which is why the analysts care); dividend, rental, other operating income. Then other income, total income.
Expenses: finance costs; fees and commission expense; net loss on fair value changes / on derecognition; **impairment
on financial instruments** (the credit cost: ECL charge plus write-offs, can be negative on a release); employee
benefits expense; depreciation, amortisation and impairment; other expenses; total expenses. Then profit before
(exceptional items and) tax, tax (current, deferred), profit for the period, other comprehensive income, total
comprehensive income, paid-up equity capital, other equity (year-end), EPS (not annualised for quarters).

"Net interest income" is usually **not** a line in the statutory format. Extract it only if the filing prints it.
Do not compute it, and do not compute operating expenses, cost-to-income or any KPI: that is `hfc-kpi-extraction`'s
job, from the clean lines you hand over.

## Picking the standalone quarter column

The column whose role is `discrete_quarter` and whose basis is standalone (or unlabelled in a standalone table). A
"half year ended", "nine months ended", "year to date" or "year ended" column is never the quarter, even when it is
the first numeric column. In a Q4 filing the quarter column exists and is usually footnoted as the balancing figure
between the audited full year and the published nine months: take it as printed, and mention the footnote. When no
discrete quarter column exists at all, hand over the cumulative columns flagged `discrete_quarter: false`; deriving
the quarter is the KPI subagent's step, with its own footnote.

## What to write

`Customers/{customer_id}/filings/lodr/extracts/{filing file stem}.results-extract.json` with `dataroom_write`, only
after `validate_results_extract.py` exits 0; then the log row. Schema:
`/workspace/schemas/results-extract.schema.json`.

## Worked example

Example Housing Finance Ltd, Q2 FY26 filing, 11 pages. `locate_results_sections.py` (abridged):

```json
{"filing_period": "Q2 FY26", "text_layer": "text", "scanned_pages": [3], "results_bases": ["consolidated", "standalone"],
 "sections": [
  {"section": "covering_letter", "pages": [1]},
  {"section": "auditor_report", "basis": "standalone", "pages": [2, 3], "scanned_pages_inside": [3]},
  {"section": "results", "basis": "standalone", "pages": [4], "unit": "lakh", "unit_status": "ok", "period": "Q2 FY26"},
  {"section": "assets_liabilities", "basis": "standalone", "basis_source": "inherited", "pages": [5], "unit": "lakh"},
  {"section": "cash_flow", "basis": "standalone", "pages": [6], "unit": "lakh"},
  {"section": "notes", "basis": "standalone", "pages": [7]},
  {"section": "auditor_report", "basis": "consolidated", "pages": [8]},
  {"section": "results", "basis": "consolidated", "pages": [9], "unit": "crore", "unit_status": "ok"},
  {"section": "reg52_4_ratios", "pages": [11]}],
 "reg52_4_mentions": [1, 7], "missing_expected": []}
```

Standalone P&L is page 4 in Rs lakh; consolidated is in Rs crore (mixed units in one file). Page 4 row
"(a) Interest income | 52,340.10 | 50,110.40 | 44,800.00 | 1,02,450.50 | 87,900.25 | 1,85,300.75" becomes
`interest_income`: Q2 FY26 523.401, Q1 FY26 501.104, Q2 FY25 448.0, H1 FY26 1024.505, H1 FY25 879.0025, FY25 1853.0075
(Rs crore), page 4. The validator then checks 56,001.00 + 99.00 = 56,100.00 (total income), 56,100.00 - 38,600.00 =
17,500.00 (PBT) and 17,500.00 - 4,400.00 = 13,100.00 (PAT) for every column. The full layout catalogue is in
`references/layout-variations.md`.

## Failure modes

| Signal | Meaning and action |
|---|---|
| `warnings`: "no results statement found on a text page" | Probably a scan or a letter-only upload. Skill `scanned-and-image-pdfs`. Never return an empty table. |
| `missing_expected` lists assets_liabilities in a Q2/Q4 filing | It may sit on an image page, or the company filed it separately. Say which pages are images; mark loan book `not_disclosed` in this filing, not zero. |
| A results section starts on an auditor's page | Should not happen (numbers guard). If it does, pass the right pages by hand and report the heading text. |
| `unit_status: conflicting` | Two unit lines inside one section, e.g. "Rs in lakhs" on the table and "Rs in crore" in a note. Read the table header itself. |
| Footing error from the validator | Usually a misread cell (a bracket lost, a column shifted). Re-extract that row; if the filing itself does not foot, report it with both numbers and do not hand over that column as clean. |
| `single_basis_filing` | See step 3. Never relabel a consolidated-only filing as standalone. If only consolidated exists, extract consolidated with a `basis_note` and tell the analyst. |
