---
description: Use when the same KPI can be read from more than one document (quarterly results and investor presentation, or a subsidiary's LODR filing and its parent's presentation), when the two values differ, or when you must decide which document a KPI should come from at all.
---

# Source precedence and conflicts

The analysts' rule, from `schemas/kpi-spec.md`:

| Company | Rule |
|---|---|
| Listed | Investor Presentation (IP) for operational metrics: branches, employees, disbursements. Quarterly Report (QR) for financial ratios, asset quality and capital adequacy. |
| Listed, values differ | Use the QR value if the two are within 5%. |
| Listed, values differ by more than 5% | Open point in the rulebook. Until the analysts decide: report the QR value, show the IP value beside it in the footnote, status `needs_review`. |
| Unlisted (debt-listed HFC, subsidiary) | 1st the company's SEBI LODR filing; 2nd the PARENT company's investor presentation, cited as `parent IP` with the parent document named. |

You never apply the 5% rule in your head. The script does it.

## Recognise the situation

- You found the KPI in both the QR and the IP for the same quarter.
- The KPI is "operational" but only the QR has it, or "financial" but only the IP has it (very common: yield, cost of
  funds and NIM are usually presentation-only).
- The company has no presentation of its own: check `get_customer` and `list_memories` for "unlisted" / the parent's
  name. If you cannot tell whether the company is listed, ask the orchestrator; do not assume.

Which KPI is operational and which is financial is fixed in the catalog:

```
python3 /workspace/scripts/kpi_catalog.py --list
```

`nature: operational` = `aum`, `disbursements`, `branches`, `employees`. Everything else disclosed is `financial`.
Efficiency, return and productivity KPIs are `computed` and are never reconciled (see the `computed-ratios` skill).

## Procedure

1. Extract each candidate exactly as printed, with its unit (or the table header), document path, page or slide, and
   the period it belongs to. Do not convert or round anything yourself.
2. Write one request per KPI (schema: `/workspace/schemas/reconcile-request.schema.json`) and run:

   ```
   python3 /workspace/scripts/reconcile_sources.py --request /workspace/out/reconcile-q2fy26.json
   ```

   The file may hold one request object or a list of them. `--stdin` works too.
3. Copy `value`, `source`, `document`, `page_or_slide`, `status`, `footnote`, and when present `alt_value`,
   `alt_source`, `pct_diff` into the KPI row. Keep the `note` for your summary; it is not a footnote.
4. If the script lists something under `ignored`, read why. A candidate from another period or with no readable unit
   was NOT compared. Fix the request if you made a mistake; otherwise carry on with what was chosen.
5. For `needs_review`, list the cell in your final summary with both values and both page references.

## What the script decides

See `references/decision-table.md` for the full table. In short:

| Both present? | Difference | Value used | Status | Footnote |
|---|---|---|---|---|
| only one source | n/a | that source | `ok` | none (a `note` says when it is not the preferred source) |
| both | equal after rounding | preferred source is cited (IP for operational, QR for financial) | `ok` | none |
| both | up to and including 5% | QR | `ok` | shows the IP value and the % difference |
| both | more than 5% | QR | `needs_review` | shows both values, the IP document and slide |
| both, QR is zero | cannot compute % | QR | `needs_review` | says so |
| neither | n/a | none | `not_found` | where it was looked for |

The difference is `|QR − IP| ÷ |QR| × 100`, after both values are converted to ₹ crore.

## Worked example (synthetic: Example Housing Finance Ltd, Q2 FY26)

The QR's notes give disbursements of 1,88,000 (table header "₹ in lakhs"). The IP slide 9 says ₹1,900 crore.

```
echo '{"kpi":"disbursements","period":"Q2 FY26","listing":"listed",
 "qr":{"value":"1,88,000","unit":"lakh","document":"Customers/example-hfl/filings/lodr/q2fy26-results.pdf","page_or_slide":7},
 "ip":{"value":"1,900","unit":"crore","document":"Customers/example-hfl/filings/presentations/q2fy26-ip.pdf","page_or_slide":"slide 9"}}' \
 | python3 /workspace/scripts/reconcile_sources.py --stdin
```

Result: `value 1880.0`, `source QR`, `status ok`, `pct_diff 1.06`, footnote
"QR ₹1,880.00 crore vs IP ₹1,900.00 crore (1.06% apart, within the 5% tolerance): QR value used."

Note what happened: disbursements is an operational metric that would normally come from the IP, but the rulebook's
conflict rule says the QR value wins whenever the two differ within 5%. The script applies the rule as written.

More examples, including the > 5% case and the unlisted case, are in `references/worked-examples.md`.

## Failure modes

- **Different periods.** The IP slide shows a nine-month figure and the QR a quarter: they are not the same metric.
  Derive the quarter first (`discrete-quarter-from-cumulative`), then reconcile.
- **Different bases.** QR standalone vs IP consolidated. Pass `basis` on each candidate; the footnote will say so.
  A > 5% gap that is explained by basis is still `needs_review`.
- **Different definitions.** GNPA on loan book in the QR vs on AUM in the IP. Pass `definition` on each candidate
  and record the convention with `remember`.
- **Unlisted company with its own presentation.** The rulebook does not rank it. The script ignores `ip` for an
  unlisted company and says so: report this to the analyst instead of choosing.
- **Tolerance.** You may not loosen 5%. The request schema rejects `tolerance_pct` above 5.
- **A value read off a chart** is `needs_review` regardless of what the reconciliation says; set `read_from_chart`.
