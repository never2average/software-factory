# filing-log.jsonl: fields

One JSON object per line at `Companies/{company_id}/filings/filing-log.jsonl`. Schema:
`/workspace/schemas/filing-log-row.schema.json`. No other fields are allowed.

| Field | Required | Rule |
|---|---|---|
| `primary_context_entity` | yes | the company's `company_id`; must equal the one in `path` |
| `filed_on` | yes | `YYYY-MM-DD`, the exchange timestamp date; real, not in the future, not before 2015; must equal the date in `path` |
| `tag` | yes | one of the fifteen tags; must equal the tag in `path` |
| `period` | for `reg33_results`, `reg52_results`; optional otherwise | canonical form only: `Q2 FY26`, `H1 FY26`, `9M FY26`, `FY26`. For results it is the filing period (the quarter), and the path's short name starts with it. Results cannot be dated before the period ends. |
| `basis` | for results tags; otherwise omit or null | what the filing **contains**: `standalone`, `consolidated`, `both`. (Which basis was extracted is in the results extract, not here.) |
| `title` | yes | the subject line as the exchange / letter gives it |
| `path` | yes | canonical, from `filing_name.py` |
| `source_url` | when `source` is `bse`, `nse`, `company_ir`, `parent_company`; always for a `.md` capture | `http(s)://...` exactly as retrieved |
| `source` | when there is no `source_url` | `bse`, `nse`, `company_ir`, `parent_company`, `data_room` (the file was already in the data room, e.g. uploaded by the analyst, and you only read and logged it) |
| `also_covers` | no | tags absorbed into this filing (from `classify_filing.py`); never repeats `tag` |
| `content` | no | `text`, `scanned`, `mixed`, `not_pdf` (from `detect_content_type.py`) |
| `regulation_as_cited` | no | only when the filing's regulation numbering differs from the tag table |
| `summary` | yes | two sentences at most; what was disclosed and when; no assessment |
| `logged_at` | yes | ISO timestamp with zone (`2025-10-27T06:10:00Z`); not before `filed_on`, not in the future |

## Short-name rules (`filing_name.py`)

1. Unicode folded to ASCII, lower-cased, `&` -> `and`.
2. Regulation citations removed ("Regulation 30", "Reg. 52(4)", "Regulations 30 and 33").
3. Split on anything that is not a letter or digit; drop stopwords: a, an, the, of, for, and, to, in, on, under,
   with, by, pursuant, regulation(s), reg, sebi, lodr, listing, obligations, disclosure(s), requirements, 2015,
   read, sub, subject, ref, reference, dear, sir, madam, intimation, submission.
4. Join with `-`, stop before the word that would pass 60 characters.
5. With `--period`, the period slug (`q2-fy26`) comes first and is not repeated if the title already had it.
6. Nothing left -> the script refuses; give a title that says what the document is.

| Title | Short name |
|---|---|
| Intimation under Regulation 30 of SEBI (LODR) Regulations, 2015 - Credit Rating Upgrade | `credit-rating-upgrade` |
| Shareholding Pattern for the quarter ended September 30, 2025 (`--period "Q2 FY26"`) | `q2-fy26-shareholding-pattern-quarter-ended-september-30-2025` |
| Change in KMP & Auditor's résumé | `change-kmp-auditors-resume` |

`python3 /workspace/scripts/filing_name.py --parse <path>` splits a canonical path back into its parts, which is
how the validator checks that path and row agree.
