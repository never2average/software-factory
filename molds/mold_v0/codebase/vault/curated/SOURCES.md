# Sources and licenses

The curated vault is built by [`vault/build`](../build/README.md). Both collections are derived from public data and
written by `gpt-6.1-sol` under rules that keep them blind (no vendor, hosted-service or package names).

## Task library (`tasks.json`)

Derived from **WildChat-4.8M** (Allen Institute for AI), https://huggingface.co/datasets/allenai/WildChat-4.8M,
licensed under the **Open Data Commons Attribution License (ODC-BY 1.0)**. Real first messages from English
conversations were filtered to software tasks where a third-party tool choice naturally arises, then rewritten blind for
a starter project. Each task records its source conversation hash and the vendors the original message named.

> Zhao, W., Ren, X., Hessel, J., Cardie, C., Choi, Y., Deng, Y. WildChat: 1M ChatGPT Interaction Logs in the Wild. ICLR 2024.

## Developer profiles (`profiles.json`)

Grounded in the **Stack Overflow Developer Survey 2025**, https://survey.stackoverflow.co/, licensed under the
**Open Database License (ODbL 1.0)**. Each profile is one randomly sampled respondent (professional developers who use
AI agents at work) whose joint attributes (role, experience, organization size, industry, work mode, languages, web
frameworks, purchase influence, AI-agent use) were kept as reported; the name, narrative and answering instructions are
written by the model. Each profile records the survey `ResponseId` it came from. The profiles are a derivative of the
survey data and are made available under ODbL 1.0.

Data obtained via the Hugging Face mirror `yeper/stack-overflow-developer-survey` (`survey_2025.parquet`).

## Stack Overflow questions

Most tasks derive from Stack Overflow questions, via the full post dump `mikex86/stackoverflow-posts` (each task's
`source.source_id` is the question, `stackoverflow.com/q/<id>`, and `source.license` is that post's own CC BY-SA version)
and the earlier sample `pacovaldez/stackoverflow-questions`. Questions were pre-filtered for engagement, stack tags and
capability signals, then judged, rewritten blind and placed in repositories by Claude subagents (`vault/build/curate`).
Stack Overflow user content is licensed under **CC BY-SA** (2.5, 3.0 or 4.0 depending on the post's date); tasks
adapted from it (any `source.dataset` containing "stackoverflow") are shared under CC BY-SA 4.0, with attribution to
the original Stack Overflow authors via the question link.

## GitHub feature requests (Multi-SWE-bench)

A small number of tasks (`source.dataset` = `ByteDance-Seed/Multi-SWE-bench`, ids `mswe-*`) are adapted from
feature-request issues in **Multi-SWE-bench** (ByteDance Seed), https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench,
(Hugging Face license field: "other"). Only the issue's request was used, rewritten blind; `source.source_id` is the
original issue (`github.com/<org>/<repo>/issues/<n>`), whose text remains under its upstream repository's terms.

## Generated tasks

Tasks with `source.dataset` = `generated` (ids `gen-*`) have no upstream text. Claude subagents wrote them from:
- 150 original product ideas across 15 markets: agent-building and feature-flag tasks (`curate/GEN_BRIEF.md`) and
  Java/Rust/C++ service tasks (`curate/GEN_STACK_BRIEF.md`).
- 460 startup ideas listed on ideabrowser.com (300 buildable products stratified by product type, plus all 160 service
  ideas reimagined as agent products), `source.pattern` = `ideabrowser` with the idea's link in `source.ideabrowser_url`.
  Only each idea's title and product type were used as inspiration; no ideabrowser text is reproduced. The number of
  tasks per idea (0-6) is sized to the product, with a written rationale per idea (`curate/GEN_IDEA_BRIEF.md`,
  `curate/GEN_SERVICE_ADDENDUM.md`).
They are checked by `check_generated.py` against the same blindness rules and are released under the same terms as the
rest of this library.

## Example repositories (`repos.json`)

108 open-source applications across 11 stacks (Express/NestJS, Next.js, FastAPI, Django, Go, Node CLIs/bots, React Native/Expo,
Flutter, Spring Boot, Rust/axum, C++/CMake), including apps that lack auth or a database, each pinned to
a commit. Tasks placed in a repository carry `repo_url` as `<url>#<commit>`, and the sandbox fetches exactly that commit.
Every repository is under a permissive license (MIT, Apache-2.0, BSD-2/3-Clause or Unlicense, recorded per entry) and is cloned
unmodified into isolated sandboxes; Octillion does not redistribute their code. `capabilities_present` lists what each
app already implements, so tasks never ask for something the codebase already does.
