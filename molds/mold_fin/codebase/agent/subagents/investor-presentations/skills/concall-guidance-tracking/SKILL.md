---
description: Use when reading an earnings-call transcript to extract management guidance (AUM growth, disbursement growth, spread or NIM band, credit cost, opex or cost-to-income, branch additions, borrowing mix, capital raise, asset quality), to decide whether each item was maintained, raised, lowered, withdrawn or new versus the previous quarter, to list questions management did not answer, or to quote management correctly.
---

# Concall guidance tracking

## Recognise the document

A transcript is a portrait, text-heavy PDF (`detect_content_type.py` says `looks_like: document`). Its
usual structure (details in `references/transcript-structure.md`):

1. Cover: company, "Q2 FY26 Earnings Conference Call", date, a **management participants** list, sometimes the
   host brokerage.
2. Moderator's introduction.
3. **Opening remarks** by the MD/CEO and CFO: mostly a report on the quarter, with guidance near the end.
4. **Q&A**: the moderator introduces each analyst ("the next question is from the line of … from …").
5. Closing remarks.

Speaker turns start with `Name:` at the beginning of a line.

## Procedure

1. Check the file: `python3 /workspace/scripts/detect_content_type.py /workspace/in/transcript.pdf`.
   Scanned transcript: report it; do not quote from an image.
2. Get candidates:
   `python3 /workspace/scripts/guidance_extract.py /workspace/in/transcript.pdf > /workspace/out/guidance-candidates.json`
   It returns `guidance_candidates` (sentence, topic, speaker, role, page, figures, direction, flags),
   `deflections` (a reply that declines, with the analyst's question), `explanations` (causal sentences about
   asset quality, yields, cost of funds, balance-transfer attrition), `speakers` with roles, and
   `topics_without_candidates`. **These are candidates. You confirm each by reading it in context.**
3. Confirm or drop each candidate (`references/guidance-detection.md`):
   - Keep: forward-looking, by management, about the company, with a number or a direction.
   - Drop: a report on the past quarter ("AUM grew 18%"), an analyst's premise, industry commentary, a
     hypothetical ("if rates fall…") unless management commits to an outcome.
   - `speaker_role_unknown`: check the participants list before keeping.
   - `several_figures`: set `value_low` / `value_high` yourself for the figure that belongs to the topic, or
     split into one row per topic, each quoting its own clause.
   - `topic_ambiguous`: choose the topic from the taxonomy (`references/guidance-topics.json`; the script reads
     the same table at `/workspace/references/guidance-topics.json`). Use `subtopic` (`spread`, `nim`,
     `gnpa`, `cost_of_funds` …) when a topic carries more than one statement.
   - Read the pages around `topics_without_candidates` for guidance the keyword net missed; search the
     transcript text for the topic words.
4. **Quote, do not paraphrase** (`references/quoting-rules.md`). `statement` is management's words, 20 to 600
   characters, continuous, from one speaker, with the page where the sentence starts.
5. Write the rows to `/workspace/out/guidance.new.jsonl` with `change_vs_previous` left as your first
   reading, then fetch the history (`dataroom_fetch_to_sandbox` on
   `Customers/{customer_id}/filings/presentations/guidance.jsonl` to `/workspace/in/guidance.jsonl`) and run:
   `python3 /workspace/scripts/guidance_diff.py --current /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl`
6. Set `change_vs_previous` from the diff:
   | Diff says | You write |
   |---|---|
   | `maintained` / `raised` / `lowered` (basis `numeric`) | the same. "raised" means the **number** went up: for credit cost or cost-to-income say in the reply that a raised figure is a worse outlook |
   | `new` with a baseline quarter on file | `new` |
   | `new` with the warning "no baseline" | `new`, and say in the reply that there was no previous quarter on file |
   | `withdrawn` | Search the transcript for the topic. If management declined when asked, add a `withdrawn` row quoting the decline with speaker and page. If nobody raised it, add a `withdrawn` row with the fixed statement `No statement on this topic in the Q2 FY26 call.`, `speaker: null`, `page: null`, and a note |
   | `not_comparable` | Read both statements. If the meaning is plainly the same or plainly moved, write maintained / raised / lowered and explain in `note`. If it cannot be said, write `not_comparable` with a note. Never force a verdict |
   Fill `previous_period` and `previous_statement` on every row that claims a comparison.
7. **Unanswered questions.** From `deflections`, and from reading the Q&A: a question is unanswered when
   management declines, defers ("will come back to you"), answers a different question, or gives no number
   when asked for one. Report: analyst and firm, the question in short, management's words, page. These go
   in the reply, not in `guidance.jsonl` (unless the deflection withdraws earlier guidance).
8. **Explanations.** From `explanations` and your reading: what management said caused movements in asset
   quality, yields, cost of funds and balance-transfer attrition. Quote, with speaker and page.
9. Validate, with both checks on:
   `python3 /workspace/scripts/validate_guidance.py /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl --transcript /workspace/in/transcript.pdf`
   `--transcript` rejects any statement that is not word for word in the transcript.
10. Only after a clean validation: `dataroom_append_jsonl`, then `record_interaction` on the company (date,
    "Q2 FY26 earnings call", management participants from `speakers` with role `management`, a five-line summary).

## What to write

Rows per `/workspace/schemas/guidance-row.schema.json`: `customer_id`, `period`, `topic`, `statement`,
`speaker`, `page`, `change_vs_previous`, `extracted_at`, plus `subtopic`, `value_low`, `value_high`,
`value_unit`, `horizon`, `previous_period`, `previous_statement`, `note` where they apply.

## Worked example

Example Housing Finance Ltd, Q2 FY26 call. Candidates (abridged) and what became of them:

| Candidate sentence | Speaker, page | Verdict |
|---|---|---|
| "AUM grew 18% YoY to Rs. 12,345 crore during the quarter." | (not offered: no forward cue) | Not guidance |
| "For the full year we expect AUM growth of 20% to 22%." | Asha Rao, MD & CEO, p.3 | Keep: `aum_growth`, 20–22 percent, horizon FY26 |
| "We expect spreads to remain in the 3.2-3.4% band going forward." | Vikram Shah, CFO, p.4 | Keep: `spread_nim` / `spread` |
| "Credit cost should be 30 to 40 basis points for FY26 and disbursement growth should be north of 20% with cost to income of 38%." | Vikram Shah, p.4 | `several_figures`: split into three rows, each quoting its clause |
| "We would not like to comment on the timing of any capital raise at this point." | Asha Rao, p.9 | Deflection; Q1 had capital-raise guidance, so also a `withdrawn` row quoting this |

`guidance_diff.py` against Q1 FY26 (AUM growth 18–20%; spread 3.2–3.4%; credit cost "around 40 basis points";
capital raise "at an appropriate time"): `aum_growth` **raised** (18-20 then, 20-22 now), `spread_nim/spread`
**maintained**, `credit_cost` **lowered** (40-40 then, 30-40 now: the top of the band is the old point
estimate; say in the reply that a lowered credit cost is a better outlook), and
`capital_raise` **withdrawn**.

```json
{"customer_id":"example-hfl","period":"Q2FY26","topic":"aum_growth","statement":"For the full year we expect AUM growth of 20% to 22%.","speaker":"Asha Rao, MD & CEO","page":3,"change_vs_previous":"raised","extracted_at":"2025-11-12T09:00:00Z","value_low":20,"value_high":22,"value_unit":"percent","horizon":"FY26","previous_period":"Q1FY26","previous_statement":"We expect AUM growth of 18% to 20% for FY26."}
{"customer_id":"example-hfl","period":"Q2FY26","topic":"capital_raise","statement":"We would not like to comment on the timing of any capital raise at this point.","speaker":"Asha Rao, MD & CEO","page":9,"change_vs_previous":"withdrawn","extracted_at":"2025-11-12T09:00:00Z","previous_period":"Q1FY26","previous_statement":"We will look at a capital raise at an appropriate time.","note":"Asked by Rohan Mehta (Example Securities) for amount and timing; management declined."}
```

Guidance table in the reply:

| Topic | Q2 FY26 (quote, speaker, page) | Q1 FY26 | Change |
|---|---|---|---|
| AUM growth | "…AUM growth of 20% to 22%." Asha Rao, p.3 | 18% to 20% | **Raised** |
| Spread | "…3.2-3.4% band…" Vikram Shah, p.4 | 3.2–3.4% | Maintained |
| Capital raise | "We would not like to comment…" Asha Rao, p.9 | "at an appropriate time" | **Withdrawn** |

## Failure modes and what to report

| Situation | Do this |
|---|---|
| No `Name:` turns found (script warning) | Another layout (names on their own line, or a table). Read page by page; attribute only speakers you can see named |
| No Q&A marker found | Every non-moderator is treated as management: check each candidate's speaker against the participants list |
| No transcript, only an audio link | Do not transcribe. Say the transcript is not published |
| No guidance history on file | Every row is `new`; say there was no baseline. Do not reconstruct last quarter's guidance from memory or the web |
| The previous quarter on file is not the adjacent quarter | `--previous-period Q4FY25`; say which quarter you compared with |
| Management gives guidance in an interview or press release, not on the call | Out of scope for `guidance.jsonl`; mention it in the reply with the source |
| Validation fails | Report the errors. Do not append; do not reword a quote to make it pass |
