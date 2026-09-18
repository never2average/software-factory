# Unit spellings seen in decks

| Unit | Spellings the scripts recognise |
|---|---|
| crore | crore, crores, Cr, Cr., Crs, "₹ Cr", "Rs. in Crore", "INR Cr" |
| lakh | lakh, lakhs, lac, lacs |
| million | million, millions, mn, Mn., mio |
| billion | billion, billions, bn, Bn. |
| thousand | thousand, thousands, '000 |
| percent | %, "per cent" |
| basis points | bps, bp, "basis points" |
| multiple | x (as in 3.2x) |
| US dollar (ignored) | US$, USD, $ before the number, "dollars" |

Not recognised on purpose (reported, never converted): "lakh crore", "trillion", "k/K" as a magnitude, "MM".

## Conversions (the analysts' table)

| From | To ₹ crore | Example |
|---|---|---|
| ₹ lakh | ÷ 100 | 12,345 lakh → 123.45 |
| ₹ million | ÷ 10 | 10,500 mn → 1,050 |
| ₹ billion | × 100 | 98.5 bn → 9,850 |
| ₹ crore | as is | 1,050 → 1,050 |
| bps → percent | ÷ 100 | 310 bps → 3.10% |

## Where decks put the unit

1. In the slide title: "AUM (₹ crore)".
2. In a corner box: "₹ in Cr" / "All figures in INR mn".
3. In a table's header row or first column header.
4. On each number: "₹ 1,050 Cr".
5. Once, on the disclaimer or the first financial slide: "All figures in ₹ crore unless otherwise stated".
6. On a chart's axis title.

If a regulation or a company changes how units are presented, trust the slide in front of you and mention the change.

## Worked example

`python3 /workspace/scripts/extract_labelled_numbers.py --text-file s.txt` on
"Average ticket size ₹ 15 lakh | AUM ₹ 12,345 Cr" gives ticket size `value 0.15, unit crore, source_value 15,
source_unit lakh, unit_source number_suffix` and AUM `12345.0`.
