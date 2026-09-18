# Search queries and where documents usually sit

Replace `<company>` with the legal name and the common short name; try both. Replace `<Qn FYyy>` with the
quarter in the three common spellings: `Q2 FY26`, `Q2FY26`, `Q2 FY2025-26`. Add the calendar hint
(`September 2025 quarter`) when the fiscal spelling finds nothing.

## Investor presentation

| Order | Query pattern | What you expect to find |
|---|---|---|
| 1 | `<company> investor presentation <Qn FYyy> site:bseindia.com` | Announcement with the deck attached, category like "Investor Presentation" or "Analyst / Investor Meet" |
| 1 | `<company> investor presentation <Qn FYyy> site:nseindia.com` or `site:nsearchives.nseindia.com` | The same disclosure on NSE |
| 1 | `<company> "Regulation 30" presentation <Qn FYyy>` | Covering letter text is often indexed |
| 2 | `<company> investor relations presentation <Qn FYyy>` | The IR page, by year and quarter |
| 2 | `<company> earnings presentation filetype:pdf <Qn FYyy>` | A direct PDF on the company's domain |
| 3 | `<parent> investor presentation <Qn FYyy>` | For a subsidiary: the parent's deck (see `parent-deck-for-unlisted-hfc`) |

## Transcript

| Order | Query pattern | Note |
|---|---|---|
| 1 | `<company> transcript earnings call <Qn FYyy> site:bseindia.com` | Filed some days after the call |
| 1 | `<company> "transcript" "conference call" <Qn FYyy>` | |
| 2 | `<company> investor relations earnings call transcript <Qn FYyy>` | IR page; sometimes under "Financial results" |
| 3 | `<parent> earnings call transcript <Qn FYyy>` | The parent's call covers the subsidiary in a few paragraphs |

## Reading the announcement list

- The first intimation is usually the **schedule** of the call (date, dial-in). It is not the deck.
- The deck is usually sent on the results day, shortly before or after the results.
- An **audio/video recording link** is usually sent within a day of the call. It is not a transcript.
- The **transcript** follows later. If only the recording exists, say so; do not transcribe it.

If a site's layout, category names or regulation references differ from the above, trust what is on the
page in front of you and mention the difference in your reply.
