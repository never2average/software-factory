---
description: "Load when the inspection report is a photo log: lines of image file, place and what the photo shows."
---
# Photo logs

## Recognise it

`detect_report_format.py` says `photo_log`: lines like `IMG_0012.jpg - Flat 3B kitchen - water under sink`.

## Procedure

1. `python3 /workspace/scripts/parse_report.py photos.txt --format photo_log > raw.jsonl`
2. Every defect keeps its image in `evidence`; the validator refuses a photo-log defect without one.
3. Two photos of the same defect (same place, same words) are one defect with both images named in the text.

## What to write

Raw defects with `source` = `line <n>`, `evidence` = the image file, `format` = `photo_log`.

## Worked example

`IMG_0012.jpg - Flat 3B kitchen - water under sink` gives "water under sink" at "Flat 3B kitchen", evidence
IMG_0012.jpg. Rated by `severity-and-due-dates`: "water under sink" matches no rule word exactly, so check the words:
a leak is R2 (high); write the text as "leak: water under sink" only if the photo log says leak; otherwise it is
Normal by default and you say so.

## When it cannot be done

Lines that are not photo lines are reported by the script on stderr; list how many.
