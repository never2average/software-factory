#!/usr/bin/env python3
"""render_briefing.py <briefing-items.jsonl> --desk <name> --date <YYYY-MM-DD> [--self-test]

Renders validated briefing items as the briefing document (markdown on stdout), in the rulebook's order: Due today
(soonest deadline first), Embargoed (soonest lift first), Unassigned, At risk, Published since the last briefing.
An empty section says "Nothing." rather than disappearing, so a reader knows it was checked. Every line ends with its
source in brackets. Run validate_briefing_items.py first; this script does not re-check the rules.
"""
import json, sys

ORDER = [("due_today", "Due today", "deadline"), ("embargoed", "Embargoed", "embargo"), ("unassigned", "Unassigned", "deadline"),
         ("at_risk", "At risk", "deadline"), ("published", "Published since the last briefing", "published_at")]

def render(items, desk, date):
    out = [f"# {desk} briefing, {date}", ""]
    for key, title, sort in ORDER:
        rows = sorted((i for i in items if i.get("section") == key), key=lambda i: (i.get(sort) or "9999", i.get("slug") or ""))
        out += [f"## {title}", ""]
        if not rows: out += ["Nothing.", ""]; continue
        for i in rows:
            when = i.get(sort) or "no time given"
            who = i.get("reporter") or "nobody yet"
            extra = f" Why: {i['risk']}." if key == "at_risk" and i.get("risk") else ""
            out.append(f"- **{i.get('slug')}**: {i.get('title')} ({who}; {when}).{extra} [{i.get('source')}]")
        out.append("")
    return "\n".join(out).rstrip() + "\n"

def self_test():
    md = render([{"slug": "b", "title": "B", "section": "due_today", "deadline": "2026-11-04T17:00Z", "source": "row 3", "reporter": "r@example.com"},
                 {"slug": "a", "title": "A", "section": "due_today", "deadline": "2026-11-04T12:00Z", "source": "row 2"},
                 {"slug": "c", "title": "C", "section": "at_risk", "deadline": "2026-11-04T16:00Z", "source": "item 1", "risk": "reporter off sick"}], "Metro", "2026-11-04")
    ok = md.index("**a**") < md.index("**b**") and "## Embargoed\n\nNothing." in md and "Why: reporter off sick." in md and "[row 2]" in md
    print(json.dumps({"self_test": "ok" if ok else "failed"})); return 0 if ok else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--desk" not in a or "--date" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    try: items = [json.loads(l) for l in open(a[0], encoding="utf-8") if l.strip()]
    except (OSError, ValueError) as e: print(f"cannot read {a[0]}: {e}", file=sys.stderr); return 2
    sys.stdout.write(render(items, a[a.index("--desk") + 1], a[a.index("--date") + 1])); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
