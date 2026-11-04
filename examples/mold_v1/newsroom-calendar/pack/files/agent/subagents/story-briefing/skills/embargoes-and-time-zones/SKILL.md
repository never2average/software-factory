---
description: "Load when any entry carries an embargo, or a time with no zone; decides Embargoed against Due today."
---
# Embargoes and time zones

## Recognise it

An entry has `embargo`, or `deadline_calc.py` reports `zone_assumed: true`.

## Procedure

1. Run every entry through `python3 /workspace/scripts/deadline_calc.py --now <now, with zone> --zone <desk zone>
   --edition-cutoff 17:00 < entries.jsonl > timed.jsonl`.
2. `embargo_state: holding`: the story goes under Embargoed with its lift time, whatever its deadline (rule 9).
3. `embargo_state: lifted`: treat it as any other story.
4. An embargo field present but not a time (`unparsed`): At risk, "embargo time missing" (rule 10).
5. `zone_assumed`: keep the time, add "(zone assumed)" to the line.

## What to write

`embargo`, `embargo_state` and `zone_assumed` on the item, as the script gave them.

## Worked example

At `--now 2026-11-04T09:00Z`, a story due 12:00Z with an embargo until 18:00Z has `embargo_state: holding`: it is
listed as "Embargoed until 2026-11-04T18:00Z", and not under Due today.

## When it cannot be done

`--now` without a zone is refused by the script: always pass the zone.
