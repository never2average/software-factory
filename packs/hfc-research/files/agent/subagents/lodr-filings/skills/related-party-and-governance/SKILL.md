---
description: Use when the filing is a half-yearly related-party transactions disclosure under Regulation 23(9), a quarterly corporate governance report under Regulation 27, or an annual secretarial compliance report under Regulation 24A - to file it correctly and tell the analyst the few things in it that matter for a housing finance company.
---

# Related-party and governance filings

These three filings are long, tabular and mostly routine. They are filed and logged like any other; nothing is
extracted into a schema. The skill is knowing what an analyst covering an HFC wants from each, so the two-sentence
log summary and the reply carry it.

## How to recognise them

| Tag | Looks like | Cadence | Format |
|---|---|---|---|
| `reg23_rpt` | "Disclosure of Related Party Transactions for the half year ended ..."; a very wide table in the SEBI-prescribed format, often submitted as XBRL / Excel with a PDF print | Half-yearly, with or soon after the H1 and FY results | One row per transaction |
| `reg27_cg` | "Report on Corporate Governance for the quarter ended ..."; annexures on board composition, committees, meeting dates, a yes/no compliance grid | Quarterly | Fixed annexures |
| `reg24a_secretarial` | "Annual Secretarial Compliance Report for the year ended 31 March ..." signed by a practising company secretary | Yearly | Compliance table + observations table |

Classify and name as usual:

```
python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/filing.pdf --listing equity
python3 /workspace/scripts/filing_name.py --customer-id example-housing-finance --filed-on 2025-11-10 --tag reg23_rpt --title "Related party transactions H1 FY26" --ext pdf --period "H1 FY26"
```

`period` on the log row: `H1 FY26` / `FY26` for the RPT disclosure (it is half-yearly: the second-half filing covers
the six months to March, which has no label in the period vocabulary, so log it as `FY26` and say "six months ended
31 March 2026" in the summary); the quarter for Reg 27; `FY26` for Reg 24A. No `basis`.

## Reg 23(9): what matters

The prescribed table has, per transaction: the listed entity or subsidiary entering into it; the counterparty and
its relationship; type of transaction; value approved by the audit committee; value during the reporting period;
amounts due to either party (opening, closing); and, for loans, inter-corporate deposits, advances or investments:
the source and cost of funds, interest rate, tenure, secured or unsecured, and purpose. Column order and count have
changed with SEBI's format revisions: read the header row.

For an HFC, scan for and report (with page, counterparty, amount, as printed):

1. **Funding from or to the group**: loans, ICDs, NCD subscriptions, guarantees or comfort from the parent /
   promoter; their rate and tenure. For a subsidiary HFC this is a real part of the liability profile.
2. **Portfolio transactions with related parties**: assignment, securitisation, co-lending, or servicing
   arrangements with a group bank / NBFC. These are sell-down / buy-out flows inside the group and the analysts
   will want to tie them to the transfer-of-loan-exposures note. Give the amounts; do not net or reconcile them.
3. **Fees and cost sharing**: sourcing / DSA commissions, brand or royalty fees, shared-services charges,
   rent paid to promoters' entities. Recurring and sized against opex.
4. **Insurance distribution income** from a group insurer.
5. **KMP remuneration** rows are routine: mention only a change of person.
6. **Any transaction whose value exceeds the approved value**, or is marked as not approved.

Units: this table is often in Rs lakh or Rs crore with a header note; say the unit with every figure. Convert to
crore in the reply only with the rule (lakh / 100, million / 10, billion x 100) and show the printed figure too.
Do not total rows yourself: the same exposure appears as transaction value and as closing balance.

## Reg 27: what matters

Routine unless one of these changes. Compare with the previous quarter's report in the data room when there is one:

- board composition: a resignation or appointment of an independent director, the chairperson, the MD & CEO;
  number of independent directors falling to the minimum; a vacancy not filled;
- committee composition (audit, risk, nomination) and whether the required meetings were held;
- any "No" in the compliance grid, and the explanation given;
- for a company that is "high value debt listed", which governance provisions it says apply.

A changed MD / CEO, CFO or auditor is a standing fact: `upsert_customer` (skill `material-events-and-ratings`), but
cite the Reg 30 intimation for the date if there is one; the Reg 27 report only confirms it.

## Reg 24A: what matters

- the **observations / deviations table**: each non-compliance, the regulation concerned, action taken by the
  exchange or SEBI (fine, warning letter), and management's response;
- the table on **actions taken on previous years' observations**;
- fines levied for late filing of results or the shareholding pattern (they also explain odd filing dates in the log).

"No observations" is the common case: say exactly that, with the page.

## What to write

The file (or `.md` capture) and one log row each. Validate before appending:

```
python3 /workspace/scripts/validate_filing_log.py /workspace/out/new-rows.jsonl --existing /workspace/in/filing-log.jsonl
```

The column families of the prescribed RPT table, and how to read them: `references/rpt-table-columns.md`.

## Worked example

Example Housing Finance Ltd, Reg 23(9) disclosure for the half year ended 30 September 2025, table unit Rs lakh.
Rows of note: "Example Parent Ltd (holding company) - inter-corporate loan taken - value during the period
25,000.00 - closing balance 40,000.00 - interest 8.75% - tenure 36 months - unsecured - for onward lending";
"Example Bank Ltd (fellow subsidiary) - assignment of loan portfolio - 31,000.00"; "Example Insurance Ltd -
commission income - 420.00".

Log summary (two sentences): "RPT disclosure for H1 FY26: inter-corporate loan of Rs 250.00 crore taken from the
holding company at 8.75% (closing balance Rs 400.00 crore) and loan assignment of Rs 310.00 crore to a fellow
subsidiary bank. Other rows are commission income, rent and KMP remuneration."

Reply adds page numbers, printed figures in lakh, and: "The assignment to Example Bank Ltd (p.3) is part of the
sell down disclosed in the Q2 FY26 results note on transfer of loan exposures (Rs 620.00 crore for H1); the two
filings do not say how they relate."

## Failure modes

| Situation | Action |
|---|---|
| RPT disclosure only as XBRL / Excel | `detect_content_type.py` says `xbrl-xml` / `xlsx`. File with that extension (`xml`, `xlsx`). Read with the standard library / openpyxl. |
| The table is a scan | Skill `scanned-and-image-pdfs`. Log it, say nothing was read. |
| Hundreds of rows | Report by the six headings above, largest first, five rows at most per heading, and say how many rows there were. |
| Debt-listed entity files a Reg 23(9)-style disclosure | Tag `reg23_rpt` if the letter cites it; record the citation as printed. |
