---
description: Use when looking for sell down (loans assigned, transferred, co-lent or securitised off the balance sheet) and buy out (portfolios or pools acquired) volumes in an investor presentation, usually in the appendix or the borrowing slides; when the figure is quarter versus year to date; when the deck shows nil or nothing; or when AUM equals the loan book.
---

# Sell down and buy out

Rulebook definitions, verbatim: **Sell Down Volume (SD): loans transferred/assigned (moved off balance
sheet). Buy Out Volume (BO): loans acquired (brought onto balance sheet).** They are "extracted from the
Appendix section of financial reports or disclosure tables". And: **if AUM equals the loan book, no sell down
volume is found.** Restructured-book details are excluded.

Both are **flows for the quarter**, not balances. The assigned portfolio *outstanding* is a balance and
belongs to `off_book_aum` (`aum-mix-and-off-book`).

## Recognise the variation

| Where | What it looks like |
|---|---|
| Appendix table, often titled "Details of loans transferred / acquired" or "Transfer of loan exposures" | Rows for loans transferred through assignment and loans acquired, with count, amount, retention, tenor. Usually for the quarter **and** the half year / nine months side by side |
| Borrowing / liability slide | "Direct assignment ₹ 180 Cr during Q2" as a funding source, or a bar in the funding mix chart |
| AUM slide | "Co-lending disbursements ₹ 45 Cr", "Assigned during the quarter" |
| Highlights | "Completed DA transactions of ₹ 180 Cr" as a bullet |
| Nowhere | The company does not sell down, or does not disclose the flow |

Labels: `references/sell-down-buy-out-labels.md`.

## Procedure

1. Do the AUM check first. If `aum` equals `loan_book` for the quarter (`aum-mix-and-off-book`), write the
   `no_off_book` row for `sell_down_volume` and go to step 6 for buy out. Do not hunt for a number the rulebook
   says is not there.
2. `python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric sell_down_volume --metric buy_out_volume`
   Appendix slides get a bonus. Slides titled as restructured-book are listed under `excluded_slides` and are
   never candidates.
3. `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`
   Lines that mention restructuring land in `excluded`, not in `candidates`.
4. **Pick the discrete quarter.** If the table has "Q2 FY26" and "H1 FY26" columns, take Q2. If it has only
   H1/9M: derive the quarter only from the **same company's previous deck** value already in
   `ip-metrics.jsonl` (H1 minus Q1), mark `status: derived` and show the arithmetic in the note; otherwise
   write the YTD figure with `period: H1FY26`, `period_basis: ytd`. See `mixed-periods-on-a-slide`.
5. **What counts as sell down.** Direct assignment and the partner's share of co-lending, as the deck
   presents them as transferred or off-book. Securitisation counts only if the deck treats the pool as
   derecognised / off-book; many pass-through structures stay on the balance sheet. If the deck lists
   components, write one `sell_down_volume` row with the total and the components in the note. Do not add
   components the deck does not add itself unless they are clearly disjoint; if you add, say so in the note.
6. **Nil handling.**
   - The deck prints "Nil", "-" or "0" against the line: `value: 0`, `status: nil`, with the slide.
   - The deck has the table but no such line, or no such slide at all: `value: null`,
     `status: not_disclosed`, `slide: null`, and the note lists what you searched.
   - AUM equals loan book: `status: no_off_book` (sell down only).
   A missing number is never written as 0.
7. Validate (`validate-and-hand-off`).

## What to write

`sell_down_volume` and `buy_out_volume` rows, `unit: crore`, every quarter, even when nil or not disclosed:
`hfc-kpi-extraction` needs to know which of the three it is.

## Worked example

Example Housing Finance Ltd, Q2 FY26. Slide 38 is the "Appendix" divider. Slide 41, ₹ crore:

```
Details of loans transferred and acquired      Q2 FY26    H1 FY26
Loans transferred through direct assignment        180        310
Co-lending: partner's share of disbursements        45         80
Loans acquired (portfolio buyout)                  Nil        Nil
```

Slide 44 "Restructured book" also has a line "Assigned from restructured pool 4": excluded, never read.

```json
{"primary_context_entity":"example-hfl","period":"Q2FY26","metric":"sell_down_volume","value":225,"unit":"crore","document":"…/2025-11-04_Q2FY26_investor-presentation.pdf","slide":41,"approximate":false,"from_parent":false,"note":"Direct assignment 180 + co-lending partner share 45, both printed for Q2 FY26 and shown by the deck as transferred; H1 FY26 column (310 + 80) not used.","extracted_at":"2025-11-05T10:00:00Z","source_label":"Loans transferred through direct assignment; Co-lending: partner's share"}
{"primary_context_entity":"example-hfl","period":"Q2FY26","metric":"buy_out_volume","value":0,"unit":"crore","document":"…","slide":41,"approximate":false,"from_parent":false,"note":"Deck prints 'Nil' for loans acquired in Q2 FY26.","extracted_at":"2025-11-05T10:00:00Z","status":"nil"}
```

## Failure modes and what to report

| Situation | Do this |
|---|---|
| AUM > loan book but no sell-down flow anywhere | `not_disclosed`. Say that off-book exists (give the amount) but the quarter's flow is not shown. Do not infer the flow from the change in the off-book balance: repayments and new assignments both move it |
| Only "upfront income on assignment" in the P&L slide | That is income, not volume. `not_disclosed`; mention the income line in the reply |
| Table is in the results' notes, not the deck | That is the quarterly report: tell the caller `lodr-filings` / `hfc-kpi-extraction` has it; write `not_disclosed` for the IP |
| Units on the appendix table differ from the rest of the deck (₹ lakh) | Trust the table's own header. `units-in-decks` |
| "Inorganic growth ₹ 300 Cr" without saying pool purchase | Quote it in the note; write the `buy_out_volume` row only if the deck says the loans were acquired |
| Sell down positive while AUM == loan book on the slides | Validator error `aum_loan_book`. Re-read both; if the deck really says both, write neither row and report the contradiction |
