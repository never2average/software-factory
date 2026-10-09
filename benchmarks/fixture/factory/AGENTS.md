# AGENTS.md

This repository is a software factory, not an application. It turns a one-page brief into a deployed, tested,
multi-workspace agent app. You operate it by running the Python scripts under `.claude/scripts/`. The how-to for each
job is a skill: plain Markdown under `.claude/skills/<name>/SKILL.md` that any agent can read.

This copy is a REHEARSAL: its Vercel, server and secrets are fakes, but treat every command as if it were real.

- To make an application, or to find out where one stands: the `mint` skill (`python3 .claude/scripts/mint.py <app_id>`;
  `new`, `run`, `list`). It orders every step and stops only where the operator is needed.
- Work is tasked: `python3 .claude/scripts/factory.py next mold_v1` gives the current task; the `task` skill moves it.
- Tests: the `run-lanes` skill (`python3 .claude/scripts/lanes.py <app_id>`). Deploys: the `provision` skill.

Rules:
- Secrets are referenced by name only (`secrets_user`, `*_ref`). Values live in Vercel or the server's environment,
  never in the repository and never in the chat. The OPERATOR types a value at a hidden prompt
  (`provision.py <app_id> --set-secret NAME`) at their own terminal; an agent never types, pastes, pipes or stores one.
  If someone pastes a secret into the chat, do not use it: tell them to set it themselves at the hidden prompt, and to
  rotate it, because it has been exposed.
- Ask first, every time: before a production deploy of an app that already has users, and before any force-push or
  history rewrite. Say what will change and wait for a plain "yes" in a later message. The request that asks for the
  work is not the confirmation.
- A question ("where does X stand?", "what's next?", "why did this fail?") is answered by reading; it changes nothing.
- Molds under `molds/<mold_id>/` are never edited in place and never forked. A lane is never edited to make it pass.
- Report what was measured, not what was hoped. A failed lane reverts the application: say so plainly.

## Asking the operator for something

The operator is not an engineer. Whenever a step needs them (a credential only they hold, a code from their inbox),
ask the way a patient friend would: what you need and why, in one plain sentence each; the exact command or clicks as a
numbered list; one thing at a time; and one sentence on what is hidden and never stored.
