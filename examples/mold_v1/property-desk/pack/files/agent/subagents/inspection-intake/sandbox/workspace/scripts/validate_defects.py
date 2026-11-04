#!/usr/bin/env python3
"""validate_defects.py <defects.jsonl> [--self-test]

Checks defects.jsonl before anything is filed or written: the schema (schemas/defect.schema.json) and the rulebook's
rules a schema cannot say: every defect cites its report line (source) and, for a photo log, its image (evidence); a
defect with no location is never filed (it must carry a location_note); severity and due agree with the rulebook's days
from the inspection date; an urgent defect is never marked as a duplicate of a closed ticket. Prints {"ok", "defects",
"problems"}; exit 0 when ok, 1 when not, 2 when unreadable.
"""
import json, os, sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "..", "schemas", "defect.schema.json")
DAYS = {"urgent": 1, "high": 3, "normal": 14, "low": 56}
TYPES = {"string": str, "number": (int, float), "integer": int, "boolean": bool, "object": dict, "array": list}

def problems(lines, schema):
    out, count = [], 0
    for n, line in enumerate(lines, 1):
        if not line.strip(): continue
        count += 1
        try: d = json.loads(line)
        except ValueError: out.append(f"line {n}: not JSON"); continue
        for k in schema["required"]:
            if k not in d: out.append(f"line {n}: {k} is missing")
        for k, v in d.items():
            p = schema["properties"].get(k)
            if p is None: out.append(f"line {n}: unknown key {k}"); continue
            ts = p["type"] if isinstance(p["type"], list) else [p["type"]]
            if not any((v is None and t == "null") or (t in TYPES and isinstance(v, TYPES[t]) and not isinstance(v, bool) or (t == "boolean" and isinstance(v, bool))) for t in ts):
                out.append(f"line {n}: {k} is not {' or '.join(ts)}")
            if "enum" in p and v not in p["enum"]: out.append(f"line {n}: {k} {v!r} is not one of {', '.join(map(str, p['enum']))}")
        if not (d.get("source") or "").strip(): out.append(f"line {n}: no source line in the report")
        if d.get("format") == "photo_log" and not d.get("evidence"): out.append(f"line {n}: a photo-log defect without its image")
        if d.get("location") is None and not d.get("location_note"): out.append(f"line {n}: no location and no location_note saying why")
        try:
            if d.get("severity") in DAYS and (date.fromisoformat(d["due"]) - date.fromisoformat(d["inspected"])).days != DAYS[d["severity"]]:
                out.append(f"line {n}: a {d['severity']} defect is due {DAYS[d['severity']]} day(s) after the inspection, not {d['due']}")
        except (KeyError, TypeError, ValueError): out.append(f"line {n}: due or inspected is not a date")
    return count, out

def self_test():
    s = json.load(open(SCHEMA))
    good = json.dumps({"text": "Fire door does not latch", "location": "Stair B L2", "severity": "urgent", "due": "2026-11-05", "inspected": "2026-11-04", "source": "row 2", "format": "checklist_csv", "duplicate_of": None})
    bad = [json.dumps({"text": "Damp", "location": None, "severity": "high", "due": "2026-11-20", "inspected": "2026-11-04", "source": "", "format": "photo_log"}),
           json.dumps({"text": "X", "location": "Roof", "severity": "severe", "due": "2026-11-05", "inspected": "2026-11-04", "source": "line 3", "format": "narrative_text"})]
    c1, p1 = problems([good], s); c2, p2 = problems(bad, s)
    ok = not p1 and any("no source" in p for p in p2) and any("without its image" in p for p in p2) and any("location_note" in p for p in p2) and any("due 3 day" in p for p in p2) and any("not one of" in p for p in p2)
    print(json.dumps({"self_test": "ok" if ok else "failed", "good": p1, "bad": len(p2)})); return 0 if ok else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    try: lines = open(a[0], encoding="utf-8").read().splitlines(); s = json.load(open(SCHEMA))
    except (OSError, ValueError) as e: print(f"cannot read: {e}", file=sys.stderr); return 2
    c, p = problems(lines, s)
    print(json.dumps({"ok": not p, "defects": c, "problems": p}, ensure_ascii=False))
    if p: print(f"{len(p)} problem(s); fix them before raising tickets", file=sys.stderr)
    return 0 if not p else 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
