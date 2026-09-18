#!/usr/bin/env python3
"""validate_rows.py — template for a validator that meets the script contract.

Copy to agent/subagents/<key>/sandbox/workspace/scripts/validate_<file>.py, rename ROWS/SCHEMA,
replace the domain rules and the self-test cases. Standard library + finlib only.

  python3 /workspace/scripts/validate_rows.py rows.jsonl
  cat rows.jsonl | python3 /workspace/scripts/validate_rows.py -
  python3 /workspace/scripts/validate_rows.py --self-test

stdout: {"ok": bool, "file": "rows.jsonl", "rows": n, "problems": ["line 3 $.value: ..."]}
exit:   0 valid, 1 invalid or self-test failed, 2 could not run (bad arguments, unreadable file)
"""
import argparse, json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # finlib sits beside this script
try:
    from finlib import schema as fschema
except ImportError:  # the template is also runnable outside a workspace, for its own self-test
    fschema = None

ROWS = "rows.jsonl"          # the file this validator owns; the checker looks for this name in the source
SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "rows.schema.json")

# Used by --self-test so it needs no files. Keep it identical in meaning to the schema file.
_SELF_TEST_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["metric", "period", "status", "source_doc"],
    "properties": {
        "metric": {"type": "string", "minLength": 1}, "period": {"type": "string"},
        "value": {"type": ["number", "null"]}, "unit": {"type": "string", "enum": ["crore", "percent", "count", "times"]},
        "status": {"type": "string", "enum": ["reported", "derived", "carried_forward", "needs_review", "not_found"]},
        "footnote": {"type": "string"}, "source_doc": {"type": "string", "minLength": 1}, "page": {"type": "integer", "minimum": 1},
    },
}


def domain_problems(rows):
    """The rules a JSON Schema cannot express. rows = [(line_no, obj)]. Never repairs, only reports."""
    out, seen = [], {}
    for n, o in rows:
        st = o.get("status")
        if st in ("reported", "derived", "carried_forward") and o.get("value") is None:
            out.append("line %d: status %s needs a value" % (n, st))
        if st in ("reported", "derived", "carried_forward") and "page" not in o:
            out.append("line %d: a value without a page citation" % n)
        if st == "not_found" and o.get("value") is not None:
            out.append("line %d: not_found must not carry a value" % n)
        if st in ("derived", "carried_forward") and not o.get("footnote"):
            out.append("line %d: %s needs a footnote saying how" % (n, st))
        k = (o.get("metric"), o.get("period"))
        if k in seen:
            out.append("line %d: duplicate of line %d (%s, %s)" % (n, seen[k], k[0], k[1]))
        seen.setdefault(k, n)
    return out


def check(path, schema):
    if fschema is None:
        raise RuntimeError("finlib is not importable; run `npm run sync:fin-workspace`")
    rows, problems = fschema.validate_jsonl(path, schema)
    problems += domain_problems(rows)
    return {"ok": not problems, "file": os.path.basename(path), "rows": len(rows), "problems": problems}


def self_test():
    good = {"metric": "aum", "period": "Q2FY25", "value": 1000.0, "unit": "crore", "status": "reported", "source_doc": "x.pdf", "page": 3}
    cases = [
        ("a cited value passes", [good], True),
        ("a derived value without a footnote fails", [dict(good, status="derived")], False),
        ("not_found with a value fails", [dict(good, status="not_found")], False),
        ("a value without a page fails", [{k: v for k, v in good.items() if k != "page"}], False),
        ("an unknown field fails", [dict(good, guess=1)], False),
        ("a duplicate metric and period fails", [good, good], False),
    ]
    if fschema is None:
        print(json.dumps({"ok": True, "skipped": "finlib not importable here; domain rules only"}))
        return 0 if not domain_problems([(1, good)]) and domain_problems([(1, dict(good, status="derived"))]) else 1
    failed = []
    for name, rows, want in cases:
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
            f.write("\n".join(json.dumps(r) for r in rows))
        try:
            if check(f.name, _SELF_TEST_SCHEMA)["ok"] != want:
                failed.append(name)
        finally:
            os.unlink(f.name)
    print(json.dumps({"ok": not failed, "cases": len(cases), "failed": failed}))
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="the .jsonl to validate, or - for stdin")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases; needs no input files")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.file:
        print("give a file to validate, or - for stdin", file=sys.stderr)
        return 2
    path = a.file
    try:
        if path == "-":
            with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
                f.write(sys.stdin.read())
            path = f.name
        with open(SCHEMA, encoding="utf-8") as f:
            schema = json.load(f)
        result = check(path, schema)
    except (OSError, ValueError, RuntimeError) as x:
        print("could not validate %s: %s" % (a.file, x), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    if not result["ok"]:
        print("%d problem(s) in %s; nothing may be written to the data room until they are fixed at the source" % (len(result["problems"]), a.file), file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
