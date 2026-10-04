---
name: repo
description: Give a minted application its own private repository on GitHub or GitLab, push to it, or check it. Use ONLY when the operator asks for a repository for an app, asks to push or update one, or asks whether an app has one. Never as a step of minting, deploying or testing.
---
# repo

An application's code can have a home outside the factory: one PRIVATE repository per application, under the one
sign-in the operator already has for that provider. It exists only if the operator asked for it. Nothing in `mint`,
`provision` or the lanes makes one; `mint.py <app_id>` only prints a line saying whether there is one.

```
python3 .claude/scripts/repo.py <app_id> status                                   # is there one, where, and what would be pushed
python3 .claude/scripts/repo.py <app_id> publish --provider github --dry-run      # what would happen; creates nothing
python3 .claude/scripts/repo.py <app_id> publish --provider github                # create it (private) and push
python3 .claude/scripts/repo.py <app_id> publish --provider gitlab [--host gitlab.example.com] [--owner <group>]
python3 .claude/scripts/repo.py <app_id> push [--dry-run]                         # one new commit, if the app changed
python3 .claude/scripts/repo.py <app_id> auto-push on|off                         # let a deploy or a test run push by itself
python3 .claude/scripts/repo.py <app_id> unlink                                   # forget it; the repository is left as it is
python3 .claude/scripts/repo.py --self-test
```

`--name` picks another repository name (default: the app id with dashes). `--owner` picks an organisation or group
(default: the signed-in account). `--keep` on `status` or a dry run leaves the assembled files in a scratch folder
and prints its path, for a look. There is no flag that makes a repository public, and none that skips the secret check.

## When the operator asks for a repository

1. Run the dry run first: `repo.py <app_id> publish --provider <github|gitlab> --dry-run`. It creates nothing.
2. Tell the operator, in plain words, before creating anything, and wait for a yes:
   - the name and where it will live (`<host>/<owner>/<name>`),
   - that it will be private,
   - what goes in: the app's code as it is deployed (base product plus this app's brand and packs), a `factory/`
     folder with the brief and the state files (which include the workspace's members by email, and the NAMES of
     secrets, never their values), and a `FACTORY.md` page saying what it was built from,
   - what is left out: installed packages, build output, `.env` files, logs,
   - the size and file count the dry run printed.
3. On a yes, run the same command without `--dry-run`. It records the repository in the app's
   `infrastructure.json` (`repository`: provider, host, owner, name, url, last commit, auto_push) and nothing else.
4. Give the operator the link, and say that nobody should edit it there: base changes go upstream as a pull request,
   this app's own changes go in its pack, and the next push replaces the repository's contents.

Running `publish` again later pushes to the same repository. `push` does the same. Both make a commit only when
something changed.

## If it refuses

- **The secret check found something.** It names the file and the line and never the value. Do not look for a way
  around it; there is none. Remove the value at its source (a pack file, a state file; for base code, a pull request
  upstream), tell the operator which credential to replace if it was real, then run again.
- **GitLab is not set up.** The command prints the steps for the operator. Give them one at a time, the way AGENTS.md
  says, exactly as printed. The token is typed at the operator's own terminal, never into the chat.
- **GitHub is not signed in.** Same: the printed steps, one at a time.
- **The repository is not private, or belongs to something else.** Nothing was pushed. Tell the operator what the
  message says and let them choose: make it private, pick another `--name`, or `unlink`.

## Pushing by itself

Off unless the operator says otherwise. `repo.py <app_id> auto-push on` lets a deploy that finished and a test run
that was recorded push one commit each; `off` stops it. Turn it on only when asked. A push that fails after a deploy
says so and does not fail the deploy.

## Credentials

One per provider, shared by every app, and never written to the repository, the state files or the chat: GitHub
uses the `gh` command's sign-in on this machine; GitLab uses the `glab` command if it is installed, otherwise the
token in this machine's environment under the name `GITLAB_TOKEN` (`docs/RUNBOOK.md` §10 has the operator's steps).
