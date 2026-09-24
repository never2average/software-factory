---
description: "Use when the KPI rows for a company and quarter are assembled and you are about to write anything: the final gate that validates the batch, builds the analyst workbook, appends to kpis.jsonl, publishes the workbook and composes the summary. Load it before the first dataroom_append_jsonl or publish_artifact call."
---

# Validate and publish

Nothing is written to the data room and nothing is published until the batch passes
`python3 /workspace/scripts/validate_kpis.py`. A failing validation is reported to the analyst. It is never bypassed,
never "fixed" by deleting the offending row, and never worked around by writing the rows anyway.

## The gate, step by step

1. **Assemble the batch** as one JSON object per line in `/workspace/out/kpis-batch.jsonl`: the disclosed rows you
   extracted, the reconciled rows, and the `rows` emitted by
   `python3 /workspace/scripts/compute_kpis.py --inputs <inputs.json> --rows`. Every row has `primary_context_entity`, one
   shared `extracted_at` (UTC, `2026-09-18T10:00:00Z`), and the fields of
   `/workspace/schemas/kpi-row.schema.json`. One row per catalog KPI (27), found or not:
   `python3 /workspace/scripts/kpi_catalog.py --list`.

2. **Fetch the history** so duplicates are seen and the workbook shows earlier quarters:
   `dataroom_fetch_to_sandbox` `Companies/{company_id}/filings/kpis.jsonl` → `/workspace/in/kpis-existing.jsonl`
   (skip if `dataroom_list` shows it does not exist yet).

3. **Validate the batch**:

   ```
   python3 /workspace/scripts/validate_kpis.py /workspace/out/kpis-batch.jsonl --expect-complete \
     --existing /workspace/in/kpis-existing.jsonl
   ```

   - exit 0, `"valid": true` → continue. Read `flags`: they go into the summary.
   - exit 1 → **stop writing**. Read `errors` (codes in `references/validator-codes.md`). If the error is yours
     (a typo in a unit, a missing page number you do have), correct the row FROM THE SOURCE DOCUMENT and validate
     again. If the error is in the data (NNPA above GNPA in the filing itself, loan book above AUM), do not alter the
     numbers: report the failure, the rows involved and the pages, and end the turn without appending or publishing.

4. **Build the workbook** from history + batch:

   ```
   cat /workspace/in/kpis-existing.jsonl /workspace/out/kpis-batch.jsonl > /workspace/out/kpis-all.jsonl
   python3 /workspace/scripts/build_kpi_workbook.py /workspace/out/kpis-all.jsonl --company-id <company_id> \
     --name "<Company name>" --xlsx /workspace/out/<company_id>-kpis.xlsx
   python3 /root/fmt_xlsx.py /workspace/out/<company_id>-kpis.xlsx
   ```

   The builder validates its input again and builds nothing if it fails. Check `"xlsx": {"written": true}`. Layout:
   one sheet per company (KPIs as rows grouped by category in rulebook order, quarters as columns oldest first, a
   Notes column with footnote references), a `Footnotes` sheet, a `Citations` sheet. If old rows in the history fail
   validation, build from the batch alone and report the invalid history lines; do not edit the history.

   Do not use the `build_workbook_spec` tool for this table: it produces the platform's company-record workbooks,
   not the KPI table. The script above prints the KPI workbook spec as JSON and writes the .xlsx.

5. **Append**: `dataroom_append_jsonl` with `path` `Companies/{company_id}/filings/kpis.jsonl` and `records` = the
   batch rows exactly as validated.

6. **Publish**: `publish_artifact` with the sandbox path of the .xlsx.

7. **Summarise** (template in `references/summary-template.md`): the table for the quarter; every `needs_review`
   and `carried_forward` cell with its reason (`review_cells` in the validator output); every validator flag; every
   filing you needed and did not find; any company definition you recorded with `remember`.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

```
$ python3 /workspace/scripts/validate_kpis.py /workspace/out/kpis-batch.jsonl --expect-complete
{"valid": false, "rows": 27, ...
 "errors": [{"code": "E-SCHEMA", "line": 6, "message": "$.footnote: shorter than 8"},
            {"code": "E-NNPA", "line": 11, "message": "example-hfl Q2 FY26: NNPA 2.4% is greater than GNPA 1.82%"}], ...}
```

- Line 6 is the carried-forward `branches` row with an empty footnote: your omission. Add "Branches not published
  for Q2 FY26; value as of Q1 FY26 from the previous quarter's investor presentation." and `value_period`.
- Line 11: you re-open QR p.6 and find NNPA is 1.21%; 2.4% was the Stage 2 share, misread. Correct it from the page.
- Validate again → `"valid": true`, flags: `F-DUP` "example-hfl Q2 FY26 aum: already present in the data room's
  kpis.jsonl; appending supersedes it". Mention in the summary that this run supersedes an earlier extraction.
- Build, format, append 27 records, publish, summarise.

Had p.6 really printed NNPA 2.4% against GNPA 1.82%, you would NOT append: reply "Validation failed (E-NNPA): the
results print Net NPA 2.40% above Gross NPA 1.82% on p.6. Nothing was written. Please confirm which figure is
right."

## Failure modes

- **openpyxl missing** (`xlsx.written: false`): a sandbox fault. Append the validated rows, do not publish a
  workbook, and report the fault.
- **Partial batches.** Validate and append one company-quarter at a time. If quarter A passes and quarter B fails,
  A may be written; B is reported.
- **Re-extraction.** Appending a second set for the same quarter is allowed (the file is append-only; the workbook
  uses the latest `extracted_at`). Never reuse the same `extracted_at` for it: that is `E-DUP`.
- **Hand-made workbook.** Never build the .xlsx with ad-hoc openpyxl code; the layout is the script's.
- **Editing numbers to pass validation** is fabrication. Report instead.
