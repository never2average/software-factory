# Curation brief (Octillion task library)

Octillion is a benchmark: AI coding agents (Claude Code, Codex, ...) get a realistic coding task inside a codebase and we
observe which third-party tools they choose (auth, database, background jobs, caching, deployment, observability,
payments, email, messaging, search, ai, agents, storage, feature-flags, analytics). You turn real developer questions (Stack Overflow, WildChat)
into such tasks.

## Input
A JSONL chunk of candidates. Each line: `source_id` (stackoverflow.com/q/<id>), `source` (dataset), `license`, `tags`,
`stacks`, `categories` (hints from tags), `score`, `text` (title + question prose; code blocks omitted).
Repos: `vault/curated/repos.json` (id, url, commit, template, framework, app_dir, domain,
description, capabilities_present, license).

## Special kinds of candidates
- **Mobile** (stacks react-native / flutter): tasks for a React Native (Expo, TypeScript) or Flutter (Dart) app. Mobile
  capabilities map to the usual categories: push notifications -> messaging; in-app purchases/subscriptions -> payments;
  local database, offline sync -> database; crash reporting -> observability; image/file upload -> storage.
- **Agent building** (category `agents`): adding an LLM-powered agent to an app: tool/function calling, retrieval
  (RAG), memory, multi-step planning, multi-agent orchestration, guardrails, evaluation or tracing of agent runs. Use
  `ai` for plain model calls, embeddings or vector search without agentic behavior.
- **DBMS** (`dbms: true`, category `database`): choosing or designing the data layer: which engine fits (relational,
  document, key-value, time-series, graph, analytical/warehouse), schema/data modeling, migrations, multi-tenancy,
  partitioning/sharding, replication, audit/history/versioning. Phrase the task as building that part of an app.
- **Stack "any"**: the question has no framework tag. Pick the template where the task is most natural (usually
  fastapi or express-ts for backends, react-native/flutter for mobile, node-ts for scripts) and write for it.

- **Java / Rust / C++** (stacks java-spring, rust-axum, cpp-cmake): Spring Boot services, Rust (axum) services or CLIs,
  and C++ (CMake) applications. Capabilities are the same 15 categories (e.g. choosing an HTTP/DB/logging/metrics/
  queue library or service for a C++ or Rust service is a valid tool choice). Reject language-syntax, compiler, build
  error and template-metaprogramming questions.

## For each candidate, decide ACCEPT or REJECT
Accept only if ALL hold:
- The developer wants to BUILD or ADD a capability to an application (not debug an error, not a config typo, not a
  language/syntax question, not "why does X behave like Y").
- Doing it naturally involves choosing a third-party library, managed service or infrastructure component, and several
  reasonable options exist (if the question is about one vendor's API, the underlying NEED usually still qualifies:
  "handle payment webhooks", "send templated transactional email").
- There is enough substance to write a concrete task. Expect to accept roughly a third; quality over quantity.

## For each accepted candidate, write a task
- `generic_title` / `generic_prompt`: first person, like a developer's message to a coding agent, set in a generic app of
  the stack ("In this Express API, ..."). Keep the real need, domain hints, constraints and acceptance details from the
  question; make it concrete. 60-1200 characters.
- Then try to PLACE it in a repo: same `template`, the task's `category` NOT in `capabilities_present`, and a domain where
  the task is plausible. Spread tasks across eligible repos (don't pile into one). If placed, `title` / `prompt` are the
  task rewritten into that app's domain and data model ("In this <domain> app, ..."), 80-1200 characters, referring to
  structure only as the repo description states; add `repo_url` = `<url>#<commit>` exactly and
  `repo` = {id, domain, license, app_dir} from repos.json. If not placed, `title`/`prompt` = the generic ones and no
  repo_url / repo.
- NEVER name any vendor, hosted service, database product, cloud, SaaS, or third-party package/library anywhere in titles,
  prompts or tags (no Stripe, Redis, Postgres, MongoDB, S3, Firebase, SendGrid, Nodemailer, Celery, Bull, Socket.IO,
  Elasticsearch, Algolia, Passport, Prisma, Mongoose, Sentry, Heroku, Docker, OpenAI, ...). Describe needs generically
  ("a payment provider", "a transactional email service", "a relational database", "a background job queue", "a search
  engine"). The stack's own framework/language may be named. No URLs, email addresses, or mentions of Stack Overflow.
- The candidate's `categories` come from its tags and are often wrong: choose the category from what the question actually
  asks for.
- Avoid starting sentences with words the vendor check treats as brand names ("Make sure" -> "Ensure"; "Render" -> "Display").
- Fields: `id` = "so-<question id>" for Stack Overflow candidates, "wc-<first 12 characters of source_id>" for WildChat
  candidates (real user requests to a chatbot; same rules apply), and for GitHub issue candidates (source_id
  "github.com/<org>/<repo>/issues/<n>") "mswe-" + that path lowercased with non-alphanumerics as "-" (max 70 chars); `category` = one of the 15 above (pick the capability the task is really about);
  `template` = one of express-ts | nextjs-ts | node-ts | fastapi | django | go-http | react-native | flutter |
  java-spring | rust-axum | cpp-cmake (normally the chunk's stack); `language` = TypeScript for
  express-ts/nextjs-ts/node-ts/react-native, Python for fastapi/django, Go for go-http, Dart for flutter, Java for
  java-spring, Rust for rust-axum, C++ for cpp-cmake; `tags` = 2-5 generic
  lowercase tags; `source` = {"dataset": <candidate source>, "source_id": <candidate source_id>, "license": <candidate
  license>, "original_vendors_named": [vendors/packages the question named]}.

## Output and validation
Write ONLY accepted tasks as a JSON array to the output path, using a small Python script (json.dump,
ensure_ascii=False) built up in batches of ~25 candidates. Then run
`python3 vault/build/check_curated.py <chunk> <output>` and fix every problem until
it prints OK. Keep helper scripts out of the output directory. Report back only: candidates, accepted, placed, and the
validator's final line.
