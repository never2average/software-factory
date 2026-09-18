---
description: Use when you have a LODR filing (or only its exchange subject line) and must give it exactly one regulation tag, especially when the covering letter cites several regulations or none.
---

# Classify a filing under one regulation tag

Every filing gets exactly one tag from the table in `references/tag-table.md`. The tag goes into the file name and
the filing log, so it is decided once, by script, from evidence you can quote.

## How to recognise what you have

A LODR filing normally opens with a covering letter to the exchange(s): addressee block (BSE / NSE), scrip code or
symbol, a `Sub:` line, and a first sentence of the form "Pursuant to Regulation N of the SEBI (Listing Obligations
and Disclosure Requirements) Regulations, 2015 ...". That sentence is the best evidence there is. When the letter is
an image, or there is no letter (XBRL, a shareholding pattern export), the exchange's announcement subject line is
the next best.

## Procedure

1. Find out whether the company is equity-listed or debt-listed (`get_customer`). Pass it as `--listing`. If the
   record does not say, run without it; the script will tell you when it matters.
2. Run the classifier on the first pages, and give it the exchange subject line too when you have it:

   ```
   python3 /workspace/scripts/classify_filing.py --pdf /workspace/in/filing.pdf --pages 2 --listing equity \
       --subject "Outcome of Board Meeting - Financial Results"
   ```

   With no PDF (subject line only, or text you captured): `--subject "..."` or `--text-file first_pages.txt`.
3. Read `confidence`:
   - `matched`: use `tag`. Copy `also_covers` into the log row (it lists tags absorbed into this one, for example
     `reg30_event` and `reg52_results` for an outcome letter that carries Reg 33 results and the Reg 52(4) ratios).
   - `ambiguous`: `tag` is null. Do not pick from `candidates`. Read the letter yourself using
     `references/tag-table.md`. If the document really carries two separate disclosures, tag it by the one the
     letter's subject line names first, log the other under `also_covers`, and say so in the reply. If you still
     cannot tell, tag `other`, and say in the title and summary what it is and why it did not classify.
   - `none`: no citation and no cue. Open the document. If it is not a LODR disclosure, tag `other` and say what it is.
4. `scanned_pages` in the output means the letter was an image: classify from `--subject`.

## Rules the script applies (so you can explain a result)

1. The letter's own citations beat subject wording. A rating letter that cites only Regulation 30 is `reg30_event`
   even though the wording says "credit rating"; the note tells you the wording pointed elsewhere.
2. A regulation number followed by the name of another SEBI regulation set (insider trading, takeovers,
   depositories ...) is not a LODR citation. Letters citing only those are `other`.
3. A prior intimation of a board meeting (Reg 29, or Reg 50 for debt-listed) is `reg29_notice` even though it
   names the results the meeting will consider. It carries no results.
4. A newspaper publication of results (Reg 47, or 52(8)) is `other`: it is an extract, not the filing.
5. A results tag with results wording absorbs what travels with results: the Reg 30 / 51 carrier, the statement
   of deviation (Reg 32 / 52(7)), the security cover certificate (Reg 54), the half-yearly RPT disclosure.
6. Reg 33 and Reg 52 cited together means listed equity plus listed debt: `reg33_results`, with `reg52_results`
   under `also_covers`. If the company record says debt-listed, that contradiction is reported as ambiguous:
   check the record, do not overrule the letter silently.
7. Reg 30 and Reg 51 are carriers. Cited with exactly one specific regulation whose wording is also present, the
   specific one wins. Without the wording, ambiguous.

The regexes and the regulation map are in `references/tag-regex-table.md` (the script reads the same table from
`/workspace/scripts/reference/filing_tag_patterns.json`; `--print-table` dumps it).

## Trust the document

If the filing cites a regulation number that does not fit this table for what the document plainly is (SEBI amends
and renumbers), record what the filing says: tag by what the document is, put the citation as printed into the log
row's `regulation_as_cited`, and mention the difference in your reply. Never "correct" the filing.

## What to write

Nothing by itself. The tag feeds `filing_name.py` and the log row (skill `filing-log-and-naming`).

## Worked example

Example Housing Finance Ltd, equity-listed with listed NCDs. Letter, page 1:

> Sub: Outcome of Board Meeting held on October 24, 2025. Pursuant to Regulations 30, 33, 52 and 54 of the SEBI
> (LODR) Regulations, 2015, we enclose the Unaudited Standalone and Consolidated Financial Results for the quarter
> and half year ended September 30, 2025, the Limited Review Reports, the disclosures under Regulation 52(4), the
> statement under Regulation 52(7) and the security cover certificate.

Output (abridged):

```json
{"tag": "reg33_results", "confidence": "matched", "basis": "citation_and_cue",
 "also_covers": ["reg52_results", "reg30_event", "reg32_deviation", "reg54_security_cover"],
 "notes": ["Reg 33 and Reg 52 both cited: equity-listed entity with listed debt; the Reg 52(4) line items are appended to the Reg 33 results"]}
```

One file, one log row, tag `reg33_results`. More cases, including the ambiguous ones, are in
`references/worked-examples.md`.

## Failure modes

| What you see | What to do |
|---|---|
| `ambiguous`, candidates `reg33_results` + `reg52_results`, no citation | The wording fits both chapters. Get the listing from the company record and rerun with `--listing`. |
| `ambiguous`, a carrier plus one specific tag | The letter cites it but the wording is absent in the pages read. Rerun with `--pages 4`; else read the letter. |
| `none` and `scanned_pages` listed | The letter is an image. Use the exchange subject line. |
| Exit 2 "no text to classify" | Same. Never invent a tag for a file you could not read. |
| The tag contradicts what the document obviously is | Report it with the evidence block; the letter may be wrong, but that is the analyst's call. |
