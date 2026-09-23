# lodr-filings/scripts

The scripts live in `../sandbox/workspace/scripts/` (seeded into the sandbox at `/workspace/scripts/`); run any of them with `--self-test`.

| Script | Purpose |
|---|---|
| `detect_content_type.py <file>` | what the file really is (pdf, xlsx, xbrl-xml, html error page ...); for a PDF: page count, text / scanned / mixed, image pages |
| `classify_filing.py` | first pages or a subject line -> regulation tag with the matched evidence; confidence `matched` / `ambiguous` / `none` |
| `filing_name.py` | (company, filed_on, tag, title, ext, period) -> canonical data-room path; rejects bad dates, tags, extensions |
| `locate_results_sections.py <pdf>` | page ranges, basis and unit of the covering letter, auditor's report, standalone / consolidated results, assets and liabilities, cash flow, notes, Reg 52(4) ratios; image pages; what is missing |
| `parse_results_columns.py` | header cells or lines -> each column's period, kind and role (discrete quarter, previous quarter, year-ago, cumulative, full year), audited marker, restated flag |
| `extract_results_lines.py` | table rows -> normalised NBFC line items in Rs crore with page; unmatched, misaligned and excluded rows reported |
| `validate_filing_log.py` | schema + domain rules + duplicates for `filing-log.jsonl` rows |
| `validate_results_extract.py` | schema, unit conversion, basis, discrete-quarter flags, footing, pages, exclusions for a `*.results-extract.json` |
| `validate_shareholding.py` | schema and arithmetic for a `*.shareholding.json` Reg 31 extract; `--previous` gives the quarter-on-quarter change |
