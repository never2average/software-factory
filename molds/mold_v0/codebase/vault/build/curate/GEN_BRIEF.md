# Generation brief: agent-building and feature-flag tasks from product ideas

Octillion gives AI coding agents a realistic task inside a codebase and observes which third-party tools they choose.
Real-world sources have few agent-building and feature-flag requests, so you write them from realistic product ideas.
Every task is labelled `source.dataset = "generated"` so it is never confused with real-request tasks.

## Input
- An ideas chunk (JSON array): id, market, name, pitch, users, core_entities, core_workflows, agent_opportunities (4),
  feature_flag_opportunities (1-2), suggested_stacks.
- Repos: `vault/curated/repos.json` (id, url, commit, template, framework, domain, description,
  capabilities_present, license, app_dir).

## For EACH idea write 5 tasks
- 4 `agents` tasks, one per agent_opportunity, and 1 `feature-flags` task from the first feature_flag_opportunity.
- Vary the agent patterns across the 4: RAG over the product's own data, tool/function calling against the product's
  own APIs, multi-step planning/workflows with human approval, memory/personalization, multi-agent hand-offs,
  evaluation/tracing/guardrails, cost/latency controls. Feature-flag tasks: gradual percentage rollout, per-tenant
  entitlements, A/B experiments with metrics, kill switches, beta cohorts, regional launches, flag cleanup.
- Write like a real developer messaging a coding agent: first person, concrete, grounded in the product's entities and
  workflows ("In this <product kind> backend, I want…"), with constraints (latency, cost, privacy, approvals, audit,
  tenancy) and acceptance details (endpoints/screens, tests, failure handling). 120-1400 characters.
- The tool choice must stay open: the agent should have to pick an LLM provider/SDK/agent framework/vector store/flag
  service or build it itself. NEVER name any vendor, model, SaaS, framework product or package (no OpenAI, Anthropic,
  Claude, GPT, LangChain, LlamaIndex, Pinecone, LaunchDarkly, Unleash, Flagsmith, GrowthBook, PostHog, Redis, etc.).
  Say "an LLM", "a vector index", "a feature-flag service". Avoid starting sentences with words like "Make"/"Render".
  No URLs or emails.
- Stack: use the idea's suggested_stacks; spread tasks across them. `language` = TypeScript (express-ts, nextjs-ts,
  node-ts, react-native), Python (fastapi, django), Go (go-http), Dart (flutter), Java (java-spring), Rust
  (rust-axum), C++ (cpp-cmake).
- Placement: if a repo with the same template has a domain that genuinely fits the product (e.g. a shop idea -> an
  e-commerce repo) and lacks the category, you may rewrite the task into that repo (`title`/`prompt` in the repo's
  domain, `repo_url` = `<url>#<commit>` exactly, `repo` = {id, domain, license, app_dir}); otherwise keep it generic
  (`title`/`prompt` = `generic_title`/`generic_prompt`, no repo fields). Never more than 2 tasks per repo per chunk.

## Fields per task
`id` = "gen-<idea id without the 'idea-' prefix>-<short-slug>" (lowercase, a-z0-9-), `title`, `prompt`,
`generic_title`, `generic_prompt`, `category` ("agents" | "feature-flags"), `template`, `language`, `tags` (2-5 generic
lowercase tags), `source` = {"dataset": "generated", "idea_id": <idea id>, "market": <market>, "pattern": <short label
e.g. "rag", "tool-calling", "kill-switch">}.

## Output
Write all tasks as a JSON array with a Python script (json.dump, ensure_ascii=False). Run
`python3 vault/build/check_generated.py <ideas chunk> <output>` and fix every problem until
it prints OK. Report back only: ideas, tasks (agents / feature-flags), placed, validator final line.
