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

Before the first app on a machine, the mold's codebase must be there: if `molds/<mold_id>/codebase` is missing, fetch it first (the `mold` skill, `python3 .claude/scripts/mold.py fetch <mold_id>`).

Stations, in order: brief, state, packs, brand, keys, deploy, workspaces, tests, package, address. `run` is safe to
repeat at any time. Never drive the underlying scripts one by one unless a station failed and you are fixing it.

**The workspaces station creates the application's first workspace.** Right after the first deploy, `run` writes the
application's own workspace (`application.json` `workspace.org`) into the app, with the operator
(`state/factory.local.json` `defaults.operator_email`) as its owner and the people state names beside them; then every
seed under `seed/orgs/`. It shows `done: workspace <id>, owner <email>`. This is a write to the app's own new database,
and it is part of the deploy the operator already said yes to: a deployed app with no workspace can email nobody a
sign-in code, so the deploy is not usable without it. It is safe to repeat: the station looks at the app first
(read-only, as the app's own role) and writes nothing that is already there. On Vercel it goes through `workspace.py`;
on a server of its own (`target: vm_remote`) through `provision.py <app_id> --workspace-remote`, which also writes the
application's surface (default agent profile, subagent configs, workflow definitions and scripts).

- If it says the operator's email address is not known (exit 3), ask the operator which address they sign in with,
  put it in `state/factory.local.json` as `defaults.operator_email`, and `run` again.
- If it stops because the app already has a workspace under another id, tell the user the two ids and ask which is right.
- If another station stands in front of it (a redeploy that wants a sign-in nobody can get yet):
  `mint.py <app_id> run --only workspaces` writes just the application's own workspace.

The package, report and handoff stations read a `vm_remote` application's address from `vm_remote.production_url`.

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
  'Continue with Google' works only at an address Google has been told about by hand, and a new app's is not, so
  `reuse-keys` also makes the app the keys came from the new app's **sign-in hub** when that app's own Google
  sign-in works (state only: the new app takes it up at its first deploy, the other app at ITS next deploy, which
  is a live app's deploy and needs its own yes). Emailed codes work without any of it. Every deploy's result says
  where Google sign-in stands (directly, through the hub, or NOT working with the steps):
  `provision.py <app_id> --google-signin`.
- **tests** — the signed-in checks need a person who can sign in. Ask them to say "send the code"; then
  `mint.py <app_id> code-request <email>`, they paste the six digits, `mint.py <app_id> code <digits> <email>`,
  then `run`. The session lives in `~/.cache/software-factory/`, never in the repo or the chat.
  **Believe what `code-request` prints, and repeat it to the operator as it is.** The app emails a code only to an
  address that belongs to one of its workspaces or holds an invite, and it gives every address the same answer, so
  `code-request` looks in the app's database first:
  - "belongs to no workspace … Nothing was sent" (exit 1): no email is coming. Do the next step it names (create the
    workspace, or have them invited), then ask again. Never tell the operator to wait for a code after this.
  - "a six-digit code is on its way": the address was seen to be a member; tell them to look for it.
  - "a code was requested … could not be checked": say exactly that, that it arrives only if the address is a member.
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
