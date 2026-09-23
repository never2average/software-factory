---
description: Use when text extraction returns nothing or very little for a report or a section, when detect_content_type.py says scanned or mixed, or when a section (often the signed auditor's report or a signed balance sheet page) is an image inside an otherwise text PDF.
---

# Scanned or image reports

A scanned page has no text layer. `pdfplumber` returns an empty string, and an empty string must never travel on as
"the section says nothing". The rule in the instructions is absolute: **say the pages are scanned; never return an
empty extract.** There is no OCR in this sandbox.

## How to recognise it

```
python3 /workspace/scripts/detect_content_type.py /workspace/in/FY26_annual-report.pdf --map /workspace/out/map.json
```

| `text_layer` | Meaning | What follows |
|---|---|---|
| `text` | At most 10% of pages are images (covers, photo pages, dividers) | Work normally. If `image_pages` lists pages inside a section you need, treat that section as mixed. |
| `mixed` | Some stretches are images | Look at `image_page_ranges` and `sections_affected`. Typical: the signed auditor's report, the signed balance sheet and P&L pages, certificates, the secretarial audit report, annexures scanned from paper. |
| `scanned` | 90% or more of pages are images | Nothing can be extracted. Report and stop. |

A page counts as an image page when it yields fewer than 40 characters. To test one stretch only (faster on a
500-page file):

```
python3 /workspace/scripts/detect_content_type.py /workspace/in/FY26_annual-report.pdf --first 150 --last 175
```

Other signs of a bad text layer, which the script does not catch: text that extracts as garbage characters (a font
without a Unicode map), or digits that extract but letters do not. Treat those pages as unreadable too, and say which.

## Procedure

1. Run the detector with `--map` when a map exists. Without a map, run it bare, then build the map: a fully scanned
   report has no readable contents page, so `section_map.py` will locate nothing and exit 1. That is expected.
2. Record `content_type` and `image_pages` in `map.json` (copy them from the detector's output), validate and render
   the map again so the finding is kept with the report:

   ```
   python3 /workspace/scripts/validate_section_map.py /workspace/out/map.json
   python3 /workspace/scripts/render_section_map_md.py /workspace/out/map.json --out /workspace/out/FY26_annual-report-map.md
   ```

3. For each requested section:
   - `fully_scanned: true`: do not write a section file with empty content. Write nothing for it, and report it.
   - partly scanned: extract the text pages, and in the section file list the image pages under a heading
     "Pages that are images (not extracted)" with printed and PDF page numbers.
   - untouched: extract as usual.
4. Never type numbers from an image by eye into `annual-report-data.jsonl`. Rows come only from extracted text.
5. Suggest the way out: a text version of the same report is often available (the stock exchange copy and the
   company website copy are different files). The orchestrator can ask `lodr-filings` for another copy.

## What to write

- The map, with `content_type` and `image_pages`.
- For a mixed report: section files for the readable parts, each naming its unreadable pages.
- In the reply: which pages are images (as ranges, printed and PDF), which requested sections that affects, and what
  was and was not extracted.

## Worked example

Example Housing Finance Ltd FY26, 320 PDF pages. The detector returns `text_layer: text`, `image_page_ranges:
[[1, 2], [158, 171]]`, and `sections_affected: [{"key": "standalone_auditors_report", "image_pages": 14,
"section_pages": 14, "fully_scanned": true}, {"key": "standalone_financial_statements", "image_pages": 14,
"section_pages": 112, "fully_scanned": false}]`.

The analyst asked for the auditor's report and the balance sheet. Reply:

> The standalone Independent Auditor's Report (printed pages 150-163, PDF pages 158-171) is a scanned image in this
> file, so its text cannot be extracted: opinion type, key audit matters and CARO remarks are **not reported**. The
> balance sheet (printed page 164, PDF page 172) is text and has been extracted to
> `Companies/example-housing-finance/filings/lodr/FY26_annual-report/standalone-financial-statements.md`. Another
> copy of the report may have a text layer; `lodr-filings` can look for one.

Reply wording for the other cases is in [references/what-to-report.md](references/what-to-report.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| The whole file is scanned | "The report is a scanned image (N of N pages); no section can be extracted." Plus the page count and file name. No map sections are invented. |
| The file is not a PDF (`kind` is `html`, `zip-office`, `text`) | Say what it is. An HTML file saved as `.pdf` is usually a download error page: ask for the filing to be fetched again. |
| `pdfplumber` is missing (`ImportError`) | The sandbox's start-up install failed. Report the error and the log path it names. Do not fall back to guessing. |
| A table page is text but comes out as one jumbled column | Not a scan. Extract with `page.extract_tables()` or by words' positions; if still unusable, say the table could not be read reliably and give the page. |
