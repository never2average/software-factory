#!/usr/bin/env python3
"""classify_severity.py --inspected <YYYY-MM-DD> < defects.jsonl [--self-test]

Adds "severity" (urgent | high | normal | low), "due" (YYYY-MM-DD) and "matched" (the rulebook rule that decided it)
to each defect, by the desk's rulebook: the FIRST rule whose words appear in the defect's text wins, in the order
urgent, high, normal; nothing matched is "normal" with matched "default". Due dates count calendar days from the
inspection date: urgent 1, high 3, normal 14, low 56 (the next quarterly round). Prints JSON lines.
"""
import json, re, sys
from datetime import date, timedelta

RULES = [
    ("urgent", r"\bgas\b|smell of gas|\bsparking\b|exposed (wire|wiring|cable)|no (heat|heating|hot water)|water ingress|flood|ceiling (collapse|down)|fire door .*(not|n't|does not) (close|latch)|fire alarm .*(fault|fail)|smoke alarm .*(missing|fail)|lift (trapped|entrapment)|broken window .*ground", "R1"),
    ("high", r"\bleak|\bdamp\b|\bmould\b|\bmold\b|handrail|trip hazard|lift (out of service|not working)|door entry|intercom|emergency light|security (gate|door)|\block\b.*(broken|fault)", "R2"),
    ("normal", r"crack|loose|stain|paint|sealant|grout|squeak|blocked|slow drain|light (out|not working)|bulb", "R3"),
    ("low", r"cosmetic|scuff|graffiti|weed|signage|label", "R4"),
]
DAYS = {"urgent": 1, "high": 3, "normal": 14, "low": 56}

def classify(text, inspected):
    t = (text or "").lower()
    for sev, pat, rule in RULES:
        if re.search(pat, t): return sev, (inspected + timedelta(days=DAYS[sev])).isoformat(), rule
    return "normal", (inspected + timedelta(days=DAYS["normal"])).isoformat(), "default"

def self_test():
    d = date(2026, 11, 4)
    ok = [classify("Fire door closer: does not latch", d)[0] == "urgent", classify("Damp patch on ceiling", d)[:2] == ("high", "2026-11-07"),
          classify("Loose skirting board", d)[0] == "normal", classify("Graffiti on bin store door", d) == ("low", "2026-12-30", "R4"),
          classify("Something odd", d)[2] == "default", classify("Smell of gas in plant room", d)[1] == "2026-11-05"]
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": ok})); return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--inspected" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    try: d = date.fromisoformat(a[a.index("--inspected") + 1])
    except ValueError: print("--inspected must be YYYY-MM-DD", file=sys.stderr); return 2
    for n, line in enumerate(sys.stdin, 1):
        if not line.strip(): continue
        try: x = json.loads(line)
        except ValueError: print(f"line {n} is not JSON", file=sys.stderr); return 2
        x["severity"], x["due"], x["matched"] = classify(x.get("text"), d)
        print(json.dumps(x, ensure_ascii=False))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
