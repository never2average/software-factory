# Dimensions on which HFC metric definitions differ

Use this as a checklist when reading a glossary or footnote. It lists *what varies*, not what any company does.

| Metric | What varies | Rulebook's definition (kpi-spec.md) |
|---|---|---|
| AUM | whether it includes assigned loans, the partner's share of co-lent loans, securitised pools; gross or net of provisions | AUM = on-book + off-book loans |
| Loan book | gross vs net of ECL; includes or excludes inter-corporate deposits and investments | taken from the balance sheet |
| Yield | on average loans vs average AUM vs interest-earning assets; interest income only vs including fees and assignment income; portfolio vs incremental; daily vs quarterly averages; annualised or not | yield = effective interest rate on loans |
| Cost of funds | on average borrowings vs average interest-bearing liabilities; includes processing/other finance charges or not; portfolio vs incremental | average cost of borrowing |
| Spread | yield minus cost of funds; on book vs on AUM; sometimes "incremental spread" | yield, cost of funds, spread, NIM extracted as presented |
| NIM | NII ÷ average loans, ÷ average AUM, or ÷ average total assets; with or without assignment/fee income; annualised | derived from net interest income |
| Cost-to-income | denominator NII, or NII + other income, or total net income; opex with or without depreciation, ESOP cost, one-offs | operating expenses ÷ NII × 100 |
| ROA | on average total assets, on average AUM, on closing AUM; annualised from the quarter or trailing | quarterly PAT × 4 ÷ AUM × 100 |
| ROE | on average vs closing net worth; with or without revaluation reserves | quarterly PAT × 4 ÷ net worth × 100 |
| GNPA % | on loan book (on-book) vs on AUM; Stage 3 under Ind AS vs NPA under the regulator's norms | GNPA = gross stage 3 / gross NPA |
| PCR | Stage 3 provisions ÷ gross Stage 3; with or without technical write-offs | Stage-3 PCR |

## Phrases that signal a definition

`is defined as`, `computed as`, `calculated as`, `represents`, `=`, `on average`, `annualised`, `on a daily
average basis`, `includes`, `excludes`, `net of`, `gross of`, `on AUM`, `on on-book loans`, `incremental`.

## Worked example

Footnote under slide 20's table: "³ NIM computed on average total assets; Q2 FY26 annualised." Record:
NIM, verbatim footnote, slide 20, dimension: denominator = average total assets (rulebook derives NIM from
NII; hfc-kpi-extraction decides how to compare), annualised = yes.

If a regulator or accounting standard changes what a term must mean, trust the definition printed in the
deck in front of you and report the change.
