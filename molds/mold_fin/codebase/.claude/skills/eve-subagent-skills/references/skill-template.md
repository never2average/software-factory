# `skills/<skill-name>/SKILL.md` skeleton

The directory name is the skill's name: lowercase words joined by hyphens, named for the
variation (`cumulative-periods`, `scanned-pdf`, `metric-not-disclosed`), not for the topic.
The example below is synthetic, including the script name and its output; replace both with
a real script and its real output.

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

Example Housing Finance Ltd, results for the nine months ended 31 December. The table has
columns "Quarter ended" and "Nine months ended"; disbursements appear only under
"Nine months ended" as `3,000.00` and the half-year filing showed `2,000.00`. Unit line:
"(Rs in crore)".

```
$ python3 /workspace/scripts/derive_quarter.py --cumulative 3000 --previous-cumulative 2000
{"value": 1000.0, "method": "9M - H1", "status": "derived"}
```

Row written: `{"metric": "disbursements", "period": "Q3", "value": 1000.0, "unit": "crore",
"status": "derived", "footnote": "9M less H1", "source_doc": "...", "page": 4}`

Second example, a refusal: the half-year filing is not in the data room. The script is not
run. Row written with `"status": "not_found"`, and the reply says which filing is missing.

## When it cannot be done

| Situation | Write | Tell the analyst |
|---|---|---|
| <input missing> | `status: not_found` | "<exact sentence>" |
| <script reports ambiguous> | `status: needs_review` | the script's message, verbatim |

Validate with `python3 /workspace/scripts/validate_<rows>.py <file>` before anything is
written to the data room.
````
