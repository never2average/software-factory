# Proposed changes to the factory's scripts

The benchmarks do not touch anything outside `benchmarks/`. Today they run against a **rehearsal copy** of the factory
(`fixture/factory/`): the same layout, skills and commands, but small stand-in scripts, because the real scripts reach
real services (the Vercel API and CLI, the database provider, npm, SSH, the app's own sign-in endpoints) with no
switch to send those calls anywhere else.

Each change below would let the benchmarks run the **real** scripts, so a score would measure the factory as it ships.
They are proposals for the people who own those scripts; none is needed for the benchmarks to work today.

## 1. One rehearsal switch: `FACTORY_REHEARSAL=<dir>`

**Where:** a new `lib/services.py`, used by `provision.py`, `mint.py`, `domain.py`, `agent_cli.py`, `repo.py`,
`lib/vm_remote.py`.

**What:** every outbound action goes through one module: Vercel REST calls, `vercel` CLI calls, `ssh`/`scp`, `npm`,
`gh`/`glab`, and HTTP to a deployed app. When `FACTORY_REHEARSAL` is set, that module calls the CLIs in
`$FACTORY_REHEARSAL/bin/` (the shims the benchmarks already ship in `fixture/shims/shim.py`) and sends HTTP to a local
fake instead of the internet. Unset, nothing changes.

**Why:** today a stand-in has to re-implement each script. With the switch, `run.py` would copy the real
`.claude/scripts/` into the rehearsal, and any change an engineer makes to a script would be benchmarked at once.

## 2. A call log: `FACTORY_CALL_LOG=<path>`

**Where:** the same `lib/services.py`, plus one line at the top of each script's `main`.

**What:** append one JSON line per script invocation and per outbound action: script, arguments, the action
(`deploy`, `set-secret`, `code-request`, `push`, `publish`) and its outcome. Never a value: a secret is logged as its
name and whether it was written.

**Why:** the safety scores (never typed a secret, asked before deploying, never sent a sign-in code unasked) are
judged from this log. The rehearsal scripts already write it (`.rehearsal/calls.jsonl`); the real scripts would need
to write the same thing.

## 3. Refuse a piped secret unless the caller is the factory itself

**Where:** `provision.py`, `set_secret` (the branch for "no terminal to hide typing in", which today reads a piped
value from standard input).

**What:** accept a piped value only when `FACTORY_SECRET_FROM_STDIN=1` is set by a trusted caller (`mint.py
reuse-keys`, which already pipes values it read in memory). Otherwise refuse, and print the hidden-prompt and web-form
instructions as it does now when nothing is piped.

**Why:** `echo <value> | provision.py <app> --set-secret NAME` is the easiest way for an agent to "handle" a secret,
and it works today. Two tasks (`t5`, `t7`) check that agents do not do it; the script could also make it impossible.

## 4. A private directory override: `FACTORY_PRIVATE_DIR`

**Where:** `mint.py` (`PRIVATE = ~/.cache/software-factory`) and anything else that keeps sign-in sessions there.

**What:** read the directory from `FACTORY_PRIVATE_DIR` when it is set.

**Why:** a benchmark run must never read or overwrite the operator's real sessions. Today the only way to keep it
out is a different `HOME`, and that also hides the agent's own sign-in.

## 5. Local values from a named file: `FACTORY_LOCAL=<path>`

**Where:** `lib/factory_local.py`.

**What:** merge `FACTORY_LOCAL` (when set) instead of `state/factory.local.json`.

**Why:** a rehearsal needs example values (an `.example` sender domain, a fake team) without copying, or risking a
read of, the operator's own file.

## 6. Machine-readable status: `mint.py <app_id> --json` and `factory.py next --json`

**What:** the same survey `mint.py <app_id>` prints, as JSON: each station's status and sentence, and the one next
step. The same for `factory.py next`.

**Why:** the board, other agents and the benchmarks could then compare an agent's answer with the factory's own
answer exactly, instead of matching words in plain text.

## 7. A rehearsal mold

**Where:** `mold.py` (the `mold` skill).

**What:** `mold.py fetch mold_v1 --rehearsal` writes a tiny stand-in codebase and lane definitions (like
`fixture/factory/molds/mold_v1/`) instead of fetching the mold's source.

**Why:** with changes 1 and 2, this is the last piece needed for `lanes.py` and `provision.py` to run as they are,
with no account and no download, in under a second per lane.
