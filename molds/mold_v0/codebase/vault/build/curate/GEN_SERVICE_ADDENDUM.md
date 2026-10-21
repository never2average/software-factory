# Addendum for service ideas (`service_to_agent: true`)

These ideas are services (done by people today). Reimagine each as an **agent product** ("service as software"): the
service's work is done by an LLM agent, with humans approving, handling exceptions, or doing the physical parts.
Example: a bookkeeping service -> a bookkeeping agent that categorizes transactions via tool calls, asks the owner when
unsure, and is evaluated against last year's books; a no-code app maintenance service -> an agent that watches the app,
diagnoses breakages and opens fixes for approval.

Sizing (still 0-6 tasks, one per category, no padding):
- The core task is category `agents`: build the agent that does the service's core job. Be specific about its tools
  (which systems it reads and acts on), the human-approval step, how it is evaluated against real past jobs, guardrails
  and failure handling. Every idea whose work is meaningfully informational gets this task.
- Add supporting tasks only where the agent product genuinely needs them: payments (per-job or subscription billing),
  messaging (client conversations/notifications), email, storage (client documents), observability (agent traces and
  audit), ai (an individual model capability such as extraction/classification separate from the agent loop), search,
  background-jobs (scheduled agent runs), auth (client/workspace access).
- Services that are mostly physical (venues, in-person care, hospitality) usually get 0-2 tasks (e.g. a scheduling or
  intake agent); 0 is valid if software adds nothing real. Say so in the rationale.
- Mostly-informational services (bookkeeping, recruiting, research, compliance, marketing ops) typically get 3-5.
In the plan rationale, state the agent product in one sentence ("Agent that ..., humans ...").
