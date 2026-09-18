# Worked example: Example Housing Finance Ltd, FY26 (synthetic)

## Inputs

Contents page as extracted (PDF page 3):

```
Contents
Corporate Overview
Corporate Information ........................................ 2
Chairman's Message . . . . . . . . . . . . . . . . . . . 4
Statutory Reports
Notice of the 28th Annual General Meeting .................... 12
Board's Report ............................................... 30
Management Discussion and
Analysis ..................................................... 62
Report on Corporate Governance ............................... 78
Business Responsibility & Sustainability Report .............. 104
Financial Statements
Standalone Financial Statements
Independent Auditor's Report ................................. 150
Balance Sheet ................................................ 164
...
Consolidated Financial Statements
Independent Auditor's Report ................................. 262
Consolidated Balance Sheet ................................... 270
Form AOC-1 ................................................... 340
```

What the parser does with it:

- "Contents", "Corporate Overview", "Statutory Reports", "Financial Statements": headers, not entries.
- "28th" and "AOC-1" are protected phrases, so 28 and 1 are not read as page numbers.
- "Management Discussion and" has no page; it is joined to "Analysis ... 62" on the next line.
- "Standalone Financial Statements" has no page: it is a group header, and it takes the page of its first item (150).
- The first "Independent Auditor's Report" follows the standalone header, so it is the standalone one; the second
  follows the consolidated header.

A two-column contents page flattened by text extraction is handled the same way:
`Corporate Information 2 Standalone Financial Statements 150` gives two entries. So is a page-first layout
(`14 Directors' Report`), and serial-numbered entries (`2. Directors' Report 10`).

Sampled labels: `[[1,"cover"],[2,""],[3,"i"],[4,"ii"],[9,"1"],[10,"2"],[60,"52"],[200,"192"],[350,"342"]]`

## Output (abridged)

| Section | Printed | PDF | Found by | Confidence |
|---|---|---|---|---|
| Corporate information | 2-3 | 10-11 | contents | found |
| Notice of the AGM | 12-29 | 20-37 | contents | unconfirmed |
| Board's / Directors' Report | 31-61 | 39-69 | contents | found (heading one page later than implied) |
| Management Discussion and Analysis | 62-77 | 70-85 | contents | found |
| Standalone financial statements | 150-261 | 158-269 | contents | unconfirmed (group header) |
| - Independent Auditor's Report (standalone) | 150-163 | 158-171 | contents | found |
| - Balance sheet (standalone) | 164 | 172 | contents | found |
| - Note: Loans | 192 | 200 | heading search | found |
| - Related-party transactions | 232 | 240 | heading search | found |
| - RBI HFC Directions disclosures | 247 | 255 | heading search | found |
| - Transfer of loan exposures | | | none | not_found |

The transfer-of-loan-exposures note was not matched. Before reporting it absent, search the statements' range for
"assignment" and "securitis" by hand (see the `transfer-of-loan-exposures-and-securitisation` skill): a nil
disclosure is often one sentence inside the RBI disclosure block, without a heading of its own.
