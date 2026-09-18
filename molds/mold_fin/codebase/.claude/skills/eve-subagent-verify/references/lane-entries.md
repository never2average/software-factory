# Functional-lane entries for the subagent workspace checks

Proposed additions to the `checks` array of `../testing/functional/lane.json` (relative to
the codebase). That file is outside this codebase's write scope: hand these to the owner of
the mold's `testing/` directory. They follow the shape of the existing entries (`name`,
`run`, optional `timeout_s`, `expect`, `why`; default `cwd` is the codebase).

```json
{
  "name": "check-subagents.self-test",
  "run": "python3 scripts/check-subagents.py --self-test",
  "timeout_s": 120,
  "expect": { "exit": 0, "stdout": ["check-subagents self-test: \\d+/\\d+ cases passed"], "stdout_not": ["^FAIL "] },
  "why": "The subagent checker grades every workspace subagent; if it cannot tell a complete workspace from a broken one, the next row's PASS means nothing."
},
{
  "name": "check:fin-workspace",
  "run": "npm run check:fin-workspace",
  "expect": { "exit": 0, "stdout": ["fin-workspace: every copy matches"] },
  "why": "Each research subagent carries its own copy of the shared number, unit, period and schema helpers; a drifted copy means two subagents convert the same figure differently."
},
{
  "name": "check:subagents",
  "run": "PYTHONDONTWRITEBYTECODE=1 timeout -k 30 840 npm run check:subagents",
  "timeout_s": 900,
  "expect": { "exit": 0, "stdout": ["\\d+ subagent\\(s\\) checked, 0 failing"], "stdout_not": ["^FAIL ", "no subagent has a sandbox/workspace"] },
  "why": "A research subagent without its skills, validators, passing script self-tests and registration is a prompt, not a specialist: it misreads the first filing laid out differently, writes unvalidated rows, or runs without appearing in the Ops Center."
}
```

Notes:

- `check:subagents` runs every script's `--self-test`, so it subsumes a separate
  per-script row. Its timeout is generous because the run is sequential (60 s per script by
  default; `--timeout N` changes it).
- `stdout_not` on `no subagent has a sandbox/workspace` stops the lane grading an empty
  scope as a pass if the subagents were ever removed.
- `PYTHONDONTWRITEBYTECODE=1` keeps `__pycache__` out of the seeded workspace tree.
- A live smoke turn for one subagent would follow the existing `chat.turn` entry: `cwd`
  `root`, the same two `requires` preconditions (a deployed URL and a usable session), a
  prompt that names the subagent, and an `expect.stdout` that matches a delegation to
  `<key>`. Without a session it is `skipped`, and so is the lane: never `pass`.
