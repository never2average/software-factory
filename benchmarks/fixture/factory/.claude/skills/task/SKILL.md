---
name: task
description: Pick, add, or close factory tasks against a mold. Use when asked what to work on next, to log new work, or to mark work finished.
---
# task

The backlog is `state/tasks/<mold_id>.jsonl`. Drive it only through the CLI so ids stay consistent:

```
python3 .claude/scripts/factory.py status
python3 .claude/scripts/factory.py tasks mold_v1
python3 .claude/scripts/factory.py next mold_v1
python3 .claude/scripts/factory.py add mold_v1 "title" --type build --pri 2 --dep mold_v1-001
python3 .claude/scripts/factory.py set mold_v1-004 status in_progress
python3 .claude/scripts/factory.py close mold_v1-004 "evidence: commit, report path or URL"
```

"Next" means what `factory.py next` prints: the highest-priority `todo` task whose dependencies are all done (a
blocked task is never next, whatever its priority). Set `in_progress` only when you start the work.
