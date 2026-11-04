---
description: "Load when checking whether a defect is already being fixed: compare with the building's open tickets."
---
# Already-open tickets

## Recognise it

Every run: the rulebook (rule 2) never files a defect twice.

## Procedure

1. `list_todos` for the building, open ones only; save the answer as `open-tickets.json`.
2. `python3 /workspace/scripts/dedupe_defects.py --open open-tickets.json < rated.jsonl > defects.jsonl`
3. `duplicate_of` set: report it with its ticket; do not file. `similarity` between 0.3 and 0.5: name the possible
   match in the reply and let the coordinator decide.

## What to write

`duplicate_of` and `similarity` on each defect.

## Worked example

Open ticket T-1 "Damp patch on bedroom ceiling" at "Flat 2A, bedroom"; the report's "Damp patch on ceiling" at the
same place is a duplicate of T-1 (similarity 1.0). The same words at "Flat 3B" are not.

## When it cannot be done

If `list_todos` fails, mark nothing as a duplicate, file nothing, and say the duplicates could not be checked.
