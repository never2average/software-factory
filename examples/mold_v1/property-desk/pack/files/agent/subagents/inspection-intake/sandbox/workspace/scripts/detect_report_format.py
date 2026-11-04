#!/usr/bin/env python3
"""detect_report_format.py <file> [--self-test]

Says what kind of inspection report a file is: checklist_csv (a spreadsheet export: one row per item checked),
photo_log (lines of "<image file> - <location> - <what it shows>"), narrative_text (a written report with numbered or
headed defects), or unknown. Prints {"file", "format", "evidence"} as JSON. Exit 0, 1 when unknown, 2 on usage error.
"""
import json, re, sys

PHOTO = re.compile(r"^\s*\S+\.(jpe?g|png|heic)\s*[-–|:]\s*", re.I | re.M)
NARR = re.compile(r"^\s*(\d+[.)]|defect\b|item\b|observation\b|#+\s)", re.I | re.M)

def detect(text):
    head = text.lstrip("﻿")[:5000]
    lines = [l for l in head.splitlines() if l.strip()]
    if not lines: return "unknown", "empty"
    if len(PHOTO.findall(head)) >= 2: return "photo_log", "lines naming image files"
    first = lines[0]
    if (first.count(",") >= 2 or first.count(";") >= 2 or first.count("\t") >= 2) and re.search(r"item|check|result|location|area", first, re.I):
        return "checklist_csv", "a delimited header: " + first[:80]
    if len(NARR.findall(head)) >= 2: return "narrative_text", "numbered or headed defects"
    return "unknown", "none of a checklist, a photo log or a written report"

def self_test():
    cases = [("Item,Location,Result,Notes\nFire door closer,Stair B L2,Fail,Does not latch\n", "checklist_csv"),
             ("IMG_0012.jpg - Flat 3B kitchen - water under sink\nIMG_0013.jpg - Bin store - door off hinge\n", "photo_log"),
             ("Inspection of 12 Harbour Street\n1. Damp patch on ceiling, Flat 2A bedroom.\n2. Loose handrail, Stair A.\n", "narrative_text"),
             ("Hello, please call me back.", "unknown")]
    bad = [(w, detect(t)[0]) for t, w in cases if detect(t)[0] != w]
    print(json.dumps({"self_test": "ok" if not bad else "failed", "bad": bad})); return 1 if bad else 0

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help"): print(__doc__); return 0 if a else 2
    try: text = open(a[0], encoding="utf-8", errors="replace").read()
    except OSError as e: print(f"cannot read {a[0]}: {e}", file=sys.stderr); return 2
    f, why = detect(text); print(json.dumps({"file": a[0], "format": f, "evidence": why})); return 0 if f != "unknown" else 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
