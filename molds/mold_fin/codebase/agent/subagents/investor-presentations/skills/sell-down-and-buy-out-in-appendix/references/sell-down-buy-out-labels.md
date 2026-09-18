# Labels for sell down and buy out

The matching table is the `sell_down_volume` and `buy_out_volume` entries of
`/workspace/references/metric-synonyms.json` (print it with `cat`). This page explains how to read what the labels find.

## Sell down (loans leave the balance sheet)

| Label | Flow or balance? | Count as sell down? |
|---|---|---|
| Loans assigned during the quarter; Direct assignment (DA) transactions; Assignment volume | Flow | Yes |
| Loans transferred through assignment; Details of loans transferred; Transfer of loan exposures | Flow | Yes |
| Co-lending disbursements (partner's share); Co-lent during the quarter | Flow | Yes, the partner's share only. If the slide gives total co-lending disbursements and the sharing ratio, quote both; do not compute the share unless the deck prints it |
| Securitisation / PTC transactions during the quarter | Flow | Only if the deck treats the pool as derecognised or off-book |
| Assigned portfolio; DA outstanding; Co-lent book; Off-book AUM | **Balance** | No. That is `off_book_aum` |
| Upfront income on assignment; Income on derecognised loans | P&L income | No |

## Buy out (loans come onto the balance sheet)

| Label | Count as buy out? |
|---|---|
| Portfolio buyout; Pool purchase; Pools purchased; Loans acquired; Loans acquired through assignment; Inward direct assignment | Yes |
| Acquired portfolio outstanding; Purchased portfolio | Balance, not the quarter's volume. Mention in the note |
| Inorganic growth; Inorganic book | Only if the deck says loans were acquired |
| Share buyback; Buyback of shares; Buy-back of NCDs | **No.** Capital or liability actions. The scripts blank these phrases before matching |
| Balance transfer in (BT-in) | No. Individual loans refinanced from other lenders are ordinary disbursements |

## Period columns on these tables

| Header | Take |
|---|---|
| "Q2 FY26" / "Quarter ended 30.09.2025" | Yes |
| "H1 FY26" / "Half year ended" / "9M FY26" | Only to derive (with last quarter's filed value) or, failing that, as a labelled YTD row |
| "FY25" (previous year, for comparison) | No |

## Worked example

`python3 /workspace/scripts/extract_labelled_numbers.py --text-file slide41.txt --period Q2FY26` on the
table in the skill's worked example returns, for the label "Loans transferred through direct assignment",
two candidates: 180 (`period: Q2 FY26`, `is_target_period: true`) and 310 (`period: H1 FY26`, flag
`not_a_discrete_quarter`). "Nil" yields no number candidate: you write the `nil` row yourself, citing the slide.
