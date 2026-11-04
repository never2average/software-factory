---
description: "Load when an inbox file is a planning-sheet export: comma, semicolon or tab separated, one story per row."
---
# Planning-sheet exports (CSV)

## Recognise it

`detect_calendar_format.py` says `csv`. Desks export their planning sheet with different headers ("Catchline" or
"Slug", "Byline" or "Reporter", "Copy due" or "Deadline"), different separators (a semicolon where the sheet's locale
uses a comma for decimals) and sometimes a byte-order mark on the first header.

## Procedure

1. `python3 /workspace/scripts/parse_calendar.py inbox/plan.csv --format csv --desk <desk id> > entries.jsonl`
2. Read the `unparsed` lists: a deadline like "tomorrow" or "after conf" is not a time. Keep the entry, leave the
   deadline empty, and list it under At risk with "deadline not a time in the planning sheet".
3. Rows for other desks: skip them and count them (the rulebook's open point on combined sheets).
4. Compare each entry with the calendar's assignment of the same slug (rule 4): the calendar wins; a different
   deadline or reporter is an At risk line.

## What to write

Only entries the calendar lacks become briefing items, with `source` = `<file> row <n>`.

## Worked example

`plan.csv`:

```
Catchline;Desk;Byline;Copy due;Words
bridge-vote;Metro;;2026-11-04T17:00+00:00;600
night-buses;Metro;r.writer@example.com;after conf;400
```

gives `bridge-vote` (no reporter: Unassigned, due 17:00) and `night-buses` (At risk: "deadline not a time in the
planning sheet", source `plan.csv row 3`).

## When it cannot be done

A file the sniffer cannot split (one column only): report "plan.csv could not be split into columns" and do not use it.
