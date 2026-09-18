# Search query patterns

`web_search` takes a free-text query and returns titles, URLs, dates and snippets. Put the identifying token first
(scrip code, symbol, exact legal name in quotes), then the document, then the site. One query per thing you want;
do not pack tags together.

`{name}` = exact legal name, `{code}` = BSE scrip code, `{sym}` = NSE symbol, `{qe}` = quarter-end date in words
("September 30 2025"), `{q}` = "Q2 FY26".

| Looking for | Queries to try, in order |
|---|---|
| Latest results (Reg 33 / 52) | `"{name}" financial results quarter ended {qe} bseindia.com` ; `{sym} financial results {qe} nseindia.com` ; `"{name}" outcome of board meeting {qe}` ; `"{name}" investor relations financial results {q}` |
| Results of a debt-listed company | `"{name}" regulation 52 financial results {qe}` ; `"{name}" debt securities financial results {qe} bseindia.com` |
| Shareholding pattern (Reg 31) | `{code} shareholding pattern {qe} bseindia.com` ; `"{name}" shareholding pattern {qe}` |
| Rating action (Reg 30 / 51 / 55) | `"{name}" credit rating intimation regulation 30` ; `"{name}" rating rationale` (the agency's rationale is background, not the filing) |
| Fund raise | `"{name}" allotment non-convertible debentures intimation` ; `"{name}" QIP OR "preferential issue" outcome` |
| KMP / auditor change | `"{name}" appointment OR resignation "managing director" OR "chief financial officer" regulation 30` ; `"{name}" statutory auditor appointment` |
| Investor meet, presentation, transcript | `"{name}" investor presentation {q}` ; `"{name}" earnings call transcript {q}` ; `"{name}" analyst investor meet schedule` |
| RPT disclosure (Reg 23(9)) | `"{name}" related party transactions half year ended {qe}` |
| Security cover, deviation | `"{name}" security cover certificate {qe}` ; `"{name}" statement of deviation {qe}` |
| Annual report | `"{name}" annual report FY{yy} pdf` |
| Scrip code / symbol unknown | `"{name}" BSE scrip code` ; `"{name}" NSE symbol` ; for debt-listed: `"{name}" debentures listed BSE ISIN` |
| Parent of a subsidiary | `"{parent}" investor presentation {q} housing finance subsidiary` ; `"{parent}" financial results {qe} segment` |

## Reading a hit

- Trust order for the URL's site: exchange, then the company's own domain, then the parent's domain. Anything else
  is a lead only.
- The hit's date is the search engine's guess. The filing date comes from the exchange's announcement line or the
  covering letter.
- An exchange announcement line typically shows: company, subject / category, dissemination date and time, and an
  attachment link. The subject line is what you pass to `classify_filing.py --subject`.
- Exchange page layouts and URL shapes change. Do not construct attachment URLs from a pattern you remember; use
  only URLs a search returned or a page you fetched shows.

## When the download is refused

Exchange sites commonly serve an HTML page to `curl`. Signs: `detect_content_type.py` says `kind: html` with
`extension_mismatch`, or the file is a few kilobytes. Then:

1. the company's IR copy of the same document;
2. for results, the exchange's XBRL / "results" page text if search returned it (file as `.md` with its URL);
3. otherwise report the URL under "could not retrieve". Do not retry in a loop, and do not rebuild the document
   from snippets.
