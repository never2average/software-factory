# What counts as guidance

The keyword tables are in `guidance-topics.json` in this folder (a mirror of
`/workspace/references/guidance-topics.json`, which the scripts read).

## The test

A statement is guidance when **all** hold:

1. Management said it (not an analyst, not the moderator).
2. It is about the future of **this company** (or, on a parent's call, of the subsidiary).
3. It carries a **number** (a level, a range, a count, a date) or a **direction** (up, down, stable).

## Topics

| Topic key | Covers | Typical subtopics |
|---|---|---|
| `aum_growth` | AUM / loan book growth targets | `aum`, `loan_book` |
| `disbursement_growth` | Disbursement growth, run-rates, volumes | |
| `spread_nim` | Spread and NIM bands, yield and cost-of-funds direction, rate pass-through | `spread`, `nim`, `yield`, `cost_of_funds` |
| `credit_cost` | Credit cost, provisioning, PCR targets | `credit_cost`, `pcr` |
| `opex_cost_to_income` | Cost-to-income, opex-to-AUM, operating leverage | `cost_to_income`, `opex_to_aum` |
| `branch_additions` | New branches, locations, states | |
| `borrowing_mix` | Share of banks / NHB / NCD / ECB; assignment and co-lending plans; fixed vs floating | `nhb`, `ncd`, `assignment`, `co_lending` |
| `capital_raise` | Equity or Tier II raise, leverage targets | `equity`, `tier2`, `leverage` |
| `asset_quality` | GNPA/NNPA, Stage 2/3, DPD, collection efficiency outlook | `gnpa`, `nnpa`, `stage2`, `collection_efficiency` |
| `other` | Anything else with a number or direction (ROA/ROE targets, product launches with volumes). `note` must say what | |

## Keep or drop

| Sentence type | Example (synthetic) | Verdict |
|---|---|---|
| Target with a number | "We expect AUM growth of 20% to 22% for the full year." | Keep |
| Band | "Spreads should stay in the 3.2-3.4% band." | Keep |
| Direction only | "We expect asset quality to improve in the second half." | Keep (`direction: up`… see note below) |
| Reiteration | "We maintain our guidance of 25 new branches." | Keep |
| Report on the past | "Disbursements grew 18% YoY in the quarter." | Drop |
| Analyst's premise | "So you are saying NIM will be 4%?" | Drop; keep management's reply if it confirms in its own words |
| Conditional | "If the repo rate is cut, cost of funds should come down by 10 to 15 bps." | Keep, with the condition inside the quote |
| Industry talk | "The sector should grow at 12 to 14%." | Drop (not about the company) |
| Aspiration without horizon | "We aspire to be a ₹ 50,000 crore AUM company." | Keep as `aum_growth`, `horizon` "unspecified", note "aspiration" |

Direction words describe the **number**: "improve" next to asset quality means GNPA going down. The
script's `direction` is taken from the words only; set the row's `direction` by the figure's movement
(GNPA to fall → `down`) and say so in the note when the two differ.

## Comparing with the previous quarter

`guidance_diff.py` compares rows on `(topic, subtopic)`:

| Both quarters carry | Result |
|---|---|
| One figure or range each, same unit, same horizon | numeric: maintained / raised / lowered |
| A range that widened or narrowed | `not_comparable` (`range_widened` / `range_narrowed`): you decide and explain |
| Percent vs bps | put on one scale, then numeric |
| A figure on one side only, or none | `not_comparable` (`qualitative`) |
| Different horizons (FY26 vs FY27) | `not_comparable` (`horizon_differs`) |
| More than one row per key on a side | `not_comparable` (`several_statements`): add subtopics |
| Row now, none before | `new` |
| Row before, none now | `withdrawn` (add the row) |
| Row before was itself `withdrawn` | not a baseline: a statement now is `new` |

## Worked example

Q1 FY26 row: `credit_cost`, "Credit cost should be around 40 basis points." Q2 FY26 row: "Credit cost should be
0.3% for the year." The diff puts both in bps (40 → 30) and reports **lowered**. In the reply: "Credit cost
guidance lowered to 0.3% from about 40 bps (a better outlook)."
