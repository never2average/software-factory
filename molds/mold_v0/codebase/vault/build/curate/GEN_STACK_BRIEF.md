# Generation brief: Java, Rust and C++ tasks from product ideas

Octillion gives AI coding agents a realistic task inside a codebase and observes which third-party tools they choose.
Real sources have few Rust/C++ requests that involve choosing a tool, so you write them from realistic product ideas.
Every task is labelled `source.dataset = "generated"`.

## Input
- An ideas chunk (JSON array). Each idea has an extra field `assigned_stack`: java-spring | rust-axum | cpp-cmake.
- Repos: `vault/curated/repos.json`.

## For EACH idea write 3 tasks in its `assigned_stack`
- Imagine the part of that product that is naturally built in this stack: a Spring Boot service (Java), a Rust axum
  service/worker/CLI, or a C++ (CMake) service, engine, edge agent or desktop tool. E.g. a trading idea in C++ -> the
  order-matching engine; a climate idea in Rust -> the telemetry ingest service; an HR idea in Java -> the payroll
  export service.
- The 3 tasks must use 3 DIFFERENT categories from: auth, database, background-jobs, caching, deployment, observability,
  payments, email, messaging, search, ai, storage, feature-flags, analytics (not `agents`). Pick ones that fit the
  component. Across the chunk, cover as many categories as possible.
- Each task: first person, concrete, grounded in the idea's entities/workflows, with constraints (throughput, latency,
  memory, tenancy, compliance, audit) and acceptance details (endpoints/CLI flags, tests, failure handling).
  120-1400 characters. The tool choice must stay open: NEVER name any vendor, SaaS, database product, broker, cloud or
  third-party library/crate/package/framework (no Kafka, Redis, Postgres, Tokio-specific crates, Boost, Spring Data,
  Hibernate, gRPC, Prometheus, OpenTelemetry, etc.). The stack's own base framework (Spring Boot, axum, CMake) and
  language may be named. Avoid sentences starting with brand-like words ("Make", "Render"). No URLs or emails.
- `language` = Java | Rust | C++ for java-spring | rust-axum | cpp-cmake.
- Placement: if a repo of the same template genuinely fits the component's domain and lacks the category, rewrite into
  it (`title`/`prompt` in the repo's domain, `repo_url` = `<url>#<commit>` exactly, `repo` = {id, domain, license,
  app_dir}); otherwise keep generic (`title`/`prompt` = `generic_title`/`generic_prompt`). At most 3 tasks per repo per
  chunk.

## Fields per task
`id` = "gen-<idea id without 'idea-'>-<short-slug>" (lowercase a-z0-9-), `title`, `prompt`, `generic_title`,
`generic_prompt`, `category`, `template` (= assigned_stack), `language`, `tags` (2-5 generic lowercase tags),
`source` = {"dataset": "generated", "idea_id", "market", "pattern": "stack-<assigned_stack>"}.

## Output
Write the tasks as a JSON array with a Python script (json.dump, ensure_ascii=False). Run
`GEN_MODE=stack python3 vault/build/check_generated.py <ideas chunk> <output>` and fix every
problem until it prints OK. Report back only: ideas, tasks, placed, validator final line.
