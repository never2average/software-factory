---
description: Use when you open an HFC investor presentation and need to find your way around it, when the deck is a PPTX rather than a PDF, when slides are landscape with several panels, or when the same number appears on more than one slide and you must decide which slide to cite.
---

# Deck layout variants

Decks differ in order, length and template, but HFC decks are built from the same dozen sections. Index the
deck first, then read the sections you need. Never read a deck top to bottom hunting for a number.

## Recognise the variation

| What you see | What it means |
|---|---|
| `detect_content_type.py` says `kind: pdf`, `looks_like: slides` | The usual case: a deck exported to PDF. One PDF page is one slide |
| `kind: pptx` | The native file. Titles come from the title placeholder, which is more reliable than a PDF; charts have no text at all unless data labels are on |
| `text_layer: mixed` | Some slides are pictures (pasted charts, maps, scanned tables). See `chart-only-figures` |
| `text_layer: scanned` | The whole deck is an image. Report it; look for a text copy (`find-the-deck-and-transcript`) |
| First one or two PDF pages are a letter to the exchange | Slide numbers you cite are **PDF page numbers**, so they are offset from the number printed on the slide. Say "slide 14 (PDF page)" once in your reply if they differ |
| A slide with four to six boxes, each with its own mini-title and chart | A multi-panel slide. Text extraction interleaves the panels; read panel by panel (below) |

## Procedure

Parse in the sandbox: `dataroom_fetch_to_sandbox` brings the file to `/workspace/in/`, and the scripts read it
with `pdfplumber` (a PDF) or `python-pptx` (a .pptx). Keep the slide number with every figure.

1. `python3 /workspace/scripts/detect_content_type.py /workspace/in/deck.pdf`
2. `python3 /workspace/scripts/slide_index.py /workspace/in/deck.pdf > /workspace/out/slide-index.json`
   Each slide gets a title, the unit it names, the periods on it, a section guess, `in_appendix`, and
   `excluded` for restructured-book slides. The keyword table behind the guess is
   `references/section-keywords.json` (the script reads the same table at `/workspace/references/`).
3. Read the index's `warnings` first: image-only slides, slides with two units, excluded slides, and whether
   an Appendix divider was found.
4. Where `section` is `null`, the script saw a tie or too little text. Read that slide's title yourself; do
   not assume.
5. Go to the sections your metric lives in (`references/section-order.md` maps metrics to sections), or let
   `python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric <key>`
   rank the slides.
6. **Multi-panel slides.** The extracted text runs left to right across panels, so a label from panel 1 can
   sit next to a number from panel 2. Use `extract_labelled_numbers.py` only as a list of candidates, then
   confirm each against the panel's own mini-title, unit and period. A panel can have its own unit
   ("₹ crore" in one, "%" in the next).
7. **Repeated numbers: which slide to cite.** Decks state AUM, disbursements and branches several times.
   Apply `references/which-slide-to-cite.md`: prefer the slide whose *subject* is the metric and that gives
   the discrete quarter with a printed number, over a highlights tile, over a chart, over the cover strip.
   If two slides disagree, do not pick: report both with slide numbers.

## What to write

Nothing is written from this skill alone. It produces `/workspace/out/slide-index.json`, which the other
skills use. Every figure you later write carries the slide number from this index.

## Worked example

Example Housing Finance Ltd, Q2 FY26 deck, 46 PDF pages. `slide_index.py` reports (abridged):

| slide | title | section | unit | periods | in_appendix |
|---|---|---|---|---|---|
| 1 | (covering letter) | null | null | | false |
| 2 | Investor Presentation Q2 FY26 | cover | null | Q2 FY26 | false |
| 4 | Key Highlights – Q2 FY26 | highlights | crore | Q2 FY26 | false |
| 9 | AUM and Disbursement trend | aum_disbursements | crore | Q2 FY25, Q1 FY26, Q2 FY26, H1 FY26 | false |
| 12 | Product and customer mix | product_customer_mix | null | Q2 FY26 | false |
| 15 | Pan-India distribution network | network | null | Sep-25 | false |
| 22 | Borrowing profile and ALM | borrowings_alm | null (`million`, `billion` both named) | | false |
| 38 | Appendix | appendix | null | | true |
| 41 | Details of loans transferred and acquired | appendix | crore | Q2 FY26, H1 FY26 | true |
| 44 | Restructured book | restructured_book (`excluded: true`) | crore | | true |
| 45 | Glossary | glossary | null | | true |

AUM of 12,345 appears on slides 4, 9 and 26. Slide 9's subject is AUM, it prints the number in a table with
the quarter in the column header, so slide 9 is cited. Slide 44 is never opened for extraction.

## Failure modes and what to report

| Situation | Do this |
|---|---|
| No Appendix divider found (`appendix_starts_at: null`) | Some decks have no appendix. Search for sell down / buy out by label across the whole deck; say the deck has no appendix section |
| Titles come out as the company name or a footer on every slide | The template repeats a header. Read `section_candidates` and the first lines of `text` instead; tell the analyst the titles are unreliable for this deck |
| Section order differs from the usual | Expected. Trust the deck in front of you; the order table is a guide, not a rule |
| PPTX with charts whose numbers are missing from `text` | Charts in PPTX carry text only when data labels are on. Treat as `chart-only-figures` |
| Python library missing (exit code 3) | Report that the sandbox lacks the parser; do not fall back to guessing from the file name |
