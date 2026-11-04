#!/usr/bin/env python3
"""parse_calendar.py <file> --format csv|ics|wire_budget|assignments_json [--desk <desk>] [--self-test]

Turns a story calendar into calendar entries, one JSON object per line on stdout (schemas/calendar-entry.schema.json):
{"slug", "title", "desk", "reporter", "deadline", "embargo", "kind", "status", "words", "source"}. Header names are read
through the synonym table in the rulebook (slug/story/catchline; reporter/writer/byline; deadline/due/copy due; ...).
A value that cannot be read is kept as null and named in "unparsed", never invented. Times are kept as written with
their offset (ISO 8601); a time with no zone is marked "zone": "unstated". Exit 0, 1 when no entry could be read, 2 on
a usage error.
"""
import csv, io, json, re, sys

SYN = {
    "slug": ("slug", "story", "catchline", "catch line", "story slug"),
    "title": ("title", "headline", "hed", "working title", "summary"),
    "desk": ("desk", "section", "department"),
    "reporter": ("reporter", "writer", "byline", "assignee", "assigned to"),
    "deadline": ("deadline", "due", "copy due", "dueat", "due at", "file by"),
    "embargo": ("embargo", "embargoed until", "hold until"),
    "kind": ("kind", "type", "format"),
    "status": ("status", "stage", "state"),
    "words": ("words", "length", "word count", "wordcount"),
}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$")

def norm_time(v):
    v = (v or "").strip()
    if not v: return None, None
    if not ISO.match(v): return None, v
    return v.replace(" ", "T"), None

def entry(raw, source, desk=None):
    e = {k: None for k in SYN}; un = []
    for k, v in raw.items():
        if v in (None, ""): continue
        if k in ("deadline", "embargo"):
            t, bad = norm_time(str(v))
            if bad: un.append(f"{k}: {bad!r} is not an ISO date or time")
            e[k] = t
        elif k == "words":
            m = re.search(r"\d+", str(v)); e[k] = int(m.group()) if m else None
            if not m: un.append(f"words: {v!r}")
        else: e[k] = str(v).strip()
    e["desk"] = e["desk"] or desk
    if not e["slug"] and e["title"]: e["slug"] = re.sub(r"[^a-z0-9]+", "-", e["title"].lower()).strip("-")[:40]
    if e["deadline"] and not re.search(r"(Z|[+-]\d{2}:?\d{2})$", e["deadline"]) and "T" in e["deadline"]: e["zone"] = "unstated"
    e["source"] = source
    if un: e["unparsed"] = un
    return e

def from_csv(text, desk):
    sample = text[:2000]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample else csv.excel
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿")), dialect))
    if not rows: return []
    head = [h.strip().lower() for h in rows[0]]
    col = {}
    for k, names in SYN.items():
        for i, h in enumerate(head):
            if h in names and k not in col: col[k] = i
    out = []
    for n, r in enumerate(rows[1:], 2):
        if not any(c.strip() for c in r): continue
        out.append(entry({k: (r[i] if i < len(r) else None) for k, i in col.items()}, f"row {n}", desk))
    return out

def from_ics(text, desk):
    out, cur, n = [], None, 0
    lines = re.sub(r"\r?\n[ \t]", "", text).splitlines()
    for line in lines:
        if line == "BEGIN:VEVENT": cur = {}; n += 1
        elif line == "END:VEVENT" and cur is not None:
            out.append(entry(cur, f"event {n}", desk)); cur = None
        elif cur is not None and ":" in line:
            k, v = line.split(":", 1); k = k.split(";")[0].upper()
            if k == "SUMMARY": cur["title"] = v
            elif k == "DTSTART":
                m = re.match(r"(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?", v)
                cur["deadline"] = (f"{m[1]}-{m[2]}-{m[3]}" + (f"T{m[4]}:{m[5]}" + ("Z" if m[7] else "") if m[4] else "")) if m else v
            elif k == "CATEGORIES": cur["desk"] = v.split(",")[0]
            elif k == "X-SLUG": cur["slug"] = v
            elif k == "X-EMBARGO": cur["embargo"] = v
    return out

WIRE = re.compile(r"^(?P<slug>[A-Z][A-Z0-9-]{2,40})\s*(?:--|—|\|)\s*(?P<words>\d{2,5})\s*w\w*\s*(?:--|—|\|)\s*(?P<title>.*?)(?:\s*(?:--|—|\|)\s*(?P<rest>.*))?$", re.I)
def from_wire(text, desk):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        m = WIRE.match(line.strip())
        if not m: continue
        raw = {"slug": m["slug"].lower(), "words": m["words"], "title": m["title"], "kind": "wire"}
        rest = m["rest"] or ""
        t = re.search(r"moving\s+(\d{2})(\d{2})\s*UTC", rest, re.I)
        e = entry(raw, f"line {n}", desk)
        if t: e["moving_utc"] = f"{t[1]}:{t[2]}"
        em = re.search(r"embargo(?:ed)?\s+(?:until\s+)?(\S+)", rest, re.I)
        if em:
            tm, bad = norm_time(em[1]); e["embargo"] = tm
            if bad: e.setdefault("unparsed", []).append(f"embargo: {bad!r}")
        out.append(e)
    return out

def from_json(text, desk):
    doc = json.loads(text); items = doc.get("items", doc) if isinstance(doc, dict) else doc
    out = []
    for n, it in enumerate(items, 1):
        c = it.get("custom") or {}
        raw = {"title": it.get("title"), "deadline": it.get("dueAt"), "reporter": it.get("assignee"), "status": c.get("stage") or it.get("status"),
               "slug": c.get("slug"), "kind": c.get("kind"), "embargo": c.get("embargo"), "words": c.get("word_count"), "desk": it.get("customerId")}
        out.append(entry(raw, f"item {n} ({it.get('id', '?')})", desk))
    return out

PARSERS = {"csv": from_csv, "ics": from_ics, "wire_budget": from_wire, "assignments_json": from_json}

def self_test():
    ok = []
    c = from_csv("Catchline,Desk,Byline,Copy due,Words\nbridge-vote,Metro,,2026-11-04T17:00+00:00,600\n,Metro,,tomorrow,\n", None)
    ok.append(c[0]["slug"] == "bridge-vote" and c[0]["deadline"] == "2026-11-04T17:00+00:00" and c[0]["words"] == 600 and c[0]["reporter"] is None)
    ok.append("unparsed" in c[1] and c[1]["deadline"] is None)
    i = from_ics("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Flood defences\nDTSTART:20261104T153000Z\nCATEGORIES:Metro\nEND:VEVENT\nEND:VCALENDAR\n", None)
    ok.append(i[0]["deadline"] == "2026-11-04T15:30Z" and i[0]["desk"] == "Metro")
    w = from_wire("BRIDGE-VOTE -- 600w -- Council votes -- moving 1700 UTC, embargoed until 2026-11-04T18:00Z\n", "Metro")
    ok.append(w[0]["slug"] == "bridge-vote" and w[0]["moving_utc"] == "17:00" and w[0]["embargo"] == "2026-11-04T18:00Z")
    j = from_json('[{"id": "t1", "title": "Bridge vote", "dueAt": "2026-11-04", "custom": {"stage": "assigned"}}]', None)
    ok.append(j[0]["status"] == "assigned" and j[0]["deadline"] == "2026-11-04")
    z = from_csv("slug,deadline\nx,2026-11-04T17:00\n", None)
    ok.append(z[0].get("zone") == "unstated")
    print(json.dumps({"self_test": "ok" if all(ok) else "failed", "checks": len(ok), "failed": [n for n, x in enumerate(ok) if not x]}))
    return 0 if all(ok) else 1

def main(a):
    if "--self-test" in a: return self_test()
    if not a or a[0] in ("-h", "--help") or "--format" not in a: print(__doc__); return 0 if a and a[0] in ("-h", "--help") else 2
    fmt = a[a.index("--format") + 1]; desk = a[a.index("--desk") + 1] if "--desk" in a else None
    if fmt not in PARSERS: print(f"--format must be one of {', '.join(PARSERS)}", file=sys.stderr); return 2
    try: text = open(a[0], encoding="utf-8", errors="replace").read()
    except OSError as e: print(f"cannot read {a[0]}: {e}", file=sys.stderr); return 2
    try: rows = PARSERS[fmt](text, desk)
    except (ValueError, csv.Error) as e: print(f"{a[0]} is not readable as {fmt}: {e}", file=sys.stderr); return 1
    for r in rows: print(json.dumps(r, ensure_ascii=False))
    if not rows: print(f"no entry could be read from {a[0]} as {fmt}", file=sys.stderr); return 1
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
