---
description: Use when a quarterly results filing contains both standalone and consolidated statements (one after the other or side by side), when only consolidated figures exist, when a presentation does not say which basis its numbers are on, or when setting the basis field of a KPI row.
---

# Standalone versus consolidated

Rulebook: "Use standalone Profit and Loss statements and ratios from LODR when both standalone and consolidated data
are provided."

Every KPI row carries `basis`: `standalone` or `consolidated`. Standalone is the default and the target. A
consolidated value is allowed only when no standalone figure exists, and then the row MUST carry a footnote saying
so (the schema and `validate_kpis.py` enforce this).

## Recognise the variation

| Layout | How to tell |
|---|---|
| Two complete sets, one after the other | page headings "Statement of Standalone Unaudited Financial Results ..." then "Statement of Consolidated ...". Each set has its own auditor's review report in front of it or behind it. |
| Side by side in one table | a super-header row "Standalone" spanning the first block of period columns and "Consolidated" spanning the second. `derive_quarter.py --columns` reports two columns with the same period when this happens. |
| Standalone only | the company has no subsidiaries; the word "consolidated" does not appear in the results. |
| Consolidated only in the IP | many presentations are silent about basis, or say "consolidated" in a footnote on the financial-summary slide. |
| Segment of a parent | an unlisted subsidiary's numbers inside the parent's consolidated presentation: they are the subsidiary's own numbers, cite as `parent IP`. |

Find the pages rather than scrolling:

```
python3 /workspace/scripts/detect_content_type.py /workspace/in/q2fy26-results.pdf \
  --find "standalone\s+(un)?audited\s+financial\s+results" "consolidated\s+(un)?audited\s+financial\s+results" \
         "statement\s+of\s+assets\s+and\s+liabilities" "standalone" "consolidated"
```

The heading patterns are in `references/headings-and-labels.md`.

## Procedure

1. Locate the standalone results table, the standalone statement of assets and liabilities, and the notes that
   belong to the standalone set (notes are numbered separately per set). Work only inside those pages for QR values.
2. Side-by-side table: read the super-header row and keep only the columns under "Standalone". Then pick the period
   column (`discrete-quarter-from-cumulative`).
3. Ratios disclosed under the LODR ratios note (debt-equity, net worth, GNPA, CRAR ...) exist once per set. Use the
   standalone set's note.
4. Presentation values: look for the basis on the slide, in the slide footnote, or on the "basis of preparation /
   disclaimer" slide. If the deck says nothing and the company has no subsidiaries (standalone-only QR), it is
   standalone. If the company has subsidiaries and the deck is silent, mark `basis` as the QR comparison suggests:
   reconcile the deck's PAT or networth against both QR sets with
   `python3 /workspace/scripts/reconcile_sources.py --request ...`; the set it matches is the basis. If it matches
   neither, the row is `needs_review`.
5. Only consolidated exists for a value you need: use it, set `basis: "consolidated"`, and footnote: "Standalone
   figure not published; consolidated figure used." The computed KPIs that use it inherit a consolidated note
   (`compute_kpis.py --rows` adds it when the inputs' `basis` is consolidated). Never mix a consolidated numerator
   with a standalone denominator: if one input of a ratio is only available consolidated, compute that ratio
   entirely on consolidated inputs or not at all, and say which.
6. `remember` the company's pattern ("files standalone and consolidated side by side; IP is consolidated").

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

The results PDF has 14 pages. `--find` reports: standalone results on page 3, standalone balance sheet page 5,
consolidated results page 8, consolidated balance sheet page 10.

| Item | Standalone (p.3 / p.5) | Consolidated (p.8 / p.10) | Row |
|---|---|---|---|
| PAT, quarter, ₹ lakh | 7,500 | 7,640 | `pat_quarter` input = 75.00, standalone, p.3 |
| Loans, ₹ lakh | 8,20,000 | 8,20,000 | `loan_book` 8200.00, standalone, p.5 |
| Total equity, ₹ lakh | 2,40,000 | 2,43,100 | `networth` 2400.00, standalone, p.5 |

The presentation's slide 6 shows "PAT ₹76.4 crore" with no basis stated. Reconciling 76.4 against the two QR values:
it equals the consolidated 76.40 and is 1.87% from the standalone 75.00. So the deck is consolidated. ROE is computed
from the standalone PAT 75.00 and networth 2,400.00 = 12.50%, and the deck's own "ROE 12.9%" goes in the footnote as
the company's published figure (consolidated).

## Failure modes

- **Only the consolidated set is in the PDF** because the filing in the data room is an extract: say which pages
  are missing and ask for the full filing; do not silently fall back.
- **Standalone and consolidated columns swapped** across quarters in your own history: compare with last quarter's
  rows in `kpis.jsonl`; a sudden step in networth with no capital raise is a basis switch.
- **Mixed rows.** If some rows of a quarter are consolidated, `validate_kpis.py` flags `F-BASIS`. List those cells
  in the summary.
- **Unlisted subsidiary in a parent deck**: the subsidiary's segment numbers are its own (standalone for the
  subsidiary). Record `basis: "standalone"`, `source: "parent IP"`, and name the parent document.
