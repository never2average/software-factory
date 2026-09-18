# Staging and ECL tables: shapes and inputs (synthetic)

## Columns are stages

| Particulars | Stage 1 | Stage 2 | Stage 3 | Total |
|---|---|---|---|---|
| Gross carrying amount | 11,800.00 | 420.00 | 180.00 | 12,400.00 |
| Less: Impairment loss allowance | (35.40) | (29.40) | (72.00) | (136.80) |
| Net carrying amount | 11,764.60 | 390.60 | 108.00 | 12,263.20 |

```json
{"fy": "FY26", "basis": "standalone", "unit_header": "(Rs. in crore)", "printed_page": "196", "pdf_page": 204,
 "gross": {"Stage 1": "11,800.00", "Stage 2": "420.00", "Stage 3": "180.00", "Total": "12,400.00"},
 "ecl":   {"Stage 1": "(35.40)", "Stage 2": "(29.40)", "Stage 3": "(72.00)", "Total": "(136.80)"}}
```

## Product by stage, with POCI and a restructured row

```json
{"fy": "FY26", "basis": "standalone", "unit": "crore", "rows": [
  {"label": "Housing loans - Stage 1", "gross": "9,000.00", "ecl": "27.00"},
  {"label": "Non-housing loans - Stage 1", "gross": "2,800.00", "ecl": "8.40"},
  {"label": "Lifetime ECL - not credit impaired", "gross": "420.00", "ecl": "29.40"},
  {"label": "of which restructured under Resolution Framework 2.0", "gross": "60.00", "ecl": "6.00"},
  {"label": "Lifetime ECL - credit impaired", "gross": "180.00", "ecl": "72.00"},
  {"label": "Purchased or originated credit impaired", "gross": "10.00", "ecl": "4.00"},
  {"label": "Total", "gross": "12,410.00", "ecl": "140.80"}]}
```

The "of which" row is dropped and listed under `excluded_restructured`. Because it is an "of which" row, the total
still foots. When a restructured row is a separate line that the total includes, the table will not foot without it:
the script says so, and the reply reports the staging as printed, the total as printed, and that the difference is
the restructured line that was left out.

## Movement of ECL allowance (extract as a table; no script computes it)

| Particulars | Stage 1 | Stage 2 | Stage 3 | Total |
|---|---|---|---|---|
| Opening balance | 30.10 | 26.80 | 64.00 | 120.90 |
| New assets originated or purchased | 9.20 | 0.60 | 0.10 | 9.90 |
| Assets derecognised or repaid (excluding write-offs) | (4.10) | (3.00) | (5.50) | (12.60) |
| Transfers to Stage 1 | 2.40 | (2.10) | (0.30) | - |
| Transfers to Stage 2 | (1.60) | 2.90 | (1.30) | - |
| Transfers to Stage 3 | (0.60) | (3.20) | 3.80 | - |
| Impact of changes in credit risk / remeasurement | - | 7.40 | 22.40 | 29.80 |
| Amounts written off | - | - | (11.20) | (11.20) |
| Closing balance | 35.40 | 29.40 | 72.00 | 136.80 |

Checks to make by eye: each transfer row nets to nil across stages; the closing row equals the staging table's ECL
column (35.40 / 29.40 / 72.00 / 136.80). Rows for the data file: `statement: "ecl_movement"`, `label` as printed,
`dimension` such as `stage_3`, one row per cell you are asked for (normally closing balances and write-offs).

## Wording seen for the same things

| Meaning | Wordings |
|---|---|
| ECL allowance | Impairment loss allowance; Allowance for expected credit loss; Provision for expected credit loss; Loss allowance; ECL provision |
| Gross carrying amount | Gross carrying amount; Gross loans; Gross exposure; Exposure at default (not the same: includes undrawn commitments) |
| Stage 3 | Credit impaired; Non-performing; Lifetime ECL - credit impaired; "Stage III" |
| SICR | Significant increase in credit risk; SICR; "more than 30 days past due" |
