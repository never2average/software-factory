---
description: "Load when the inspection report is written prose: numbered defects, 'Defect 3:' headings or bullet points."
---
# Written reports

## Recognise it

`detect_report_format.py` says `narrative_text`. Each defect is a numbered line, a "Defect n:" heading or a bullet,
often with the place after a comma at the end ("Damp patch on ceiling, Flat 2A bedroom.").

## Procedure

1. `python3 /workspace/scripts/parse_report.py report.txt --format narrative_text > raw.jsonl`
2. A defect whose place is in the sentence but not after a comma ("on the second-floor landing"): read the place from
   the text yourself and set `location_raw`, citing the same line.
3. Paragraphs that describe the building in general are not defects; skip them.

## What to write

Raw defects with `source` = `line <n>`, `format` = `narrative_text`.

## Worked example

"1. Damp patch on ceiling, Flat 2A bedroom." gives "Damp patch on ceiling" at "Flat 2A bedroom" (line 2).
"2. Loose handrail on the landing" gives "Loose handrail on the landing" with no place after a comma: set
`location_raw` to "landing", which `normalise_location.py` names "Corridor", and ask which floor if none is said.

## When it cannot be done

A scanned report with no text: say the file has no readable text.
