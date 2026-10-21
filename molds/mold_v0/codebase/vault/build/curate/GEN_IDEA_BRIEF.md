# Generation brief: tasks sized to real product ideas (ideabrowser)

Octillion gives AI coding agents a realistic task inside a codebase and observes which third-party tools they choose.
You turn real startup ideas into the development tasks their builders would actually face. Every task is labelled
`source.dataset = "generated"`.

## Input
- An ideas chunk (JSON array): `id`, `title`, `market` (business model · product type), `product_type`, `scores`
  (opportunity/pain/timing/feasibility, 1-10), `ideabrowser_id`, `ideabrowser_url`. Only titles are given: infer the
  product from the title the way a founder pitching it would mean it.
- Repos: `vault/curated/repos.json`.

## Step 1: size each idea (the task count is NOT fixed)
For each idea, picture the software its first engineers build, then list the capabilities where they would genuinely
have to choose a third-party tool or service. Categories: auth, database, background-jobs, caching, deployment,
observability, payments, email, messaging, search, ai, storage, feature-flags, analytics, agents (building an LLM agent:
tool calling, RAG, multi-step workflows, evals, guardrails, human approval).
Write ONE task per such capability, 0-6 per idea, never two in the same category. Rough guide:
- Two-sided marketplaces / platforms with transactions: 4-6 (auth, payments, messaging, search, email, storage...).
- B2B SaaS with integrations, data or AI at its core: 3-5.
- Single-purpose consumer apps, browser plugins, simple ecommerce shops: 1-3.
- Physical products / hardware where software is a companion (device app, telemetry): 0-3.
- An idea with no real software build (a physical kit, a pure service): 0 tasks. That is a valid, honest answer.
Do not pad: a category earns a task only if this product would really need it in its first year. Prefer the
capabilities that make THIS product distinctive (e.g. a fax-to-EHR tool -> ai document extraction, storage, audit
observability), not generic boilerplate. When an idea is AI-centric, the agents/ai tasks should be the core workflow.

## Step 2: pick the stack per task from the product
- Mobile app products -> react-native or flutter (backend tasks for them may use fastapi/django/go-http/nextjs-ts).
- Hardware / device / edge -> cpp-cmake (firmware-adjacent, desktop or edge agent) or rust-axum (ingest service, CLI).
- Marketplaces / platforms -> nextjs-ts, django, java-spring or go-http. Data/AI-heavy SaaS -> fastapi or django.
- Developer tools, bots, CLIs -> node-ts, rust-axum or go-http. High-throughput services -> go-http, rust-axum, java-spring.
- NEVER express-ts (already over-represented). Vary stacks across the chunk.
`language`: TypeScript (nextjs-ts, node-ts, react-native), Python (fastapi, django), Go (go-http), Dart (flutter),
Java (java-spring), Rust (rust-axum), C++ (cpp-cmake).

## Step 3: write each task
- First person, as the product's engineer; concrete and grounded in the product's users, entities and workflows, with
  constraints (scale, latency, tenancy, compliance, cost, offline) and acceptance details (endpoints, screens, CLI flags,
  tests, failure handling). 120-1400 characters.
- The tool choice must stay open: NEVER name a vendor, SaaS, database product, model provider, broker, cloud, or
  third-party library/package/framework (no Stripe, Twilio, Postgres, Redis, OpenAI, LangChain, Firebase, Kafka...). The
  stack's own base framework may be named. Avoid sentences starting with brand-like words ("Make", "Render"). No URLs or
  emails. Do not name ideabrowser or the idea's marketing title in the prompt; describe the product instead.
- Placement: if a repo of the same template genuinely fits the product's domain and lacks the category, rewrite the task
  into it (`title`/`prompt` in the repo's domain, `repo_url` = `<url>#<commit>` exactly, `repo` = {id, domain, license,
  app_dir}); otherwise keep it generic (`title`/`prompt` = `generic_title`/`generic_prompt`). At most 3 per repo per chunk.

## Fields per task
`id` = "gen-<idea id without 'idea-'>-<short-slug>" (lowercase a-z0-9-), `title`, `prompt`, `generic_title`,
`generic_prompt`, `category`, `template`, `language`, `tags` (2-5 generic lowercase tags),
`source` = {"dataset": "generated", "idea_id", "market", "pattern": "ideabrowser", "ideabrowser_url" (copied from the idea)}.

## Output
Write two files with a Python script (json.dump, ensure_ascii=False):
- `<output>.json`: the tasks (JSON array).
- `<output>.plan.json`: one entry per idea, `{"idea_id", "task_count", "rationale"}` where the rationale (one or two
  sentences) says what the product is and why it needs exactly these capabilities, or why it needs none.
Run `GEN_MODE=idea python3 vault/build/check_generated.py <ideas chunk> <output>.json`
and fix every problem until it prints OK. Report back only: ideas, tasks, ideas with 0 tasks, placed, category counts,
validator final line.
