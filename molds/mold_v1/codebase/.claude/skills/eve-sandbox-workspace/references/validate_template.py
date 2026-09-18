#!/usr/bin/env python3
"""validate_rows.py — template for a validator that meets the script contract.

Copy to agent/subagents/<key>/sandbox/workspace/scripts/validate_<file>.py, rename ROWS/SCHEMA, replace the
domain rules and the self-test cases. Standard library only, so it runs anywhere with no install.

  python3 /workspace/scripts/validate_rows.py rows.jsonl
  cat rows.jsonl | python3 /workspace/scripts/validate_rows.py -
  python3 /workspace/scripts/validate_rows.py --self-test

stdout: {"ok": bool, "file": "rows.jsonl", "rows": n, "problems": ["line 3 $.value: ..."]}
exit:   0 valid, 1 invalid or self-test failed, 2 could not run (bad arguments, unreadable file)

The small JSON Schema subset below (type, required, properties, additionalProperties: false, enum, minimum,
minLength, pattern) is inlined so the template stands alone. When several subagents need it, move it into a shared
helper family (scripts/subagent-shared/<family>/, see scripts/subagent-shared/README.md) and import it instead:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from doclib import schema
"""
import argparse, json, os, re, sys

ROWS = "rows.jsonl"          # the file this validator owns; the checker looks for this name in the source
SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "rows.schema.json")

# Used by --self-test so it needs no files. Keep it identical in meaning to the schema file.
_SELF_TEST_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["field", "document_id", "status", "source_doc"],
    "properties": {
        "field": {"type": "string", "minLength": 1}, "document_id": {"type": "string", "minLength": 1},
        "value": {"type": ["number", "string", "null"]}, "unit": {"type": "string", "enum": ["currency", "percent", "count", "text"]},
        "status": {"type": "string", "enum": ["reported", "derived", "needs_review", "not_found"]},
        "footnote": {"type": "string"}, "source_doc": {"type": "string", "minLength": 1}, "page": {"type": "integer", "minimum": 1},
    },
}

_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def _is(value, name):
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, _TYPES[name])


def schema_problems(value, schema, at="$"):
    """Problems as strings; an empty list means valid. Never repairs, only reports."""
    out = []
    types = schema.get("type")
    if types is not None:
        types = types if isinstance(types, list) else [types]
        if not any(_is(value, t) for t in types):
            return ["%s: expected %s" % (at, " or ".join(types))]
    if "enum" in schema and value not in schema["enum"]:
        out.append("%s: %r is not one of %s" % (at, value, schema["enum"]))
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            out.append("%s: shorter than %d" % (at, schema["minLength"]))
        if "pattern" in schema and not re.search(schema["pattern"], value):
            out.append("%s: does not match %s" % (at, schema["pattern"]))
    if _is(value, "number") and "minimum" in schema and value < schema["minimum"]:
        out.append("%s: below %s" % (at, schema["minimum"]))
    if isinstance(value, dict):
        props = schema.get("properties", {})
        out += ["%s: missing %s" % (at, k) for k in schema.get("required", []) if k not in value]
        if schema.get("additionalProperties") is False:
            out += ["%s: unknown field %s" % (at, k) for k in value if k not in props]
        for k, v in value.items():
            if k in props:
                out += schema_problems(v, props[k], "%s.%s" % (at, k))
    return out


def domain_problems(rows):
    """The rules a JSON Schema cannot express. rows = [(line_no, obj)]. Never repairs, only reports."""
    out, seen = [], {}
    for n, o in rows:
        st = o.get("status")
        if st in ("reported", "derived") and o.get("value") is None:
            out.append("line %d: status %s needs a value" % (n, st))
        if st in ("reported", "derived") and "page" not in o:
            out.append("line %d: a value without a page citation" % n)
        if st == "not_found" and o.get("value") is not None:
            out.append("line %d: not_found must not carry a value" % n)
        if st == "derived" and not o.get("footnote"):
            out.append("line %d: derived needs a footnote saying how" % n)
        k = (o.get("document_id"), o.get("field"))
        if k in seen:
            out.append("line %d: duplicate of line %d (%s, %s)" % (n, seen[k], k[0], k[1]))
        seen.setdefault(k, n)
    return out


def check(text, schema, name=ROWS):
    rows, problems = [], []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError as x:
            problems.append("line %d: not JSON (%s)" % (n, x))
            continue
        found = schema_problems(obj, schema)
        problems += ["line %d %s" % (n, p) for p in found]
        if not found:
            rows.append((n, obj))
    problems += domain_problems(rows)
    return {"ok": not problems, "file": name, "rows": len(rows), "problems": problems}


def self_test():
    good = {"field": "invoice_total", "document_id": "INV-0001", "value": 1000.0, "unit": "currency", "status": "reported",
            "source_doc": "example-invoice.pdf", "page": 1}
    cases = [
        ("a cited value passes", [good], True),
        ("a derived value without a footnote fails", [dict(good, status="derived")], False),
        ("not_found with a value fails", [dict(good, status="not_found")], False),
        ("a value without a page fails", [{k: v for k, v in good.items() if k != "page"}], False),
        ("an unknown field fails", [dict(good, guess=1)], False),
        ("an unknown status fails", [dict(good, status="estimated")], False),
        ("a duplicate document and field fails", [good, good], False),
    ]
    failed = [name for name, rows, want in cases
              if check("\n".join(json.dumps(r) for r in rows), _SELF_TEST_SCHEMA)["ok"] != want]
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
    try:
        if a.file == "-":
            text = sys.stdin.read()
        else:
            with open(a.file, encoding="utf-8") as f:
                text = f.read()
        with open(SCHEMA, encoding="utf-8") as f:
            schema = json.load(f)
    except (OSError, ValueError) as x:
        print("could not validate %s: %s" % (a.file, x), file=sys.stderr)
        return 2
    result = check(text, schema, os.path.basename(a.file) if a.file != "-" else ROWS)
    print(json.dumps(result, indent=2))
    if not result["ok"]:
        print("%d problem(s) in %s; nothing may be written to the data room until they are fixed at the source"
              % (len(result["problems"]), a.file), file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
