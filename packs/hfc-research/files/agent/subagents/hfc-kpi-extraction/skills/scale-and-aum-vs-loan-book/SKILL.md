---
description: Use when extracting the scale metrics (AUM, loan book, disbursements, networth, borrowings, branches, employees), when AUM and loan book are labelled differently or confused with each other (managed book, on-book, off-book, loan assets), or when applying the rule that AUM equal to the loan book means there is no sell down.
---

# Scale metrics, and AUM versus loan book

Rulebook definitions:

- **AUM** = Assets Under Management = on-book + off-book loans.
- **Loan Book Value** = on-book loans, "to be extracted from the Balance Sheet".
- "If AUM equals the Loan Book, then no Sell Down Volume is found (as there are no off-book loans)."
- Scale metrics come from "Key Highlights, Balance Sheet, Quarterly Performance section, and Financial Highlights".

## Where each metric lives

| KPI | First place to look | Second | Kind |
|---|---|---|---|
| `aum` | IP: key highlights / AUM slide | QR press release or notes (rare) | balance |
| `loan_book` | QR: statement of assets and liabilities, line "Loans" under financial assets | IP: "on-book" / "loan book" figure on the AUM slide | balance |
| `disbursements` | IP: quarterly performance / disbursement slide | QR notes or press release | flow (must be the quarter) |
| `networth` | QR: balance sheet "Total equity" (equity share capital + other equity), or the "Net worth" line of the ratios note | IP: financial highlights | balance |
| `borrowings` | QR: balance sheet: debt securities + borrowings (other than debt securities) + deposits + subordinated liabilities | IP: liability / borrowing profile slide | balance |
| `branches` | IP: distribution / network slide | none | count |
| `employees` | IP: distribution or people slide | none | count |

Label synonyms and the regexes that match them are in `references/label-synonyms.md`. Ask the catalog what a label is:

```
python3 /workspace/scripts/kpi_catalog.py --match "Loan assets under management"
python3 /workspace/scripts/kpi_catalog.py --match "On-book loans"
```

`verdict: ambiguous` or `no_match` means the label alone does not decide it: read the slide's footnote or the note
the line refers to.

## Recognise the variation

- **Balance sheet only twice a year.** Quarterly results normally carry a statement of assets and liabilities with
  the half-year and year-end results, and not with the Q1 and Q3 results. Check the document in front of you. When
  the quarter's QR has no balance sheet: take `loan_book`, `networth` and `borrowings` from the ratios note in the
  QR if it gives them, else from the IP for the same quarter (source `IP`, footnote "No balance sheet in the
  quarter's results; on-book loans from the investor presentation"). If neither has it, apply
  `missing-data-and-carry-forward`.
- **"Loans" on the balance sheet is net of the impairment allowance**; AUM in the IP is gross. So AUM is normally a
  little above the balance sheet loans even with nothing off-book. The rulebook's loan book is the balance sheet
  figure, so report that. For the sell-down rule see below.
- **AUM that includes more than loans**: co-lending partner share, securitised pools, developer finance, or
  inter-corporate deposits. Record the company's definition in `definition` and `remember` it.
- **Borrowings is several balance sheet lines.** Add them with the script, not by hand (step 3).
- **Branches**: "branches", "offices", "locations", "touchpoints", "points of presence" are not the same thing. Use
  the count labelled branches. If the company only publishes another kind of count, use it, name it in `definition`,
  and keep using the same one every quarter.

## Procedure

1. `python3 /workspace/scripts/detect_content_type.py <file> --find "assets under management|\bAUM\b" "statement of assets and liabilities" "disbursement" "branch" "employee|headcount"`
   to get the pages.
2. Read each value as printed, with its unit header, page and the as-at date. Balances must be as at the quarter-end
   date. Disbursements must be the three-month figure.
3. Convert each with `python3 /workspace/scripts/convert_units.py --stdin`. For borrowings, convert every component
   line and add the `crore` values in the sandbox (`python3 -c "print(round(a+b+c, 2))"`), and list the components in
   `definition`, for example "debt securities + borrowings + subordinated liabilities".
4. Where both QR and IP give the metric, reconcile: `python3 /workspace/scripts/reconcile_sources.py --request ...`.
5. Apply the sell-down rule with the calculator (it is part of the same run that computes the ratios):

   ```
   python3 /workspace/scripts/compute_kpis.py --inputs /workspace/out/inputs-q2fy26.json
   ```

   Read `sell_down_verdict`:

   | `action` | Meaning | You do |
   |---|---|---|
   | `record_not_found` | AUM equals the loan book (after rounding both to 2 decimals, or within an explicit tolerance) | write `sell_down_volume` as `not_found` with the verdict's `footnote`, and do NOT search for it |
   | `search` | off-book loans exist, or the rule cannot be applied | go to the `sell-down-and-buy-out` skill |

   If the verdict carries a `hint` (small gap, balance sheet loans are net of provisions), find gross loans in the
   loans note, pass it as `loan_book_gross`, and run again. Pass a tolerance (`--sd-tolerance-pct 0.1`) only when
   the two figures differ because one document rounds to the nearest crore; say so in the footnote (the script does).
6. Buy out volume is NOT covered by this rule: a company with no off-book loans can still have bought a pool.

## Worked example (synthetic)

**Example Housing Finance Ltd, Q2 FY26.** IP slide 5: "AUM ₹100.0 bn, of which on-book ₹82.0 bn, assigned ₹18.0 bn".
QR page 5 balance sheet: Loans 8,14,300 (₹ in lakhs); loans note: gross loans 8,20,000, impairment allowance 5,700.

- `aum` = 10000.00 (IP, slide 5). `loan_book` = 8143.00 (QR, p.5; "net of impairment allowance" in `definition`).
- Verdict with `loan_book_gross` 8200.00: off-book 1800.00 → `action: search`.

**Sample Home Loans Ltd, Q2 FY26.** IP: "AUM ₹4,200 crore (100% on book)". QR gross loans 4,20,000 lakh.

- Verdict: `aum_equals_loan_book: true`, `action: record_not_found`, footnote "AUM (₹4,200.00 crore) equals the loan
  book (₹4,200.00 crore, gross of impairment allowance): no off-book loans, so no sell down volume (rulebook rule)."

## Failure modes

- **Loan book larger than AUM**: impossible by definition. `compute_kpis.py` warns and `validate_kpis.py` rejects
  (`E-LOANBOOK`, beyond 1%). Usual causes: consolidated loans vs standalone AUM, a unit slip, or different dates.
- **AUM only on a chart** with no data label: `needs_review`, `read_from_chart: true`.
- **Disbursements only as H1/9M/FY**: derive the quarter (`discrete-quarter-from-cumulative`).
- **Sanctions are not disbursements.** A slide headed "Sanctions" is a different metric: `not_found`.
- **Networth vs "net worth as per Companies Act"**: the ratios note may define net worth differently from total
  equity. Prefer the balance sheet's total equity when there is a balance sheet; otherwise the note's figure with
  its wording in `definition`.
