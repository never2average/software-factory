---
name: research-workspace-setup
description: "Work inside a housing-finance research workspace from a coding agent: connect, find the companies you cover, read and file SEBI LODR filings and investor presentations, keep Portfolios and Coverage reports true, and hand figures back with their sources. Use when someone says \"connect me to the research workspace\", \"what do we cover\", \"file this quarter's results\", \"where do filings go\", \"update the portfolio\" or \"record a coverage report\"."
---

# Work in the research workspace

This workspace is used by equity and credit analysts who cover Indian housing finance companies (HFCs), both
listed and debt-listed. You are connected to it as the signed-in person, through its MCP endpoint or this
package. You see and change only what that person may.

The source of truth is the workspace itself: its data room (files) and its records. You are a second pair of
hands for an analyst and you are not the analyst. You prepare the work, you cite it, and you leave every
judgement to a person.

## 1. Connect and orient

1. Call `fde_status` to confirm who you are signed in as, and `workspace_list` to see which workspace is
   selected. If the person belongs to several workspaces, confirm the right one before you write anything.
2. Call `dataroom_structure` to read the data-room description. Folder names are the real ones. People see
   `Customers/` as "Companies", `Implementation/` as "Portfolios" and `Deployments/` as "Coverage reports".
3. Call `customer_list` to see the covered companies. A "customer" record is a company. Its owner is the
   covering analyst, and its record says whether it is equity-listed or only debt-listed.

## 2. Where things live

```
Customers/{company_id}/
  context.md                     what we know about the company
  interactions.jsonl             earnings calls and meetings
  filings/
    lodr/                        SEBI LODR filings, named {YYYY-MM-DD}_{tag}_{name}
    presentations/               investor presentations and concall transcripts
    filing-log.jsonl             dated log of what was filed
    kpis.jsonl                   the standard quarterly KPI table, one row per KPI, each cited
```

- Put a company's material only inside that company's own folder.
- The workspace's research specialists own the `.jsonl` files. They write them only after their own validators
  pass. Do not hand-edit those files.
- If a number needs correcting, ask the workspace agent to re-extract it, or tell the analyst.

## 3. What you may do, and what you leave to the workspace

| Task | Do it |
|---|---|
| Find which filings exist for a company and quarter | `dataroom_list` on its `filings/` folders, then read `filing-log.jsonl` |
| Add a document the analyst gives you | Write it under the company's `filings/lodr/` or `filings/presentations/` with the dated name, then ask the workspace agent to log it |
| Get KPIs, read an annual report, or track guidance | Ask the workspace agent. Its specialists apply the analysts' own rules for sources, units and formulas. You do not have those rules and must not approximate them. |
| Summarise where coverage stands | Call `implementation_list` for the Portfolio entries (build-out stage, completeness, blockers) and `deployment_list` for the Coverage reports (type, period, status, data quality). The tools keep their original names. |
| Record that a report was produced | Create a Coverage report with `deployment_upsert`. Give its type, period and basis, the analyst, the status **In progress**, and what changed. Only a person sets it to Published. |

## 4. Rules that do not bend

- **Every figure carries its source**: the document, plus the page or slide. A figure you cannot cite is
  "not found". Never give a number from memory or from a news article.
- **Statuses pass through unchanged.** Relay `needs_review`, `carried_forward` and `not_found` exactly as the
  workspace reports them. Do not smooth them over.
- **Reporting conventions:**
  - Amounts are in ₹ crore.
  - Use standalone figures where both standalone and consolidated exist.
  - Use the discrete quarter, never a cumulative figure.
- **Restructured-book details are excluded** from the analysts' tables. If a source contains them, say so and
  leave them out.
- **No opinions** on whether a number is good or bad, and no recommendations. Report what was disclosed and when.
- **Stay in the workspace you were given.** Never read or combine another workspace's records.

## Worked example

> "Where are we on Example Housing Finance Ltd for Q2 FY26?"

1. Call `customer_list` and find `examplehfl` (equity-listed; its covering analyst is named on the record).
2. Call `dataroom_list Customers/examplehfl/filings/`. The results filing is dated 2025-10-20, and there is no
   investor presentation for Q2.
3. Read the Portfolio entry. The stage is "Filings ingested", filings are 100% complete, presentations are 75%
   complete, and the blocker is "Q2 deck not yet published by the company", owned by the Company.
4. Look at the Coverage reports. `Q2FY26-results` is a Quarterly results update, In progress, with data quality
   Partial (values carried forward).
5. Reply with those four facts, each with its file path. Do not give a KPI number. If the person wants the
   numbers, ask the workspace agent for the KPI table.

## When it cannot be done

- **Not signed in, or the token has expired:** say so and give the sign-in command from `--help`. Never ask the
  person to paste a token into chat.
- **The company is not covered by this workspace:** say it is outside coverage. Do not create the company unless
  the person asks you to.
- **A tool returns an error about permissions or the workspace:** stop and report it. Do not retry in another
  workspace.
