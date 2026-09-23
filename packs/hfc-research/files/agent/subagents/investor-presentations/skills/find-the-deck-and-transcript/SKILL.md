---
description: Use when you need to locate, name and file a quarter's investor presentation or earnings-call transcript for an HFC (or its parent), when you are unsure whether a document is already in the data room, or when web search is disabled and you must work from what is filed.
---

# Find the deck and the transcript

The analysts read two documents a quarter: the **investor presentation** (IP) and the **earnings-call
transcript**. This skill is the procedure for getting the right files into the data room once, under the
right names, and for saying plainly what you could not get.

## Recognise the situation

- The request names a company and a quarter ("Q2 FY26 deck for Example Housing Finance").
- `dataroom_list` on `Companies/{company_id}/filings/presentations/` does not show that quarter.
- Or it shows a file and you need to know whether it is the same document you just found.

## Procedure

1. **Look in the data room first.** `dataroom_list` on `Companies/{company_id}/filings/presentations/`.
   File names carry the period, so `Q2FY26` in a name means that quarter is already filed. Do not file a
   second copy. If a file is there, go straight to reading it.
2. **Find out what kind of company it is** with `get_company`: equity-listed (own deck) or unlisted /
   debt-listed (parent's deck; load `parent-deck-for-unlisted-hfc`).
3. **If `web_search` is not among your tools, stop searching.** Work only from the data room and open your
   reply with: "Web search is disabled in this workspace, so I worked only from documents already in the
   data room." List what is missing. Do not describe a document you have not opened.
4. **With web search, look in this order** and stop at the first place that gives you the document itself:
   1. The exchange intimation. Companies send the presentation and, later, the transcript to BSE and NSE as
      disclosures under Regulation 30 of the SEBI listing regulations. Query patterns are in
      `references/search-queries.md`.
   2. The company's investor-relations page (usually "Investors" > "Investor presentation" / "Earnings call"
      / "Financial results", arranged by financial year and quarter).
   3. For a subsidiary, the parent's investor-relations page and the parent's exchange filings.
5. **Check that what you retrieved is the document**, not a page about it:
   `python3 /workspace/scripts/detect_content_type.py /workspace/in/<file>`
   - `kind: other` with `detail: html` means you saved a web page or an error page. Do not file it.
   - `looks_like: slides` for a deck, `looks_like: document` for a transcript. A covering letter to the
     exchange is often the first page or two of the same PDF; that is fine, slide numbers are PDF page numbers.
   - `text_layer: scanned` is still the document; file it, and say it is scanned.
6. **Confirm the period from the document's own cover or first slide**, never from the search result's
   title. Run `python3 /workspace/scripts/slide_index.py /workspace/in/<file>` and read slide 1 to 3.
7. **Name and file it** (rules in `references/naming-and-dedupe.md`):
   - `Companies/{company_id}/filings/presentations/{YYYY-MM-DD}_{period}_investor-presentation.pdf`
   - `Companies/{company_id}/filings/presentations/{YYYY-MM-DD}_{period}_concall-transcript.pdf`
   - parent's document: `_parent-{parent-slug}` before the extension.
   - `period` is written `Q2FY26`. The date is the date the document was published or sent to the exchange,
     as printed on it. A `.pptx` keeps its own extension.
8. **Dedupe.** The exchange copy and the IR-page copy are the same deck. File one. Prefer the one with a
   text layer; if both have one, prefer the exchange copy because its date is unambiguous.

## What to write

Only a file you actually retrieved, under the name above. Nothing else. No placeholder files, no `.md`
summary of a news article about the results, no transcript reconstructed from a video or an article.

## Worked example

Request: "Get the Q2 FY26 deck and concall for Example Housing Finance Ltd."

1. `dataroom_list` shows `2025-08-02_Q1FY26_investor-presentation.pdf` only. Q2 is missing.
2. `get_company`: equity-listed. Own deck.
3. Search "Example Housing Finance investor presentation Q2 FY26" restricted to the exchange sites. The
   first result is an intimation dated 4 November 2025 with a PDF attached.
4. Fetched to `/workspace/in/ehfl-q2.pdf`. `detect_content_type.py` says
   `{"kind": "pdf", "text_layer": "text", "slide_count": 46, "looks_like": "slides"}`.
5. Slide 2 of the PDF (slide 1 is the covering letter) reads "Investor Presentation, Q2 FY26". Period confirmed.
6. Filed as `Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf`.
7. The transcript is not yet on the exchange or the IR page (transcripts usually follow the call by some
   days). Reply: "The Q2 FY26 transcript is not published yet as far as I could find; I looked at the exchange
   announcements and the company's investor page on <date>. The audio recording link exists but I do not
   transcribe recordings."

## Failure modes and what to report

| Situation | Do this |
|---|---|
| Only a press release or a results PDF, no deck | Say the company appears not to publish a deck for this quarter. The results belong to `lodr-filings`; do not file them here. |
| Search result title says Q2 but the cover says Q1 | Trust the cover. File under the cover's period, and say the listing was mislabelled. |
| Two decks for one quarter (results deck and a later investor-day or roadshow deck) | File the results-day deck as the quarter's IP. Mention the other; file it only if asked, with `_investor-day` before the extension. |
| Revised deck re-filed after a correction | File the revised one with its own date; keep the first. Say which one your numbers come from (the later). |
| Download blocked, login wall, or only an HTML viewer | Do not file. Give the URL and say the file could not be retrieved. |
| The regulation number on the covering letter is not 30 | Record what the letter says and mention it. The numbering may have been amended; the document is what matters. |
| Web search disabled | Work from the data room only and say so in the first line of the reply. |
