---
description: "Load when rating defects: the rulebook's four severities, their trigger words and their due dates."
---
# Severity and due dates

## Recognise it

Every defect is rated; the rulebook's rules 7 to 11 decide, the first match winning.

## Procedure

1. `python3 /workspace/scripts/classify_severity.py --inspected <YYYY-MM-DD> < placed.jsonl > rated.jsonl`
2. Read `matched`: `default` means no rule word matched. Look at the text: if it plainly describes a rule's case in
   other words ("radiators cold in every room" is no heat), rewrite nothing; add a line to the reply proposing the
   higher severity for the coordinator to confirm.
3. Never lower a severity the script gave.

## What to write

`severity`, `due` and `matched` as the script gave them.

## Worked example

Inspected 2026-11-04: "Fire door closer: does not latch" is urgent (R1), due 2026-11-05; "Damp patch on ceiling" is
high (R2), due 2026-11-07; "Graffiti on bin store door" is low (R4), due 2026-12-30.

## When it cannot be done

No inspection date: ask for it before rating anything.
