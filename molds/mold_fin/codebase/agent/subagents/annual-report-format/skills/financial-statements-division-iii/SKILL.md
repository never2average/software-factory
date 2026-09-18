---
description: Use when extracting a balance sheet, statement of profit and loss, cash flow statement or statement of changes in equity from an annual report (standalone or consolidated), when a statement table spans pages, when labels need normalising (Loans to loan_book, the four borrowings lines), when units are lakhs or millions, or when comparatives are marked restated.
---

# Financial statements (NBFC format, Division III of Schedule III)

An HFC's statements follow the NBFC format: no current / non-current split; assets and liabilities are split into
**financial** and **non-financial**; the order is roughly by liquidity. If the statement in front of you differs
from the line items listed in [references/division-iii-line-items.md](references/division-iii-line-items.md), follow
the document and report the difference.

## Rules that bind this skill

- **The analysts use standalone when both exist.** Extract consolidated only when asked, and label it.
- Every figure carries: basis, financial year, printed page, PDF page. Amounts are reported in Rs crore.
- Keep the company's label; add the normalised label beside it. Unknown labels stay as printed.
- Tables are extracted as tables. A table that spans pages is stitched, and the pages are named.
- Restructured-book line items are left out (the scripts drop and list them).

## How to recognise what you have

| Look at | To learn |
|---|---|
| The statement's title line | Basis: "Standalone Balance Sheet", "Consolidated Statement of Profit and Loss". A title with neither word, in a report with one set of statements, is standalone basis: see `report-layout-variants`. |
| The line under the title | Unit: "(Rs. in lakh)", "(Rs. in crore)", "(Rs. in millions)". "unless otherwise stated" is normal; two units named in one header is not: see failure modes. |
| The column heads | Periods: "As at March 31, 2026" / "As at March 31, 2025"; for the P&L "Year ended ...". A third column ("As at April 1, 2024") means a restated opening balance sheet. |
| A "Note" column | Note references: keep them (`note_ref`); they lead to the notes skills. |
| "(Restated)", "(Refer note 58)", "regrouped / reclassified" under a column head or in a note | Restated comparatives: set `"restated": true` on that column and quote the note that explains it. |

## Procedure

1. From the map take the page of the statement (`standalone_balance_sheet`, `standalone_statement_of_profit_and_loss`,
   `standalone_cash_flow_statement`, `standalone_statement_of_changes_in_equity`). If the map has only the parent
   section, the four statements are the first pages after the auditor's report and its annexures.
2. Extract the table from each page with `pdfplumber` (`page.extract_table()`; if it returns ragged rows, build rows
   from `page.extract_words()` grouped by `top`). Keep the cell text exactly as printed. A snippet is in
   [references/extracting-tables.md](references/extracting-tables.md).
3. If the statement runs over more than one page (P&L and cash flow usually do, SOCIE always), stitch:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/standalone-pnl.pages.json > /workspace/out/standalone-pnl.table.json
   ```

   The script refuses when column counts disagree between pages. Fix the extraction (usually the note column went
   missing on one page); do not pad columns by hand to make it pass.
4. Normalise labels and convert to crore:

   ```
   python3 /workspace/scripts/normalise_statement.py /workspace/out/standalone-pnl.rows.json > /workspace/out/standalone-pnl.norm.json
   ```

   Input fields: `customer_id`, `report_fy`, `section`, `statement`, `basis`, `unit_header` (the line as printed),
   `columns` (one per value column, with `fy` or the column head as `label`, and `restated` where marked),
   `printed_page`, `pdf_page`, `rows`. Rows from `stitch_tables.py` can be passed as they are.
5. Read the script's lists before going on:
   - `unknown_labels`: fine if they are the company's own sub-lines; check none is a Division III head under an
     unusual name. If one is, report the wording so the label table can learn it.
   - `ambiguous_labels`: keep as printed.
   - `unparseable_values`: a footnote mark stuck to a number (`1,234.5*`), or a broken cell. Re-read the cell. Never
     type in what it "must be".
   - `excluded_restructured`: mention in the reply that the statement has such lines; do not extract them.
   - `derived.borrowings`: the analysts' borrowings total = debt securities + borrowings (other than debt
     securities) + deposits + subordinated liabilities. It is derived, and says which components were present.
6. Check your extraction foots before writing: total assets = total liabilities and equity, and the P&L runs down to
   the profit printed. If it does not, a row was missed. Say so rather than write a statement that does not add up.
7. The `data_rows` in the script's output are ready for `annual-report-data.jsonl`. Validate, then append
   (`validate-and-write` skill):

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

- `.../{fy}_annual-report/standalone-financial-statements.md` (or `consolidated-financial-statements.md`): the four
  statements as tables with both the company's label and the normalised label, values in crore, the filing unit
  stated once per statement, pages cited, stitched pages named, restated columns marked.
- Rows in `annual-report-data.jsonl`: `section` = `standalone_financial_statements`, `statement` = `balance_sheet` /
  `profit_and_loss` / `cash_flow` / `changes_in_equity`.

## Worked example

Example Housing Finance Ltd, standalone balance sheet, printed page 164 (PDF 172), header "(Rs. in Lakhs)".

| As printed | Note | As at March 31, 2026 | As at March 31, 2025 |
|---|---|---|---|
| (e) Loans | 7 | 12,34,567.80 | 10,11,121.30 |
| (c) Debt securities | 13 | 3,00,000.00 | 2,50,000.00 |
| (d) Borrowings (other than debt securities) | 14 | 6,00,000.00 | 5,00,000.00 |
| (f) Subordinated liabilities | 16 | 50,000.00 | 50,000.00 |

Output: `loan_book` 12,345.678 crore (FY26) and 10,111.213 crore (FY25); `debt_securities` 3,000.00;
`borrowings_other_than_debt_securities` 6,000.00; `subordinated_liabilities` 500.00; derived `borrowings` 9,500.00
crore with `components_absent: ["deposits"]` (the company takes no public deposits, so the line is not on its balance
sheet). "Derivative financial instruments" appears on both sides: the script tracks the ASSETS / LIABILITIES AND
EQUITY heading rows and labels them `derivative_financial_instruments_assets` and `..._liabilities`.

One data row, as appended:

```json
{"customer_id": "example-housing-finance", "fy": "FY26", "report_fy": "FY26", "section": "standalone_financial_statements", "statement": "balance_sheet", "label": "(e) Loans", "normalised_label": "loan_book", "value": 12345.678, "unit": "crore", "original_value": 1234567.8, "original_unit": "lakh", "basis": "standalone", "printed_page": "164", "pdf_page": 172, "note_ref": "7"}
```

The label table is [references/statement-labels.json](references/statement-labels.json) (the scripts read the same
file). A stitched P&L and a restated comparative are worked through in
[references/worked-examples.md](references/worked-examples.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| Header names two units ("Rs. in lakh, except per share data") | `normalise_statement.py` refuses the header. Pass `"unit": "lakh"` explicitly; EPS rows are never converted anyway. Say which unit you read and from where. |
| No unit line on the page | Look at the first page of the statement or the notes' basis-of-preparation paragraph ("rounded to the nearest lakh"). Quote it. If none can be found, do not convert; report the figures as unconverted and say why. |
| Standalone and consolidated columns side by side | Pass only the standalone columns. Name the columns taken. |
| `stitch_tables.py` refuses | Report its reason. Do not write the table. |
| Total equity is asked for as "net worth" | They are not the same thing. Give total equity as printed, and the company's own net worth figure only where the report states one (usually the RBI disclosures or ratios note). |
| Statement pages are images | Load `scanned-or-image-reports`. |
