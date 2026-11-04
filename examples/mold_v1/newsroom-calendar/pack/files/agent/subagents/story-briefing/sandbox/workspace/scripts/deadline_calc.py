#!/usr/bin/env python3
"""deadline_calc.py --now <ISO time with zone> [--edition-cutoff HH:MM] [--zone +HH:MM] < entries.jsonl [--self-test]

For each calendar entry (one JSON object per line on stdin) adds, as the rulebook defines them:
  minutes_to_deadline   whole minutes from --now to the deadline (negative when past); null when there is none
  deadline_state        past | due_now (within 60 minutes) | today (before the edition cut-off) | later | none
  embargo_state         none | holding (the embargo is after --now) | lifted
  zone_assumed          true when the entry's time had no zone and --zone (the desk's zone, default +00:00) was used
A date with no time is due at the edition cut-off of that day (default 17:00). Prints JSON lines on stdout.
Exit 0, 2 on a usage error or an unreadable --now.
"""
import json, sys
from datetime import datetime, timedelta, timezone

def tz(s):
    sign = -1 if s.startswith("-") else 1; h, m = s.lstrip("+-").split(":")
    return timezone(sign * timedelta(hours=int(h), minutes=int(m)))

def parse(v, zone, cutoff):
    """-> (aware datetime, zone assumed?) or (None, False)."""
    if not v: return None, False
    v = v.replace("Z", "+00:00")
    if len(v) == 10: v = f"{v}T{cutoff}"
    try: d = datetime.fromisoformat(v)
    except ValueError: return None, False
    if d.tzinfo is None: return d.replace(tzinfo=zone), True
    return d, False

def annotate(e, now, zone, cutoff):
    d, assumed = parse(e.get("deadline"), zone, cutoff)
    out = dict(e)
    if d is None:
        out.update(minutes_to_deadline=None, deadline_state="none")
    else:
        mins = int((d - now).total_seconds() // 60)
        cut = datetime.fromisoformat(f"{now.astimezone(zone).date()}T{cutoff}").replace(tzinfo=zone)
        state = "past" if mins < 0 else "due_now" if mins <= 60 else "today" if d <= cut else "later"
        out.update(minutes_to_deadline=mins, deadline_state=state)
    em, em_assumed = parse(e.get("embargo"), zone, "00:00")
    out["embargo_state"] = "none" if em is None else ("holding" if em > now else "lifted")
    out["zone_assumed"] = assumed or em_assumed
    return out

def self_test():
    now = datetime.fromisoformat("2026-11-04T09:00+00:00"); z = tz("+00:00")
    t = lambda **e: annotate(e, now, z, "17:00")
    ok = [
        t(deadline="2026-11-04T09:30Z")["deadline_state"] == "due_now",
        t(deadline="2026-11-04T08:00Z")["deadline_state"] == "past" and t(deadline="2026-11-04T08:00Z")["minutes_to_deadline"] == -60,
        t(deadline="2026-11-04")["deadline_state"] == "today",
        t(deadline="2026-11-05T10:00+01:00")["deadline_state"] == "later",
        t(deadline="2026-11-04T12:00")["zone_assumed"] is True,
        t(embargo="2026-11-04T18:00Z")["embargo_state"] == "holding",
        t(embargo="2026-11-04T08:00Z")["embargo_state"] == "lifted",
        t()["deadline_state"] == "none" and t()["embargo_state"] == "none",
        t(deadline="soon")["deadline_state"] == "none",
    ]
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": len(ok), "failed": [i for i, x in enumerate(ok) if not x]}))
    return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--now" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    try: now = datetime.fromisoformat(a[a.index("--now") + 1].replace("Z", "+00:00"))
    except ValueError: print("--now must be an ISO time with its zone", file=sys.stderr); return 2
    if now.tzinfo is None: print("--now must carry its zone (Z or +HH:MM)", file=sys.stderr); return 2
    zone = tz(a[a.index("--zone") + 1]) if "--zone" in a else timezone.utc
    cutoff = a[a.index("--edition-cutoff") + 1] if "--edition-cutoff" in a else "17:00"
    for n, line in enumerate(sys.stdin, 1):
        if not line.strip(): continue
        try: e = json.loads(line)
        except ValueError: print(f"line {n} is not JSON", file=sys.stderr); return 2
        print(json.dumps(annotate(e, now, zone, cutoff), ensure_ascii=False))
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
