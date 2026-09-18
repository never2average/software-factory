# Worked examples (synthetic, Example Housing Finance Ltd)

## 1. Quarter column present: no derivation

Results table headers: `Quarter ended 30.09.2025 | Quarter ended 30.06.2025 | Quarter ended 30.09.2024 | Half year
ended 30.09.2025 | Half year ended 30.09.2024 | Year ended 31.03.2025`. Profit after tax row: `7,500 | 7,100 | 6,200 |
14,600 | 12,000 | 26,400` (₹ in lakhs).

`derive_quarter.py --columns ... --target "Q2 FY26"` → `use_for_flows: 0`. PAT for Q2 FY26 = 7,500 lakh = ₹75.00
crore. The 14,600 is H1 and is ignored. Check: 7,500 + 7,100 = 14,600, which confirms the columns were read right.

## 2. Q4 from FY − 9M with mixed units

The Q4 FY26 presentation gives only "FY26 disbursements ₹74.6 bn". The Q3 FY26 presentation gave "9M FY26
disbursements ₹5,400 crore".

```
python3 /workspace/scripts/derive_quarter.py --kind flow --metric disbursements \
  --through "FY26" --through-value "74.6" --unit billion --before "9M FY26" --before-value "5,400" --before-unit crore
```

→ 7,460.00 − 5,400.00 = `2060.0` ₹ crore, period `Q4 FY26`.

Row: `value 2060.0`, `source "IP"`, `document` = the Q4 deck, `page_or_slide` = its slide,
`derived_from_cumulative true`, `status "ok"`, footnote = the script's text plus "9M FY26 from
Customers/example-hfl/filings/presentations/q3fy26-ip.pdf, slide 9."

## 3. Restated comparative

The Q2 FY26 results print H1 FY26 operating expenses 12,300 and, in the preceding-quarter column, Q1 FY26 6,050
"(restated, refer note 4)". The Q1 filing had originally shown 6,000. A Q2 column is printed (6,250), so nothing is
derived: use 6,250. If it were not printed: 12,300 − 6,050 = 6,250 with `--before-restated`, and the footnote reads
"... Q1 FY26 is the comparative restated in the current filing."

Never mix: current cumulative − ORIGINAL earlier figure would give 6,300, which includes the restatement effect of
another quarter.

## 4. Footnote wording

Use the script's sentence verbatim, then add the earlier document. Pattern:

> Q3 FY26 derived as 9M FY26 (5,400.00) minus H1 FY26 (3,500.00); the filing gives no discrete quarter figure. H1
> FY26 is the figure published in the earlier filing. H1 FY26 from <data-room path>, slide 9.

## 5. Things the script refuses, and what to do instead

| Attempt | Script says | Do this |
|---|---|---|
| `--kind balance --metric aum` | point-in-time figure, never subtract | use the as-at figure |
| `--kind flow --metric loan_book` | loan_book is a balance | same |
| `--kind ratio --metric nim_pct` | a ratio cannot be derived by subtraction | report the printed ratio with its period in the footnote, `needs_review` |
| `--through FY26 --before "H1 FY26"` | Q4 = FY minus 9M, but --before is H1 | get the 9M figure |
| `--through "9M FY26" --before "H1 FY25"` | wrong fiscal year | get H1 FY26 |
| `--through "Q2 FY26"` | already a discrete quarter | use as printed |
| `--through-value "-"` | blank | the quarter is `not_found` |
