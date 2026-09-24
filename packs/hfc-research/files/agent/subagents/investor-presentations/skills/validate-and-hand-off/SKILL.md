---
description: Use as the last step before any dataroom_append_jsonl, publish_artifact or record_interaction in this subagent, to validate ip-metrics and guidance rows, to decide what to do when validation fails, and to check that hfc-kpi-extraction gets every input it needs from you.
---

# Validate, then hand off

**Rule: validation runs before anything is written to the data room or published.** A failing validation is
reported to the analyst. It is never bypassed, and a row is never edited just to make it pass.

## Procedure

1. Write this run's rows to local files in the sandbox, never straight to the data room:
   - `/workspace/out/ip-metrics.new.jsonl`
   - `/workspace/out/guidance.new.jsonl`
2. Fetch what is already filed, so duplicates and changes can be checked:
   `dataroom_fetch_to_sandbox` `Companies/{company_id}/filings/presentations/ip-metrics.jsonl` → `/workspace/in/ip-metrics.jsonl`
   and `…/guidance.jsonl` → `/workspace/in/guidance.jsonl`. If a file does not exist yet, leave the option out.
3. Validate the metrics:
   `python3 /workspace/scripts/validate_ip_metrics.py /workspace/out/ip-metrics.new.jsonl --existing /workspace/in/ip-metrics.jsonl --require-core`
4. Validate the guidance:
   `python3 /workspace/scripts/validate_guidance.py /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl --transcript /workspace/in/transcript.pdf`
5. Read the JSON. `valid: true` and exit code 0: go on. Read the `warnings` anyway and mention the ones the
   analyst should know (a carried-forward offer missing, loan book + off-book ≠ AUM, implausible spread).
6. `valid: false` (exit 1): **nothing is appended.** For each error (`references/validator-rules.md` explains
   every rule):
   - If the extraction was wrong (unit not converted, slide missing, YTD filed as a quarter), go back to the
     slide, fix the extraction, re-run.
   - If the document itself is the problem (two slides disagree, sell down reported while AUM equals loan
     book), leave the affected rows out, append the rest only after a clean re-run, and report the problem
     with slide numbers.
   - Never change a value, drop a note, or flip `approximate` to get past the gate.
7. Append: `dataroom_append_jsonl` each validated row to
   `Companies/{company_id}/filings/presentations/ip-metrics.jsonl` and `…/guidance.jsonl`.
8. `record_interaction` for the call, and `publish_artifact` if a brief was asked for, **after** the appends.
9. Reply (the instructions' "Reply" section): brief, guidance table with changes, operational metrics with
   slide numbers, anything not found. Approximate values are marked "about"; parent-sourced values say so.

## Row fields

`ip-metrics.jsonl` (`/workspace/schemas/ip-metric-row.schema.json`), always: `primary_context_entity`, `period`, `metric`,
`value`, `unit`, `document`, `slide`, `approximate`, `from_parent`, `note`, `extracted_at`. Optional
provenance: `status` (`reported`, `nil`, `not_disclosed`, `no_off_book`, `derived`), `period_basis`, `basis`,
`source_label`, `source_value`, `source_unit`, `parent_document` (required when `from_parent` is true), and
the `carried_*` fields. `guidance.jsonl` (`/workspace/schemas/guidance-row.schema.json`), always:
`primary_context_entity`, `period`, `topic`, `statement`, `speaker`, `page`, `change_vs_previous`, `extracted_at`.
Optional: `subtopic`, `value_low`, `value_high`, `value_unit`, `direction`, `horizon`, `previous_period`,
`previous_statement`, `document`, `from_parent`, `note`.

## What hfc-kpi-extraction needs from you

One row per core metric per period, **even when the answer is "not there"**, so the KPI subagent can tell
"nil" from "not disclosed" from "no off-book":

| Metric | Why it needs it | If absent |
|---|---|---|
| `branches` | Disbursement per branch | `not_disclosed` + previous quarter's IP value in `carried_*` (rulebook: carry forward with a footnote) |
| `employees` | Disbursement / expense / employee cost per employee | same |
| `disbursements` (discrete quarter, ₹ crore) | Productivity ratios | `not_disclosed`, or a labelled YTD row |
| `aum` | Opex/AUM, ROA, and the AUM == loan book test | `not_disclosed` |
| `loan_book` (the deck's on-book figure) | The AUM == loan book test. The balance-sheet value is theirs | `not_disclosed` |
| `sell_down_volume` | KPI table | `nil` (0), `not_disclosed`, or `no_off_book` |
| `buy_out_volume` | KPI table | `nil` (0) or `not_disclosed` |

Also useful to them: `off_book_aum`, the mix rows, and the company's own `yield`, `cost_of_funds`, `spread`,
`nim` with the definition in the note. **Not yours:** GNPA, NNPA, PCR, CRAR, debt/equity, cost-to-income,
opex ratios, ROA, ROE, and the choice between an IP value and a results value (the 5% rule).
`--require-core` makes a missing core row an error.

Every row tells them, without opening the deck: the slide, whether the value is approximate, whether it came
from the parent's document, the basis (branches vs touchpoints, on-roll vs total), and the period basis.

## Worked example

`/workspace/out/ip-metrics.new.jsonl` for Example Housing Finance Ltd Q2 FY26 has 12 rows. First run:

```json
{"valid": false, "errors": [
  {"line": 3, "rule": "unit", "message": "'disbursements' is reported in crore, not 'million' (amounts are always Rs crore: convert, and keep the printed figure in source_value/source_unit)"},
  {"line": 9, "rule": "mix_sum", "message": "Q2 FY26: product mix shares on basis 'aum' add up to 135%. …"},
  {"line": null, "rule": "core", "message": "example-hfl Q2 FY26: no row for core metric(s) ['buy_out_volume']. …"}]}
```

Fixes: line 3 converted through the extractor (10,500 mn → 1,050 crore, `source_value`/`source_unit` kept);
line 9's affordable share given `basis: "affordable_cut"` because the slide shows it as a cut across housing;
a `nil` row added for buy out citing slide 41. Second run: `valid: true`, one warning (`aum_loan_book`: loan
book 10,900 + off-book 1,400 (approximate) ≠ AUM 12,345), which goes into the reply. Then the appends.

## Failure modes and what to report

| Situation | Do this |
|---|---|
| The validator itself crashes or a script is missing | Do not append. Report the error text; say validation could not run |
| `--existing` shows the row is already filed | Do not append it again. If the value differs from the filed one, report both; never append a second value silently |
| An error you believe is a false alarm | Still do not append that row. Report the rule, the row and why you think the deck is right; the analyst decides |
| The data-room file is unreadable (broken lines) | Report it; validate without `--existing` and say the duplicate check was skipped |
| Nothing could be extracted | Append nothing. The reply lists what was searched and not found |
