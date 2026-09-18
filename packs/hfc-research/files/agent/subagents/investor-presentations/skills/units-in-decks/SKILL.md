---
description: Use when a deck states amounts in crore on some slides and in millions or billions on others, when a slide names two units or none, when US dollar convenience translations appear next to rupee figures, or when a ratio is given in basis points rather than percent.
---

# Units in decks

Everything you report is in **₹ crore** (amounts), **percent** (ratios) or **count**. The analysts'
conversion table, verbatim from the rulebook:

| Filing unit | Conversion to ₹ crore |
|---|---|
| lakhs | ÷ 100 |
| millions | ÷ 10 |
| billions | × 100 |
| crores | as is |

The arithmetic is done by `finlib.units.to_crore`, never in your head.

## Recognise the variation

| On the slide | Meaning |
|---|---|
| "₹ crore", "Rs. Cr", "INR Cr", "(₹ in crore)" in the title, a corner, or a table header | The slide's unit |
| "₹ mn", "INR million", "₹ bn" | Companies with foreign investors often present in millions or billions |
| Nothing on the slide, but the disclaimer or the first financial slide says "all figures in ₹ crore unless stated" | A deck-level default. Use it only when the slide names no unit, and say so in the note |
| Two units on one slide ("₹ bn (US$ mn)", or "₹ crore" in one panel and "₹ lakh" in another) | `slide_index.py` sets `unit: null` and lists both in `units_found` |
| "US$ 1,180 mn", "$1.2 bn" | **Convenience translation. Ignore it.** Never convert dollars to rupees |
| "Ticket size ₹ 15 lakh" on a slide otherwise in crore | A per-number unit; the suffix on the number wins |
| "Spread 310 bps", "credit cost 35 bps" | Basis points. 100 bps = 1 percent |
| "k", "K" after a number ("12.3k Cr") | Thousands of the stated unit, and rounded: treat as approximate |

## Procedure

1. Read each slide's `unit` and `units_found` from `/workspace/out/slide-index.json`
   (`python3 /workspace/scripts/slide_index.py /workspace/in/deck.pdf > /workspace/out/slide-index.json`).
   The deck's most common unit is `deck_unit`; it is a convenience, **every figure takes the unit of its own slide**.
2. Run `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n>`.
   Unit precedence inside the script: suffix on the number (`₹ 10,500 mn`) > unit named on the line > the
   slide's unit. Each candidate reports `unit_source` and keeps `source_value` / `source_unit`.
3. `unit_unresolved` flag (two units on the slide, or none): look at the slide, decide which unit governs the
   figure's panel or table, and re-run with `--unit million` (or `crore`, `lakh`, `billion`). If you cannot
   tell, do not write the row; report the slide.
4. Counts (branches, employees) are never converted. The script recognises them by label and returns
   `unit: count` even on a "₹ crore" slide.
5. Basis points to percent when the metric is reported in percent (spread 310 bps → 3.10). Do the division
   with the shared library and keep the printed form:
   `python3 -c "import sys; sys.path.insert(0,'/workspace/scripts'); from finlib import numbers; print(numbers.parse_number('310')/100)"`
   then `source_value: 310, source_unit: "bps"`.
6. **Sanity check the magnitude** after conversion. An HFC's quarterly disbursements in ₹ crore are
   typically in the hundreds to tens of thousands. A converted value 10× or 100× away from last quarter's row
   means the unit was misread; re-read the slide before writing.
7. Validate (`validate-and-hand-off`). The validator recomputes `source_value × source_unit` and rejects a
   mismatch, and rejects an amount whose `unit` is not `crore`.

## What to write

`value` in ₹ crore with `unit: "crore"`; `source_value` and `source_unit` whenever the slide was not in crore.

## Worked example

Example Housing Finance Ltd presents in millions. Slide 4: "(₹ in million) AUM 1,23,450 | Disbursements
10,500 | Branches 215". Extractor: AUM `value 12345.0, unit crore, source_value 123450, source_unit million`;
disbursements `1050.0`; branches `215, unit count`.

```json
{"customer_id":"example-hfl","period":"Q2FY26","metric":"aum","value":12345,"unit":"crore","document":"…/2025-11-04_Q2FY26_investor-presentation.pdf","slide":4,"approximate":false,"from_parent":false,"note":"","extracted_at":"2025-11-05T10:00:00Z","source_value":123450,"source_unit":"million"}
```

Slide 22 "Borrowings, INR bn (US$ mn)": "Total borrowings 98.5 (US$ 1,180 mn)". The index gives
`unit: null, units_found: ["million","billion"], usd_present: true`. The extractor marks 1,180 as
`usd_convenience_translation_ignored` and leaves 98.5 `unit_unresolved`. The rupee figures on this slide are
in billions, so re-run with `--unit billion`: 98.5 → 9,850 crore.

## Failure modes and what to report

| Situation | Do this |
|---|---|
| No unit anywhere on the slide and no deck-level statement | Do not assume crore. Report the slide; write no amount from it |
| The unit label contradicts the magnitude (AUM "₹ 12,345 mn" for a company that had ₹ 12,000 crore last quarter) | Likely a typo in the deck. Write no row; report both readings |
| Only a dollar figure is given | No row. Say the deck gives it only in US dollars |
| Lakh crore, trillion | `finlib.units` does not know them. Report; do not convert by hand |
| Indian digit grouping (1,23,450) | Handled by `finlib.numbers.parse_number`. Brackets mean negative; "-", "NA", "Nil" are blanks, not zero |
