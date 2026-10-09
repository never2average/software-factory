---
name: mint
description: Take an application from a plain description to a tested, live product in one line of work. Use whenever someone wants a new app from a mold, asks where an app stands, or asks what is left to do.
---
# mint

```
python3 .claude/scripts/mint.py new <app_id> --brief briefs/<app_id>.md    # start
python3 .claude/scripts/mint.py <app_id>                                    # every station + THE ONE next thing (read-only)
python3 .claude/scripts/mint.py <app_id> run                                # do everything that needs nobody; stop where it needs the operator
python3 .claude/scripts/mint.py list                                        # every application and its next step
```

Stations, in order: brief, state, packs, brand, keys, deploy, workspaces, tests, package, address. `run` is safe to
repeat. Never drive the underlying scripts one by one unless a station failed and you are fixing it.

## Starting from a conversation

1. Write the person's description to `briefs/<app_id>.md`. Lines the line understands, each on its own line:
   `Product name:`, `Colour: #RRGGBB`, `Workspace:`, `Owner: <email>`, `Members: <emails>`, plus plain phrases such
   as "web search on, browser off".
2. `mint.py new …`. If it leaves `questions.json`, ask the operator only those, write `answers.json`, then `run`.
3. `mint.py <app_id> run`, and again after each thing the operator does, until it says finished.

## When a station says "needs you"

Exactly one thing at a time, asked the way AGENTS.md says. What each station needs:

- **keys**: first try `mint.py <app_id> reuse-keys <an app of theirs that already runs>`: it copies the operator's
  own service keys without showing them. Only for a key no app holds yet, the operator runs, at their own terminal,
  `python3 .claude/scripts/provision.py <app_id> --set-secret NAME` and types the value at the hidden prompt. You never
  type, paste or pipe a value yourself, and never write one into a file.
- **tests**: the signed-in checks need a person who can sign in. Ask them to say "send the code" and which email to
  use; only then `mint.py <app_id> code-request <email>`; they paste the six digits; `mint.py <app_id> code <digits> <email>`;
  then `run`.

## When a station fails

Read the report or log it names before doing anything else. A failed test lane marks the app `reverted` and files a
task: fix the cause (upstream if it is base code), then `run` redeploys and re-tests.
