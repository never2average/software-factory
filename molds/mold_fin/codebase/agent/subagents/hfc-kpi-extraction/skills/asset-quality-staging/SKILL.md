---
description: Use when extracting GNPA %, NNPA % or the Stage-3 provision coverage ratio, when a filing reports Gross Stage 3 / Net Stage 3 instead of GNPA / NNPA, gives amounts but no percentages, reports more than one coverage ratio, or states asset quality on AUM in one document and on the loan book in another.
---

# Asset quality: GNPA, NNPA, Stage-3 PCR

Rulebook: **GNPA** = Gross Stage 3 (GS3) / Gross NPA. **NNPA** = Net Stage 3 / Net NPA. Asset quality is
"percentages sourced from Gross/Net NPA and Stage-3 Provision Coverage Ratio (PCR)". Source for a listed company:
the QR. All three are percentages (write `1.82`, not `0.0182`).

The restructured book is excluded from the report: never create a row for restructured loans, and keep
restructuring amounts out of footnotes.

## Recognise the variation

| Variation | What you see | What to do |
|---|---|---|
| Ind AS vocabulary | "Gross Stage 3", "Stage 3 assets (%)", "GS3", "credit-impaired" | it IS the GNPA row (rulebook definition). Put the printed label in `definition`. |
| Regulatory vocabulary | "Gross NPA", "GNPA", "Net NPA", "NNPA" (in the ratios note of the QR) | use directly |
| Both printed and different | Stage 3 % and GNPA % differ slightly (regulatory NPA classification can differ from Ind AS staging) | prefer the figure in the QR's ratios note labelled GNPA / NNPA; give the Stage 3 figure in the footnote; `remember` the choice |
| Amounts only | Gross Stage 3 ₹ and gross loans ₹, no % | compute in the sandbox (see procedure), `definition` says "computed from amounts", status `ok` when both amounts are from the same table |
| Base differs | "GNPA (% of AUM)" in the IP vs "% of loan book / gross loans" in the QR | record the base in `definition`. QR wins within 5%; beyond 5% `needs_review` (`source-precedence-and-conflicts`). |
| Several coverage ratios | "PCR (Stage 3)", "Total ECL / Stage 3" (can exceed 100%), "Total provisions / gross loans" (a small number like 0.9%) | only the Stage-3 PCR is the KPI: Stage-3 ECL ÷ Gross Stage 3. See `references/staging-and-pcr-variants.md`. |
| Including / excluding write-offs, or technical write-offs in PCR | footnote on the slide | use the plain Stage-3 PCR; mention the other in the footnote |

Check a label:

```
python3 /workspace/scripts/kpi_catalog.py --match "Provision coverage ratio (Stage 3)"
python3 /workspace/scripts/kpi_catalog.py --match "Stage 2 provision coverage"      # -> no_match, on purpose
python3 /workspace/scripts/kpi_catalog.py --match "Restructured loans (OTR 2.0)"     # -> excluded_restructured
```

## Procedure

1. Locate: `python3 /workspace/scripts/detect_content_type.py <qr.pdf> --find "gross\s+(NPA|stage\s*-?\s*3)" "net\s+(NPA|stage\s*-?\s*3)" "provision\s+coverage" "stage\s*-?\s*3"`.
   In the QR the ratios note (the list of ratios disclosed with the results) and the ECL / staging note are the usual
   places; in the IP it is the asset quality slide.
2. Take the standalone set, as at the quarter-end date.
3. Record for each of the three: value, the printed label, the base (loan book / AUM / not stated) in `definition`.
4. If only amounts are printed, compute in the sandbox and keep the inputs in the footnote:

   ```
   python3 -c "gs3=149.24; gross=8200.00; ecl3=50.59; print(round(gs3/gross*100,2), round((gs3-ecl3)/(gross-ecl3)*100,2), round(ecl3/gs3*100,2))"
   ```

   NNPA % from amounts = (Gross Stage 3 − Stage 3 ECL) ÷ (gross loans − Stage 3 ECL). Some companies divide by net
   loans after ALL provisions; if the filing prints its own NNPA %, use the printed figure, never your own.
5. Reconcile QR vs IP where both exist: `python3 /workspace/scripts/reconcile_sources.py --request ...` with
   `definition` on each candidate.
6. Sanity (the validator enforces these): NNPA ≤ GNPA; 0 ≤ each ≤ 100; GNPA above 25% or PCR outside 5–90% is
   flagged for the analyst, not rejected. `python3 /workspace/scripts/validate_kpis.py <batch.jsonl>`.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

QR page 6, ECL note (₹ in crore, standalone):

| | Gross carrying amount | ECL allowance |
|---|---|---|
| Stage 1 | 7,722.76 | 23.17 |
| Stage 2 | 328.00 | 19.68 |
| Stage 3 | 149.24 | 50.59 |
| Total | 8,200.00 | 93.44 |

QR ratios note: "Gross NPA 1.82%, Net NPA 1.21%".

- `gnpa_pct` 1.82 (QR p.6, `definition` "Gross NPA % as per ratios note; equals Gross Stage 3 / gross loans =
  149.24 / 8,200.00").
- `nnpa_pct` 1.21 (printed). Own check: (149.24 − 50.59) ÷ (8,200.00 − 50.59) = 1.21%.
- `pcr_stage3_pct` = 50.59 ÷ 149.24 = 33.90 (`definition` "Stage-3 PCR = Stage 3 ECL / Gross Stage 3, computed from
  the ECL note"). Total ECL ÷ Stage 3 = 62.61% is NOT the KPI.

IP slide 14 shows "GNPA 1.49% (on AUM)". 149.24 ÷ 10,000 = 1.49%: the presentation uses AUM as the base. 18% below
the QR figure → the reconciler returns the QR value with `needs_review` and both definitions in the footnote.

## Failure modes

- **Stage 3 including restructured accounts.** Use the Stage 3 figure as printed; do not split out or mention the
  restructured part.
- **Percentages on a chart only** → `needs_review`, `read_from_chart: true`.
- **"Net Stage 3" printed as an amount only and no ECL by stage** → NNPA % is `not_found`; do not back-solve from PCR
  unless the PCR is explicitly the Stage-3 PCR, and if you do, say so and mark `needs_review`.
- **Days-past-due buckets (30+ DPD, 90+ DPD)** are not GNPA. 90+ DPD is close to, but not the same as, Stage 3:
  `not_found` unless the filing itself equates them.
- **Consolidated only** → see `standalone-vs-consolidated`.
