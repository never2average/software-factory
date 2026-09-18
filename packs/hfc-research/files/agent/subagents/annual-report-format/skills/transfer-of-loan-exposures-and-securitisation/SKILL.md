---
description: Use when extracting loans assigned or transferred (sell down) and loans acquired (buy out), direct assignment, co-lending, pass-through certificates (PTC) or securitisation volumes and retained interest from an annual report, or when that disclosure cannot be found or says nil.
---

# Transfer of loan exposures and securitisation

The analysts' definitions (rulebook, `hfc-kpi-extraction/schemas/kpi-spec.md`):

- **Sell down**: loans transferred or assigned, moved off the balance sheet.
- **Buy out**: loans acquired, brought onto the balance sheet.
- If AUM equals the loan book there are no off-book loans, so no sell down is expected. A missing or nil disclosure
  is then consistent, and is reported as such, not as a gap.

## How to recognise the disclosure

It is a note-level disclosure with no place on the contents page. The map key is `transfer_of_loan_exposures`; when
the map says `not_found`, search by hand before reporting absence. It usually sits in one of these places:

| Place | Heading wording |
|---|---|
| Its own note near the end of the notes | "Disclosure pursuant to the Master Direction - Transfer of Loan Exposures"; "Details of loans transferred / acquired" |
| Inside the RBI HFC Directions disclosure block | "Securitisation"; "Details of assignment transactions"; "Details of financial assets sold to securitisation / reconstruction company"; "Details of non-performing financial assets purchased / sold" |
| Inside the Loans note or the financial-instruments note | "Transferred financial assets that are not derecognised in their entirety" (securitisation kept on the balance sheet); "... derecognised in their entirety" (direct assignment) |
| The P&L note on "Net gain on derecognition of financial instruments under amortised cost category" | The income side of assignments |

Hand search of the statements' range when the map has nothing:

```
python3 - <<'PY'
import pdfplumber, re
first, last = 158, 269          # standalone_financial_statements from map.json
pat = re.compile(r"assign|securitis|securitiz|transfer of loan|co-?lend|pass[- ]through|\bPTC", re.I)
with pdfplumber.open("/workspace/in/FY26_annual-report.pdf") as pdf:
    for n in range(first, last + 1):
        for line in (pdf.pages[n-1].extract_text() or "").splitlines():
            if pat.search(line): print(n, "|", line[:140])
PY
```

## The four structures, and which side they fall on

| Structure | What happens | Sell down / buy out | On or off the balance sheet |
|---|---|---|---|
| Direct assignment (DA) | A pool is sold to a bank or another lender; the seller keeps a minimum retention and services the loans | Seller: sell down. Buyer: buy out | Assigned share is derecognised by the seller; the retained share stays |
| Co-lending | A loan is originated jointly with a bank in an agreed ratio | The partner's share is off the HFC's book from the start. Report it as co-lending, separately from assignment; say how the report labels it | HFC's share on book |
| Securitisation (PTC) | Pool sold to a trust that issues pass-through certificates; the seller often gives credit enhancement | Report as securitisation. Often **not derecognised** under Ind AS: the loans stay on the book with a matching liability, so it is not a sell down in the analysts' sense unless the report says the assets were derecognised | Usually on book |
| Sale to an asset reconstruction company / stressed-loan transfer | NPA sold | Report separately as stressed-loan transfer | Off book |
| Loans acquired (DA inward, pool buyout, portfolio purchase) | | Buy out | On book |

Report the company's structure in the company's words, then say which of the analysts' two headings it falls
under. Where that is not clear from the report, say so; do not decide.

## Procedure

1. Locate every place in the table above; list them with pages.
2. Extract each table as printed. The usual fields for loans **not in default** transferred or acquired: aggregate
   amount (count of accounts where given), weighted average residual maturity, weighted average holding period,
   retention of beneficial economic interest, tangible security coverage, rating-wise distribution. For
   securitisation: number of SPEs, outstanding securitised assets, exposures retained (first loss, second loss,
   investment in PTCs), credit enhancement. Follow the headings in the document if they differ from these.
3. **Retained interest**: the retention percentage and amount; for securitisation the credit enhancement and PTC
   investment. Quote the accounting-policy sentence on derecognition.
4. **Off-book AUM**: if the report states assigned or co-lent assets outstanding at year end, extract that: it is
   the bridge between loan book and AUM.
5. **Nil disclosures**: "The Company has not transferred or acquired any loan exposures during the year" is a
   finding. Write a row with `value: null` and `note: "stated as Nil"` (or `value: 0` if the table prints 0), and
   quote the sentence.
6. Stitch tables that span pages, convert to crore, write rows with `section: "transfer_of_loan_exposures"`,
   `statement: "note"`, `dimension` naming the structure and direction (`direct_assignment | transferred`,
   `direct_assignment | acquired`, `co_lending`, `securitisation_ptc`, `stressed_loans | transferred`), then validate:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/transfer.pages.json
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`.../{fy}_annual-report/transfer-of-loan-exposures.md`: where the disclosures were found; one table per structure
and direction, both years; retained interest; off-book outstanding; income recognised on derecognition; quoted
policy; and a closing two lines "Sell down (analysts' definition): ..." and "Buy out: ...", each with its source.

## Worked example

Example Housing Finance Ltd FY26, Note 50, printed page 243 (PDF 251), "(Rs. in crore)":

| Loans not in default transferred through assignment | FY 2025-26 | FY 2024-25 |
|---|---|---|
| Aggregate amount of loans transferred | 820.00 | 640.00 |
| Weighted average residual maturity (months) | 168 | 172 |
| Weighted average holding period (months) | 14 | 13 |
| Retention of beneficial economic interest | 10% | 10% |
| Tangible security coverage | 100% | 100% |

"The Company has not acquired any loan exposures during the year." The MD&A (printed p. 66) says assigned assets
outstanding were Rs. 1,640 crore at March 31, 2026; the P&L shows net gain on derecognition of 31.05 crore.

Rows: `label` "Aggregate amount of loans transferred", `dimension` "direct_assignment | transferred", value 820.0
crore; retention 10 `percent`; residual maturity 168 `months`; and for buy out `value: null`, `note: "stated as
Nil: 'The Company has not acquired any loan exposures during the year' "`. Closing lines: sell down FY26 Rs. 820
crore (direct assignment, Note 50); buy out nil. Loan book 12,263.20 + assigned outstanding 1,640.00 is consistent
with an AUM above the loan book, which is what a sell down implies.

More on telling the structures apart: [references/structures-and-nil-cases.md](references/structures-and-nil-cases.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| Nothing found by the map or by the hand search | "No disclosure on transfer of loan exposures, assignment or securitisation was found in the standalone notes (PDF pages a-b searched for: assign, securitis, transfer of loan, co-lend, PTC)." Add whether AUM and loan book are equal in the report, if it states both. |
| Securitisation present but the report does not say whether assets were derecognised | Report the volumes as securitisation; do not classify them as sell down; say the report is silent. |
| Only year-end outstanding given, no volume for the year | Report the outstanding; say the year's volume is not disclosed. Never derive volume from two year-ends. |
| Restructured or resolution-framework tables nearby | Leave out; mention presence. |
