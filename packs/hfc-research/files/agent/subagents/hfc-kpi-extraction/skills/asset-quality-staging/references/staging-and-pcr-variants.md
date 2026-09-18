# Asset quality: label and definition variants

## Label → KPI (regexes from `/workspace/scripts/kpi_catalog.py`)

| KPI | Regex | Example labels |
|---|---|---|
| `gnpa_pct` | `\bGNPA\b`, `\bgross\s+NPAs?\b`, `\bgross\s+non[- ]performing\s+assets?\b`, `\bgross\s+stage[- ]?(3\|III)\b`, `\bGS\s?3\b`, `\bstage[- ]?(3\|III)\s+(assets\|loans)\s*(\(%\)\|%\|ratio)`, `\bgross\s+credit[- ]impaired\b` | GNPA, Gross NPA ratio, Gross Stage 3 (%), GS3, Stage 3 assets % |
| `nnpa_pct` | `\bNNPA\b`, `\bnet\s+NPAs?\b`, `\bnet\s+non[- ]performing\s+assets?\b`, `\bnet\s+stage[- ]?(3\|III)\b`, `\bNS\s?3\b`, `\bnet\s+credit[- ]impaired\b` | NNPA %, Net NPA, Net Stage 3 (%) |
| `pcr_stage3_pct` | `\bPCR\b`, `\bprovision(ing)?\s+coverage\b`, `\bcoverage\s+ratio\b`, `\bstage[- ]?(3\|III)\s+(provision\s+)?coverage\b`, `\bNPA\s+coverage\b` | PCR, Provision coverage ratio (Stage 3), Stage 3 coverage |

Vetoes: a label with "net" never matches GNPA; "gross" never matches NNPA; "Stage 1" / "Stage 2", "total ECL",
"total provisions", "interest service coverage", "debt service coverage", "liquidity coverage / LCR" never match PCR;
anything with "restructur", "OTR", "resolution framework" is `excluded_restructured`.

A label naming two metrics ("GNPA / NNPA") is `ambiguous`: the row has two numbers; read each separately.

## The ratios, as companies define them

| Name on the page | Numerator | Denominator | Is it the KPI? |
|---|---|---|---|
| GNPA % / Gross Stage 3 % | Gross Stage 3 loans | gross loans (on-book) | yes (`gnpa_pct`), base "loan book" |
| GNPA % on AUM | Gross Stage 3 loans | AUM | yes if it is the only one; base "AUM" in `definition` |
| NNPA % / Net Stage 3 % | Gross Stage 3 − Stage 3 ECL | gross loans − Stage 3 ECL (some: net loans after all ECL) | yes (`nnpa_pct`); use the printed % |
| Stage-3 PCR | Stage 3 ECL | Gross Stage 3 | yes (`pcr_stage3_pct`) |
| Total PCR / "coverage on Stage 3 incl. Stage 1 & 2 provisions" | total ECL | Gross Stage 3 | no; often > 60%, can exceed 100% |
| ECL / gross loans, "provisions to loans" | total ECL | gross loans | no; around 1% |
| PCR including technical write-offs | Stage 3 ECL + write-offs | Gross Stage 3 + write-offs | no; footnote only |
| Stage 2 %, 30+ DPD, 1+ DPD, collection efficiency | | | no |

Identity to check a printed set: `NNPA% ≈ GNPA% × (1 − PCR) ÷ (1 − GNPA% × PCR)` (in fractions). With GNPA 1.82%,
PCR 33.90%: 0.0182 × 0.661 ÷ (1 − 0.0182 × 0.339) = 1.21%. If the printed three do not satisfy this within 0.05
percentage points, the PCR printed is probably not the Stage-3 PCR: say so in the footnote and mark PCR
`needs_review`.

## Base: loan book or AUM

| Clue | Base |
|---|---|
| figures come from the ECL / staging note of the QR | on-book gross loans |
| slide footnote "on AUM", "as % of AUM", "on total AUM basis" | AUM |
| slide footnote "on loan book", "on-book", "as % of loan assets" | loan book |
| nothing stated; GS3 amount ÷ gross loans reproduces the % | loan book |
| nothing stated; GS3 amount ÷ AUM reproduces the % | AUM |
| nothing stated and no amounts | write "base not stated" |

Always write the base in `definition`, for example `"Gross Stage 3 / gross loans (on-book), QR ratios note"`. When a
company with a large off-book share switches base between quarters, the series breaks: compare with last quarter's
`definition` in `kpis.jsonl` and raise it in the summary.

## Bounds applied by validate_kpis.py

| KPI | Rejected outside | Flagged outside |
|---|---|---|
| `gnpa_pct` | 0–100 | 0–25; below 0.05 looks like a fraction |
| `nnpa_pct` | 0–100, and must be ≤ GNPA | 0–15 |
| `pcr_stage3_pct` | 0–100 | 5–90; below 1 looks like a fraction |
