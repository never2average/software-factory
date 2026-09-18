---
description: Use when a filing's text extraction returns nothing or very little, when detect_content_type reports scanned or mixed, or when an expected section (auditor's report, statement of assets and liabilities, the results table itself) seems to be missing from a PDF - before returning any table or saying something was not disclosed.
---

# Scanned and image PDFs

Many results filings are scans of signed paper, or text PDFs with some image pages. A scan read as if it were text
produces an empty table, and an empty table reads like "the company disclosed nothing". That must never leave this
subagent.

## Recognise it

```
python3 /workspace/scripts/detect_content_type.py /workspace/in/filing.pdf
```

| Output | Meaning |
|---|---|
| `text_layer: text`, `image_pages: []` | Normal. |
| `text_layer: text`, `image_pages: [12]` | A few image pages (under 10%). Still check which section they are. |
| `text_layer: mixed` | A real share of pages are images. Typical: signed auditor's report, covering letter, a security cover certificate. |
| `text_layer: scanned` | No usable text anywhere (each page has fewer than 40 extractable characters). |
| `kind: html` with `extension_mismatch` | Not a PDF at all: an error page saved under a .pdf name. Re-retrieve. |
| `unreadable` | Encrypted or damaged. Report the message verbatim. |

A subtler case: a text layer exists but is garbage (OCR noise, glyphs without a Unicode map: text like
"(cid:12)(cid:45)" or random symbols). Character counts look fine, headings never match, `locate_results_sections.py`
reports "no results statement found on a text page". Treat it as scanned and say why.

## Procedure

1. Run the detector. Then, for a results filing, the locator, which maps image pages to sections:

   ```
   python3 /workspace/scripts/locate_results_sections.py /workspace/in/filing.pdf
   ```

   `scanned_pages`, each section's `scanned_pages_inside`, and `missing_expected` tell you what is affected.
2. Decide by what is affected:
   - **Only the letter / auditor's report are images:** proceed with extraction. In the reply, list the image pages
     and say the review report was not read (so an auditor's qualification or emphasis of matter, if any, was not
     seen).
   - **A statement or the notes are images (or the whole file):** do not extract from this file. Go to step 3.
3. Look for a text version of the same filing, in this order (skill `find-filings-on-exchanges`):
   1. the exchange's XBRL / structured results for the same period (file as `.xml` or as a `.md` capture with the URL);
   2. the company's investor-relations copy, which is frequently the original text PDF of the same document;
   3. for a subsidiary, nothing replaces its own filing; the parent's presentation is a different source and is
      logged as such.
   Check that the replacement is the same document: same company, same period, same basis, same totals on any
   figure you can see in both.
4. If no text version exists: log the scanned file as filed (it is still the filing), with `content: "scanned"`,
   and a summary that says it is an image scan and nothing was extracted. No results extract is written.
5. There is no OCR in this sandbox. Do not describe numbers from a page you could not read, and do not transcribe
   from a search snippet.

## What to report, always

- which file, how many pages, which pages are images;
- which sections those pages are (or "unknown: no headings readable");
- what you tried (XBRL, IR copy) with URLs, and what you found;
- what therefore could not be extracted, named item by item (e.g. "Stage 3 / ECL note, transfer of loan exposures
  note: on image pages 7-8"). Use `status: "not_disclosed"` only for items you looked for on readable pages. For items
  that may sit on image pages say "not readable", not "not disclosed".

Ready wording for each case, and what goes in the log row: `references/report-wording.md`.

## Worked example

Example Housing Finance Ltd, Q4 FY26 results, 14 pages.

```json
{"kind": "pdf", "page_count": 14, "text_layer": "mixed", "image_pages": [1, 2, 3, 4, 9, 10], "text_pages": 8}
```

Locator: `results standalone [5]`, `assets_liabilities standalone [6]`, `cash_flow [7]`, `notes [8]`,
`results consolidated [11]` ..., `scanned_pages: [1, 2, 3, 4, 9, 10]`. Pages 1-4 are the letter and the standalone
audit report, 9-10 the consolidated audit report. The statements and notes are text: extract normally. Reply
includes: "Pages 1-4 and 9-10 are image scans (covering letter and both audit reports); the audit opinion was not
read. All figures below come from text pages 5-8."

Counter-example: `text_layer: scanned`, 9 pages. The IR page has "Financial Results Q4 FY26 (PDF)"; detector says
`text`, 9 pages, page 1 names the same company and period. Use the IR copy for extraction, log it with
`source: "company_ir"`, and mention that the exchange copy is a scan of the same document.

## Failure modes

| Temptation | Why not |
|---|---|
| Return the table skeleton with nulls | Reads as a nil disclosure. Return no table; return the explanation. |
| Fill from the press release or a news article | Not the filing; different rounding and often consolidated. |
| Use the parent's numbers for a subsidiary's scanned filing | Different entity and basis. Offer it as a separate, labelled source only. |
| Mark `not_disclosed` for an item on an image page | Unknown is not absent. |
