# mold_v3 roadmap

**Status: in progress. The repository owner is still working on this mold.** It is not ready to stamp applications from.

mold_v3 extends mold_v1 with:

| Capability | Scope | Backlog |
|---|---|---|
| Autoresearch | bounded research loops with stop conditions | mold_v3-002, mold_v3-005 |
| SAI | scope and interface to be defined by the owner | mold_v3-003, mold_v3-006 |
| Multi-context + multi-role isolation per workflow | each workflow runs with its own context and role boundaries | mold_v3-004, mold_v3-007 |

Sequence: design notes first, then fork mold_v1 into `codebase/` once mold_v1 passes its functional lane (mold_v3-001), then implement, then lane coverage and evals (mold_v3-008), then productize (mold_v3-009).

Track progress with `python3 .claude/scripts/factory.py tasks mold_v3`.
