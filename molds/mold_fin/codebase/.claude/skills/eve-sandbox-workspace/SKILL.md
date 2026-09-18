---
name: eve-sandbox-workspace
description: Give a subagent its own sandbox with parsers installed and deterministic scripts, schemas and validators seeded into /workspace. Use when a subagent needs to parse PDFs, spreadsheets or decks, do arithmetic or unit conversion, validate what it writes, or when someone says "add a script to the X subagent", "the sandbox is missing pdfplumber", "finlib drifted", "where do the scripts go", or `npm run check:fin-workspace` / `npm run check:subagents` reports a script without --self-test, a missing validator or a schema problem. Covers sandbox/sandbox.ts vs sandbox.ts, bootstrap that fails loudly, why helper source is inlined, the shared finlib and its sync, the script contract, content-type detectors and validators.
---

# The sandbox workspace of a subagent

The model decides; scripts compute. All arithmetic, unit conversion, period parsing,
reconciliation, classification by regex, file naming and validation is a Python script that
the subagent runs with its built-in `bash` tool. Read `node_modules/eve/docs/sandbox.mdx`
first; what follows is how this codebase uses it.

## What eve gives you

- Every agent has exactly one sandbox, a filesystem rooted at `/workspace`. The built-in
  `bash`, `read_file`, `write_file`, `glob` and `grep` tools run there.
- A declared subagent's sandbox *"does not inherit from the parent; it falls back to the
  framework default unless the subagent authors"* its own. The root's parsers are not in
  the child's sandbox.
- Two layouts. `sandbox.ts` at the agent root is the shorthand: *"Use it when you need only
  a definition, no seeded files."* Seeding *"requires the folder layout
  (`agent/sandbox/sandbox.ts`), not the top-level shorthand"*. If both exist the folder
  layout wins, which hides the mistake; the checker therefore fails a workspace subagent
  that still has a top-level `sandbox.ts`.
- *"Every file under `workspace/` mirrors into the sandbox cwd with its structure intact,
  and eve lists the top-level entries to the model in the prompt automatically."* So the
  model sees `scripts/` and `schemas/` exist without being told.
- `bootstrap({ use })` is template-scoped: it runs once when the template is built and
  every later session inherits the filesystem. `onSession` runs per session. Parsers are
  installed in `bootstrap`.
- A session's sandbox is replaced only when *"the authored sandbox source, workspace seed
  content, or `revalidationKey`"* changes. Editing a seeded script therefore rotates the
  template by itself, and an open session's *"next turn starts from the rebuilt template"*.
  Do not rely on scratch files a session left under `/workspace`; anything worth keeping is
  written to the data room.
- `agent/lib/` *"stays import-only source code and never reaches the workspace"*. Python
  helpers cannot live there.

## Layout

```
agent/subagents/<key>/sandbox/
  sandbox.ts                       defineSandbox: install parsers in bootstrap, fail loudly
  workspace/
    scripts/<name>.py              -> /workspace/scripts/<name>.py
    scripts/finlib/**              -> /workspace/scripts/finlib/   (synced copy, never edit)
    schemas/<file>.schema.json     -> /workspace/schemas/<file>.schema.json
```

`agent/subagents/<key>/scripts/README.md` and `schemas/README.md` are one-line pointers to
`sandbox/workspace/`. The operator's rulebook `schemas/<name>-spec.md` stays outside the
workspace: it is for people and for `instructions.md`, not for the sandbox.

## `sandbox/sandbox.ts`

Copy `agent/subagents/hfc-kpi-extraction/sandbox/sandbox.ts` and change the package list
and the subagent's name in the error messages. Three properties are not negotiable:

1. **It fails loudly.** The install script ends by importing every module and exits 1 with
   pip's log tail if any is missing; `bootstrap` throws on a non-zero exit. A swallowed
   install once produced a template that looked fine and then failed every run with an
   import error far from the cause.
2. **Helper source is inlined as string constants in this file**, not imported from
   `agent/lib/`. eve derives the template key from this file's source hash (plus the seed
   contents and `revalidationKey`). An imported helper could change without rotating the
   template, leaving the deployed snapshot silently stale.
3. **The module check list and the package list match.** The import name differs from the
   pip name for some packages (`pptx` / `python-pptx`, `docx` / `python-docx`); the check
   line carries both.

Install only what the scripts import: `pdfplumber` and `pypdf` for PDFs, `openpyxl` for
XLSX, `python-pptx` for decks. OCR engines are not installed; a scanned PDF is detected and
reported, not read (that is an Absence skill, see eve-subagent-skills).

Do not set `networkPolicy: "deny-all"` on a subagent that uses
`dataroom_fetch_to_sandbox`: that tool hands the model a `curl` command against a
short-lived URL, and the download runs inside the sandbox.

## The shared `finlib`

eve has no shared-workspace mechanism, so each subagent carries its own copy of the shared
helpers. The single source is `scripts/fin-workspace/finlib/`:

| Module | Provides |
|---|---|
| `numbers` | `parse_number` (Indian grouping, brackets, `%`, `x`; unparseable gives `None`), `is_blank`, `pct_diff` |
| `units` | `detect_unit` from a header line, `to_crore` |
| `periods` | `normalise`, `previous_quarter`, `derive_quarter`, `cumulative_label` |
| `schema` | `validate` (JSON Schema subset), `read_jsonl`, `validate_jsonl` |
| `pdfdoc` | `sniff`, `classify_text_layer`, `page_texts`, `find_pages`, `outline` (parsers imported lazily) |

`schema.validate` supports `type` (including lists and `null`), `required`, `properties`,
`additionalProperties: false`, `enum`, `const`, `pattern`, `minimum`, `maximum`,
`minLength`, `items`, and `allOf` with `if`/`then`. Write schemas inside that subset, or
extend `finlib/schema.py` and its self-test first.

```bash
npm run sync:fin-workspace     # copy finlib into every subagent listed in FIN_SUBAGENTS
npm run check:fin-workspace    # exit 1 if any copy differs from the source
PYTHONDONTWRITEBYTECODE=1 python3 -m finlib.selftest   # run from scripts/fin-workspace/
```

A new subagent that uses `finlib` must be added to `FIN_SUBAGENTS` in
`scripts/sync-fin-workspace.mjs:11`, or the sync never writes its copy. Never hand-edit a
copy: the next sync deletes and replaces the directory. If every subagent needs a new
helper, add it to the source with `_self_test` cases, register the module in
`finlib/selftest.py`, then sync.

Scripts import it like this (the script's own directory is on the path first):

```python
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from finlib import numbers, units, periods, schema, pdfdoc
```

and read schemas from `os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "<file>.schema.json")`.

## The script contract

Every `sandbox/workspace/scripts/*.py` meets all of these.
[`references/validate_template.py`](references/validate_template.py) is a working example
you can copy.

- `argparse` with `--help`. Input from file arguments or stdin (`-`).
- JSON on stdout, and nothing else on stdout.
- Problems go to stderr in plain words, with a non-zero exit. Keep "the input is invalid"
  (exit 1) apart from "I could not run" (exit 2).
- `--self-test` runs built-in cases with **no input files and no third-party parser**, and
  exits 0 or 1. This is what `npm run check:subagents` and the functional lane run, on a
  machine that has no `pdfplumber`.
- Standard library plus `finlib` only. `pdfplumber`, `pypdf`, `openpyxl` and `pptx` are
  imported **lazily, inside the function that opens a real document**, so `--help` and
  `--self-test` work without them.
- It never guesses. An unparseable or ambiguous value is reported as such (`null` plus a
  reason), never coerced. Two candidate values is `ambiguous`, not the first one.
- Deterministic: no clock, no network, no randomness in the result.
- It is named in `instructions.md`'s Scripts table or in a skill, with the exact command.
  The one exception is a helper module that sibling scripts import (`from ar_common import
  ...`): the model never runs it, so it need not be documented, but it still needs
  `--self-test`.

Each subagent has at least:

| Kind | Naming | What it answers |
|---|---|---|
| **Content-type detector**, one per input kind | `detect_<input>.py` | What is this file really (sniff the bytes, do not trust the extension)? Does the PDF have a text layer or is it scanned? Which pages hold which statement? Which unit line applies? The skills' "Recognise it" sections branch on its output. |
| **Validator**, one per written file | `validate_<file>.py` | Does every row match the schema **and** the domain rules a schema cannot express: cross-field sanity, a citation on every value, a footnote on every derived or carried-forward value, excluded content absent, no duplicates? |
| **Calculators and reconcilers** | by what they compute | Whatever the rulebook implies: unit conversion, Q4 = FY − 9M, the conflict threshold between two sources, ratios, file naming. |

## Schemas

Every `.jsonl` or `.json` the subagent writes has
`sandbox/workspace/schemas/<file>.schema.json` with a top-level `"type"`,
`"additionalProperties": false`, an `enum` for the status vocabulary, and `allOf`/`if`/`then`
for "when status is X, field Y is required". The validator loads it from `../schemas/`.
The checker requires that each `<name>.jsonl` mentioned in `instructions.md` is named in
the source of some `validate_*.py`.

## Check

```bash
for f in agent/subagents/<key>/sandbox/workspace/scripts/*.py; do PYTHONDONTWRITEBYTECODE=1 python3 "$f" --self-test || echo "FAILED $f"; done
npm run check:fin-workspace
npm run check:subagents -- <key>
```

`PYTHONDONTWRITEBYTECODE=1` keeps `__pycache__` out of the seeded tree (it is gitignored,
but it would be seeded into a locally built sandbox).

## Never

- Never import a Python helper from outside `sandbox/workspace/`. It will not exist in the sandbox.
- Never let bootstrap succeed when a parser is missing.
- Never put a secret in a seeded file or in `bootstrap`. Seeds are in the repository and the template.
- Never make `--self-test` depend on a sample filing in the repo. Real filings are not committed.
