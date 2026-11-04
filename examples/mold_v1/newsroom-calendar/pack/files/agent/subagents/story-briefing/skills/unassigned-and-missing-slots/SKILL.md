---
description: "Load when a story has no reporter, or a planned slot (a page, a time on the homepage) has no story yet."
---
# Unassigned stories and empty slots

## Recognise it

An entry with no `reporter`, a wire story (always unassigned), or a calendar event with no title (a slot).

## Procedure

1. List the desk's people with `list_members` only to name who COULD take it if the editor asks; never assign anyone.
2. Each unassigned story becomes an Unassigned item, deadline first.
3. A slot with no story: an Unassigned item whose slug is `slot-<time>` and title "Empty slot", so the editor sees it.
4. Check how close each one is: `python3 /workspace/scripts/deadline_calc.py --now <now, with zone> < entries.jsonl`.
5. Unassigned and due within two hours: also At risk (rule 11): load `at-risk-assignments`.

## What to write

Unassigned items with `reporter: null`. The validator refuses an Unassigned item with a reporter.

## Worked example

`flood-prep` from the wire, due 15:00Z, no reporter, at 09:00Z: Unassigned ("nobody yet; 2026-11-04T15:00Z").
At 13:30Z the same story is also At risk: "due in 90 minutes and nobody has it".

## When it cannot be done

If `list_members` fails, still write the Unassigned section; it never depends on the roster.
