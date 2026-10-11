# How much a specialist sends per step (mold_v1-220)

A specialist runs as one eve child session: a tool step, then another, until it answers. **Every step resends the
session's whole history** to the model: the instructions, the tools, and every earlier tool call and its result. So a
run's input is roughly the sum, over its steps, of everything it has read so far. Measured on one workspace
(2026-10-09, GLM 5.3): single specialist runs of 3.5M, 5.6M, 11.8M and 18.3M input tokens, in 20-40+ steps, with the
context climbing to a few hundred thousand tokens.

Two things let it climb:

1. **eve compacted only at 90% of the window.** A session is summarised once its prompt passes
   `compaction.thresholdPercent x context window`, and eve's default is 0.9: ~1.18M tokens on GLM 5.3's 1,310,720
   window. A specialist never got there, so nothing it read ever left its prompt.
2. **`dataroom_read` and `dataroom_list` returned whole files.** One read of a long filing became one tool result of
   that size, resent on every later step.

Nothing here caps a run: there is no step limit and no budget that stops work. What changes is how much one step
sends.

## What a run does now

**Specialists compact at a threshold from the deployment profile.** `agent.compaction.specialist_tokens`, 160,000 by
default (`profiles/00-default.json`), is turned into eve's `compaction.thresholdPercent` against the window the agent
declares (`agent/lib/compaction-threshold.ts`, through `compactionFor(<key>, <role>)` in `agent/lib/model.ts`). Every
subagent declares it beside its window:

```ts
model: agentModel("specialist"),
modelContextWindowTokens: modelContextWindowTokens("specialist"),
compaction: compactionFor("my-specialist", "specialist"),
```

`npm run check:subagents` fails a subagent (a pack's too) whose `agent.ts` does not, or names another directory. One
specialist can have its own value (`agent.compaction.specialists.<key>`), and
`MODEL_COMPACT_AT_TOKENS_SPECIALIST` overrides the role for one deployment. Each value is held to 90% of the window;
gateway mode (where eve looks the window up itself) keeps eve's own.

**The main agent keeps eve's own threshold** (`agent.compaction.orchestrator_tokens: null`). The investigation's input
was in the specialists' tool steps; the main agent resends the conversation and the specialists' results, which a
specialist hands back as one answer. It can be given a value the same way if a deployment needs it.

**eve's compaction keeps what was read** (the eve patch, `scripts/eve-patch/files/harness/compaction-fidelity.js`).
eve as shipped wrote its summary from a 280-character digest of each part, with a tool result collapsed to
`object(type=json, value=object(3 keys))`, and the messages it kept after the summary lost their tool calls and results.
Early compaction on that would lose whatever a specialist had read. With the patch:

- the summariser reads tool calls and results in full, as JSON (the transcript is never held below the summarised
  messages' own size, which the session already sent; over its budget the largest parts are shortened first);
- the kept messages keep their tool calls and results as complete pairs, and a result whose call is summarised is
  summarised with it;
- the kept window is at most a quarter of the threshold, so a compaction leaves room for three quarters of a
  threshold of new work before the next one.

**Data-room reads are paged** (`agent/lib/dataroom-paging.ts`). `dataroom_read` returns at most one page
(`DATAROOM_PAGE_CHARS`, default 40,000 characters, about 10,000 tokens) and, when there is more, `offset`,
`nextOffset`, the total and `more`: "MORE IS AVAILABLE: call dataroom_read again with the same path and offset: N ...".
Text pages by character (ending on a line break when there is one), `.jsonl` by whole record, `dataroom_list` by path
(sorted when it spans pages). A file or listing that fits in one page comes back exactly as before. Binary files are
unchanged: `dataroom_fetch_to_sandbox`, then parse in the sandbox; the note also points there for searching a large
text file with `grep` instead of reading all of it.

**Prompt caching keeps working.** The system prompt and tools are untouched and nothing dynamic is placed before
them: paging notes are in tool results, at the end of the history. A compaction replaces the history after the system
prompt with the summary, so the step after it misses the cache once and the steps after that hit again. Every call,
the compaction call included, carries the session's `x-session-affinity` (`agent/lib/session-affinity.ts`).

## What it costs and saves

A step sends at most about the threshold, plus the step's own new results (one page at most from the data room).
Each compaction is one extra call whose input is the summarised part (about three quarters of a threshold) and whose
output is the summary. A run whose context never reaches the threshold is unchanged.

`npm run test:specialist-context` measures it on the real eve runtime with the fake model server: a specialist reads a
800,000-character document (20 pages, ~200,000 tokens, 48 facts) page by page and reports every fact. With the profile's threshold every
call (compaction calls included) stays under 160,000 tokens and every fact reaches the main agent; with eve's own
threshold the same run peaks above it. The test prints both runs' totals. Measured (2026-10-10, input tokens as eve
estimates them): eve's own threshold, 22 steps, peak 211,401, total 2,456,600; the profile's, 22 steps and one
compaction call, peak 158,916, total 1,780,806 (27.5% less on a run that only just passes the threshold; the saving
grows with the run's length, below).

The same run with the threshold but WITHOUT the patch's compaction files (eve's stock compaction) shows why the patch
is part of this: the summary, written from 280-character digests, kept 2 of the facts read and no offset, so the
specialist went back to page 1 after every compaction: 21 restarts and 26.2M input tokens without finishing.

For runs shaped like the measured ones (a base prompt of ~15,000 tokens, 30-40 steps, each adding the same share of
the run's recorded input), the model in the PR description gives: 3.5M -> 2.7-3.5M for the smallest, 11.8M -> 3.4-4.2M,
18.3M -> 3.5-4.6M for the largest; the seven measured runs together 54.8M -> 21.7-27.3M (50-60% less). A run that
never reaches 160,000 tokens is unchanged.

## Checks

```
npm run test:specialist-context    # the real eve runtime: peak per step under the threshold, nothing lost (before/after printed)
npm run test:compaction-fidelity   # the eve patch's helpers and eve's compactMessages; the thresholds per role
npm run test:dataroom-paging       # paging, pure and through the real tools on a local data room
npm run check:subagents            # every subagent declares its compaction
```
