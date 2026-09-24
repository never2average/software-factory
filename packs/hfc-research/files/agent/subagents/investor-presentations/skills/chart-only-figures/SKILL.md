---
description: Use when a figure you need appears only on a chart in the deck (bar, stacked bar, line, pie or doughnut), when a slide has no text layer, when numbers on a slide turn out to be axis ticks rather than data, or when you must decide whether a value read from a chart may be written as exact.
---

# Figures that exist only on a chart

Rule from the instructions: **a number read off a chart without a data label is approximate. Mark it
`approximate: true` and never present it as exact.** This skill tells a printed data label (exact) from an
axis reading (approximate), and says how to write each.

## Recognise the variation

| What you see | What it is |
|---|---|
| A number printed on or just above a bar, inside a pie segment, or at a line's marker | A **data label**. Exact, as printed (it may itself be rounded) |
| Evenly spaced numbers up the side or along the bottom (0, 300, 600, 900) | **Axis ticks**. Never values |
| A bar with no number on it | Its height can only be **read off the axis**: approximate |
| A stacked bar with a total on top and unlabelled segments | Total exact; segments approximate |
| A stacked bar with labelled segments and no total | Segments exact; the total is a sum **you** computed: say so in the note, not approximate but `status: derived` |
| `image_only: true` in the slide index, or `[chart]` in a PPTX slide's text | No text at all: everything on it is a reading from the picture |
| Pie / doughnut with percentages printed | Exact. Without them: approximate |

## Procedure

1. Confirm there is no printed source first. Look for the same figure in a table elsewhere
   (`python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric <key>`).
   Summary tables near the end of the deck often print what the chart only draws. A printed number on
   another slide always beats a chart reading.
2. If the chart slide has text, run the extractor in chart mode:
   `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26 --from-chart`
   - `axis_ticks` lists the evenly spaced runs it recognised as a scale (one line, or one tick per line).
   - A number on its own labelled line (`Individual housing 71%`) comes back `approximate: false`.
   - A number the text does not tie to a label on its own line comes back `approximate: true` with the flag
     `chart_number_not_tied_to_a_label`. Category labels printed **below** the bars give such numbers their
     period (`period_source: category_labels_below`), but which *series* they belong to is still yours to confirm.
3. Look at the slide itself and decide, per figure (`references/reading-charts.md`):
   - **Printed data label for the bar you want** (right series, right period): write the printed value,
     `approximate: false`, and say in the note "data label on chart".
   - **No data label**: read against the axis to the nearest half gridline, `approximate: true`, and the note
     says how: "read off bar chart against axis gridlines of 300; no data label".
4. If the slide has no text layer at all (`image_only`), and you cannot view the image, do not invent a
   reading. Write `not_disclosed` with the note "shown only as an image on slide N; not readable in this
   environment", and report it.
5. Never compute an exact-looking number from approximate inputs (no "approximately 1,047"). Round an axis
   reading to the precision you can defend (nearest 50 on a 300-gridline axis).
6. In the reply, prefix approximate values with "about" and list them separately from exact ones.
7. Validate (`validate-and-hand-off`). `validate_ip_metrics.py` refuses an `approximate: true` row without a note.

## What to write

Rows as usual, with `approximate` set truthfully and a note that says what was read and how.

## Worked example

Example Housing Finance Ltd, Q2 FY26, slide 10 "Disbursement trend (₹ crore)". Extracted text:

```
Disbursement trend (₹ crore)
1,200
900
600
300
0
890 960 1,050
Q2 FY25 Q1 FY26 Q2 FY26
```

`--from-chart` returns `axis_ticks: [[1200, 900, 600, 300, 0]]` and three candidates 890 / 960 / 1,050 with
periods Q2 FY25 / Q1 FY26 / Q2 FY26 from the category labels below, each `approximate: true` because no label
sits on their line. On the slide the three numbers sit on top of the three bars of a single-series chart
titled "Disbursements": they are data labels. Row: `disbursements = 1050`, `approximate: false`, note
"Data label on the Q2 FY26 bar of the disbursement chart (single series)."

Slide 11 "On-book / off-book AUM" is a stacked bar with only totals labelled (12,345). The off-book segment
for Q2 FY26 reaches from about 10,900 to 12,345 on an axis with gridlines every 2,000:

```json
{"primary_context_entity":"example-hfl","period":"Q2FY26","metric":"off_book_aum","value":1450,"unit":"crore","document":"…/2025-11-04_Q2FY26_investor-presentation.pdf","slide":11,"approximate":true,"from_parent":false,"note":"Read off the stacked bar against gridlines of 2,000; the segment has no data label. Total 12,345 is labelled.","extracted_at":"2025-11-05T10:00:00Z"}
```

Reply: "Off-book AUM: about ₹ 1,450 crore (approximate, read off the chart on slide 11)."

## Failure modes and what to report

| Situation | Do this |
|---|---|
| Numbers and labels are interleaved from two charts on one slide | Treat every candidate as unconfirmed; match by looking at the slide panel by panel (`deck-layout-variants`) |
| Axis is broken, logarithmic or unlabelled | Do not read values off it. `not_disclosed`, note "chart without a readable axis" |
| Dual-axis chart (₹ crore bars, % line) | Make sure which axis your series uses; units differ per axis (`units-in-decks`) |
| Data label is rounded ("1.05k") | Write 1050 with `approximate: true` and the printed form in the note |
| The approximate value disagrees with the quarterly results by more than rounding | Report it. The 5% rule and the choice of value belong to `hfc-kpi-extraction`; keep your row approximate |
