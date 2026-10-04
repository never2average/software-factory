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
python3 .claude/scripts/mint.py <app_id> report                             # what it took: time and money
python3 .claude/scripts/mint.py <app_id> handoff                            # one page for the next person or agent
python3 .claude/scripts/mint.py list                                        # every application and its next step
```

Stations, in order: brief, state, packs, brand, keys, deploy, workspaces, tests, package, address. `run` is safe to
repeat at any time. For an application on a server of its own (`target: vm_remote`) the workspaces station also writes
the brief's own workspace and then the application's surface (default agent profile, subagent configs, workflow definitions
and scripts), on that server (`provision.py <app_id> --workspace-remote`); if it stops because the server
already has a workspace under another id, tell the user the two ids and ask which is right. The package, report and
handoff stations read that application's address from `vm_remote.production_url`. Never drive the underlying scripts one by one unless a station failed and you are fixing it.

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

## What it took

`mint.py <app_id> report` writes `reports/mint/<app_id>.md` (+ `.json`): calendar time to first deploy, agent working
time, operator messages, deploys, test runs, upstream pull requests, and money. Every figure is measured from a record
(the sessions' own cost counters, git, lane reports, the live app's run table) or says **not measured** and where to
look; the one estimate it carries is labelled. Run it when an app is finished and whenever the operator asks about cost.
The first app's figure includes building the factory; a later app's report is the marginal cost.

## Handing it on

`mint.py <app_id> handoff` writes `reports/mint/<app_id>.handoff.html` from state: where the app stands, what is inside
it, how people and agents get in, what was measured, open work, and the rules of the road, plus the same facts as JSON
for an agent (`<script id="handoff-data">`). It refuses to write a page that carries an email address or anything
shaped like a credential. Publish it with the Artifact tool: if `infrastructure.json` has `handoff_url`, read that
artifact and republish to the same `url`; otherwise publish new and record the link there. Regenerate and republish
whenever a station changes state, and tell the operator the page is private until they share it from its Share menu.
Another agent picking the work up reads the page (Artifact `read`), then starts from `mint.py <app_id>`.
