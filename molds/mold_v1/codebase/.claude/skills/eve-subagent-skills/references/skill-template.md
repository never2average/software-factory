# `skills/<skill-name>/SKILL.md` skeleton

The directory name is the skill's name: lowercase words joined by hyphens, named for the
variation (`table-split-across-pages`, `scanned-pdf`, `value-not-stated`), not for the
topic. The example below is synthetic, including the script name and its output; replace
both with a real script and its real output.

````md
---
description: Use when <what you can see in the document or the detector output that marks this variation>. <One clause on what the skill makes you do differently.>
---

# <Variation, as a noun phrase>

## Recognise it

- <visible sign 1>
- <visible sign 2>
- `python3 /workspace/scripts/detect_<input>.py <file>` prints `"<field>": "<value>"`.

It is NOT this variation when <the neighbouring case>; load `<other-skill>` instead.

## Procedure

1. <step>
2. Run `python3 /workspace/scripts/<calculator>.py --<arg> <value> ...`. Use its output;
   do not compute the value yourself.
3. If the script exits non-zero, stop and go to "When it cannot be done".
4. Open `references/<table>.md` only if <condition>.

## What to write

One row per <fact> in `<rows>.jsonl`:

| Field | Value |
|---|---|
| `status` | `reported` / `derived` / `needs_review` |
| `footnote` | required when `status` is `derived`: "<wording>" |
| `source_doc`, `page` | always |

## Worked example

Example Trading Co., invoice INV-0001. The line items run over pages 1 and 2; page 1 ends
with "Carried forward 2,000.00" and the invoice total on page 2 reads `3,000.00`. Currency
line: "All amounts in EUR".

```
$ python3 /workspace/scripts/sum_line_items.py --items 1000 1000 1000 --stated-total 3000
{"sum": 3000.0, "stated_total": 3000.0, "matches": true, "status": "reported"}
```

Row written: `{"field": "invoice_total", "document_id": "INV-0001", "value": 3000.0,
"unit": "currency", "status": "reported", "source_doc": "...", "page": 2}`

Second example, a refusal: page 2 is missing from the file in the data room. The script is
not run. Row written with `"status": "not_found"`, and the reply says which page is missing.

## When it cannot be done

| Situation | Write | Tell the user |
|---|---|---|
| <input missing> | `status: not_found` | "<exact sentence>" |
| <script reports ambiguous> | `status: needs_review` | the script's message, verbatim |

Validate with `python3 /workspace/scripts/validate_<rows>.py <file>` before anything is
written to the data room.
````

If the description you write contains `: ` or ` #`, wrap the whole value in double quotes:
`eve build` rejects the skill otherwise, and `npm run check:subagents` reports it.
