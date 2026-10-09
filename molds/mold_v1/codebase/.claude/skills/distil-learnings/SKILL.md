---
name: distil-learnings
description: Turn recorded coding sessions into runbooks a new joiner can follow, and share them so the team stops rediscovering the same things. Use when someone says "capture what we learned", "write this up", "why does everyone hit this", "onboard the new engineer faster", or after a painful incident. Uploads sessions (one or thousands) via the fde-control MCP, runs a server-side distillation job, and lands markdown runbooks in Learnings/runbooks/ with the best pointers in team memory. Sibling of onboard-self (a person) and backfill-* (history).
---

# Distil learnings into runbooks

The point is **compounding**: the second person to hit a problem should read a
runbook, not repeat the afternoon. A list of lessons does not achieve that —
"we learned that the OIDC token decides the project" helps only someone who
already knows what that means. A runbook does, because it starts from the
reader's situation.

## What a runbook is here

Five sections, in this order, because that is the order a stuck person needs
them:

| Section | Answers | Failure if vague |
|---|---|---|
| **When this applies** | "Is this even my problem?" | Reader skips a runbook that would have saved them |
| **How to tell** | "How do I confirm it?" | Reader applies the wrong fix confidently |
| **Do this** | "What exactly do I run?" | Reader has to re-derive it — the whole point is lost |
| **Verify** | "Did it work?" | Reader declares victory over a broken system |
| **Watch out for** | "What bit us?" | Reader falls into the same trap |

**"Do this" must contain commands, tool names and paths.** If a step reads
"check the configuration", it is not a runbook step. If it reads
``npx vercel env ls production --project agent-workspace-api``, it is.

## Procedure

### 1. Get the sessions in

One session:

```
session_upload  { transcript: "<contents of the .jsonl>", author: "quinn" }
```

Many — hundreds or thousands — in one call:

```
session_upload_batch  { sessions: [ { transcript, author, date }, … ] }
```

Use the batch tool for anything above a handful. It groups by author and day, so
the data room gains a few append-only files instead of one per session. That is
not tidiness: `dataroom_list` is a tool the *web* agents call on unrelated
questions, and a directory with thousands of entries makes every one of those
slower.

Transcripts are redacted before anything is stored. Do not pre-strip them
yourself — you will remove the context that makes a runbook specific.

### 2. Plan the job before paying for it

```
learning_distil  { since: "2026-07-01", focus: "deployment failures", dryRun: true }
```

`dryRun` executes the real job with the model stubbed: you see the phases and the
number of agent calls for zero tokens. Check it before the real run.

### 3. Run it

```
learning_distil  { since: "2026-07-01", focus: "deployment failures" }
```

It creates a **workflow** and runs it server-side, so it is durable, resumable
and visible in run history like every other automation — close your laptop if you
want. It writes each runbook as its own markdown file under
`Learnings/runbooks/`, appends an index row to
`Learnings/runbooks/index.jsonl`, and saves the two or three most broadly useful
as one-line pointers in **team-scoped memory**, which is what carries them to
teammates in other environments.

### 4. Read before you write more

```
learning_list  { contains: "deploy" }
```

Check the index first. A second runbook on the same trigger splits the guidance,
and the next reader finds whichever one they find.

## Continuing a session on the web

Terminal work does not have to end in the terminal:

```
session_continue_url  { path: "Learnings/sessions/{user}/2026-08-09.jsonl" }
```

That returns a link which opens a fresh chat already primed to read the recorded
session and carry on. Hand it to a teammate and they pick up your context
without you narrating it. The agent reads the real transcript from the data
room, so it is working from what happened rather than a summary.

## Judgement

- **A runbook is for a stranger.** If it only makes sense to someone who was
  there, it is a diary entry. Name the tool, the path, the flag.
- **Incidents are not learnings.** "The bill was unpaid on the 8th" is history.
  "Vercel disables the whole account, not one project, so check billing before
  debugging a 402" is a runbook.
- **Say what to do differently**, not what went wrong. The reader has the
  problem; they need the exit.
- **Nothing customer-confidential.** These are read by everyone in the
  workspace, including people who do not work on that account.
- **Prefer fewer, better.** Eight runbooks somebody follows beat forty nobody
  opens.
