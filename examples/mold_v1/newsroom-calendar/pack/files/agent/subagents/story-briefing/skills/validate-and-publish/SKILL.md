---
description: "Load before writing anything to the data room: validate briefing-items.jsonl, render, write, publish."
---
# Validate, then write and publish

## Recognise it

Every briefing ends here. Nothing is written to the data room before this procedure passes.

## Procedure

1. `python3 /workspace/scripts/validate_briefing_items.py briefing-items.jsonl`. Exit 1: read `problems`, fix each in
   the items (never by deleting the line), run it again.
2. `python3 /workspace/scripts/render_briefing.py briefing-items.jsonl --desk "<desk name>" --date <YYYY-MM-DD> > briefing.md`
3. `dataroom_write` the markdown to `Accounts/<desk id>/briefings/<date>_briefing.md`.
4. `dataroom_append_jsonl` the items to `Accounts/<desk id>/briefings/briefing-items.jsonl`.
5. `publish_artifact` only when the person asked for it.

## What to write

The briefing and its items; reply with the counts per section.

## Worked example

Validation says `line 4: in embargoed but has no embargo time`. The wire line said "embargoed" with no time, so the
item moves to At risk with risk "embargo time missing"; validation then passes and the briefing is written.

## When it cannot be done

A data-room write that fails: keep the rendered briefing in the reply and say it was not saved.
