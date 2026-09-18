# AGENTS.md

This repository is a software factory, not an application. Read `state/factory.json` first: it names the operator, the service surface, the molds and the service/revert loop.

Work is tasked: run `python3 .claude/scripts/factory.py next <mold_id>` to get the current task, and use the `task` skill to move it. Products and their stage gates are in `state/products.json`.

To stamp from a description: `intake` subagent (asks the user only unresolved questions, writes state) then `provisioner` subagent (checks secrets by name, deploys). Secret values never enter the repo or the chat.

Rules:
- Molds under `molds/<mold_id>/codebase` are general-purpose snapshots. Do not edit them in place, and do not fork one to stamp an application. Refresh from source per the mold's `MOLD.md`.
- An application's own code (subagents, a root-instructions section, shared sandbox helpers) is a pack under `packs/<pack_id>/`. The application's state names it, and `.claude/scripts/packs.py` applies it to `build/<app_id>/`. If a vertical needs a base-code change, that is a pull request to the mold's upstream, never a fork.
- Stamping an application means: copy `state/application/app_id/` to a real id, fill the four JSON files against their schemas, then run the five testing lanes in `molds/<mold_id>/testing/`. A failed lane sets the application to `reverted` and hands control back to the operator.
- Secrets are referenced by name only (`*_ref` fields). Values live in Vercel or the VM environment.
- Every command runs on the DigitalOcean VM. Shallow-clone external repos.
- Generic agent assets live under `.agents/`; Claude Code specific ones under `.claude/`.

## Asking the operator for something

The operator is not an engineer. Whenever a step needs them (a login only they hold, a value from a dashboard, a click in a console, a code from their inbox), ask the way a patient friend would:

- Open with what you need and why in one plain sentence each. No acronyms without the words behind them, no "devtools", "localStorage", "origin" or "env" unless you say what to click.
- Give the clicks as a numbered list, one action per line, starting from the web address they should open and naming the button or field exactly as the screen shows it. Put anything they must paste on its own line inside a code block.
- One thing at a time. If two things are needed, finish asking for the first before mentioning the second, and say how long each takes.
- Prefer the path with the fewest tools: an emailed code they paste into the chat beats a value copied out of the browser; a link beats a menu path.
- Say what happens next and reassure them about safety in one sentence: what is hidden, what is never stored, what expires.
- Never scold, never say "as I said". If they got stuck, ask what the screen shows and go from there.
