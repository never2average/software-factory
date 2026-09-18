# mold_fin: build brief for the four subagent workspaces

Read first:

- `/root/software-factory/.claude/skills/subagent/SKILL.md` (the standard)
- the subagent's own `instructions.md`
- `agent/subagents/hfc-kpi-extraction/schemas/kpi-spec.md` (the analysts' rulebook; it binds all four subagents)
- eve's docs at `/root/software-factory/molds/mold_v1/codebase/node_modules/eve/docs/{skills.mdx,sandbox.mdx,subagents.mdx}`

Domain: Indian housing finance companies (HFCs), equity-listed and debt-listed ("unlisted"). The sources are SEBI
LODR filings and investor presentations, and amounts are reported in Rs crore.

## Your write scope

Your write scope is exactly `agent/subagents/<your-key>/`.

- Do not touch other subagents, `scripts/fin-workspace/`, package.json or the root agent.
- `sandbox/workspace/scripts/finlib/` is a synced copy, so never edit it. If finlib lacks something every
  subagent needs, say so in your report.

## Layout

```
skills/<skill-name>/SKILL.md          frontmatter: --- description: Use when ... --- ; body per the standard
skills/<skill-name>/references/*.md   heading lists, label synonym tables, regex tables, worked examples
sandbox/workspace/scripts/*.py        run in the sandbox as: python3 /workspace/scripts/<name>.py ...
sandbox/workspace/schemas/*.schema.json
```

In the sandbox the scripts sit at `/workspace/scripts/`, and `finlib` is importable when the script starts with:

```python
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from finlib import numbers, units, periods, schema, pdfdoc
```

Schemas are read by scripts from `os.path.join(os.path.dirname(__file__), "..", "schemas", ...)`.

finlib provides:

- `numbers.parse_number`, `numbers.is_blank`, `numbers.pct_diff`
- `units.detect_unit`, `units.to_crore`
- `periods.normalise`, `periods.previous_quarter`, `periods.derive_quarter`
- `schema.validate`, `schema.read_jsonl`, `schema.validate_jsonl`
  - JSON-Schema subset: type, required, properties, additionalProperties, enum, const, pattern, minimum,
    maximum, minLength, items, and allOf with if/then
- `pdfdoc.sniff`, `pdfdoc.classify_text_layer`, `pdfdoc.page_texts`, `pdfdoc.find_pages`, `pdfdoc.outline`

## Script contract

Every script must meet all of these:

- It uses argparse with `--help`.
- It prints JSON to stdout.
- Problems go to stderr with a non-zero exit.
- It has `--self-test`, which runs built-in cases with no input files and no pdfplumber or pypdf, and exits 0 or 1.
- It uses the Python standard library only. pdfplumber, pypdf, openpyxl and python-pptx are imported lazily, inside
  the functions that read a real document.
- It never guesses. An unparseable or ambiguous value is reported as such.

Run every `--self-test` yourself before reporting.

## Skills

Write one skill per format variation or multi-step procedure. Write from knowledge of how these documents are
generally laid out.

- Do not state facts about a specific named company's filings or numbers.
- Do not invent regulation text.
- Where a regulation or format detail might have changed, tell the agent to trust the document in front of it and
  report the difference.
- Include worked examples with clearly synthetic numbers (company "Example Housing Finance Ltd").
- Every skill names the exact script command it uses.

## Finish

Finish by rewriting the subagent's `instructions.md`:

- Keep its rules.
- Add a "Skills" table (skill, load it when) and a "Scripts" table (script, purpose).
- Add the rule that validation runs before anything is written to the data room or published.

Replace `schemas/README.md` and `scripts/README.md` with one-line pointers to `sandbox/workspace/`. Remove
`skills/README.md`.

## Report

Report the files written, the self-test output, anything in the rulebook you found ambiguous, and anything you
want added to finlib.
