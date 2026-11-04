#!/usr/bin/env python3
"""validate_briefing_items.py <briefing-items.jsonl> [--self-test]

Checks every line of briefing-items.jsonl before it is appended to the data room or rendered: the schema
(schemas/briefing-item.schema.json: required keys, types, the section enum) and the rules a schema cannot say:
  - every item cites where it came from (source: a file and a row, event or line, or an assignment id);
  - an item in "embargoed" has an embargo time, and no item whose embargo is still holding sits in "due_today";
  - an item in "unassigned" has no reporter, and an item with a reporter is never in "unassigned";
  - an item in "at_risk" says why (risk) in words;
  - a slug appears once per briefing.
Prints {"ok", "items", "problems": [...]} as JSON; exit 0 when ok, 1 when not, 2 when the file cannot be read.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "..", "schemas", "briefing-item.schema.json")
TYPES = {"string": str, "integer": int, "boolean": bool, "object": dict, "array": list}

def schema_problems(item, schema, n):
    out = []
    for k in schema.get("required", []):
        if k not in item: out.append(f"line {n}: {k} is missing")
    for k, v in item.items():
        p = schema["properties"].get(k)
        if p is None:
            if schema.get("additionalProperties") is False: out.append(f"line {n}: unknown key {k}")
            continue
        types = p["type"] if isinstance(p["type"], list) else [p["type"]]
        if not any((v is None and t == "null") or (t in TYPES and isinstance(v, TYPES[t]) and not (t == "integer" and isinstance(v, bool))) for t in types):
            out.append(f"line {n}: {k} is not {' or '.join(types)}")
        if "enum" in p and v not in p["enum"]: out.append(f"line {n}: {k} {v!r} is not one of {', '.join(map(str, p['enum']))}")
    return out

def rule_problems(item, n, seen):
    out = []; s = item.get("section")
    if not (item.get("source") or "").strip(): out.append(f"line {n}: no source: every line of a briefing cites where it came from")
    if s == "embargoed" and not item.get("embargo"): out.append(f"line {n}: in embargoed but has no embargo time")
    if s == "due_today" and item.get("embargo_state") == "holding": out.append(f"line {n}: embargo still holding, so it cannot be due for publication today")
    if s == "unassigned" and item.get("reporter"): out.append(f"line {n}: has a reporter, so it is not unassigned")
    if s == "at_risk" and not (item.get("risk") or "").strip(): out.append(f"line {n}: at risk but says no why")
    slug = item.get("slug")
    if slug in seen: out.append(f"line {n}: slug {slug} is already in this briefing (line {seen[slug]})")
    seen.setdefault(slug, n)
    return out

def validate(lines, schema):
    probs, seen, count = [], {}, 0
    for n, line in enumerate(lines, 1):
        if not line.strip(): continue
        count += 1
        try: item = json.loads(line)
        except ValueError: probs.append(f"line {n}: not JSON"); continue
        if not isinstance(item, dict): probs.append(f"line {n}: not an object"); continue
        probs += schema_problems(item, schema, n) + rule_problems(item, n, seen)
    return count, probs

def self_test():
    schema = json.load(open(SCHEMA))
    good = [json.dumps({"slug": "bridge-vote", "title": "Council votes on the bridge", "desk": "Metro", "section": "due_today", "deadline": "2026-11-04T17:00Z", "reporter": "a.writer@example.com", "source": "calendar.csv row 2"}),
            json.dumps({"slug": "flood-prep", "title": "Pumps ready", "desk": "Metro", "section": "unassigned", "deadline": "2026-11-04T15:00Z", "reporter": None, "source": "wire line 4"})]
    bad = [json.dumps({"slug": "x", "title": "X", "desk": "Metro", "section": "embargoed", "source": ""}),
           json.dumps({"slug": "x", "title": "X", "desk": "Metro", "section": "at_risk", "source": "row 3", "reporter": "r@example.com"}),
           json.dumps({"slug": "y", "title": "Y", "desk": "Metro", "section": "somewhere", "source": "row 4"})]
    c1, p1 = validate(good, schema); c2, p2 = validate(bad, schema)
    ok = not p1 and c1 == 2 and any("no source" in p for p in p2) and any("no embargo" in p for p in p2) and any("already" in p for p in p2) and any("not one of" in p for p in p2) and any("says no why" in p for p in p2)
    print(json.dumps({"self_test": "ok" if ok else "failed", "good_problems": p1, "bad_problems": len(p2)}))
    return 0 if ok else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    try: lines = open(a[0], encoding="utf-8").read().splitlines(); schema = json.load(open(SCHEMA))
    except (OSError, ValueError) as e: print(f"cannot read: {e}", file=sys.stderr); return 2
    count, probs = validate(lines, schema)
    print(json.dumps({"ok": not probs, "items": count, "problems": probs}, ensure_ascii=False))
    if probs: print(f"{len(probs)} problem(s); fix them before writing the briefing", file=sys.stderr)
    return 0 if not probs else 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
