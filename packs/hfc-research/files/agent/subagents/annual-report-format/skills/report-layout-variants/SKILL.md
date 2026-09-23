---
description: Use when the section map looks wrong or incomplete because the report is not laid out the usual way - an integrated report, statutory reports first, no consolidated statements, consolidated before standalone, the AGM notice missing, or a slim report from a debt-listed company.
---

# Report layout variants

The section index assumes a full equity-listed annual report. Real reports vary along six axes. Work out which
variant you have **from the map and the contents page**, record it in the map's `layout` block, and adjust what you
report as "not contained" accordingly. None of these is an error in the report.

## How to recognise each variant

| Axis | Variant | How it shows in `map.json` / the contents page |
|---|---|---|
| Style | **Integrated report** | 60-120 pages of narrative before the statutory reports: capitals, value-creation model, materiality, stakeholder engagement, ESG. Many `other_entries`. Corporate information may be at the very end. |
| | **Statutory-only** | Opens with corporate information or the notice, then the Board's Report. Few `other_entries`. |
| Order | Corporate overview first | `layout.statutory_reports_first` is false |
| | Statutory reports first | `layout.statutory_reports_first` is true; corporate information may be on the inside cover or the last page |
| Notice | Inside the report | `layout.notice_of_agm_inside` is true, at the front or the very end |
| | Separate document | no notice entry. Normal: the notice is often sent and filed separately |
| Statements | Standalone then consolidated | `layout.statement_order` = `standalone_first` |
| | Consolidated then standalone | `consolidated_first`. The FIRST "Independent Auditor's Report" is then the consolidated one: check `basis` on both |
| | No subsidiaries | `standalone_only`. The statements are headed just "Financial Statements", with no "standalone" anywhere |
| Listing | Equity-listed | Corporate Governance Report and (for larger companies) BRSR present |
| | **Debt-listed only** (Reg 53 report) | Slim: no BRSR, often no Corporate Governance Report or a short one, no shareholder information; debenture trustee details are prominent; MD&A may be a section of the Board's Report |
| MD&A | Own chapter | a top-level entry |
| | Annexure to / section of the Board's Report | `mdna` lies inside the Board's Report's page range |

## Procedure

1. Build or read the map (`build-the-section-map`). Re-run the validator after any manual change:

   ```
   python3 /workspace/scripts/validate_section_map.py /workspace/out/map.json
   ```

2. Read `layout` and `other_entries`, and decide the variant on each axis using the table above.
3. For each section that is `not_found`, decide whether the variant explains it:
   - no `consolidated_financial_statements` and no Form AOC-1, and the Board's Report says the company has no
     subsidiary, associate or joint venture: set the note to "company has no subsidiaries; no consolidated
     statements are prepared". Quote the sentence and its page.
   - no `brsr` or `corporate_governance_report` in a debt-listed company's report: set the note to "not part of
     this report (debt-listed entity)". Do not state which regulation exempts it; say only what the report contains.
   - MD&A inside the Board's Report: search the Board's Report's range for the heading and record it by hand with
     `method: manual`. Set the Board's Report's `end_pdf_page` to its true last page: the validator accepts an MD&A
     (or corporate governance report, or BRSR) that lies wholly inside the Board's Report, and rejects a partial
     overlap. Say in the note that the MD&A is part of the Board's Report.
4. For unlabelled statements ("Financial Statements"): the map marks them `unconfirmed`. Confirm on the balance
   sheet page that no "consolidated" statements exist anywhere, then set `confidence: found` and keep
   `basis: standalone`. In every figure's row the basis is `standalone`, and the reply says "the company prepares
   only one set of statements".
5. Fill `layout.report_style` (`integrated`, `statutory_only` or `debt_listed_slim`) and add one line per finding
   to `layout.notes`. Validate, render and write the map as usual:

   ```
   python3 /workspace/scripts/render_section_map_md.py /workspace/out/map.json --out /workspace/out/FY26_annual-report-map.md
   ```

## What to write

The `layout` block of the map, the notes on `not_found` sections, and a short "Layout" paragraph in the reply.
`remember` the variant: it rarely changes from year to year.

## Worked example

Example Housing Finance Ltd is debt-listed only and has no subsidiaries. Its FY26 report has 148 PDF pages. The map
comes back with `statement_order: standalone_only`, `brsr`, `corporate_governance_report` and
`consolidated_financial_statements` all `not_found`, and the statements found under the heading "Financial
Statements" (`unconfirmed`). The Board's Report, printed page 9 (PDF page 12), says: "The Company does not have any
subsidiary, associate or joint venture." After checking the balance sheet page:

- `standalone_financial_statements`: `found`, note "headed 'Financial Statements'; only one set of statements".
- `consolidated_financial_statements`: `not_found`, note "company has no subsidiaries (Board's Report, printed page
  9, PDF page 12); no consolidated statements are prepared".
- `brsr`, `corporate_governance_report`: `not_found`, note "not part of this report (debt-listed entity)".
- `layout.report_style`: `debt_listed_slim`.

More cases are in [references/variants-checklist.md](references/variants-checklist.md).

## Failure modes and what to report

- Both "standalone" and "consolidated" appear on one statement page (columns side by side): do not pick one. Say the
  statements are presented side by side and extract only the columns headed standalone, naming the column headers.
- The first auditor's report's basis cannot be read from its first page: leave it `unconfirmed` and read the opinion
  paragraph, which names the statements audited.
- A subsidiary's numbers appear inside a parent's report (an unlisted HFC covered through its parent): this subagent
  extracts only the report of the company named by `company_id`. Say what you saw and stop.
