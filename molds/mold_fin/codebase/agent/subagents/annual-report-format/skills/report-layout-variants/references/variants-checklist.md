# Layout variants: checklist and cases

## Questions to answer from the map, in order

1. Is there a consolidated set? (`layout.statement_order`)
2. Which set comes first, and does each auditor's report carry the right `basis`?
3. Is the MD&A its own chapter or inside the Board's Report?
4. Is the notice inside? Are BRSR and the Corporate Governance Report inside?
5. How many pages come before the first statutory report? Over about 60 means an integrated-style report.
6. Are the statements paginated continuously with the rest, or afresh? (offset notes)

## Cases (synthetic)

| Report | What the map shows | What to do |
|---|---|---|
| Integrated report, 412 pages, equity-listed | 14 `other_entries` before the Board's Report at PDF 96; corporate information at PDF 410 | Nothing is wrong. `report_style: integrated`. Extract corporate information from the last pages. |
| Consolidated first | `consolidated_financial_statements` at PDF 180, `standalone_financial_statements` at PDF 290 | Check `consolidated_auditors_report` is the one at 180. The analysts still use standalone: extract from 290 onwards. |
| Notice at the end | `notice_of_agm` at PDF 398 | The last section's `end_pdf_page` stops at 397. No action. |
| Slim debt-listed report, 148 pages | BRSR, corporate governance, consolidated all `not_found` | Notes as in the skill's worked example. `report_style: debt_listed_slim`. |
| Statements side by side | One balance sheet with four value columns: standalone FY26, FY25, consolidated FY26, FY25 | Both statement sections point at the same pages. Extract the standalone columns; pass only those two columns to `normalise_statement.py`. Say so. |
| MD&A as Annexure to the Board's Report | `mdna` `not_found` by the contents page; heading search finds it at PDF 58 inside the Board's Report (40-95) | Record by hand with its own start and end (58-74); keep the Board's Report at 40-95 and note that the MD&A is part of it. |

## What never to do

- Do not report a section as "missing from the filing" when the variant explains it. Say "this report does not
  contain one" and why.
- Do not quote a regulation to explain an absence unless the report itself states it. Regulations change; the
  document in front of you is the evidence.
