---
description: Use when an annual report PDF is met for the first time (no `{fy}_annual-report-map.md` in the data room yet), when a section's page is needed and the map is missing or unconfirmed, or when last year's map should be reused to speed up this year's.
---

# Build the section map

An annual report runs to 300-500 pages. The map is built once per report and everything else works from it.
Never read the report from page 1.

Two page numbers exist for every page and both are recorded, always:

- **printed page**: the number printed on the page (`45`, or `iv` in the front matter). Analysts cite this one.
- **PDF page**: the page's position in the file, counting from 1. Scripts and `pdfplumber` use this one.

## Before building: is there a map already?

1. `dataroom_list` on `Customers/{customer_id}/filings/lodr/`. If `{fy}_annual-report-map.md` exists, fetch it and read
   the map back. Do not rebuild it:

   ```
   python3 /workspace/scripts/render_section_map_md.py --extract /workspace/in/FY26_annual-report-map.md > /workspace/out/map.json
   ```

2. If only last year's map exists, read it the same way and use it as a guide (see "Reuse next year" below). It is
   never copied: this year's pages are different.

## Procedure

1. Fetch the PDF with `dataroom_fetch_to_sandbox` to `/workspace/in/`.
2. Check what the file is. A scanned or mixed result changes the plan: load `scanned-or-image-reports`.

   ```
   python3 /workspace/scripts/detect_content_type.py /workspace/in/FY26_annual-report.pdf
   ```

3. Build the map. The script tries the evidence in order of strength and says which one it used (`method_summary`):

   ```
   python3 /workspace/scripts/section_map.py /workspace/in/FY26_annual-report.pdf \
     --customer-id example-housing-finance --fy FY26 --content-type text --out /workspace/out/map.json
   ```

   | Order | Evidence | What it gives | Weakness |
   |---|---|---|---|
   | 1 | PDF outline (bookmarks) | PDF pages directly | Many reports have none, or only chapter-level ones |
   | 2 | Contents page | printed pages, converted with the offsets | Wrong when unnumbered pages were inserted; group headers carry no page |
   | 3 | Heading search | PDF pages where the heading is printed | Running headers repeat on every page; note headings vary |

   Note-level sections (Loans, borrowings, Ind AS 109, transfer of loan exposures, RBI disclosures, related parties)
   are never on the contents page. They are searched for inside the standalone statements' page range only.

4. Read the result. Each section is `found` (heading seen on the page), `unconfirmed` (a page is proposed but the
   heading was not seen there), or `not_found`.
   - For every `unconfirmed` section you were asked about, open the proposed PDF page and the two after it, and look.
     Correct `pdf_page`, `printed_page`, `title_as_printed`, set `method` to `manual` and `confidence` to `found`.
   - A section with `candidates` matched in several places: the first is recorded, check it.
   - `not_found` stays `not_found` with its note unless you locate it by hand. It is not dropped from the map.
   - Headings the table does not know are listed under `other_entries`. If one of them is plainly a section in the
     index under another name, record it by hand (`method: manual`) and tell the orchestrator the heading, so the
     table can learn it.
5. Check the offsets block. See [references/page-offsets.md](references/page-offsets.md) for roman front matter,
   unnumbered inserts, restarted numbering and double-page spreads. To test an offset by hand:

   ```
   python3 /workspace/scripts/page_offset.py --pairs "1:cover,3:i,4:ii,9:1,10:2,300:292" --page-count 320 --lookup 45 --lookup iv
   ```

6. Validate, render, write. Nothing is written before the validator passes.

   ```
   python3 /workspace/scripts/validate_section_map.py /workspace/out/map.json
   python3 /workspace/scripts/render_section_map_md.py /workspace/out/map.json --out /workspace/out/FY26_annual-report-map.md
   ```

   Write the rendered file with `dataroom_write` to the `dataroom_path` the script prints
   (`Customers/{customer_id}/filings/lodr/{fy}_annual-report-map.md`).
7. `remember` the layout facts that will save time next year, in one line each, for example
   "example-housing-finance: RBI disclosures are Note 52, after the related-party note; statements are paginated
   continuously; no bookmarks". Put the same lines in the map's `layout_memories` before rendering.

## When the script cannot open the contents page

If the contents page is an image, or laid out so that the text comes out scrambled, read it yourself, type its lines
into a text file, sample a few page labels, and build the map from that:

```
python3 /workspace/scripts/section_map.py --toc-text /workspace/out/contents.txt \
  --samples /workspace/out/samples.json --page-count 412 --customer-id example-housing-finance --fy FY26
```

Everything built this way is `unconfirmed` until you have looked at the pages.

## Reuse next year

Last year's map tells you where to look first, nothing more:

- the order of sections and whether consolidated comes before standalone rarely change;
- note numbers drift by one or two when a note is added; search near last year's note number;
- printed-to-PDF offsets change every year. Never carry an offset over.

Build this year's map with the script as usual, then compare: a section that was `found` last year and is
`not_found` this year deserves a manual look before it is reported as absent.

## What to write

- `/workspace/out/map.json`, validated.
- `Customers/{customer_id}/filings/lodr/{fy}_annual-report-map.md`, rendered from it.
- In the reply, on first contact with a report: the sections table, the offsets, what was not found.

## Worked example

Example Housing Finance Ltd, FY26, 360 PDF pages, no bookmarks. The contents page reads "Board's Report ... 30" and
"Management Discussion and Analysis ... 62". Sampled page labels: PDF 3 = `i`, PDF 4 = `ii`, PDF 9 = `1`, PDF 10 =
`2`, PDF 200 = `192`. The script reports two offset segments: roman, PDF page = printed + 2; arabic, PDF page =
printed + 8. So the Board's Report is proposed at PDF page 38. The heading is actually on PDF page 39 (a divider
page was inserted): the script finds it there, records PDF 39 / printed 31, marks it `found`, and notes "heading
found on pdf page 39; the contents page and offsets implied 38". The RBI disclosures are found by the note search
at PDF page 255 (printed 247) under the heading "52. Disclosures required by the Reserve Bank of India ...".
The full contents page, the samples and the resulting map are in
[references/worked-example.md](references/worked-example.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| `section_map.py` exits 1 with "no section could be located" | Run the content-type check. If scanned, say so. Otherwise say no contents page or headings were recognised and list `other_entries`. |
| Offsets show "numbering restarts" | Printed pages are not unique. Cite the part as well ("printed page 12 of the financial statements") and rely on PDF pages. |
| Offsets show double-page spreads | Text comes out with the two printed pages interleaved. Say so; tables need care (see the offsets reference). |
| A required section is genuinely absent (no consolidated statements, no BRSR for a debt-listed company) | Leave it `not_found`, put the reason in its note, and say it in the reply. Load `report-layout-variants`. |
| The validator reports an error you cannot fix | Report the error text. Do not write the map. |

The heading table the script uses is [references/section-headings.json](references/section-headings.json). Typical
headings per section, in words, are in [references/heading-variants.md](references/heading-variants.md).
