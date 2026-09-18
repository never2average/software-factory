---
description: Use when extracting the Ind AS 109 credit-risk notes - Stage 1, 2 and 3 gross carrying amount and ECL allowance, the ECL or gross-carrying-amount movement reconciliation, write-offs, significant-increase-in-credit-risk criteria, collateral and loan-to-value disclosures - or when Stage 3 / provision coverage figures are needed from an annual report.
---

# Ind AS 109: staging and expected credit loss

Where the staging information sits differs by report. There are usually three places, and the map's
`ind_as_109_notes` entry lists `candidates` for them:

1. **Inside the Loans note**: a stage-wise table of gross carrying amount and impairment allowance, and the two
   reconciliations (movement in gross carrying amount, movement in ECL allowance).
2. **In the financial risk management note, under "Credit risk"**: staging criteria, SICR definition, default
   definition, ECL methodology (PD, LGD, EAD), management overlay, collateral, LTV bands, concentration.
3. **In the RBI disclosures**: a table comparing Ind AS 109 provisions with the prudential (IRACP) norms, by asset
   classification. It repeats stage-wise gross, ECL and net. Use it as a cross-check, not as the primary source.

## The analysts' rule on restructured loans

**Exclude restructured-book details.** Staging tables sometimes carry "of which restructured" rows, and credit-risk
notes often carry resolution-framework tables. Do not extract them. Say in the reply that the report contains them,
with the page. `staging_table.py` drops such rows and lists them; `validate_ar_data.py` rejects such rows.

## Staging table shapes

| Shape | Looks like | Input to the script |
|---|---|---|
| Rows are stages | Rows "Stage 1 / Stage 2 / Stage 3 / Total"; columns "Gross carrying amount", "Impairment loss allowance" (and often "Net") | `"rows": [{"label", "gross", "ecl"}]` |
| Columns are stages | Rows "Gross carrying amount", "Less: impairment loss allowance"; columns "Stage 1, Stage 2, Stage 3, Total" | `"gross": {...}, "ecl": {...}` |
| Product by stage | Rows "Housing loans - Stage 1", "Non-housing loans - Stage 1", ... | rows shape: several rows per stage are summed and listed |
| DPD buckets | Rows "0 DPD", "1-30", "31-60", "61-90", "90+" with a stage column | Only when the table itself names the stage for each bucket. Put the stage in the label ("Stage 1 - 0 DPD"). Never assign a bucket to a stage yourself. |
| Ind AS wording | "12-month ECL", "Lifetime ECL - not credit impaired", "Lifetime ECL - credit impaired" | recognised as Stage 1, 2, 3 |
| With POCI | a "Purchased or originated credit impaired" row or column | kept as its own line |

Gross carrying amount versus ECL allowance: gross is before the allowance; the balance sheet's Loans line is after
it. Allowances are often printed in brackets: the script takes their absolute value. Some tables include loan
commitments and undrawn amounts (exposure at default rather than carrying amount): use the table headed gross
carrying amount of loans, and say which table you used.

## Procedure

1. Open the candidates from the map; pick the stage-wise table for **loans**, current year, standalone. Note the
   unit line, the page, and whether a total row is printed.
2. Compute and foot:

   ```
   python3 /workspace/scripts/staging_table.py /workspace/out/staging-fy26.rows.json
   ```

   - `status: ok`: use the output.
   - `does_not_foot` (exit 1): re-read the page. Usual causes: a transposed digit, a missed row, a total that
     includes POCI or restructured rows. Do not use the figures until the cause is known; if the printed table
     itself does not add up, report it as printed and say so.
   - `incomplete`: a stage was not recognised (`unrecognised_rows`), or a value could not be parsed.
3. Repeat for the comparative year (its own input, `"fy": "FY25"`).
4. **Movement reconciliation.** Extract as a table, stage columns preserved: opening balance; new assets originated
   or purchased; assets derecognised or repaid; transfers to Stage 1 / 2 / 3; changes in ECL due to remeasurement,
   model or assumption changes; amounts written off; closing balance. The closing balance must equal the staging
   table: check it. Stitch if it spans pages:

   ```
   python3 /workspace/scripts/stitch_tables.py /workspace/out/ecl-movement.pages.json
   ```

5. **Write-offs.** The amount written off in the year (from the reconciliation or the impairment note to the P&L),
   recoveries from written-off accounts if stated, and the write-off policy sentence, quoted.
6. **SICR and default criteria.** Quote them. Typical: a rebuttable presumption of significant increase in credit
   risk at more than 30 days past due; default at 90 days past due; qualitative triggers; the cure or upgrade
   criteria. Reports differ, and regulatory guidance on upgrades has changed over time: quote the report, do not
   paraphrase from memory.
7. **Collateral and LTV.** The LTV-band table (gross carrying amount by LTV band, sometimes by stage), the statement
   of collateral held, repossessed assets. Extract tables as tables.
8. **Management overlay.** Amount and the reason stated, quoted.
9. Rows for `annual-report-data.jsonl` use `section: "ind_as_109_notes"`, `statement: "staging"` or `"ecl_movement"`,
   and `dimension` = `stage_1` / `stage_2` / `stage_3` / `total` (plus the row name for movements). Validate before
   appending:

   ```
   python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
   ```

## What to write

`.../{fy}_annual-report/ind-as-109-notes.md`: staging table (both years) with coverage %, the reconciliations,
write-offs, quoted SICR / default / write-off policies, collateral and LTV tables, overlay; a line "Restructured-book
disclosures are present on printed p. X and were left out per the analysts' rule" when applicable.

## Worked example

Example Housing Finance Ltd, Note 7.3, printed page 196 (PDF 204), "(Rs. in lakh)":

| | Gross carrying amount | Impairment loss allowance |
|---|---|---|
| Stage 1 | 11,80,000.00 | 3,540.00 |
| Stage 2 | 42,000.00 | 2,940.00 |
| Stage 3 | 18,000.00 | 7,200.00 |
| Total | 12,40,000.00 | 13,680.00 |

`staging_table.py` output (crore): Stage 1 gross 11,800.00, ECL 35.40, coverage 0.30%; Stage 2 gross 420.00, ECL
29.40, coverage 7.00%; Stage 3 gross 180.00, ECL 72.00, coverage 40.00%, share of gross 1.4516%; total gross
12,400.00, ECL 136.80, coverage 1.1032%; both totals foot. Stage 3 share of gross is the gross Stage 3 (GNPA) ratio
on the Ind AS basis, and Stage 3 coverage is the provision coverage ratio: label them as computed from this table,
because the company's own stated ratios (often on AUM, or including off-book loans) can differ.

If Stage 2 had been typed as 24,000.00, the script would report `does_not_foot`, difference -180.00 crore, and exit 1.

More shapes and a movement table are in [references/table-shapes.md](references/table-shapes.md).

## Failure modes and what to report

| Situation | Report |
|---|---|
| Only a combined "Stage 1 and Stage 2" figure is given | Report it as printed; the script leaves such a row unrecognised. Do not split it. |
| Staging given only as percentages | Extract the percentages (`unit: "percent"`); do not back-compute amounts. |
| Staging given for total exposure including commitments, not for loans | Use it, and say the base is exposure, not loans. |
| No stage-wise table anywhere in the annual report | Say so; give the impairment allowance total from the Loans note and the asset-classification table from the RBI disclosures if present. |
| Closing balance of the reconciliation differs from the staging table | Report both with pages. Do not reconcile them yourself. |
