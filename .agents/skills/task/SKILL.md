---
name: task
description: Pick, add, or close factory tasks against a mold. Use when asked what to work on next, to log new work, or to mark work finished.
---
# task

The backlog is `state/tasks/<mold_id>.jsonl`, one task per line, schema `state/tasks.schema.json`. It is this factory machine's own and never committed (git-ignored since mold_v0-198: ticket notes name run ids, costs and applications). Drive it only through the CLI so ids and stages stay consistent:

```
python3 .claude/scripts/factory.py status
python3 .claude/scripts/factory.py next mold_v1
python3 .claude/scripts/factory.py add mold_v1 "title" --type build --pri 2 --dep mold_v1-001
python3 .claude/scripts/factory.py set mold_v1-004 status in_progress
python3 .claude/scripts/factory.py close mold_v1-004 "commit abc123, report molds/mold_v1/testing/functional/report.md"
```

Rules: work the `next` task unless the user names one. Set `in_progress` before starting. Close only with evidence (commit, report path, URL). If a task turns out to need splitting, `add` the parts with `--dep` on the parent and drop nothing silently. The backlog change is not committed: from a scratch clone, run the factory checkout's own script (`python3 <factory checkout>/.claude/scripts/factory.py close ...`), which writes that checkout's `state/tasks/`.
