# Reply template

Keep it short. Numbers come from the validated rows, never retyped from memory.

```
<Company name> (<customer_id>): KPIs for <period>, <basis>

| Category | KPI | <period> | Source |
|---|---|---|---|
| Scale | AUM (₹ crore) | 10,000.00 | IP s.5 |
| ... one line per KPI in catalog order; "not found" where status is not_found ...

Needs review (n)
- GNPA %: QR 1.82% vs IP 1.20% differ by 34.07% (> 5%). QR shown. QR p.6; IP slide 14. Definitions differ (loan book vs AUM).

Carried forward (n)
- Branches: 198 as of Q1 FY26 (previous quarter's IP, slide 4); not published for Q2 FY26.
- Disbursement per Branch: computed on carried-forward branches.

Not found (n)
- Buy Out Volume: company states nil ("-" in the Acquired column, QR p.7).

Validator flags (n)
- F-RANGE Cost of Funds 3.9% is below the usual 4–16%: checked, the presentation prints this (slide 12).

Filings needed and not found
- none   |   Investor presentation for Q2 FY26 (ask investor-presentations)

Conventions recorded
- NIM = NII incl. assignment income / average AUM, annualised (remembered).

Written: 27 rows appended to Customers/<customer_id>/filings/kpis.jsonl; workbook <customer_id>-kpis.xlsx published.
```

If validation failed, replace the last line with:

```
NOT written: validation failed.
- E-NNPA line 11: NNPA 2.40% is greater than GNPA 1.82% (QR p.6 prints both). Please confirm which is right.
```

Source column abbreviations: `QR p.n`, `IP s.n`, `parent IP s.n`, `computed`.
