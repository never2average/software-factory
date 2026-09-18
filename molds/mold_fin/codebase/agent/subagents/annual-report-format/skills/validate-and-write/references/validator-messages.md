# Validator messages and what to do

## validate_section_map.py

| Message contains | Cause | Fix |
|---|---|---|
| `schema:` | A field is missing, mistyped, or not allowed (`confidence: found` with no `pdf_page`; `fy` not `FY26`) | Correct the field. |
| `required section ... is missing` | A section from the index was deleted from the map | Put it back as `not_found` with a note saying where you looked. |
| `not_found needs a note` | | Add the note: what was searched, or why the report has no such section. |
| `beyond the page count`, `before it starts` | Typing error in a page | Re-read the page. |
| `maps to pdf page N by the offsets, but the map says M` | Printed and PDF page disagree with the map's own offsets | One of the two is wrong, or unnumbered pages sit before this section: sample labels near it with `page_offset.py` and rebuild the offsets. |
| `cannot be placed by the offsets` | Printed numbering restarts or the label is outside every segment | Sample more pages; if numbering restarts this is expected for ambiguous labels only when the PDF page is one of the candidates. |
| `overlaps` | One section's end runs past the next one's start | Fix `end_pdf_page`. MD&A, corporate governance or BRSR wholly inside the Board's Report, and the auditor's report inside the statements, are accepted. |
| `outside its parent` | A note-level section was recorded outside the statements' range | Wrong page, or the parent's range is wrong. |
| `printed pages go backwards` | | A misread printed page; or numbering restarts (then the offsets must show it). |

## validate_ar_data.py

| Message contains | Fix |
|---|---|
| `schema: ... unit` | `unit` must be crore, percent, times, count, rupees, months or years. Lakh and million are never written: convert, and keep `original_value` / `original_unit`. |
| `is not ... in crore (expected ...)` | The value was not converted, or converted twice. Use `normalise_statement.py`'s output. |
| `is an amount and must be in crore` / `per share and must be in rupees` | Wrong unit for a known label. |
| `printed_page is missing` | Add it. A page with no printed number is `"unnumbered"`. |
| `basis is not labelled`, `cannot carry basis` | Set `basis`; a standalone-statements row cannot be consolidated. |
| `does not parse as a financial year`, `later than the report` | `fy` is the year of the figure (`FY25` for a comparative), `report_fy` the report it came from. |
| `duplicate of line` | Same label twice: if they are different things (stage, bucket, party, side of the balance sheet) set `dimension`; otherwise remove one. |
| `already in the data room` | The rows were appended before. Do not append again. |
| `restructured-book item` | Remove the row; mention the disclosure's presence in the reply. |
| `value` null without `note` (schema) | A null value needs a note saying what the report printed ("stated as Nil"). |
| warning `restated or regrouped comparative` | Set `restated: true`, find and quote the explanation. |
| warning `implausibly large` | Check the unit conversion. |
| warning `no normalised label` | Expected for the company's own sub-lines. |
