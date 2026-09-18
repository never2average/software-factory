# Worked examples (synthetic: Example Housing Finance Ltd)

## 1. A P&L that spans two pages

Pages JSON given to `stitch_tables.py`:

```json
{"pages": [
  {"pdf_page": 173, "printed_page": "165",
   "header": ["Particulars", "Note", "Year ended March 31, 2026", "Year ended March 31, 2025"],
   "rows": [["Revenue from operations", "", "", ""],
            ["(i) Interest income", "24", "1,52,300.40", "1,27,900.15"],
            ["(ii) Fees and commission income", "25", "6,210.30", "5,100.20"],
            ["(iii) Net gain on derecognition of financial instruments under amortised cost category", "26", "3,105.00", "2,480.00"],
            ["Total revenue from operations", "", "1,61,615.70", "1,35,480.35"]]},
  {"pdf_page": 174, "printed_page": "166",
   "header": ["Particulars (Contd.)", "Note", "Year ended March 31, 2026", "Year ended March 31, 2025"],
   "rows": [["Expenses", "", "", ""],
            ["(i) Finance costs", "28", "98,450.10", "82,300.00"],
            ["(iv) Impairment on financial instruments", "29", "4,120.55", "(310.20)"],
            ["Profit for the year", "", "25,012.30", "20,655.10"]]}]}
```

Result: `stitched: true`, `pdf_pages: [173, 174]`, 9 rows, `repeated_headers_dropped_on: [174]`, and the sentence
"Table stitched from pdf pages 173-174." Each row keeps the page it came from, so every data row cites the right page.

Pass the result's `rows` to `normalise_statement.py` with `"unit_header": "(Rs. in Lakhs)"`, `"statement":
"profit_and_loss"`, `"basis": "standalone"` and two columns. The note column is recognised because each row has one
more cell than there are value columns. `(310.20)` becomes -3.102 crore: a write-back of impairment in FY25.

## 2. Restated comparatives

The FY26 balance sheet heads its second column "As at March 31, 2025 (Restated - refer note 58)". Note 58 explains
that certain securitised loans, previously derecognised, have been brought back on the balance sheet.

- Pass the column as `{"label": "As at March 31, 2025", "restated": true}`.
- Every FY25 row from this report carries `"fy": "FY25", "report_fy": "FY26", "restated": true`.
- In the extract, quote the sentence of note 58 that says what was restated and by how much, with its pages.
- If the FY25 report is also in `annual-report-data.jsonl`, `validate_ar_data.py --existing` warns wherever the FY25
  figure differs between the two reports, and `compare_years.py` lists the restated lines (`multi-year-comparison` skill).

A third balance sheet column ("As at April 1, 2024") is the restated opening position. Its `fy` is FY24. Extract it
only if asked; say that it exists.

## 3. Statement in millions

Header "(Rs. in millions)". Interest income 15,000.0 becomes 1,500.00 crore (millions / 10). Basic EPS 27.45 stays
27.45 with `unit: "rupees"`. `original_value` and `original_unit` are kept on every converted row so the conversion
can be checked: `validate_ar_data.py` recomputes it.
