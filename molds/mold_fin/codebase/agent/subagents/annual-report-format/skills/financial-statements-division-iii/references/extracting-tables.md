# Getting a statement table off a page

```
python3 - <<'PY'
import pdfplumber, json
PDF, pages = "/workspace/in/FY26_annual-report.pdf", [173, 174]      # pdf pages of the P&L, from map.json
out = []
with pdfplumber.open(PDF) as pdf:
    for n in pages:
        page = pdf.pages[n - 1]
        table = page.extract_table({"vertical_strategy": "text", "horizontal_strategy": "text"}) or []
        rows = [[(c or "").strip() for c in r] for r in table if any((c or "").strip() for c in r)]
        out.append({"pdf_page": n, "printed_page": None, "header": None, "rows": rows})
        print(n, len(rows), "rows; widths:", sorted({len(r) for r in rows}))
json.dump({"pages": out}, open("/workspace/out/standalone-pnl.pages.json", "w"), ensure_ascii=False, indent=1)
PY
```

Then, by hand, in the JSON:

1. Set `printed_page` for each page (from the map's offsets or the page footer).
2. Move the column-head row into `header` on the first page (`["Particulars", "Note", "Year ended March 31, 2026",
   "Year ended March 31, 2025"]`). On later pages set `header` to the repeated head, or `null` when the page has none.
3. Remove the title, unit line and signature block rows: they are not table rows. Keep the unit line's text for
   `unit_header`.
4. Rows whose label wrapped onto two lines come out as two rows, the first with no values. Join them into one
   label. (A label-only row that is a genuine sub-heading, like "Financial assets", stays.)

If the widths printed differ between pages, fix that before stitching: the usual cause is the empty Note column
being dropped on a page where no row has a note reference. Insert the empty column; do not delete it elsewhere.

Negative numbers are printed in brackets, a dash means nil, and Indian digit grouping is used (`12,34,567.80`). Leave
all of that as printed: `normalise_statement.py` parses it through `finlib.numbers`.
