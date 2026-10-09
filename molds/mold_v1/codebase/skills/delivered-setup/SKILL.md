---
name: delivered-setup
description: Set up a Delivered workspace end to end — verify the workspace MCP wiring, choose and install a vertical data room, connect the first source, and onboard the first {account}. Use when someone is invited to a Delivered workspace, says "set up my Delivered workspace", "finish the Delivered setup checks", "run the Delivered onboarding", or when the workspace MCP tools return 401 / are not wired yet.
---

# Set up a Delivered workspace

Take a freshly created Delivered workspace to **ready**: every setup check green,
without asking the operator to drive.

## Working style — scout, ask once, then run unattended

**One bounded approval up front, then no interruptions.**

This replaced a pasted prompt that gated every step behind a confirmation. But
"proceed by default" alone is not right either: this runs against a live
platform, on someone's own machine, touching their files and credentials. They
should see the full scope before anything happens — once — and then be free to
walk away.

So the shape is:

1. **Scout** (§0). Read-only. Find out what is already true.
2. **Ask once** (§1). One consolidated list of everything you need, scoped.
3. **Run** (§2 onwards). Unattended, to completion, then report.

Do NOT drip-feed approvals. Ten small asks spread across a run is the pattern
this exists to kill: it is more interruption than a single clear one, and it is
*less* informative, because the operator never sees the whole scope at any
point — only the next step.

After the approval, stop only if:

1. **Authentication fails.** Nothing works until it is fixed.
2. **Something outside the approved scope turns out to be needed.** The
   approval was for a specific list; exceeding it silently is the one thing
   that makes a bounded approval worthless.
3. **A step fails twice.** Report the error; do not loop.

Never echo a token, secret, or credential back into the chat, and never write
one into a file that gets committed. When you need one, name it and say where
it should go — do not ask them to paste it to you.

Everything writes to the **live** platform — the same data room and Ops API as
the web console. There is no sandbox and no undo.

## 0. Scout — read-only, change nothing

Before asking for anything, find out what is already true. Every one of these
is a read:

- **Which agent and config.** Which coding agent is running, and where its MCP
  config lives (`~/.claude.json` / `.mcp.json`, `~/.cursor/mcp.json`,
  `.vscode/mcp.json` keyed on `servers`, `~/.codex/config.toml` in TOML).
- **Is the workspace MCP wired?** Call `connector_list`. A list — *including an empty one* —
  is a PASS. 401 or "not signed in" means the session is missing; the tool not
  existing at all means the server is not configured.
- **What already exists.** `connector_list`, `customer_list`, `workflow_list`
  and `dataroom_list`, so you do not propose creating what is already there.
- **What you would need from them.** Which credential for the first connector,
  which files or repositories you would have to read.

Report what you found in a few lines. Then, and only then, ask.

## 1. Ask once — one bounded list

Present a single request covering the whole run. It must state:

- **What you will do**, step by step, in the order you will do it.
- **What you will touch** — which config files, which credentials, which parts
  of the data room. Name them.
- **What you will NOT touch**, where that is reassuring and true.
- **What you need from them** — the specific credential(s), by name, and where
  they should put them. Never ask them to paste a secret into the chat.

If the session is not authenticated, this list starts with the sign-in step
that `workspace_status` reports and stops there: nothing else can proceed, so asking
for the rest is noise. Connected to the workspace's own address (`…/api/mcp`),
that is a fresh access token (the emailed-code sign-in in the invite, step 2) in
the MCP config's `Authorization` header; through the npm package it is
`npx @delivery-agents/cli login`. Never guess an address: the package needs
`WORKSPACE_OPS_URL` set to the workspace's own address and has no default.

Once they approve, run to the end without checking back.

## 2. Seed the data room

```
dataroom_structure          # the canonical layout this workspace expects
dataroom_list               # what already exists — do not recreate it
```

Write the skeleton with `dataroom_write` for anything genuinely missing. It is
additive: never overwrite a path that already has content (that is case 2 of
the approval — it needs their say-so).

## 3. Connect the first source

Connect one source and store its secret.

A connector with no stored secret is not usable, so do not treat the step as done
until the secret is stored. If no credential is available, say exactly which one
you need and stop — this is case 2 (you cannot invent a credential).

## 4. Onboard the first {account}

Create the first {account} and its data-room skeleton. If the operator
named one, use it. If not, and a {account} is discoverable from the roster or an
existing connector, use that and say so. Otherwise ask for a name — one question,
not a questionnaire.

## Done

The workspace is ready when every setup check is green:

| Check | Green when |
|---|---|
| Members | an owner and at least one admin |
| Roster | imported from Directory or CSV |
| Connector | one connector **with** a stored secret |
| Workflows | the library is seeded |
| Data room | the skeleton is written |
| {Account} | one {account} onboarded |

Finish by **reporting the checks that are still outstanding**, not by declaring
success. "Done" with three checks red is the failure mode this skill exists to
prevent. The operator can see the same list at `/onboard?step=checks`.

## When something fails

| Symptom | Meaning | Do |
|---|---|---|
| 401 on any call | token expired (7 days for an emailed-code token) | Ask the person for a fresh token (invite step 2) and update the `Authorization` header; with the npm package, re-run `npx @delivery-agents/cli login` |
| Permission denied on a write | acting against a workspace they are not a member of | Report which workspace you targeted; do not retry |
| A tool times out | the write may have landed | Read current state BEFORE retrying |
| Empty list from a read | usually a legitimately empty workspace | Not an error — continue |
