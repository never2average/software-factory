# Layout variations catalogue

What `locate_results_sections.py` returns for each, and what you do. All examples are synthetic
("Example Housing Finance Ltd").

## A. Classic order, both bases, half-year

letter (1) -> review report S (2-3) -> results S (4) -> assets & liabilities S (5) -> cash flow S (6) -> notes (7) ->
review report C (8) -> results C (9) -> assets & liabilities C (10) -> Reg 52(4) annexure (11).

Use page 4. Loan book from page 5. Notes on page 7. Ratios on page 11.

## B. Consolidated first, auditor's reports at the end, quarter only

letter (1) -> results C with notes starting on the same page (2) -> results S (3) -> notes (4) -> report C (5) -> report S (6).

`sections` shows `results consolidated [2]`, `notes consolidated [2]`, `results standalone [3]`, `notes standalone [4]`.
`absent_as_expected: ["assets_liabilities", "cash_flow"]` because Q1 and Q3 filings do not carry them. Use page 3.
The first table in the file is NOT the one to extract.

## C. Side-by-side standalone and consolidated

One wide table headed "Statement of Standalone and Consolidated ... Results": one `results` section, `basis: both`.
The header has a top row "Standalone | Consolidated". Pass all header rows to `parse_results_columns.py`; roles are
resolved inside each basis, and `extract_results_lines.py` with `"basis": "standalone"` takes only those columns.
If the top row was lost in extraction the parser reports two discrete-quarter columns (`ambiguous`): re-extract the
header, do not assume the left block is standalone.

## D. Single-basis filing (no subsidiaries; most debt-listed HFCs)

Heading "Statement of Unaudited Financial Results for the quarter ended ...": `basis: unspecified`,
`single_basis_filing: true`, warning raised. Confirm from the auditor's report title or note 1. Write
`bases_in_filing: "single_unlabelled"`, `basis: "standalone"`, and a `basis_note` such as "Statement names no basis;
auditor's report p.2 is on 'financial results' of the Company only; no consolidated statement in the filing."

## E. Results table over two pages

The title repeats with "(continued)" or not at all. With the repeat: one section, `pages: [p, p+1]`. Without it: the
section still runs to the next heading. Extract both pages' rows into one `rows` list, each row carrying its own
page: `{"page": 5, "cells": [...]}`. Check the header is repeated on page 2 before assuming the same column order.

## F. Mixed units

Standalone in Rs lakh, consolidated in Rs crore, annexure ratios with "Net worth (Rs. in crore)". Each section
reports its own `unit`. `extract_results_lines.py` takes the unit of the table it is given. A disclosure row taken
from a different section carries its own `unit_reported`.

## G. Reg 52(4) ratios inside the results table

Rows such as "Debt-equity ratio", "Net worth", "Gross NPA (%)" appear under EPS in the same table. They will show up
in `unmatched_rows` (the P&L synonym table does not claim them). Take them as disclosures (skill
`reg52-debt-listed-results`). `locate` reports a `reg52_4_ratios` section on the same page as `results` when the
citation is printed there; otherwise only `reg52_4_mentions`.

## H. Image pages inside a text PDF

Typically the signed auditor's report and sometimes the letter. `scanned_pages` lists them and each section shows
`scanned_pages_inside`. If the *statement* pages are images, nothing can be extracted: skill `scanned-and-image-pdfs`.

## I. Letter-only upload

Some exchange uploads are just the outcome letter, with results in a second attachment. `sections` has only
`covering_letter`; warning "no results statement found". Look for the companion attachment; log the letter as what
it is (`reg30_event`, or `reg33_results` only when the results are actually inside).
