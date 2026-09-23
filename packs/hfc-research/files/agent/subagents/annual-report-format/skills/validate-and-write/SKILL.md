---
description: Use as the final gate before anything is written - before dataroom_write of the section map or a section file, before dataroom_append_jsonl to annual-report-data.jsonl, and before publish_artifact or render_account_report. Also use when a validator fails and you need to know what to do.
---

# Validate and write

**Nothing is written to the data room or published until validation has passed.** A failing validation is reported to
the analyst with the validator's messages. It is never bypassed, never "fixed" by deleting the rule's subject without
saying so, and never worked around by writing to a different path.

## What is written, and what guards it

| Output | Path | Gate |
|---|---|---|
| Section map | `Companies/{company_id}/filings/lodr/{fy}_annual-report-map.md` | `validate_section_map.py`, then `render_section_map_md.py` (which refuses an invalid map) |
| Section extract | `Companies/{company_id}/filings/lodr/{fy}_annual-report/{section-slug}.md` | the checklist below |
| Numeric rows | `Companies/{company_id}/filings/annual-report-data.jsonl` (append) | `validate_ar_data.py` |
| Formatted deliverable | via `render_account_report` / `publish_artifact` | built only from extracts and rows that passed the gates above |

Section slugs: `corporate-information`, `directors-report`, `management-discussion-and-analysis`,
`corporate-governance-report`, `brsr`, `standalone-financial-statements`, `consolidated-financial-statements`,
`ind-as-109-notes`, `loans-and-borrowings-notes`, `transfer-of-loan-exposures`, `rbi-hfc-directions-disclosures`,
`related-party-transactions`, `independent-auditors-report`.

## Row fields in `annual-report-data.jsonl`

One JSON object per line item, checked by `validate_ar_data.py` against `/workspace/schemas/annual-report-data-row.schema.json`.

- Required: `customer_id`, `fy`, `section`, `label`, `normalised_label`, `value`, `unit`, `basis`, `printed_page`,
  `pdf_page`.
- Optional: `report_fy`, `statement`, `dimension`, `original_value`, `original_unit`, `note_ref`, `restated`, `note`,
  `stitched_pdf_pages`, `source_file`.
- `fy` is the year the figure belongs to; `report_fy` is the report it was read from (a comparative column in the
  FY26 report is `fy: FY25`, `report_fy: FY26`).

## Procedure

1. **Workspace sanity** (once per session, or when a script complains about its references):

   ```
   python3 /workspace/scripts/ar_common.py
   ```

2. **Map.**

   ```
   python3 /workspace/scripts/validate_section_map.py /workspace/out/map.json
   python3 /workspace/scripts/render_section_map_md.py /workspace/out/map.json --out /workspace/out/FY26_annual-report-map.md
   ```

   Errors block. Warnings (unconfirmed sections, missing printed pages, image pages) are repeated in the reply.
   Write the file's content with `dataroom_write` to the `dataroom_path` the renderer prints.
3. **Rows.** Put only the NEW rows in `/workspace/out/annual-report-data.jsonl`, one JSON object per line. Fetch the
   existing data-room file (if any) to `/workspace/in/`. Then:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl \
     --existing /workspace/in/annual-report-data.jsonl --map /workspace/out/map.json
   ```

   Exit 0: append exactly those rows with `dataroom_append_jsonl`. Exit 1: fix and re-run; see
   [references/validator-messages.md](references/validator-messages.md). Warnings about restated comparatives go into
   the reply.
4. **Section file checklist**, before each `dataroom_write`:
   - every figure and quote has printed page and PDF page; every table names its unit, basis and financial year;
   - amounts are in Rs crore, the filing unit is stated once;
   - stitched tables name their pages;
   - the company's labels are kept, normalised labels beside them;
   - no restructured-book details; a line says they exist if they do;
   - nothing is empty: a section that could not be read says why (scanned pages, not in the report);
   - text is quoted or neutrally summarised; no opinion of yours.
5. **Reply** with: the section map (first contact with a report), what was extracted and where it was written, what
   the report did not contain, warnings from the validators, and anything ambiguous you did not resolve.
6. `remember` layout facts worth keeping.

## Worked example

After extracting Example Housing Finance Ltd's FY26 standalone balance sheet, the new-rows file has 38 rows.
`validate_ar_data.py` prints:

```json
{"valid": false, "rows": 38,
 "errors": ["line 12: duplicate of line 7 ('Derivative financial instruments', FY26, standalone); if the rows differ by stage, bucket or party, set dimension",
            "line 31: 'Restructured loans (OTR 2.0)' is a restructured-book item; the analysts exclude these, remove the row (mention in the reply that the report has the disclosure)"],
 "warnings": ["line 9: 'Loans' FY25 is 10111.213 in the FY26 report but 10100.0 in the FY25 report: a restated or regrouped comparative. Set restated and call it out"]}
```

Actions: line 12 is the liabilities-side derivative line: its `normalised_label` is
`derivative_financial_instruments_liabilities` but the company label is the same as line 7's, so set `dimension:
"liabilities"` (and `"assets"` on line 7). Line 31: remove the row, add the presence line to the extract. Line 9:
set `restated: true` on the FY25 rows, find the explaining note, quote it. Re-run: `valid: true`, 37 rows. Append 37
rows. The reply mentions the restatement and the left-out restructured line.

## Failure modes and what to report

| Situation | Do |
|---|---|
| A validator error you believe is wrong for this report | Do not write. Report the message, the row or section, and why you think the rule does not fit. The orchestrator decides. |
| The script itself crashes | Report the traceback's last line and the command. Do not write unvalidated output. |
| `dataroom_append_jsonl` rejects the rows | Report its error; do not retry with altered fields to get past it. |
| Part of a batch fails | Append nothing from that batch until all of it passes, so the file never holds half a statement. |
| The analyst asks to skip validation | Say that validation is a fixed rule of this workspace, give the failing messages, and offer the fix. |
