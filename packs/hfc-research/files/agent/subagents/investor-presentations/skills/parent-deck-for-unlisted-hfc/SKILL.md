---
description: Use when the covered company is an unlisted or debt-listed housing finance company (a subsidiary) and its figures must be found inside the parent company's investor presentation or earnings call, including how to label and cite such figures.
---

# The parent's deck for an unlisted HFC

Rulebook, unlisted companies: **1st priority SEBI LODR filings; 2nd priority the parent company's investor
presentation.** The LODR filings belong to `lodr-filings`. You read the parent's deck, find the
housing-finance subsidiary inside it, and make it unmistakable in every row and every sentence that the
figure comes from the **parent's** document.

## Recognise the situation

- `get_company` says the company is unlisted / debt-listed, or names a parent. Examples: IIFL Home Finance
  inside IIFL Finance's deck, Tata Capital Housing Finance inside Tata Capital's.
- The company has no deck of its own on its investor page (some debt-listed HFCs do publish one: if so, that
  is its own deck and this skill does not apply).
- The data room holds, or you find, a file named `…_parent-{parent-slug}.pdf`.

## Procedure

1. Get the parent's name and slug from `get_company` (or the company's website). If the record does not
   say who the parent is, ask; do not guess from the brand name.
2. Find and file the parent's deck (`find-the-deck-and-transcript`), under the **subsidiary's** folder with
   `_parent-{parent-slug}` before the extension.
3. Index it: `python3 /workspace/scripts/slide_index.py /workspace/in/parent-deck.pdf > /workspace/out/slide-index.json`
4. Locate the subsidiary's slides. Parent decks are organised by business segment; look for
   (`references/segment-slide-cues.md`):
   - a section divider or slide title carrying the subsidiary's name or "Housing finance" / "Home loans" /
     "Mortgages" / "Affordable housing finance";
   - a "business-wise" / "segment-wise" / "subsidiary performance" summary table with one column or row per business;
   - the consolidated AUM break-up with a "Home loans" line.
   Search the index text for the subsidiary's name and the words above, e.g.
   `python3 -c "import json; d=json.load(open('/workspace/out/slide-index.json')); print([(s['slide'], s['title']) for s in d['slides'] if 'housing' in (s.get('text') or '').lower() or 'home loan' in (s.get('text') or '').lower()])"`
5. **Make sure the figure is the subsidiary's, not the group's product line.** "Home loans AUM" in a parent
   deck can be the group's home-loan *product* across entities (the parent may book home loans too), not the
   subsidiary's balance sheet. Use it only when the slide names the subsidiary entity, or the deck says the
   product is housed entirely in it. Otherwise report the figure as "group home-loan product, not entity
   level" and write no row.
6. Extract as usual from those slides
   (`python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --core`, then
   `python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide <n> --period Q2FY26`),
   restricted to the subsidiary's slides. Read each unit from its slide; parent decks often switch units
   between segments.
7. Every row: `from_parent: true`, `parent_document` naming the parent and its deck, `document` = the
   `_parent-…` file, and a `note` saying which segment slide. The validator enforces all three.
8. What is usually **not** in a parent deck (see the reference): employees and branches of the subsidiary
   alone, sell down / buy out, the subsidiary's own yield and cost of funds, its definitions. Write
   `not_disclosed` rows for the core metrics you could not find; for branches and employees also offer the
   previous quarter's value (`operational-metrics`).
9. The parent's concall: run `concall-guidance-tracking` on it, but keep only statements **about the
   subsidiary**; set `from_parent: true` on those guidance rows and name the parent in the note.
10. Validate (`validate-and-hand-off`).

## Citation wording

In the reply, never "Example Home Finance reported…". Always:

> "AUM ₹ 5,000 crore as at Q2 FY26, **from the parent's document**: Example Finance Ltd investor presentation
> Q2 FY26, slide 30 (housing finance segment). Example Home Finance does not publish its own deck; its LODR
> filings are the first-priority source and may differ."

## Worked example

Company `example-home-finance` (debt-listed), parent Example Finance Ltd (`example-finance`). Parent's
Q2 FY26 deck, 70 slides; slide 28 is a divider "Housing Finance: Example Home Finance Ltd"; slide 30
(₹ crore) gives "AUM 5,000 | Disbursements 420 | Branches 96 | GNPA 1.1%". No employee count, no assignment table.

```json
{"primary_context_entity":"example-home-finance","period":"Q2FY26","metric":"aum","value":5000,"unit":"crore","document":"Companies/example-home-finance/filings/presentations/2025-10-29_Q2FY26_investor-presentation_parent-example-finance.pdf","slide":30,"approximate":false,"from_parent":true,"parent_document":"Example Finance Ltd investor presentation Q2 FY26","note":"From the parent's deck, housing finance segment slide (entity named on the slide).","extracted_at":"2025-10-30T08:00:00Z"}
{"primary_context_entity":"example-home-finance","period":"Q2FY26","metric":"employees","value":null,"unit":"count","document":"Companies/example-home-finance/filings/presentations/2025-10-29_Q2FY26_investor-presentation_parent-example-finance.pdf","slide":null,"approximate":false,"from_parent":true,"parent_document":"Example Finance Ltd investor presentation Q2 FY26","note":"The parent's deck gives group headcount only (slide 6), not the subsidiary's. No earlier value on file.","extracted_at":"2025-10-30T08:00:00Z","status":"not_disclosed"}
```

## Failure modes and what to report

| Situation | Do this |
|---|---|
| The parent's deck has one line on the subsidiary | Extract that line; everything else `not_disclosed`. Say the LODR filings are the real source |
| Figures are for the "housing finance segment" including another entity | No rows. Report what the segment contains |
| The subsidiary is consolidated only part of the quarter (acquired or sold) | Report; write no flow rows for the part-quarter |
| Parent reports in a different fiscal year or currency | Report; do not map periods or convert currencies |
| Group branch count only | Not the subsidiary's. `not_disclosed` with the group figure mentioned in the note, clearly labelled group |
| The subsidiary turns out to publish its own deck | Use its own deck (`from_parent: false`); mention the parent's only as a cross-reference |
