# Quoting rules

1. **Verbatim.** `statement` is copied from the transcript. `validate_guidance.py --transcript` checks it
   word for word (ignoring line breaks, runs of spaces and curly quotes).
2. **Continuous.** No "…" standing in for skipped words. If the guidance is spread over two sentences that
   are not adjacent, write two rows.
3. **One speaker.** Never merge the CEO's sentence with the CFO's.
4. **Length 20 to 600 characters.** Quote the clause that carries the guidance plus enough to stand alone
   (the subject and the horizon). A whole paragraph is not a quote.
5. **Transcript typos stay.** Do not correct "loose" to "lose" or fix a number you think is mistyped. If a
   figure in the transcript looks wrong (spread of "32%"), quote it as printed and say so in `note`; leave
   `value_low` / `value_high` empty.
6. **Speaker as printed**, with the designation from the cover when known: "Asha Rao, MD & CEO".
7. **Page** is where the quoted sentence starts.
8. **In the reply**, put quotes in quotation marks with speaker and page; keep your own view out. "Management
   sounded cautious" is a view; "'We would not like to comment on the timing' (Asha Rao, p.9)" is a fact.
9. **Withdrawn with no words said**: the fixed sentence `No statement on this topic in the Q2 FY26 call.`
   (with the call's period), `speaker: null`, `page: null`, and a `note`. It is the only non-quote allowed.
10. **Hindi or mixed-language passages**: quote as transcribed; do not translate inside `statement`. Put a
    translation in `note` only if you are sure of it.

## Worked example

Transcript, page 4: "On credit cost, see, last year was elevated. This year, credit cost should be 30 to 40
basis points for FY26 and disbursement growth should be north of 20% with cost to income of 38%."

Three rows, each a continuous clause from the same sentence:

| topic | statement |
|---|---|
| `credit_cost` | "credit cost should be 30 to 40 basis points for FY26" |
| `disbursement_growth` | "disbursement growth should be north of 20%" |
| `opex_cost_to_income` | "with cost to income of 38%" (26 characters: just enough to stand alone; `horizon` "FY26" goes in its own field, with a note that the horizon comes from the first clause of the same sentence) |
