# CI steps for the subagent checks

For the `verify` job of `.github/workflows/ci.yml`. All three are offline (Python 3
standard library and Node only), so they fit the job's rule that nothing needs a database
or a secret. Place them after "Generated artifacts are current".

```yaml
      - name: Subagent checker self-test
        if: always()
        run: python3 scripts/check-subagents.py --self-test

      - name: Shared subagent helpers are in sync
        if: always()
        run: npm run check:subagent-shared

      - name: Subagent registry and workspace standard
        if: always()
        run: npm run check:subagents
        env:
          PYTHONDONTWRITEBYTECODE: "1"
```

What each line of output should be held to, if your runner can match on stdout (a plain
exit code is enough for GitHub Actions):

| Step | Exit | stdout must match | stdout must not match |
|---|---|---|---|
| `python3 scripts/check-subagents.py --self-test` | 0 | `check-subagents self-test: \d+/\d+ cases passed` | `^FAIL ` |
| `npm run check:subagent-shared` | 0 | `subagent-shared: \d+ famil(y\|ies), every copy matches` | |
| `npm run check:subagents` | 0 | `\d+ subagent\(s\) checked, 0 failing; registry ok` | `^FAIL ` |

Notes:

- `check:subagents` runs every script's `--self-test`, so it subsumes a separate
  per-script step. The run is sequential: 60 s per script by default, `--timeout N`
  changes it.
- In the base app no subagent follows the workspace standard yet, so the third step prints
  "no workspace-standard subagents yet" and exits 0 after checking the registry. A
  deployment that **depends** on a pack should name the pack's keys instead
  (`npm run check:subagents -- <key> <key>`): a named key that is missing fails, so a pack
  that silently failed to apply is not graded as a pass.
- `PYTHONDONTWRITEBYTECODE=1` keeps `__pycache__` out of the seeded workspace tree.
- A live smoke turn needs a deployed URL and a signed-in session; it does not belong in
  this job. Without a session it is skipped, never passed.
