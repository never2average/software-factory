---
description: Use when asked to compare an annual-report section or schedule across two or more financial years - the same section on the same basis - or when comparatives are restated, regrouped or reclassified, an accounting policy changed, or a disclosure is presented differently from last year.
---

# Multi-year comparison

The rule: **compare the same section on the same basis. Call out restated comparatives and any change in
accounting policy or in the way a disclosure is presented.** A comparison that hides a restatement is worse than none.

## How to recognise what needs calling out

| Signal | Where | Meaning |
|---|---|---|
| "(Restated)", "Restated - refer note X" under a column head | Statements | The comparative differs from what last year's report printed |
| "Previous year's figures have been regrouped / reclassified wherever necessary" | Last note, or a statement footnote | Presentation change; amounts moved between lines. Usually no list of what moved |
| A third balance sheet column "As at April 1, 20XX" | Balance sheet | Retrospective restatement |
| Note on "Changes in accounting policies", "Prior period errors", "Ind AS 8" | Accounting policies / a late note | Policy change or error correction, with amounts |
| New standard or amendment adopted; change in ECL model, staging or write-off policy; change in estimate | Accounting policies; credit risk note | Affects comparability even without restatement |
| A line present in one year only; a note renumbered or split; buckets changed | Anywhere | Presentation change |
| Merger, demerger, acquisition of a portfolio or subsidiary | Board's Report; business combination note | Year-on-year change is not organic |
| Regulatory basis changed (NHB Directions to RBI Directions; new disclosure formats) | RBI disclosures | Tables are not like for like: say so |

Wording to search for is in [references/restatement-wording.md](references/restatement-wording.md).

## Procedure

1. Both years' reports need maps and extracted rows. If a year is missing from the data room, say so; the orchestrator
   can ask `lodr-filings`. Do not compare from the comparative column alone without saying that is what you did.
2. Fetch `Companies/{company_id}/filings/annual-report-data.jsonl` to the sandbox and run:

   ```
   python3 /workspace/scripts/compare_years.py /workspace/in/annual-report-data.jsonl --fy FY26 --prior FY25 \
     --basis standalone --section standalone_financial_statements
   ```

   For each line it gives `current` (FY26 in the FY26 report), `comparative` (FY25 as printed in the FY26 report),
   `first_reported` (FY25 as printed in the FY25 report), the change against the comparative (same report, same
   presentation), and `restated` when comparative and first-reported differ or the row is marked restated. Percent
   rows change in percentage points. Standalone is never compared with consolidated.
3. For every line in `restated_lines`: find the note that explains it, quote it with pages. If the report gives no
   explanation beyond the regrouping sentence, quote that sentence and say no detail is given.
4. For `new_lines` and `dropped_lines`: say whether the item is new business, or the same amounts presented
   differently (look at where the amount sat last year). If you cannot tell, say so.
5. For `relabelled_lines`: give both labels.
6. For text sections (MD&A, Board's Report, auditor's report) compare by the same sub-heading: what is new, what
   was dropped, what changed in wording on policies (SICR, default, write-off), auditor's remarks added or removed,
   KAMs added or removed. Quote both years.
7. More than two years: run the script per adjacent pair. Build the series from each year's **own report**, and show
   restated values as a second row, not as replacements.
8. New rows added during this work are validated before appending, with `--existing` so restatements surface:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl \
     --existing /workspace/in/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write (output shape)

`.../{fy}_annual-report/comparison-{prior}-to-{fy}-{section-slug}.md`:

1. Scope line: section, basis, years, which reports were used.
2. **Call-outs first**: restatements (line, first reported, as restated, difference, quoted explanation); policy
   changes; presentation changes; non-organic events.
3. The table: line (company's label, normalised label), FY25 first reported, FY25 as per FY26 report, FY26, change,
   change %, pages. Amounts in crore.
4. Lines in one year only.
When a formatted deliverable is asked for, pass the same content to `render_account_report`.

## Worked example

Example Housing Finance Ltd, standalone balance sheet, FY25 to FY26.

| Line | FY25 first reported | FY25 per FY26 report | FY26 | Change | Change % |
|---|---|---|---|---|---|
| Loans (`loan_book`) | 10,100.00 | 10,111.21 (restated) | 12,345.68 | 2,234.47 | 22.10% |
| Investments | 640.00 | 640.00 | 800.00 | 160.00 | 25.00% |
| Right-of-use assets | - | - | 45.00 | new line | |
| Goodwill | 3.00 | - | - | dropped line | |
| CRAR (RBI disclosures) | | 23.10% | 21.40% | -1.70 pp | |

Call-out: "Loans as at March 31, 2025 were Rs. 10,100.00 crore in the FY25 report and are Rs. 10,111.21 crore in the
FY26 report's comparative column (difference Rs. 11.21 crore). Note 58 (printed p. 259, PDF p. 267): 'Securitised
loans of Rs. 11.21 crore previously derecognised have been recognised ... comparative figures have been restated.'
The label also changed from 'Loans (at amortised cost)' to 'Loans'." The change of 2,234.47 is measured against the
restated comparative.

## Failure modes and what to report

| Situation | Report |
|---|---|
| Only one year's report in the data room | Compare current with the comparative column only, and say restatements cannot be detected without the earlier report. |
| Units differ between years (lakh then crore) | No issue: rows are stored in crore. The script refuses to compare a line whose `unit` differs between years (amount versus percent) and lists it. |
| Basis differs (company had no subsidiaries last year, consolidated this year) | Compare standalone with standalone; say consolidated statements are new this year. |
| Script reports duplicates | Run `validate_ar_data.py` on the file and report; do not compare from a file with duplicates. |
| FY changed length (a 15-month period) | Say so at the top; flows are not comparable, balances are. |
