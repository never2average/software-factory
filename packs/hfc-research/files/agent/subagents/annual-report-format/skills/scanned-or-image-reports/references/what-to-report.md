# What to say when pages are images

Always give: the pages (printed and PDF, as ranges), the sections affected, what was extracted anyway, and the
next step. Never write "no key audit matters" or "no related-party transactions" when the truth is "the pages could
not be read".

## Fully scanned report

> `FY26_annual-report.pdf` (298 pages) is a scanned image: 298 of 298 pages carry no text layer. No section map and
> no extracts could be produced. A text copy of the same annual report is needed; `lodr-filings` can check the
> exchange and the company's website for one.

## Scanned section inside a text report

> Extracted: Board's Report, MD&A, standalone balance sheet, statement of profit and loss, notes 1-54.
> Not extracted: the standalone Independent Auditor's Report, printed pages 150-163 (PDF 158-171), which is a
> scanned image in this file. Its opinion, key audit matters and CARO remarks are therefore not reported.

## Signed statement pages scanned, notes in text

Common: the balance sheet, P&L and cash flow pages carry signatures and were scanned; the notes are text.

> The four primary statements (printed pages 164-169, PDF 172-177) are scanned images. Line items that the notes
> repeat (loans, borrowings, investments) were extracted from the notes and are labelled with their note numbers.
> Balance-sheet totals and the statement of profit and loss were not extracted.

Rows taken from notes carry `statement: "note"` and the note reference, never `balance_sheet`.

## Garbled text layer

> Pages 96-131 (PDF) extract as unreadable characters (the embedded font has no character map). Treated as
> unreadable; nothing was extracted from them.
