# Worked examples (synthetic)

All for "Example Housing Finance Ltd". Commands are run from anywhere in the sandbox.

## 1. Subject line only, listing unknown: reported, not guessed

```
python3 /workspace/scripts/classify_filing.py --subject "Unaudited Financial Results for the quarter ended June 30, 2025"
```

```json
{"tag": null, "confidence": "ambiguous", "candidates": ["reg33_results", "reg52_results"],
 "notes": ["the wording fits both the equity (Chapter IV) and the debt (Chapter V) tag; pass --listing from the company record"]}
```

Rerun with `--listing debt` -> `reg52_results`, `matched`, basis `subject_cue_only` (the note reminds you no citation was found).

## 2. Prior intimation that talks about results

> Intimation of Board Meeting pursuant to Regulation 29 ... to consider the unaudited financial results for the
> quarter ended September 30, 2025

-> `reg29_notice`, `matched`. Note: "prior intimation of a board meeting: it mentions ... business but does not carry it".
Do not log a period or basis on this row: it is not a results filing.

## 3. Rating letter citing Regulation 30

> Pursuant to Regulation 30 ..., ICRA has reaffirmed the credit rating of the Company's NCDs with a stable outlook.

-> `reg30_event`, `matched`, with the note "wording also suggests reg55_rating, which the letter does not cite; the
letter's citation is kept". The same letter citing "Regulation 51 and Regulation 55" -> `reg55_rating`, `also_covers: ["reg51_event"]`.

## 4. Carrier plus a specific regulation, wording missing

> Pursuant to Regulation 30 and Regulation 31 ..., please find enclosed the disclosure.

-> `ambiguous`, candidates `reg30_event`, `reg31_shareholding`. Read page 2: if it is the shareholding pattern
table, tag `reg31_shareholding` and say the letter did not name it.

## 5. Letter contradicts the company record

Company record: debt-listed. Letter: "Pursuant to Regulation 33 and Regulation 52 ...".

-> `ambiguous` with the note that Regulation 33 applies to listed equity. Either the record is stale (the company
listed its equity) or the letter is a template slip. Report both facts; update the record only on evidence of an
equity listing, not on this letter alone.

## 6. Not LODR

> Disclosure under Regulation 29(2) of SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011

-> `other`, `matched`; the note says the citation is under another regulation set. Title the log row with what it
is ("SAST Reg 29(2) disclosure by <acquirer>").

## 7. Renumbered regulation (trust the document)

A future letter says "Pursuant to Regulation 33A ..." and encloses quarterly results. With `--listing equity` the
script returns `reg33_results`, `matched`, basis `subject_cue_only`, and the note "also cited: Reg 33A is not in the
tag table". That note is the signal: tag `reg33_results`, set `regulation_as_cited: "Regulation 33A"` on the log
row, and tell the analyst the filing's numbering differs from the index. Without `--listing` the same input is
`ambiguous` between the two results tags, as in example 1.
