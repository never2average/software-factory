#!/usr/bin/env python3
"""check-subagents.py [key ...] [--json] [--timeout N] [--self-test]

Holds this codebase's subagents to the workspace standard described in
.claude/skills/eve-subagent-workspace/SKILL.md. Python 3 standard library only.

  python3 scripts/check-subagents.py                  every subagent that has sandbox/workspace/
  python3 scripts/check-subagents.py lodr-filings     only the named subagents (legacy ones included, if named)
  python3 scripts/check-subagents.py --json           the same verdict as JSON on stdout
  python3 scripts/check-subagents.py --self-test      run the checker against a built-in good and bad subagent

Exit 0 when every checked subagent passes, 1 on any failure, 2 on a usage error.
Warnings never change the exit code.
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

# Every file that must name a subagent key before the product knows the subagent exists.
# .claude/skills/eve-subagent-wiring/SKILL.md explains what each one is for.
REGISTRATION_SITES = [
    "agent/lib/agent-configs.ts",
    "app/_components/tool-display.ts",
    "app/_components/ops/workspace-panel.tsx",
    "app/_components/ops/workflows-panel.tsx",
    "app/_components/insights.ts",
    "scripts/seed-ops.mjs",
    "agent/instructions.md",
]
# Named in a warning only: the finance delta did not register its keys here.
ADVISORY_SITES = ["setup/fde-mcp.mjs"]

MIN_SKILLS = 6
FINLIB_SRC = "scripts/fin-workspace/finlib"
SYNC_SCRIPT = "scripts/sync-fin-workspace.mjs"


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


def key_pattern(key, markdown=False):
    k = re.escape(key)
    if markdown:
        return re.compile(r"(\*\*%s\*\*|`%s`)" % (k, k))
    # "key", 'key', `key`, or an unquoted object key (research: "Research")
    return re.compile(r"([\"'`]%s[\"'`]|(?<![\w-])%s\s*:)" % (k, k))


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


def check_subagent(root, key, timeout=60):
    r = Report(key)
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
        src = read(ws)
        r.check("WEB_SEARCH_ENABLED" in src and "disableTool" in src,
                "tools/web_search.ts does not gate on WEB_SEARCH_ENABLED (ENABLE_WEB_SEARCH=false would leave this subagent on the web)")

    # 8. registration
    for site in REGISTRATION_SITES:
        path = os.path.join(root, site)
        if not r.check(os.path.isfile(path), "registration site %s does not exist" % site):
            continue
        r.check(key_pattern(key, markdown=site.endswith(".md")).search(read(path)) is not None,
                "key \"%s\" is not registered in %s" % (key, site))
    for site in ADVISORY_SITES:
        path = os.path.join(root, site)
        if os.path.isfile(path) and not key_pattern(key).search(read(path)):
            r.warn("key \"%s\" is not in %s (the fde MCP's agent-config tools will refuse it)" % (key, site))

    # 9. finlib copy
    copy = os.path.join(scripts_dir, "finlib")
    uses = any(re.search(r"^\s*(from|import)\s+finlib\b", read(os.path.join(scripts_dir, n)), re.M) for n in scripts)
    if os.path.isdir(copy) or uses:
        src = os.path.join(root, FINLIB_SRC)
        if r.check(os.path.isdir(copy), "scripts import finlib but sandbox/workspace/scripts/finlib is missing — run: npm run sync:fin-workspace") \
                and r.check(os.path.isdir(src), "%s is missing" % FINLIB_SRC):
            want, have = tree_files(src), tree_files(copy)
            bad = sorted(f for f in set(want) | set(have)
                         if f not in want or f not in have or read(want[f]) != read(have[f]))
            r.check(not bad, "finlib copy differs from %s (%s) — never hand-edit it, run: npm run sync:fin-workspace" % (FINLIB_SRC, ", ".join(bad)))
        sync = os.path.join(root, SYNC_SCRIPT)
        if os.path.isfile(sync):
            r.check(key_pattern(key).search(read(sync)) is not None,
                    "key \"%s\" is not in FIN_SUBAGENTS in %s, so the sync never refreshes its finlib copy" % (key, SYNC_SCRIPT))

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


def run(root, keys, as_json, timeout, out=sys.stdout):
    keys = keys or default_keys(root)
    reports = [check_subagent(root, k, timeout) for k in keys]
    ok = bool(reports) and all(not r.failures for r in reports)
    if as_json:
        json.dump({"ok": ok, "subagents": {r.key: r.as_dict() for r in reports}}, out, indent=2)
        out.write("\n")
    else:
        if not reports:
            out.write("no subagent has a sandbox/workspace/ directory, so there is nothing to check\n")
        for r in reports:
            out.write("%s  %s  (%d checks passed, %d failed, %d warnings)\n" %
                      ("PASS" if not r.failures else "FAIL", r.key, r.passed, len(r.failures), len(r.warnings)))
            for m in r.failures:
                out.write("  - %s\n" % m)
            for m in r.warnings:
                out.write("  ~ warning: %s\n" % m)
        bad = [r.key for r in reports if r.failures]
        out.write("\n%d subagent(s) checked, %d failing%s\n" % (len(reports), len(bad), (": " + ", ".join(bad)) if bad else ""))
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
    _write(os.path.join(sub, "hooks/usage.ts"), 'const WORKFLOW = "%s";\n' % key)
    _write(os.path.join(sub, "sandbox/sandbox.ts"), "export default defineSandbox({});\n")
    _write(os.path.join(sub, "schemas/%s-spec.md" % key), "# Rulebook\n\n## Open points\n")
    _write(os.path.join(sub, "sandbox/workspace/schemas/rows.schema.json"), '{"type": "object"}' if not broken else '{"properties": {}}')
    _write(os.path.join(sub, "sandbox/workspace/scripts/detect_input.py"), _SCRIPT % (1 if broken else 0))
    _write(os.path.join(sub, "sandbox/workspace/scripts/validate_rows.py"), "# validates rows.jsonl\n" + _SCRIPT % 0)
    names = ["skill-%d" % i for i in range(3 if broken else 6)]
    for s in names:
        _write(os.path.join(sub, "skills", s, "SKILL.md"),
               "---\ndescription: Use when the input looks like %s.\n---\n\nRun `python3 /workspace/scripts/detect_input.py in.pdf`.\n\n"
               "## Worked example\n\nExample Housing Finance Ltd.\n" % s)
    _write(os.path.join(sub, "instructions.md"),
           "# %s\n\n## Skills\n%s\n\n## Scripts\ndetect_input.py validate_rows.py\n\nValidate before writing rows.jsonl%s.\n"
           % (key, " ".join(names), " and extra_log.jsonl" if broken else ""))
    if broken:
        _write(os.path.join(sub, "sandbox.ts"), "export default defineSandbox({});\n")
        _write(os.path.join(sub, "tools/web_search.ts"), 'export { webSearchTool as default } from "#lib/tools.js";\n')


def self_test():
    tmp = tempfile.mkdtemp(prefix="check-subagents-")
    try:
        _fixture(tmp, "good-one")
        _fixture(tmp, "bad-one", broken=True)
        os.makedirs(os.path.join(tmp, "agent/subagents/legacy"))
        for site in REGISTRATION_SITES:
            _write(os.path.join(tmp, site), "- **good-one** — x\n" if site.endswith(".md") else 'const K = ["good-one"];\n')
        cases = []
        good, bad = check_subagent(tmp, "good-one", 30), check_subagent(tmp, "bad-one", 30)
        cases.append(("a complete workspace passes", not good.failures, good.failures))
        expect = ["top-level sandbox.ts", "operator-override.ts loads", "skill package(s)", "--self-test exited 1",
                  "no top-level \"type\"", "extra_log.jsonl", "WEB_SEARCH_ENABLED", "is not registered in agent/lib/agent-configs.ts",
                  "is not registered in agent/instructions.md"]
        for e in expect:
            cases.append(("a broken workspace reports: " + e, any(e in f for f in bad.failures), bad.failures))
        cases.append(("default scope skips subagents without sandbox/workspace", default_keys(tmp) == ["bad-one", "good-one"], default_keys(tmp)))
        cases.append(("unquoted object keys count as registered", key_pattern("research").search('  research: "Research",') is not None, None))
        cases.append(("a key inside a longer key does not count", key_pattern("evals").search('"hfc-evals-x"') is None, None))
        cases.append(("folded description frontmatter is read", frontmatter_description("---\ndescription: >\n  Use when x.\n---\n") == "Use when x.", None))
        cases.append(("unquoted description with a colon is YAML-unsafe", yaml_unsafe_description("---\ndescription: Use when x: the gate.\n---\n"), None))
        cases.append(("quoted description with a colon is safe", not yaml_unsafe_description('---\ndescription: "Use when x: the gate."\n---\n'), None))
        cases.append(("plain description is safe", not yaml_unsafe_description("---\ndescription: Use when a table shows H1/9M columns.\n---\n"), None))
        cases.append(("empty description is rejected", frontmatter_description("---\ndescription:\nname: x\n---\n") is None, None))

        class Sink:
            def write(self, _): pass
        cases.append(("exit code is 1 when any subagent fails", run(tmp, [], False, 30, Sink()) == 1, None))
        cases.append(("exit code is 0 when all pass", run(tmp, ["good-one"], False, 30, Sink()) == 0, None))
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
