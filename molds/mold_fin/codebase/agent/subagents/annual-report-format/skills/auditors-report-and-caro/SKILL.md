---
description: Use when extracting the Independent Auditor's Report - opinion type, key audit matters, emphasis of matter, material uncertainty on going concern, the CARO annexure clause by clause with any adverse or qualified remark flagged, and the internal financial controls opinion - for the standalone or the consolidated statements.
---

# Independent Auditor's Report and CARO

## How to recognise the parts

There are two auditor's reports when there are two sets of statements: map keys `standalone_auditors_report` and
`consolidated_auditors_report`. The analysts use standalone: extract that one unless asked for the other, and always
say which you extracted. The opinion paragraph names the statements audited ("the accompanying standalone financial
statements"); if the map's `basis` was taken from order only, confirm it there.

| Part | Heading | Notes |
|---|---|---|
| Opinion | "Opinion"; or "Qualified Opinion" / "Adverse Opinion" / "Disclaimer of Opinion" | A modified opinion always comes with a "Basis for Qualified (etc.) Opinion" paragraph: quote it in full |
| Basis for opinion | "Basis for Opinion" | Boilerplate when unmodified |
| Emphasis of matter | "Emphasis of Matter" | Draws attention to a note; opinion not modified. Quote, with the note number |
| Going concern | "Material Uncertainty Related to Going Concern" | Quote in full |
| Key audit matters | "Key Audit Matters" | A two-column table: the matter, and how the audit addressed it. For an HFC, typically impairment of loans (ECL), and often IT systems, derecognition on assignment, or valuation. Listed companies only |
| Other information, responsibilities | | Boilerplate: note presence only |
| Other matter | "Other Matter" | E.g. prior-year figures audited by a predecessor, reliance on other auditors (consolidated) |
| Report on other legal and regulatory requirements | | The s.143(3) list: managerial remuneration, pending litigation, audit trail (accounting software edit log) remarks. Quote anything that is not a plain confirmation |
| Annexure: CARO | "Annexure A / 1 ... referred to in paragraph ... (Companies (Auditor's Report) Order)" | Clause-by-clause. **Standalone report only**; the consolidated report carries just the clause listing group companies' adverse CARO remarks |
| Annexure: IFC | "Report on the Internal Financial Controls with reference to financial statements" | Its own opinion |

## Procedure

1. Check the pages are text: the signed auditor's report is the section most often scanned.

   ```
   python3 /workspace/scripts/detect_content_type.py /workspace/in/FY26_annual-report.pdf --first 158 --last 171
   ```

   If they are images, load `scanned-or-image-reports`. Never report a clean opinion from an empty extract.
2. Save the text of the range to a file and get the reading list:

   ```
   python3 /workspace/scripts/audit_report_flags.py /workspace/out/standalone-auditors-report.txt --basis standalone
   ```

   The script reports the opinion type from the report's own headings, which headings are present, the IFC opinion,
   and the CARO clauses split into `caro_read_these` and `caro_clean_wording`. **It is a reading list, not a
   verdict**: a clause is listed when it has a trigger word without a plain negation, or an "except", "however",
   "other than", "subject to".
3. Read every `read_this` clause and decide what it says. Quote the sentence, with printed and PDF page. Classify each
   remark as the auditor's wording supports: qualified or adverse remark; factual disclosure (disputed tax dues
   table, frauds by borrowers reported, delays in statutory dues); or not a remark after all.
4. Skim the `clean_wording` clauses for tables: clause (vii)(b) disputed dues and clause (iii) loans are often
   tables under a clean-sounding sentence.
5. Opinion `undetermined`, or IFC `undetermined`: read the paragraph and report its wording.
6. Key audit matters: extract as a two-column table, abridging the "how addressed" column to its bullet heads.
7. CARO clause numbering and content have changed between versions of the Order. Use the clause numbers printed in
   the report and describe each by its content; see [references/caro-clauses.md](references/caro-clauses.md) for what
   the clauses generally cover.

## What to write

`.../{fy}_annual-report/independent-auditors-report.md`: basis; auditor firm and signing date as printed; opinion
type with the quoted opinion sentence; modified-opinion basis, emphasis of matter, going concern, other matter
(quoted); KAM table; remarks under other legal and regulatory requirements; CARO: a table of clauses flagged, each
with quote, page and your classification, then "All other clauses: no adverse remark noted"; IFC opinion. No rows go
to `annual-report-data.jsonl` from this section unless amounts are asked for (disputed dues), in which case validate:

```
python3 /workspace/scripts/validate_ar_data.py /workspace/out/annual-report-data.jsonl --map /workspace/out/map.json
```

## Worked example

Example Housing Finance Ltd FY26, standalone auditor's report, printed pages 150-163 (PDF 158-171).
`audit_report_flags.py` returns opinion `unmodified`, `key_audit_matters: true`, `emphasis_of_matter: false`, IFC
`unmodified`, 7 CARO clauses found, and two to read:

| Clause | Quote | Page | Classification |
|---|---|---|---|
| (vii)(b) | "There are no statutory dues which have not been deposited on account of any dispute, except as given below: Income tax, Rs. 1.20 crore, assessment year 2021-22, Commissioner (Appeals)." | printed 160, PDF 168 | Factual disclosure: disputed income-tax demand of Rs. 1.20 crore |
| (xi)(a) | "No fraud by the Company and no material fraud on the Company has been noticed or reported during the year, other than 3 instances of fraud by borrowers aggregating Rs. 0.85 crore reported to the regulator." | printed 161, PDF 169 | Factual disclosure: 3 borrower frauds, Rs. 0.85 crore |

Clause (ix)(a) "has not defaulted in repayment" and clause (xvii) "has not incurred cash losses" come back as clean
wording. Summary line in the reply: "Unmodified opinion; KAM: impairment of loans (ECL); no emphasis of matter; CARO:
no qualified or adverse remark; two factual disclosures (disputed tax Rs. 1.20 crore; 3 borrower frauds Rs. 0.85
crore); IFC opinion unmodified."

## Failure modes and what to report

| Situation | Report |
|---|---|
| Pages scanned | Opinion, KAM and CARO **not reported**, with the page range. |
| Script finds no CARO clauses | The annexure may use "1.", "2." or "3(i)" numbering, or sit outside the range given. Read it by eye; say the script did not split it. |
| Two-column KAM table extracts interleaved | Crop the columns (`page.crop`) and re-extract. |
| Joint auditors, two signatures | Record both firms. |
| Consolidated report relies on other auditors | Quote the Other Matter paragraph with the share of assets / revenue it states. |
| A remark on restructured accounts | Report that the auditor remarks on it, with the quote; this is an audit remark, not restructured-book data, so it is kept. |
