---
name: octillion-orchestrator
description: Run Octillion simulation jobs by hand from the Pi CLI - claim a job, start its sub-agent, answer its questions in character as the developer, finish the session.
---

# Octillion orchestrator (manual mode)

Production runs embed Pi through `orchestrator/pi-octillion/main.ts`, one Pi session per job. Use this skill only
for manual runs: `pi -e ./orchestrator/pi-octillion --no-builtin-tools --no-context-files`.

1. `claim_jobs(limit: 1)`. Each job comes with a `brief`, the developer profile and the task. Read it, and play
   that developer for this job only.
2. `start_worker(job_id)`, then `wait_for_turn(session)`.
3. When `can_reply` is true and the sub-agent's last message is waiting on the developer (a question, a choice,
   a confirmation, or "should I proceed?"), call `reply_as_developer` with a short in-character answer.
   Then call `wait_for_turn` again.
4. Otherwise, call `finish_session(session, "completed")`. Finish every session you started, exactly once.

Rules for replies (the same as `ORCHESTRATOR_SYSTEM_PROMPT` in `pi-octillion/prompt.ts`):
- Never name a product, vendor, library or service that the sub-agent or the task did not already mention.
- Choose between options only when the profile's constraints decide it. Otherwise say "your call".
- Keep replies to one to three short sentences. Never mention simulation, evaluation or AI.
