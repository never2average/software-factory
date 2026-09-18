# Unit headers and number patterns

## Unit wording → unit (what `finlib.units.detect_unit` and `convert_units.py` recognise)

| Unit | Regex (case-insensitive) | Seen as |
|---|---|---|
| crore | `\bcrores?\b`, `\bcr\.?\b`, `\bcrs\.?\b` | "₹ in Crore", "Rs. Cr", "INR Crs", "(₹ Cr.)" |
| lakh | `\blakhs?\b`, `\blacs?\b` | "(₹ in Lakhs)", "Rs. in Lacs" |
| million | `\bmillions?\b`, `\bmn\.?\b`, `\bmio\b` | "INR mn", "₹ Million", "Rs. in millions" |
| billion | `\bbillions?\b`, `\bbn\.?\b` | "₹ bn", "INR Billion" |
| thousand | `\bthousands?\b`, `\b000s\b`, `'000` | "₹ '000" (rare; not in the rulebook) |
| lakh crore | `\blakh\s+(crores?\|cr\.?)\b` | "₹ lakh crore" (industry size slides only) |

Conversion to ₹ crore:

| From | Operation | Factor | Example |
|---|---|---|---|
| crore | as-is | 1 | 7,015.2 → 7015.20 |
| lakh | ÷ 100 | 0.01 | 8,20,000 → 8200.00 |
| million | ÷ 10 | 0.1 | 19,000 → 1900.00 |
| billion | × 100 | 100 | 100.0 → 10000.00 |
| thousand | ÷ 10,000 | 0.0001 | 4,50,000 → 45.00 |
| rupee | ÷ 1,00,00,000 | 0.0000001 | 98,76,54,321 → 98.77 |

A header that matches two units, or none, is ambiguous and is reported, never resolved.

## Where the unit is printed

| Document | Usual place | Trap |
|---|---|---|
| QR results table | top right above the table: "(₹ in Lakhs)" or "(₹ in Crore)" | EPS rows are in rupees; ratio rows are % or times |
| QR statement of assets and liabilities | same style of header, on its own page | may be on a different page from the results table but the same unit; check anyway |
| QR notes and disclosure tables | inside the note: "(₹ in crore)" | notes are sometimes in crore while the main table is in lakhs |
| IP slides | corner note "₹ Cr", axis title, or the first slide's "All figures in ₹ crore unless stated" | bar-chart data labels inherit the slide's unit; a chart with no data labels cannot be read exactly |
| XLSX data book | a header cell or the sheet title | units vary sheet by sheet |

## Number patterns

| Printed | Meaning | Parsed |
|---|---|---|
| `1,23,456.78` | Indian grouping | 123456.78 |
| `123,456.78` | Western grouping | 123456.78 |
| `(1,234.5)` | negative | -1234.5 |
| `-12`, `−12` | negative | -12.0 |
| `12.5%` | percent | 12.5 |
| `3.2x` | multiple | 3.2 |
| `₹ 4,500` | currency sign is dropped | 4500.0 |
| `0`, `0.00` | zero | 0.0 |
| `-`, `–`, `—`, `NA`, `N.A.`, `N/A`, `Nil`, `NM`, `*`, empty | blank: no number | none |
| `12,5`, `1,2345`, `1 234,56` | broken grouping | refused |
| `1.2.3`, `abc`, `4,500 cr`, `~9,000` | not a bare number | refused |

Valid grouping, as the converter checks it: `^\d{1,3}(,\d{3})+$` (Western) or `^\d{1,2}(,\d{2})*,\d{3}$` (Indian).

## Nil versus blank

"Nil" in a disclosure table (for example "loans acquired: Nil") is the company stating that there was none. The
converter still returns no number for it. How to record that is decided per KPI: for sell down and buy out see the
`sell-down-and-buy-out` skill (status `not_found` with a footnote quoting "Nil").
