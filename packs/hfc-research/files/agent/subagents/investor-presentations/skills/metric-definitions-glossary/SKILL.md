---
description: Use when capturing how the company itself defines AUM, NIM, spread, yield, cost of funds, cost-to-income, ROA, ROE or GNPA from a deck's footnotes or glossary slide, when the deck's ratio disagrees with the quarterly results, or when deciding what to store with remember for next quarter.
---

# The company's own metric definitions

HFCs compute the same-named ratio differently. The analysts' rulebook has its **own** formulas
(cost-to-income = operating expenses ÷ net interest income; ROA = quarterly PAT × 4 ÷ AUM; ROE = quarterly PAT
× 4 ÷ net worth), and those belong to `hfc-kpi-extraction`. Your job is to record what the **company** means,
because that explains most differences between the deck and the results.

## Recognise the variation

| Where | Looks like |
|---|---|
| A "Glossary", "Definitions", "Basis of computation" slide, usually last in the appendix | A two-column table: term, formula |
| Footnotes under a ratio table | "NIM = NII / average total assets, annualised", superscripts ¹ ² ³ |
| A small-print line under a chart | "Spread = yield on loans less cost of borrowings, on daily average" |
| The disclaimer | "AUM includes assigned and co-lent portfolio" |
| Nowhere | The deck does not define it. Say so; do not supply a textbook definition |

Dimensions on which definitions differ are in `references/definition-dimensions.md`.

## Procedure

1. Find the slides:
   `python3 /workspace/scripts/slide_index.py /workspace/in/deck.pdf > /workspace/out/slide-index.json`
   then look at slides with `section: "glossary"`, and at the footnote lines of the `margins_spreads`,
   `financials` and `highlights` slides (the `text` field of each slide).
2. For each of AUM, yield, cost of funds, spread, NIM, cost-to-income, ROA, ROE, GNPA basis: copy the
   definition **verbatim**, with the slide number. If a term is not defined, record "not defined in deck".
3. Note the dimensions that matter (`references/definition-dimensions.md`): denominator (AUM / loan book /
   total assets / average vs closing), annualisation, on-book vs managed, whether fee or assignment income is
   inside yield or NIM, what "operating expenses" includes, GNPA on AUM vs on loan book.
4. **Compare with the rulebook's definitions** and state each difference in one line. Example: "Company
   cost-to-income = opex ÷ total net income; rulebook = opex ÷ NII. The company's figure will be lower."
   Do not recompute anything; `hfc-kpi-extraction` does.
5. **Compare with last quarter.** `list_memories` for this company's definitions. If a definition changed,
   say so prominently: a changed definition breaks the time series.
6. **Store what will matter next quarter** with `remember`, one memory per company, replacing the old one:
   the verbatim definitions, the slide numbers, the deck's period, and any change. Keep it short and factual.
7. Put the company's presented values for yield, cost of funds, spread and NIM into `ip-metrics.jsonl`
   (`unit: percent`, discrete quarter, the definition summarised in `note`). Pull candidates with
   `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`.
   Cost-to-income, ROA, ROE, GNPA are **not** written to `ip-metrics.jsonl`: they are the KPI subagent's
   ratios; you report only their definitions.
8. Validate (`validate-and-hand-off`).

## What to write

- `ip-metrics.jsonl`: `yield`, `cost_of_funds`, `spread`, `nim` rows, as presented.
- `remember`: the definitions memory.
- The reply: a "Definitions" block with verbatim text, slide numbers, and differences from the rulebook.

## Worked example

Example Housing Finance Ltd, Q2 FY26, slide 45 "Glossary":

```
AUM: on-book loan assets plus assigned and co-lent loans serviced by the Company
Yield: interest income on loans / average on-book loans, annualised
Cost of funds: finance cost / average borrowings, annualised
Spread: Yield less Cost of funds
NIM: (NII + assignment income) / average AUM, annualised
Cost to income: operating expenses / (NII + other income)
ROA: PAT / average total assets, annualised
```

Reply block:

> **Definitions (slide 45, verbatim above).** Differences from the analysts' rulebook: NIM includes assignment
> income and is on average AUM; cost-to-income divides by NII **plus other income** (rulebook: NII only), so
> the company's ratio will read lower; ROA is on average total assets (rulebook: AUM). GNPA basis: not defined
> in the deck. No change from Q1 FY26.

Memory stored: "example-hfl definitions as of Q2 FY26 deck (slide 45): AUM = on-book + assigned + co-lent;
yield on avg on-book loans; NIM = (NII + assignment income)/avg AUM; C/I = opex/(NII + other income); ROA on
avg total assets; GNPA basis not defined. Unchanged vs Q1 FY26."

Row: `{"metric":"nim","value":4.2,"unit":"percent","slide":20,"note":"As presented: (NII + assignment income)/average AUM, annualised (glossary, slide 45).", …}`

## Failure modes and what to report

| Situation | Do this |
|---|---|
| No glossary and no footnotes | Say "the deck does not define its ratios". Do not infer a definition from the numbers |
| Definition changed from last quarter | Lead the definitions block with the change; update the memory; mention that prior quarters are not comparable |
| Two slides define the term differently | Quote both with slide numbers; do not pick |
| Ratio shown both "reported" and "adjusted / normalised" | Record both labels; write the row for the unadjusted figure and put the adjusted one in the note |
| The deck's ratio differs from the quarterly results | Report the definition that explains it if there is one. The choice of value (and the 5% tolerance) belongs to `hfc-kpi-extraction` |
