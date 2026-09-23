#!/usr/bin/env python3
"""check-subagents.py [key ...] [--json] [--timeout N] [--self-test]

Holds this codebase's subagents to the workspace standard described in
.claude/skills/eve-subagent-workspace/SKILL.md, and checks that the generated subagent registry is current.
Python 3 standard library only.

Nothing registers a subagent by hand: scripts/gen-subagent-meta.mjs discovers agent/subagents/<key>/agent.ts and
writes the two generated files every consumer reads. So "registered" here means "npm run build:subagent-meta was
run after the last change" - see .claude/skills/eve-subagent-wiring/SKILL.md.

  python3 scripts/check-subagents.py                  the registry, then every subagent that has sandbox/workspace/
  python3 scripts/check-subagents.py invoice-extraction   only the named subagents (legacy ones included, if named)
  python3 scripts/check-subagents.py --json           the same verdict as JSON on stdout
  python3 scripts/check-subagents.py --self-test      run the checker against a built-in good and bad subagent

Exit 0 when the registry and every checked subagent pass (also when no subagent is in scope: the base app ships
none that follow the workspace standard), 1 on any failure, 2 on a usage error. Warnings never change the exit code.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REQUIRED_FILES = [
    "agent.ts",
    "instructions.md",
    "instructions/00-mode.ts",
    "instructions/operator-override.ts",
    "hooks/usage.ts",
    "sandbox/sandbox.ts",
]

# The two files scripts/gen-subagent-meta.mjs writes. Every consumer (UI lists, labels, workflows rows, data-room
# templates) reads these, so a key missing from either means `npm run build:subagent-meta` was not run.
GENERATED_META = "app/_components/subagent-meta.generated.ts"
GENERATED_REGISTRY = "agent/lib/subagent-registry.generated.ts"

MIN_SKILLS = 6
SHARED_DIR = "scripts/subagent-shared"
KEY_OK = re.compile(r"^[a-z][a-z0-9-]{0,79}$")  # the same shape setup/fde-mcp.mjs accepts
DECL_FIELDS = ("name", "summary", "dataroomPaths")
# Kept identical to TEMPLATE_OK in scripts/gen-subagent-meta.mjs.
TEMPLATE_OK = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*(/(\{[a-z_]+\}|[A-Za-z0-9_.{}-]+))*/(\*\*|[A-Za-z0-9_.{}-]+)$")


def read(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def tree_files(d):
    out = {}
    for base, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x != "__pycache__"]
        for n in files:
            if n.endswith(".pyc"):
                continue
            p = os.path.join(base, n)
            out[os.path.relpath(p, d)] = p
    return out


def yaml_unsafe_description(text):
    """True when a single-line, unquoted description would not parse as YAML (found by `eve build`, 2026-09-18:
    'incomplete explicit mapping pair' on a description containing ': ')."""
    m = re.match(r"---\n(.*?)\n---", text, re.S)
    d = re.search(r"^description:[ \t]*(.*)$", m.group(1), re.M) if m else None
    if not d: return False
    v = d.group(1).strip()
    if not v or v[0] in "\"'" or v in (">", "|", ">-", "|-", ">+", "|+"): return False
    return bool(re.search(r":(\s|$)|\s#", v)) or v[0] in "[]{}&*!|>%@`,?-" and (len(v) == 1 or v[0] != "-" or v[1] == " ")

def frontmatter_description(text):
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return None
    d = re.search(r"^description:[ \t]*(.*(?:\n[ \t]+.*)*)", m.group(1), re.M)
    if not d:
        return None
    value = d.group(1).strip().strip(">|").strip().strip("\"'").strip()
    return value or None


def _json_after(text, marker):
    """The JSON value that follows `marker ... = ` in a generated .ts file, or None."""
    at = text.find(marker)
    if at == -1:
        return None
    eq = text.find("= ", at)
    if eq == -1:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[eq + 2:])[0]
    except ValueError:
        return None


def generated_registry(root):
    """What scripts/gen-subagent-meta.mjs last wrote: {"meta": {key: {...}} | None, "keys": [...] | None,
    "labels": {...}, "summaries": {...}, "templates": [...]}."""
    out = {"meta": None, "keys": None, "labels": {}, "summaries": {}, "templates": []}
    path = os.path.join(root, GENERATED_META)
    if os.path.isfile(path):
        out["meta"] = _json_after(read(path), "export const SUBAGENT_META")
    path = os.path.join(root, GENERATED_REGISTRY)
    if os.path.isfile(path):
        text = read(path)
        out["keys"] = _json_after(text, "export const SUBAGENT_KEYS")
        out["labels"] = _json_after(text, "export const SUBAGENT_LABELS") or {}
        out["summaries"] = _json_after(text, "export const SUBAGENT_SUMMARIES") or {}
        out["templates"] = _json_after(text, "export const EXTRA_DATAROOM_PATH_TEMPLATES") or []
    return out


def dataroom_grammar(root):
    """(domains, tokens) the data-room store will accept, read from its source; (None, None) when unreadable.
    agent/lib/dataroom-store.ts compiles every template at import time and THROWS on an unknown domain or token,
    which takes every data-room tool down - the generator's regex does not catch either."""
    domains = tokens = None
    schema = os.path.join(root, "agent/lib/dataroom-schema.ts")
    if os.path.isfile(schema):
        m = re.search(r"dataroomDomainSchema\s*=\s*z\.enum\(\[(.*?)\]\)", read(schema), re.S)
        if m:
            domains = re.findall(r"^\s*\"([^\"]+)\"", m.group(1), re.M)
    store = os.path.join(root, "agent/lib/dataroom-store.ts")
    if os.path.isfile(store):
        m = re.search(r"const TOKEN_PATTERNS[^=]*=\s*\{(.*?)\n\};", read(store), re.S)
        if m:
            tokens = re.findall(r"^  ([a-z_]+):", m.group(1), re.M)
    return domains or None, tokens or None


def template_problem(t, domains, tokens):
    """Why `t` is not a usable subagent.json dataroomPaths entry, or None."""
    if not isinstance(t, str):
        return "is not a string"
    if not TEMPLATE_OK.match(t) or ".." in t:
        return "is not a data-room path template (Domain/segment/.../file-or-**, tokens as {lower_snake})"
    if domains is not None and t.split("/")[0] not in domains:
        return "starts with \"%s\", which is not a data-room domain (%s)" % (t.split("/")[0], ", ".join(domains))
    if re.search(r"[{}]", re.sub(r"\{[a-z_]+\}", "", t)):
        return "has a stray or malformed brace (a token is {lower_snake})"
    unknown = sorted(set(re.findall(r"\{([a-z_]+)\}", t)) - set(tokens)) if tokens is not None else []
    if unknown:
        return "uses unknown token(s) {%s}; the store knows: %s" % ("}, {".join(unknown), ", ".join(tokens))
    return None


def check_declaration(r, root, key, reg, grammar):
    """subagent.json: optional, but when present it must be what the generator and the data-room store accept."""
    path = os.path.join(root, "agent/subagents", key, "subagent.json")
    if not os.path.isfile(path):
        return
    try:
        decl = json.loads(read(path))
    except ValueError as e:
        r.check(False, "subagent.json is not valid JSON: %s" % e)
        return
    if not r.check(isinstance(decl, dict), "subagent.json must be a JSON object"):
        return
    extra = sorted(set(decl) - set(DECL_FIELDS))
    r.check(not extra, "subagent.json has unknown field(s) %s; known: %s" % (", ".join(extra), ", ".join(DECL_FIELDS)))
    for f in ("name", "summary"):
        if f in decl:
            r.check(isinstance(decl[f], str) and decl[f].strip() != "", "subagent.json \"%s\" must be a non-empty string" % f)
    paths = decl.get("dataroomPaths", [])
    if r.check(isinstance(paths, list), "subagent.json \"dataroomPaths\" must be a list of path templates"):
        for t in paths:
            why = template_problem(t, *grammar)
            if r.check(why is None, "subagent.json dataroomPaths entry %s %s" % (json.dumps(t), why)):
                r.check(t in reg["templates"],
                        "dataroomPaths entry %s is not in %s - run: npm run build:subagent-meta" % (json.dumps(t), GENERATED_REGISTRY))
    # A declared name/summary that the generated files do not carry means they are stale.
    for f, table in (("name", reg["labels"]), ("summary", reg["summaries"])):
        if isinstance(decl.get(f), str) and decl[f].strip() and key in table:
            r.check(table[key] == decl[f].strip(),
                    "subagent.json \"%s\" differs from %s - run: npm run build:subagent-meta" % (f, GENERATED_REGISTRY))


def shared_families(root):
    """{family: (source dir, targets list | None, problem | None)} from scripts/subagent-shared/<family>/targets.json."""
    base, out = os.path.join(root, SHARED_DIR), {}
    if not os.path.isdir(base):
        return out
    for family in sorted(os.listdir(base)):
        src = os.path.join(base, family)
        if not os.path.isdir(src):
            continue
        try:
            targets = json.loads(read(os.path.join(src, "targets.json")))["subagents"]
            if not isinstance(targets, list) or not all(isinstance(t, str) for t in targets):
                raise ValueError('"subagents" must be a list of keys')
            out[family] = (src, targets, None)
        except (OSError, ValueError, KeyError, TypeError) as e:
            out[family] = (src, None, "%s/%s/targets.json: %s" % (SHARED_DIR, family, e))
    return out


def shared_tree(d):
    return {f: p for f, p in tree_files(d).items() if os.path.basename(f) != "targets.json"}


def check_shared(r, root, key, scripts_dir):
    """Every shared helper family this subagent carries is the synced copy, and every family that names it is there."""
    for family, (src, targets, problem) in shared_families(root).items():
        copy = os.path.join(scripts_dir, family)
        if targets is None:
            if os.path.isdir(copy):
                r.check(False, problem)
            continue
        if key in targets:
            if r.check(os.path.isdir(copy), "%s/%s names this subagent but sandbox/workspace/scripts/%s is missing - run: npm run sync:subagent-shared"
                       % (SHARED_DIR, family, family)):
                want, have = shared_tree(src), shared_tree(copy)
                bad = sorted(f for f in set(want) | set(have) if f not in want or f not in have or read(want[f]) != read(have[f]))
                r.check(not bad, "%s copy differs from %s/%s (%s) - never hand-edit it, run: npm run sync:subagent-shared"
                        % (family, SHARED_DIR, family, ", ".join(bad)))
        elif os.path.isdir(copy):
            r.check(False, "sandbox/workspace/scripts/%s is a copy of the shared family but %s/%s/targets.json does not name \"%s\", "
                           "so the sync never refreshes it" % (family, SHARED_DIR, family, key))


def web_search_gated(path):
    src = read(path)
    return "WEB_SEARCH_ENABLED" in src and "disableTool" in src


class Report:
    def __init__(self, key):
        self.key, self.failures, self.warnings, self.passed = key, [], [], 0

    def check(self, ok, message):
        if ok:
            self.passed += 1
        else:
            self.failures.append(message)
        return ok

    def warn(self, message):
        self.warnings.append(message)

    def as_dict(self):
        return {"ok": not self.failures, "passed": self.passed, "failures": self.failures, "warnings": self.warnings}


def check_subagent(root, key, timeout=60, reg=None, grammar=None):
    r = Report(key)
    reg = reg if reg is not None else generated_registry(root)
    grammar = grammar if grammar is not None else dataroom_grammar(root)
    sub = os.path.join(root, "agent/subagents", key)
    if not os.path.isdir(sub):
        r.check(False, "agent/subagents/%s does not exist" % key)
        return r
    p = lambda *parts: os.path.join(sub, *parts)

    # 1. required files
    for f in REQUIRED_FILES:
        r.check(os.path.isfile(p(f)), "missing %s" % f)
    r.check(not os.path.exists(p("sandbox.ts")),
            "top-level sandbox.ts present: eve only seeds sandbox/workspace/** with the folder layout, move it to sandbox/sandbox.ts")
    if os.path.isfile(p("agent.ts")):
        r.check(re.search(r"description\s*:", read(p("agent.ts"))) is not None,
                "agent.ts has no description (eve rejects the build; the parent routes on it)")

    # 2. copied files are re-keyed
    if os.path.isfile(p("instructions/operator-override.ts")):
        src = read(p("instructions/operator-override.ts"))
        found = re.findall(r"loadWorkflowOverride\(\s*[\"']([^\"']+)[\"']", src)
        r.check(found == [key] or (found and all(x == key for x in found)),
                "instructions/operator-override.ts loads the override for %s, not \"%s\"" % (found or "nothing", key))
    if os.path.isfile(p("hooks/usage.ts")):
        src = read(p("hooks/usage.ts"))
        found = re.findall(r"WORKFLOW\s*=\s*[\"']([^\"']+)[\"']", src)
        r.check(found == [key], "hooks/usage.ts has WORKFLOW = %s, not \"%s\"" % (found or "nothing", key))

    instructions = read(p("instructions.md")) if os.path.isfile(p("instructions.md")) else ""
    scripts_dir = p("sandbox/workspace/scripts")
    schemas_dir = p("sandbox/workspace/schemas")
    scripts = sorted(n for n in os.listdir(scripts_dir) if n.endswith(".py") and os.path.isfile(os.path.join(scripts_dir, n))) \
        if os.path.isdir(scripts_dir) else []

    # 3. skills
    skills_dir = p("skills")
    skills = sorted(n for n in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, n))) \
        if os.path.isdir(skills_dir) else []
    r.check(len(skills) >= MIN_SKILLS, "%d skill package(s) under skills/, the standard asks for at least %d" % (len(skills), MIN_SKILLS))
    skill_text = ""
    for s in skills:
        md = os.path.join(skills_dir, s, "SKILL.md")
        if not r.check(os.path.isfile(md), "skills/%s has no SKILL.md" % s):
            continue
        text = read(md)
        skill_text += "\n" + text
        r.check(frontmatter_description(text) is not None,
                "skills/%s/SKILL.md has no non-empty `description:` frontmatter (eve requires it on a packaged skill)" % s)
        r.check(not yaml_unsafe_description(text),
                "skills/%s/SKILL.md: the description is a plain YAML scalar containing ': ' or ' #' (or starting with a YAML "
                "indicator); `eve build` rejects the whole skill. Wrap the description in double quotes" % s)
        r.check(re.search(r"^#{1,6}[ \t].*\bexample", text, re.M | re.I) is not None,
                "skills/%s/SKILL.md has no worked example heading (e.g. `## Worked example`)" % s)
        cmds = sorted(set(re.findall(r"/workspace/scripts/([\w\-./]+\.py)", text)))
        if r.check(bool(cmds), "skills/%s/SKILL.md names no /workspace/scripts/<x>.py command" % s):
            for c in cmds:
                r.check(os.path.isfile(os.path.join(scripts_dir, c)),
                        "skills/%s/SKILL.md runs /workspace/scripts/%s, which is not in sandbox/workspace/scripts/" % (s, c))
        r.check(s in instructions, "skill `%s` is not named in instructions.md (the model is never told when to load it)" % s)
        for ref in re.findall(r"\]\((references/[^)#\s]+)", text) + re.findall(r"`(references/[^`\s]+)`", text):
            r.check(os.path.isfile(os.path.join(skills_dir, s, ref)), "skills/%s/SKILL.md points at %s, which does not exist" % (s, ref))
    if os.path.isfile(os.path.join(skills_dir, "README.md")):
        r.warn("skills/README.md is a leftover placeholder; eve would treat a flat .md here as a skill named README")

    # 4. scripts
    r.check(bool(scripts), "no scripts under sandbox/workspace/scripts/ (a detector, a validator and the rulebook's calculators are expected)")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    for n in scripts:
        path = os.path.join(scripts_dir, n)
        if r.check("--self-test" in read(path), "scripts/%s does not support --self-test" % n):
            try:
                run = subprocess.run([sys.executable, path, "--self-test"], cwd=scripts_dir, env=env,
                                     capture_output=True, text=True, timeout=timeout)
                tail = (run.stderr.strip() or run.stdout.strip()).splitlines()[-1:] or [""]
                r.check(run.returncode == 0, "scripts/%s --self-test exited %d: %s" % (n, run.returncode, tail[0][:200]))
            except subprocess.TimeoutExpired:
                r.check(False, "scripts/%s --self-test did not finish in %ds" % (n, timeout))
        # A helper module that sibling scripts import is not something the model runs, so it need not be documented.
        stem = n[:-3]
        is_library = any(re.search(r"^\s*(from\s+%s\s+import|import\s+%s\b)" % (re.escape(stem), re.escape(stem)),
                                   read(os.path.join(scripts_dir, o)), re.M) for o in scripts if o != n)
        r.check(is_library or n in instructions or n in skill_text,
                "scripts/%s is mentioned in neither instructions.md nor any skill" % n)

    # 5. schemas and validators
    schemas = sorted(n for n in os.listdir(schemas_dir) if n.endswith(".json")) if os.path.isdir(schemas_dir) else []
    r.check(bool(schemas), "no JSON Schemas under sandbox/workspace/schemas/")
    for n in schemas:
        try:
            doc = json.loads(read(os.path.join(schemas_dir, n)))
            r.check(isinstance(doc, dict) and "type" in doc, "schemas/%s has no top-level \"type\"" % n)
        except ValueError as e:
            r.check(False, "schemas/%s is not valid JSON: %s" % (n, e))
    validators = [n for n in scripts if n.startswith("validate_")]
    r.check(bool(validators), "no validate_*.py under sandbox/workspace/scripts/")
    validator_text = "\n".join(n + "\n" + read(os.path.join(scripts_dir, n)) for n in validators)
    norm = lambda s: s.lower().replace("-", "_")
    for stem in sorted(set(re.findall(r"(?<![\w}])([A-Za-z0-9_\-]+)\.jsonl", instructions))):
        lines = [ln for ln in instructions.splitlines() if stem + ".jsonl" in ln]
        if lines and all(re.search(r"read[- ]only", ln, re.I) for ln in lines):
            continue
        r.check(norm(stem) in norm(validator_text),
                "instructions.md mentions %s.jsonl but no validate_*.py names it (mark the line `read-only` if this subagent never writes it)" % stem)

    # 6. rulebook
    own = [n for n in os.listdir(p("schemas")) if n.endswith("-spec.md")] if os.path.isdir(p("schemas")) else []
    borrowed = [m for m in re.findall(r"([\w-]+)/schemas/([\w-]+-spec\.md)", instructions)
                if os.path.isfile(os.path.join(root, "agent/subagents", m[0], "schemas", m[1]))]
    r.check(bool(own or borrowed),
            "no rulebook: neither schemas/*-spec.md here nor a reference in instructions.md to <other-subagent>/schemas/<name>-spec.md that exists")

    # 7. web_search gate
    ws = p("tools/web_search.ts")
    if os.path.isfile(ws):
        r.check(web_search_gated(ws),
                "tools/web_search.ts does not gate on WEB_SEARCH_ENABLED (ENABLE_WEB_SEARCH=false would leave this subagent on the web)")

    # 8. registration = the generated registry knows the key (nothing is registered by hand)
    r.check(KEY_OK.match(key) is not None, "key \"%s\" is not lowercase letters, digits and hyphens (the MCP and the API refuse it)" % key)
    r.check(isinstance(reg["meta"], dict) and key in reg["meta"],
            "key \"%s\" is not in %s - run: npm run build:subagent-meta" % (key, GENERATED_META))
    r.check(isinstance(reg["keys"], list) and key in reg["keys"],
            "key \"%s\" is not in %s - run: npm run build:subagent-meta" % (key, GENERATED_REGISTRY))
    check_declaration(r, root, key, reg, grammar)

    # 9. shared helper families
    check_shared(r, root, key, scripts_dir)

    # advisory: instructions.md contract
    for heading in ("Skills", "Scripts"):
        if not re.search(r"^#{1,6}[ \t]+%s\b" % heading, instructions, re.M):
            r.warn("instructions.md has no `%s` heading with its table" % heading)
    if not re.search(r"validat", instructions, re.I):
        r.warn("instructions.md never mentions validation (the validate-before-write rule)")
    return r


def default_keys(root):
    base = os.path.join(root, "agent/subagents")
    if not os.path.isdir(base):
        return []
    return sorted(k for k in os.listdir(base) if os.path.isdir(os.path.join(base, k, "sandbox", "workspace")))


def declared_keys(root):
    """What the generator discovers: a directory is a subagent only if it has agent.ts."""
    base = os.path.join(root, "agent/subagents")
    if not os.path.isdir(base):
        return []
    return sorted(k for k in os.listdir(base) if os.path.isfile(os.path.join(base, k, "agent.ts")))


def check_registry(root, reg=None, grammar=None, skip=()):
    """Codebase-wide checks that hold for EVERY subagent, legacy ones included: the generated files are current,
    every subagent.json is well formed, shared families are declared properly, every web_search is gated."""
    r = Report("(registry)")
    reg = reg if reg is not None else generated_registry(root)
    grammar = grammar if grammar is not None else dataroom_grammar(root)
    declared = declared_keys(root)
    for label, have in ((GENERATED_META, reg["meta"]), (GENERATED_REGISTRY, reg["keys"])):
        if not r.check(have is not None, "%s is missing or unreadable - run: npm run build:subagent-meta" % label):
            continue
        have = sorted(have)
        missing, stale = [k for k in declared if k not in have], [k for k in have if k not in declared]
        r.check(not missing, "%s does not list %s - run: npm run build:subagent-meta" % (label, ", ".join(missing)))
        r.check(not stale, "%s still lists %s, which no longer has agent/subagents/<key>/agent.ts - run: npm run build:subagent-meta"
                % (label, ", ".join(stale)))
    wanted = []
    for key in declared:
        if key not in skip:  # a subagent checked in full reports its own subagent.json
            sub = Report(key)
            check_declaration(sub, root, key, reg, grammar)
            for m in sub.failures:
                r.check(False, "agent/subagents/%s: %s" % (key, m))
            r.passed += sub.passed
        try:
            decl = json.loads(read(os.path.join(root, "agent/subagents", key, "subagent.json")))
            wanted += [t for t in decl.get("dataroomPaths", []) if isinstance(t, str)] if isinstance(decl, dict) else []
        except (OSError, ValueError):
            pass
    stale = [t for t in reg["templates"] if t not in wanted]
    r.check(not stale, "%s carries data-room template(s) no subagent.json declares (%s) - run: npm run build:subagent-meta"
            % (GENERATED_REGISTRY, ", ".join(stale)))
    for family, (_src, targets, problem) in shared_families(root).items():
        if not r.check(targets is not None, problem or ""):
            continue
        for key in targets:
            r.check(key in declared, "%s/%s/targets.json names \"%s\", which is not a subagent under agent/subagents/" % (SHARED_DIR, family, key))
    for key in declared:
        check_usage_hook(r, root, key)
    check_delegation_recorder(r, root)
    agent_dir = os.path.join(root, "agent")
    for base, dirs, files in os.walk(agent_dir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "sandbox")]
        if "web_search.ts" in files and os.path.basename(base) == "tools":
            path = os.path.join(base, "web_search.ts")
            r.check(web_search_gated(path), "%s does not gate on WEB_SEARCH_ENABLED (ENABLE_WEB_SEARCH=false would leave it on the web)"
                    % os.path.relpath(path, root))
    return r


def check_usage_hook(r, root, key):
    """A subagent's run accounting, checked for EVERY declared subagent - a pack's included.

    This lives in the codebase-wide registry check on purpose. The run-history defect fixed on
    2026-09-23 was fixed in this repo's ten subagents and NOT in the four that actually run in
    production, because those come from a pack (docs/SUBAGENT_PACKS.md) and carry their own copy
    of this file. Nothing compared the two, and the repo's own test walked only agent/subagents/,
    so it passed while the deployed specialists were untouched. A pack is applied INTO
    agent/subagents/, so checking here is what finally sees it.

    Each rule below is one measured failure:
      - no hook at all          -> that subagent's runs are never recorded anywhere;
      - wrong WORKFLOW constant -> its runs are filed under another subagent's history;
      - no turn.started/open    -> the row was created by the first step that reported TOKENS, so
                                   a turn whose provider reported none left no row at all
                                   (automation_runs was EMPTY in production);
      - no ctx.session.id       -> eve numbers turns WITHIN a session (`turn_<sequence>`) and a
                                   delegated child session is new each time, so every invocation
                                   keyed `...:turn_0` and run two merged into run one (three
                                   invocations, one row).
    """
    rel = "agent/subagents/%s/hooks/usage.ts" % key
    path = os.path.join(root, "agent/subagents", key, "hooks/usage.ts")
    if not r.check(os.path.isfile(path), "%s is missing - this subagent's runs are never recorded" % rel):
        return
    src = read(path)
    r.check('const WORKFLOW = "%s";' % key in src,
            "%s does not set WORKFLOW = \"%s\" - its runs are filed under another subagent" % (rel, key))
    r.check('"turn.started"' in src and "openWorkflowRun" in src,
            "%s opens no run row on turn.started - an invocation whose provider reports no tokens leaves NO history" % rel)
    r.check("ctx.session.id" in src,
            "%s does not pass ctx.session.id - eve's turn ids count within a session, so every invocation would share one run_key" % rel)


def check_delegation_recorder(r, root):
    """The half of the run history a subagent CANNOT record about itself.

    Every recorder in hooks/usage.ts is driven by the child's own turn events. Two measured cases produce no
    turn event at all, and both are only visible from the PARENT - which is the root agent, whose hooks live in
    agent/hooks/ and are never supplied by a pack:

      - a child that dies during bootstrap never emits turn.started, so the invocation left NO row at all.
        Recorded verbatim in scripts/fixtures/subagent-delivery/child-fails.ndjson: subagent.called, then an
        action.result flagged isError, and nothing from the child in between;
      - a child PARKED on a question is live for as long as nobody answers (across six live sessions every
        declared specialist parked - #42), so its open row must be marked as waiting or the abandoned-run
        sweeper in agent/lib/workflow-usage.ts would close a run that is still working.

    Checked here, beside check_usage_hook, for the same reason that one is: this is a contract about run
    history that must hold for the specialists that ship in a pack, and a rule kept anywhere a pack cannot be
    seen is the mistake #43 was written to stop repeating.
    """
    rel = "agent/hooks/delegation-runs.ts"
    path = os.path.join(root, rel)
    if not r.check(os.path.isfile(path),
                   "%s is missing - a delegation that dies before turn.started leaves NO run history, for every "
                   "subagent including a pack's" % rel):
        return
    src = read(path)
    r.check('"subagent.called"' in src,
            "%s does not watch subagent.called - the failed result carries no child session id, and the run key is "
            "nothing without it" % rel)
    r.check('"action.result"' in src and "recordFailedDelegation" in src,
            "%s does not record a failed delegation - an invocation that died before its first turn leaves no row" % rel)
    r.check('"input.requested"' in src and "markDelegationParked" in src,
            "%s does not mark a parked delegation - the abandoned-run sweeper would close a specialist that is still "
            "waiting for an answer" % rel)


def run(root, keys, as_json, timeout, out=sys.stdout):
    named = bool(keys)
    keys = keys or default_keys(root)
    reg, grammar = generated_registry(root), dataroom_grammar(root)
    registry = check_registry(root, reg, grammar, skip=keys)
    reports = [check_subagent(root, k, timeout, reg, grammar) for k in keys]
    # No subagent in scope is not a failure: the base app ships none that follow the workspace standard.
    ok = not registry.failures and all(not r.failures for r in reports)
    if as_json:
        json.dump({"ok": ok, "registry": registry.as_dict(), "subagents": {r.key: r.as_dict() for r in reports}}, out, indent=2)
        out.write("\n")
    else:
        for r in [registry] + reports:
            out.write("%s  %s  (%d checks passed, %d failed, %d warnings)\n" %
                      ("PASS" if not r.failures else "FAIL", r.key, r.passed, len(r.failures), len(r.warnings)))
            for m in r.failures:
                out.write("  - %s\n" % m)
            for m in r.warnings:
                out.write("  ~ warning: %s\n" % m)
        if not reports and not named:
            out.write("\nno workspace-standard subagents yet: no agent/subagents/<key>/ has sandbox/workspace/, so only the "
                      "registry was checked (%d declared subagent(s)). Name a key to check a legacy subagent.\n" % len(declared_keys(root)))
        bad = [r.key for r in reports if r.failures]
        out.write("\n%d subagent(s) checked, %d failing%s; registry %s\n" %
                  (len(reports), len(bad), (": " + ", ".join(bad)) if bad else "", "ok" if not registry.failures else "FAILING"))
    return 0 if ok else 1


# --------------------------------------------------------------------------- self-test

def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


_SCRIPT = '''import argparse, json, sys
a = argparse.ArgumentParser(); a.add_argument("--self-test", action="store_true"); n = a.parse_args()
if n.self_test: sys.exit(%d)
print(json.dumps({"ok": True}))
'''


def _fixture(root, key, broken=False):
    sub = os.path.join(root, "agent/subagents", key)
    _write(os.path.join(sub, "agent.ts"), 'export default defineAgent({ description: "Delegate here when ..." });\n')
    _write(os.path.join(sub, "instructions/00-mode.ts"), "export default 1;\n")
    _write(os.path.join(sub, "instructions/operator-override.ts"),
           'await loadWorkflowOverride("%s", orgId);\n' % ("research" if broken else key))
    # The full run-accounting contract check_usage_hook holds every declared subagent to:
    # the key it files under, the turn.started row, and the session id that keeps one
    # invocation's run_key distinct from the next one's.
    _write(os.path.join(sub, "hooks/usage.ts"),
           'const WORKFLOW = "%s";\nevents: { async "turn.started"(event, ctx) { await openWorkflowRun(WORKFLOW, event.data.turnId, ctx.session.id); } }\n' % key)
    _write(os.path.join(sub, "sandbox/sandbox.ts"), "export default defineSandbox({});\n")
    _write(os.path.join(sub, "schemas/%s-spec.md" % key), "# Rulebook\n\n## Open points\n")
    _write(os.path.join(sub, "sandbox/workspace/schemas/rows.schema.json"), '{"type": "object"}' if not broken else '{"properties": {}}')
    _write(os.path.join(sub, "sandbox/workspace/scripts/detect_input.py"), _SCRIPT % (1 if broken else 0))
    _write(os.path.join(sub, "sandbox/workspace/scripts/validate_rows.py"), "# validates rows.jsonl\n" + _SCRIPT % 0)
    names = ["skill-%d" % i for i in range(3 if broken else 6)]
    for s in names:
        _write(os.path.join(sub, "skills", s, "SKILL.md"),
               "---\ndescription: Use when the input looks like %s.\n---\n\nRun `python3 /workspace/scripts/detect_input.py in.pdf`.\n\n"
               "## Worked example\n\nExample Trading Co.\n" % s)
    _write(os.path.join(sub, "instructions.md"),
           "# %s\n\n## Skills\n%s\n\n## Scripts\ndetect_input.py validate_rows.py\n\nValidate before writing rows.jsonl%s.\n"
           % (key, " ".join(names), " and extra_log.jsonl" if broken else ""))
    if broken:
        _write(os.path.join(sub, "sandbox.ts"), "export default defineSandbox({});\n")
        _write(os.path.join(sub, "tools/web_search.ts"), 'export { webSearchTool as default } from "#lib/tools.js";\n')


def _root_hooks(root):
    """The root agent's parent-side run recorder, as a complete codebase carries it (agent/hooks/ is never
    supplied by a pack, which is the point of checking it there)."""
    _write(os.path.join(root, "agent/hooks/delegation-runs.ts"),
           'events: { "subagent.called"(e, ctx) {},\n'
           '  async "input.requested"(e, ctx) { await markDelegationParked(); },\n'
           '  async "action.result"(e, ctx) { await recordFailedDelegation(); } }\n')


def _generated(root, keys, templates=(), labels=None, summaries=None):
    """What scripts/gen-subagent-meta.mjs would have written for `keys`."""
    labels, summaries = labels or {}, summaries or {}
    meta = {k: {"name": labels.get(k, k), "summary": summaries.get(k, ""), "description": "", "skillNames": [], "skillsSummary": "", "tools": []} for k in keys}
    _write(os.path.join(root, GENERATED_META),
           "export const SUBAGENT_META: Record<string, SubagentMeta> = %s;\n\nexport const SUBAGENT_KEYS: readonly string[] = Object.keys(SUBAGENT_META);\n"
           % json.dumps(meta, indent=2))
    _write(os.path.join(root, GENERATED_REGISTRY),
           "export const SUBAGENT_KEYS: readonly string[] = %s;\n\nexport const SUBAGENT_LABELS: Record<string, string> = %s;\n\n"
           "export const SUBAGENT_SUMMARIES: Record<string, string> = %s;\n\nexport const EXTRA_DATAROOM_PATH_TEMPLATES: readonly string[] = %s;\n"
           % (json.dumps(list(keys), indent=2), json.dumps({k: labels.get(k, k) for k in keys}, indent=2),
              json.dumps({k: summaries.get(k, "") for k in keys}, indent=2), json.dumps(list(templates), indent=2)))


def self_test():
    tmp = tempfile.mkdtemp(prefix="check-subagents-")
    try:
        _fixture(tmp, "good-one")
        _fixture(tmp, "bad-one", broken=True)
        _fixture(tmp, "unbuilt-one")
        os.makedirs(os.path.join(tmp, "agent/subagents/stray-folder"))
        _write(os.path.join(tmp, "agent/subagents/legacy/agent.ts"), 'export default defineAgent({ description: "Legacy." });\n')
        _write(os.path.join(tmp, "agent/subagents/legacy/hooks/usage.ts"), 'const WORKFLOW = "legacy";\\nevents: { async "turn.started"(event, ctx) { await openWorkflowRun(WORKFLOW, event.data.turnId, ctx.session.id); } }\\n')
        sub = lambda key, *parts: os.path.join(tmp, "agent/subagents", key, *parts)
        # the data-room grammar the store would enforce
        _write(os.path.join(tmp, "agent/lib/dataroom-schema.ts"), 'export const dataroomDomainSchema = z.enum([\n  "Customers",\n  "Uploads",\n]);\n')
        _write(os.path.join(tmp, "agent/lib/dataroom-store.ts"),
               'const TOKEN_PATTERNS: Record<string, string> = {\n  customer_id: SLUG,\n  date: "x",\n};\n')
        # subagent.json: a good one, and one with every kind of mistake
        good_template = "Customers/{customer_id}/invoices/**"
        _write(sub("good-one", "subagent.json"), json.dumps({"name": "Good One", "summary": "Reads things.", "dataroomPaths": [good_template]}))
        _write(sub("bad-one", "subagent.json"), json.dumps({"name": "", "colour": "red", "dataroomPaths": [
            "Invoices/{customer_id}/**", "Customers/{vendor_id}/x.json", "Customers/../x", "Customers/**/x.json", 7]}))
        # a shared family: good-one carries the synced copy, bad-one a hand-edited one, unbuilt-one a copy nobody syncs
        _write(os.path.join(tmp, SHARED_DIR, "doclib/targets.json"), json.dumps({"subagents": ["good-one", "bad-one", "gone"]}))
        _write(os.path.join(tmp, SHARED_DIR, "doclib/__init__.py"), "VERSION = 1\n")
        _write(sub("good-one", "sandbox/workspace/scripts/doclib/__init__.py"), "VERSION = 1\n")
        _write(sub("bad-one", "sandbox/workspace/scripts/doclib/__init__.py"), "VERSION = 2  # edited in place\n")
        _write(sub("unbuilt-one", "sandbox/workspace/scripts/doclib/__init__.py"), "VERSION = 1\n")
        # the generated files as they were before unbuilt-one was added and after "removed" was deleted
        _generated(tmp, ["bad-one", "good-one", "legacy", "removed"], templates=[good_template, "Customers/{customer_id}/old/**"],
                   labels={"good-one": "Good One"}, summaries={"good-one": "Reads things."})

        cases = []
        good, bad, unbuilt = (check_subagent(tmp, k, 30) for k in ("good-one", "bad-one", "unbuilt-one"))
        cases.append(("a complete workspace passes", not good.failures, good.failures))
        expect = ["top-level sandbox.ts", "operator-override.ts loads", "skill package(s)", "--self-test exited 1",
                  "no top-level \"type\"", "extra_log.jsonl", "WEB_SEARCH_ENABLED",
                  "unknown field(s) colour", "\"name\" must be a non-empty string",
                  "\"Invoices/{customer_id}/**\" starts with \"Invoices\"", "unknown token(s) {vendor_id}",
                  "\"Customers/../x\" is not a data-room path template", "\"Customers/**/x.json\" is not a data-room path template",
                  "7 is not a string", "doclib copy differs from scripts/subagent-shared/doclib (__init__.py)"]
        for e in expect:
            cases.append(("a broken workspace reports: " + e, any(e in f for f in bad.failures), bad.failures))
        for e in ["is not in %s" % GENERATED_META, "is not in %s" % GENERATED_REGISTRY, "targets.json does not name \"unbuilt-one\""]:
            cases.append(("a subagent added without the build reports: " + e, any(e in f for f in unbuilt.failures), unbuilt.failures))
        registry = check_registry(tmp)
        for e in ["does not list unbuilt-one", "still lists removed", "no subagent.json declares (Customers/{customer_id}/old/**)",
                  "targets.json names \"gone\"", "agent/subagents/bad-one: subagent.json has unknown field",
                  "agent/subagents/bad-one/tools/web_search.ts does not gate",
                  # The half no subagent can record about itself, and which no pack supplies.
                  "agent/hooks/delegation-runs.ts is missing"]:
            cases.append(("the registry reports: " + e, any(e in f for f in registry.failures), registry.failures))
        # A root hook that watches the delegation but never marks a park would let the abandoned-run sweeper
        # close a specialist that is still waiting for an answer.
        _write(os.path.join(tmp, "agent/hooks/delegation-runs.ts"),
               'events: { "subagent.called"(e, ctx) {}, async "action.result"(e, ctx) { await recordFailedDelegation(); } }\n')
        half = check_registry(tmp)
        cases.append(("a recorder that never marks a parked delegation is reported",
                      any("does not mark a parked delegation" in f for f in half.failures), half.failures))
        _root_hooks(tmp)
        whole = check_registry(tmp)
        cases.append(("a complete parent-side recorder passes",
                      not any("delegation-runs.ts" in f for f in whole.failures), whole.failures))
        cases.append(("a folder without agent.ts is not a subagent", "stray-folder" not in declared_keys(tmp), declared_keys(tmp)))
        cases.append(("default scope skips subagents without sandbox/workspace",
                      default_keys(tmp) == ["bad-one", "good-one", "unbuilt-one"], default_keys(tmp)))
        _write(sub("good-one", "subagent.json"), json.dumps({"name": "Renamed", "dataroomPaths": [good_template]}))
        stale = check_subagent(tmp, "good-one", 30)
        cases.append(("a subagent.json edited after the build is reported", any("\"name\" differs" in f for f in stale.failures), stale.failures))
        _write(sub("good-one", "subagent.json"), "{not json")
        broken = check_subagent(tmp, "good-one", 30)
        cases.append(("an unparseable subagent.json is reported", any("not valid JSON" in f for f in broken.failures), broken.failures))
        cases.append(("a mixed literal-and-token segment is a template", template_problem("Customers/{customer_id}/{date}_notes.md", ["Customers"], ["customer_id", "date"]) is None, None))
        cases.append(("a one-segment template is refused", template_problem("Customers", ["Customers"], []) is not None, None))
        cases.append(("generated JSON is read back", _json_after('export const X: readonly string[] = [\n  "a"\n];\n', "export const X") == ["a"], None))
        cases.append(("folded description frontmatter is read", frontmatter_description("---\ndescription: >\n  Use when x.\n---\n") == "Use when x.", None))
        cases.append(("unquoted description with a colon is YAML-unsafe", yaml_unsafe_description("---\ndescription: Use when x: the gate.\n---\n"), None))
        cases.append(("quoted description with a colon is safe", not yaml_unsafe_description('---\ndescription: "Use when x: the gate."\n---\n'), None))
        cases.append(("plain description is safe", not yaml_unsafe_description("---\ndescription: Use when a table shows two total columns.\n---\n"), None))
        cases.append(("empty description is rejected", frontmatter_description("---\ndescription:\nname: x\n---\n") is None, None))

        class Sink:
            def __init__(self): self.text = ""
            def write(self, t): self.text += t
        cases.append(("exit code is 1 when any subagent fails", run(tmp, [], False, 30, Sink()) == 1, None))

        # a clean codebase with one good subagent, then the base app's shape: only legacy subagents
        clean = tempfile.mkdtemp(prefix="check-subagents-clean-")
        try:
            _fixture(clean, "good-one")
            _root_hooks(clean)
            _write(os.path.join(clean, "agent/subagents/legacy/agent.ts"), 'export default defineAgent({ description: "Legacy." });\n')
            _write(os.path.join(clean, "agent/subagents/legacy/hooks/usage.ts"), 'const WORKFLOW = "legacy";\\nevents: { async "turn.started"(event, ctx) { await openWorkflowRun(WORKFLOW, event.data.turnId, ctx.session.id); } }\\n')
            _generated(clean, ["good-one", "legacy"])
            sink = Sink()
            cases.append(("exit code is 0 when the registry and every subagent pass", run(clean, [], False, 30, sink) == 0, sink.text))
            shutil.rmtree(os.path.join(clean, "agent/subagents/good-one"))
            _generated(clean, ["legacy"])
            sink = Sink()
            code = run(clean, [], False, 30, sink)
            cases.append(("no workspace-standard subagent in scope exits 0 and says so",
                          code == 0 and "no workspace-standard subagents yet" in sink.text, sink.text))
            sink = Sink()
            cases.append(("a named legacy subagent is held to the standard", run(clean, ["legacy"], False, 30, sink) == 1, sink.text))
            _generated(clean, [])
            sink = Sink()
            cases.append(("an empty scope still fails on a stale registry", run(clean, [], False, 30, sink) == 1, sink.text))
        finally:
            shutil.rmtree(clean, ignore_errors=True)

        failed = 0
        for name, ok, detail in cases:
            print("%s %s" % ("ok  " if ok else "FAIL", name))
            if not ok:
                failed += 1
                if detail is not None:
                    print("     got: %s" % detail, file=sys.stderr)
        print("check-subagents self-test: %d/%d cases passed" % (len(cases) - failed, len(cases)))
        return 1 if failed else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keys", nargs="*", help="subagent keys; default is every subagent with sandbox/workspace/")
    ap.add_argument("--json", action="store_true", help="print the verdict as JSON")
    ap.add_argument("--timeout", type=int, default=60, help="seconds allowed per script --self-test (default 60)")
    ap.add_argument("--self-test", action="store_true", help="check the checker against built-in fixtures")
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    return run(ROOT, a.keys, a.json, a.timeout)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
