Please make me a new app from mold_v1, called **Inkboard**: the story calendar and morning briefing for a newsroom's
desks.

## Who it is for

A newsroom of a few dozen journalists split into desks (Metro, Culture, Science, Sport and so on). Desk editors plan
the day's stories, reporters file copy against deadlines, and sub-editors check it before it is published. They chat
with Inkboard's assistant, keep each desk's files in its folder, and read a briefing every morning before conference.

## How the newsroom is modelled

- **Desks** are what everything hangs off (in the app's words: a "desk", led by its "desk editor", with a "deputy
  editor"). The people are "journalists".
- **Assignments** are the stories: one story a reporter owes by its copy deadline. Each assignment has a working title,
  a brief, a copy deadline (required), the reporter, a news value (lead, standard, or if space), a slug in lower case
  with hyphens (like `bridge-vote`), a kind (news, feature, analysis, live blog, photo or video), a word count (0 to
  20,000), an embargo time if it has one, and whether it needs a legal read.
  An assignment moves through pitched, assigned, filed, subbed, published, and spiked: assign it (from pitched; it
  needs a reporter), file copy (from assigned), sub it (from filed, and never by the story's own reporter), publish it
  (from subbed), and spike it (from anywhere, desk editors and admins only, with a reason). Moves outside these rules
  go through but are noted. On screen, assignments show as a board by stage (cards with the deadline and reporter, and
  the news value as the badge), a table (title, stage, slug, kind, news value, edition, deadline, reporter) and a
  timeline; the "Add assignment" form asks for the title, slug, deadline, reporter, kind, news value and brief.
- **Editions**: each day is one edition holding the assignments due in it. An edition lasts one day, unfinished
  assignments roll over to the next edition automatically, and workspaces cannot change the length.
- **Corrections**: a correction or update put into a published story, and whether it has landed everywhere the story
  ran.
- The planning screen is called "Calendar".

## Files

The data room is called "Newsroom files". Each desk has its folder (shown as "Desks"), with a `briefings` folder where
the desk drops its planning-sheet exports, calendar feeds and wire budgets, and where the briefings are written. The
people's folders stay, and so do the corrections. The other folders (platform, solutions, projects, tickets) are
hidden.

## The briefing specialist

Inkboard has one specialist of its own, **Story Briefing** (it goes by "Copy Chief"). It writes a desk's briefing from
its calendar and from whatever the desk dropped in its briefings folder: a planning-sheet export (CSV, comma,
semicolon or tab separated), a calendar feed (.ics) or the wire budget (lines like `BRIDGE-VOTE -- 600w -- Council
votes -- moving 1700 UTC`). It writes the briefing as a markdown document in the desk's briefings folder and keeps
every briefing line, validated, in a `briefing-items.jsonl` file beside it. Build it as a full workspace: a skill for
each way the calendar arrives (planning-sheet exports, calendar feeds, wire budget lines) and for embargoes and time
zones, unassigned stories and empty slots, at-risk assignments, and validating and publishing; scripts that detect a
file's format, parse it, work out deadlines and embargoes, validate the briefing lines and render the briefing, each
with a self-test; a JSON schema for each file it writes; and the editors' rules below, kept word for word as its
rulebook.

The editors' rules for a briefing:

1. One briefing per desk per edition day, written before the morning conference and again on request.
2. Five sections, always in this order and always present (an empty one says "Nothing."): Due today, Embargoed,
   Unassigned, At risk, Published since the last briefing.
3. Every line names the slug, the working title, who has it (or "nobody yet"), the time that matters, and where the
   line came from.
4. The calendar's assignments win over every export. Exports only add stories the calendar does not have; when they
   disagree on a deadline or a reporter, the calendar's value is used and the disagreement goes under At risk.
5. A wire story is never a commitment: it is Unassigned until a desk editor assigns it.
6. Every time carries its zone. A time without one is read in the desk's zone (UTC unless the desk says otherwise) and
   marked "(zone assumed)".
7. A deadline that is a day with no time is due at the edition cut-off, 17:00.
8. "Due now" means within 60 minutes; a past deadline for a story not yet filed is At risk.
9. A story under an embargo that has not lifted is listed under Embargoed with its lift time, never under Due today.
10. An embargo with no time goes under At risk: "embargo time missing".
11. At risk means: past its deadline and not filed; due within two hours with no reporter; a reporter with three or
    more stories due the same day; a calendar and export disagreement; an embargo with no time. Each says why.
12. Leave out spiked stories and stories published before the last briefing.
13. Say nothing about a person beyond the name or address the calendar gives.

Two points the editors have not settled, with what to do meanwhile: a planning sheet that covers several desks gives one
briefing per desk (the other desks' rows are skipped and counted); weekend editions are covered by the Friday briefing.

## What the assistant knows and does

The assistant is Inkboard itself (not the base product's operations persona), brisk and factual. On every turn it is
told: this workspace is a newsroom, desks are the accounts, assignments are stories with copy deadlines and reporters,
each edition holds the assignments due for it, every time it states carries its zone, and an embargoed story is never
described as publishable before its embargo lifts. It sends briefings and "what is at risk" questions to Story
Briefing, changes assignments only when someone asks, and never reassigns a reporter on its own.

The empty chat suggests: "What is due today?", "Write the Metro briefing", "What is nobody covering?" and "Which stories
are at risk?", under the headings "Due within the hour" and "Quiet desks".

The base product's specialists that do not fit a newsroom are left out: customer context, data migration, deployment,
evals and research.

## Scheduled briefings

Every new workspace starts with two apps, both written by Story Briefing:

- **Morning briefing**, refreshed every weekday at 06:00 UTC: every desk with assignments due today or tomorrow, one
  section per desk, by the editors' rules, every line cited.
- **Weekend planner**, refreshed on Fridays at 14:00 UTC: every assignment due Saturday or Sunday, by desk, with its
  reporter or nobody, its deadline with its zone, and anything at risk.

Each is written the first time someone opens it. No other starter workflows are needed.

## Capabilities and models

No web search and no browser: Inkboard never reaches outside the newsroom's own records. The models run on Workers AI,
and the microphone button uses the `@cf/openai/whisper-large-v3-turbo` speech model. Several workspaces are allowed
(another newsroom could have its own).

## Brand, workspace and where it runs

- Name Inkboard, colour #9F1239 (a deep newsprint red), tagline "The story calendar and morning briefing for newsroom
  desks". The logo is a small calendar page with lines of copy, light on a rounded red square:
  `examples/mold_v1/newsroom-calendar/logo.svg`.
- The first workspace is "Example Newsroom", owned by managing-editor@example.com, with metro-editor@example.com,
  culture-editor@example.com and reporter@example.com in it.
- It runs on Vercel, at inkboard.example.com.
