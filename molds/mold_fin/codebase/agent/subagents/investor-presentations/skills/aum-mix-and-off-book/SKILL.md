---
description: Use when reading AUM, the loan book, the on-book versus off-book split, assigned, co-lent or securitised pools, the product mix (individual housing, LAP, construction or developer finance, affordable), the salaried versus self-employed split, ticket size or LTV from an investor presentation.
---

# AUM, its mix, and the off-book part

The rulebook defines **AUM = on-book + off-book loans** and takes the **loan book from the balance sheet**.
The deck is where the split between the two is shown. Get this right and sell down follows; get it wrong and
every per-AUM ratio downstream is wrong.

## Recognise the variation

| The deck shows | It means | Rows |
|---|---|---|
| "AUM ₹ 12,345 Cr" and "Loan book ₹ 10,900 Cr" | Off-book of about 1,445 exists | `aum`, `loan_book`; `off_book_aum` only if the deck **prints** it |
| "On-book 88% / Off-book 12%" of AUM | Same, as shares | `aum`; the split goes in the note unless amounts are printed. Do not multiply a rounded share into an amount and present it as exact |
| Only "AUM" everywhere, footnote "AUM = loan assets" | AUM equals the loan book: no off-book | `aum`, `loan_book` (same value, same slide), and a `no_off_book` row for `sell_down_volume` |
| "Assigned portfolio", "DA outstanding", "Co-lent book", "Securitised portfolio" | Components of off-book | One `off_book_aum` row with the total; list the components in the note |
| "Gross loans" vs "Net loans" (after ECL) | Two on-book figures | Take gross for `loan_book`; say so. The balance-sheet figure belongs to `hfc-kpi-extraction` |

Securitised pools: whether they are off-book depends on the accounting (many pass-through structures stay on
the balance sheet). Trust how the deck in front of you classifies them and quote its wording in the note.

## Procedure

1. `python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric aum --metric loan_book --metric off_book_aum`
2. `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`
   AUM and loan book are balances: the period is the quarter whose **end date** the slide shows ("Sep-25",
   "as on 30 September 2025" map to Q2 FY26; the index does this).
3. Write `aum` and `loan_book` from the **same slide** where possible, so they share rounding.
4. Compare them. If they are equal, apply the rulebook: *no sell down is found*. Write the `no_off_book` row
   (example below). `validate_ip_metrics.py` refuses a positive sell down next to AUM == loan book.
5. **Product mix.** `--metric aum_mix_individual_housing` (and `_lap`, `_construction_finance`,
   `_affordable`, `_other`). Record shares as `unit: percent` with `basis: aum` (or `loan_book` /
   `disbursements`: read the slide title: "Disbursement mix" is not "AUM mix"). Mix vocabulary is in
   `references/mix-vocabulary.md`.
   - **Affordable is usually a cut across housing, not a fourth product.** If the pie is
     housing / LAP / construction = 100% and a separate line says "affordable 35% of AUM", give the affordable
     row its own `basis` (`affordable_cut`). The validator rejects mixes that add to more than 100 on one basis.
6. **Customer mix.** `aum_mix_salaried`, `aum_mix_self_employed`. Some decks split self-employed into
   professional and non-professional: add them only if the slide prints the total; otherwise write the two in
   the note and the printed total if any.
7. **Ticket size and LTV.** `avg_ticket_size` in ₹ crore (₹ 15 lakh = 0.15 crore; keep
   `source_value: 15, source_unit: "lakh"`). `avg_ltv` in percent. Say in the note whether it is at
   origination or on the outstanding book, and on the portfolio or on incremental disbursements.
8. Pie and doughnut charts: see `chart-only-figures`. Printed segment labels are exact; a segment without a
   label is not.
9. Validate (`validate-and-hand-off`).

## What to write

Rows in `/workspace/out/ip-metrics.new.jsonl`. Amounts `unit: crore`; shares `unit: percent` with `basis`.

## Worked example

Example Housing Finance Ltd, Q2 FY26, slide 9 (₹ crore): `AUM 12,345 | On-book 10,900 | Off-book 1,445
(Direct assignment 1,020; Co-lending 425)`. Slide 12: `Individual housing 71% | LAP 19% | Construction
finance 10%`, footer `Affordable housing (ticket < ₹ 25 lakh): 35% of AUM`, `Salaried 58% | Self-employed 42%`,
`Average ticket size ₹ 15 lakh | Average LTV at origination 62%`.

```json
{"customer_id":"example-hfl","period":"Q2FY26","metric":"aum","value":12345,"unit":"crore","document":"…/2025-11-04_Q2FY26_investor-presentation.pdf","slide":9,"approximate":false,"from_parent":false,"note":"","extracted_at":"2025-11-05T10:00:00Z"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"loan_book","value":10900,"unit":"crore","document":"…","slide":9,"approximate":false,"from_parent":false,"note":"Deck's 'On-book' figure, gross. The balance-sheet loan book is hfc-kpi-extraction's to take from the results.","extracted_at":"2025-11-05T10:00:00Z","source_label":"On-book"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"off_book_aum","value":1445,"unit":"crore","document":"…","slide":9,"approximate":false,"from_parent":false,"note":"Direct assignment 1,020 + co-lending 425, as printed.","extracted_at":"2025-11-05T10:00:00Z"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"aum_mix_affordable","value":35,"unit":"percent","document":"…","slide":12,"approximate":false,"from_parent":false,"note":"A cut across products (ticket below Rs 25 lakh), not a fourth product; the product pie adds to 100 without it.","extracted_at":"2025-11-05T10:00:00Z","basis":"affordable_cut"}
{"customer_id":"example-hfl","period":"Q2FY26","metric":"avg_ticket_size","value":0.15,"unit":"crore","document":"…","slide":12,"approximate":false,"from_parent":false,"note":"Rs 15 lakh, on the outstanding book.","extracted_at":"2025-11-05T10:00:00Z","source_value":15,"source_unit":"lakh"}
```

A company with no off-book (AUM 8,200 = loan book 8,200 on slide 6):

```json
{"customer_id":"example-hfl","period":"Q2FY26","metric":"sell_down_volume","value":null,"unit":"crore","document":"…","slide":null,"approximate":false,"from_parent":false,"note":"AUM equals the loan book (8,200, slide 6): no off-book loans, so no sell down is found.","extracted_at":"2025-11-05T10:00:00Z","status":"no_off_book"}
```

## Failure modes and what to report

| Situation | Do this |
|---|---|
| AUM is **below** the loan book | Definitions differ (AUM net of something, or loan book includes investments). Write both, capture the definition (`metric-definitions-glossary`), and say so. The validator warns |
| Loan book + off-book does not equal AUM | Same. Record the definition; do not force the numbers to add |
| Mix given only for disbursements, not AUM | Write it with `basis: disbursements`; say AUM mix is not disclosed |
| Mix categories do not match the five keys ("Prime / Affordable / Emerging") | Write what maps cleanly; put the deck's own categories and shares in the note of an `aum_mix_other` row; never split a category by guess |
| Shares are read from a pie with no labels | `chart-only-figures`. `approximate: true` |
| The slide is about the restructured book | Excluded by the rulebook. Extract nothing |
