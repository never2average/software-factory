# Profit-and-loss lines behind the computed ratios

How the standalone results table of an NBFC / HFC under Ind AS is generally laid out, and which lines feed which
input. Formats evolve: if the table in front of you differs, follow it and report the difference.

## Typical line order and use

| Line (typical wording) | Regex | Feeds |
|---|---|---|
| Interest income | `^\s*(\(?[a-z]\)?\s*)?interest\s+income` | NII (+) |
| Fees and commission income | `fees?\s+and\s+commission\s+income` | not NII |
| Net gain on derecognition of financial instruments under amortised cost category | `net\s+gain\s+on\s+derecognition` | not NII (assignment income). If the company's NII includes it, that is the company's NIM definition, not this input |
| Net gain on fair value changes | `net\s+gain\s+on\s+fair\s+value` | not NII |
| Other operating income / Total revenue from operations / Other income / Total income | | not used |
| Finance costs | `finance\s+costs?` | NII (−) |
| Fees and commission expense | `fees?\s+and\s+commission\s+expense` | not opex (option A) |
| Impairment on financial instruments | `impairment\s+on\s+financial\s+instruments` | never opex (credit cost) |
| Employee benefits expense | `employee\s+benefits?\s+expenses?` | `employee_cost`; opex option A |
| Depreciation, amortisation and impairment | `depreciation` | opex option A |
| Other expenses | `^\s*(\(?[a-z]\)?\s*)?other\s+expenses` | opex options A and C |
| Total expenses | | not used |
| Profit before tax; Tax expense | | not used |
| Profit for the period / Profit after tax | `profit\s*(/\s*\(loss\))?\s+(for\s+the\s+(period\|quarter\|year)\|after\s+tax)` | `pat_quarter` |
| Other comprehensive income; Total comprehensive income | | never PAT |
| Earnings per share | | not used (in rupees, not in the table's unit) |

**NII input** = Interest income − Finance costs, both from the same quarter column, computed in the sandbox:

```
python3 -c "print(round(34210.55 - 19210.55, 2))"     # lakhs; then convert_units.py --unit lakh
```

or pass both through `python3 /workspace/scripts/convert_units.py --stdin` first and subtract the `crore` values.
If the IP prints "NII" and it differs from this by more than 5%, the company's NII includes other items
(assignment income, fees): use the QR-derived NII for the formula and footnote the company's figure.

## Operating-expense options (pick one per company and keep it)

| Option | `opex_definition` text | `opex_includes_employee_cost` | Effect on Expense per Employee |
|---|---|---|---|
| A | "employee benefits expense + depreciation + other expenses" | true | employee cost counted twice (footnoted; open point) |
| B | "company's operating expenses as per IP slide n (= <QR lines>)" | usually true | as A |
| C | "other expenses only" | false | no double count |

## Worked example (synthetic, ₹ in lakhs, quarter ended 30.09.2025, standalone)

| Line | Quarter |
|---|---|
| Interest income | 34,210.55 |
| Net gain on derecognition | 1,150.00 |
| Finance costs | 19,210.55 |
| Impairment on financial instruments | 640.00 |
| Employee benefits expense | 3,600.00 |
| Depreciation and amortisation | 400.00 |
| Other expenses | 2,000.00 |
| Profit for the period | 7,500.00 |

→ `nii` = 34,210.55 − 19,210.55 = 15,000.00 lakh = ₹150.00 crore; `opex` (A) = 3,600 + 400 + 2,000 = 6,000.00 lakh =
₹60.00 crore; `employee_cost` = ₹36.00 crore; `pat_quarter` = ₹75.00 crore.

## Headcount and branch inputs

Employees and branches are closing counts from the IP. If the IP gives "employees (on-roll)" and "off-roll"
separately, use on-roll and say so in `definition`; keep the same choice every quarter.
