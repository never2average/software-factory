#!/usr/bin/env python3
"""normalise_location.py [--units <units.json>] < defects.jsonl [--self-test]

Adds "location" to each raw defect: the building's own name for the place, by the rulebook. "Apt 3b", "apartment 3B",
"Unit 3B" and "flat 3b" are all "Flat 3B"; floors are "L<n>" (ground "L0", basement "B1"); common areas take the
rulebook's names (Stair A, Lift 1, Roof, Plant room, Bin store, Car park, Lobby, Corridor L<n>). With --units (a JSON
list of the building's flats), a flat the building does not have is kept as written and flagged "unknown_unit". A place
it cannot name is "location": null with "location_note" saying why. Prints JSON lines.
"""
import json, re, sys

FLAT = re.compile(r"\b(?:flat|apt\.?|apartment|unit)\s*([0-9]{1,3}[a-z]?)\b", re.I)
FLOOR = re.compile(r"\b(?:level|floor|l)\s*([0-9]{1,2})\b", re.I)
COMMON = [("stair", r"\bstair(?:case|well)?\s*([a-z0-9])\b", "Stair {0}"), ("lift", r"\blift\s*([0-9a-z])\b", "Lift {0}"),
          ("roof", r"\broof\b", "Roof"), ("plant", r"\bplant\s*room\b", "Plant room"), ("bins", r"\bbin\s*store\b", "Bin store"),
          ("car", r"\bcar\s*park\b", "Car park"), ("lobby", r"\b(?:lobby|entrance hall|reception)\b", "Lobby"),
          ("corridor", r"\b(?:corridor|landing)\b", "Corridor")]

def name(raw, units=None):
    if not raw: return None, "no location given"
    s = raw.strip(); m = FLAT.search(s)
    if m:
        u = m.group(1).upper(); loc = f"Flat {u}"
        rest = s[m.end():].strip(" ,-")
        if units is not None and u not in units: return loc + (f", {rest}" if rest else ""), "unknown_unit"
        return loc + (f", {rest}" if rest else ""), None
    for _, pat, fmt in COMMON:
        c = re.search(pat, s, re.I)
        if c:
            loc = fmt.format(*(g.upper() for g in c.groups()))
            f = FLOOR.search(s)
            if f: loc += f" L{int(f.group(1))}"
            elif re.search(r"\bground\b", s, re.I): loc += " L0"
            return loc, None
    return None, f"could not name {raw!r} the building's way"

def self_test():
    ok = [name("apartment 3b kitchen") == ("Flat 3B, kitchen", None), name("Unit 12A") == ("Flat 12A", None),
          name("Stair B L2") == ("Stair B L2", None), name("bin store") == ("Bin store", None),
          name("landing, ground floor") == ("Corridor L0", None), name("Flat 9Z", ["3B"]) == ("Flat 9Z", "unknown_unit"),
          name("somewhere outside")[0] is None, name(None) == (None, "no location given")]
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": ok})); return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if a and a[0] in ("-h", "--help"): print(__doc__); return 0
    units = None
    if "--units" in a:
        try: units = [str(u).upper() for u in json.load(open(a[a.index("--units") + 1]))]
        except (OSError, ValueError) as e: print(f"--units: {e}", file=sys.stderr); return 2
    for n, line in enumerate(sys.stdin, 1):
        if not line.strip(): continue
        try: d = json.loads(line)
        except ValueError: print(f"line {n} is not JSON", file=sys.stderr); return 2
        loc, note = name(d.get("location_raw"), units)
        d["location"] = loc
        if note: d["location_note"] = note
        print(json.dumps(d, ensure_ascii=False))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
