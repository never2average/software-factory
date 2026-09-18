---
description: Use when asked to extract the Board's / Directors' Report or any of its annexures - financial summary, dividend, transfer to statutory reserve under s.29C of the NHB Act, capital or debt raised, changes in directors and KMP, subsidiaries, Form AOC-2, secretarial audit report (MR-3), CSR report, particulars of employees, conservation of energy.
---

# Board's / Directors' Report and its annexures

The Board's Report is 20-60 pages of prose with one or two small tables, followed by lettered or numbered annexures.
It is read by sub-heading, not from top to bottom.

## How to recognise its parts

Take the page range from the map (`directors_report`, and the sub-sections `aoc_2`, `secretarial_audit_report`,
`csr_report`, `particulars_of_employees`, `conservation_of_energy`, `aoc_1` when the map found them). Pull the text
of that range only:

```
python3 - <<'PY'
import pdfplumber, json
first, last = 39, 69            # pdf pages from map.json
with pdfplumber.open("/workspace/in/FY26_annual-report.pdf") as pdf:
    pages = {n: pdf.pages[n-1].extract_text() or "" for n in range(first, last + 1)}
json.dump(pages, open("/workspace/out/directors-report.pages.json", "w"))
print({n: len(t) for n, t in pages.items()})     # a page with < 40 characters is an image: load scanned-or-image-reports
PY
```

Then find the sub-headings. The usual ones, with what the analyst needs from each, are in
[references/what-to-extract.md](references/what-to-extract.md). The annexure list, usually a paragraph or table near
the end of the report proper, tells you which annexure letter is which.

## Procedure

1. **Financial summary / financial highlights / financial results.** A small table, current and previous year,
   often standalone and consolidated side by side. Extract it as a table, read the unit from its header, and
   normalise it:

   ```
   python3 /workspace/scripts/normalise_statement.py /workspace/out/financial-summary.rows.json
   ```

   Use `"statement": "profit_and_loss"` and `"section": "directors_report"`. Labels the table invents ("Profit
   available for appropriation") stay as printed and are listed as unknown: that is correct.
2. **Dividend.** Quote the sentence: rate per share, face value, interim or final, subject to shareholders'
   approval or not. A per-share figure is `unit: "rupees"`. "The Board has not recommended any dividend" is a fact to quote.
3. **Transfer to reserves.** Quote the sentence or table row for the transfer to the statutory reserve under section
   29C of the NHB Act, and for the special reserve under section 36(1)(viii) of the Income-tax Act where the report
   shows it. Companies present these together or apart: keep the company's split. If the report's wording or section
   numbers differ, follow the report and say so.
4. **Capital and debt raised.** Equity issued (preferential, rights, QIP, ESOP allotments), NCDs issued (public or
   private placement), commercial paper, NHB refinance sanctioned or drawn, ECB, securitisation or assignment done
   in the year, credit ratings and any rating change. Amounts to crore.
5. **Directors and KMP.** Appointments, re-appointments, resignations, cessations, with names, designations and
   dates as printed.
6. **Subsidiaries, associates, joint ventures.** Names and changes; or the sentence saying there are none (this
   also explains a missing consolidated set).
7. **Annexures.** For each annexure present, extract per the reference. Two need care:
   - **AOC-2**: load `related-parties-and-aoc2`.
   - **Secretarial audit report (MR-3)**: quote every observation, qualification or "subject to the following";
     otherwise quote the clean-report sentence. Do not summarise a qualification away.
8. Quote the sentences that carry a fact or a commitment, with printed and PDF page. Summarise the rest in a few
   lines. Do not editorialise. Leave out anything about the restructured book (say only that the report has it).
9. Validate any rows before appending (`validate-and-write` skill):

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`Customers/{customer_id}/filings/lodr/{fy}_annual-report/directors-report.md`, with one heading per item above, each
fact followed by `(printed p. 33, PDF p. 41)`. Rows for the financial summary, dividend per share and capital raised
go to `annual-report-data.jsonl` with `section: "directors_report"`.

## Worked example

Example Housing Finance Ltd, FY26 Board's Report, printed pages 31-61.

Financial summary table, header "(Rs. in lakh)", standalone columns:

| Particulars | FY 2025-26 | FY 2024-25 |
|---|---|---|
| Total income | 1,65,432.10 | 1,38,210.55 |
| Profit before tax | 32,110.40 | 26,480.25 |
| Profit after tax | 25,012.30 | 20,655.10 |
| Transfer to statutory reserve u/s 29C of the NHB Act | 5,002.46 | 4,131.02 |

`normalise_statement.py` returns total income 1,654.321 crore and PAT 250.123 crore for FY26, and recognises the
last row as `transfer_to_statutory_reserve` (50.0246 crore). A row such as "Balance carried forward to next year"
would come back under `unknown_labels` and be written as printed with `normalised_label: null`. That is correct;
do not invent a normalised label for it.

Extract, as written to `directors-report.md`:

> **Dividend.** "The Board has recommended a final dividend of Rs. 4.50 per equity share of face value Rs. 10 each
> for the financial year 2025-26, subject to the approval of the members." (printed p. 32, PDF p. 40)
>
> **Statutory reserve.** "An amount of Rs. 50.02 crore has been transferred to the Statutory Reserve pursuant to
> Section 29C of the National Housing Bank Act, 1987." (printed p. 32, PDF p. 40)

## Failure modes and what to report

| Situation | Report |
|---|---|
| The financial summary shows standalone and consolidated side by side | Extract the standalone columns (the analysts' rule); name the columns you took. Consolidated only when asked, labelled. |
| Unit differs from the statements (summary in crore, statements in lakh) | Normal. Read each table's own header. |
| An annexure is referred to but not in the PDF ("available on the website") | Say so, with the sentence and page. Common for particulars of employees. |
| The annexure pages are scanned | Load `scanned-or-image-reports`; never report "no observations" from an unreadable secretarial audit report. |
| The report gives a figure only in a chart | Say it is shown only in a chart on that page; do not read values off a chart. |
