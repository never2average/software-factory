# mold_fin

**Status:** active
**Base:** mold_v1
**Source:** github.com/never2average/fde-agent @ 79df480 (`main`, forked 2026-09-18), plus the finance delta below

**Node:** 24.x
**Target model:** GLM 5.2 via OpenAI-compatible provider
**Definition:** mold_v1 specialised for financial research on listed Indian housing finance companies (HFCs). Primary data sources are SEBI LODR filings and investor presentations. Four dedicated research subagents; web search on, browser off.

## This mold is a fork, not a snapshot

Unlike `mold_v1`, `codebase/` here is edited in place. The first commit of `molds/mold_fin/codebase` is the
pristine upstream tree at 79df480 (proved `IDENTICAL` by the `diff -rq` in `molds/mold_v1/MOLD.md`), so
`git log -- molds/mold_fin/codebase` after that commit is exactly the finance delta.

Never `rsync --delete` from upstream over this directory. To take an upstream change, clone upstream at the new
commit, diff it against the base commit above, and apply that diff here (3-way), then update the base commit.

## Finance delta

| What | Where |
|---|---|
| Subagent `hfc-kpi-extraction` | `codebase/agent/subagents/hfc-kpi-extraction/` |
| Subagent `lodr-filings` | `codebase/agent/subagents/lodr-filings/` |
| Subagent `investor-presentations` | `codebase/agent/subagents/investor-presentations/` |
| Subagent `annual-report-format` | `codebase/agent/subagents/annual-report-format/` |
| Subagent keys registered | `agent/lib/agent-configs.ts`, `app/_components/tool-display.ts`, `app/_components/ops/workspace-panel.tsx`, `app/_components/ops/workflows-panel.tsx`, `app/_components/insights.ts`, `scripts/seed-ops.mjs`, `agent/instructions.md` |
| Data-room paths for filings | `Customers/{customer_id}/filings/lodr/**`, `Customers/{customer_id}/filings/presentations/**` in `agent/lib/dataroom-store.ts` and `dm.md` |

In this mold a "customer" row is a covered company (one listed HFC); `fde_owner` is the covering analyst.

## Contents

- `codebase/` — the fork.
- `testing/` — the five lanes, copied from mold_v1 with paths pointed here and the page-title expectation set to `OnFinance`. Task ids of the form `mold_v1-NNN` in lane text are history from the base mold and are kept as written. The `MOLD_V1_LANE_URL` / `MOLD_V1_SESSION_TOKEN` environment names are the factory scripts' and are unchanged.
- `branding/` — overlay rules for `branding.py`, same rules as mold_v1 (the fork keeps the base strings the rules look for).

## Deploy targets

Vercel today. A VM-ready variant (remote deploy over SSH) is tracked in `state/tasks/mold_fin.jsonl`.
