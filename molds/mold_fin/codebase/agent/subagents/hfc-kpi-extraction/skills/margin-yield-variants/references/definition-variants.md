# Yield, cost of funds, spread, NIM: definition variants and the wording that signals them

Write the company's own wording into the row's `definition`. The catalogue below helps you recognise which variant
it is; it is not a licence to convert one into another.

## Yield (`yield_pct`)

| Signal wording | Variant | Typical level vs others |
|---|---|---|
| "yield on average loans", "yield on advances", "interest income / average loan book" | earned yield on the on-book loans, annualised | baseline |
| "yield on AUM", "on average AUM" | earned yield with assigned loans in the base (and sometimes assignment income in the numerator) | slightly different from on-book |
| "portfolio yield", "book yield", "weighted average yield" as at the quarter end | contracted rate on the outstanding book, point in time | usually a little above earned yield |
| "effective interest rate (EIR)" | Ind AS effective rate including amortised fees | slightly above contracted |
| "yield on disbursements", "incremental yield", "origination yield" | new business only | **not the KPI** |
| "yield on investments", "treasury yield" | not loans | **not the KPI** |

Regex: `\byield\b`, `\bportfolio\s+yield\b`, `\byield\s+on\s+(loans?\|advances\|AUM\|loan\s+book\|portfolio\|average\s+\w+)\b`,
`\baverage\s+(lending\|loan)\s+(rate\|yield)\b`, `\beffective\s+interest\s+rate\b`, `\bweighted\s+average\s+yield\b`;
veto `incremental\|origination\|on\s+disbursements?\|spread\|investments?\|dividend`.

## Cost of funds (`cost_of_funds_pct`)

| Signal wording | Variant |
|---|---|
| "cost of funds", "cost of borrowings", "average cost of borrowings" for the quarter | finance cost ÷ average borrowings, annualised |
| "weighted average cost of borrowings as at ..." | point in time, on outstanding borrowings |
| "cost of funds (incl. assignment)" | assigned pools treated as funding at the pass-through rate |
| "incremental / marginal cost of funds" | new borrowings only: **not the KPI** |

Regex: `\bcost\s+of\s+funds?\b`, `\bcost\s+of\s+borrowings?\b`, `\bCoF\b`, `\bCoB\b`,
`\bweighted\s+average\s+cost\s+of\s+(funds\|borrowings?)\b`; veto `incremental\|marginal\|spread`.

## Spread (`spread_pct`)

| Situation | Row |
|---|---|
| printed ("Spread", "Interest spread", "Spread on loans") | as disclosed, `source` IP / QR |
| not printed, yield and cost of funds both present | `compute_kpis.py`: yield − cost of funds, `source "computed"`, footnote says so |
| not printed and one of the two missing | `not_found`, reason names the missing input |
| printed in basis points | divide by 100; say so in the footnote |
| "incremental spread" only | `not_found` |

`validate_kpis.py` checks a computed spread against the yield and cost-of-funds rows of the same quarter
(`E-ARITH` when it is off by more than 0.01).

## NIM (`nim_pct`)

| Denominator wording | Variant |
|---|---|
| "average total assets", "average assets" | NIM on assets |
| "average AUM", "AAUM" | NIM on AUM (lower denominator effect when off-book is large) |
| "average loan book", "average on-book loans", "average interest-earning assets" | NIM on loans |
| not stated | write "denominator not stated" |

| Numerator wording | Variant |
|---|---|
| "net interest income" = interest income − finance cost | plain |
| "NII including assignment income / upfront income / EIS" | includes gain on derecognition |
| "net total income", "net revenue", "NII + fee and other income" | broader than NII: say so; it is what the company calls NIM |

Annualisation wording: "annualised", "(annualized)", "*annualised for the quarter", "not annualised". When the slide
says nothing and the level is around a quarter of the company's usual annual NIM, it is un-annualised: report as
printed, `needs_review`.

Regex: `\bNIM\b`, `\bnet\s+interest\s+margin\b`, `\bNII\s*/\s*(average\s+)?(AUM\|assets\|loans?)\b`. "Net interest
income" on its own is an amount (the `nii` input of `compute_kpis.py`), not NIM.

## Usual ranges (flags, not rejections) in validate_kpis.py

| KPI | Flagged outside |
|---|---|
| `yield_pct` | 6–30 |
| `cost_of_funds_pct` | 4–16 |
| `spread_pct` | 0–15 |
| `nim_pct` | 1–20 |

A flag means "confirm against the filing", nothing more. Report flags in the summary.

## What to remember per company (via `remember`)

`<customer_id>: yield = <definition>; CoF = <definition>; spread = disclosed|computed; NIM = <numerator>/<denominator>, <annualisation>; source slide title "<title>"`
