# Proposed changes to the factory's scripts: done

The benchmarks used to run against small stand-in scripts, because the real ones reached real services with no switch
to send those calls anywhere else. The seven changes proposed here are now in the factory, and the benchmarks run the
**real** scripts (README, "How the rehearsal works"):

| # | proposal | where it landed |
|---|---|---|
| 1 | one rehearsal switch, `FACTORY_REHEARSAL=<dir>` | `.claude/scripts/lib/services.py`; used by `provision.py`, `mint.py`, `lanes.py`, `factory.py` (outside CLIs through `<dir>/bin`, a refusing stub for any that has no fake; the scripts' own HTTP through the `http` fake) |
| 2 | a call log, `FACTORY_CALL_LOG=<path>` | `services.log_call` / `services.script_start`: each script run and each outside call, with its action and caller, never a value |
| 3 | refuse a piped secret unless the caller is the factory | `provision.py --set-secret` refuses stdin without reading it; only `FACTORY_SECRET_FROM_STDIN=1` from `mint.py reuse-keys` is trusted |
| 4 | `FACTORY_PRIVATE_DIR` | `services.private_dir()`, read by `mint.py` |
| 5 | `FACTORY_LOCAL=<path>` | `lib/factory_local.py` |
| 6 | `mint.py <app> --json`, `factory.py next --json` | both, in the one result shape every script uses (`lib/agent_result.py`) |
| 7 | a rehearsal mold | `mold.py fetch <mold_id> --rehearsal` (only inside a rehearsal) |

With none of the variables set, the scripts behave as before.
