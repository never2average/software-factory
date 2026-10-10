# Credentials

Two kinds, with a sample file for each. The samples hold **names and fake placeholder values only**.

| | Sample | Where the real values live |
|---|---|---|
| **Factory-level:** what the factory machine needs once, for every app | [`credentials/factory.example.env`](credentials/factory.example.env) | sign-ins (`gh`, `vercel`, coding agents), SSH keys in `~/.ssh`, the uptime alert key in `~/.config/software-factory/uptime.env` (mode 600), private settings in `state/factory.local.json` |
| **App-level:** what one deployed app needs | [`credentials/app.example.env`](credentials/app.example.env) | the app's deploy target only: Vercel's production environment, or `/etc/software-factory/<app>/env` (mode 600) on its own server |

## Rules

- **Never** put a real value in the repository, a state file, a command line or a chat. State files name secrets (`*_ref`, `secrets_user`); they never hold them.
- You set a value yourself, at a hidden prompt, in your own terminal:
  - app-level: `python3 .claude/scripts/provision.py <app> --set-secret NAME`
  - uptime alerts: `python3 .claude/scripts/uptime.py set-email-key`
- A coding agent never types, pastes or repeats a secret. It tells you which one is missing and how to set it (`AGENTS.md`, "Secrets").
- If a key was ever pasted somewhere it shouldn't have been, replace it: create a new one, set it as above, then delete the old one where it was issued.
- Values you provide once can be copied from an app that already runs to a new one, in memory and never printed: `python3 .claude/scripts/mint.py <new_app> reuse-keys <running_app>`.

## Checking what's set (names only)

- Factory machine: `python3 .claude/scripts/factory.py doctor`
- An app: `python3 .claude/scripts/provision.py <app>` lists every name it needs and which are present.
