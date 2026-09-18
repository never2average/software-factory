# Naming and dedupe rules

## Path

```
Customers/{customer_id}/filings/presentations/{YYYY-MM-DD}_{period}_investor-presentation.pdf
Customers/{customer_id}/filings/presentations/{YYYY-MM-DD}_{period}_concall-transcript.pdf
Customers/{customer_id}/filings/presentations/{YYYY-MM-DD}_{period}_investor-presentation_parent-{parent-slug}.pdf
Customers/{customer_id}/filings/presentations/{YYYY-MM-DD}_{period}_concall-transcript_parent-{parent-slug}.pdf
```

| Part | Rule |
|---|---|
| `customer_id` | the covered company's slug from `get_customer`, even when the document is the parent's |
| `YYYY-MM-DD` | the date printed on the document or its covering letter; if none, the exchange's dissemination date; never today's date |
| `period` | `Q1FY26` .. `Q4FY26`. A Q4 deck that is titled "FY26" is still filed as `Q4FY26` |
| `parent-slug` | lower case, hyphens, the parent's short name: `example-finance` |
| extension | the file's real type from `detect_content_type.py` (`pdf` or `pptx`), not what the URL said |

## Is it already filed?

1. `dataroom_list` the folder.
2. A file with the same `{period}` and the same kind (`investor-presentation` / `concall-transcript`) and
   the same parent suffix means it is filed. Do not file again, even if your copy came from another site.
3. Same period, **different date**: it may be a revised deck. Compare slide counts from
   `python3 /workspace/scripts/detect_content_type.py <file>` on both. Different counts or a "Revised" mark
   on the cover: file the new one too and say which is later.

## Worked example

| Found | In the data room | Action |
|---|---|---|
| Q2 FY26 deck from the IR page | `2025-11-04_Q2FY26_investor-presentation.pdf` | Nothing to file |
| Q2 FY26 deck, cover says "Revised, 6 November 2025", 47 slides vs 46 | same | File `2025-11-06_Q2FY26_investor-presentation.pdf`; extract from this one |
| Parent's Q2 FY26 deck for an unlisted subsidiary `example-home-finance` | nothing | File `2025-10-29_Q2FY26_investor-presentation_parent-example-finance.pdf` under the subsidiary's folder |
