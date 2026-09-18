---
description: Use when you need the asset-quality position from a results filing - Stage 1/2/3 gross loans and ECL, Gross and Net NPA or Stage 3, provision coverage, CRAR - and have to find it in the notes, a ratios annexure or rows under the P&L, under whichever vocabulary the company uses.
---

# Asset quality and ECL in the notes

The analysts define GNPA as Gross Stage 3 (GS3) / Gross NPA and NNPA as Net Stage 3 / Net NPA, and take asset
quality and capital adequacy from the Quarterly Report. The P&L does not carry them. They sit in one of four places,
and a company rarely uses the same place or the same words as its peers.

## Where it is

| Place | What it looks like | How complete |
|---|---|---|
| A note to the results | "Gross Stage 3 assets stood at Rs X crore (a%) and Net Stage 3 at Rs Y crore (b%); ECL provision of Rs Z crore, coverage c%" in a sentence, or a small Stage 1/2/3 table | Often percentages plus one or two amounts |
| Reg 52(4) annexure / rows under the P&L (entities with listed debt) | "Gross NPA (%)", "Net NPA (%)", "Provision coverage ratio", "CRAR" among the ratios | Percentages only |
| The RBI ECL-vs-IRACP comparison table (asset classification as per RBI norms against Ind AS 109 stages) | A wide table: Performing (Stage 1, Stage 2), Non-performing (Stage 3: substandard, doubtful, loss), gross carrying amount, loss allowance under Ind AS 109, net carrying amount, provisions as per IRACP norms, difference | Complete, but usually only in the year-end filing / annual report |
| Not in the filing | Quarterly results of some companies give no asset-quality number | Report as not disclosed; the investor presentation may carry it (not your source) |

## Procedure

1. Find the notes and the ratios pages:

   ```
   python3 /workspace/scripts/locate_results_sections.py /workspace/in/results.pdf
   ```

   Use the `notes` section of the **standalone** basis, plus `reg52_4_ratios` and `reg52_4_mentions`.
2. Search those pages' text for the vocabulary in `references/vocabulary.md` (case-insensitive). Read the whole
   sentence or table around each hit: the same note often gives current quarter, previous quarter and year-end.
3. For each figure found, write a disclosure row (keys below) with the label **as printed**, the as-at date as the
   period (`period: "Q2 FY26"`, `period_kind: "as_at"`), the page, and for amounts the `raw` text and
   `unit_reported`. The unit of a note is the unit stated in the note or, failing that, the statement's header unit
   ("all amounts in Rs lakh unless otherwise stated"). If a sentence says "Rs 450 crore" inside a lakh-denominated
   filing, the sentence wins for that figure.
4. Do not compute. If the filing gives Gross Stage 3 and the ECL on Stage 3 but no coverage ratio, hand over the two
   amounts; `pcr_pct` is `not_disclosed`. If it gives percentages without amounts, hand over percentages.
5. Validate the extract:

   ```
   python3 /workspace/scripts/validate_results_extract.py /workspace/out/extract.json
   ```

| Key | Meaning | Unit |
|---|---|---|
| `gross_stage1`, `gross_stage2`, `gross_stage3` | Gross carrying amount of loans per stage | crore |
| `ecl_stage1`, `ecl_stage2`, `ecl_stage3` | Loss allowance (ECL provision) per stage | crore |
| `total_gross_loans`, `total_ecl` | Totals of the same table | crore |
| `net_stage3` | Stage 3 net of its ECL, when printed | crore |
| `gnpa_amount`, `nnpa_amount` | When the filing speaks of NPA (RBI / NHB classification) rather than stages | crore |
| `gnpa_pct`, `nnpa_pct` | Gross / Net NPA or Stage 3 ratio, whichever the filing prints; the label tells which | percent |
| `pcr_pct` | Provision coverage on Stage 3 / NPA, only when printed | percent |
| `crar_pct`, `tier1_pct`, `tier2_pct` | Capital adequacy | percent |

## Traps

- **Stage 3 vs NPA.** They are close but not identical (Ind AS staging vs regulatory classification). The analysts
  treat them as the same KPI, but you keep the printed label so they can see which one it was. If both are printed
  and differ, hand over both: `gnpa_pct` twice is not allowed, so give the Stage 3 percentage under `gnpa_pct`
  with its label, and mention the NPA figure with its page in the reply.
- **Denominator.** "% of loan assets", "% of AUM", "% of gross advances" differ when there is an off-book portfolio.
  Copy the denominator wording into `note`.
- **Restructured accounts.** Notes on resolution frameworks and restructured accounts sit right next to the staging
  note. Do not extract them, even as context. The validator rejects any disclosure whose label or note mentions them.
- **Basis.** A consolidated note quotes consolidated Stage 3. Take the standalone note.
- **Period.** Balance-sheet items are as at the quarter end: `period_kind: "as_at"`. Never `quarter`/`ytd`.
- **Write-offs** in the quarter are flows (`ytd` or `quarter`), and are not part of this skill's keys: mention them in
  the reply if the note gives them.

## What to write

Rows in `extract.disclosures` of the results extract; `not_found` gets the names of what you looked for and did not
find (e.g. `"pcr_pct"`, `"crar_pct"`).

## Worked example

Example Housing Finance Ltd, Q2 FY26 standalone notes (page 7), filing unit Rs lakh:

> 6. Gross Stage 3 loans as at September 30, 2025 stood at Rs. 45,000.00 lakh (1.10% of loan assets) and Net Stage 3
> at Rs. 27,000.00 lakh (0.67%). The Company holds ECL provision of Rs. 18,000.00 lakh on Stage 3 assets.

```json
[{"key": "gross_stage3", "label_reported": "Gross Stage 3 loans", "period": "Q2 FY26", "period_kind": "as_at", "value": 450.0, "unit": "crore", "raw": "45,000.00", "unit_reported": "lakh", "status": "ok", "page": 7},
 {"key": "gnpa_pct", "label_reported": "Gross Stage 3 (% of loan assets)", "period": "Q2 FY26", "period_kind": "as_at", "value": 1.10, "unit": "percent", "raw": "1.10%", "status": "ok", "page": 7, "note": "denominator: loan assets"},
 {"key": "net_stage3", "label_reported": "Net Stage 3", "period": "Q2 FY26", "period_kind": "as_at", "value": 270.0, "unit": "crore", "raw": "27,000.00", "unit_reported": "lakh", "status": "ok", "page": 7},
 {"key": "nnpa_pct", "label_reported": "Net Stage 3 (%)", "period": "Q2 FY26", "period_kind": "as_at", "value": 0.67, "unit": "percent", "raw": "0.67%", "status": "ok", "page": 7},
 {"key": "ecl_stage3", "label_reported": "ECL provision on Stage 3 assets", "period": "Q2 FY26", "period_kind": "as_at", "value": 180.0, "unit": "crore", "raw": "18,000.00", "unit_reported": "lakh", "status": "ok", "page": 7},
 {"key": "pcr_pct", "label_reported": "Provision coverage ratio", "period": "Q2 FY26", "period_kind": "as_at", "value": null, "unit": "percent", "raw": null, "status": "not_disclosed", "page": null}]
```

The coverage ratio (18,000 / 45,000) is not written: the filing did not print it, and computing it is the KPI
subagent's step.

## Failure modes

| Situation | Report |
|---|---|
| No hit for any vocabulary term on the text pages | "No asset-quality disclosure in the text pages of this filing (notes pp. x-y, ratios p. z searched)." Plus image pages, if any. |
| Only a chart-like sentence without numbers ("asset quality remained stable") | Not a disclosure. Nothing extracted. |
| Percentages differ between the note and the Reg 52(4) annexure | Hand over the note's (standalone) figure, mention the other with its page. |
