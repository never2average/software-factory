---
name: subagent
description: Build a specialist subagent inside a pack (never a mold fork) as a full workspace (instructions, skills for format variations, sandbox scripts, schemas, validators, tests), not as a single instructions file. Use whenever a product needs a new subagent or an existing one is only a prompt.
---

# Build a subagent as a full workspace

A subagent that is only `agent.ts` plus `instructions.md` is a prompt, not a specialist. It
fails the first time a source document is laid out differently from the one the author
pictured. The factory's standard is the workspace below. `packs.py verify` (the mold's own `check-subagents.py`) enforces it,
and a subagent that does not pass is not done.

**Subagents live in a pack, never in a fork.** Molds are general-purpose checkpoints. Stamping an application
never forks one.

- An application's own code is a **pack**, `packs/<pack_id>/`. It is a directory tree that only ADDS files to the
  application's build copy (`build/<app_id>/`).
- An application names its packs in its brief ("Packs: hfc-research") or inherits them from its product.
- `python3 .claude/scripts/packs.py` lists, checks, applies and verifies packs. `provision.py --deploy` applies them
  after the brand.

```
packs/<pack_id>/
  pack.json                                   pack_id, name, description, subagents[], shared_families[], state{corpus, workspace, persona_name, tone}
  files/agent/subagents/<key>/**              the subagent workspaces (section 2), each with a subagent.json (name, summary, dataroomPaths)
  files/agent/instructions/NN-pack-<id>.md    the root agent's section for this pack (eve loads it after agent/instructions.md)
  files/scripts/subagent-shared/<family>/**   shared sandbox helpers + targets.json
```

- A pack may add files only under those paths, and it never replaces a mold file.
- This works because the mold discovers subagents from their directories (`scripts/gen-subagent-meta.mjs`) and
  carries its own authoring skills (`codebase/.claude/skills/eve-*`), its own checker
  (`scripts/check-subagents.py`) and `docs/SUBAGENT_PACKS.md`.
- If a vertical genuinely needs a change to base code, that is a pull request to the mold's upstream, followed by
  a snapshot refresh. It is never a fork.

## 1. Get the operator's rulebook first

Before writing anything, ask the operator for the rules their people already follow:

- the definitions and formulas they use
- which source wins when two disagree
- units
- what to do when data is missing
- what to leave out

Keep the rules **verbatim** in `schemas/<name>-spec.md`. The instructions restate them. If
the two disagree, the spec wins and the instructions are the defect. Anything the rulebook
leaves open goes under an "Open points" heading in the spec, together with the behaviour
chosen in the meantime. Never resolve an open point silently.

## 2. The workspace

```
agent/subagents/<key>/
  agent.ts                      description written as a routing hint: when to delegate here
  instructions.md               identity, sources, precedence, output contract, which skill to load when
  instructions/00-mode.ts       copy from a sibling
  instructions/operator-override.ts   key = <key>
  hooks/usage.ts                WORKFLOW = "<key>"
  tools/*.ts                    the narrowest set that does the job; web_search only through the gated re-export
  skills/<skill>/SKILL.md       one per FORMAT VARIATION or procedure (see 3); frontmatter `description` required
  skills/<skill>/references/*   worked examples, heading lists, regex tables the skill points to
  sandbox/sandbox.ts            folder layout (not sandbox.ts), installs the parsers, fails loudly
  sandbox/workspace/scripts/*   runnable tools that land in /workspace/scripts (see 4)
  sandbox/workspace/schemas/*   JSON Schemas for every file the subagent writes (see 5)
  schemas/<name>-spec.md        the operator's rulebook, verbatim
  schemas/README.md, scripts/README.md   one line each, pointing at sandbox/workspace/
```

eve scopes everything per subagent: a subagent sees only its own skills, sandbox and tools.
Shared helpers are therefore kept once in the mold, in `scripts/<family>-workspace/`. A
sync script copies them into each subagent's `sandbox/workspace/scripts/`, and a check
fails when a copy drifts. Never hand-edit a synced copy.

## 3. Skills: one per way the input varies

Write a skill for each case where the same fact arrives in a different shape, and for each
procedure with more than three steps. Aim for six to ten per subagent. For document-reading
subagents, list the variations before writing:

- **Layout.** The same statement comes in different templates. Tables get split across
  pages. Standalone and consolidated appear side by side or one after the other.
- **Encoding.** Text PDF vs scanned image, PPTX vs PDF, XBRL/XLSX vs PDF.
- **Units and number formats.** Lakhs, crore, millions, billions. Indian digit grouping.
  Brackets for negatives. `-` vs `NA` vs blank.
- **Period.** Discrete quarter vs cumulative (H1/9M/FY), Q4 derived from FY − 9M, restated
  comparatives.
- **Vocabulary.** The same metric under different labels, or the same label with different
  definitions.
- **Entity.** Listed vs unlisted, subsidiary numbers inside a parent's document.
- **Absence.** Metric not disclosed, filing not in the data room, a figure shown only on a
  chart.

Each `SKILL.md` has these parts:

- `description` frontmatter, phrased as the situation that should trigger loading
- how to recognise the variation
- the procedure, including which script to run with the exact command
- what to write
- at least one worked example
- the failure modes and what to report when it cannot be done

`instructions.md` names every skill and when to load it.

### The always-on prompt budget (the mold tests this)

`instructions.md` is loaded on every turn, and the mold's context lane (`scripts/test-prompt-context.mjs`) holds
every subagent's file to three rules. The file must:

- be **at most 1,400 words** (aim for 1,350). Keep in it:
  - the rules, stated tersely
  - the output contract
  - the Skills table and the Scripts table, with one short clause per row

  Definitions tables, formula tables, worked detail and explanations belong in skills, which load on demand.
- contain `<!-- organization-policy -->` exactly once, followed by the workspace-isolation paragraph. Copy it from
  any built-in subagent.
- end with `<!-- stable-prompt-end -->`, exactly once, as the last non-blank line.

A pack keeps a `verify-instructions.sh` that checks these together with the naming rules. Run it before
`packs.py verify`. These rules were found the hard way on hfc-research (2026-09-19): all four files were 1,650 to
2,080 words with no markers, and the context lane reverted the application.

## 4. Scripts: deterministic work belongs in code

The model decides and the scripts compute. All arithmetic, unit conversion, period parsing,
reconciliation, classification by regex, file naming and validation is a script under
`sandbox/workspace/scripts/`. These scripts run with the Python standard library plus what
`sandbox.ts` installs.

Every script meets these requirements:

- `--help`, and input from files or stdin.
- JSON on stdout.
- A non-zero exit with a plain message on stderr.
- `--self-test`, which runs its built-in cases without any input files and exits 0 or 1.
  This is what the functional lane runs.
- It never guesses. An unparseable value is reported as unparseable.

Each subagent has at least these scripts:

- one **content-type detector** per input kind (what is this file, and is it scanned?)
- one **validator** per output file
- the **calculators and reconcilers** its rulebook implies

## 5. Schemas and validators: nothing is written unvalidated

Every `.jsonl`/`.json` the subagent writes has a JSON Schema in `sandbox/workspace/schemas/`.
It also has a validator script that checks the schema **and** the domain rules a schema
cannot express: cross-field sanity, citation present on every value, carried-forward values
carry a footnote, excluded content is absent.

The instructions make validation the last step before any `dataroom_append_jsonl` or
`publish_artifact`. A failing validation is reported to the analyst, never bypassed.

## 6. Register and wire

No list anywhere is edited by hand. In the pack:

- Give each subagent a `subagent.json` with its display name, a one-line summary and any data-room path
  templates it writes to.
- Put the root agent's delegation text in `files/agent/instructions/NN-pack-<id>.md`.
- Name the subagents in `pack.json`.
- Put what the pack means for application state (corpus, workspace instructions) in `pack.json` "state". Intake
  reads it, so the state is reproducible from the brief.

`packs.py apply` runs the mold's generator, which registers everything.

## 7. Prove it

```
python3 .claude/scripts/packs.py check <pack_id>              # the pack on its own
python3 .claude/scripts/packs.py apply <app_id>               # into build/<app_id>/, generators run
python3 .claude/scripts/packs.py verify <app_id>              # the mold's check-subagents.py + shared-helper drift
cd build/<app_id> && npm run typecheck && npm run build:eve   # eve build is the final word on skill frontmatter
```

`lanes.py` runs a packed application's codebase checks in `build/<app_id>/`, and the mold's functional lane
includes `check:subagents`, so a stamped application cannot pass with a broken workspace. Close the task with the check's
output as evidence.

## Fanning out

One subagent is one `mold-engineer` with a write scope of exactly `packs/<pack_id>/files/agent/subagents/<key>/`.
Build the shared helpers and this standard first, then run the subagents in parallel, then
run the check over all of them.
