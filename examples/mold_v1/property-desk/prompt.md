Please make me a new app from mold_v1, called **Keyward**: the operations desk for a team that maintains residential
buildings.

## Who it is for

A property maintenance desk looking after a few dozen apartment buildings. Coordinators log defects, send them to the
right vendor, book visits and check the work; building managers own each building; an inspector walks every building
once a quarter and sends in a report. They chat with Keyward's assistant, keep each building's files in its folder,
and start the day with a list of what is urgent or late.

## How the desk is modelled

- **Buildings** are what everything hangs off (a "building", run by its "building manager", with a "deputy manager").
  The people are "coordinators".
- **Maintenance tickets**: one defect to fix at a building by its fix-by date. Each ticket has the defect, details and
  evidence, a fix-by date (required), the coordinator looking after it, a severity (urgent or high, normal, or low),
  where it is in the building, written the building's way (required when the ticket is logged), the trade (plumbing,
  electrical, heating, lifts, fire safety, joinery, roofing, cleaning or general), the vendor doing the work, the
  vendor's quote in US dollars, the day the visit is booked for, which inspection report and line it came from, and
  photos.
  A ticket moves through reported, with vendor, visit booked, waiting for access, fixed, verified and cancelled: send
  to vendor (from reported; it needs the vendor and the trade), book the visit (from with vendor; it needs the visit
  day), waiting for access (from with vendor or visit booked, with a reason), rebook (from waiting for access, with a
  visit day), mark fixed (from visit booked), verify (from fixed, and never by the ticket's own coordinator), and
  cancel (from anywhere, building managers and admins only, with a reason). Moves outside these rules go through but
  are noted. Tickets show as a table (defect, where, stage, severity, trade, vendor, fix-by, coordinator), a board by
  stage (cards with the place and fix-by, severity as the badge) and a timeline; the "Log a defect" form asks for the
  defect, where, fix-by, severity, trade, coordinator and details.
- **Inspection rounds**: each quarter is one round, 90 days long, holding the tickets due in it. Unfinished tickets
  roll over into the next round automatically, and each workspace may choose its own round length.
- **Service contracts**: a vendor's standing contract to cover one trade at one building, for months at a time; a
  building has several. Each has the vendor (required), the trade (required), a status (tendering, trial period,
  active, or suspended), its performance (green, yellow or red), the contract owner, the emergency response time in hours
  (1 to 72), the renewal date, the annual value in US dollars and the vendor's contact email. The list shows the
  building, vendor, trade, status, response time and renewal date. The assistant may read contracts but not change
  them.
- **Planned works**: a planned change carried out at a building (a boiler replacement, a roof repair), then watched
  for problems.
- The maintenance screen is called "Maintenance".

## Files

The data room is called "Building files". Each building has its folder (shown as "Buildings"), with an `inspections`
folder where inspection reports land and the defects read from them are kept. The people's folders, the planned works
and the service contracts stay; the platform, solutions and tickets folders are hidden.

## The inspection specialist

Keyward has one specialist of its own, **Inspection Intake** (it goes by "Clerk of Works"). It reads a building's
inspection report however it arrives (a checklist spreadsheet with a pass or fail per item, a written report with
numbered defects, or a photo log of lines like `IMG_0012.jpg - Flat 3B kitchen - water under sink`) and turns every
defect into a proposed ticket: where it is, what is wrong, how severe, when it is due, and whether an open ticket
already covers it. It keeps the defects, validated, in the building's `inspections` folder as a `defects.jsonl` file,
and files tickets only when a coordinator asks. Build it as a full workspace: a skill for each way a report arrives
(checklist spreadsheets, written reports, photo logs) and for naming places the building's way, severity and due dates,
already-open tickets, and validating and raising tickets; scripts that detect a report's format, parse it, name the places,
rate severity, find duplicates and validate the defects, each with a self-test; a JSON schema for the defects file; and
the desk's rules below, kept word for word as its rulebook.

The desk's rules:

1. An inspection report is the inspector's: never change what it says was found.
2. The building's open tickets win on whether something is already being fixed: a defect an open ticket covers is
   reported as a duplicate, never filed twice.
3. Flats are "Flat" and the number and letter in capitals (Flat 3B), whatever the report calls them.
4. Floors are L and a number: ground is L0, the first basement B1.
5. Common areas use only these names: Stair (letter), Lift (number), Roof, Plant room, Bin store, Car park, Lobby,
   Corridor (floor).
6. A place the building does not have, or one that cannot be named, is never guessed: the defect is listed with the
   reason and not filed.
7. Urgent, due one day after the inspection: gas, sparking or exposed wiring, no heat or hot water, water coming in, a
   ceiling down, a fire door that does not close or latch, a fire or smoke alarm fault, someone trapped in a lift, a
   broken ground-floor window.
8. High, three days: leaks, damp, mould, handrails, trip hazards, a lift out of service, door entry and intercoms,
   emergency lighting, security doors and gates, broken locks.
9. Normal, fourteen days: cracks, loose fittings, stains, paint, sealant, grout, blocked or slow drains, lights out.
10. Low, fifty-six days (the next quarterly round): cosmetic marks, scuffs, graffiti, weeds, signage.
11. The first rule that matches decides; nothing matched is Normal, and the reply says so.
12. Tickets are filed only when a coordinator asks, after validation, one per defect, due on the rule's date, with the
    report line and the photo in the ticket's details.
13. Urgent defects are named first in every reply, so someone can phone the contractor.
14. Leave out items the report marks as passed or not applicable, and anything about residents beyond the flat number.

Two points the desk has not settled, with what to do meanwhile: a report covering several buildings is read one
building at a time (other buildings' items are listed as not read); a defect found again after its ticket was closed
gets a new ticket that names the old one.

## What the assistant knows and does

The assistant is Keyward itself (not the base product's operations persona), calm and practical, urgent things first.
On every turn it is told: this workspace runs maintenance for residential buildings; buildings are the accounts;
tickets have a place, a trade, a fix-by date and a vendor; inspection rounds hold each quarter's tickets; service
contracts say which vendor covers which trade; urgent defects come first; never invent a vendor, a price or a place.
It sends inspection reports to Inspection Intake, uses a building's service contract to pick a vendor, and never
files tickets nobody asked for.

The empty chat suggests: "What is urgent today?", "Read the latest inspection", "Which tickets are overdue?" and "Who
covers plumbing here?", under the headings "Urgent tickets" and "Buildings with overdue tickets".

The base product's specialists that do not fit a maintenance desk are left out: customer context, data migration,
deployment, evals and research.

## Scheduled lists

Every new workspace starts with two apps, both written by Inspection Intake:

- **Urgent and overdue**, refreshed every weekday at 07:00 UTC: every open ticket that is urgent or past its fix-by
  date, by building, urgent ones first, with a count per building.
- **Contracts renewing**, refreshed every Monday at 08:00 UTC: service contracts renewing in the next 60 days, by
  building, with the vendor, trade, renewal date, annual value and how many of that vendor's tickets closed late this
  quarter.

Each is written the first time someone opens it. No other starter workflows are needed.

## Capabilities and models

No web search and no browser: Keyward never reaches outside the desk's own records. The models run on Workers AI, and
the microphone button uses the `@cf/openai/whisper-large-v3-turbo` speech model, so coordinators can dictate defects on
site. Several workspaces are allowed (another desk could have its own).

## Brand, workspace and where it runs

- Name Keyward, colour #15803D (a deep green), tagline "Maintenance tickets, inspections and vendors for residential
  buildings". The logo is a light house with a keyhole on a rounded green square:
  `examples/mold_v1/property-desk/logo.svg`.
- The first workspace is "Example Property Desk", owned by desk-manager@example.com, with coordinator@example.com and
  inspector@example.com in it.
- It runs on Vercel, at keyward.example.com.
