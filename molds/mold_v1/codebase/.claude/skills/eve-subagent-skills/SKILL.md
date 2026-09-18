---
name: eve-subagent-skills
description: "Author the skill packages inside a subagent (agent/subagents/<key>/skills/<skill>/SKILL.md plus references/) so the model loads the right procedure for each way its input varies. Use when writing or reviewing a subagent's skills, when someone says \"add a skill to the X subagent\", \"the agent misread a document that was laid out differently\", \"teach it to handle scanned PDFs / a different number format / multi-page tables\", or when `npm run check:subagents` reports too few skills, a missing or unquoted description, a missing worked example or a skill not named in instructions.md. Covers eve's load_skill mechanics, per-agent scoping, the format-variation checklist, the required sections, worked-example rules and anti-patterns."
---

# Author skills for a subagent

Note the two kinds of "skill" in this repository. `.claude/skills/` (this file) is read by
the coding agent working on the codebase. `agent/subagents/<key>/skills/` is read by the
**deployed eve agent** at runtime. This skill is about the second kind.

## How eve loads a skill

From `node_modules/eve/docs/skills.mdx`; re-read it if eve has been upgraded.

- eve scans the agent's `skills/` directory and *"exposes each one's description to the
  model alongside a framework-owned `load_skill` tool"*. Only the description is in context
  until the model calls `load_skill`; then eve appends that skill's markdown to the turn.
  This is why a subagent can carry ten procedures without paying for them on every turn.
- *"The description is a routing hint, not a label. Write it as the task that should
  trigger activation."* Start with `Use when ...` and describe what the model can **see**
  at that moment ("the totals row appears on a later page than the line items"), not the
  topic ("table handling").
- A packaged skill is a directory with `SKILL.md` plus siblings such as `references/`.
  *"The packaged `SKILL.md` must carry `description` frontmatter; it has no filename slug to
  fall back on."* The skill's name is the directory name.
- At runtime the package is placed at `$HOME/.agents/skills/<skill>/` (fallback
  `/workspace/skills/<skill>/` when `$HOME` is unavailable). `load_skill` reads `SKILL.md`
  only. A reference such as `references/labels.md` resolves relative to that skill's
  directory, and the model opens it with `bash` or `read_file`. So say in the body *when*
  to open each reference; nothing loads it automatically.
- *"Loading a skill adds instructions, never a new execution surface."* A skill cannot add
  a tool. The executable part of a skill is a script in the sandbox
  (eve-sandbox-workspace), named by exact command in the skill.
- **Scoping.** *"A subagent's `skills/` are invisible to the root agent, and the reverse
  holds too. There's no shared-skill mechanism."* When two subagents need the same
  procedure, copy the markdown under each `skills/` directory. Shared *code* goes in a
  shared helper family under `scripts/subagent-shared/<family>/` (synced into each
  sandbox) or, for TypeScript, `agent/lib/`.
- Anything directly under `skills/` that ends in `.md` is a flat skill. A leftover
  `skills/README.md` (the legacy subagents have one) is discovered as a skill called
  `README`. Delete it once real skills exist. `scripts/gen-subagent-meta.mjs` uses that
  file only as an optional one-paragraph summary for the Control Panel; without it the
  panel still lists the skill names.

Skills may sit under `skills/<skill>/scripts/` in the wider Agent Skills convention, but in
this codebase scripts live in `sandbox/workspace/scripts/` so they land at the stable path
`/workspace/scripts/` and are covered by the checker's `--self-test` run.

## List the variations before writing

Write a skill for each case where the same fact arrives in a different shape, and for each
procedure with more than three steps. Aim for six to ten per subagent (the checker requires
six). For a document-reading subagent, walk this checklist and write down the concrete
cases first:

| Axis | Ask | Typical cases |
|---|---|---|
| **Layout** | Does the same document come in different templates? | a table split across pages; two entities side by side or one after the other; a note that changes a headline value |
| **Encoding** | Can I get text out of it at all? | text PDF vs scanned image; a deck vs its PDF export; a spreadsheet vs a PDF of it |
| **Units and number formats** | What does `1.234,56` or `1,23,456` mean here? | thousands vs millions; regional digit grouping and decimal marks; brackets for negatives; `-` vs `NA` vs blank |
| **Period and dates** | Which period is this column? | a single period vs a cumulative one; day-first vs month-first dates; restated comparatives |
| **Vocabulary** | Is this the field I think it is? | one field under several labels; one label with different definitions between issuers |
| **Entity** | Whose document is this? | a parent vs a subsidiary; a supplier's trading name vs legal name |
| **Absence** | What if it is not there? | the value is not disclosed; the document is not in the data room; a value shown only on a chart |

Each axis that applies gets at least one skill. "Absence" always applies: every subagent
needs a skill for what to write and report when the fact cannot be established.

## Required sections of a `SKILL.md`

[`references/skill-template.md`](references/skill-template.md) is a copyable skeleton.

1. **Frontmatter `description`**, phrased as the situation that triggers loading.
2. **Recognise it.** How the model tells this variation from its neighbours, including the
   detector script to run and which field of its JSON output decides.
3. **Procedure.** Numbered steps. Every computation is a script call, written as the exact
   command: `python3 /workspace/scripts/<name>.py <args>`. The checker requires at least
   one such command per skill and that the script exists.
4. **What to write.** Which file, which fields, which status value, which footnote.
5. **Worked example**, under a heading containing the words `Worked example`. Input as it
   appears, the command, the JSON it prints, the row written.
6. **When it cannot be done.** The failure modes, and the exact status and sentence to
   report. Never "try your best".

Then add the skill to the **Skills table in `instructions.md`**. eve advertises the
description on its own, but the table is where the subagent is told how skills relate to
its workflow ("after `detect_pdf.py` says `scanned`, load `scanned-pdf`"). The checker
fails a skill whose directory name does not appear in `instructions.md`.

## Worked-example rules

- Synthetic data only. The organisation is "Example Trading Co."; numbers are obviously
  round or patterned. Never a real organisation's figures: a model will quote them as fact.
- Do not state facts about a specific named organisation's documents, and do not invent
  regulation text. Where a regulation or format might have changed, tell the agent to trust
  the document in front of it and report the difference.
- The example's command output must be what the script really prints. Run it and paste.
- Show at least one example that ends in a refusal (`not_found`, `needs_review`), so the
  model sees that not answering is a correct outcome.

## References

Put in `references/` what is looked up rather than followed: label synonym tables, heading
lists, regex tables, unit phrase lists, long worked examples. Keep `SKILL.md` to what is
needed on every use of the skill; a reference is opened only when the body says so. If a
script needs the same table, the script owns it and the reference documents it; never two
hand-maintained copies. The checker fails a `SKILL.md` that points at a `references/` file
which does not exist.

## Anti-patterns

- A topic label as the description ("PDF handling"). The model will not route on it.
- One giant skill per subagent. Nothing is saved over putting it in `instructions.md`.
- A skill that restates the rulebook. Rules live in `schemas/<name>-spec.md` and are
  restated once in `instructions.md`; a skill says how to apply them to one shape of input.
- Arithmetic in prose ("divide by 1000 to get thousands"). That is a script with a self-test.
- "If unsure, estimate." The script contract is *never guess*; the skill's is the same.
- A command that does not exist, or a path other than `/workspace/scripts/`.
- Relying on a reference being in context. It is not until the model reads it.
- Skills that assume the parent's conversation. The child sees only the message.

## The description must be valid YAML

`eve build` parses the frontmatter as YAML and rejects the whole skill on an error.

- A description that contains `: ` (colon then space), contains ` #`, or starts with a YAML
  indicator character must be wrapped in double quotes (escape inner double quotes as `\"`).
- `npm run check:subagents` fails an unquoted one.
- `npm run build:eve` is the final word: run it after writing skills, not only the checker.

## Check

```bash
npm run check:subagents -- <key>
npm run build:subagent-meta        # the Control Panel lists each subagent's skills
npm run build:eve                  # no "Error:" lines
```
