#!/usr/bin/env python3
"""parse_report.py <file> --format checklist_csv|photo_log|narrative_text [--self-test]

Turns an inspection report into raw defects, one JSON object per line: {"text", "location_raw", "evidence", "source"}.
Checklist rows count as defects only when their result is a fail (fail, no, x, defect, action, unsatisfactory); a pass
or an N/A row is skipped and counted. A line it cannot read is reported on stderr with its number, never guessed.
"""
import csv, io, json, re, sys

FAIL = {"fail", "failed", "no", "x", "defect", "action", "action required", "unsatisfactory", "poor"}
SYN = {"item": ("item", "check", "element", "component"), "location": ("location", "area", "unit", "flat", "where"),
       "result": ("result", "status", "outcome", "pass/fail"), "notes": ("notes", "comment", "comments", "observation", "detail")}

def from_csv(text):
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿")), csv.Sniffer().sniff(text[:2000], delimiters=",;\t")))
    head = [h.strip().lower() for h in rows[0]]; col = {}
    for k, names in SYN.items():
        for i, h in enumerate(head):
            if h in names and k not in col: col[k] = i
    out, skipped = [], 0
    for n, r in enumerate(rows[1:], 2):
        g = lambda k: (r[col[k]].strip() if k in col and col[k] < len(r) else "")
        if not any(c.strip() for c in r): continue
        if g("result").lower() not in FAIL: skipped += 1; continue
        text_ = (g("item") + (": " + g("notes") if g("notes") else "")).strip(": ")
        out.append({"text": text_, "location_raw": g("location") or None, "evidence": None, "source": f"row {n}"})
    return out, skipped

PHOTO = re.compile(r"^\s*(?P<img>\S+\.(?:jpe?g|png|heic))\s*[-–|:]\s*(?P<loc>[^-–|]+?)\s*[-–|]\s*(?P<what>.+)$", re.I)
def from_photos(text):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        m = PHOTO.match(line)
        if m: out.append({"text": m["what"].strip(), "location_raw": m["loc"].strip(), "evidence": m["img"], "source": f"line {n}"})
        elif line.strip(): print(f"line {n}: not a photo log line, skipped", file=sys.stderr)
    return out, 0

ITEM = re.compile(r"^\s*(?:\d+[.)]|defect\s*\d*[:.]|[-*])\s*(?P<body>.+)$", re.I)
LOC = re.compile(r",\s*(?P<loc>(?:flat|apt\.?|apartment|unit|stair|lift|roof|basement|car park|bin store|lobby|corridor|plant room)[^.;]*)\.?\s*$", re.I)
def from_narrative(text):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        m = ITEM.match(line)
        if not m: continue
        body = m["body"].strip(); loc = LOC.search(body)
        out.append({"text": (body[:loc.start()] if loc else body).strip().rstrip("."), "location_raw": loc["loc"].strip() if loc else None, "evidence": None, "source": f"line {n}"})
    return out, 0

PARSERS = {"checklist_csv": from_csv, "photo_log": from_photos, "narrative_text": from_narrative}

def self_test():
    a, s = from_csv("Item,Location,Result,Notes\nFire door closer,Stair B L2,Fail,Does not latch\nSmoke alarm,Flat 3B,Pass,\n")
    b, _ = from_photos("IMG_0012.jpg - Flat 3B kitchen - water under sink\n")
    c, _ = from_narrative("Report\n1. Damp patch on ceiling, Flat 2A bedroom.\n2. Loose handrail on the landing\n")
    ok = [len(a) == 1 and s == 1 and a[0]["text"] == "Fire door closer: Does not latch" and a[0]["location_raw"] == "Stair B L2",
          b[0]["evidence"] == "IMG_0012.jpg" and b[0]["location_raw"] == "Flat 3B kitchen",
          c[0]["location_raw"] == "Flat 2A bedroom" and c[1]["location_raw"] is None and c[0]["text"] == "Damp patch on ceiling"]
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": ok})); return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--format" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    fmt = a[a.index("--format") + 1]
    if fmt not in PARSERS: print(f"--format must be one of {', '.join(PARSERS)}", file=sys.stderr); return 2
    try: text = open(a[0], encoding="utf-8", errors="replace").read()
    except OSError as e: print(f"cannot read {a[0]}: {e}", file=sys.stderr); return 2
    try: rows, skipped = PARSERS[fmt](text)
    except (csv.Error, IndexError) as e: print(f"{a[0]} is not readable as {fmt}: {e}", file=sys.stderr); return 1
    for r in rows: print(json.dumps(r, ensure_ascii=False))
    if skipped: print(f"{skipped} passed or not-applicable item(s) skipped", file=sys.stderr)
    return 0 if rows else 1

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
