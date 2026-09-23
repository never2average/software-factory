# Absence markers, footnote templates and exclusion patterns

## How absence is printed

| Printed | Meaning | Treatment |
|---|---|---|
| `-`, `–`, `—` | nil or not applicable | no number (`finlib.numbers.is_blank`); decide nil vs not published from context |
| `NA`, `N.A.`, `N/A` | not applicable / not available | no number |
| `Nil` | the company states none | `not_found`, footnote quotes it |
| `NM` | not meaningful (a ratio on a negative base) | `not_found`, footnote "NM in the filing" |
| `*`, `#`, `^` next to a number | footnote marker | read the footnote; pass the bare number |
| empty cell | not published for that period | `not_found` or carry forward |
| `0`, `0.00` | zero | a number; for SD / BO treat like a stated nil (row `not_found`, footnote "0.00 printed") so the series has one convention |
| a bar on a chart with no data label | not readable exactly | `needs_review`, `read_from_chart: true` |

## Footnote templates

| Case | Footnote |
|---|---|
| carried forward (branches / employees) | `<KPI> not published for <period>; value as of <value_period> from the previous quarter's investor presentation.` |
| carried forward (other) | `<KPI> not published for <period>; most recent available value, as of <value_period> (<document>).` |
| other source, same quarter | `No balance sheet in the <period> results; <KPI> from the investor presentation.` |
| never published | `Not disclosed in the quarterly results (pp. a–b) or the investor presentation for <period>; not published in earlier quarters either.` |
| stated nil | `Company states nil: "<quoted words>" (<QR/IP> p.<n>).` |
| sell down, AUM = loan book | taken verbatim from `compute_kpis.py` → `sell_down_verdict.footnote` |
| year-to-date ratio | `Only the <value_period> figure is disclosed; a ratio cannot be converted to a quarter.` |
| chart reading | `Read from a chart without data labels on slide <n>; approximate.` |
| earlier cumulative missing | `Only <9M FY26> is published and the <H1 FY26> filing is not in the data room; the quarter cannot be derived.` |

The validator requires: `carried_forward` → `value_period` earlier than `period`, and the footnote contains the
`value_period` text. `needs_review` → footnote of at least 8 characters. `not_found` without a footnote is flagged.

## Restructured-book exclusion patterns

`RESTRUCTURED_RE` in `/workspace/scripts/kpi_catalog.py` (case-insensitive):

| Pattern | Catches |
|---|---|
| `restructur` | restructured book, restructured assets, restructuring, loans restructured |
| `\bOTR\b`, `one[- ]time\s+restructuring` | OTR 1.0 / OTR 2.0 |
| `resolution\s+framework`, `\bRF\s*[12]\b` | resolution framework 1.0 / 2.0 disclosures |
| `resolution\s+plan\s+implemented` | the half-yearly resolution-plan disclosure table |
| `covid[- ]?19\s+(related\s+)?stress` | the same disclosures under their older title |

Leave out: the slide or note itself, provisions held on restructured accounts, restructured book as % of AUM,
movement of restructured accounts. Do not add a footnote like "GNPA includes restructured accounts of ₹x crore".

## When to stop instead of filling gaps

| Finding | Reply to the orchestrator |
|---|---|
| no QR for the quarter in `Companies/{company_id}/filings/lodr/` | "Missing: quarterly results for <period> (Reg 33 / Reg 52 filing). Ask `lodr-filings` to fetch it." |
| no IP for the quarter in `.../filings/presentations/` | "Missing: investor presentation for <period>. Ask `investor-presentations` to fetch it." For an unlisted company name the PARENT's presentation. |
| previous quarter's IP missing and branches / employees absent this quarter | same, naming the previous quarter |
| scanned PDF | "The <document> is a scanned image with no text layer; it cannot be read in the sandbox." |
| HTML or empty file where a PDF was expected | "The file at <path> is not a PDF (saved web page / empty); it needs to be fetched again." |

If the analyst explicitly asks you to proceed with the QR only (no IP published yet), do so: operational KPIs become
`carried_forward` or `not_found` by the table above, and the summary lists the presentation as "needed, not found".
