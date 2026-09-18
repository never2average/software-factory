---
description: Use when asked to extract the Management Discussion and Analysis - industry view, business and product mix, distribution, asset quality commentary, funding and liquidity, risk management, outlook - or to decide what to quote and what to summarise in any long text section.
---

# Management Discussion and Analysis

The MD&A is management's own narrative: 10-30 pages, mostly prose with a few tables and many charts. The analyst
wants the facts and commitments in it, with pages, and a short neutral summary of the rest.

## How to recognise it

- Map key `mdna`. Headed "Management Discussion and Analysis", sometimes "Management's Discussion & Analysis".
- It may be its own chapter, an annexure to the Board's Report, or (in slim debt-listed reports) a few paragraphs
  inside the Board's Report. Load `report-layout-variants` if the map did not find it as a chapter.
- In integrated reports, some of its content moves to narrative chapters ("Business review", "Our capitals"). Extract
  the MD&A as headed; mention the other chapters by title and page, and extract them only if asked.

## Procedure

1. Check the range is text before reading it:

   ```
   python3 /workspace/scripts/detect_content_type.py /workspace/in/FY26_annual-report.pdf --first 70 --last 85
   ```

2. Pull the text of the range (as in `directors-report-and-annexures`) and split it by the report's own sub-headings.
   Map them to the seven buckets in [references/headings-and-facts.md](references/headings-and-facts.md). A
   sub-heading that fits no bucket is kept under its own name.
3. Within each bucket, apply the quoting rule:
   - **Quote** a sentence when it carries a number with a period, a named source for an industry figure, a
     commitment or target ("plans to add 40 branches in FY27"), a definition management uses (what it counts as
     AUM, affordable housing, a "small ticket" loan), or a statement about risk events, regulatory change, frauds,
     litigation.
   - **Summarise** everything else in at most three lines per bucket, in neutral words.
   - **Leave out** restructured-book details; note only that the section discusses them, with the page.
   - Never read a value off a chart. Say "shown only as a chart on printed p. 66".
4. Tables inside the MD&A (financial performance summary, key ratios with year-on-year change, product mix) are
   extracted as tables with their unit. Key financial ratios and "details of significant changes (25% or more)" are
   worth extracting in full when present: quote management's explanation of each change.
5. Numbers from the MD&A go to `annual-report-data.jsonl` only when they are a table of the company's own figures
   with a stated unit and period; set `section: "mdna"`, `statement: "report_text"`. Industry figures never go there.
   Validate before appending:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`Customers/{customer_id}/filings/lodr/{fy}_annual-report/management-discussion-and-analysis.md`: the seven buckets as
headings, quotes with `(printed p., PDF p.)`, summaries marked as summaries, tables as tables, and a closing list
"Shown only as charts".

## Worked example

Example Housing Finance Ltd FY26 MD&A, printed pages 62-77 (PDF 70-85). Sub-headings found: "Economic overview",
"Housing finance industry", "Company overview", "Product portfolio", "Distribution network", "Asset quality",
"Borrowing profile", "Risk management", "Human resources", "Internal control systems", "Outlook", "Cautionary statement".

Extract (abridged):

> ## Business and product mix
> "Individual home loans constituted 78% of assets under management as at March 31, 2026, loans against property
> 17% and construction finance 5%." (printed p. 66, PDF p. 74)
> "The average ticket size of home loans disbursed during the year was Rs. 14.2 lakh." (printed p. 66, PDF p. 74)
> Summary: describes the affordable-housing focus and the salaried / self-employed split of customers; no targets given.
>
> ## Funding and liquidity
> "The Company raised Rs. 2,150 crore during the year, of which Rs. 600 crore was refinance from the National
> Housing Bank." (printed p. 70, PDF p. 78)
> The borrowing-mix table (printed p. 70) is extracted below. Unit: per cent of total borrowings.
>
> ## Shown only as charts
> AUM growth FY22-FY26 (printed p. 65); branch count by state (printed p. 67).

"Human resources" and "Internal control systems" fit no bucket and are kept under their own headings, one line each
plus the quoted employee count. The cautionary statement is noted as present, not extracted.

## Failure modes and what to report

| Situation | Report |
|---|---|
| Two-column page layout extracts with the columns interleaved | Re-extract by cropping each half of the page (`page.crop`) and reading left then right. If sentences still break, quote less and say the layout prevented reliable quoting on those pages. |
| A figure in the MD&A disagrees with the statements | Report both with pages. Do not choose; do not "correct". |
| MD&A not found as a heading | Search the Board's Report range for it; if it truly is not there, say the report has no MD&A section and name the chapters that cover similar ground. |
| Pages are images | Load `scanned-or-image-reports`. |
