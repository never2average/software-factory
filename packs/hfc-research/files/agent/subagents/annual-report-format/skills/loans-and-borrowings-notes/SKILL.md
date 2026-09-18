---
description: Use when extracting the Loans note (loan book by product, by security, by geography and sector) or the borrowings notes (debt securities, borrowings other than debt securities, deposits, subordinated liabilities) including NHB refinance, bank term loans, NCDs, commercial paper, public deposits, ECB, and their maturity and interest-rate bands.
---

# Loans and borrowings notes

## How to recognise them

- **Loans note** (map key `loans_note`): headed "Loans" or "Loans (at amortised cost)". It normally presents the
  same total three times: (A) by product or type, (B) by security, (C) by geography and sector (in India: public
  sector / others; outside India). Each block runs Gross, less impairment loss allowance, Net. Net equals the
  balance sheet's Loans line.
- **Borrowings notes** (map key `borrowings_notes`): up to four separate notes, one per balance-sheet line: "Debt
  securities", "Borrowings (other than debt securities)", "Deposits", "Subordinated liabilities". Each shows the
  instruments at amortised cost, then in India / outside India, then secured / unsecured, followed by **terms of
  repayment** tables (maturity bands by interest-rate bands) and the security details. The terms tables are long and
  almost always span pages.

Instrument names to look for, and the normalised labels the script gives them, are in
[references/instrument-labels.md](references/instrument-labels.md).

## Procedure

1. Go to the map's pages. `borrowings_notes` records the first of the four notes; the others follow it directly.
2. Extract each table; stitch those that span pages and name the pages:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/borrowings-terms.pages.json > /workspace/out/borrowings-terms.table.json
   ```

3. Normalise the instrument tables (`"statement": "loans_note"` or `"borrowings_note"`, `"section":
   "loans_and_borrowings_notes"`):

   ```
   python3 /workspace/scripts/normalise_statement.py /workspace/out/borrowings.rows.json > /workspace/out/borrowings.norm.json
   ```

4. **Loan book by product.** Keep the company's product names exactly (home loans, loans against property,
   construction or developer finance, lease rental discounting, top-up, others). Product names are not normalised:
   companies draw the lines differently, and the analysts compare them knowingly. Use `dimension` for the product.
5. **By security.** Secured by tangible assets (equitable mortgage of property), secured by other assets, covered by
   guarantees, unsecured.
6. **Borrowings by instrument.** NHB refinance, term loans from banks, from financial institutions, NCDs (secured /
   unsecured; public issue / private placement), commercial paper, public deposits and other deposits, ECB,
   subordinated debt, securitisation liabilities, working capital / cash credit. Sum nothing the report does not sum.
7. **Maturity and rate bands.** Extract the terms-of-repayment tables as printed: the bands differ by company
   ("0-1 year, 1-3 years, 3-5 years, above 5 years"; rate bands "7.00%-8.00%" and so on). Do not re-bucket. Use
   `dimension` like `"term loans from banks | 1-3 years | 8.01%-9.00%"` for rows.
8. Cross-check: Net loans = balance sheet `loan_book`; each borrowings note's total = its balance sheet line. If a
   total differs, report both with pages.
9. Leave out restructured-loan sub-tables in the Loans note; say they are there.
10. Validate rows before appending:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`.../{fy}_annual-report/loans-and-borrowings-notes.md`: loans by product, by security, by geography; each borrowings
note's instrument table; the terms tables; security and covenant sentences quoted (asset cover, negative lien, NHB
refinance security); pages cited; stitched pages named.

## Worked example

Example Housing Finance Ltd, Note 14 "Borrowings (other than debt securities)", printed pages 205-206 (PDF 213-214),
"(Rs. in crore)":

| At amortised cost | March 31, 2026 | March 31, 2025 |
|---|---|---|
| Term loans from banks | 4,000.00 | 3,500.00 |
| Refinance from National Housing Bank | 1,250.50 | 1,100.00 |
| Term loans from financial institutions | 300.00 | 250.00 |
| Liability against securitised assets | 449.50 | 150.00 |
| Total | 6,000.00 | 5,000.00 |

Normalised labels: `term_loans_from_banks`, `refinance_from_nhb`, `term_loans_from_financial_institutions`,
`securitisation_liabilities`. The total, 6,000.00 crore, equals the balance sheet's "Borrowings (other than debt
securities)" line in the `financial-statements-division-iii` example. The terms-of-repayment table for bank term
loans starts on printed page 205 and continues on 206: `stitch_tables.py` reports "Table stitched from pdf pages
213-214", dropping the repeated header and the "Total c/f" / "Total b/f" rows.

The Loans note's block (A): Housing loans 9,620.00; Loans against property 2,110.00; Construction finance 670.00;
Total gross 12,400.00; Less: impairment loss allowance 136.80; Total net 12,263.20 (crore). These reconcile to the
staging example: gross 12,400.00 and ECL 136.80.

## Failure modes and what to report

| Situation | Report |
|---|---|
| The label "Borrowings" alone (no "other than debt securities") | The script maps it to `borrowings_other_than_debt_securities`. If the company uses one "Borrowings" line for everything, say so: the four-way split is then not available from the balance sheet. |
| A line containing "National Housing Bank" that is not refinance (for example a deposit with NHB on the assets side) | The pattern is for the borrowings note only. Anywhere else keep the label as printed. |
| Interest-rate bands not given, only a range in a sentence | Quote the sentence. |
| Terms table split column-wise over two pages | `stitch_tables.py` handles row-wise continuation only. Extract the two halves as separate tables and say so. |
| Public deposits absent | Normal for a non-deposit-taking HFC. Say the company shows no deposits line. |
