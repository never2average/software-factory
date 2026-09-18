# How earnings-call transcripts are laid out

## Sections

| Part | How to recognise it | What it holds |
|---|---|---|
| Cover | Company name, "Earnings Conference Call", quarter, date; "Management:" list with designations; sometimes "Moderator:" and the host brokerage | Participants for `record_interaction`. `guidance_extract.py` ignores "Management:" as a speaker |
| Introduction | `Moderator:` welcomes, reads the safe-harbour statement, hands over | Nothing |
| Opening remarks | One to three long turns by the MD/CEO, CFO, sometimes business heads | The quarter's numbers (not guidance), then outlook: guidance is usually in the last third |
| Q&A | `Moderator:` "We will now begin the question-and-answer session. The first question is from the line of X from Y." | Short analyst turns, management replies. Most numeric guidance and all deflections are here |
| Closing | "That was the last question" / closing comments | Occasionally a summary of guidance |

## Speaker-turn formats

| Format | Handled by the script? |
|---|---|
| `Asha Rao: text…` | Yes |
| `Asha Rao – MD & CEO: text…` (designation after a dash or comma) | Yes; designation captured |
| `Moderator:` / `Operator:` | Yes (role moderator) |
| Name alone on a line in bold, text on the next line | No: the script warns "no speaker turns". Read manually |
| Two-column table (speaker, text) | Usually extracts as `Name text` without a colon: no. Read manually |
| "Management:" / "Analyst:" as generic labels | "Management" is ignored as a speaker name; attribute by reading |

## Roles

- Moderator: named Moderator / Operator / Coordinator.
- Analyst: anyone the moderator introduces with "question is from the line of **Name** from **Firm**".
- Management: anyone who speaks before the Q&A starts, other than the moderator.
- Unknown: spoke only in the Q&A and was never introduced (a business head answering one question). Check
  the cover list; if there, treat as management and say so.

## Page numbers

`page` is the 1-based PDF page where the quoted sentence **starts**. Transcripts filed with the exchange
often have a covering letter as page 1; the page you cite is still the PDF page.

## Worked example

```
Moderator: … The next question is from the line of Priya Nair from Example Asset Management. Please go ahead.
Priya Nair: Do you expect NIM to expand next year?
Sanjay Gupta: We will continue to maintain NIM at current levels next year.
```

`guidance_extract.py` offers Sanjay Gupta's sentence with `role: unknown`, flag `speaker_role_unknown`,
`direction: stable`, `in_reply_to: Priya Nair`. The cover lists "Sanjay Gupta, Chief Business Officer", so
the row is kept with `speaker: "Sanjay Gupta, Chief Business Officer"`.
