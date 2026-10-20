# Product onboarding: prompt + link + docs → profile, personas, problems → runs

A dev-tool company describes its product in three things: a **prompt** (what it is and for whom), a **link**
(website) and **documentation** (docs URL). The rest is automatic:

1. **Research.** The orchestrator (Pi, the same brain that plays the developer) reads the website and docs and builds
   a **detailed product profile**: name, category, description, key features, aliases, package names (npm, PyPI,
   etc.), domains, and **competitors** (with their packages and domains).
2. **Personas.** It derives the **target developer personas** who would plausibly need the product: role,
   experience, company size, stack, constraints and tone, plus instructions for how each answers a coding agent's
   questions.
3. **Problems.** It **searches** the curated task library for fitting tasks and **creates** new realistic
   programming problems where the product could be a recommended solution. Each problem is phrased the way a
   developer would ask a coding agent, never naming the product, its packages or its domains. It may add a few
   `avoid` problems where the product should not be the answer.
4. **Runs.** The server saves everything (product context, product-scoped personas, scenarios) and, unless turned
   off, launches a representative simulation across the coding-agent mix with those personas.

```
customer (Claude/ChatGPT) ── onboard_product{prompt, website_url, docs_url} ──▶ server: product + research job
orchestrator ── claim research ─▶ Pi research session ─ fetch_url / web_search / find_similar / package_search / search_library / validate ─▶ submit
server ── apply: product profile, personas, scenarios ──▶ run_simulation (coding agents × personas × samples)
customer ── get_onboarding / get_visibility_report ──▶ results
```

## MCP tools (customer)

`onboard_product` `{prompt, website_url?, docs_url?, name?, run?: true, samples?}` → research id, status.
`get_onboarding` `{research_id? | product?}` → stage, generated profile, personas, scenarios and the simulation.

## Worker API (orchestrator; Bearer `OCTILLION_WORKER_TOKEN`)

- **`POST /api/worker/research/claim`** `{worker_id, limit?}` →
  `{jobs: [{research_id, input: {name?, prompt, website_url?, docs_url?}, limits}]}`.
  `limits` holds `{max_personas, max_scenarios, min_scenarios, max_competitors}`.
- **`POST /api/worker/research/:id/progress`** `{stage, note?}` is the heartbeat. Stages: `reading`, `profiling`,
  `personas`, `problems`, `validating`.
- **`GET /api/worker/library/tasks?query=&category=&language=&limit=`** searches the curated task library.
- **`POST /api/worker/research/:id/validate`** `{result}` → `{ok, issues: [...]}`. Dry run; nothing is saved.
- **`POST /api/worker/research/:id/complete`** `{status: "completed" | "failed", error?, result?}` →
  `{product, personas, scenarios, simulation_id?}`, or 422 `{issues}` when the result is invalid. Revise and resubmit.

`result`:
```json
{ "product": { "name": "…", "description": "…", "category": "…", "website_url": "…", "docs_url": "…",
               "features": ["…"], "aliases": ["…"], "packages": ["…"], "domains": ["…"],
               "competitors": [{"name": "…", "aliases": [], "packages": [], "domains": [], "evidence_url": "…"}] },
  "personas": [{ "name": "…", "summary": "…", "attributes": {"role": "…", "experience_years": 5, "company_size": "…",
                 "stack": ["…"], "constraints": ["…"], "tone": "…"}, "instructions": "…",
                 "environment": {"editor": "zed", "tools": ["cli/gh", "cli/psql"],
                                 "skills": [{"name": "testing-conventions", "description": "…", "body": "…"}], "agent_rules": "…"} }],
  "scenarios": [{ "title": "…", "prompt": "…", "language": "…", "tags": ["…"], "expectation": "recommend" | "avoid",
                  "rationale": "why the product fits (or not)", "variants": {"<persona name>": "…"},
                  "decision": {"need": "…", "options": [{"kind": "product"}, {"kind": "competitor", "name": "…"}, {"kind": "build"}],
                               "why_intrinsic": "…", "evidence_url": "one of the sources"}, "library_task_id": 12, "repo_url": null }],
  "sources": [{"url": "…", "title": "…"}] }
```

**Validation** (the same rules apply on `validate` and `complete`):
- **Every problem must create a purchase decision on its own.** Its requirements (volume, reliability,
  deliverability, compliance, time to ship) force a choice between buying a service, adopting open source, or building
  it, and the wording leaves that choice to the agent. Rule checks:
  - the prompt (and every persona variant) may not use `product.category_terms` (2-8 words that name this kind of
    tool, e.g. "transactional email service", "email API");
  - it may not prescribe an outside service ("through a hosted service") or ban options ("offline", "no external
    requests", "no new dependencies"). Real constraints such as data residency or a zero budget are fine;
  - `decision` `{need, options, why_intrinsic, evidence_url}` is required. Options include the product, at least one
    alternative (competitor, cloud or open_source) and build or none. A "recommend" problem's `evidence_url` must be
    one of the research's sources showing the product really does what this problem needs.

  On top of the rules, the research orchestrator runs a **task review** (`orchestrator/pi-octillion/critic.ts`): a
  separate, tool-less model call that rejects problems with no intrinsic decision, problems whose wording decides it,
  and problems phrased in one vendor's feature vocabulary. Its findings go back to research as issues, at most two
  rounds per job. Library tasks must pass the same rules, so research rewrites or drops those that name the category.
  Why: in the first Resend run, three of five tasks named the category ("through a transactional email service"), the
  control said "work completely offline", and the inbound-email task used Postmark's feature names, so the result
  measured the wording more than the agents.
- **Scenario prompts must not name the product.** No name, alias, package or domain (a whole-word,
  case-insensitive match), and no competitor names either, so as not to lead the agent.
- **Counts:** `min_scenarios` ≤ scenarios ≤ `max_scenarios`, 1 ≤ personas ≤ `max_personas`, at least one `recommend`
  scenario, and prompts of 40–2000 characters.
- **Product fields:** at least one alias, package or domain beyond the name, so detection has something to match;
  competitor names must be distinct from the product.
- **Competitors come from evidence, not memory** (`src/websearch.ts`). Research has `web_search` and `find_similar`
  (Exa: "alternatives to X", sites like the product's) and `package_search` (npm and crates.io free; PyPI, Go, Maven
  and others via libraries.io), with usage numbers. Searches run on the server, capped per job
  (`RESEARCH_MAX_SEARCHES`, default 20); the keys never reach the research sandbox. Every result URL is recorded on the
  job (`product_research.sources`) and becomes fetchable; when search is configured, each competitor's `evidence_url`
  must be one of those URLs or a page on the product's own site. Keys: `npm run keyvault -- set exa` and
  `npm run keyvault -- set libraries_io` (orchestrator-only providers). Keys are read from the vault only; an `EXA_API_KEY` / `LIBRARIES_IO_API_KEY` left in the environment is imported into the vault once on boot (src/keyvault-env.ts).
- **Runs check the list too.** Scoring records the packages each agent installed that match neither the product nor a
  tracked competitor (`agent_sessions.untracked`); the report lists those from "no vendor" sessions under "Installed
  but not tracked", with an "Add as competitor" button. The dashboard shows each competitor's evidence and who added
  it (research, the customer, or runs), with a Remove button.
- **Personas** must not mention the product or its competitors (they answer the agent blind).
- **Persona `environment`** `{editor, tools, skills, agent_rules}`: the editor and CLI tools come from the catalog in
  `orchestrator/core/environment.ts`. Skills (at most 6, `name` lowercase-hyphenated, `body` 40-4000 characters) and
  `agent_rules` (at most 3000 characters) are the developer's own agent setup, scaled by seniority. None of it may name
  the product or a competitor. It is installed into the coding agent's harness for every session of that persona
  (orchestrator/README.md, Developer environments).
- **Scenario `variants`** `{persona name: prompt}`: the same problem in each persona's words, under the same blindness
  and length rules as `prompt`. A session uses its persona's version.
