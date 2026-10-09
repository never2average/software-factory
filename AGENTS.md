# AGENTS.md

Instructions for any coding agent working in this repository, on any machine.

## What this is

A software factory, not an application. It turns a one-page brief into a tested, deployed web app: it stamps the app from a general-purpose base codebase (a **mold**), adds the app's own code (a **pack**), brands it, deploys it to Vercel or a server, proves workspace isolation, and runs five testing lanes. You operate it by running its Python scripts (standard library only) and following its skills. State is JSON under `state/`.

## Start here

1. If `AGENTS.local.md` exists next to this file, read it. It holds this machine's and this operator's own rules (git-ignored, never committed) and wins over this file where they differ.
2. `python3 .claude/scripts/factory.py doctor`: checks the machine (tools, sign-ins, mold on disk). Fix or report what it names before anything else.
3. Read state: `state/factory.json` (operator, molds, defaults), `state/products.json` (products and stage gates), `python3 .claude/scripts/mint.py list --json` (every app and its next step).
4. Then do what was asked, using the map below.

## Skills: how each job is done

Every job has a skill: plain Markdown at `.agents/skills/<name>/SKILL.md`. `.claude/skills` and `.kiro/skills` are links to the same folder. If your tool loads skills, use them; if it does not, open the SKILL.md for the job and follow it. Specialist subagents are in `.agents/agents/<name>.md`; without subagent support, follow that file yourself.

Scripts are in `.claude/scripts/` (`.agents/scripts/` is a mirror). Run them from the repository root as written in the skills.

| The person asks | Open | Runs |
|---|---|---|
| "Make an app from this brief", "mint X" | `mint` | `mint.py new <app> --brief briefs/<app>.md`, then `mint.py <app> run` |
| "Where does X stand?", "what's left?" | `mint` | `mint.py <app> --json`, `mint.py list --json` |
| "What's next on the backlog?", log or close work | `task` | `factory.py next <mold_id>`, `factory.py add`, `factory.py close` |
| "Can X deploy?", "deploy X" | `provision` | `provision.py <app>` (check), `provision.py <app> --deploy` |
| "Run the tests on X" | `run-lanes` | `lanes.py <app> --list`, `lanes.py <app>` |
| "Is the server big enough?" | `provision` | `provision.py <app> --capacity` |
| "Give X its own web address" | `provision` | `domain.py <app> status`, `attach <domain>` |
| "Fetch / check / refresh the mold" | `mold` | `mold.py fetch\|check\|refresh <mold_id>` |
| "Give X its own repository" (only when asked) | `repo` | `repo.py <app> status`, `publish --provider github\|gitlab --dry-run` |
| "Turn this description into app state" | `intake` | `intake.py <brief> --app <app>` |
| "Build a specialist agent for this product" | `subagent` | `packs.py check <pack>`, `packs.py verify <app>` |
| "Ship / release this product" | `productize` | `factory.py status` |
| "Clone the live deployment" | `clone` | `clone.py <app> plan` |

`stamp` is superseded by `mint`. Never drive the scripts under `mint` one by one unless a station failed and you are fixing it.

## Script protocol

- `--json` (on `mint.py`, `provision.py`, `lanes.py`) prints one machine-readable result. Prefer it; read logs only when something failed.
- Exit codes: `0` done, `1` failed (read the message and the report it names before doing anything else), `2` could not run (bad input or missing state), **`3` a human is needed**.
- **Exit 3:** stop. The JSON output has `"status": "needs_human"`, and its `needs` list says what is needed (a credential, a sign-in code, a DNS record, a click, a yes). Ask the person for exactly that one thing, as described in "Asking the operator", and wait. Never guess, fake or work around it.
- **Long steps run in the background.** A deploy takes about 10 minutes and the lanes about 30, longer than most agents' command time limits. Start them with `--background` (`provision.py <app> --deploy --background`, `lanes.py <app> --background`), then poll `provision.py <app> status` or `lanes.py <app> status` every minute or so until it reports done, failed or needs a human.
- **Locks.** One app runs one long step at a time. If a script says another run holds the app's lock, do not start a second one and never delete a lock file: poll `status` and wait, or tell the person what is running.

## Secrets

- Secrets are referenced by name only (`*_ref` fields). Values live in the deploy target (Vercel's environment or the server's environment files), never in the repository, a state file, a command line or the chat.
- **You never type, paste, pipe, store or repeat a secret value.** When a key is missing, the operator sets it themselves, in a separate terminal on the factory machine (for example a second SSH session):

  ```
  python3 .claude/scripts/provision.py <app_id> --set-secret NAME
  ```

  It asks at a hidden prompt and prints only the name. Give them that line with the real app id and NAME, then wait for them to say it is done.
- Do not use your tool's in-chat shell (`!` in Claude Code, Codex, Gemini, Qwen, OpenCode, and others) for this: its output goes into the conversation. Pi's `!!` runs a command without sending its output to the model; a separate terminal works with every tool.
- If someone pastes a secret into the chat, do not repeat it or write it anywhere. Tell them it should be replaced (it has been exposed), and give them the `--set-secret` line for the new one.

## What needs an explicit yes

Safe to run without asking: `factory.py doctor`, `status`, `tasks`, `next`, `validate`; `mint.py list` and `mint.py <app> [--json]`; every check, `status`, `--list` and `--dry-run`; `provision.py <app>` (the check) and `--capacity`; `repo.py <app> status`; `mold.py check`. Local edits to the factory's own state as part of the job you were given (a brief, `mint.py new`, intake, a task note) are fine.

**Always ask first, naming the app and what will happen, and wait for a plain yes:**

- **Deploys:** `provision.py --deploy`, `--deploy-remote`, `--verify-db`, and `mint.py <app> run` when its next station is a deploy. A request that asks for the deploy ("deploy it", "carry on" after you said the deploy is next) is a yes; your own inference is not. **An app that is live with users gets its own separate yes every time, even when the request names it:** if the request bundles the deploy with another risky step (a force-push, a delete, "quickly"), stop, say what each step would do, and ask about the live deploy on its own.
- **Repositories:** `repo.py publish` or `push` (only ever when the person asked for a repository), `gh repo create`.
- **Force-push or history rewrite** on any shared branch: `git push --force`, `-f`, `--force-with-lease`, `+refspec`.
- **Spending:** anything that starts a paid plan, a bigger server, a paid add-on, or publishes a package (`agent_cli.py publish`, `npm publish`).
- **Deletes and irreversible changes:** removing projects, databases, repositories, workspaces or files you did not create; any `--apply` of a cleanup; `domain.py switch`.
- **Contacting people:** anything that emails or messages someone (`mint.py <app> code-request`).

## Rules

- Molds under `molds/<mold_id>/codebase` are general-purpose snapshots, committed in this repository at their pinned version and refreshed from their source by `mold.py` (the source's address is the machine's own, in `state/factory.local.json`). Never edit one in place and never fork one for an app. A base-code change is a pull request to the mold's source.
- An app's own code (specialist agents, an instructions section, sandbox helpers) is a pack under `packs/<pack_id>/`, named in the app's state and applied to `build/<app_id>/` by `packs.py`.
- Stamping an app means: copy `state/application/app_id/` to a real id, fill the four JSON files against their schemas, then run the five lanes in `molds/<mold_id>/testing/`. A failed lane sets the app to `reverted` and hands control back to the operator. Report what was measured, never what was hoped; never edit a lane or a test to make it pass.
- Shallow-clone external repositories.
- **Never commit git-ignored paths:** app state (`state/application/<app_id>/`), `packs/`, `brands/`, `briefs/`, `reports/`, `build/`, `molds/*/codebase/`, `state/factory.local.json`, `AGENTS.local.md`, `.env*`. Stage explicit paths (`git add <path>`); never `git add -A` or `git add -f`.
- Generic agent assets live under `.agents/`; tool-specific ones under that tool's folder (`.claude/`, `.gemini/`, `.codex/`, ...). `docs/AGENT_INTEGRATION.md` lists what each coding agent reads.

## Asking the operator for something

Assume the operator is not an engineer unless `AGENTS.local.md` says otherwise. Whenever a step needs them (a login only they hold, a value from a dashboard, a click in a console, a code from their inbox, a key at the hidden prompt), ask the way a patient friend would:

- Open with what you need and why, in one plain sentence each. No acronyms without the words behind them, and no "devtools", "localStorage", "origin" or "env" unless you say what to click.
- Give the steps as a numbered list, one action per line, starting from the web address to open and naming each button or field exactly as the screen shows it. Put anything they must paste or type on its own line in a code block.
- One thing at a time. If two things are needed, finish the first before mentioning the second, and say how long each takes.
- Prefer the path with the fewest tools: an emailed code they paste into the chat beats a value copied out of the browser; a link beats a menu path.
- Say what happens next, and in one sentence why it is safe: what is hidden, what is never stored, what expires.
- Never scold or say "as I said". If they are stuck, ask what the screen shows and go from there.
