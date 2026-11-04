Please make me a new app from mold_v0, called **Wrenchline**: a work tracker for field-service maintenance teams.

## Who it is for

Small and mid-sized teams that keep equipment running at other people's buildings: heating and cooling plant, lifts,
generators, pumps and fire panels. A dispatcher logs incoming jobs, technicians go out and fix things, and a team lead
makes sure nothing sits past its deadline. People sign in and work in Wrenchline itself, and they connect their AI
assistant to it; nobody builds it into another product, so it is a tool, not something embedded.

## What it keeps

All of this belongs to each service team on its own; no team sees another team's records.

- **Sites.** A place the team services. Each site has an address (required), a region (north, south, east or west),
  the site contact's name and phone number, how the team gets in (open hours, escorted only, or out of hours only) and
  free-text access notes for keys, parking and ladders. Sites are what equipment and work orders hang off.
- **Equipment.** One serviced unit at a site. Each has its site (required), a category (heating and cooling, lift,
  generator, pump, fire panel or other; required), make, model, serial number, the date it was installed, the date it
  was last serviced, how often it should be serviced in days (between 7 and 730), and the maker's manual as an uploaded
  file.
- **Work orders.** A job to do. Each has a site and the piece of equipment, a priority (P1 urgent, P2 high, P3 normal or
  P4 planned; required), where it came from (email, phone, the preventive plan, or raised by a technician on site), the
  technician it is assigned to and their supervisor (both people in the team), who asked for it (an email address), the
  day it was reported, a long description, and the list of files that came with an emailed request.
  A work order moves through these states: new, assigned, on site, awaiting parts, completed, closed, or cancelled.
  The moves are: assign (from new); arrive on site (from assigned or awaiting parts); wait for parts (from on site);
  complete (from on site or awaiting parts); close (from completed, owners only); cancel (from new, assigned or awaiting
  parts, owners only); and reopen (from completed or closed, back to assigned). Everyone in the team can read work
  orders, members and owners can create, edit and move them, and only owners can delete one.
- **Visits.** One technician visit for a work order. Each has the work order (required), the technician (required),
  the day of the visit (required), hours on site (0 to 24), the outcome (fixed, temporary fix, needs parts, no access,
  or no fault found; required), the parts used, the technician's notes, any number of photos, and the name of the site
  contact who signed the work off.

## Deadlines and alerts

Every work order runs two clocks from the moment it is created, both set by its priority:

- **Respond by**, until a technician is on site: 4 hours for P1, 8 hours for P2, 24 hours for P3 and 72 hours for P4
  (24 hours if the priority is somehow missing). The clock stops once the work order is on site, awaiting parts,
  completed, closed or cancelled. Remind the assigned technician one hour before it is due; if it is missed by an
  hour, tell the owners.
- **Fix by**, until the job is done: 24 hours for P1, 72 hours for P2, 7 days for P3 and 30 days for P4 (7 days by
  default). It stops at completed, closed or cancelled, and it pauses while the work order is awaiting parts. Tell the
  technician and the owners when it is a day away; four hours after it is missed, hand the work order to its
  supervisor and tell the owners.

The technician is who each clock belongs to. Reminders show up in the app and also go out by email (so the due-date
emails are on, as well as the emails about access requests and about usage budgets).

## Email

A team can connect its own service-requests mailbox in Settings. Every new message there becomes a new work order:
the subject is its title, the sender's address is who asked, the time it arrived is the day reported, the message text
is the description (up to 6,000 characters), and its attachments are listed (at most 10, up to 10 MB each). Each one
starts as a P3 work order from email, with both clocks running. Only the inbox folder is read, nothing is moved or
deleted, and the first connection looks back three days. A team may also send Wrenchline's emails from its own
mail server instead of ours.

## The AI agents

- **Draft a visit report.** Started on one visit. The agent reads the visit, its work order, the equipment's history
  and the photos, and writes the customer-facing visit report as a markdown document: what was found, what was done,
  the parts used, what is still open, and the next recommended service date. It may spend at most US$2 a run and
  US$120 a month per team, up to 4 at once per team, and it is retried once if it fails. Its code is at
  https://git.example.com/agents/visit-report, commit 1111111111111111111111111111111111111111: it runs
  `node draft-visit-report.mjs --visit <the visit>`, checks its output with `node validate-report.mjs
  out/visit-report.md`, keeps the `out` folder, and has 15 minutes.
- **Plan preventive maintenance.** Runs every Monday at 05:00 UTC for each team (and owners can add their own times).
  It reads every piece of equipment, its last service date and interval, and writes the coming fortnight's preventive
  plan as a markdown document: what is due, grouped by site and region, in a sensible visit order. If the team has
  given it a building telemetry token, it may also read run hours and alarms from telemetry.example.com. At most US$4
  a run and US$60 a month per team, one at a time, no retry. Code at https://git.example.com/agents/preventive-plan,
  commit 2222222222222222222222222222222222222222: it runs `node plan.mjs`, checks with `node validate-plan.mjs
  out/preventive-plan.md`, keeps `out`, and has 20 minutes.

Both use Anthropic's models. The telemetry token is a team setting, write-only, entered in Settings and handed to the
agent only as `TELEMETRY_TOKEN`; it is optional.

In the app's own words, an agent run is a "draft" and a team is a "service team".

## Screens

- **Overview** first: the four headline numbers at the top (open work orders, work orders past their fix-by, median
  time to complete, first-time fix rate), then the getting-started steps (add a site, add its equipment, log a work
  order or connect the mailbox, draft the first visit report, connect your AI app) and charts of open work orders by
  priority, work orders opened and completed per week over 8 weeks, visit outcomes, and equipment by category.
- Under **Service**:
  - **Work orders**, a table with each record's detail, priority, state, site, technician and day reported as
    columns, plus the clocks. Main button: "New work order". When it is empty it says to log one or connect the
    mailbox.
  - **Visits**, a table (work order, technician, day, outcome, hours) whose four cards are visits per week,
    first-time fix rate, open work orders and work orders past their fix-by. Main button: "Log a visit".
  - **Visit reports**, the agent's finished reports. Main button: "Draft a visit report".
- Under **Assets**: **Sites** (button "Add a site"), **Equipment** (button "Add equipment") and **Preventive plans**,
  the schedules list (button "New plan schedule").

What the AI assistant is told: Wrenchline keeps a field-service team's sites, equipment, work orders and technician
visits; work orders carry two clocks, respond by and fix by, set by their priority; it should list what is overdue and
start a visit report on a visit when asked.

## Security and records of access

Keep the data access trail on, so a team's owners can see who read, changed or exported their records. The platform
request trail and signed checkpoints are not needed. Team members may make their own personal API keys. Runners
inside a customer's network are not needed: every agent run is hosted.

## Brand

Name Wrenchline, colour #C2410C (a deep orange), tagline "Work orders, visits and reports for field-service teams".
The logo is a light wrench on a rounded orange square: `examples/mold_v0/field-service/logo.svg`.

## Who runs it, where, and what it may spend

- It runs on Vercel, at wrenchline.example.com.
- The platform administrator is ops@example.com.
- Emails come from service@example.com.
- The company behind the terms and privacy pages is Example Field Services Ltd, contact legal@example.com, effective
  2026-11-04.
- Budgets: any one agent run may spend at most US$5, any one kind of run at most US$150 a month per team, with up to 4
  runs at once and 20 live per team.
- Agent runs use an Anthropic key, boat.dev sandboxes and the key vault's object storage for their workspaces.
