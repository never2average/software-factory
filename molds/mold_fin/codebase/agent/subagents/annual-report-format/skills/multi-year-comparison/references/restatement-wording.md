# Restatement, regrouping, policy change: wording to look for

| Kind | Wording | What to do |
|---|---|---|
| Regrouping | "Previous year's figures have been regrouped / rearranged / reclassified wherever necessary to conform to the current year's presentation." | Quote. Compare line by line with last year's report to find what moved: `compare_years.py` shows the lines whose comparative differs from first reported. Totals normally do not change. |
| Restatement for error | "prior period error", "restated in accordance with Ind AS 8", a table of line items "as previously reported / adjustment / as restated" | Extract that table in full. Mark the comparatives `restated: true`. |
| Change in accounting policy | "During the year the Company has changed its accounting policy for ...", "with retrospective effect" | Quote the policy before and after, and the amounts. |
| Change in estimate | "revised its estimate of ...", "refined the ECL model", "change in PD / LGD", "management overlay released" | Not a restatement. Quote, with the impact stated. It affects comparability of provisions and coverage. |
| New requirement adopted | "amendments ... effective from April 1, 20XX", "pursuant to the RBI circular dated ...", "disclosure added as required by ..." | Quote. New tables have no comparative, or a comparative prepared for the first time. |
| Scheme of arrangement | "pursuant to the scheme of amalgamation ... appointed date ...", "figures are not comparable" | Quote. Put at the top of the comparison. |

## Same basis, same section: checklist

- Standalone with standalone. Consolidated with consolidated. Never crossed.
- Balance-sheet dates a full year apart; P&L periods both twelve months.
- Same table: Ind AS staging with Ind AS staging; regulatory NPA movement with regulatory NPA movement.
- Same base for ratios: a Stage 3 ratio on loans is not a GNPA ratio on AUM.
- Buckets and bands unchanged (ALM buckets, LTV bands, rate bands). If they changed, present both as printed and do
  not re-bucket.
- Restructured-book lines stay out of both years.
