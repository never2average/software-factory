# mold_v2 roadmap

**Status: in progress. The repository owner is still working on this mold.** It is not ready to stamp applications from.

mold_v2 extends mold_v1 with four capabilities:

| Capability | Scope | Backlog |
|---|---|---|
| Agent governance | policies, approvals, audit trail for every agent action | mold_v2-002, mold_v2-006 |
| Pipeline-level data isolation | per-pipeline stores and RLS scope | mold_v2-003, mold_v2-007 |
| Budget management | per-org token and cost caps with alerts | mold_v2-004, mold_v2-008 |
| Performance governor | concurrency, rate and sandbox limits | mold_v2-005, mold_v2-009 |

Sequence: design notes first, then fork mold_v1 into `codebase/` once mold_v1 passes its functional lane (mold_v2-001), then implement, then extend the context and load lanes (mold_v2-010), then productize (mold_v2-011).

Track progress with `python3 .claude/scripts/factory.py tasks mold_v2`.
