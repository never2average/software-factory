---
description: "Load when any place in the report is not already in the building's own form (Flat 3B, Stair A, Corridor L2)."
---
# Places, the building's way

## Recognise it

Reports say "Apt 3b", "Unit 12A", "second-floor landing", "staircase B level 2". The rulebook (rules 3 to 6) names
each place one way.

## Procedure

1. Save the building's flats (from `get_customer` or the building's README in the data room) as `units.json`.
2. `python3 /workspace/scripts/normalise_location.py --units units.json < raw.jsonl > placed.jsonl`
3. `location_note: unknown_unit`: the flat is not one of the building's; keep the defect, do not file it, say so.
4. `location: null`: the place could not be named; same.

## What to write

`location` on every defect, and `location_note` where it is null or unknown.

## Worked example

"apartment 3b kitchen" becomes "Flat 3B, kitchen"; "landing, ground floor" becomes "Corridor L0"; "Flat 9Z" in a
building whose flats stop at 6 keeps "Flat 9Z" with `unknown_unit`.

## When it cannot be done

Without the building's list of flats, run the script without `--units` and say the flats were not checked.
