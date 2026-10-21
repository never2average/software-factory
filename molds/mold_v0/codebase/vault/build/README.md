# Curated vault build

Builds `vault/curated/profiles.json` and `vault/curated/tasks.json` from public data. Every model call uses
`gpt-6.1-sol`, with a disk cache (re-runs only pay for new inputs) and a hard spend cap (`VAULT_BUILD_BUDGET`, default $15).

```bash
python -m venv .venv && .venv/bin/pip install pyarrow pandas huggingface_hub
export OPENAI_API_KEY=... VAULT_BUILD_WORK=/tmp/vault-work
export SO_SURVEY_PARQUET=/path/to/survey_2025.parquet   # Stack Overflow Developer Survey 2025, ODbL
# Tasks: WildChat-4.8M shards (one shard on disk at a time), then classify + blind rewrite + vendor check.
.venv/bin/python wildchat_extract.py $VAULT_BUILD_WORK/wc 0 86
.venv/bin/python tasks_build.py $VAULT_BUILD_WORK/wc/candidates.jsonl ../curated/tasks.json 50
# Personas: random respondents (professional developers who use AI agents at work), written blind.
.venv/bin/python so_personas.py ../curated/profiles.json 150
# Researcher personas: academic researchers, data scientists and applied scientists who use AI agents at work (many
# write code for their research rather than as developers). Sampled here; the drafts are written from the brief in
# FACTS.json, then merge checks them against their respondents and adds them to the profiles.
.venv/bin/python so_researchers.py sample 40 $VAULT_BUILD_WORK/researcher-facts.json
.venv/bin/python so_researchers.py merge $VAULT_BUILD_WORK/researcher-facts.json DRAFTS.json ../curated/profiles.json
```

Then load into Postgres: `VAULT_DIR=vault/curated npm run vault:sync`.

Rules the build enforces:
- Tasks and personas never name a vendor, hosted service, database product, cloud or third-party package (regex check
  against the survey's own database/platform/AI answer options plus well-known dev-tool vendors; failures are rewritten
  or dropped). Languages and the starter project's framework are allowed.
- Personal data is dropped at classification and stripped at rewrite.

Next source: [SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) (real Claude Code / Codex sessions,
ODC-BY, gated: accept its terms on Hugging Face with the account whose token this machine uses).

## More sources and round 2

- `so_extract.py`: Stack Overflow questions (`pacovaldez/stackoverflow-questions`, CC BY-SA 4.0) whose title asks how to
  add a capability (email, payments, feature flags, analytics, jobs, storage, ...). Code blocks and HTML are stripped.
- `round2.py`: unclassified WildChat candidates in thin categories + a quota-weighted Stack Overflow sample.

## Placing tasks in example repositories

`vault/curated/repos.json` lists 44 permissively licensed apps, pinned to commits, with the capabilities each already has.
Placement is done by Claude subagents, not a paid API:

1. `prep_place.py` merges task rounds, writes `vendors.json` and splits tasks into per-stack chunks (`place/*.json`).
2. One subagent per chunk rewrites each task into a fitting repo (same stack, capability not already present, balanced
   across repos), adds `repo_url` = `<url>#<commit>`, keeps the original as `generic_prompt`, and must pass
   `check_placed.py <chunk> <output>` (ids unchanged, exact pinned URL, no vendor names, no URLs/emails, length bounds).
3. `merge_placed.py` re-validates every chunk and writes the final library.

## Curation by subagents (full corpus)

The large corpus (5,500+ tasks) is curated by Claude subagents, not a paid API:

1. `so_full_extract.py` (full Stack Overflow dump, engagement + stack + capability pre-filter; DBMS, mobile and
   agent-building modes) and `wildchat_agents_extract.py` produce candidates for free.
2. `chunk_curate.py <wave>` splits new candidates into 150-item chunks; `make_queue.py` orders pending chunks by value.
3. One subagent per chunk follows `curate/BRIEF.md` (judge, blind rewrite, place into a pinned repo) and must pass
   `check_curated.py <chunk> <output>`.
4. `build_library.py` merges, dedupes, re-validates and caps placements at 25 per repo per category;
   `audit_library.py` checks the whole library before it ships.
