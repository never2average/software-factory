---
description: Use when extracting Sell Down Volume (loans transferred, assigned, securitised or co-lent off the balance sheet) or Buy Out Volume (loan pools acquired) from the transfer-of-loan-exposures disclosure in the quarterly results notes or from the investor presentation appendix, including year-to-date disclosures and "Nil".
---

# Sell down and buy out

Rulebook: **Sell Down Volume (SD)** = loans transferred / assigned (moved off balance sheet). **Buy Out Volume (BO)**
= loans acquired (brought onto balance sheet). Source: "the Appendix section of financial reports or disclosure
tables". Both are FLOWS for the quarter, in ₹ crore.

## Before you search

Run the sell-down rule first (`scale-and-aum-vs-loan-book`, step 5). If
`python3 /workspace/scripts/compute_kpis.py --inputs <inputs.json>` returns
`sell_down_verdict.action == "record_not_found"`, write `sell_down_volume` as `not_found` with the verdict's footnote
and stop. That rule says nothing about buy out: still look for BO.

## Where it is

| Place | What it looks like |
|---|---|
| QR notes | a note that begins along the lines of "Details of loans transferred / acquired during the quarter ... under the RBI's directions on transfer of loan exposures", followed by one or two small tables: loans not in default transferred through assignment, loans acquired through assignment, and (separately) stressed loans transferred. The direction's exact title and date may change: trust the note in front of you. |
| QR notes (securitisation) | a separate sentence or table on securitisation / pass-through certificates, if any |
| IP appendix / annexure / data book | "Direct assignment during the quarter", "Assignment volume", "Co-lending disbursements", "Portfolio buyout", often a small table across quarters |
| IP AUM slide | "off-book AUM" / "assigned book outstanding": that is a BALANCE (the stock), not the quarter's volume. Never use it as SD. |

Find the pages:

```
python3 /workspace/scripts/detect_content_type.py /workspace/in/q2fy26-results.pdf \
  --find "transfer\s+of\s+loan\s+exposures" "transferred\s+through\s+(direct\s+)?assignment" "loans?\s+acquired" \
         "securiti[sz]ation" "co[- ]?lending"
```

Vocabulary and table row labels are in `references/disclosure-vocabulary.md`.

## What counts

| Counts as Sell Down Volume | Does not |
|---|---|
| aggregate amount (principal outstanding) of loans transferred through direct assignment during the quarter | outstanding assigned book (a balance) |
| loans securitised during the quarter WHERE derecognised (off balance sheet) | securitisation that stays on the balance sheet (not "moved off balance sheet") |
| co-lending: the partner's share originated during the quarter, where the company reports it as transferred or off-book | the company's own retained share |
| | income or gain on assignment, upfront income, excess interest spread |
| | stressed loans / NPAs transferred to an ARC: report separately in the footnote, not in SD, because the analysts' definition is about funding sell-downs. This is an assumption: say it in the footnote when such a transfer exists. |

| Counts as Buy Out Volume | Does not |
|---|---|
| aggregate amount of loans acquired through assignment / portfolio buy-out during the quarter | loans originated through co-lending partners on the company's own book |
| pools purchased (retail pools, pass-through of on-book assets where the company books the loans) | investments in PTCs (an investment, not loans) unless the company classifies them as loans: then footnote it |

If SD has several components (assignment + derecognised securitisation + co-lending), convert each, add them in the
sandbox, and list the components in `definition` and the footnote.

## Quarter versus year to date

The note is often worded "during the quarter ended ..." but some companies disclose "during the half year / nine
months / year ended ...". Read the sentence above the table.

- Quarter figure printed → use it.
- Only year-to-date printed → derive the quarter from the previous filing's year-to-date figure:

  ```
  python3 /workspace/scripts/derive_quarter.py --kind flow --metric sell_down_volume \
    --through "H1 FY26" --through-value "540.00" --before "Q1 FY26" --before-value "230.00" --unit crore
  ```

  Set `derived_from_cumulative: true` and use the script's footnote.
- Earlier filing not in the data room → `not_found`, name the missing filing.

## Nil handling

| The document says | Row |
|---|---|
| a number | `ok` |
| "Nil", "-", "NA" in the table, or "The Company has not transferred / acquired any loans during the quarter" | `not_found`, value null, footnote quoting the statement and its page: `Company states nil: "has not acquired any loans ..." (QR p.7).` A stated nil is NOT written as 0, because the rulebook's word for absence is "not found"; the footnote keeps the distinction. |
| the disclosure is simply absent from QR and IP | `not_found`, footnote "No transfer-of-loan-exposures disclosure in the QR notes (pp. x–y) or the IP appendix." |
| AUM equals loan book | `not_found` by rule (SD only), verdict footnote |

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

QR page 7, note 6: "Details of loans transferred / acquired during the quarter ended 30 September 2025 ..."
(₹ in crore):

| Particulars | Transferred | Acquired |
|---|---|---|
| Aggregate amount of loans transferred / acquired | 310.00 | - |
| Weighted average residual maturity (months) | 168 | - |
| Retention of beneficial economic interest | 10% | - |

IP appendix slide 27: "Direct assignment Q2 FY26: ₹312 crore".

1. `sell_down_volume`: reconcile QR 310.00 crore vs IP 312 crore →
   `python3 /workspace/scripts/reconcile_sources.py --request ...` → 0.65% apart → value 310.0, source QR, `ok`,
   footnote shows the IP value.
2. `buy_out_volume`: "-" in the Acquired column → `not_found`, footnote `Company discloses no loans acquired in
   Q2 FY26 ("-" in the Acquired column, QR p.7, note 6).`

## Failure modes

- **Retention share.** The disclosed aggregate is the amount transferred (for example 90% of the pool when 10% is
  retained). Use the disclosed aggregate as printed; do not gross it up.
- **Assigned-book outstanding mistaken for volume**: a number close to `AUM − loan book` is the stock, not the flow.
- **Securitisation that stays on book** inflates SD if included. The note usually says whether the derecognition
  criteria are met; if it does not say, include nothing and footnote the amount as "securitised; derecognition not
  stated".
- **IP quarterly series table** (SD for the last five quarters): take only the requested quarter's column and
  check that it is a quarter, not a trailing-twelve-months figure.
- **Unit**: disclosure notes are frequently in crore even when the main table is in lakhs.
