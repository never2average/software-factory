#!/usr/bin/env python3
"""detect_calendar_format.py <file> [--self-test]

Says what kind of story calendar a file is, so the right skill is loaded: csv (a planning-sheet export), ics (a
calendar feed), wire_budget (a news agency's budget lines), assignments_json (the list_todos answer saved as JSON),
or unknown. Prints JSON {"file", "format", "evidence", "rows_hint"} on stdout. Never guesses: unknown is an answer.
Exit 0 when a format was found, 1 when it is unknown, 2 on a usage error.
"""
import json, re, sys

WIRE = re.compile(r"^[A-Z][A-Z0-9-]{2,40}\s*(--|—|\|)\s*\d{2,5}\s*w(ords)?\b", re.I | re.M)

def detect(text):
    head = text.lstrip("﻿")[:4000]
    if head.lstrip().startswith("BEGIN:VCALENDAR"):
        return "ics", "starts with BEGIN:VCALENDAR", head.count("BEGIN:VEVENT")
    s = head.lstrip()
    if s[:1] in "[{":
        try:
            doc = json.loads(text)
            items = doc.get("items", doc) if isinstance(doc, dict) else doc
            if isinstance(items, list) and items and isinstance(items[0], dict) and "title" in items[0]:
                return "assignments_json", "a JSON list of records with titles", len(items)
        except ValueError:
            pass
    wire = WIRE.findall(head)
    if len(wire) >= 2:
        return "wire_budget", "lines of SLUG -- <n>w -- ...", len(wire)
    first = head.splitlines()[0] if head.splitlines() else ""
    if first.count(",") >= 2 or first.count(";") >= 2 or first.count("\t") >= 2:
        return "csv", "a delimited header line: " + first[:80], max(0, len(text.splitlines()) - 1)
    return "unknown", "none of csv, ics, wire budget lines or an assignments list", 0

def self_test():
    cases = [
        ("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR\n", "ics"),
        ("slug,desk,reporter,deadline\nbridge-vote,Metro,,2026-11-04T17:00\n", "csv"),
        ("slug;desk;deadline\nx;y;z\n", "csv"),
        ("BRIDGE-VOTE -- 600w -- Council votes on the bridge -- moving 1700 UTC\nFLOOD-PREP -- 450w -- Pumps\n", "wire_budget"),
        ('[{"title": "Bridge vote", "dueAt": "2026-11-04"}]', "assignments_json"),
        ("Dear desk, see you at conference.", "unknown"),
    ]
    bad = [(t[:20], want, detect(t)[0]) for t, want in cases if detect(t)[0] != want]
    for b in bad: print("FAIL", b, file=sys.stderr)
    print(json.dumps({"self_test": "ok" if not bad else "failed", "cases": len(cases)}))
    return 1 if bad else 0

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    try: text = open(a[0], encoding="utf-8", errors="replace").read()
    except OSError as e: print(f"cannot read {a[0]}: {e}", file=sys.stderr); return 2
    fmt, why, rows = detect(text)
    print(json.dumps({"file": a[0], "format": fmt, "evidence": why, "rows_hint": rows}))
    return 0 if fmt != "unknown" else 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
