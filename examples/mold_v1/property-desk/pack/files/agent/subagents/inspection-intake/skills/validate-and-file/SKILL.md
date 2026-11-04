---
description: "Load before writing defects.jsonl or raising any ticket: validate, write, then file only when asked."
---
# Validate, write, file

## Recognise it

Every run ends here.

## Procedure

1. Add `inspected` (YYYY-MM-DD) and `format` to every line of `defects.jsonl`.
2. `python3 /workspace/scripts/validate_defects.py defects.jsonl`. Exit 1: fix each problem it names, run it again.
3. `dataroom_append_jsonl` to `Accounts/<building id>/inspections/<date>_defects.jsonl`.
4. Only when the coordinator asks to file: `upsert_todo` per defect with a location and no `duplicate_of`: title the
   defect text, under the building, `dueAt` the due date, priority high for urgent and high, normal otherwise; notes
   with the report's line and the image. Record each `ticket_id` back and append the updated lines.

## What to write

The validated defects, then the tickets when asked.

## Worked example

Validation says `line 3: a high defect is due 3 day(s) after the inspection, not 2026-11-20`: the due date was typed
by hand. Run `classify_severity.py` again for that line; validation passes.

## When it cannot be done

A ticket that fails to file: leave its `ticket_id` null and list it in the reply.
