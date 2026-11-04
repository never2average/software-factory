---
description: "Load when an inbox file is a calendar feed (.ics, starts with BEGIN:VCALENDAR): each event is a story or a slot."
---
# Calendar feeds (.ics)

## Recognise it

`detect_calendar_format.py` says `ics`. Each VEVENT is one story; SUMMARY is its title, DTSTART its deadline,
CATEGORIES its desk; a feed may carry `X-SLUG` and `X-EMBARGO`. Long lines are folded (a line starting with a space
continues the one before).

## Procedure

1. `python3 /workspace/scripts/parse_calendar.py inbox/desk.ics --format ics --desk <desk id> > entries.jsonl`
2. A DTSTART with `VALUE=DATE` (no time) is a day: the deadline is the edition cut-off (rule 7).
3. A DTSTART without `Z` or a TZID is a floating time: `deadline_calc.py` marks it `zone_assumed`, and the briefing
   line says "(zone assumed)".
4. An event with no SUMMARY is a slot, not a story: load `unassigned-and-missing-slots`.

## What to write

Briefing items with `source` = `<file> event <n>`.

## Worked example

```
BEGIN:VEVENT
SUMMARY:Flood defences inspection
DTSTART:20261104T153000Z
CATEGORIES:Metro
END:VEVENT
```

becomes `flood-defences-inspection`, due 2026-11-04T15:30Z, Metro, no reporter: Unassigned.

## When it cannot be done

A feed with no VEVENT: say the feed was empty. Recurring events (RRULE) are not expanded: list the first occurrence
and say the rest were not read.
