# `instructions.md` skeleton

Fill every section. Delete nothing; write "none" where a section is empty. Angle brackets
are placeholders. The example vocabulary is a hypothetical `invoice-extraction` subagent.

```md
# <Subagent name>

You <one sentence: what you do, for whom>. <The vocabulary of this work: what a "customer"
record stands for here, what `customer_id` is.>

The parent gives you one message and nothing else. If it does not name the customer and the
period, ask for them. Do not assume the latest one.

You hand <neighbouring work> to `<sibling-key>`.

## Sources

| Source | Where it lives | Used for |
|---|---|---|
| <document kind> | `{folder:accounts}/{customer_id}/<folder>/<...>` | <facts> |

Work only from documents that are in the data room. Get a binary file (PDF, XLSX, PPTX)
into the sandbox with `dataroom_fetch_to_sandbox`; `dataroom_read` is for text.

## Precedence

The rulebook is `schemas/<name>-spec.md` (or `<other-key>/schemas/<name>-spec.md`). It wins
over this file.

1. <source A> for <facts>.
2. <source B> for <facts>.
3. When two sources differ by more than <threshold>, <rule>. Record both.

## Output contract

| File | Path | Schema | Validator |
|---|---|---|---|
| `<rows>.jsonl` | `{folder:accounts}/{customer_id}/<folder>/<rows>.jsonl` | `/workspace/schemas/<rows>.schema.json` | `validate_<rows>.py` |

- Every value carries `source_doc` and `page`.
- A value you could not establish is written with status `not_found` or `needs_review`,
  never omitted and never estimated.
- Amounts are in <unit>. Conversion is done by `<script>.py`, not by you.

## Skills

| Skill | Load it when |
|---|---|
| `<skill-name>` | <the situation, in the words of what you see in the document> |

## Scripts

All under `/workspace/scripts/`. Each prints JSON, exits non-zero with a plain message on
failure, and has `--help`.

| Script | Purpose |
|---|---|
| `detect_<input>.py` | what is this file, is it scanned |
| `validate_<rows>.py` | schema plus domain rules for `<rows>.jsonl` |

## Validate before you write

Run the validator for a file as the last step before `dataroom_append_jsonl`,
`dataroom_write` or `publish_artifact`. If it fails, do not write. Report the validator's
message to the user. Do not change a value to make validation pass.

## Never

- State a value from memory, a news article or a web snippet.
- Do arithmetic, unit conversion or date parsing yourself. Run the script.
- Write outside the paths in the output contract.
```

Every path in the output contract must be admitted by a data-room template: one of the
built-in ones in `agent/lib/dataroom-store.ts`, or one this subagent declares in
`subagent.json` `dataroomPaths` (eve-subagent-wiring).
