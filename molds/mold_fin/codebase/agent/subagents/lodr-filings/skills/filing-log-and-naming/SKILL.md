---
description: Use when about to store a filing or a text capture in the data room or append to filing-log.jsonl - to build the canonical file name, check the log so the same document is never filed twice, write the log row, and validate it before anything is written.
---

# Filing log and naming

The data room is the analysts' archive. Two things keep it usable: every file name says what the file is, and the
log has exactly one row per filing. Both are produced by script and validated before any write.

## Canonical name

```
Customers/{customer_id}/filings/lodr/{YYYY-MM-DD}_{tag}_{short-name}.{ext}
```

- `{YYYY-MM-DD}` = `filed_on`: the exchange's dissemination date. If you only have the company's IR copy, the date
  on the covering letter; say so in the summary.
- `{tag}` = one of the fifteen tags (skill `classify-a-filing`).
- `{short-name}` = lower-case words from the subject line joined by hyphens, at most 60 characters, cut at a word
  boundary, boilerplate dropped ("pursuant to Regulation 30 of SEBI LODR" says nothing). For `reg33_results` /
  `reg52_results` it **starts with the period**: `q2-fy26-...`.
- `{ext}` = `pdf`, `md` (text capture), `xml` (XBRL), `xlsx`, `html`. From the file's real content
  (`detect_content_type.py`), not the URL's ending.

Derived files sit beside the filings: `Customers/{customer_id}/filings/lodr/extracts/{stem}.results-extract.json`
and `.../extracts/{stem}.shareholding.json`, where `{stem}` is the filing's file name without its extension.

## Procedure

1. **Read the log first.** `dataroom_read` `Customers/{customer_id}/filings/filing-log.jsonl` (a missing file means
   an empty log). Also `dataroom_list` `Customers/{customer_id}/filings/lodr/`. Save the log text to
   `/workspace/in/filing-log.jsonl` in the sandbox for the validator.
2. **Dedupe before fetching or writing.** A filing is already filed when the log has a row with the same
   `filed_on` + `tag` + `period` + title (ignoring case and punctuation), or the same `path`. Then do not write
   again. If you are only *reading* a filing that is already logged, do not add a row either; a new row is for a
   new document. (A revised filing the company re-submitted is a new document with its own date: log it, and
   say in its summary which row it revises.)
3. **Build the name:**

   ```
   python3 /workspace/scripts/filing_name.py --customer-id example-housing-finance --filed-on 2025-10-24 \
       --tag reg33_results --period "Q2 FY26" --ext pdf \
       --title "Outcome of Board Meeting - Unaudited Financial Results for the quarter ended September 30, 2025"
   ```

   It refuses impossible or future dates, unknown tags and extensions, a results tag without a period, and a title
   that leaves no words. Fix the input; do not hand-write a name.
4. **Write the row** to `/workspace/out/new-rows.jsonl`, one JSON object per line. Fields in
   `references/log-row-fields.md`; schema at `/workspace/schemas/filing-log-row.schema.json`.
5. **Validate** against the rules and the existing log:

   ```
   python3 /workspace/scripts/validate_filing_log.py /workspace/out/new-rows.jsonl --existing /workspace/in/filing-log.jsonl
   ```

   Exit 0 is required. On exit 1 read `errors`, fix the row (or the classification behind it), rerun. If it cannot
   be fixed (say the filing date is genuinely unknown), tell the analyst what is missing and write nothing.
6. **Only then** store the file (`dataroom_write`) and append the row (`dataroom_append_jsonl`), in that order, so
   a log row never points at a file that is not there.

## Idempotency

Running the same task twice must leave the data room unchanged the second time:

- same inputs to `filing_name.py` give the same path;
- the validator's `--existing` check turns a repeat into an error ("duplicate path" / "same filing ... already
  logged") instead of a second row;
- never "fix" a duplicate by altering the title or the date to get past the check;
- the log is append-only. A wrong row is corrected by telling the analyst; do not rewrite history with
  `dataroom_write` over the log.

## What to write

The file, then the row. In the reply, list each new row as `filed_on - tag - title - path`.

## Worked example

Example Housing Finance Ltd. The log already holds the Q1 FY26 results. New: the Q2 FY26 outcome letter with
results (text PDF, pages 2-3 images), fetched from the company's IR page.

`filing_name.py` ->
`Customers/example-housing-finance/filings/lodr/2025-10-24_reg33_results_q2-fy26-outcome-board-meeting-unaudited-financial-results.pdf`

Row:

```json
{"customer_id": "example-housing-finance", "filed_on": "2025-10-24", "tag": "reg33_results", "period": "Q2 FY26", "basis": "both",
 "title": "Outcome of Board Meeting - Unaudited Financial Results for the quarter ended September 30, 2025",
 "path": "Customers/example-housing-finance/filings/lodr/2025-10-24_reg33_results_q2-fy26-outcome-board-meeting-unaudited-financial-results.pdf",
 "source_url": "https://www.example-hfl.invalid/investors/results/q2fy26.pdf", "source": "company_ir",
 "also_covers": ["reg30_event", "reg52_results"], "content": "mixed",
 "summary": "Standalone and consolidated results for Q2 FY26 with limited review reports; Reg 52(4) ratios at p.11. Pages 2-3 are image scans.",
 "logged_at": "2025-10-27T06:10:00Z"}
```

Validator: `{"rows": 1, "valid": true, "errors": []}`. Running the whole task again: the validator returns
`line 1: duplicate path, already at existing line 2` and exits 1; nothing is written; the reply says the filing
was already in the log.

## Failure modes

| Error from the validator | Meaning |
|---|---|
| "path says tag = ... but the row says ..." | The file was named before the tag was settled. Rebuild the name. |
| "results path short name ... does not start with the period slug" | `--period` was not passed to `filing_name.py`. |
| "results cannot be filed before the period ends" | Wrong period or wrong date (often the year-ago quarter's date read from the table). |
| "source is 'bse' ... but source_url is missing" | Every fetched file carries the URL it came from. |
| "a .md text capture must carry the source_url" | A text capture without provenance is not a filing. |
| "summary has 3 sentences" | Two at most. Details go in the reply. |
| "unexpected field 'verdict'" | The log holds facts, not assessments. |
