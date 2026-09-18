---
description: Use when reading any amount from a filing (lakhs, millions, billions or crore), when the quarterly results and the investor presentation use different units, when a number is printed with Indian digit grouping, brackets, a dash, NA or a blank, or when a table has no unit in its header.
---

# Units and number formats

Rulebook: every amount is reported in **₹ crore**. Lakhs ÷ 100. Millions ÷ 10. Billions × 100. Crores as-is.

You never convert in your head and you never retype a number "cleaned up". Copy the cell exactly as printed and let
the script parse and convert it.

## Recognise the variation

- The unit lives in the header of EACH table or slide: "(₹ in Lakhs)", "Rs. in Crore", "INR mn", "₹ bn",
  "(All amounts in ₹ millions unless otherwise stated)". It often differs between the QR (lakhs or crore) and the IP
  (crore, millions or billions), and sometimes between two tables of the same document (the results table in lakhs,
  a disclosure note in crore).
- Indian digit grouping: `1,23,456.78` is one lakh twenty-three thousand. Western grouping `123,456.78` also appears,
  mostly in presentations in millions.
- Negatives are in brackets: `(1,234.5)`. A leading minus or a Unicode minus also occurs.
- Blanks: `-`, `–`, `—`, `NA`, `N.A.`, `Nil`, `NM`, empty cell. A blank is NOT zero. `0` and `0.00` are zero.
- Per-share data, percentages, ratios and counts sit in the same table as amounts and are not in the table's unit
  ("₹ in lakhs except per share data").

Header and number patterns are tabulated in `references/unit-headers-and-number-patterns.md`.

## Procedure

1. Find the unit for THIS table: the header line above the column headings, the slide's corner note, or the
   document's notes ("all amounts in ₹ crore unless otherwise stated"). Record it with the value.
2. Convert:

   ```
   python3 /workspace/scripts/convert_units.py --value "1,82,45,630" --header "(₹ in Lakhs)"
   python3 /workspace/scripts/convert_units.py --value "182.4" --unit billion
   ```

   For many values at once:

   ```
   echo '[{"id":"loan_book","value":"8,20,000","header":"(Rs. in Lakhs)"},
          {"id":"aum","value":"100.0","header":"INR bn"}]' | python3 /workspace/scripts/convert_units.py --stdin
   ```

3. Use `crore_rounded` (2 decimals) as the row's `value`, unit `₹ crore`.
4. Percentages are written as percent (`1.82`, never `0.0182`), Debt/Equity as a multiple with unit `x` (`3.2`),
   branches and employees as whole numbers with unit `count`. None of these go through the converter.
5. Productivity KPIs (disbursement per branch, expense per employee ...) are ₹ crore per branch / per employee with
   4 decimals; `compute_kpis.py` produces them. Do not rescale them to lakhs.

`reconcile_sources.py`, `derive_quarter.py` and `compute_kpis.py` all accept the printed value with its unit and
convert with the same code, so mixed units between the QR and the IP are handled there too.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

| Where | Printed | Header | Command result |
|---|---|---|---|
| QR balance sheet, Loans | `8,20,000.00` | (₹ in Lakhs) | 8200.0 |
| IP slide 5, AUM | `100.0` | INR bn | 10000.0 |
| IP slide 9, Disbursements | `19,000` | ₹ mn | 1900.0 |
| QR results, PAT | `7,500` | (₹ in Lakhs) | 75.0 |
| QR results, exceptional item | `(120.50)` | (₹ in Lakhs) | -1.21 (rounded from -1.205) |
| QR note, loans acquired | `-` | (₹ in Crore) | refused: "blank in the filing ... do not read it as zero" |

```
python3 /workspace/scripts/convert_units.py --value "19,000" --header "₹ mn"
```

→ `{"unit": "million", "factor_to_crore": 0.1, "crore_rounded": 1900.0, "rule": "millions: divide by 10", "ok": true}`

## What the script refuses (and why you must not work around it)

| Input | Message | What to do |
|---|---|---|
| header "Rs in lakhs unless otherwise stated in crore" | names no single unit | read the specific table; pass `--unit` only when the table itself says it |
| header "Particulars" / no header | no unit | find the unit elsewhere in the document; if it is nowhere, the value is `not_found` with that reason |
| `--unit crore` with header "(Rs. in Lakhs)" | unit and header disagree | one of them is wrong: re-read the page |
| `12,5` or `1 234,56` | grouping is neither Indian nor Western | probably two cells merged by the PDF extractor, or a decimal comma: re-extract the table cell by cell |
| `4,500 cr`, `~9,000`, `9,000+`, `1,234 *` | cannot parse | strip nothing yourself: pass the bare number and put the unit in `--unit`; "~" and "+" mean the figure is approximate → `needs_review` |
| `12.5%`, `3.2x` | not an amount | it is a ratio: no conversion |
| header with `USD`, `$`, `€` | foreign currency | not covered by the rulebook: report it |

## Failure modes

- **Magnitude sanity.** After converting, compare with last quarter's value (from `kpis.jsonl`). A loan book that
  moved by ×100 or ÷10 between quarters is a unit mistake, not growth. `validate_kpis.py` also rejects loan book >
  AUM, which catches most lakhs/crore mix-ups.
- **"Lakh crore"** appears on market-size slides (₹ 1.5 lakh crore = ₹ 1,50,000 crore). The converter reads it, but
  such slides are about the industry, not the company.
- **Thousands and rupees** are not in the rulebook. The converter handles them as arithmetic identities and says so
  in `rule`; mention it in the footnote.
- **Scanned pages**: run `python3 /workspace/scripts/detect_content_type.py <file>` first. Numbers cannot be read
  from image pages, and there is no OCR in the sandbox.
