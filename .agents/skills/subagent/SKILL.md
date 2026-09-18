---
name: subagent
description: Build a specialist subagent in a forked mold as a full workspace (instructions, skills for format variations, sandbox scripts, schemas, validators, tests), not as a single instructions file. Use whenever a product needs a new subagent or an existing one is only a prompt.
---

# Build a subagent as a full workspace

A subagent that is only `agent.ts` plus `instructions.md` is a prompt, not a specialist. It
fails the first time a source document is laid out differently from the one the author
pictured. The factory's standard is the workspace below. `subagent_check.py` enforces it,
and a subagent that does not pass is not done.

Subagents are code, so they live only in a forked mold (`molds/<mold_id>/codebase`, where
`MOLD.md` says edits are allowed). Never build them in a snapshot mold such as `mold_v1`.

**The mold carries its own authoring skills.** A forked mold has these under
`codebase/.claude/skills/eve-*`:

- `eve-subagent-workspace`
- `eve-subagent-skills`
- `eve-sandbox-workspace`
- `eve-subagent-tools`
- `eve-subagent-wiring`
- `eve-subagent-verify`
- `eve-customize-existing-agent`

It also carries its own checker, `codebase/scripts/check-subagents.py`. That way anyone
working inside the mold can customise its agents without this repo.

- Those skills are the concrete, file-by-file procedure. This document is the standard they
  implement.
- When forking a new mold, copy them from `molds/mold_fin/codebase` and adjust the paths.
- When the standard changes, change both.

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

In the fork, wire the new key in these places:

- Add the key to every hardcoded key list (grep an existing key such as `"research"`).
- Add the delegation paragraph to the root `agent/instructions.md`.
- Add any data-room paths to `DATAROOM_PATH_TEMPLATES` and `dm.md`.
- Add the key to the `agent_key` enum in `state/application/app_id/application.schema.json`.
- Run `node scripts/gen-subagent-meta.mjs`.

## 7. Prove it

```
python3 .claude/scripts/subagent_check.py <mold_id>            # structure, skills, schemas, self-tests, registration
cd molds/<mold_id>/codebase && npm run typecheck && npm run build
```

Add the self-tests to the mold's functional lane (`molds/<mold_id>/testing/functional/lane.json`)
so a stamped application cannot pass with a broken workspace. Close the task with the check's
output as evidence.

## Fanning out

One subagent is one `mold-engineer` with a write scope of exactly `agent/subagents/<key>/`.
Build the shared helpers and this standard first, then run the subagents in parallel, then
run the check over all of them.
