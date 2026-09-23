---
description: Use when asked to fetch, refresh or look for a company's LODR filings (latest results, a rating intimation, the shareholding pattern) on BSE, NSE or the company's investor-relations page, including when web search is disabled or the company is a subsidiary with thin disclosures.
---

# Find filings on the exchanges

## What decides the route

| Situation | Route |
|---|---|
| `web_search` is in your tool list | Exchange first, then the company's IR page, then the parent (order below). |
| `web_search` is not in your tool list | Web search is disabled in this workspace. Work only from `dataroom_list` on `Companies/{company_id}/filings/` and say so in the reply. Do not describe filings from memory. |
| Debt-listed ("unlisted") company | Same exchanges, but it appears under the debt segment. It has a scrip code / symbol for its debt securities, no equity quote page. |
| Subsidiary with thin disclosures | The subsidiary's own Reg 52 filings first; then the parent's filings and presentation, logged as from the parent. |

## Procedure

1. **Identify the company.** `get_company` for the legal name, BSE scrip code, NSE symbol, listing kind, parent.
   If the scrip code or symbol is missing, find it once (search "<legal name> BSE scrip code"), confirm it on an
   exchange page whose title shows the same legal name, then `upsert_company` and `remember` it. A similar name is
   not a match: group companies share names.
2. **Read the log first.** `dataroom_read` `Companies/{company_id}/filings/filing-log.jsonl`. Note the latest
   `filed_on` per tag. You are looking for what is newer or missing, not everything.
3. **Search, in this order**, using the query patterns in `references/search-queries.md`:
   1. the exchange's corporate announcements page and financial results page for the company (BSE by scrip code,
      NSE by symbol);
   2. the company's investor-relations page (usually sections named "Financial Results", "Stock Exchange
      Intimations" / "Disclosures under Regulation 46 / 62", "Shareholding Pattern", "Annual Reports");
   3. for a subsidiary, the parent's filings.
4. **Retrieve.** A search hit is a lead, not a document. Download the file into the sandbox and check it:

   ```
   curl -sSL --max-time 60 -A "Mozilla/5.0" -o /workspace/in/candidate.pdf "<url>"
   python3 /workspace/scripts/detect_content_type.py /workspace/in/candidate.pdf
   ```

   `kind: html` under a `.pdf` name means the site returned an error or consent page. That is not a retrieval.
   Try the company's IR copy. Exchange sites often refuse non-browser clients; that is expected, not a fault to
   work around with guesses.
5. **Confirm it is the right document** before filing: the company name on page 1, the period, the date.
   Classify it (skill `classify-a-filing`).
6. **File and log** (skill `filing-log-and-naming`). `filed_on` is the exchange's dissemination date. When you
   only have the IR copy, use the date on the covering letter and say so in the summary.

## Only file what you actually retrieved

- File a document only when its bytes (or its full text) came from an exchange or the company and are in the
  sandbox or data room now.
- Never file a news article, a broker note, an aggregator's summary, or a search snippet as the filing. A snippet
  can tell you a filing exists; report it under "looked for and could not retrieve", with the URL.
- `dataroom_write` stores text. A PDF you downloaded into the sandbox can be read there but cannot be written to
  the data room through it. File the text capture as `.md`: first line `source_url: <url>`, second line
  `retrieved_on: <date>`, then the text page by page under `## Page N` headings
  (`python3 /workspace/scripts/detect_content_type.py` tells you first whether there is any text to capture). Say in
  the reply that the original PDF is at the URL and was not stored. If the analyst uploads the PDF, log that path
  instead.
- A scanned PDF has no text to capture. Log nothing as filed; report the URL and that it is an image scan (skill
  `scanned-and-image-pdfs`).

## Subsidiaries via the parent

The analysts' rule for unlisted companies is: first the company's own SEBI LODR filings, then the parent's investor
presentation. When you take something from the parent:

- store it under the subsidiary's `company_id` with `source: "parent_company"` in the log row;
- put the parent's name in the title ("<Parent> Q2 FY26 results: segment note on housing finance subsidiary");
- say in the summary that the figures are the parent's disclosure about the subsidiary, and whether they are
  subsidiary standalone numbers or a segment of the parent's consolidated numbers. They are not the same thing.

## What to write

Files under `Companies/{company_id}/filings/lodr/`, one log row per file, company-record updates when a standing
fact changed (skill `material-events-and-ratings`). Validation comes first: `validate_filing_log.py`.

## Worked example

Task: "Get Example Housing Finance Ltd's latest results." Record: equity-listed, BSE scrip 500000, NSE symbol
EXAMPLEHFL. Log's latest `reg33_results` is Q1 FY26, filed 2025-07-25. Today is 2025-10-27.

1. Search `Example Housing Finance Ltd financial results quarter ended September 30 2025 bseindia.com`. One hit on
   the exchange's announcement page, subject "Outcome of Board Meeting", dated 2025-10-24, with an attachment URL.
2. `curl` the attachment: `detect_content_type.py` says `kind: html`, `extension_mismatch`. Not retrieved.
3. Search `Example Housing Finance investor relations financial results Q2 FY26`. The IR page lists
   "Q2 FY26 - Outcome of Board Meeting (PDF)". `curl` gives `kind: pdf`, `text_layer: mixed`, `image_pages: [2, 3]`.
4. Page 1 names the company and "quarter and half year ended September 30, 2025". Classifier: `reg33_results`.
5. File the text capture as `.md`, log with `source: "company_ir"`, `source_url` the IR URL, `filed_on: 2025-10-24`
   (the letter's date, same as the exchange's), `content: "mixed"`.
6. Reply lists the filing, says the exchange copy could not be downloaded and gives its URL, and says pages 2-3
   (the auditor's review report) are images.

## Failure modes

| What happens | What to report |
|---|---|
| Nothing newer than the log | "No filing after <date> found for <tags> on <places searched>." List the queries. That is a result. |
| Hits only on news / aggregator sites | The lead and its URL, under "could not retrieve". Nothing filed. |
| Two companies with near-identical names | Stop; ask which one, giving both scrip codes. |
| The exchange and the IR copy differ (page count, a revised results PDF) | File the exchange copy as primary; mention the revision and log the revised one as a separate row with its own date. |
| Web search disabled | Say so in the first line of the reply; work from the data room only. |
