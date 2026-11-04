Please make me a new app from mold_v0, called **Panelwise**: a hiring pipeline for teams that run structured interview
panels.

## Who it is for

Hiring teams at growing companies: recruiters who keep candidates moving, hiring managers who own a role, and the
interviewers on each panel who owe feedback. They sign in to Panelwise and use it directly, and they connect their AI
assistant to it; it is not built into any other product, so it is a tool. Each hiring team's roles, candidates and
interviews are its own and invisible to every other team.

## What it keeps

- **Roles.** A position being hired for. Each role has a team (engineering, design, sales, operations or support;
  required), a location, the kind of employment (full time, part time or contract), the hiring manager (a person in the
  team), how many openings (1 to 50), a target start date, the must-haves a candidate has to show (the screening agent
  reads these), and the job description as an uploaded file. A role starts as a draft and can be opened, put on hold,
  marked filled or closed: opening, holding and closing are for owners; anyone can mark a role filled once it is open;
  a role on hold can be opened again.
- **Candidates.** One person applying for one role. Each has the role (required), the day they applied (required),
  where they came from (careers page, referral, agency or sourced), the recruiter looking after them (a person in the
  team), their CV and cover letter as uploaded files, a portfolio link, and notes. Three things about a candidate are
  private and stored encrypted: their **email** (members and owners may reveal it, and the team can look a candidate up
  by their exact email address), their **phone number** and their **salary expectation** (only owners may reveal
  those). Every reveal is written to the access trail.
  A candidate moves through the stages applied, screening, interviewing, offer, hired, rejected and withdrew: screen
  (from applied), invite to interview (from screening), make an offer (from interviewing, owners only), hired (from
  offer), reject or withdrew (from any open stage), and reconsider (from rejected or withdrew back to screening, owners
  only). Members, billing staff and owners can read candidates (viewers cannot); members and owners can add, edit and
  move them; only owners can delete one.
- **Interviews.** One interview with one candidate. Each has the candidate (required), the kind (phone screen, skills,
  panel, values or final; required), the day it is scheduled for (required), the interviewer (required), a score from
  1 to 5, a recommendation (strong yes, yes, no or strong no), the interview notes, and the scorecard as an uploaded
  file. An interview is scheduled, then done, cancelled or a no-show.

## Deadlines and alerts

All deadlines count working days (Monday to Friday).

- **Reply by:** every new candidate gets a reply within 5 working days of being added, and the clock stops as soon as
  they move on from applied. The recruiter is reminded a working day before; a working day after it is missed, the
  owners are told.
- **Decide by:** once a candidate enters interviewing, the team decides within 10 working days, stopped by an offer, a
  hire, a rejection or a withdrawal. The recruiter and the owners are reminded two working days before; two working days
  late, the owners are told.
- **Feedback by:** an interviewer owes a recommendation within 2 working days of the interview day; the clock stops
  when a recommendation is entered. The interviewer is reminded a day before; a day late, the owners are told.

Reminders appear in the app and go out by email (the due-date emails and access-request emails are on; usage-budget
emails are not needed). A hiring team may send these emails from its own mail server.

## The AI agents

All three use Anthropic's models, keep their `out` folder, and write a markdown document. In the app, an agent run is
called a "brief", and a team is a "hiring team".

- **Screen a CV**, started on one candidate. It reads the CV and cover letter against the role's must-haves and writes
  a screening note: each must-have met, partly met or not shown, quoting the line of the CV that shows it, and
  questions for the phone screen. It judges only against the role's must-haves. At most US$1 a run, US$80 a month per
  team, 4 at once, retried once, 10 minutes. Code: https://git.example.com/agents/cv-screen at commit
  3333333333333333333333333333333333333333; runs `node screen.mjs --candidate <the candidate>`, checked by
  `node validate-note.mjs out/screening-note.md`.
- **Summarise interviews**, started on one candidate. It reads every finished interview (notes, scores,
  recommendations, scorecards) and writes the panel summary: strengths and concerns with who raised each, where
  interviewers disagree, the recommendations tallied, and what is still unknown. At most US$2 a run, US$100 a month,
  4 at once, retried once, 15 minutes. Code: https://git.example.com/agents/panel-summary at commit
  4444444444444444444444444444444444444444; runs `node summarise.mjs --candidate <the candidate>`, checked by
  `node validate-summary.mjs out/panel-summary.md`.
- **Weekly pipeline digest**, every Monday at 07:00 UTC for each team (owners can add other times). Per open role:
  candidates at each stage, who moved, interviews waiting for feedback, candidates past their reply-by or decide-by,
  and roles with nobody interviewing. At most US$2 a run, US$20 a month, one at a time, no retry, 10 minutes. Code:
  https://git.example.com/agents/pipeline-digest at commit 5555555555555555555555555555555555555555; runs
  `node digest.mjs`, checked by `node validate-digest.mjs out/pipeline-digest.md`.

## Screens

- **Overview**: the four headline numbers (active candidates, candidates past their reply-by, median days to hire, and
  the share of interviewed candidates who got an offer), the getting-started steps (add a role, add a candidate with
  their CV, screen a CV, schedule an interview, connect your AI app), and charts of candidates by stage, applied and
  hired per week over 8 weeks, and where candidates come from.
- Under **Hiring**:
  - **Candidates**: a table (role, stage, source, recruiter, applied) with each candidate's detail and clocks. Main
    button: "Add a candidate".
  - **Interviews**: a table (candidate, kind, day, interviewer, state, recommendation) whose four cards are interviews
    per week, late feedback, the average score and active candidates. Main button: "Schedule an interview".
  - **Roles**: main button "Add a role".
- Under **Agents**: **Briefs**, the agents' finished documents, with the main button "Write a brief" offering Screen a
  CV or Summarise interviews; and **Digests**, the schedules list, with "New digest schedule".

What the AI assistant is told: Panelwise keeps a hiring team's roles, candidates and interviews; a candidate's email,
phone and salary expectation are encrypted, so reveal them only when needed; list what is waiting for a reply, a
decision or feedback; start a screening or a summary on a candidate when asked.

## Security and records of access

Turn on both trails: the data access trail (who read, revealed, changed or exported candidate records) and the platform
request trail (every API and AI-assistant request and every sign-in). Signed checkpoints are not needed. People connect
their AI assistant by signing in; no personal API keys. Every agent run is hosted; nothing runs inside a customer's
network.

## Brand

Name Panelwise, colour #4338CA (indigo), tagline "Roles, candidates and interview panels in one place". The logo is
three light figures, a small panel, on a rounded indigo square: `examples/mold_v0/hiring-pipeline/logo.svg`.

## Who runs it, where, and what it may spend

- It runs on Vercel, at panelwise.example.com.
- The platform administrators are people-ops@example.com and anyone at admins.example.com.
- Emails come from hiring@example.com.
- The company behind the terms and privacy pages is Example Talent Ltd, contact legal@example.com, effective
  2026-11-04.
- Budgets: any one agent run at most US$3, any one kind of run at most US$100 a month per team, up to 4 runs at once
  and 20 live per team.
- Agent runs use an Anthropic key, boat.dev sandboxes and the key vault's object storage.
