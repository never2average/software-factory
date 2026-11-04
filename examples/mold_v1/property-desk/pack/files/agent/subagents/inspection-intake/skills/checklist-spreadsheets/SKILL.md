---
description: "Load when the inspection report is a checklist export: a spreadsheet with one row per item and a pass/fail result."
---
# Checklist spreadsheets

## Recognise it

`detect_report_format.py` says `checklist_csv`. Headers vary ("Item" or "Check" or "Element"; "Result" or "Outcome";
"Location" or "Area" or "Unit"); results vary (Fail, No, X, Action required, Unsatisfactory).

## Procedure

1. `python3 /workspace/scripts/parse_report.py report.csv --format checklist_csv > raw.jsonl`
2. Only failed rows become defects; the script counts the passed and not-applicable ones on stderr: report that count.
3. The defect text is the item plus its note ("Fire door closer: does not latch").
4. Continue with `unit-and-area-names`.

## What to write

Raw defects with `source` = `row <n>`, `format` = `checklist_csv`.

## Worked example

```
Item,Location,Result,Notes
Fire door closer,Stair B L2,Fail,Does not latch
Smoke alarm,Flat 3B,Pass,
```

gives one defect, "Fire door closer: Does not latch" at "Stair B L2", and "1 passed item skipped".

## When it cannot be done

A file with no result column: say the checklist has no pass/fail column and stop; every row would otherwise be a guess.
