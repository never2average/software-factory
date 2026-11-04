---
description: "Load when deciding the At risk section: past deadlines, overloaded reporters, disagreements, missing times."
---
# At-risk assignments

## Recognise it

Rule 11 of the rulebook lists the five reasons. Every At risk line says which one, in words.

## Procedure

1. From `timed.jsonl`, take `deadline_state: past` for stories not filed (stage not filed, edited, ready or published).
2. `deadline_state: due_now` or `minutes_to_deadline` under 120 with no reporter.
3. Count stories per reporter due today: three or more puts each of them At risk ("three stories due today").
4. Calendar/export disagreements found while parsing (rule 4).
5. Embargo with no time (rule 10).
6. Validate with `python3 /workspace/scripts/validate_briefing_items.py briefing-items.jsonl`: an At risk item with no
   `risk` text is refused.

## What to write

At risk items with `risk` set to the reason.

## Worked example

`night-buses`, due 2026-11-04T08:00Z, stage `assigned`, at 09:00Z: At risk, risk "an hour past its deadline and not
filed". The same story in the planning sheet with a 10:00Z deadline adds "the planning sheet says 10:00Z".

## When it cannot be done

A story with no stage at all: treat it as not filed and say "stage not recorded".
