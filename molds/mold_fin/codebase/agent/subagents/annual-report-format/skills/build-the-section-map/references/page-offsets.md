# Printed page versus PDF page

`page_offset.py` fits segments of the form `printed = a x pdf_page + b`. `a` is 1 for ordinary pages and 2 when the
report was exported as double-page spreads. For `a = 1` it also prints `offset`, where `PDF page = printed + offset`.

## The patterns

| What the report does | What the samples look like | What the script reports |
|---|---|---|
| Cover and inside cover unnumbered, body numbered from 1 | `1:cover, 2:"", 3:1, 4:2` | one arabic segment, offset 2; pages 1-2 under `unnumbered` |
| Front matter in roman numerals, body restarts at 1 | `3:i, 4:ii, 9:1, 10:2` | a roman segment (offset 2) and an arabic segment (offset 8) |
| Unnumbered divider or advertisement pages between sections | `10:2, 20:12, 60:48, 70:58` | two arabic segments (offsets 8 and 12) and a note that pages were inserted. A printed page between the last sample of one segment and the first of the next (13-47 here) is **ambiguous** until another page in that stretch is sampled |
| Financial statements paginated afresh | `10:2, 20:12, 150:1, 160:11` | a note that numbering restarts. Printed page 5 exists twice; `--lookup 5` returns both candidates and no answer |
| Exported as spreads | `2:2, 3:4, 10:18` | `pages_per_pdf_page: 2`. PDF page = (printed - b) / 2 rounded down. Sample the LOWER number on each spread |
| A label misread (footnote number, a figure in a table footer) | `9:1, 10:2, 11:8, 12:4` | the odd sample is left out and named, with the label it expected |

## Sampling by hand

`section_map.py` samples the first 14 pages and then every 10th-20th page. When it reports an ambiguous stretch,
sample inside it. The label is the number printed in the header or footer, not a number in the text:

```
python3 - <<'PY'
import pdfplumber
with pdfplumber.open("/workspace/in/FY26_annual-report.pdf") as pdf:
    for n in (21, 30, 40, 50):
        lines = [l for l in (pdf.pages[n-1].extract_text() or "").splitlines() if l.strip()]
        print(n, "| first:", lines[:1], "| last:", lines[-2:])
PY
python3 /workspace/scripts/page_offset.py --pairs "10:2,20:12,30:22,40:28,60:48" --page-count 320 --lookup 25
```

## Rules

- Never state a PDF page computed from an offset as `found`. It is `unconfirmed` until the heading is seen on it.
- Never carry an offset from last year's report.
- When numbering restarts, cite figures as "printed page 12 (financial statements), PDF page 161".
- A page with no printed number (a divider, a full-page table turned sideways) is cited as `unnumbered` plus its PDF page.
