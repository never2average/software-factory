---
description: Use when extracting the number of branches, the number of employees or the quarter's disbursements from an investor presentation, when the deck says "locations", "touchpoints" or "districts" instead of branches, when headcount is given as on-roll versus total, or when branches or employees are missing this quarter and the previous quarter's value must be offered for carry-forward.
---

# Operational metrics: branches, employees, disbursements

The analysts' rulebook makes the investor presentation **the** source for these three. They feed the
productivity ratios (disbursement per branch, per employee; cost per employee), which `hfc-kpi-extraction`
computes. You supply the inputs and say exactly what was counted.

## Recognise the variation

| Metric | The same fact arrives as | Record |
|---|---|---|
| Branches | "215 branches", "Branch network: 215", "Presence in 162 locations", "480 touchpoints", "140 districts across 14 states" | `basis`: `branches`, `locations`, `touchpoints`, `districts` or `states`. Only `basis: branches` is the branch count |
| Employees | "3,410 employees", "Team strength 3,410", "On-roll 3,410; off-roll 620", "Workforce of 4,030 including off-roll" | `basis`: `on_roll`, `off_roll`, `total`, or `unspecified` when the deck does not say |
| Disbursements | "Disbursements ₹ 1,050 Cr", "Disbursals", "Loans disbursed", a bar chart, "H1 disbursements ₹ 2,010 Cr" | the **discrete quarter**; `period_basis: ytd` only when no quarter exists and none can be derived |

The full synonym table is `references/metric-synonyms.json` (the scripts read the same table at
`/workspace/references/metric-synonyms.json`). `references/label-synonyms.md` explains the traps.

## Procedure

1. Build the index if you have not: `python3 /workspace/scripts/slide_index.py /workspace/in/deck.pdf > /workspace/out/slide-index.json`
2. Rank the slides:
   `python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric branches --metric employees --metric disbursements`
   For branches and employees the result carries `basis_hits`: which of branches / locations / touchpoints /
   districts / on-roll / total the slide mentions.
3. Pull the candidates from the best slide:
   `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`
4. **Branches.** Take the number labelled branches (or branch offices). If the slide gives only locations,
   touchpoints or districts, write that number with its `basis` and say in the note that the deck gives no
   branch count. Never relabel a touchpoint count as branches. If it gives both, write the `branches` row;
   add the others as separate rows only when the analyst asked for them.
5. **Employees.** Prefer the figure the deck itself headlines. Record `basis`. If both on-roll and total are
   given, write the on-roll row and mention the total in the note (`"Total incl. off-roll 4,030, slide 15"`).
   If the deck does not say which, `basis: unspecified` and say so; do not assume.
6. **Disbursements.** Take the discrete quarter (`is_target_period: true` in the candidates). Convert to
   ₹ crore (the script does this from the slide's unit; see `units-in-decks`). If only H1/9M/FY is shown, see
   `mixed-periods-on-a-slide`. If only a chart without data labels, see `chart-only-figures`.
7. **Missing this quarter (branches, employees).** The rulebook: use the previous quarter's IP value. So:
   1. Say plainly that the Q2 FY26 deck does not give it, and which slides you checked.
   2. Read the previous quarter's value: first from `ip-metrics.jsonl` (`dataroom_read`), else from the
      previous quarter's deck in the data room.
   3. Write a `status: not_disclosed` row for **this** period with `value: null`, and put the previous value in
      `carried_from_period`, `carried_value`, `carried_document`, `carried_slide`. The value field of this
      quarter never holds a carried number: the analysts carry it forward with a footnote, not you.
   4. If no previous value is on file either, say so in the note.
8. Validate before writing (`validate-and-hand-off`).

## What to write

One row per metric in `/workspace/out/ip-metrics.new.jsonl`; schema `/workspace/schemas/ip-metric-row.schema.json`.
Counts: `unit: "count"`, whole numbers. Disbursements: `unit: "crore"`.

## Worked example

Example Housing Finance Ltd, Q2 FY26, slide 15 "Pan-India distribution network":
`Branches 215   Locations 162   Touchpoints 480   Districts 140` and `On-roll employees 3,410`.
Slide 9 table: `Disbursements 890 960 1,050 2,010` under `Q2 FY25  Q1 FY26  Q2 FY26  H1 FY26`, unit ₹ crore.

```json
{"customer_id":"example-hfl","period":"Q2FY26","metric":"branches","value":215,"unit":"count","document":"Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf","slide":15,"approximate":false,"from_parent":false,"note":"","extracted_at":"2025-11-05T10:00:00Z","basis":"branches","source_label":"Branches"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"employees","value":3410,"unit":"count","document":"Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf","slide":15,"approximate":false,"from_parent":false,"note":"","extracted_at":"2025-11-05T10:00:00Z","basis":"on_roll","source_label":"On-roll employees"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"disbursements","value":1050,"unit":"crore","document":"Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf","slide":9,"approximate":false,"from_parent":false,"note":"Discrete quarter from the quarterly trend table; H1 FY26 of 2,010 shown alongside was not used.","extracted_at":"2025-11-05T10:00:00Z","source_label":"Disbursements"}
```

Next quarter the Q3 FY26 deck drops the employee count:

```json
{"customer_id":"example-hfl","period":"Q3FY26","metric":"employees","value":null,"unit":"count","document":"Companies/example-hfl/filings/presentations/2026-02-03_Q3FY26_investor-presentation.pdf","slide":null,"approximate":false,"from_parent":false,"note":"Not given in the Q3 FY26 deck (checked slides 4, 15, 33). Q2 FY26 IP value offered for carry-forward.","extracted_at":"2026-02-04T09:00:00Z","status":"not_disclosed","carried_from_period":"Q2FY26","carried_value":3410,"carried_document":"Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf","carried_slide":15}
```

Reply line: "Employees: not disclosed in the Q3 FY26 deck. Previous value 3,410 (on-roll), Q2 FY26 deck,
slide 15, for carry-forward with a footnote."

## Failure modes and what to report

| Situation | Do this |
|---|---|
| Deck gives "480 touchpoints" and no branch count | Row with `basis: touchpoints`; note that branches are not disclosed; also offer last quarter's branch count as in step 7 |
| Branch count differs between the network slide and the highlights tile | `deck-layout-variants` > which slide to cite. If they truly conflict, no row; report both |
| Headcount jumps because the basis changed (on-roll last quarter, total now) | Write what the deck says with its `basis`, and flag the change of basis in the note and the reply. `hfc-kpi-extraction` must not compare them silently |
| Disbursements stated only as growth ("up 18% YoY") | No row from growth alone. Do not back-compute from last year's number |
| "Sanctions" or "logins" given, not disbursements | Not the same thing. `not_disclosed` for disbursements; mention the sanction figure in the reply only |
| Count printed as "3.4k" or "~3,400" | Write nothing exact from it: `approximate: true`, note the printed form |
