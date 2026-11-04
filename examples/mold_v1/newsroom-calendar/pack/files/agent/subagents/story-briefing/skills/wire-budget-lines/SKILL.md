---
description: "Load when an inbox file is a news agency's budget: lines like SLUG -- 600w -- summary -- moving 1700 UTC."
---
# Wire budget lines

## Recognise it

`detect_calendar_format.py` says `wire_budget`. Each line is `SLUG -- <words>w -- <summary> -- <when it moves>`, with
`--`, an em dash or a pipe between parts; some lines say "embargoed until <time>".

## Procedure

1. `python3 /workspace/scripts/parse_calendar.py inbox/wire.txt --format wire_budget --desk <desk id> > entries.jsonl`
2. A wire story is never a commitment (rule 5): every one goes under Unassigned unless the calendar already has an
   assignment with the same slug, in which case the calendar's line is used.
3. "moving 1700 UTC" is when the agency files, not the desk's deadline: put it in the line's text, not in `deadline`.
4. An embargo on a wire line: load `embargoes-and-time-zones`.

## What to write

Unassigned items with `source` = `<file> line <n>`.

## Worked example

`BRIDGE-VOTE -- 600w -- Council votes on the bridge -- moving 1700 UTC, embargoed until 2026-11-04T18:00Z` becomes
`bridge-vote`, 600 words, embargoed until 18:00Z: it is listed under Embargoed (rule 9), not Unassigned, and says the
agency moves it at 17:00 UTC.

## When it cannot be done

Lines that do not match the pattern are skipped by the parser; say how many lines were skipped.
