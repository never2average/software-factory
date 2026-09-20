---
name: mint
description: Take an application from a plain description to a tested, live product in one line of work. Use whenever someone wants a new app from a mold, asks where an app stands, or asks what is left to do. This replaces driving intake, packs, branding, provision, workspace, lanes, agent_cli and domain by hand.
---
# mint

One command orders the whole line and knows, by looking, where an application stands:

```
python3 .claude/scripts/mint.py new <app_id> --brief briefs/<app_id>.md    # start
python3 .claude/scripts/mint.py <app_id>                                    # every station + THE ONE next thing
python3 .claude/scripts/mint.py <app_id> run                                # do everything that needs nobody; stop where it needs the operator
python3 .claude/scripts/mint.py list                                        # every application and its next step
```

Stations, in order: brief, state, packs, brand, keys, deploy, workspaces, tests, package, address. `run` is safe to
repeat at any time. Never drive the underlying scripts one by one unless a station failed and you are fixing it.

## Starting from a conversation

1. Ask the person to describe the product in their own words. Write it to `briefs/<app_id>.md` yourself. Lines the
   line understands, each on its own line: `Product name:`, `Colour: #RRGGBB`, `Logo: brands/<x>/logo.png`,
   `Workspace:`, `Owner: <email>`, `Members: <emails>`, `Packs: <pack_id>`, `Domain:`, plus plain phrases such as
   "web search on, browser off". A brief that names its product creates the product; nobody has to know product ids.
2. `mint.py new …`. If it leaves `questions.json`, the `intake` subagent asks only those.
3. If the product needs its own specialists, fields or wording, that is a pack (`subagent` skill), named in the
   brief. Build it before `run`. Anything the base cannot do is a pull request upstream, never a fork.
4. `mint.py <app_id> run`, and again after each thing the operator does, until it says finished.

## When a station says "needs you"

Exactly one thing at a time, asked the way AGENTS.md says (what and why in a sentence each, numbered clicks from a
web address, one paste per code block, what is hidden). What each station needs:

- **keys** — first try `mint.py <app_id> reuse-keys <an app of theirs that already runs>`: it copies the operator's
  own service keys in memory and derives the sender address, so a second app asks for nothing. Only for a key no
  app holds yet: `provision.py <app_id> --set-secret NAME` (hidden prompt; or the Vercel form it points to).
  'Continue with Google' additionally needs the new address added to that Google client's Authorised JavaScript
  origins; emailed codes work without it.
- **tests** — the signed-in checks need a person who can sign in. Ask them to say "send the code"; then
  `mint.py <app_id> code-request <email>`, they paste the six digits, `mint.py <app_id> code <digits> <email>`,
  then `run`. The session lives in `~/.cache/software-factory/`, never in the repo or the chat.
- **package** — the operator runs `npm login` on this machine once (it prints a link). Never publish without them.
- **address** — `domain.py <app_id> attach <domain>` prints the one DNS record for the domain's owner.

## When a station fails

Read the report or message it names before doing anything else, and before writing any commit message. A failed test
lane marks the app `reverted` and files a task: fix the cause (upstream if it is base code), then `run` redeploys
and re-tests. Report what was measured, not what was hoped.
