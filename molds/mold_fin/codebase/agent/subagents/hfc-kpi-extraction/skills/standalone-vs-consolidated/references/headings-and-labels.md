# Headings and labels that identify the basis

All patterns are case-insensitive regexes usable with
`python3 /workspace/scripts/detect_content_type.py <file> --find "<regex>" ...`.

## Page headings in the quarterly results (QR)

| Pattern | Identifies |
|---|---|
| `statement\s+of\s+(un)?audited\s+standalone\s+financial\s+results` | standalone results table |
| `standalone\s+(un)?audited\s+financial\s+results` | same, other word order |
| `statement\s+of\s+(un)?audited\s+consolidated\s+financial\s+results` | consolidated results table |
| `consolidated\s+(un)?audited\s+financial\s+results` | same |
| `(standalone\|consolidated)?\s*statement\s+of\s+assets\s+and\s+liabilities` | balance sheet (check the word in front, or the running page header) |
| `(standalone\|consolidated)?\s*(statement\s+of\s+)?cash\s+flows?` | cash flow (cumulative; not used for quarter flows) |
| `independent\s+auditor'?s'?\s+(review\s+)?report\s+on\s+.*standalone` | the review report that precedes or follows the standalone set |
| `limited\s+review\s+report` | same, other wording |
| `notes?\s+to\s+the\s+(standalone\|consolidated)` | which set a block of notes belongs to |

When a page has no basis word, use the nearest preceding heading that has one; sets are contiguous.

## Super-headers in a side-by-side table

| Row text | Meaning |
|---|---|
| `Standalone` spanning N columns, then `Consolidated` spanning N columns | first block is standalone |
| `Consolidated` first | some companies lead with consolidated: read the words, not the position |
| no super-header, but the page heading says "Standalone and Consolidated" | the column sub-headers carry (S)/(C) or the table is repeated lower on the page |

## Basis wording in presentations (IP)

| Wording | Basis |
|---|---|
| "Standalone financials", "on a standalone basis", "(Standalone)" in the slide title | standalone |
| "Consolidated", "on a consolidated basis", "including subsidiaries" | consolidated |
| nothing, and the QR has no consolidated set | standalone |
| nothing, and the QR has both sets | unknown: reconcile PAT / networth against both sets |

## Footnote wording to use

| Situation | Footnote |
|---|---|
| Only consolidated published | "Standalone figure not published in <document>; consolidated figure used." |
| IP value is consolidated, QR standalone value used | handled by `reconcile_sources.py` when `basis` is passed on both candidates |
| Computed from consolidated inputs | "Computed from consolidated figures; the filing gives no standalone figures." (added by `compute_kpis.py --rows`) |
| Parent's presentation | "From the parent company's investor presentation (<path>), segment slide for <subsidiary>." |
