#!/usr/bin/env python3
"""dedupe_defects.py --open <open-tickets.json> < defects.jsonl [--self-test]

Marks each defect that an open maintenance ticket already covers: same location (the building's name for it) and at
least half of the defect's significant words in the ticket's title. Adds "duplicate_of" (the ticket id) or null, and
"similarity" (0 to 1). Never drops a line: a duplicate is still reported, only not filed again. --open is the
list_todos answer saved as JSON (a list, or {"items": [...]}, each with id, title and custom.location).
"""
import json, re, sys

STOP = set("a an the of on in at to and or is are was not no with for by from under over near".split())
words = lambda s: {w for w in re.findall(r"[a-z]{3,}", (s or "").lower()) if w not in STOP}

def match(defect, tickets):
    best, score = None, 0.0
    dw = words(defect.get("text"))
    for t in tickets:
        loc = ((t.get("custom") or {}).get("location") or "").lower()
        if not defect.get("location") or loc != defect["location"].lower(): continue
        s = len(dw & words(t.get("title"))) / max(1, len(dw))
        if s > score: best, score = t.get("id"), s
    return (best if score >= 0.5 else None), round(score, 2)

def self_test():
    tickets = [{"id": "T-1", "title": "Damp patch on bedroom ceiling", "custom": {"location": "Flat 2A, bedroom"}},
               {"id": "T-2", "title": "Fire door does not latch", "custom": {"location": "Stair B L2"}}]
    a = match({"text": "Damp patch on ceiling", "location": "Flat 2A, bedroom"}, tickets)
    b = match({"text": "Damp patch on ceiling", "location": "Flat 3B"}, tickets)
    c = match({"text": "Handrail loose", "location": "Stair B L2"}, tickets)
    ok = [a[0] == "T-1", b[0] is None, c[0] is None]
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": ok})); return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--open" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    try:
        doc = json.load(open(a[a.index("--open") + 1])); tickets = doc.get("items", doc) if isinstance(doc, dict) else doc
    except (OSError, ValueError) as e: print(f"--open: {e}", file=sys.stderr); return 2
    for n, line in enumerate(sys.stdin, 1):
        if not line.strip(): continue
        try: d = json.loads(line)
        except ValueError: print(f"line {n} is not JSON", file=sys.stderr); return 2
        d["duplicate_of"], d["similarity"] = match(d, tickets)
        print(json.dumps(d, ensure_ascii=False))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
